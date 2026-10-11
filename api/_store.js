// Kleiner Schlüssel-Wert-Speicher über die REST-Schnittstelle von Upstash Redis (Vercel: Storage → Upstash Redis / KV).
// Atomare Zähler (INCR) tragen die fortlaufenden Nummern. Belege liegen als JSON unter "pv:"-Schlüsseln.
const base = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function cmd(...args) {
  if (!base() || !token()) throw new Error("Speicher nicht eingerichtet (UPSTASH_REDIS_REST_URL/TOKEN fehlen)");
  const r = await fetch(base(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("Speicher: " + (j.error || r.status));
  return j.result;
}

const get = async (k) => { const v = await cmd("GET", k); return v == null ? null : JSON.parse(v); };
const set = (k, v, exSec) => (exSec ? cmd("SET", k, JSON.stringify(v), "EX", String(exSec)) : cmd("SET", k, JSON.stringify(v)));
const setnx = async (k, v, exSec) => (await cmd(...["SET", k, JSON.stringify(v), "NX", ...(exSec ? ["EX", String(exSec)] : [])])) === "OK";
const incr = (k) => cmd("INCR", k);
const zadd = (k, score, member) => cmd("ZADD", k, String(score), member);
const zrevrange = (k) => cmd("ZREVRANGE", k, "0", "-1");
const del = (k) => cmd("DEL", k);

module.exports = { get, set, setnx, incr, zadd, zrevrange, del };
