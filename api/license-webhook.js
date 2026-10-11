// Webhook von Stripe: nach bezahlter Checkout-Sitzung Lizenzschlüssel erzeugen und per E-Mail senden.
// Umgebungsvariablen: PYTHIA_PAYMENT_LINKS (Diktat) und PYTHIA_VOICE_LINKS (Sprachnachrichten), je plink_…, Komma-getrennt; STRIPE_WEBHOOK_SECRET (ggf. "whsec_test,whsec_live"), PYTHIA_LICENSE_PRIVATE, PYTHIA_ID_SECRET, RESEND_API_KEY, RESEND_FROM
const crypto = require("crypto");
const { issue } = require("./_license");
const { invoicePdf } = require("./_invoice");
const books = require("./_books");

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

// Markenmail: Tabellen-Layout mit Inline-Styles (so zeigen es auch Outlook und Gmail richtig an), Logo als gehostetes PNG
function mailHtml(key, product) {
  const T = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f1830;font-size:16px;line-height:1.6";
  const block = (h, intro, steps, outro) => `
    <h2 style="margin:0 0 8px;font-size:20px;color:#0f1830">${h}</h2>
    <p style="margin:0 0 14px">${intro}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:#fff8e1;border:2px solid #e9b949;border-radius:12px;padding:18px 10px">
      <span style="font-family:Consolas,'Courier New',monospace;font-size:20px;font-weight:700;letter-spacing:1px;color:#101a33;word-break:break-all">${key}</span>
    </td></tr></table>
    <p style="margin:14px 0 0">${steps}</p>
    <p style="margin:10px 0 0;color:#4a5470;font-size:14px">${outro}</p>`;
  return `<!doctype html><html><body style="margin:0;background:#f6f3ea">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ea"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;${T}">
    <tr><td align="center" style="background:#101a33;padding:26px 20px">
      <img src="https://www.pythiavoice.app/mail-logo.png" width="72" height="72" alt="" style="display:block;border:0;border-radius:16px;margin:0 auto 10px">
      <span style="font-size:24px;font-weight:700;color:#f5f1e6;letter-spacing:-0.5px">Pythia Voice</span>
    </td></tr>
    <tr><td style="padding:28px 28px 8px">
      ${block("Danke für deinen Kauf!", `Hier ist dein Lizenzschlüssel für ${product.de}:`, "So aktivierst du ihn: App öffnen, bei der Testphase-Karte den Schlüssel einfügen und auf „Aktivieren“ tippen.", "Gültig ohne Ablauf. Bewahre diese Mail gut auf.")}
    </td></tr>
    <tr><td style="padding:8px 28px"><hr style="border:0;border-top:1px solid #e6e1d2"></td></tr>
    <tr><td style="padding:8px 28px 28px">
      ${block("Thank you for your purchase!", `Here is your license key for ${product.en}:`, "To activate: open the app, paste the key into the trial card and tap “Activate”.", "It never expires. Please keep this e-mail.")}
    </td></tr>
    <tr><td align="center" style="background:#f6f3ea;padding:16px 20px;font-size:13px;color:#4a5470">
      Fragen? Antworte einfach auf diese Mail. · Questions? Just reply to this e-mail.<br>
      <a href="https://www.pythiavoice.app/" style="color:#8a6a12">pythiavoice.app</a> ·
      <a href="https://www.pythiavoice.app/impressum" style="color:#8a6a12">Impressum</a> ·
      <a href="https://www.pythiavoice.app/datenschutz" style="color:#8a6a12">Datenschutz</a>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
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
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to,
      reply_to: "support@pythiavoice.app", // Antworten der Kunden landen im echten Postfach
      subject: `Dein Lizenzschlüssel: ${product.de} / Your license key: ${product.en}`,
      html: mailHtml(key, product),
      ...(attachments && { attachments }),
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
