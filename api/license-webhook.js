// Webhook von Stripe: nach bezahlter Checkout-Sitzung Lizenzschlüssel erzeugen und per E-Mail senden.
// Umgebungsvariablen: PYTHIA_PAYMENT_LINKS (Diktat) und PYTHIA_VOICE_LINKS (Sprachnachrichten), je plink_…, Komma-getrennt; STRIPE_WEBHOOK_SECRET (ggf. "whsec_test,whsec_live"), PYTHIA_LICENSE_PRIVATE, PYTHIA_ID_SECRET, RESEND_API_KEY, RESEND_FROM
const crypto = require("crypto");
const { issue } = require("./_license");
const { invoicePdf } = require("./_invoice");
const books = require("./_books");
const { sendLicenseMail } = require("./_licensemail");

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// Stripe-Signatur: Header "t=<Zeit>,v1=<hex>[,v1=...]", signiert wird "<Zeit>.<Body>"; Zeit höchstens 5 Minuten alt
// Mehrere Secrets (Test und Live) durch Komma getrennt erlaubt: so laufen Sandbox und Live-Betrieb parallel
function validSignature(body, header, secrets) {
  const parts = String(header || "").split(",").map((s) => s.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  return String(secrets).split(",").map((s) => s.trim()).filter(Boolean).some((secret) => {
    const expect = crypto.createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex");
    return parts.some(([k, v]) => k === "v1" && v?.length === expect.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expect)));
  });
}

async function sendMail(to, key, session, product) {
  // Der Kauf wird zuerst als Posten mit fortlaufender Rechnungsnummer gebucht, dann geht der Beleg als PDF mit.
  // Scheitert das (Speicher oder PDF), geht der Schlüssel trotzdem raus, aber OHNE Beleg: eine Ersatznummer wäre steuerlich falsch.
  // Der Posten entsteht dann beim nächsten Stripe-Abgleich (Knopf im internen Bereich oder Monatsbericht).
  let attachments;
  try {
    const entry = await books.invoiceFor(session);
    attachments = [{ filename: `Rechnung-${entry.number}.pdf`, content: (await invoicePdf([session], { [session.id]: entry.number })).toString("base64") }];
  } catch (e) { console.error("Beleg: " + e.message); }
  await sendLicenseMail(to, key, product, attachments);
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
  // In Stripe ausgelöste Erstattungen: als Gutschrift buchen und dem Verkauf zuordnen (Stripe-Ereignis charge.refunded)
  if (ev?.type === "charge.refunded") {
    try { await books.syncRefundFromCharge(s); return res.status(200).json({ ok: true }); }
    catch (e) { console.error("Erstattung: " + e.message); return res.status(500).end(); }
  }
  const email = s?.customer_details?.email || s?.customer_email;
  // Nur bezahlte Checkout-Sitzungen (auch verzögerte Zahlarten); alles andere bestätigen wir ohne Aktion
  const paid = (ev?.type === "checkout.session.completed" && s?.payment_status === "paid") || ev?.type === "checkout.session.async_payment_succeeded";
  if (!paid || !s?.id || !email) return res.status(200).json({ ignored: true });
  // Das Stripe-Konto wird auch für andere Produkte genutzt: nur Käufe über unseren Zahlungslink bekommen einen Schlüssel
  const product = books.productOf(s.payment_link);
  if (!product) return res.status(200).json({ ignored: true });
  try {
    await sendMail(email, issue(s.id, product.version), s, product);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e.message); // kein Schlüssel und keine Adresse im Log
    return res.status(500).end(); // Stripe wiederholt die Zustellung; derselbe Schlüssel entsteht erneut
  }
};
// shortcut: Erstattungen widerrufen den Schlüssel nicht (offline prüfbar); bei Bedarf eine Sperrliste ergänzen.
// Falls Vercel den Body schon geparst hat (Signatur schlägt dann fehl): bodyParser deaktivieren oder den Web-Handler nutzen.
module.exports.config = { api: { bodyParser: false } };
