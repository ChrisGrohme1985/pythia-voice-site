// Vermittler zwischen Pythia Voice (Play-Fassung ohne eigenen Schlüssel) und Groq. Durch kommt nur, wer ein laufendes Play-Abo
// "pythia_voice_sub" hat oder in der Testphase ist; Tageskontingente und ein Gesamtdeckel der Testphasen begrenzen die Kosten.
// POST /api/ai?p=audio/transcriptions|chat/completions, Header x-pv-device (32 hex), x-pv-product (dictation|voice), optional x-pv-sub (Play-Kauf-Token)
// → Groq-Antwort unverändert | 400 ungültig | 402 Test/Abo vorbei | 413 zu groß | 429 Tageskontingent | 502/503 Groq/Google gestört
// Umgebungsvariablen: AI_PROVIDER (groq|cloudflare), GROQ_API_KEY bzw. CF_ACCOUNT_ID + CF_API_TOKEN (siehe _aiprovider.js), PLAY_SERVICE_ACCOUNT_JSON (sonst FIREBASE_SERVICE_ACCOUNT_JSON; JSON oder Base64), AI_TRIAL_DAILY_BYTES
// shortcut: Testphase hängt an der Geräte-ID; neue IDs sind nur per IP-Grenze und Gesamtdeckel gebremst. Bei Missbrauch Play Integrity ergänzen.
const crypto = require("crypto");
const db = require("./_db");


const TRIAL_BYTES = { dictation: 40_000_000, voice: 60_000_000 };
const PRODUCTS = new Set(["dictation", "voice"]);
const PATHS = new Set(["audio/transcriptions", "chat/completions"]);

let cachedToken = null;

const fail = (code) => Object.assign(new Error("status " + code), { code });

function serviceAccount() {
  const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  try { return JSON.parse(raw); } catch { return JSON.parse(Buffer.from(raw, "base64").toString("utf8")); }
}

async function rawBody(req, max) {
  if (req.body instanceof Buffer) {
    if (req.body.length > max) throw fail(413);
    return req.body;
  }
  if (typeof req.body === "string") {
    const buf = Buffer.from(req.body);
    if (buf.length > max) throw fail(413);
    return buf;
  }
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    if (total + c.length > max) throw fail(413);
    chunks.push(c);
    total += c.length;
  }
  return Buffer.concat(chunks);
}

async function subActive(token) {
  const subHash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 40);
  const now = Date.now();
  let cached = await db.get("subs", subHash);
  if (cached && now - cached.checked < 6 * 3600e3 && cached.expiry > now) return true;
  if (cached && cached.expiry <= now && now - cached.checked < 10 * 60e3) return false;

  // Google gestört oder nicht erreichbar: letzter bekannter Stand gilt, ohne ihn 503
  const outage = () => { if (cached) return cached.expiry > now; throw fail(503); };
  try {
  let accessToken = cachedToken;
  if (!accessToken || now >= accessToken.until) {
    const sa = serviceAccount();
    const iat = Math.floor(now / 1000);
    const exp = iat + 3600;
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp
    };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
    const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = crypto.createSign("RSA-SHA256").update(encodedHeader + "." + encodedClaims).sign(sa.private_key, "base64url");

    const jwt = encodedHeader + "." + encodedClaims + "." + signature;

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`
    });
    if (!res.ok) return outage();
    const json = await res.json();
    if (!json.access_token) return outage();
    accessToken = { token: json.access_token, until: now + (json.expires_in - 60) * 1000 };
    cachedToken = accessToken;
  }

  const res = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/app.pythiavoice/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`,
    { headers: { Authorization: `Bearer ${accessToken.token}` } }
  );
  if (res.status === 400 || res.status === 404 || res.status === 410) {
    cached = { expiry: 0, checked: now };
  } else if (!res.ok) {
    return outage();
  } else {
    const json = await res.json();
    let expiry = 0;
    if (json.subscriptionState && ["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "SUBSCRIPTION_STATE_CANCELED"].includes(json.subscriptionState)) {
      for (const item of json.lineItems || []) {
        if (item.productId === "pythia_voice_sub") {
          const e = Date.parse(item.expiryTime);
          if (e > expiry) expiry = e;
        }
      }
    }
    cached = { expiry, checked: now };
  }
  } catch (e) {
    if (e.code === 503) throw e;
    return outage(); // Netzwerkfehler oder kaputte Antwort
  }

  await db.set("subs", subHash, { ...cached, expires: new Date(Math.max(cached.expiry, now) + 30 * 864e5) });
  return cached.expiry > now;
}

