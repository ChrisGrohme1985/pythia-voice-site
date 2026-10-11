// Monatsbericht für den Steuerberater: holt die bezahlten Käufe des Vormonats aus Stripe, erzeugt eine Excel-taugliche CSV
// und ein PDF mit allen Belegen und mailt beides. Aufruf durch den Vercel-Cron (siehe vercel.json) oder manuell mit ?month=YYYY-MM.
// Umgebungsvariablen: STRIPE_READ_KEY (eingeschränkter Schlüssel, nur lesen), PYTHIA_PAYMENT_LINKS, CRON_SECRET,
//                     ACCOUNTANT_EMAIL (Komma-getrennt), RESEND_API_KEY, RESEND_FROM
const { invoicePdf, belegNr, day } = require("./_invoice");

const num = (cents) => (Number(cents || 0) / 100).toFixed(2).replace(".", ",");
const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function stripeGet(path, params) {
  const url = new URL("https://api.stripe.com/v1/" + path);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.STRIPE_READ_KEY}` } });
  if (!r.ok) throw new Error(`Stripe ${r.status}`);
  return r.json();
}

/** Bezahlte Sitzungen unseres Zahlungslinks im Zeitraum [from, to) (Unix-Sekunden), mit Gebühr und Erstattung. */
async function paidSessions(from, to) {
  const links = (process.env.PYTHIA_PAYMENT_LINKS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  let after;
  for (;;) {
    const params = [["limit", "100"], ["created[gte]", from], ["created[lt]", to],
      ["expand[]", "data.payment_intent.latest_charge.balance_transaction"]];
    if (after) params.push(["starting_after", after]);
    const page = await stripeGet("checkout/sessions", params);
    for (const s of page.data) {
      if (s.status === "complete" && s.payment_status === "paid" && links.includes(s.payment_link)) out.push(s);
    }
    if (!page.has_more) break;
    after = page.data[page.data.length - 1].id;
  }
  return out.sort((a, b) => a.created - b.created);
}

function csv(sessions) {
  const head = ["Belegnummer", "Datum", "E-Mail", "Brutto EUR", "Stripe-Gebühr EUR", "Netto EUR", "Erstattet EUR", "Stripe-Sitzung"];
  const cents = sessions.map((s) => {
    const ch = s.payment_intent?.latest_charge, bt = ch?.balance_transaction;
    return [s.amount_total || 0, bt?.fee || 0, bt?.net || 0, ch?.amount_refunded || 0];
  });
  const rows = sessions.map((s, i) => [belegNr(s), day(s.created), s.customer_details?.email || "", ...cents[i].map(num), s.id]);
  const sum = (k) => num(cents.reduce((a, c) => a + c[k], 0));
  rows.push(["Summe", "", "", sum(0), sum(1), sum(2), sum(3), ""]);
  // Semikolon und Dezimalkomma, UTF-8 mit BOM: öffnet in deutschem Excel direkt richtig
  return "﻿" + [head, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const m = String(req.query?.month || "").match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const y = m ? +m[1] : now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const mo = m ? +m[2] - 1 : (now.getUTCMonth() + 11) % 12;
  const from = Math.floor(Date.UTC(y, mo, 1) / 1000), to = Math.floor(Date.UTC(y, mo + 1, 1) / 1000);
  const label = `${y}-${String(mo + 1).padStart(2, "0")}`;
  try {
    const sessions = await paidSessions(from, to);
    const attachments = [{ filename: `Pythia-Voice-Umsaetze-${label}.csv`, content: Buffer.from(csv(sessions), "utf8").toString("base64") }];
    if (sessions.length) attachments.push({ filename: `Pythia-Voice-Belege-${label}.pdf`, content: (await invoicePdf(sessions)).toString("base64") });
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: String(process.env.ACCOUNTANT_EMAIL || "").split(",").map((s) => s.trim()).filter(Boolean),
        subject: `Pythia Voice: Umsätze und Belege ${label}`,
        text: `Anbei die Umsätze und Belege für ${label} (${sessions.length} Verkäufe).\n\nCSV: Übersicht mit Brutto, Stripe-Gebühr, Netto und Erstattungen. PDF: ein Beleg je Verkauf.\nGemäß § 19 UStG wird keine Umsatzsteuer berechnet.\n`,
        attachments,
      }),
    });
    if (!r.ok) throw new Error(`Mailversand ${r.status}`);
    return res.status(200).json({ ok: true, month: label, sales: sessions.length });
  } catch (e) {
    console.error(e.message);
    return res.status(500).end();
  }
};
module.exports.csv = csv;
