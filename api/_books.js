// Buchhaltung für Pythia Voice, abgeleitet vom Finanzmodul von zuhause-web (server/api/admin/finance.js):
// Posten (Einnahmen/Ausgaben) mit Belegen als PDF, Beleg-Inbox, wiederkehrende Ausgaben, CSV-Export, Steuerberater-Paket.
// Neu gegenüber der Vorlage: fortlaufende Nummern (PRÄFIX-JAHR-0001, atomar), Stripe-Verkäufe werden automatisch Einnahmen,
// Stornieren statt Löschen, gespeicherte Berichte. Alles liegt in Firestore (siehe _db.js).
const crypto = require("crypto");
const { PDFDocument } = require("pdf-lib");
const db = require("./_db");
const inv = require("./_invoice");
const { creditMailHtml } = require("./_licensemail");
const { parse } = require("./_license");

const GRANTS = "licenseGrants";
const BINDINGS = "licenseBindings";
const ENTRIES = "financeEntries", INBOX = "financeReceiptInbox", BLOBS = "financeReceiptBlobs", PARTS = "financeUploadParts";
const REPORTS = "financeReports", REPORT_BLOBS = "financeReportBlobs";
const EXPENSE_CATEGORIES = ["Software und Abos", "Domain und Hosting", "Werbung", "Recht und Beratung", "Gebühren und Beiträge", "Hardware", "Sonstiges"];
const INCOME_CATEGORIES = ["Verkauf (Stripe)", "Sonstige Einnahme"];
// Zuordnung: ein Projekt oder "Allgemein" für Posten, die für alles gelten (z. B. Steuerberater, Büro)
const PROJECTS = ["Pythia Voice", "Pythia Recap", "FlowUnion", "Allgemein"];
const projectOf = (e) => (PROJECTS.includes(e.project) ? e.project : e.source === "stripe" ? "Pythia Voice" : "Allgemein");
const RECURRENCES = { monthly: 1, quarterly: 3, yearly: 12 };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECEIPT = 15 * 1024 * 1024;
const now = () => Math.floor(Date.now() / 1000);
const num = (cents) => (Number(cents || 0) / 100).toFixed(2).replace(".", ",");
const unix = (ymd) => Math.floor(Date.parse(ymd + "T00:00:00Z") / 1000);
const cleanName = (v) => String(v || "beleg.pdf").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "beleg.pdf";

