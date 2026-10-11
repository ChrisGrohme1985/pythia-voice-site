// Interner Bereich (/intern): Anmeldung per Einmalcode (wie in zuhause-web), Ausgaben, Rechnungen und Berichte.
// Eine einzige Funktion mit ?action=..., damit die Funktionszahl des Vercel-Tarifs nicht aufgebraucht wird.
// Umgebungsvariablen: ADMIN_SECRET, ADMIN_EMAIL (Standard support@pythiavoice.app), RESEND_API_KEY, RESEND_FROM,
//                     Speicher (UPSTASH_REDIS_REST_URL/TOKEN) sowie die Bericht-Variablen aus _books.js
const crypto = require("crypto");
const store = require("./_store");
const books = require("./_books");

const COOKIE = "pv_admin";
const SESSION_SEC = 12 * 3600;
const b64 = (s) => Buffer.from(s).toString("base64url");
const hmac = (s) => crypto.createHmac("sha256", process.env.ADMIN_SECRET).update(s).digest("base64url");
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const adminEmail = () => process.env.ADMIN_EMAIL || "support@pythiavoice.app";

function token() {
  const body = b64(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_SEC }));
  return `${body}.${hmac(body)}`;
}
function loggedIn(req) {
  if (!process.env.ADMIN_SECRET) return false;
  const c = String(req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(COOKIE + "="));
  const [body, sig] = String(c || "").slice(COOKIE.length + 1).split(".");
  if (!body || !sig || !same(sig, hmac(body))) return false;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()).exp > Date.now() / 1000; } catch { return false; }
}

async function mail(to, subject, text) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.RESEND_FROM, to, subject, text }),
  });
  if (!r.ok) throw new Error(`Mailversand ${r.status}`);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const action = String(q.action || "");
  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : req.body || {};
  const reply = (code, json) => res.status(code).json(json);
  if (!process.env.ADMIN_SECRET) return reply(503, { error: "not_configured" });
  if (req.method === "POST" && req.headers["x-requested-with"] !== "pv") return reply(403, { error: "forbidden" }); // einfacher CSRF-Schutz
  try {
    // --- Anmeldung ---
    if (action === "login-request" && req.method === "POST") {
      const hour = Math.floor(Date.now() / 3.6e6);
      if ((await store.incr(`pv:rl:otp:${hour}`)) > 5) return reply(429, { error: "too_many" });
      const code = String(crypto.randomInt(100000, 1000000));
      await store.set("pv:otp", { hash: hmac("otp:" + code), tries: 0 }, 600);
      await mail([adminEmail()], "Pythia Voice: Anmeldecode", `Dein Code: ${code}\n\nGültig 10 Minuten. Nicht angefordert? Dann ignoriere diese Mail.`);
      return reply(200, { ok: true });
    }
    if (action === "login-verify" && req.method === "POST") {
      const o = await store.get("pv:otp");
      if (!o || o.tries >= 5) return reply(401, { error: "invalid" });
      o.tries += 1; await store.set("pv:otp", o, 600);
      if (!same(o.hash, hmac("otp:" + String(body.code || "").trim()))) return reply(401, { error: "invalid" });
      await store.del("pv:otp");
      res.setHeader("Set-Cookie", `${COOKIE}=${token()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SEC}`);
      return reply(200, { ok: true });
    }
    if (action === "logout") {
      res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return reply(200, { ok: true });
    }
    if (!loggedIn(req)) return reply(401, { error: "unauthorized" });

    // --- Daten ---
    if (action === "me") return reply(200, { ok: true, categories: books.CATEGORIES });
    if (action === "sales") return reply(200, { sales: await books.listSales(q.from, q.to) });
    if (action === "expenses") return reply(200, { expenses: await books.listExpenses(q.from, q.to) });
    if (action === "expense-add" && req.method === "POST") return reply(200, { expense: await books.addExpense(body) });
    if (action === "expense-void" && req.method === "POST") return reply(200, { expense: await books.voidExpense(String(body.number || "")) });
    if (action === "reports") return reply(200, { reports: await books.listReports() });
    if (action === "report-create" && req.method === "POST") {
      const rep = await books.createReport(body.from, body.to);
      let mailed = false;
      if (body.mail !== false) { await books.mailReport(rep); mailed = true; }
      const { files, ...meta } = rep;
      return reply(200, { report: meta, mailed });
    }
    if (action === "download") {
      const rep = await books.getReport(String(q.number || ""));
      const type = String(q.type || "");
      if (!rep || !rep.files[type]) return reply(404, { error: "not_found" });
      const ext = type === "pdf" ? "pdf" : "csv";
      res.setHeader("Content-Type", type === "pdf" ? "application/pdf" : "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${rep.number}-${type}.${ext}"`);
      return res.status(200).send(Buffer.from(rep.files[type], "base64"));
    }
    return reply(404, { error: "unknown_action" });
  } catch (e) {
    console.error("admin:", e.message);
    return reply(400, { error: e.message });
  }
};
