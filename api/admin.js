// Interner Bereich (/intern): Anmeldung mit E-Mail und Passwort, Passwort vergessen per Code (Muster aus zuhause-web), Finanzen, Belege und Berichte.
// Eine einzige Funktion mit ?action=..., damit die Funktionszahl des Vercel-Tarifs nicht aufgebraucht wird.
// Umgebungsvariablen: ADMIN_SECRET, ADMIN_EMAIL (Standard support@pythiavoice.app), RESEND_API_KEY, RESEND_FROM,
//                     FIREBASE_SERVICE_ACCOUNT_JSON sowie die Bericht-Variablen aus _books.js
const crypto = require("crypto");
const db = require("./_db");
const books = require("./_books");
const { issue } = require("./_license");
const { sendLicenseMail } = require("./_licensemail");

const COOKIE = "pv_admin";
const SESSION_SEC = 12 * 3600;
const b64 = (s) => Buffer.from(s).toString("base64url");
const hmac = (s) => crypto.createHmac("sha256", process.env.ADMIN_SECRET).update(s).digest("base64url");
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const adminEmail = () => process.env.ADMIN_EMAIL || "support@pythiavoice.app";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Passwort-Ablage: scrypt mit eigenem Salz. */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString("hex"), hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
function checkPassword(pw, u) {
  const h = crypto.scryptSync(pw, Buffer.from(u.salt, "hex"), 64);
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, "hex"));
}

