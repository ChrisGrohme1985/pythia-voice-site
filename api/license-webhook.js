// Webhook des Zahlungsanbieters (Lemon Squeezy): nach bezahlter Bestellung Lizenzschlüssel erzeugen und per E-Mail senden.
// Umgebungsvariablen: LS_WEBHOOK_SECRET, PYTHIA_LICENSE_PRIVATE, PYTHIA_ID_SECRET, RESEND_API_KEY, RESEND_FROM
const crypto = require("crypto");
const { issue } = require("./_license");

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function sameSignature(body, header, secret) {
  const expect = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expect), b = Buffer.from(String(header || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sendMail(to, key) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to,
      subject: "Dein Pythia-Voice-Lizenzschlüssel / Your Pythia Voice license key",
      text:
        `Danke für deinen Kauf!\n\nDein Lizenzschlüssel:\n\n${key}\n\n` +
        `So aktivierst du ihn: App öffnen, bei der Testphase-Karte den Schlüssel einfügen und auf „Aktivieren“ tippen.\n\n` +
        `Thank you for your purchase!\n\nYour license key:\n\n${key}\n\n` +
        `To activate: open the app, paste the key into the trial card and tap “Activate”.\n`,
    }),
  });
  if (!r.ok) throw new Error(`E-Mail-Versand fehlgeschlagen: ${r.status}`);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const body = await rawBody(req);
  if (!process.env.LS_WEBHOOK_SECRET || !sameSignature(body, req.headers["x-signature"], process.env.LS_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  let ev;
  try { ev = JSON.parse(body.toString("utf8")); } catch { return res.status(400).end(); }
  const a = ev?.data?.attributes;
  // Nur bezahlte Bestellungen; alles andere (Erstattung, Abo-Ereignisse) bestätigen wir ohne Aktion
  if (ev?.meta?.event_name !== "order_created" || a?.status !== "paid" || !a?.user_email) return res.status(200).json({ ignored: true });
  try {
    await sendMail(a.user_email, issue(ev.data.id));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e.message); // kein Schlüssel und keine Adresse im Log
    return res.status(500).end(); // Anbieter wiederholt die Zustellung; derselbe Schlüssel entsteht erneut
  }
};
// shortcut: Erstattungen widerrufen den Schlüssel nicht (offline prüfbar); bei Bedarf eine Sperrliste ergänzen.
// Falls Vercel den Body schon geparst hat (Signatur schlägt dann fehl): bodyParser deaktivieren oder den Web-Handler nutzen.
module.exports.config = { api: { bodyParser: false } };
