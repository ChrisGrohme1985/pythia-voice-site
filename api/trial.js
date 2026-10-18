// Testphasen-Stand je Gerät und Produkt (recap | dictation | voice). Ohne ihn startet die Testphase nach "Daten löschen" oder Neuinstallation neu,
// denn nur die Geräte-ID überlebt beides. Gespeichert wird nur: Produkt, Hash der Geräte-ID, Teststart, Zähler. Keine Inhalte, kein Konto.
// POST { product, device, used } → 200 { start, used, now } | 400 ungültig | 429 zu viele Aufrufe
// "used" ist der lokale Zähler der App; der Server behält den höheren Wert, "start" bleibt der erste Kontakt, "now" ist die Serverzeit (gegen zurückgestellte Uhren).
// shortcut: Wert wird dem Gerät geglaubt (wie die Lizenz-Bindung an die Geräte-ID); ein neues Gerät oder Werksreset beginnt neu. Bei Missbrauch Play Integrity ergänzen.
const crypto = require("crypto");
const db = require("./_db");

const COL = "trials";
const PRODUCTS = new Set(["recap", "dictation", "voice"]);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    const { product, device, used } = req.body || {};
    if (!PRODUCTS.has(product) || typeof device !== "string" || !/^[0-9a-f]{32}$/.test(device) || !Number.isInteger(used) || used < 0 || used > 1_000_000) {
      return res.status(400).json({ error: "invalid" });
    }

    // Raten begrenzen: je Absender höchstens 120 Aufrufe pro Stunde
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const who = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
    const rk = `trial-${new Date().toISOString().slice(0, 13)}-${who}`;
    const rate = (await db.get("authRate", rk)) || { n: 0 };
    if (rate.n >= 120) return res.status(429).json({ error: "too_many" });
    await db.set("authRate", rk, { n: rate.n + 1, expires: new Date(Date.now() + 2 * 864e5) }); // Firestore-TTL löscht nach 2 Tagen (firebase/firestore.indexes.json)

    const id = `${product}-${crypto.createHash("sha256").update(device).digest("hex").slice(0, 32)}`;
    const now = Date.now();
    const expires = new Date(now + 3 * 365 * 864e5); // Firestore-TTL: 3 Jahre nach dem letzten Abgleich gelöscht (Datenschutzerklärung)
    if (await db.create(COL, id, { start: now, used, seen: now, expires })) return res.status(200).json({ start: now, used, now });
    const t = await db.get(COL, id);
    const merged = Math.max(t.used || 0, used);
    await db.set(COL, id, { used: merged, seen: now, expires }, { merge: true });
    return res.status(200).json({ start: t.start, used: merged, now });
  } catch (e) {
    console.error("Testphase: " + e.message);
    return res.status(500).json({ error: "server" });
  }
};