/** Akzeptiert "1.234,56", "1,234.56", "49,90" und "49.9"; ergibt Cent oder NaN. */
function cents(value) {
  let s = String(value ?? "").trim().replace(/[€\s]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function addMonths(iso, months) {
  const d = new Date(`${iso}T12:00:00Z`), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.toISOString().slice(0, 10);
}

function clean(input, fixedType) {
  const type = fixedType || String(input.type || "");
  const date = String(input.date || ""), amount = cents(input.amount), category = String(input.category || "");
  if (type !== "income" && type !== "expense") throw new Error("Art muss Einnahme oder Ausgabe sein");
  if (!YMD.test(date) || Number.isNaN(Date.parse(date + "T12:00:00Z"))) throw new Error("Datum fehlt oder ist ungültig");
  if (!(amount > 0) || amount > 1e9) throw new Error("Betrag fehlt oder ist ungültig");
  const party = String(input.party || "").trim().slice(0, 120);
  if (type === "expense" && !party) throw new Error("Lieferant fehlt");
  const project = PROJECTS.includes(input.project) ? input.project : "Allgemein";
  const list = type === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
  return {
    type, date, amount, project, category: list.includes(category) ? category : list[list.length - 1], party,
    description: String(input.description || "").trim().slice(0, 300),
    recurrence: type === "expense" && RECURRENCES[input.recurrence] ? String(input.recurrence) : null,
    recurrenceUntil: YMD.test(String(input.recurrenceUntil || "")) ? String(input.recurrenceUntil) : null,
  };
}

// ---------- Posten ----------

const listEntries = () => db.list(ENTRIES, { orderBy: "date" });

/** Neue manuelle Posten; wiederkehrende Ausgaben erzeugen je Termin einen eigenen, eigens nummerierten Posten. */
async function addEntry(input, actor = "") {
  const e = clean(input);
  const dates = [e.date];
  if (e.recurrence) {
    const step = RECURRENCES[e.recurrence], until = e.recurrenceUntil || addMonths(e.date, 24);
    for (let i = 1, d = addMonths(e.date, step); d <= until && i < 25; i++, d = addMonths(e.date, step * (i))) dates.push(d);
  }
  const seriesId = dates.length > 1 ? crypto.randomUUID() : null;
  const out = [];
  for (const [i, date] of dates.entries()) {
    const id = crypto.randomUUID();
    const { doc } = await db.numbered(ENTRIES, id, e.type === "expense" ? "AUS" : "EIN", Number(date.slice(0, 4)), (number) => ({
      number, type: e.type, source: "manual", date, amount: e.amount, project: e.project, category: e.category, party: e.party, description: e.description,
      void: false, seriesId, seriesIndex: i, createdBy: actor, createdAt: now(),
    }));
    out.push({ id, ...doc });
  }
  if (input.receiptInboxId) {
    try { Object.assign(out[0], await assignReceipt(out[0].id, String(input.receiptInboxId))); }
    catch (err) { for (const x of out) await db.del(ENTRIES, x.id); throw err; } // wie in der Vorlage: ohne Beleg kein halber Posten
  }
  return out;
}

/** Eindeutig zugeordnet = Stripe-Verkauf oder Ausgabe mit zugeordnetem Beleg. Solche Posten sind unveränderbar (nur Storno bei manuellen). */
const lockReason = (e) => (e.source === "stripe" ? "Stripe-Verkauf" : e.source === "flowunion" ? "FlowUnion-Zahlung" : e.receiptStatus === "ready" ? "Beleg zugeordnet" : "");
const srcLabel = (e) => (e.source === "stripe" ? "Stripe" : e.source === "flowunion" ? "FlowUnion" : "manuell");

async function updateEntry(id, input) {
  const cur = await db.get(ENTRIES, id);
  if (!cur) throw new Error("Posten nicht gefunden");
  if (lockReason(cur)) throw new Error(`Gesperrt (${lockReason(cur)}): eindeutig zugeordnete Posten sind nicht änderbar`);
  if (cur.void) throw new Error("Stornierte Posten sind schreibgeschützt");
  const e = clean(input, cur.type);
  const patch = { date: e.date, amount: e.amount, project: e.project, category: e.category, party: e.party, description: e.description, updatedAt: now() };
  await db.set(ENTRIES, id, patch, { merge: true });
  return { id, ...cur, ...patch };
}

/** Projekt eines noch offenen Postens ändern (manuell, ohne Beleg). Stripe-Verkäufe und Posten mit Beleg sind gesperrt. */
async function assignProject(id, project) {
  if (!PROJECTS.includes(project)) throw new Error("Unbekanntes Projekt");
  const cur = await db.get(ENTRIES, id);
  if (!cur) throw new Error("Posten nicht gefunden");
  if (lockReason(cur)) throw new Error(`Gesperrt (${lockReason(cur)}): eindeutig zugeordnete Posten sind nicht änderbar`);
  if (cur.void) throw new Error("Stornierte Posten sind schreibgeschützt");
  await db.set(ENTRIES, id, { project, updatedAt: now() }, { merge: true });
  return { id, ...cur, project };
}

/** Stornieren statt Löschen: die Nummer bleibt vergeben, die Folge bleibt lückenlos. Erstattungen von Verkäufen laufen über Stripe. */
async function voidEntry(id) {
  const cur = await db.get(ENTRIES, id);
  if (!cur) throw new Error("Posten nicht gefunden");
  if (cur.source === "stripe") throw new Error("Stripe-Verkäufe werden in Stripe erstattet");
  const patch = { void: true, voidedAt: now() };
  await db.set(ENTRIES, id, patch, { merge: true });
  return { id, ...cur, ...patch };
}

// ---------- Stripe ----------

const ids = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const PRODUCTS = [
  { env: "PYTHIA_PAYMENT_LINKS", version: 1, de: "Pythia Voice (Diktat)", en: "Pythia Voice (dictation)", item: "Lebenslange Lizenz für die Android-App Pythia Voice (digital)" },
  { env: "PYTHIA_RECAP_LINKS", version: 3, project: "Pythia Recap", de: "Pythia Recap", en: "Pythia Recap", item: "Lebenslange Lizenz für die Android-App Pythia Recap (digital)" },
  { env: "PYTHIA_VOICE_LINKS", version: 2, de: "Pythia Voice Sprachnachrichten", en: "Pythia Voice voice messages", item: "Lebenslange Lizenz Pythia Voice Sprachnachrichten (digital)" },
];
/** Produkt zu einem Zahlungslink; null, wenn der Kauf nicht zu uns gehört (z. B. FlowUnion im selben Stripe-Konto). */
const productOf = (link) => PRODUCTS.find((p) => ids(process.env[p.env]).includes(link)) || null;

/** Idempotent: derselbe Kauf ergibt immer denselben Posten mit derselben Rechnungsnummer (auch bei doppeltem Webhook). */
/** Stripe liefert den Namen als ein Feld; Nachname = letztes Wort, Vorname = der Rest (bei Doppelnamen ggf. von Hand prüfen). */
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return parts.length < 2 ? { firstName: "", lastName: parts[0] || "" } : { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

async function invoiceFor(session) {
  const id = `st_${session.id}`;
  const email = session.customer_details?.email || session.customer_email || "";
  const { doc } = await db.numbered(ENTRIES, id, "PV", new Date(session.created * 1000).getUTCFullYear(), (number) => ({
    number, type: "income", source: "stripe", date: inv.day(session.created), created: session.created, amount: session.amount_total || 0,
    category: "Verkauf (Stripe)", project: (productOf(session.payment_link) || PRODUCTS[0]).project || "Pythia Voice", party: email, email, description: (productOf(session.payment_link) || PRODUCTS[0]).de, item: (productOf(session.payment_link) || PRODUCTS[0]).item,
    session: session.id, payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || "",
    link: session.payment_link || "", version: (productOf(session.payment_link) || PRODUCTS[0]).version,
    name: String(session.customer_details?.name || "").trim(), ...splitName(session.customer_details?.name),
    fee: 0, refunded: 0, void: false, createdAt: now(),
  }));
  return { id, ...doc };
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
  const out = [];
  let after;
  for (;;) {
    const params = [["limit", "100"], ["created[gte]", from], ["created[lt]", to], ["expand[]", "data.payment_intent.latest_charge.balance_transaction"]];
    if (after) params.push(["starting_after", after]);
    const page = await stripeGet("checkout/sessions", params);
    for (const s of page.data) if (s.status === "complete" && s.payment_status === "paid" && productOf(s.payment_link)) out.push(s);
    if (!page.has_more) break;
    after = page.data[page.data.length - 1].id;
  }
  return out.sort((a, b) => a.created - b.created);
}

/** Holt Käufe des Zeitraums aus Stripe: legt fehlende Posten an (chronologisch) und aktualisiert Gebühr und Erstattung. */
async function syncStripe(from, to) {
  if (!process.env.STRIPE_READ_KEY) return 0;
  const sessions = await paidSessions(unix(from), unix(to) + 86400);
  for (const s of sessions) {
    const e = await invoiceFor(s);
    const ch = s.payment_intent?.latest_charge;
    const fee = ch?.balance_transaction?.fee || 0, refunded = ch?.amount_refunded || 0;
    const nm = String(s.customer_details?.name || "").trim();
    const pi = s.payment_intent?.id || "";
    if (e.fee !== fee || (nm && !e.name) || (pi && !e.payment_intent)) {
      await db.set(ENTRIES, e.id, { fee, ...(pi && !e.payment_intent ? { payment_intent: pi } : {}), ...(nm && !e.name ? { name: nm, ...splitName(nm) } : {}) }, { merge: true });
    }
    if (refunded > 0) await bookMissingRefunds({ ...e, payment_intent: e.payment_intent || pi }, refunded);
  }
  return sessions.length;
}

/** Alle verkauften Lizenzen (nur Stripe-Verkäufe) mit Kundendaten; der Schlüssel wird aus der Bestellung neu abgeleitet. */
async function listLicenses(issue) {
  const bindings = new Map((await db.list(BINDINGS, { orderBy: "boundAt" })).map((b) => [b.id, b]));
  const withDevice = (l) => {
    let id = "";
    try { id = parse(l.key)?.idHex || ""; } catch { /* Signierschlüssel nicht gesetzt */ }
    const b = bindings.get(id);
    return b ? { ...l, deviceId: id, boundAt: b.boundAt, lastSeen: b.lastSeen } : { ...l, deviceId: id };
  };
  const grants = (await db.list(GRANTS, { orderBy: "number" })).map((g) => {
    const product = PRODUCTS.find((p) => p.version === g.version) || PRODUCTS[0];
    return { id: g.id, number: g.number, date: g.date, product: product.de, firstName: g.firstName, lastName: g.lastName, email: g.email,
      amount: 0, refunded: 0, key: g.key, source: "manuell", note: g.note || "", mailedAt: g.mailedAt || 0 };
  });
  const sales = (await listEntries()).filter((e) => e.source === "stripe" && e.type === "income").sort((a, b) => b.number.localeCompare(a.number)).map((e) => {
    let key = "";
    try { key = issue(e.session, e.version || 1); } catch { /* Signierschlüssel nicht gesetzt */ }
    const product = PRODUCTS.find((p) => p.version === (e.version || 1)) || PRODUCTS[0];
    return { id: e.id, number: e.number, date: e.date, product: product.de, firstName: e.firstName || "", lastName: e.lastName || "", email: e.email || "",
      amount: e.amount, refunded: e.refunded || 0, key, source: "stripe", note: "", mailedAt: 0 };
  });
  return [...grants, ...sales].map(withDevice).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
}

/**
 * Schlüssel von Hand ausstellen (Geschenk, Support, Rezensent). Wird mit Name, Produkt und Schlüssel in Firestore gespeichert,
 * damit die Übersicht und der Support ihn jederzeit finden. Es entsteht keine Einnahme und keine Rechnung.
 * @param issue Funktion (orderId, version) → Schlüssel
 */
async function grantLicense(input, issue) {
  const product = PRODUCTS.find((p) => p.version === (input.product === "voice" ? 2 : input.product === "recap" ? 3 : 1));
  const firstName = String(input.firstName || "").trim().slice(0, 80), lastName = String(input.lastName || "").trim().slice(0, 80);
  const email = String(input.email || "").trim().slice(0, 160);
  if (!lastName) throw new Error("Nachname fehlt");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("E-Mail-Adresse ist ungültig");
  const id = crypto.randomUUID();
  const key = issue(`grant-${id}`, product.version);
  const { doc } = await db.numbered(GRANTS, id, "LIZ", new Date().getUTCFullYear(), (number) => ({
    number, version: product.version, firstName, lastName, email, note: String(input.note || "").trim().slice(0, 300),
    key, date: new Date().toISOString().slice(0, 10), createdAt: now(), mailedAt: 0,
  }));
  return { id, product, ...doc };
}

/** Gerätebindung eines Schlüssels aufheben (Kunde wechselt das Handy); der Schlüssel lässt sich dann neu aktivieren. */
async function releaseDevice(idHex) {
  if (!/^[0-9a-f]{32}$/.test(String(idHex))) throw new Error("Schlüssel-ID ungültig");
  await db.del(BINDINGS, idHex);
}

async function markMailed(id) { await db.set(GRANTS, id, { mailedAt: now() }, { merge: true }); }

// ---------- Erstattungen ----------

/**
 * Gutschrift ("GS-JJJJ-0001") zu einem Stripe-Verkauf. Die Kennung hängt am Gesamtbetrag nach der Erstattung:
 * Auslösung hier und Meldung aus Stripe landen so auf demselben Dokument und buchen nie doppelt.
 */
async function createRefundDoc(sale, { amount, total, reason = "", note = "", actor = "", pending = false, stripeRefund = "" }) {
  const id = `rf_${sale.id}_${total}`;
  const { doc, created } = await db.numbered(ENTRIES, id, "GS", new Date().getUTCFullYear(), (number) => ({
    number, type: "refund", source: "stripe", date: new Date().toISOString().slice(0, 10), amount, project: sale.project || "Pythia Voice",
    refOf: sale.id, refNumber: sale.number, party: sale.email || sale.party || "", email: sale.email || "", name: sale.name || "",
    session: sale.session, category: "Erstattung", description: `Erstattung zu ${sale.number}`, reason, note, pending, stripeRefund,
    void: false, createdBy: actor, createdAt: now(),
  }));
  if (created) await db.set(ENTRIES, sale.id, { refunded: total }, { merge: true });
  return { id, doc: { id, ...doc }, created };
}

const bookedRefunds = async (saleId) => (await listEntries()).filter((x) => x.type === "refund" && x.refOf === saleId && !x.void).reduce((a, x) => a + x.amount, 0);

/**
 * Vollständig erstattete Verkäufe sperren ihren Lizenzschlüssel (Sammlung licenseRevoked, geprüft in activate.js).
 * shortcut: Teilerstattungen sperren nicht; die Sperre wird nicht automatisch aufgehoben, falls eine Gutschrift später storniert wird.
 */
async function revokeIfFullyRefunded(sale, total) {
  if (!sale.session || !(total >= sale.amount)) return false;
  const { idFor } = require("./_license");
  await db.set("licenseRevoked", idFor(sale.session), { session: sale.session, number: sale.number || "", at: now() }, { merge: true });
  return true;
}

/** Stripe meldet insgesamt `total` erstattet; was noch nicht als Gutschrift gebucht ist, wird nachgebucht (z. B. im Dashboard ausgelöst). */
async function bookMissingRefunds(sale, total) {
  const booked = await bookedRefunds(sale.id);
  if (total <= booked) return null;
  const doc = await createRefundDoc(sale, { amount: total - booked, total, reason: "in Stripe ausgelöst" });
  await revokeIfFullyRefunded(sale, total);
  return doc;
}

/** Erstattung zu einer Zahlung (Ereignis refund.created/refund.updated): Gesamtstand bei Stripe holen und fehlende Gutschriften buchen. */
async function syncRefundForPayment(pi) {
  if (!pi) return null;
  if (!process.env.STRIPE_READ_KEY) throw new Error("STRIPE_READ_KEY fehlt");
  const j = await stripeGet(`payment_intents/${encodeURIComponent(pi)}`, [["expand[]", "latest_charge"]]);
  const refunded = j?.latest_charge?.amount_refunded || 0;
  return refunded > 0 ? syncRefundFromCharge({ payment_intent: pi, amount_refunded: refunded }) : null;
}

/** Meldung `charge.refunded` aus dem Webhook. Nur Verkäufe, die wir kennen (über payment_intent), werden gebucht. */
async function syncRefundFromCharge(charge) {
  const pi = typeof charge?.payment_intent === "string" ? charge.payment_intent : charge?.payment_intent?.id;
  if (!pi || !(charge.amount_refunded > 0)) return null;
  const sale = (await listEntries()).find((e) => e.source === "stripe" && e.type === "income" && e.payment_intent === pi);
  return sale ? bookMissingRefunds(sale, charge.amount_refunded) : null;
}

async function stripeRefundCall(sale, amount, reason, rfId) {
  if (!process.env.STRIPE_REFUND_KEY) throw new Error("STRIPE_REFUND_KEY fehlt (eingeschränkter Stripe-Schlüssel mit Schreibrecht für Erstattungen)");
  let pi = sale.payment_intent;
  if (!pi && process.env.STRIPE_READ_KEY) pi = (await stripeGet(`checkout/sessions/${encodeURIComponent(sale.session)}`, [])).payment_intent;
  if (!pi) throw new Error("Zahlung bei Stripe nicht gefunden (payment_intent fehlt)");
  const body = new URLSearchParams({ payment_intent: pi, amount: String(amount), reason, "metadata[invoice]": sale.number, "metadata[entry]": sale.id });
  const r = await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STRIPE_REFUND_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `pv-${rfId}` },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Stripe: " + (j.error?.message || r.status));
  return j;
}

/**
 * Erstattung auslösen: erst die Gutschrift buchen (reserviert Betrag und Nummer, verhindert Doppelklick),
 * dann bei Stripe erstatten. Scheitert Stripe, wird die Gutschrift storniert und der Verkauf unverändert gelassen.
 */
async function refundSale(saleId, { amount, reason, note, notify = true } = {}, actor = "") {
  const sale = await db.get(ENTRIES, saleId);
  if (!sale || sale.source !== "stripe" || sale.type !== "income") throw new Error("Nur Stripe-Verkäufe lassen sich erstatten");
  if (sale.void) throw new Error("Stornierte Posten lassen sich nicht erstatten");
  const s = { id: saleId, ...sale };
  const booked = await bookedRefunds(saleId);
  const remaining = s.amount - booked;
  const cents_ = String(amount ?? "").trim() === "" ? remaining : cents(amount); // "5,00" und "5.00" gleichermaßen; leer = Rest
  if (!(cents_ > 0) || cents_ > remaining) throw new Error(`Betrag ungültig (höchstens ${num(remaining)} €)`);
  const why = ["requested_by_customer", "duplicate", "fraudulent"].includes(reason) ? reason : "requested_by_customer";
  const total = booked + cents_;
  const rf = await createRefundDoc(s, { amount: cents_, total, reason: why, note: String(note || "").slice(0, 300), actor, pending: true });
  if (!rf.created) throw new Error("Diese Erstattung ist bereits gebucht");
  let stripe;
  try { stripe = await stripeRefundCall(s, cents_, why, rf.id); }
  catch (e) {
    await db.set(ENTRIES, rf.id, { void: true, pending: false, failure: e.message }, { merge: true });
    await db.set(ENTRIES, saleId, { refunded: booked }, { merge: true });
    throw e;
  }
  await db.set(ENTRIES, rf.id, { pending: false, stripeRefund: stripe.id || "", stripeStatus: stripe.status || "" }, { merge: true });
  const revoked = await revokeIfFullyRefunded(s, total);
  const credit = { ...rf.doc, pending: false, stripeRefund: stripe.id || "" };
  let mailed = false;
  if (notify && s.email) { try { await mailCreditNote(credit); mailed = true; } catch (e) { console.error("Gutschrift-Mail: " + e.message); } }
  return { credit, mailed, revoked };
}

async function mailCreditNote(c) {
  const pdf = await inv.creditPdf({ number: c.number, date: c.date, amount: c.amount, refNumber: c.refNumber, email: c.email, name: c.name });
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM, to: [c.email], reply_to: "support@pythiavoice.app",
      subject: `Erstattung ${num(c.amount)} € / Refund ${num(c.amount)} €`,
      html: creditMailHtml(c),
      text: `Wir haben ${num(c.amount)} € zu deiner Rechnung ${c.refNumber} erstattet. Das Geld kommt über dein ursprüngliches Zahlungsmittel zurück, das dauert meist einige Werktage. Die Gutschrift hängt an.\n\n` +
        `We have refunded ${num(c.amount)} € for your invoice ${c.refNumber}. The money returns via your original payment method, usually within a few business days. The credit note is attached.\n`,
      attachments: [{ filename: `Gutschrift-${c.number}.pdf`, content: pdf.toString("base64") }],
    }),
  });
  if (!r.ok) throw new Error(`Mailversand ${r.status}`);
}

