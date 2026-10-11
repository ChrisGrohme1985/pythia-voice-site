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
function issue(orderId, version = 1, idSecret = process.env.PYTHIA_ID_SECRET) {
  if (!idSecret) throw new Error("PYTHIA_ID_SECRET fehlt");
  const id = crypto.createHmac("sha256", idSecret).update(String(orderId)).digest().subarray(0, 16);
  const payload = Buffer.concat([Buffer.from([version]), id]);
  const sig = crypto.sign(null, Buffer.concat([CONTEXT, payload]), privateKey());
  return "PV-" + b32(Buffer.concat([payload, sig])).match(/.{1,5}/g).join("-");
}

const RECEIPT_CONTEXT = Buffer.from("PYTHIAVOICE-ACTIVATION-1");

function b32decode(text) {
  let bits = 0, n = 0;
  const out = [];
  for (const c of text) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return null;
    bits = ((bits << 5) | v) & 0xffff; n += 5;
    if (n >= 8) { out.push((bits >> (n - 8)) & 0xff); n -= 8; }
  }
  return Buffer.from(out);
}

/** Prüft einen Schlüssel genau wie die App (Normalisierung, Ed25519-Signatur). @returns {{version:number,idHex:string}|null} */
function parse(key) {
  const k = String(key).toUpperCase().replace(/[^0-9A-Z]/g, "");
  const raw = b32decode((k.startsWith("PV") ? k.slice(2) : k).replace(/O/g, "0").replace(/[IL]/g, "1"));
  if (!raw || raw.length < 81) return null;
  const ok = crypto.verify(null, Buffer.concat([CONTEXT, raw.subarray(0, 17)]), crypto.createPublicKey(privateKey()), raw.subarray(17, 81));
  return ok ? { version: raw[0], idHex: raw.subarray(1, 17).toString("hex") } : null;
}

/** Quittung "dieses Gerät darf diesen Schlüssel nutzen": Produkt, Schlüssel-ID und Geräte-Hash, vom Server signiert (andere Signaturdomäne als der Schlüssel selbst). */
function receipt(version, idHex, deviceHashHex) {
  const payload = Buffer.concat([Buffer.from([version]), Buffer.from(idHex, "hex"), Buffer.from(deviceHashHex, "hex")]);
  return Buffer.concat([payload, crypto.sign(null, Buffer.concat([RECEIPT_CONTEXT, payload]), privateKey())]).toString("base64url");
}

module.exports = { issue, b32, parse, receipt };
