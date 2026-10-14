// Aktivierung eines Lizenzschlüssels: bindet ihn an genau ein Gerät und stellt dafür eine signierte Quittung aus.
// POST { key, device } → 200 { receipt } | 400 ungültig | 403 gesperrt (erstattet) | 409 schon auf einem anderen Gerät | 429 zu viele Versuche.
// Die App fragt hier regelmäßig nach (siehe Activation.kt): so greift eine Sperre auch auf Geräten, die schon aktiviert sind.
// Der Schlüssel selbst bleibt offline prüfbar; neu ist die Bindung: wer ihn weitergibt, kann ihn nicht ein zweites Mal aktivieren.
// Binden wir an die Geräte-ID statt an die IP-Adresse: Die IP wechselt ständig (WLAN, Mobilfunk, Unterwegs) und teilen sich viele Kunden.
const crypto = require("crypto");
const db = require("./_db");
const { parse, receipt } = require("./_license");

const BINDINGS = "licenseBindings";
const REVOKED = "licenseRevoked";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    const { key, device } = req.body || {};
    if (typeof key !== "string" || key.length > 400 || typeof device !== "string" || !/^[0-9a-f]{32}$/.test(device)) return res.status(400).json({ error: "invalid" });

    // Raten begrenzen: je Absender höchstens 30 Versuche pro Stunde (verhindert das Durchprobieren)
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const who = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
    const rk = `act-${new Date().toISOString().slice(0, 13)}-${who}`;
    const rate = (await db.get("authRate", rk)) || { n: 0 };
    if (rate.n >= 30) return res.status(429).json({ error: "too_many" });
    await db.set("authRate", rk, { n: rate.n + 1 });

    const lic = parse(key);
    if (!lic) return res.status(400).json({ error: "invalid" });
    if (await db.get(REVOKED, lic.idHex)) return res.status(403).json({ error: "revoked" });
    const deviceHash = crypto.createHash("sha256").update(device).digest("hex").slice(0, 32);
    const now = Date.now();
    if (!(await db.create(BINDINGS, lic.idHex, { device: deviceHash, version: lic.version, boundAt: now, lastSeen: now }))) {
      const b = await db.get(BINDINGS, lic.idHex);
      if (b.device !== deviceHash) return res.status(409).json({ error: "bound" });
      await db.set(BINDINGS, lic.idHex, { lastSeen: now }, { merge: true });
    }
    return res.status(200).json({ receipt: receipt(lic.version, lic.idHex, deviceHash) });
  } catch (e) {
    console.error("Aktivierung: " + e.message);
    return res.status(500).json({ error: "server" });
  }
};
