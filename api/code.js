// POST /api/code {"code": "..."}: prüft einen Zugangscode für die App (200 = gültig, 404 = unbekannt, 400 = Format).
const { friend, FORMAT } = require("./_codes");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  const code = String((req.body && req.body.code) || "").trim();
  if (!FORMAT.test(code)) return res.status(400).json({ error: "invalid" });
  await new Promise((r) => setTimeout(r, 400)); // bremst Durchprobieren
  return friend(code) ? res.status(200).json({ ok: true }) : res.status(404).json({ error: "unknown" });
};
