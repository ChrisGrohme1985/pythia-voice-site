// Belege (Rechnung nach § 33 UStDV, Kleinbetrag bis 250 €) als PDF aus Stripe-Checkout-Sitzungen.
// Gemeinsam genutzt vom Webhook (Beleg zur Kaufmail) und vom Monatsbericht für den Steuerberater.
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const SELLER = ["Christoph Grohme", "Im Bröltal 108", "53773 Hennef", "Deutschland", "support@pythiavoice.app"];
const KLEIN = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.";

const eur = (cents) => (Number(cents || 0) / 100).toFixed(2).replace(".", ",") + " €";
const day = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);
const de = (unix) => day(unix).split("-").reverse().join(".");
// Standardschrift kennt nur WinAnsi: alles andere (z. B. exotische Zeichen in E-Mails) wird zu "?"
const safe = (s) => String(s ?? "").replace(/[^ -~ -ÿ€]/g, "?");

/** Stabile Belegnummer aus Datum und Sitzungs-ID. Eine fortlaufende Nummer ist bei Kleinbeträgen nicht vorgeschrieben. */
const belegNr = (s) => `PV-${day(s.created).replace(/-/g, "")}-${String(s.id).slice(-6).toUpperCase()}`;

function page(doc, fonts, s) {
  const p = doc.addPage([595, 842]);
  const ink = rgb(0.06, 0.09, 0.19), gray = rgb(0.35, 0.38, 0.45);
  const t = (txt, x, y, size = 11, font = fonts.r, color = ink) => p.drawText(safe(txt), { x, y, size, font, color });
  t("Pythia Voice", 56, 780, 20, fonts.b);
  SELLER.forEach((l, i) => t(l, 56, 756 - i * 14, 10, fonts.r, gray));
  t("Rechnung (Kleinbetragsrechnung)", 56, 650, 16, fonts.b);
  t("Rechnungsnummer:", 56, 620); t(belegNr(s), 190, 620);
  t("Datum / Leistungsdatum:", 56, 602); t(de(s.created), 190, 602);
  t("Kunde (E-Mail):", 56, 584); t(s.customer_details?.email || s.customer_email || "-", 190, 584);
  t("Leistung", 56, 530, 11, fonts.b); t("Betrag", 470, 530, 11, fonts.b);
  p.drawLine({ start: { x: 56, y: 522 }, end: { x: 539, y: 522 }, thickness: 0.7, color: gray });
  t("Lebenslange Lizenz für die Android-App Pythia Voice (digital)", 56, 504);
  t(eur(s.amount_total), 470, 504);
  p.drawLine({ start: { x: 56, y: 490 }, end: { x: 539, y: 490 }, thickness: 0.7, color: gray });
  t("Gesamtbetrag", 56, 468, 12, fonts.b); t(eur(s.amount_total), 470, 468, 12, fonts.b);
  t(KLEIN, 56, 430, 10);
  t("Bezahlt per Stripe. Der Betrag ist beglichen.", 56, 412, 10, fonts.r, gray);
}

/** @param sessions Stripe-Checkout-Sitzungen; ergibt ein PDF mit einer Seite je Beleg. */
async function invoicePdf(sessions) {
  const doc = await PDFDocument.create();
  const fonts = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold) };
  for (const s of sessions) page(doc, fonts, s);
  return Buffer.from(await doc.save());
}

module.exports = { invoicePdf, belegNr, eur, day };
