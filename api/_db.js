// Speicher-Schicht: Firestore (firebase-admin) im Betrieb, Arbeitsspeicher in den Tests.
// Zugangsdaten wie in zuhause-web: FIREBASE_SERVICE_ACCOUNT_JSON (JSON oder Base64 davon) oder
// FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY. Alle Werte sind einfache JSON-Typen (Zahlen statt Timestamps).
const CHUNK = 700 * 1024; // Firestore erlaubt 1 MB je Dokument

let memory = null;
let fsInstance = null;

function credentials() {
  let raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  let sa = null;
  if (raw) {
    if (!raw.startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8");
    sa = JSON.parse(raw);
  }
  const projectId = sa?.project_id || process.env.FIREBASE_PROJECT_ID;
  const clientEmail = sa?.client_email || process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = String(sa?.private_key || process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) throw new Error("Firebase-Zugangsdaten fehlen (FIREBASE_SERVICE_ACCOUNT_JSON)");
  return { projectId, clientEmail, privateKey };
}

function fs() {
  if (fsInstance) return fsInstance;
  const admin = require("firebase-admin");
  const app = admin.apps[0] || admin.initializeApp({ credential: admin.credential.cert(credentials()) });
  fsInstance = app.firestore();
  return fsInstance;
}

/** Nur für Tests: alles im Arbeitsspeicher statt Firestore. */
function useMemory() {
  memory = { cols: new Map(), blobs: new Map(), counters: new Map() };
}
const col = (name) => { if (!memory.cols.has(name)) memory.cols.set(name, new Map()); return memory.cols.get(name); };
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

async function get(c, id) {
  if (memory) { const v = col(c).get(String(id)); return v ? clone(v) : null; }
  const s = await fs().collection(c).doc(String(id)).get();
  return s.exists ? s.data() : null;
}

async function set(c, id, data, { merge = false } = {}) {
  if (memory) { col(c).set(String(id), clone(merge ? { ...(col(c).get(String(id)) || {}), ...data } : data)); return; }
  await fs().collection(c).doc(String(id)).set(data, { merge });
}

/** @returns {boolean} false, wenn es das Dokument schon gibt. */
async function create(c, id, data) {
  if (memory) { if (col(c).has(String(id))) return false; col(c).set(String(id), clone(data)); return true; }
  try { await fs().collection(c).doc(String(id)).create(data); return true; } catch (e) { if (e.code === 6 || /ALREADY_EXISTS/.test(e.message)) return false; throw e; }
}

async function del(c, id) {
  if (memory) { col(c).delete(String(id)); return; }
  await fs().collection(c).doc(String(id)).delete();
}

/** Alle Dokumente einer Sammlung, absteigend nach orderBy (kleine Datenmengen, Filter geschieht im Aufrufer). */
async function list(c, { orderBy = "date", limit = 5000 } = {}) {
  if (memory) {
    return [...col(c)].map(([id, v]) => ({ id, ...clone(v) }))
      .sort((a, b) => String(b[orderBy] ?? "").localeCompare(String(a[orderBy] ?? "")) || String(b.id).localeCompare(String(a.id))).slice(0, limit);
  }
  const s = await fs().collection(c).orderBy(orderBy, "desc").limit(limit).get();
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Löscht Dokumente mit abgelaufenem Feld expires. Ersatz für Firestore-TTL, das den Blaze-Tarif braucht. @returns Anzahl */
async function purgeExpired(c) {
  const now = new Date();
  let n = 0;
  if (memory) { for (const [id, v] of col(c)) if (v.expires && new Date(v.expires) < now) { col(c).delete(id); n++; } return n; }
  for (;;) {
    const s = await fs().collection(c).where("expires", "<", now).limit(400).get();
    if (s.empty) return n;
    const b = fs().batch(); s.docs.forEach((d) => b.delete(d.ref)); await b.commit(); n += s.size;
  }
}

/** Legt ein Dokument mit der nächsten fortlaufenden Nummer an, genau einmal je id (atomar, auch bei gleichzeitigen Aufrufen). */
async function numbered(c, id, prefix, year, build) {
  if (memory) {
    const ex = col(c).get(String(id));
    if (ex) return { doc: clone(ex), created: false };
    const key = `${prefix}-${year}`;
    const n = (memory.counters.get(key) || 0) + 1;
    memory.counters.set(key, n);
    const number = `${prefix}-${year}-${String(n).padStart(4, "0")}`;
    const doc = build(number);
    col(c).set(String(id), clone(doc));
    return { doc: clone(doc), created: true };
  }
  const db = fs();
  return db.runTransaction(async (tx) => {
    const ref = db.collection(c).doc(String(id));
    const snap = await tx.get(ref);
    if (snap.exists) return { doc: snap.data(), created: false };
    const cref = db.collection("counters").doc(`${prefix}-${year}`);
    const cs = await tx.get(cref);
    const n = (cs.exists ? cs.data().value : 0) + 1;
    const number = `${prefix}-${year}-${String(n).padStart(4, "0")}`;
    const doc = build(number);
    tx.set(cref, { value: n });
    tx.set(ref, doc);
    return { doc, created: true };
  });
}

/** Nummer ohne Dokument (Berichte). */
async function nextNumber(prefix, year) {
  const r = await numbered("_numbers", `${prefix}-${year}-${Date.now()}-${Math.random().toString(36).slice(2)}`, prefix, year, (number) => ({ number }));
  return r.doc.number;
}

// ----- Dateien in Stücken (Belege als PDF, Berichte): keine Storage-Einrichtung nötig, läuft im kostenlosen Firebase-Tarif -----
async function putBlob(c, id, buffer, meta = {}) {
  const parts = [];
  for (let o = 0; o < buffer.length; o += CHUNK) parts.push(buffer.subarray(o, o + CHUNK));
  if (memory) { memory.blobs.set(`${c}/${id}`, { data: Buffer.from(buffer), meta: clone(meta) }); return parts.length; }
  const base = fs().collection(c).doc(String(id));
  for (let i = 0; i < parts.length; i++) await base.collection("chunks").doc(String(i).padStart(3, "0")).set({ index: i, data: parts[i] });
  await base.set({ ...meta, size: buffer.length, chunks: parts.length }, { merge: true });
  return parts.length;
}

async function getBlob(c, id) {
  if (memory) { const b = memory.blobs.get(`${c}/${id}`); return b ? { data: Buffer.from(b.data), meta: clone(b.meta) } : null; }
  const base = fs().collection(c).doc(String(id));
  const [m, s] = await Promise.all([base.get(), base.collection("chunks").orderBy("index").get()]);
  if (!m.exists || !s.docs.length) return null;
  const toBuf = (v) => (Buffer.isBuffer(v) ? v : v?.toBuffer ? v.toBuffer() : Buffer.from(v || []));
  const data = Buffer.concat(s.docs.map((d) => toBuf(d.data().data)));
  if (m.data().size && Number(m.data().size) !== data.length) throw new Error("Datei unvollständig");
  return { data, meta: m.data() };
}

async function delBlob(c, id) {
  if (!id) return;
  if (memory) { memory.blobs.delete(`${c}/${id}`); return; }
  const base = fs().collection(c).doc(String(id));
  const s = await base.collection("chunks").get();
  for (let o = 0; o < s.docs.length; o += 400) {
    const b = fs().batch();
    s.docs.slice(o, o + 400).forEach((d) => b.delete(d.ref));
    await b.commit();
  }
  await base.delete();
}

module.exports = { useMemory, get, set, create, del, list, purgeExpired, numbered, nextNumber, putBlob, getBlob, delBlob, CHUNK };