// ---------- FlowUnion (kroell-web): Zahlungseingänge und Rechnungs-PDF über die Nur-Lese-Schnittstelle ----------

async function feedGet(params, asBuffer = false) {
  const base = process.env.FLOWUNION_FEED_URL, key = process.env.FLOWUNION_FEED_SECRET;
  if (!base || !key) throw new Error("FlowUnion-Schnittstelle nicht eingerichtet (FLOWUNION_FEED_URL und FLOWUNION_FEED_SECRET)");
  const r = await fetch(`${base}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`FlowUnion antwortet mit ${r.status}`);
  return asBuffer ? Buffer.from(await r.arrayBuffer()) : r.json();
}

/**
 * Zahlungseingänge von FlowUnion (Bank und Stripe, je einer Rechnung zugeordnet) in [from, to] als Einnahmen buchen.
 * Idempotent je Zahlung (Kennung der Zuordnung in kroell-web). Eine einmal gebuchte Zahlung bleibt unverändert, auch wenn sie dort
 * später umgebucht wird: Korrekturen in FlowUnion erscheinen hier nicht automatisch (shortcut: bei Bedarf Abgleich von Änderungen ergänzen).
 */
async function syncFlowUnion(from, to) {
  if (!process.env.FLOWUNION_FEED_URL) return { created: 0, total: 0 };
  const j = await feedGet({ action: "payments", from, to });
  let created = 0;
  for (const p of j.payments || []) {
    const id = `fu_${p.id}`;
    const r = await db.numbered(ENTRIES, id, "FU", Number(String(p.date).slice(0, 4)), (number) => ({
      number, type: "income", source: "flowunion", date: p.date, amount: Math.round(p.amount * 100), project: "FlowUnion",
      category: "Zahlungseingang (FlowUnion)", party: p.customerName || p.counterparty || "", email: "",
      description: `Rechnung ${p.invoiceNumber}${p.purpose ? " · " + p.purpose : ""}`.slice(0, 300), refNumber: p.invoiceNumber, invoiceId: p.invoiceId,
      customerNo: p.customerNo || "", channel: p.source, counterparty: p.counterparty || "", fee: 0, refunded: 0, void: false, createdAt: now(),
    }));
    if (r.created) created++;
  }
  return { created, total: (j.payments || []).length };
}

/** Beleg als PDF zu einem Posten: Rechnung bei Stripe-Verkauf, Gutschrift bei Erstattung. */
async function documentPdf(id) {
  const e = await db.get(ENTRIES, id);
  if (e?.source === "flowunion") return e.invoiceId ? feedGet({ action: "invoice-pdf", id: e.invoiceId }, true) : null;
  if (!e || e.source !== "stripe") return null;
  if (e.type === "refund") return inv.creditPdf({ number: e.number, date: e.date, amount: e.amount, refNumber: e.refNumber, email: e.email, name: e.name });
  return inv.invoicePdf([asSession({ id, ...e })], { [asSession({ id, ...e }).id]: e.number });
}

// ---------- Belege (PDF) ----------

const listInbox = async () => (await db.list(INBOX, { orderBy: "createdAt" })).filter((x) => x.status === "ready")
  .map(({ id, filename, size, createdAt }) => ({ id, filename, size, createdAt }));

async function inboxStart({ filename, contentType, size }, actor = "") {
  const name = cleanName(filename), n = Number(size || 0);
  if (contentType !== "application/pdf" && !name.toLowerCase().endsWith(".pdf")) throw new Error("Nur PDF-Dateien");
  if (!(n > 0) || n > MAX_RECEIPT) throw new Error("Datei zu groß (höchstens 15 MB)");
  const id = crypto.randomUUID();
  await db.set(INBOX, id, { filename: name, size: n, status: "uploading", createdBy: actor, createdAt: now() });
  return { id, filename: name, size: n };
}

async function inboxChunk(id, index, data) {
  const item = await db.get(INBOX, id);
  if (!item || item.status !== "uploading" || !Number.isInteger(index) || index < 0 || index > 31) throw new Error("Upload fehlgeschlagen");
  if (!data || data.length > 1500000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Upload fehlgeschlagen");
  await db.set(PARTS, `${id}-${index}`, { data });
}

async function inboxFinish(id, chunks) {
  const item = await db.get(INBOX, id);
  if (!item || item.status !== "uploading" || !Number.isInteger(chunks) || chunks < 1 || chunks > 32) throw new Error("Upload fehlgeschlagen");
  try {
    const parts = [];
    for (let i = 0; i < chunks; i++) {
      const p = await db.get(PARTS, `${id}-${i}`);
      if (!p) throw new Error("Teil fehlt");
      parts.push(Buffer.from(p.data, "base64"));
    }
    const pdf = Buffer.concat(parts);
    if (pdf.length !== item.size || pdf.length > MAX_RECEIPT) throw new Error("Größe stimmt nicht");
    if (!pdf.subarray(0, Math.min(1024, pdf.length)).includes(Buffer.from("%PDF-"))) throw new Error("Keine PDF");
    await db.putBlob(BLOBS, id, pdf, { filename: item.filename });
    await db.set(INBOX, id, { status: "ready", blobId: id, confirmedAt: now() }, { merge: true });
    return { id, filename: item.filename, size: pdf.length };
  } catch (e) {
    await db.delBlob(BLOBS, id); await db.del(INBOX, id);
    throw new Error("Upload fehlgeschlagen: " + e.message);
  } finally {
    for (let i = 0; i < chunks; i++) await db.del(PARTS, `${id}-${i}`);
  }
}

async function deleteInbox(id) {
  const item = await db.get(INBOX, id);
  if (item) { await db.delBlob(BLOBS, item.blobId || id); await db.del(INBOX, id); }
}

async function assignReceipt(entryId, inboxId) {
  const [entry, item] = await Promise.all([db.get(ENTRIES, entryId), db.get(INBOX, inboxId)]);
  if (!entry || !item || item.status !== "ready" || !item.blobId) throw new Error("Beleg nicht gefunden");
  if (entry.type !== "expense") throw new Error("Belege gibt es nur zu Ausgaben");
  if (entry.receiptStatus === "ready") throw new Error("Beleg ist bereits zugeordnet und gesperrt");
  const receipt = { receiptBlobId: item.blobId, receiptFilename: item.filename, receiptStatus: "ready", receiptUpdatedAt: now() };
  await db.set(ENTRIES, entryId, receipt, { merge: true });
  await db.del(INBOX, inboxId);
  return receipt;
}

const receiptOf = async (entryId) => {
  const e = await db.get(ENTRIES, entryId);
  return e?.receiptBlobId ? db.getBlob(BLOBS, e.receiptBlobId) : null;
};
const inboxFile = async (id) => {
  const item = await db.get(INBOX, id);
  return item?.status === "ready" ? db.getBlob(BLOBS, item.blobId || id) : null;
};

// ---------- Auswertung ----------

const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }; // Excel-Formeln entschärfen
const csv = (head, rows) => "﻿" + [head, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
const inRange = (e, from, to) => e.date >= from && e.date <= to;

function totals(entries) {
  const live = entries.filter((e) => !e.void);
  const income = live.filter((e) => e.type === "income"), exp = live.filter((e) => e.type === "expense");
  const sum = (l, k = "amount") => l.reduce((a, e) => a + Number(e[k] || 0), 0);
  const t = { income: sum(income), refunds: sum(income, "refunded"), fees: sum(income, "fee"), expenses: sum(exp), sales: income.filter((e) => e.source === "stripe").length };
  t.result = t.income - t.refunds - t.fees - t.expenses;
  return t;
}

/** Kennzahlen je Projekt, in fester Reihenfolge; nicht belegte Projekte entfallen. */
function byProject(entries) {
  return PROJECTS.map((name) => ({ project: name, ...totals(entries.filter((e) => projectOf(e) === name)), count: entries.filter((e) => projectOf(e) === name).length }))
    .filter((r) => r.count > 0);
}

const salesCsv = (entries) => csv(["Nummer", "Datum", "Art", "Quelle", "Projekt", "Kunde", "Kategorie", "Brutto EUR", "Stripe-Gebühr EUR", "Erstattet EUR", "Status"],
  entries.filter((e) => e.type === "income").map((e) => [e.number, e.date, "Einnahme", srcLabel(e), projectOf(e), e.party, e.category,
    num(e.amount), num(e.fee), num(e.refunded), e.void ? "storniert" : "gültig"]));
const expensesCsv = (entries) => csv(["Belegnummer", "Datum", "Projekt", "Lieferant", "Beschreibung", "Kategorie", "Betrag EUR", "Beleg", "Status"],
  entries.filter((e) => e.type === "expense").map((e) => [e.number, e.date, projectOf(e), e.party, e.description, e.category, num(e.amount),
    e.receiptStatus === "ready" ? e.receiptFilename : "", e.void ? "storniert" : "gültig"]));

/** Stripe-Verkauf als Sitzungs-Ersatz für die Rechnungsseite. */
const asSession = (e) => ({ id: e.session || e.id, created: e.created || unix(e.date), amount_total: e.amount, customer_details: { email: e.email, name: e.name }, item: e.item });

async function reportPdf(number, from, to, entries, t) {
  const doc = await PDFDocument.create();
  const fonts = await inv.fontsFor(doc);
  let p, w, y;
  const page = (title) => { p = doc.addPage([595, 842]); w = inv.writer(p, fonts); y = 790; w(title, 56, y, 14, true); y -= 28; };
  page(`Bericht ${number}: ${inv.de(from)} bis ${inv.de(to)}`);
  const lines = [["Einnahmen (brutto)", num(t.income)], ["Erstattungen", "-" + num(t.refunds)], ["Stripe-Gebühren", "-" + num(t.fees)], ["Ausgaben", "-" + num(t.expenses)], ["Ergebnis", num(t.result)]];
  lines.forEach(([l, v], i) => { const b = i === lines.length - 1; w(l, 56, y, 12, b); w(v + " €", 440, y, 12, b); y -= 20; });
  y -= 10;
  w(`${t.sales} Verkäufe über Stripe. Stornierte Posten sind nicht eingerechnet.`, 56, y, 10, false, inv.colors.gray); y -= 14;
  w(inv.KLEIN, 56, y, 10, false, inv.colors.gray); y -= 14;
  w("Ergebnis = Einnahmen - Erstattungen - Stripe-Gebühren - Ausgaben. Keine Steuerberechnung.", 56, y, 10, false, inv.colors.gray);
  y -= 30;
  w("Je Projekt", 56, y, 12, true); y -= 20;
  for (const r of byProject(entries)) {
    w(r.project, 56, y, 11); w(`Einnahmen ${num(r.income)}  Ausgaben ${num(r.expenses)}  Ergebnis ${num(r.result)} €`, 190, y, 11); y -= 18;
  }
  const table = (title, head, xs, rows) => {
    page(title); head.forEach((h, i) => w(h, xs[i], y, 9, true)); y -= 16;
    for (const r of rows) {
      if (y < 60) { page(title + " (Fortsetzung)"); head.forEach((h, i) => w(h, xs[i], y, 9, true)); y -= 16; }
      r.forEach((c, i) => w(String(c).slice(0, i === 2 ? 34 : 30), xs[i], y, 9));
      y -= 13;
    }
  };
  const asc = [...entries].sort((a, b) => a.number.localeCompare(b.number));
  table("Einnahmen", ["Nummer", "Datum", "Kunde", "Brutto €", "Gebühr €"], [56, 150, 220, 430, 490],
    asc.filter((e) => e.type === "income").map((e) => [e.number, inv.de(e.date), e.party, num(e.amount), num(e.fee)]));
  table("Ausgaben", ["Nummer", "Datum", "Lieferant / Beschreibung", "Betrag €", "Status"], [56, 150, 220, 430, 490],
    asc.filter((e) => e.type === "expense").map((e) => [e.number, inv.de(e.date), `${e.party}${e.description ? " - " + e.description : ""}`, num(e.amount), e.void ? "storniert" : ""]));
  const sales = asc.filter((e) => e.source === "stripe" && e.type === "income" && !e.void);
  if (sales.length && sales.length <= 200) for (const e of sales) inv.invoicePage(doc, fonts, asSession(e), e.number);
  return Buffer.from(await doc.save());
}

/** Bericht für [from, to] (inklusive): speichert Kennzahlen und Dateien, gibt die Metadaten zurück. */
async function createReport(from, to, project = "") {
  if (!YMD.test(from || "") || !YMD.test(to || "") || from > to) throw new Error("Zeitraum ungültig");
  await syncStripe(from, to);
  await syncFlowUnion(from, to).catch((e) => console.error("FlowUnion-Abgleich: " + e.message)); // ein Ausfall dort darf den Bericht nicht verhindern
  if (project && !PROJECTS.includes(project)) throw new Error("Unbekanntes Projekt");
  const entries = (await listEntries()).filter((e) => inRange(e, from, to) && (!project || projectOf(e) === project));
  const t = totals(entries);
  const number = await db.nextNumber("BER", new Date().getUTCFullYear());
  const pdf = await reportPdf(number, from, to, entries, t);
  const files = { einnahmen: Buffer.from(salesCsv(entries), "utf8"), ausgaben: Buffer.from(expensesCsv(entries), "utf8"), pdf };
  for (const [k, buf] of Object.entries(files)) await db.putBlob(REPORT_BLOBS, `${number}-${k}`, buf, { type: k });
  const meta = { number, from, to, project: project || "", totals: t, byProject: byProject(entries), createdAt: now(), entries: entries.length };
  await db.set(REPORTS, number, meta);
  return { ...meta, files };
}

const listReports = async () => (await db.list(REPORTS, { orderBy: "number" }));
async function reportFile(number, type) {
  if (!["einnahmen", "ausgaben", "pdf"].includes(type)) return null;
  const meta = await db.get(REPORTS, number);
  const b = meta ? await db.getBlob(REPORT_BLOBS, `${number}-${type}`) : null;
  return b ? { number, data: b.data } : null;
}

/** Bericht an dich selbst mailen (nicht an den Steuerberater). */
async function mailReport(report) {
  const t = report.totals;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to: [process.env.REPORT_EMAIL || "support@pythiavoice.app"],
      subject: `Pythia Voice Bericht ${report.number}: ${report.from} bis ${report.to}`,
      text: `Bericht ${report.number} für ${report.from} bis ${report.to}\n\nEinnahmen: ${num(t.income)} €\nErstattungen: ${num(t.refunds)} €\n` +
        `Stripe-Gebühren: ${num(t.fees)} €\nAusgaben: ${num(t.expenses)} €\nErgebnis: ${num(t.result)} €\n\n` +
        `Anhänge: Einnahmen (CSV), Ausgaben (CSV), Bericht mit Rechnungen (PDF).\n`,
      attachments: [
        { filename: `${report.number}-Einnahmen.csv`, content: report.files.einnahmen.toString("base64") },
        { filename: `${report.number}-Ausgaben.csv`, content: report.files.ausgaben.toString("base64") },
        { filename: `${report.number}-Bericht.pdf`, content: report.files.pdf.toString("base64") },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Mailversand ${r.status}`);
}

