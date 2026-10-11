// Erzeugt Lizenzschlüssel im selben Format wie tools/license_gen.py (siehe dort und app/.../License.kt).
// Der private Schlüssel kommt nur aus der Umgebungsvariablen PYTHIA_LICENSE_PRIVATE (PEM oder Base64 davon), nie aus dem Repo.
const crypto = require("crypto");

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford-Base32
const CONTEXT = Buffer.from("PYTHIAVOICE-LICENSE-1");

function b32(buf) {
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  bits += "0".repeat((5 - (bits.length % 5)) % 5);
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function privateKey() {
  let pem = process.env.PYTHIA_LICENSE_PRIVATE || "";
  if (!pem) throw new Error("PYTHIA_LICENSE_PRIVATE fehlt");
  if (!pem.includes("BEGIN")) pem = Buffer.from(pem, "base64").toString("utf8");
  return crypto.createPrivateKey(pem.replace(/\\n/g, "\n"));
}

/**
 * Gleiche Bestellung ergibt immer denselben Schlüssel: Die 128-Bit-ID wird aus der Bestell-ID abgeleitet (HMAC),
 * so erzeugt ein erneut zugestellter Webhook keinen zweiten Schlüssel.
 */
function issue(orderId, idSecret = process.env.PYTHIA_ID_SECRET) {
  if (!idSecret) throw new Error("PYTHIA_ID_SECRET fehlt");
  const id = crypto.createHmac("sha256", idSecret).update(String(orderId)).digest().subarray(0, 16);
  const payload = Buffer.concat([Buffer.from([1]), id]);
  const sig = crypto.sign(null, Buffer.concat([CONTEXT, payload]), privateKey());
  return "PV-" + b32(Buffer.concat([payload, sig])).match(/.{1,5}/g).join("-");
}

module.exports = { issue, b32 };
