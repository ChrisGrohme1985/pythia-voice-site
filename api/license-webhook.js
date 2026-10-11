// Webhook von Stripe: nach bezahlter Checkout-Sitzung Lizenzschlüssel erzeugen und per E-Mail senden.
// Umgebungsvariablen: STRIPE_WEBHOOK_SECRET, PYTHIA_LICENSE_PRIVATE, PYTHIA_ID_SECRET, RESEND_API_KEY, RESEND_FROM
const crypto = require("crypto");
const { issue } = require("./_license");

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// Stripe-Signatur: Header "t=<Zeit>,v1=<hex>[,v1=...]", signiert wird "<Zeit>.<Body>"; Zeit höchstens 5 Minuten alt
function validSignature(body, header, secret) {
  const parts = String(header || "").split(",").map((s) => s.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expect = crypto.createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex");
  return parts.some(([k, v]) => k === "v1" && v?.length === expect.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expect)));
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
  if (!process.env.STRIPE_WEBHOOK_SECRET || !validSignature(body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  let ev;
  try { ev = JSON.parse(body.toString("utf8")); } catch { return res.status(400).end(); }
  const s = ev?.data?.object;
  const email = s?.customer_details?.email || s?.customer_email;
  // Nur bezahlte Checkout-Sitzungen (auch verzögerte Zahlarten); alles andere bestätigen wir ohne Aktion
  const paid = (ev?.type === "checkout.session.completed" && s?.payment_status === "paid") || ev?.type === "checkout.session.async_payment_succeeded";
  if (!paid || !s?.id || !email) return res.status(200).json({ ignored: true });
  try {
    await sendMail(email, issue(s.id));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e.message); // kein Schlüssel und keine Adresse im Log
    return res.status(500).end(); // Stripe wiederholt die Zustellung; derselbe Schlüssel entsteht erneut
  }
};
// shortcut: Erstattungen widerrufen den Schlüssel nicht (offline prüfbar); bei Bedarf eine Sperrliste ergänzen.
// Falls Vercel den Body schon geparst hat (Signatur schlägt dann fehl): bodyParser deaktivieren oder den Web-Handler nutzen.
module.exports.config = { api: { bodyParser: false } };
