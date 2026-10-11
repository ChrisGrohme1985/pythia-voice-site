// Belege (Rechnung nach § 33 UStDV, Kleinbetrag bis 250 €) als PDF aus Stripe-Checkout-Sitzungen.
// Gemeinsam genutzt vom Webhook (Beleg zur Kaufmail) und von den Berichten (_books.js).
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const SELLER = ["Christoph Grohme", "Im Bröltal 108", "53773 Hennef", "Deutschland", "support@pythiavoice.app"];
const KLEIN = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.";

const eur = (cents) => (Number(cents || 0) / 100).toFixed(2).replace(".", ",") + " €";
const day = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);
const de = (ymd) => String(ymd).split("-").reverse().join(".");
// Standardschrift kennt nur WinAnsi: alles andere (z. B. exotische Zeichen in E-Mails) wird zu "?"
const safe = (s) => String(s ?? "").replace(/[^ -~ -ÿ€]/g, "?");

/** Ersatznummer, falls kein Speicher erreichbar ist (nicht fortlaufend). Normal kommt die Nummer aus _books.invoiceFor. */
const belegNr = (s) => `PV-${day(s.created).replace(/-/g, "")}-${String(s.id).slice(-6).toUpperCase()}`;

async function fontsFor(doc) {
  return { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold) };
}

const colors = { ink: rgb(0.06, 0.09, 0.19), gray: rgb(0.35, 0.38, 0.45) };

/** Textzeichner für eine Seite. */
function writer(p, fonts) {
  return (txt, x, y, size = 11, bold = false, color = colors.ink) =>
    p.drawText(safe(txt), { x, y, size, font: bold ? fonts.b : fonts.r, color });
}

function invoicePage(doc, fonts, s, nr) {
  const p = doc.addPage([595, 842]);
  const t = writer(p, fonts);
  t("Pythia Voice", 56, 780, 20, true);
  SELLER.forEach((l, i) => t(l, 56, 756 - i * 14, 10, false, colors.gray));
  t("Rechnung (Kleinbetragsrechnung)", 56, 650, 16, true);
  t("Rechnungsnummer:", 56, 620); t(nr, 190, 620);
  t("Datum / Leistungsdatum:", 56, 602); t(de(day(s.created)), 190, 602);
  t("Kunde (E-Mail):", 56, 584); t(s.customer_details?.email || s.customer_email || "-", 190, 584);
  t("Leistung", 56, 530, 11, true); t("Betrag", 470, 530, 11, true);
  p.drawLine({ start: { x: 56, y: 522 }, end: { x: 539, y: 522 }, thickness: 0.7, color: colors.gray });
  t("Lebenslange Lizenz für die Android-App Pythia Voice (digital)", 56, 504);
  t(eur(s.amount_total), 470, 504);
  p.drawLine({ start: { x: 56, y: 490 }, end: { x: 539, y: 490 }, thickness: 0.7, color: colors.gray });
  t("Gesamtbetrag", 56, 468, 12, true); t(eur(s.amount_total), 470, 468, 12, true);
  t(KLEIN, 56, 430, 10);
  t("Bezahlt per Stripe. Der Betrag ist beglichen.", 56, 412, 10, false, colors.gray);
}

/** @param sessions Stripe-Checkout-Sitzungen, @param numbers Map Sitzungs-ID → Rechnungsnummer (optional). */
async function invoicePdf(sessions, numbers = {}) {
  const doc = await PDFDocument.create();
  const fonts = await fontsFor(doc);
  for (const s of sessions) invoicePage(doc, fonts, s, numbers[s.id] || belegNr(s));
  return Buffer.from(await doc.save());
}

module.exports = { invoicePdf, invoicePage, fontsFor, writer, colors, belegNr, eur, day, de, safe, KLEIN, SELLER };