function token() {
  // Der Anmeldecode geht nur an ADMIN_EMAIL: wer sich anmeldet, ist Systemadmin. Weitere Rollen können später dazukommen.
  const body = b64(JSON.stringify({ role: "sysadmin", exp: Math.floor(Date.now() / 1000) + SESSION_SEC }));
  return `${body}.${hmac(body)}`;
}
function session(req) {
  if (!process.env.ADMIN_SECRET) return null;
  const c = String(req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(COOKIE + "="));
  const [body, sig] = String(c || "").slice(COOKIE.length + 1).split(".");
  if (!body || !sig || !same(sig, hmac(body))) return null;
  try { const s = JSON.parse(Buffer.from(body, "base64url").toString()); return s.exp > Date.now() / 1000 ? s : null; } catch { return null; }
}
const loggedIn = (req) => Boolean(session(req));

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
  const file = (f, type, name, disposition = "attachment") => {
    if (!f) return reply(404, { error: "not_found" });
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", `${disposition}; filename="${name}"`);
    return res.status(200).send(f);
  };
  if (!process.env.ADMIN_SECRET) return reply(503, { error: "not_configured" });
  if (req.method === "POST" && req.headers["x-requested-with"] !== "pv") return reply(403, { error: "forbidden" }); // einfacher CSRF-Schutz
  try {
    // --- Anmeldung: E-Mail + Passwort. Passwort festlegen/vergessen läuft über einen Code per Mail ---
    const setCookie = () => res.setHeader("Set-Cookie", `${COOKIE}=${token()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SEC}`);
    const hourKey = (p) => `${p}-${Math.floor(Date.now() / 3.6e6)}`;
    if (action === "login" && req.method === "POST") {
      const fk = hourKey("fail"), fails = (await db.get("authRate", fk)) || { n: 0 };
      if (fails.n >= 10) return reply(429, { error: "too_many" });
      const u = await db.get("authUsers", "admin");
      const okMail = String(body.email || "").trim().toLowerCase() === adminEmail().toLowerCase();
      const okPw = Boolean(u) && checkPassword(String(body.password || ""), u);
      if (!(okMail && okPw)) { await db.set("authRate", fk, { n: fails.n + 1 }); return reply(401, { error: "invalid" }); }
      setCookie();
      return reply(200, { ok: true });
    }
    if (action === "pw-request" && req.method === "POST") {
      const rk = hourKey("otp"), rate = (await db.get("authRate", rk)) || { n: 0 };
      if (rate.n >= 5) return reply(429, { error: "too_many" });
      await db.set("authRate", rk, { n: rate.n + 1 });
      const code = String(crypto.randomInt(100000, 1000000));
      await db.set("authOtp", "admin", { hash: hmac("otp:" + code), tries: 0, exp: Math.floor(Date.now() / 1000) + 600 });
      await mail([adminEmail()], "Pythia Voice: Code zum Festlegen des Passworts", `Dein Code: ${code}

Gültig 10 Minuten. Nicht angefordert? Dann ignoriere diese Mail, dein Passwort bleibt unverändert.`);
      return reply(200, { ok: true });
    }
    if (action === "pw-reset" && req.method === "POST") {
      const pw = String(body.password || "");
      if (pw.length < 12) return reply(400, { error: "Das Passwort braucht mindestens 12 Zeichen." });
      const o = await db.get("authOtp", "admin");
      if (!o || o.tries >= 5 || o.exp < Date.now() / 1000) return reply(401, { error: "invalid" });
      await db.set("authOtp", "admin", { tries: o.tries + 1 }, { merge: true });
      if (!same(o.hash, hmac("otp:" + String(body.code || "").trim()))) return reply(401, { error: "invalid" });
      await db.del("authOtp", "admin");
      await db.set("authUsers", "admin", { ...hashPassword(pw), updatedAt: Math.floor(Date.now() / 1000) });
      setCookie();
      return reply(200, { ok: true });
    }
    if (action === "logout") {
      res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return reply(200, { ok: true });
    }
    if (!loggedIn(req)) return reply(401, { error: "unauthorized" });
    const post = req.method === "POST";
    const actor = adminEmail();

    // --- Daten lesen ---
    if (action === "me") return reply(200, { ok: true, expenseCategories: books.EXPENSE_CATEGORIES, incomeCategories: books.INCOME_CATEGORIES, projects: books.PROJECTS });
    if (action === "licenses") {
      if (session(req)?.role !== "sysadmin") return reply(403, { error: "forbidden" });
      return reply(200, { licenses: await books.listLicenses(issue) });
    }
    if (action === "license-create" && req.method === "POST") {
      if (session(req)?.role !== "sysadmin") return reply(403, { error: "forbidden" });
      const g = await books.grantLicense(body, issue);
      let mailed = false;
      if (body.send && g.email) { await sendLicenseMail([g.email], g.key, g.product); await books.markMailed(g.id); mailed = true; }
      const { product, ...license } = g;
      return reply(201, { license: { ...license, product: product.de }, mailed });
    }
    if (action === "entries") return reply(200, { entries: await books.listEntries() });
    if (action === "inbox") return reply(200, { items: await books.listInbox() });
    if (action === "invoice") { const f = await books.documentPdf(String(q.id || "")); return file(f, "application/pdf", "beleg.pdf", "inline"); }
    if (action === "inbox-preview") { const f = await books.inboxFile(String(q.id || "")); return file(f?.data, "application/pdf", "beleg.pdf", "inline"); }
    if (action === "receipt") { const f = await books.receiptOf(String(q.id || "")); return file(f?.data, "application/pdf", "beleg.pdf", "inline"); }
    if (action === "reports") return reply(200, { reports: await books.listReports() });
    if (action === "download") {
      const number = String(q.number || ""), type = String(q.type || "");
      const f = await books.reportFile(number, type);
      return file(f?.data, type === "pdf" ? "application/pdf" : "text/csv; charset=utf-8", `${number}-${type}.${type === "pdf" ? "pdf" : "csv"}`);
    }
    if (action === "csv" || action === "tax-package") {
      if (!YMD.test(q.from || "") || !YMD.test(q.to || "")) return reply(400, { error: "Zeitraum ungültig" });
      if (action === "csv") return file(Buffer.from(await books.entriesCsv(q.from, q.to, String(q.project || "")), "utf8"), "text/csv; charset=utf-8", `pythiavoice-posten-${q.from}_${q.to}.csv`);
      return file(await books.taxPackage(q.from, q.to, String(q.project || "")), "application/zip", `pythiavoice-steuerberater-${q.from}_${q.to}.zip`);
    }

    // --- Daten ändern ---
    if (!post) return reply(404, { error: "unknown_action" });
    if (action === "sync") {
      if (!YMD.test(body.from || "") || !YMD.test(body.to || "")) return reply(400, { error: "Zeitraum ungültig" });
      return reply(200, { synced: await books.syncStripe(body.from, body.to) });
    }
    if (action === "entry-add") { const entries = await books.addEntry(body, actor); return reply(201, { entry: entries[0], entries }); }
    if (action === "entry-update") return reply(200, { entry: await books.updateEntry(String(body.id || ""), body) });
    if (action === "entry-project") return reply(200, { entry: await books.assignProject(String(body.id || ""), String(body.project || "")) });
    if (action === "entry-test") return reply(200, { entry: await books.markTest(String(body.id || "")) });
    if (action === "refund") {
      const r = await books.refundSale(String(body.id || ""), { amount: body.amount, reason: body.reason, note: body.note, notify: body.notify !== false }, actor);
      return reply(200, r);
    }
    if (action === "entry-void") return reply(200, { entry: await books.voidEntry(String(body.id || "")) });
    if (action === "inbox-start") return reply(201, { item: await books.inboxStart(body, actor) });
    if (action === "inbox-chunk") { await books.inboxChunk(String(q.id || ""), Number(q.index), String(body.data || "")); return reply(200, { ok: true }); }
    if (action === "inbox-finish") return reply(200, { item: await books.inboxFinish(String(q.id || ""), Number(body.chunks)) });
    if (action === "inbox-delete") { await books.deleteInbox(String(body.id || "")); return reply(200, { ok: true }); }
    if (action === "receipt-assign") return reply(200, { receipt: await books.assignReceipt(String(body.id || ""), String(body.inboxId || "")) });
    if (action === "report-create") {
      const rep = await books.createReport(body.from, body.to, String(body.project || ""));
      let mailed = false;
      if (body.mail !== false) { await books.mailReport(rep); mailed = true; }
      const { files, ...meta } = rep;
      return reply(200, { report: meta, mailed });
    }
    return reply(404, { error: "unknown_action" });
  } catch (e) {
    console.error("admin:", e.message);
    return reply(400, { error: e.message });
  }
};
