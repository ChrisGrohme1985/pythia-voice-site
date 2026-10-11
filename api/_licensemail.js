// Lizenzmail mit Branding: wird vom Stripe-Webhook und von der Schlüsselvergabe im internen Bereich genutzt.
/** Gemeinsamer Rahmen aller Markenmails: Kopf mit Logo, Inhalt (Tabellenzeilen), Fußzeile. */
function shell(rows) {
  const T = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f1830;font-size:16px;line-height:1.6";
  return `<!doctype html><html><body style="margin:0;background:#f6f3ea">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ea"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;${T}">
    <tr><td align="center" style="background:#101a33;padding:26px 20px">
      <img src="https://www.pythiavoice.app/mail-logo.png" width="72" height="72" alt="" style="display:block;border:0;border-radius:16px;margin:0 auto 10px">
      <span style="font-size:24px;font-weight:700;color:#f5f1e6;letter-spacing:-0.5px">Pythia Voice</span>
    </td></tr>
${rows}
    <tr><td align="center" style="background:#f6f3ea;padding:16px 20px;font-size:13px;color:#4a5470">
      Fragen? Antworte einfach auf diese Mail. · Questions? Just reply to this e-mail.<br>
      <a href="https://www.pythiavoice.app/" style="color:#8a6a12">pythiavoice.app</a> ·
      <a href="https://www.pythiavoice.app/impressum" style="color:#8a6a12">Impressum</a> ·
      <a href="https://www.pythiavoice.app/datenschutz" style="color:#8a6a12">Datenschutz</a>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

/** Link, der die App öffnet und den Schlüssel einlöst; der Schlüssel steht im Fragment und erreicht so nie einen Server. */
const openLink = (key) => `https://www.pythiavoice.app/open#${key}`;

// Markenmail: Tabellen-Layout mit Inline-Styles (so zeigen es auch Outlook und Gmail richtig an), Logo als gehostetes PNG
function mailHtml(key, product) {
  const T = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f1830;font-size:16px;line-height:1.6";
  const link = openLink(key);
  const block = (h, intro, button, steps, outro) => `
    <h2 style="margin:0 0 8px;font-size:20px;color:#0f1830">${h}</h2>
    <p style="margin:0 0 14px">${intro}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:#fff8e1;border:2px solid #e9b949;border-radius:12px;padding:18px 10px">
      <span style="font-family:Consolas,'Courier New',monospace;font-size:20px;font-weight:700;letter-spacing:1px;color:#101a33;word-break:break-all">${key}</span>
    </td></tr></table>
    <p style="margin:16px 0 0;text-align:center"><a href="${link}" style="display:inline-block;background:#e9b949;color:#101a33;font-weight:700;text-decoration:none;border-radius:999px;padding:13px 26px">${button}</a></p>
    <p style="margin:14px 0 0">${steps}</p>
    <p style="margin:10px 0 0;color:#4a5470;font-size:14px">${outro}</p>`;
  return shell(`
    <tr><td style="padding:28px 28px 8px">
      ${block("Danke für deinen Kauf!", `Hier ist dein Lizenzschlüssel für ${product.de}:`, "In der App freischalten", "Am Handy genügt ein Tippen auf den Knopf. Sonst: Schlüssel kopieren, die App öffnen, sie erkennt ihn selbst oder du fügst ihn bei der Testphase-Karte ein.", "Gültig ohne Ablauf. Bewahre diese Mail gut auf.")}
    </td></tr>
    <tr><td style="padding:8px 28px"><hr style="border:0;border-top:1px solid #e6e1d2"></td></tr>
    <tr><td style="padding:8px 28px 28px">
      ${block("Thank you for your purchase!", `Here is your license key for ${product.en}:`, "Activate in the app", "On your phone, just tap the button. Otherwise copy the key and open the app: it recognizes the key, or paste it into the trial card.", "It never expires. Please keep this e-mail.")}
    </td></tr>
  `);
}

/** Gutschrift-Mail im selben Layout: zweisprachig, Betrag und Rechnung hervorgehoben. @param c {amount (Cent), refNumber, number} */
function creditMailHtml(c) {
  const amt = (c.amount / 100).toFixed(2).replace(".", ",") + " €";
  const block = (h, text, label, outro) => `
    <h2 style="margin:0 0 8px;font-size:20px;color:#0f1830">${h}</h2>
    <p style="margin:0 0 14px">${text}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:#fff8e1;border:2px solid #e9b949;border-radius:12px;padding:16px 10px">
      <span style="display:block;font-size:13px;color:#4a5470;margin-bottom:4px">${label}</span>
      <span style="font-size:26px;font-weight:700;color:#101a33">${amt}</span>
      <span style="display:block;font-size:13px;color:#4a5470;margin-top:4px">${c.refNumber} · ${c.number}</span>
    </td></tr></table>
    <p style="margin:12px 0 0;color:#4a5470;font-size:14px">${outro}</p>`;
  return shell(`
    <tr><td style="padding:28px 28px 8px">
      ${block("Wir haben dir Geld erstattet", `Zu deiner Rechnung ${c.refNumber} haben wir einen Betrag erstattet. Die Gutschrift hängt als PDF an.`, "Erstattungsbetrag", "Das Geld kommt über dein ursprüngliches Zahlungsmittel zurück, das dauert meist einige Werktage.")}
    </td></tr>
    <tr><td style="padding:8px 28px"><hr style="border:0;border-top:1px solid #e6e1d2"></td></tr>
    <tr><td style="padding:8px 28px 28px">
      ${block("We have refunded you", `We refunded an amount for your invoice ${c.refNumber}. The credit note is attached as a PDF.`, "Refund amount", "The money returns via your original payment method, usually within a few business days.")}
    </td></tr>`);
}

/** Sendet die Lizenzmail. @param attachments optional, Resend-Format [{filename, content(Base64)}]. */
async function sendLicenseMail(to, key, product, attachments, intro = "purchase") {
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
        `Danke für deinen Kauf!

Dein Lizenzschlüssel:

${key}

` +
        `Am Handy: ${openLink(key)}
Oder Schlüssel kopieren und die App öffnen, sie erkennt ihn selbst.

` +
        `Thank you for your purchase!

Your license key:

${key}

` +
        `On your phone: ${openLink(key)}
Or copy the key and open the app, it recognizes it.
`,
    }),
  });
  if (!r.ok) throw new Error(`E-Mail-Versand fehlgeschlagen: ${r.status}`);
}

module.exports = { mailHtml, creditMailHtml, sendLicenseMail };