async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const p = req.query.p;
    if (!PATHS.has(p)) return res.status(404).json({ error: "path" });

    const device = req.headers["x-pv-device"];
    if (!device || !/^[a-f0-9]{32}$/.test(device)) return res.status(400).json({ error: "invalid" });

    const product = req.headers["x-pv-product"];
    if (!PRODUCTS.has(product)) return res.status(400).json({ error: "invalid" });

    const sub = req.headers["x-pv-sub"];
    if (sub && (!/^[A-Za-z0-9._:-]{1,600}$/.test(sub))) return res.status(400).json({ error: "invalid" });

    // Erst Größe und Inhalt prüfen: Ungültiges darf weder Testphasen anlegen noch Kontingent kosten
    let body;
    let contentType;

    if (p === "audio/transcriptions") {
      const max = 4_000_000;
      try {
        body = await rawBody(req, max);
      } catch (e) {
        if (e.code === 413) return res.status(413).json({ error: "too_large" });
        throw e;
      }
      const ct = req.headers["content-type"];
      if (!ct || !ct.startsWith("multipart/form-data")) return res.status(400).json({ error: "invalid" });
      const bodyStr = body.toString("latin1");
      let count = 0;
      for (let i = 0; i < bodyStr.length - 12; i++) {
        if (bodyStr.slice(i, i + 12) === 'name="model"') count++;
      }
      if (count !== 1 || !bodyStr.includes("\r\n\r\nwhisper-large-v3-turbo\r\n")) {
        return res.status(400).json({ error: "invalid" });
      }
      contentType = ct;
    } else {
      const max = 64_000;
      try {
        body = await rawBody(req, max);
      } catch (e) {
        if (e.code === 413) return res.status(413).json({ error: "too_large" });
        throw e;
      }
      let json;
      try {
        json = JSON.parse(body.toString());
      } catch (e) {
        return res.status(400).json({ error: "invalid" });
      }

      if (!Array.isArray(json.messages) || json.messages.length < 1 || json.messages.length > 4) return res.status(400).json({ error: "invalid" });

      let totalLength = 0;
      for (const m of json.messages) {
        if (typeof m.role !== "string" || !["system", "user"].includes(m.role)) return res.status(400).json({ error: "invalid" });
        if (typeof m.content !== "string") return res.status(400).json({ error: "invalid" });
        totalLength += m.content.length;
      }
      if (totalLength > 20_000) return res.status(400).json({ error: "invalid" });

      const newJson = {
        model: "openai/gpt-oss-20b",
        temperature: 0,
        reasoning_effort: "low",
        max_completion_tokens: 4096,
        messages: json.messages.map(m => ({ role: m.role, content: m.content }))
      };
      body = JSON.stringify(newJson);
      contentType = "application/json";
    }

    const devHash = crypto.createHash("sha256").update(device).digest("hex").slice(0, 32);
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
    const now = Date.now();
    const day = new Date().toISOString().slice(0, 10);

    let who;
    let art;

    if (sub) {
      try {
        if (await subActive(sub)) {
          who = "s-" + crypto.createHash("sha256").update(sub).digest("hex").slice(0, 40);
          art = "sub";
        } // sonst weiter mit Testphase
      } catch (e) {
        if (e.code === 503) return res.status(503).json({ error: "busy" });
        throw e;
      }
    }

    let trial = null;
    if (!who) {
      const id = product + "-" + devHash;
      trial = await db.get("trials", id);
      if (!trial) {
        const rateKey = `aitrial-${day}-${ipHash}`;
        let rate = await db.get("authRate", rateKey);
        if (!rate) rate = { n: 0 };
        if (rate.n >= 5) return res.status(402).json({ error: "payment" });
        await db.set("authRate", rateKey, { n: rate.n + 1, expires: new Date(now + 2 * 864e5) });

        trial = { start: now, used: 0, aiBytes: 0, seen: now, expires: new Date(now + 3 * 365 * 864e5) };
        if (!(await db.create("trials", id, trial))) trial = await db.get("trials", id); // gleichzeitig angelegt: gespeicherten Stand nehmen
      }

      if (!trial || now - trial.start >= 7 * 864e5 || (trial.aiBytes || 0) >= TRIAL_BYTES[product] ||
          (product === "dictation" && (trial.used || 0) >= 3000)) {
        return res.status(402).json({ error: "payment" });
      }

      who = "t-" + devHash;
      art = "trial";
    }

    const maxBytes = art === "sub" ? 40_000_000 : 15_000_000;
    const maxCalls = art === "sub" ? 3000 : 600;

    let quota = await db.get("aiQuota", day + "-" + who);
    if (!quota) quota = { bytes: 0, calls: 0 };

    if (quota.bytes + Buffer.byteLength(body) > maxBytes || quota.calls + 1 > maxCalls) {
      return res.status(429).json({ error: "quota" });
    }

    let all;
    if (art === "trial") {
      all = await db.get("aiQuota", day + "-trial-all");
      if ((all?.bytes || 0) + Buffer.byteLength(body) > (Number(process.env.AI_TRIAL_DAILY_BYTES) || 500_000_000)) {
        return res.status(503).json({ error: "busy" });
      }
    }

    let r;
    try {
      r = await require("./_aiprovider").run(p, body, contentType);
    } catch (e) {
      console.error("KI: Anbieter nicht nutzbar: " + e.message);
      return res.status(e.code === "config" ? 500 : 502).json({ error: e.code === "config" ? "server" : "upstream" });
    }

    if (r.status < 200 || r.status > 299) {
      if (r.status === 401 || r.status === 403) {
        console.error("KI: Anbieter lehnt den Schlüssel ab (" + r.status + ")");
        return res.status(502).json({ error: "upstream" });
      }
      if (r.status === 429) return res.status(503).json({ error: "busy" });
      res.setHeader("Content-Type", "application/json");
      return res.status(r.status).send(r.text);
    }

    const text = r.text;
    res.setHeader("Content-Type", "application/json");
    res.status(r.status).send(text);

    // Verbuchen: die Antwort ist schon raus, Fehler hier nur protokollieren
    const n = Buffer.byteLength(body);
    try {
      await db.set("aiQuota", day + "-" + who, { bytes: quota.bytes + n, calls: quota.calls + 1, expires: new Date(now + 2 * 864e5) });
      if (art === "trial") {
        await db.set("trials", product + "-" + devHash, { aiBytes: (trial.aiBytes || 0) + n, seen: now }, { merge: true });
        await db.set("aiQuota", day + "-trial-all", { bytes: (all?.bytes || 0) + n, calls: (all?.calls || 0) + 1, expires: new Date(now + 2 * 864e5) });
      }
    } catch (e) {
      console.error("KI: Verbuchen fehlgeschlagen: " + e.message);
    }
  } catch (e) {
    console.error("KI: " + e.message);
    return res.status(500).json({ error: "server" });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
module.exports._reset = () => { cachedToken = null; };
