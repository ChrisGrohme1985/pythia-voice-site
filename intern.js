// Interner Bereich: Anmeldung per Einmalcode, Finanzen, Beleg-Inbox, Berichte. Alle Daten kommen von /api/admin.
(() => {
  const $ = (id) => document.getElementById(id);
  const eur = (c) => (c / 100).toFixed(2).replace(".", ",") + " €";
  const de = (ymd) => ymd.split("-").reverse().join(".");
  const ymd = (d) => d.toISOString().slice(0, 10);
  let me = null, entries = [], editType = "expense";

  async function api(action, { method = "GET", body, query = "" } = {}) {
    const r = await fetch(`/api/admin?action=${action}${query}`, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json", "X-Requested-With": "pv" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status });
    return j;
  }
  const td = (text, cls) => { const c = document.createElement("td"); c.textContent = text; if (cls) c.className = cls; return c; };
  const fill = (tableId, rows, cols) => {
    const body = $(tableId).querySelector("tbody");
    body.replaceChildren();
    rows.forEach((cells) => { const tr = document.createElement("tr"); cells.forEach((c) => tr.append(c)); body.append(tr); });
    if (!rows.length) { const tr = document.createElement("tr"); const c = td("Noch nichts vorhanden."); c.colSpan = cols; tr.append(c); body.append(tr); }
  };
  const msg = (id, text, bad) => { const e = $(id); e.textContent = text; e.className = "msg" + (bad ? " bad" : ""); };
  const btn = (label, fn) => { const b = document.createElement("button"); b.className = "link"; b.type = "button"; b.textContent = label; b.onclick = fn; return b; };
  const link = (href, label, blank) => { const a = document.createElement("a"); a.href = href; a.textContent = label; a.className = "dl"; if (blank) { a.target = "_blank"; a.rel = "noopener"; } return a; };

  // --- Anmeldung ---
  $("send").onclick = async () => {
    try { await api("login-request", { method: "POST" }); $("verify").hidden = false; msg("loginMsg", "Code gesendet. Er gilt 10 Minuten."); $("code").focus(); }
    catch (e) { msg("loginMsg", e.status === 429 ? "Zu viele Anfragen, bitte später erneut." : "Senden nicht möglich.", true); }
  };
  $("verify").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api("login-verify", { method: "POST", body: { code: $("code").value } }); start(); }
    catch { msg("loginMsg", "Code falsch oder abgelaufen.", true); }
  };
  $("logout").onclick = async () => { await api("logout", { method: "POST" }).catch(() => {}); location.reload(); };

  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    ["fin", "reports", "inbox"].forEach((t) => ($("tab-" + t).hidden = t !== b.dataset.tab));
    load(b.dataset.tab);
  }));

  // --- Zeiträume ---
  const ranges = {
    month: () => { const n = new Date(); return [new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)), new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0))]; },
    lastmonth: () => { const n = new Date(); return [new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1)), new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0))]; },
    year: () => { const y = new Date().getUTCFullYear(); return [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31))]; },
    lastyear: () => { const y = new Date().getUTCFullYear() - 1; return [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31))]; },
    all: () => [new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2099, 11, 31))],
  };
  document.querySelectorAll("[data-range]").forEach((b) => (b.onclick = () => {
    const [a, z] = ranges[b.dataset.range]();
    $("fFrom").value = ymd(a); $("fTo").value = ymd(z);
    renderFin();
  }));
  ["fFrom", "fTo", "fType", "fQ"].forEach((i) => ($(i).oninput = renderFin));

  // --- Finanzen ---
  function visible() {
    const from = $("fFrom").value || "0000-01-01", to = $("fTo").value || "9999-12-31", type = $("fType").value, q = $("fQ").value.trim().toLowerCase();
    return entries.filter((e) => e.date >= from && e.date <= to && (!type || e.type === type)
      && (!q || `${e.number} ${e.party} ${e.description} ${e.category}`.toLowerCase().includes(q))).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  }
  function renderFin() {
    const list = visible(), live = list.filter((e) => !e.void);
    const sum = (t, k = "amount") => live.filter((e) => e.type === t).reduce((a, e) => a + (e[k] || 0), 0);
    const income = sum("income"), refunds = sum("income", "refunded"), fees = sum("income", "fee"), exp = sum("expense");
    const kpi = (l, v, cls = "") => `<div class="kpi ${cls}"><span>${l}</span><strong>${eur(v)}</strong></div>`;
    $("kpis").innerHTML = kpi("Einnahmen", income) + kpi("Erstattungen", refunds) + kpi("Stripe-Gebühren", fees) + kpi("Ausgaben", exp)
      + kpi("Ergebnis", income - refunds - fees - exp, income - refunds - fees - exp < 0 ? "neg" : "pos");
    fill("finTable", list.map((e) => {
      const rcpt = document.createElement("td");
      if (e.receiptStatus === "ready") rcpt.append(link(`/api/admin?action=receipt&id=${encodeURIComponent(e.id)}`, "PDF", true));
      const act = document.createElement("td");
      if (e.void) act.textContent = "storniert";
      else if (e.source === "stripe") act.textContent = "Stripe";
      else {
        act.append(btn("Bearbeiten", () => openEntry(e.type, e)), " ", btn("Stornieren", async () => {
          if (confirm(`${e.number} stornieren? Die Nummer bleibt erhalten.`)) { await api("entry-void", { method: "POST", body: { id: e.id } }); loadFin(); }
        }));
      }
      const row = [td(e.number), td(de(e.date)), td(e.type === "income" ? "Einnahme" : "Ausgabe"), td(e.party), td(e.description), td(e.category), td((e.type === "expense" ? "-" : "") + eur(e.amount)), rcpt, act];
      if (e.void) row.forEach((c) => c.classList.add("void"));
      return row;
    }), 9);
  }
  async function loadFin() { entries = (await api("entries")).entries; renderFin(); }

  const q = () => `&from=${$("fFrom").value || "2000-01-01"}&to=${$("fTo").value || "2099-12-31"}`;
  $("csvBtn").onclick = () => (location.href = `/api/admin?action=csv${q()}`);
  $("zipBtn").onclick = () => (location.href = `/api/admin?action=tax-package${q()}`);
  $("syncBtn").onclick = async () => {
    msg("finMsg", "Gleiche mit Stripe ab …");
    try { const r = await api("sync", { method: "POST", body: { from: $("fFrom").value || ymd(new Date(Date.now() - 365 * 864e5)), to: $("fTo").value < ymd(new Date()) ? $("fTo").value : ymd(new Date()) } }); msg("finMsg", `${r.synced} Verkäufe geprüft.`); loadFin(); }
    catch (e) { msg("finMsg", "Fehler: " + e.message, true); }
  };

  // --- Posten anlegen / bearbeiten ---
  let editing = null;
  async function openEntry(type, entry) {
    editing = entry || null; editType = type;
    const exp = type === "expense";
    $("dlgTitle").textContent = (entry ? "Bearbeiten: " : "Neu: ") + (exp ? "Ausgabe" : "Einnahme");
    $("partyLbl").firstChild.textContent = exp ? "Lieferant" : "Kunde / Quelle";
    $("eCat").replaceChildren(...(exp ? me.expenseCategories : me.incomeCategories).map((c) => new Option(c, c)));
    $("eDate").value = entry?.date || ymd(new Date());
    $("eAmount").value = entry ? (entry.amount / 100).toFixed(2).replace(".", ",") : "";
    $("eParty").value = entry?.party || ""; $("eParty").required = exp;
    $("eDesc").value = entry?.description || ""; if (entry) $("eCat").value = entry.category;
    $("eRec").value = ""; $("eUntil").value = "";
    ["recWrap", "recUntilWrap", "rcptWrap"].forEach((w) => ($(w).hidden = !exp || Boolean(entry)));
    const items = exp && !entry ? (await api("inbox")).items : [];
    $("eInbox").replaceChildren(new Option("Keiner", ""), ...items.map((i) => new Option(i.filename, i.id)));
    $("dlg").showModal();
  }
  $("newExp").onclick = () => openEntry("expense");
  $("newInc").onclick = () => openEntry("income");
  $("entCancel").onclick = () => $("dlg").close();
  $("entForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { type: editType, date: $("eDate").value, amount: $("eAmount").value, party: $("eParty").value, category: $("eCat").value, description: $("eDesc").value };
    if (!editing) { body.recurrence = $("eRec").value; body.recurrenceUntil = $("eUntil").value; body.receiptInboxId = $("eInbox").value; }
    try {
      if (editing) await api("entry-update", { method: "POST", body: { ...body, id: editing.id } });
      else { const r = await api("entry-add", { method: "POST", body }); msg("finMsg", `Gespeichert als ${r.entry.number}${r.entries.length > 1 ? ` (+${r.entries.length - 1} Folgetermine)` : ""}.`); }
      $("dlg").close(); loadFin();
    } catch (e) { msg("finMsg", "Fehler: " + e.message, true); $("dlg").close(); }
  };

  // --- Beleg-Inbox (Upload in 512-KB-Stücken wie in zuhause-web) ---
  const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  async function upload(file) {
    const start = await api("inbox-start", { method: "POST", body: { filename: file.name, contentType: "application/pdf", size: file.size } });
    try {
      const size = 512 * 1024, n = Math.ceil(file.size / size);
      for (let i = 0; i < n; i++) {
        const bytes = new Uint8Array(await file.slice(i * size, (i + 1) * size).arrayBuffer());
        await api("inbox-chunk", { method: "POST", query: `&id=${start.item.id}&index=${i}`, body: { data: b64(bytes) } });
      }
      await api("inbox-finish", { method: "POST", query: `&id=${start.item.id}`, body: { chunks: n } });
    } catch (e) { await api("inbox-delete", { method: "POST", body: { id: start.item.id } }).catch(() => {}); throw e; }
  }
  $("inboxFile").onchange = async (ev) => {
    for (const f of ev.target.files) {
      msg("inboxMsg", `Lade ${f.name} hoch …`);
      try { await upload(f); msg("inboxMsg", "Hochgeladen."); } catch (e) { msg("inboxMsg", `${f.name}: ${e.message}`, true); }
    }
    ev.target.value = ""; loadInbox();
  };
  async function loadInbox() {
    const { items } = await api("inbox");
    fill("inboxTable", items.map((i) => [td(i.filename), td(`${Math.max(1, Math.round(i.size / 1024))} KB`), (() => {
      const c = document.createElement("td");
      c.append(link(`/api/admin?action=inbox-preview&id=${encodeURIComponent(i.id)}`, "Ansehen", true), btn("Löschen", async () => {
        if (confirm(`${i.filename} löschen?`)) { await api("inbox-delete", { method: "POST", body: { id: i.id } }); loadInbox(); }
      }));
      return c;
    })()]), 3);
  }

  // --- Berichte ---
  $("repForm").onsubmit = async (ev) => {
    ev.preventDefault();
    msg("repMsg", "Bericht wird erzeugt …");
    try {
      const r = await api("report-create", { method: "POST", body: { from: $("rFrom").value, to: $("rTo").value, mail: $("rMail").checked } });
      msg("repMsg", `Bericht ${r.report.number} erzeugt${r.mailed ? " und per Mail gesendet" : ""}.`);
      loadReports();
    } catch (e) { msg("repMsg", "Fehler: " + e.message, true); }
  };
  async function loadReports() {
    const { reports } = await api("reports");
    fill("repTable", reports.map((r) => {
      const files = document.createElement("td");
      for (const [t, l] of [["pdf", "PDF"], ["einnahmen", "Einnahmen CSV"], ["ausgaben", "Ausgaben CSV"]]) files.append(link(`/api/admin?action=download&number=${encodeURIComponent(r.number)}&type=${t}`, l));
      return [td(r.number), td(`${de(r.from)} – ${de(r.to)}`), td(eur(r.totals.income)), td(eur(r.totals.expenses)), td(eur(r.totals.result)), files];
    }), 6);
  }

  function load(tab) {
    const f = { fin: loadFin, reports: loadReports, inbox: loadInbox }[tab];
    f().catch((e) => { if (e.status === 401) location.reload(); });
  }
  async function start() {
    me = await api("me");
    $("login").hidden = true; $("app").hidden = false; $("logout").hidden = false;
    [$("fFrom").value, $("fTo").value] = ranges.month().map(ymd);
    [$("rFrom").value, $("rTo").value] = ranges.lastmonth().map(ymd);
    load("fin");
  }
  api("me").then(start).catch(() => {});
})();