// ---------- Steuerberater-Paket (ZIP ohne Kompression, wie in der Vorlage) ----------

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zipStore(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, "/")), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data), crc = crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x800, 6); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    locals.push(l, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(c, name);
    offset += l.length + name.length + data.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

/** ZIP mit Postenliste, Ausgabenbelegen und erzeugten Rechnungen für [from, to]. */
async function taxPackage(from, to, project = "") {
  if (!YMD.test(from || "") || !YMD.test(to || "") || from > to) throw new Error("Zeitraum ungültig");
  const entries = (await listEntries()).filter((e) => inRange(e, from, to) && (!project || projectOf(e) === project)).sort((a, b) => a.number.localeCompare(b.number));
  const head = ["Nummer", "Datum", "Art", "Quelle", "Projekt", "Partei", "Kategorie", "Beschreibung", "Brutto EUR", "Stripe-Gebühr EUR", "Erstattet EUR", "Beleg", "Status"];
  const rows = entries.map((e) => [e.number, e.date, e.type === "income" ? "Einnahme" : e.type === "refund" ? "Erstattung" : "Ausgabe", srcLabel(e), projectOf(e), e.party,
    e.category, e.description, num(e.amount), num(e.fee), num(e.refunded), e.receiptStatus === "ready" ? e.receiptFilename : "", e.void ? "storniert" : "gültig"]);
  const files = [{ name: "posten.csv", data: Buffer.from(csv(head, rows), "utf8") }];
  const seenFu = new Set();
  for (const e of entries) {
    if (e.void) continue;
    if (e.receiptStatus === "ready" && e.receiptBlobId) {
      const b = await db.getBlob(BLOBS, e.receiptBlobId).catch(() => null);
      if (b) files.push({ name: `Belege/${e.number}_${cleanName(e.receiptFilename)}`, data: b.data });
    }
    if (e.source === "stripe" && e.type === "income") files.push({ name: `Rechnungen/${e.number}.pdf`, data: await inv.invoicePdf([asSession(e)], { [asSession(e).id]: e.number }) });
    if (e.type === "refund") files.push({ name: `Gutschriften/${e.number}.pdf`, data: await documentPdf(e.id) });
    if (e.source === "flowunion" && e.invoiceId && !seenFu.has(e.invoiceId)) {
      seenFu.add(e.invoiceId);
      const pdf = await documentPdf(e.id).catch((err) => { console.error("FlowUnion-PDF: " + err.message); return null; });
      if (pdf) files.push({ name: `Rechnungen-FlowUnion/${cleanName(e.refNumber)}.pdf`, data: pdf });
    }
  }
  return zipStore(files);
}

/** Posten des Zeitraums als CSV (Bank/Excel). */
async function entriesCsv(from, to, project = "") {
  const entries = (await listEntries()).filter((e) => inRange(e, from, to) && (!project || projectOf(e) === project)).sort((a, b) => a.number.localeCompare(b.number));
  return csv(["Nummer", "Datum", "Art", "Quelle", "Projekt", "Partei", "Kategorie", "Beschreibung", "Einnahme EUR", "Ausgabe EUR", "Stripe-Gebühr EUR", "Erstattet EUR", "Status"],
    entries.map((e) => [e.number, e.date, e.type === "income" ? "Einnahme" : e.type === "refund" ? "Erstattung" : "Ausgabe", srcLabel(e), projectOf(e), e.party, e.category,
      e.description, e.type === "income" ? num(e.amount) : "", e.type === "expense" ? num(e.amount) : e.type === "refund" ? "-" + num(e.amount) : "", num(e.fee), num(e.refunded), e.void ? "storniert" : "gültig"]));
}

module.exports = {
  PROJECTS, projectOf, byProject, assignProject, lockReason, EXPENSE_CATEGORIES, INCOME_CATEGORIES, cents, listEntries, addEntry, updateEntry, voidEntry, invoiceFor, syncStripe, paidSessions,
  listInbox, inboxStart, inboxChunk, inboxFinish, deleteInbox, assignReceipt, receiptOf, inboxFile,
  productOf, syncFlowUnion, totals, refundSale, syncRefundFromCharge, syncRefundForPayment, documentPdf, listLicenses, grantLicense, releaseDevice, markMailed, splitName, createReport, listReports, reportFile, mailReport, taxPackage, entriesCsv,
};
