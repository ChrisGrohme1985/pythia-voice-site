// Zugangscodes für Freunde und Tester: dauerhaft Pro ohne Kauf. Vercel-Variable AI_FRIEND_CODES = "name:CODE,name2:CODE2".
// Einen Code löschen sperrt ihn sofort (die App verwirft ihn beim nächsten Diktat).
const crypto = require("crypto");

const FORMAT = /^[A-Za-z0-9-]{8,64}$/;

/** Name zum Code oder null; vergleicht in konstanter Zeit, damit sich Codes nicht über die Antwortzeit erraten lassen. */
function friend(code) {
  if (!code || !FORMAT.test(code)) return null;
  const want = crypto.createHash("sha256").update(code.trim().toUpperCase()).digest();
  let hit = null;
  for (const entry of (process.env.AI_FRIEND_CODES || "").split(",")) {
    const i = entry.indexOf(":");
    if (i < 1) continue;
    const name = entry.slice(0, i).trim(), c = entry.slice(i + 1).trim();
    if (!c) continue;
    const have = crypto.createHash("sha256").update(c.toUpperCase()).digest();
    if (crypto.timingSafeEqual(want, have)) hit = name;
  }
  return hit;
}

module.exports = { friend, FORMAT };
