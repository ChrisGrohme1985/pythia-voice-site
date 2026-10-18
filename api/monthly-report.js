// Monatsbericht: legt am 1. jeden Monats den Bericht des Vormonats an (im internen Bereich von grohme.dev abrufbar) und mailt ihn an dich selbst.
// Aufruf durch den Vercel-Cron (siehe vercel.json) oder manuell mit ?month=JJJJ-MM. Zugriff nur mit CRON_SECRET.
const books = require("./_books");
const db = require("./_db");

module.exports = async (req, res) => {
  const auth = req.headers.authorization || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const m = String(req.query?.month || "").match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const y = m ? +m[1] : now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const mo = m ? +m[2] - 1 : (now.getUTCMonth() + 11) % 12;
  const pad = (n) => String(n).padStart(2, "0");
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  // Abgelaufene Ratenbegrenzungs- und Testphasen-Einträge löschen (Löschfristen laut Datenschutzerklärung); darf den Bericht nicht verhindern
  for (const c of ["authRate", "trials"]) await db.purgeExpired(c).catch((e) => console.error(`Aufräumen ${c}: ${e.message}`));
  try {
    const rep = await books.createReport(`${y}-${pad(mo + 1)}-01`, `${y}-${pad(mo + 1)}-${pad(last)}`);
    await books.mailReport(rep);
    return res.status(200).json({ ok: true, report: rep.number, sales: rep.totals.sales });
  } catch (e) {
    console.error(e.message);
    return res.status(500).end();
  }
};
