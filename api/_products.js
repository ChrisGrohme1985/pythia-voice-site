// Produkte der Startseite: liegen in Firestore (Dokument siteProducts/products). Ohne Eintrag gelten die Standardwerte unten.
const db = require("./_db");

const FIELDS = ["name", "kind", "text", "price", "url", "status"];
const DEFAULT = [
  { name: "Pythia Voice", kind: "App für Android", text: "Diktieren in jede App: Du sprichst, Pythia schreibt. Einmal zahlen, kein Abo.", price: "19,99 €", url: "https://www.pythiavoice.app/de/", status: "Verfügbar" },
  { name: "Pythia Voice Sprachnachricht", kind: "Zusatzfunktion zu Pythia Voice", text: "Lange Sprachnachrichten als Text lesen, statt sie anzuhören.", price: "", url: "https://www.pythiavoice.app/de/#sprachnachrichten", status: "Verfügbar" },
  { name: "Pythia Recap", kind: "App für Android", text: "Besprechungen und Sprachnotizen zusammenfassen. Einmal zahlen, kein Abo.", price: "19,99 €", url: "https://www.pythiavoice.app/recap", status: "In Vorbereitung" },
  { name: "FlowUnion", kind: "Betriebssoftware", text: "Angebote, Aufträge, Objekte, Teams, Tickets, Dokumentation, Rechnungen und Zahlungen in einem System. Schwerpunkt Hausmeisterservice, Gebäudedienstleistung und Handwerk.", price: "", url: "https://flowunion.de/", status: "Verfügbar" },
];

/** Prüft jeden Eintrag, bevor er gespeichert oder ausgeliefert wird (url landet als href). */
function clean(list) {
  if (!Array.isArray(list) || list.length > 30) throw new Error("Produktliste ungültig");
  return list.map((p) => {
    const o = {};
    for (const f of FIELDS) o[f] = String(p?.[f] ?? "").trim().slice(0, 500);
    if (!o.name) throw new Error("Jedes Produkt braucht einen Namen.");
    if (o.url && !/^(https:\/\/|\/(?!\/))/.test(o.url)) throw new Error(`Link von „${o.name}“ muss mit https:// beginnen.`);
    return o;
  });
}

async function load() {
  const d = await db.get("siteProducts", "products");
  return d?.list || DEFAULT;
}

async function save(list) {
  const cleaned = clean(list);
  await db.set("siteProducts", "products", { list: cleaned, updatedAt: Math.floor(Date.now() / 1000) });
  return cleaned;
}

module.exports = { load, save, clean, DEFAULT };
