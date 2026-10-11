// Buchhaltung für Pythia Voice: fortlaufende Nummern, Einnahmen (aus Stripe), Ausgaben (von Hand), Berichte.
// Nummernmodell wie in kroell-web: PRÄFIX-JAHR-0001, pro Jahr neu beginnend, vergeben über einen atomaren Zähler.
const { PDFDocument } = require("pdf-lib");
const store = require("./_store");
const inv = require("./_invoice");

const CATEGORIES = ["Software und Abos", "Domain und Hosting", "Werbung", "Gebühren und Beiträge", "Hardware", "Sonstiges"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const num = (cents) => (Number(cents || 0) / 100).toFixed(2).replace(".", ",");
const unix = (ymd) => Math.floor(Date.parse(ymd + "T00:00:00Z") / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nextNumber(prefix, year) {
  return `${prefix}-${year}-${String(await store.incr(`pv:seq:${prefix}:${year}`)).padStart(4, "0")}`;
}

// ---------- Einnahmen ----------

/** Idempotent: derselbe Kauf bekommt immer dieselbe Rechnungsnummer, auch bei doppelt zugestelltem Webhook. */
async function invoiceFor(session) {
  const mapKey = `pv:salemap:${session.id}`;
  if (await store.setnx(mapKey, "pending", 60)) {
    const number = await nextNumber("PV", new Date(session.created * 1000).getUTCFullYear());
    const doc = {
      number, session: session.id, created: session.created, date: inv.day(session.created),
      email: session.customer_details?.email || session.customer_email || "", amount: session.amount_total || 0, link: session.payment_link || "",
    };
    await store.set(`pv:sale:${number}`, doc);
    await store.zadd("pv:sales", session.created, number);
    await store.set(mapKey, number);
    return doc;
  }
  for (let i = 0; i < 10; i++) {
    const v = await store.get(mapKey);
    if (v && v !== "pending") return store.get(`pv:sale:${v}`);
    await sleep(300);
  }
  throw new Error("Rechnungsnummer wird gerade vergeben");
}

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

async function listSales(from, to) {
  const all = await Promise.all((await store.zrevrange("pv:sales")).map((n) => store.get(`pv:sale:${n}`)));
  return all.filter((d) => d && (!from || d.date >= from) && (!to || d.date <= to)).sort((a, b) => a.number.localeCompare(b.number));
}

// ---------- Ausgaben ----------

async function addExpense(e) {
  const amount = Math.round(parseFloat(String(e.amount).replace(",", ".")) * 100);
  if (!YMD.test(e.date || "")) throw new Error("Datum fehlt oder ist ungültig");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Betrag fehlt oder ist ungültig");
  const vendor = String(e.vendor || "").trim().slice(0, 120);
  if (!vendor) throw new Error("Lieferant fehlt");
  const number = await nextNumber("AUS", Number(e.date.slice(0, 4)));
  const doc = {
    number, date: e.date, vendor, description: String(e.description || "").trim().slice(0, 300),
    category: CATEGORIES.includes(e.category) ? e.category : "Sonstiges", note: String(e.note || "").trim().slice(0, 300),
    amount, void: false, createdAt: Math.floor(Date.now() / 1000),
  };
  await store.set(`pv:exp:${number}`, doc);
  await store.zadd("pv:exps", unix(e.date), number);
  return doc;
}

/** Ausgaben werden nie gelöscht, nur storniert: so bleibt die Nummernfolge lückenlos und nachvollziehbar. */
async function voidExpense(number) {
  const doc = await store.get(`pv:exp:${number}`);
  if (!doc) throw new Error("Beleg nicht gefunden");
  if (!doc.void) { doc.void = true; doc.voidedAt = Math.floor(Date.now() / 1000); await store.set(`pv:exp:${number}`, doc); }
  return doc;
}

async function listExpenses(from, to) {
  const all = await Promise.all((await store.zrevrange("pv:exps")).map((n) => store.get(`pv:exp:${n}`)));
  return all.filter((d) => d && (!from || d.date >= from) && (!to || d.date <= to)).sort((a, b) => a.number.localeCompare(b.number));
}

// ---------- Berichte ----------

// Zellen, die mit = + - @ beginnen, würde Excel als Formel auslesen
const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
const csv = (head, rows) => "﻿" + [head, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";

async function reportPdf({ number, from, to, totals, sales, expenses, sessions, numbers }) {
  const doc = await PDFDocument.create();
  const fonts = await inv.fontsFor(doc);
  let p, t, y;
  const newPage = (title) => {
    p = doc.addPage([595, 842]); t = inv.writer(p, fonts); y = 790;
    t(title, 56, y, 14, true); y -= 28;
  };
  newPage(`Bericht ${number}: ${inv.de(from)} bis ${inv.de(to)}`);
  const lines = [
    ["Einnahmen (brutto)", num(totals.income)], ["Erstattungen", "-" + num(totals.refunds)], ["Stripe-Gebühren", "-" + num(totals.fees)],
    ["Ausgaben", "-" + num(totals.expenses)], ["Ergebnis", num(totals.result)],
  ];
  lines.forEach(([l, v], i) => { const b = i === lines.length - 1; t(l, 56, y, 12, b); t(v + " €", 440, y, 12, b); y -= 20; });
  y -= 10;
  t(`${sales.length} Verkäufe, ${expenses.filter((e) => !e.void).length} Ausgabenbelege (stornierte nicht gezählt).`, 56, y, 10, false, inv.colors.gray); y -= 14;
  t(inv.KLEIN, 56, y, 10, false, inv.colors.gray); y -= 14;
  t("Ergebnis = Einnahmen - Erstattungen - Stripe-Gebühren - Ausgaben. Keine Steuerberechnung.", 56, y, 10, false, inv.colors.gray);

  const table = (title, head, xs, rows) => {
    newPage(title);
    head.forEach((h, i) => t(h, xs[i], y, 9, true)); y -= 16;
    for (const r of rows) {
      if (y < 60) { newPage(title + " (Fortsetzung)"); head.forEach((h, i) => t(h, xs[i], y, 9, true)); y -= 16; }
      r.forEach((c, i) => t(String(c).slice(0, i === 2 ? 34 : 30), xs[i], y, 9));
      y -= 13;
    }
  };
  table("Einnahmen", ["Nummer", "Datum", "E-Mail", "Brutto €", "Gebühr €"], [56, 150, 220, 430, 490],
    sales.map((s) => [s.doc.number, inv.de(s.doc.date), s.doc.email, num(s.doc.amount), num(s.fee)]));
  table("Ausgaben", ["Nummer", "Datum", "Lieferant / Beschreibung", "Betrag €", "Status"], [56, 150, 220, 430, 490],
    expenses.map((e) => [e.number, inv.de(e.date), `${e.vendor}${e.description ? " - " + e.description : ""}`, num(e.amount), e.void ? "storniert" : ""]));
  if (sessions.length && sessions.length <= 200) for (const s of sessions) inv.invoicePage(doc, fonts, s, numbers[s.id]);
  return Buffer.from(await doc.save());
}

/** Erzeugt einen Bericht für [from, to] (inklusive, Datum JJJJ-MM-TT, nach UTC), speichert ihn und gibt die Metadaten zurück. */
async function createReport(from, to) {
  if (!YMD.test(from || "") || !YMD.test(to || "") || from > to) throw new Error("Zeitraum ungültig");
  const sessions = await paidSessions(unix(from), unix(to) + 86400);
  const rows = [];
  const numbers = {};
  for (const s of sessions) { // chronologisch, damit nachträglich vergebene Nummern in der richtigen Reihenfolge liegen
    const doc = await invoiceFor(s);
    numbers[s.id] = doc.number;
    const ch = s.payment_intent?.latest_charge, bt = ch?.balance_transaction;
    rows.push({ doc, fee: bt?.fee || 0, net: bt?.net || 0, refunded: ch?.amount_refunded || 0 });
  }
  const expenses = await listExpenses(from, to);
  const totals = {
    income: rows.reduce((a, r) => a + r.doc.amount, 0), refunds: rows.reduce((a, r) => a + r.refunded, 0),
    fees: rows.reduce((a, r) => a + r.fee, 0), expenses: expenses.filter((e) => !e.void).reduce((a, e) => a + e.amount, 0),
  };
  totals.result = totals.income - totals.refunds - totals.fees - totals.expenses;
  const salesCsv = csv(["Rechnungsnummer", "Datum", "E-Mail", "Brutto EUR", "Stripe-Gebühr EUR", "Netto EUR", "Erstattet EUR", "Stripe-Sitzung"],
    [...rows.map((r) => [r.doc.number, r.doc.date, r.doc.email, num(r.doc.amount), num(r.fee), num(r.net), num(r.refunded), r.doc.session]),
      ["Summe", "", "", num(totals.income), num(totals.fees), num(rows.reduce((a, r) => a + r.net, 0)), num(totals.refunds), ""]]);
  const expCsv = csv(["Belegnummer", "Datum", "Lieferant", "Beschreibung", "Kategorie", "Betrag EUR", "Status", "Notiz"],
    [...expenses.map((e) => [e.number, e.date, e.vendor, e.description, e.category, num(e.amount), e.void ? "storniert" : "gültig", e.note]),
      ["Summe", "", "", "", "", num(totals.expenses), "", ""]]);
  const number = await nextNumber("BER", new Date().getUTCFullYear());
  const pdf = await reportPdf({ number, from, to, totals, sales: rows, expenses, sessions, numbers });
  const b64 = (v) => Buffer.from(v).toString("base64");
  const report = {
    number, from, to, createdAt: Math.floor(Date.now() / 1000), totals, sales: rows.length, expenses: expenses.length,
    files: { einnahmen: b64(salesCsv), ausgaben: b64(expCsv), pdf: pdf.toString("base64") },
  };
  await store.set(`pv:rep:${number}`, report);
  await store.zadd("pv:reps", report.createdAt, number);
  return report;
}

async function listReports() {
  const all = await Promise.all((await store.zrevrange("pv:reps")).map((n) => store.get(`pv:rep:${n}`)));
  return all.filter(Boolean).map(({ files, ...meta }) => meta);
}
const getReport = (number) => store.get(`pv:rep:${number}`);

/** Bericht an dich selbst mailen (nicht an den Steuerberater). */
async function mailReport(report) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to: [process.env.REPORT_EMAIL || "support@pythiavoice.app"],
      subject: `Pythia Voice Bericht ${report.number}: ${report.from} bis ${report.to}`,
      text: `Bericht ${report.number} für ${report.from} bis ${report.to}\n\nEinnahmen: ${num(report.totals.income)} €\nErstattungen: ${num(report.totals.refunds)} €\n` +
        `Stripe-Gebühren: ${num(report.totals.fees)} €\nAusgaben: ${num(report.totals.expenses)} €\nErgebnis: ${num(report.totals.result)} €\n\n` +
        `Anhänge: Einnahmen (CSV), Ausgaben (CSV), Bericht mit Belegen (PDF).\n`,
      attachments: [
        { filename: `${report.number}-Einnahmen.csv`, content: report.files.einnahmen },
        { filename: `${report.number}-Ausgaben.csv`, content: report.files.ausgaben },
        { filename: `${report.number}-Bericht.pdf`, content: report.files.pdf },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Mailversand ${r.status}`);
}

module.exports = {
  CATEGORIES, nextNumber, invoiceFor, listSales, addExpense, voidExpense, listExpenses,
  createReport, listReports, getReport, mailReport, paidSessions,
};
