// Interner Bereich: Anmeldung per Einmalcode, Berichte, Ausgaben, Rechnungen. Alle Daten kommen von /api/admin.
(() => {
  const $ = (id) => document.getElementById(id);
  const eur = (c) => (c / 100).toFixed(2).replace(".", ",") + " €";
  const de = (ymd) => ymd.split("-").reverse().join(".");

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
  const fill = (tableId, rows) => {
    const body = $(tableId).querySelector("tbody");
    body.replaceChildren();
    rows.forEach((cells) => { const tr = document.createElement("tr"); cells.forEach((c) => tr.append(c)); body.append(tr); });
    if (!rows.length) { const tr = document.createElement("tr"); const c = td("Noch nichts vorhanden."); c.colSpan = 7; tr.append(c); body.append(tr); }
  };
  const msg = (id, text, bad) => { const e = $(id); e.textContent = text; e.className = "msg" + (bad ? " bad" : ""); };

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

  // --- Tabs ---
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    ["reports", "expenses", "sales"].forEach((t) => ($("tab-" + t).hidden = t !== b.dataset.tab));
    load(b.dataset.tab);
  }));

  // --- Berichte ---
  const ymd = (d) => d.toISOString().slice(0, 10);
  const ranges = {
    lastmonth: () => { const n = new Date(); return [new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1)), new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0))]; },
    month: () => { const n = new Date(); return [new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)), n]; },
    year: () => { const n = new Date(); return [new Date(Date.UTC(n.getUTCFullYear(), 0, 1)), n]; },
    lastyear: () => { const y = new Date().getUTCFullYear() - 1; return [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31))]; },
  };
  document.querySelectorAll("[data-range]").forEach((b) => (b.onclick = () => {
    const [a, z] = ranges[b.dataset.range]();
    $("rFrom").value = ymd(a); $("rTo").value = ymd(z);
  }));
  $("repForm").onsubmit = async (ev) => {
    ev.preventDefault();
    msg("repMsg", "Bericht wird erzeugt …");
    try {
      const r = await api("report-create", { method: "POST", body: { from: $("rFrom").value, to: $("rTo").value, mail: $("rMail").checked } });
      msg("repMsg", `Bericht ${r.report.number} erzeugt${r.mailed ? " und per Mail gesendet" : ""}.`);
      load("reports");
    } catch (e) { msg("repMsg", "Fehler: " + e.message, true); }
  };
  const fileLink = (number, type, label) => {
    const a = document.createElement("a");
    a.href = `/api/admin?action=download&number=${encodeURIComponent(number)}&type=${type}`;
    a.textContent = label; a.className = "dl";
    return a;
  };
  async function loadReports() {
    const { reports } = await api("reports");
    fill("repTable", reports.map((r) => {
      const files = document.createElement("td");
      files.append(fileLink(r.number, "pdf", "PDF"), " ", fileLink(r.number, "einnahmen", "Einnahmen CSV"), " ", fileLink(r.number, "ausgaben", "Ausgaben CSV"));
      return [td(r.number), td(`${de(r.from)} – ${de(r.to)}`), td(eur(r.totals.income)), td(eur(r.totals.expenses)), td(eur(r.totals.result)), files];
    }));
  }

  // --- Ausgaben ---
  $("expForm").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const r = await api("expense-add", { method: "POST", body: {
        date: $("eDate").value, vendor: $("eVendor").value, amount: $("eAmount").value,
        category: $("eCat").value, description: $("eDesc").value, note: $("eNote").value } });
      msg("expMsg", `Gespeichert als ${r.expense.number}.`);
      ["eVendor", "eAmount", "eDesc", "eNote"].forEach((i) => ($(i).value = ""));
      load("expenses");
    } catch (e) { msg("expMsg", "Fehler: " + e.message, true); }
  };
  async function loadExpenses() {
    const { expenses } = await api("expenses");
    fill("expTable", expenses.map((e) => {
      const act = document.createElement("td");
      if (e.void) act.textContent = "storniert";
      else {
        const b = document.createElement("button"); b.className = "link"; b.type = "button"; b.textContent = "Stornieren";
        b.onclick = async () => { if (confirm(`${e.number} stornieren? Die Nummer bleibt erhalten.`)) { await api("expense-void", { method: "POST", body: { number: e.number } }); load("expenses"); } };
        act.append(b);
      }
      const row = [td(e.number), td(de(e.date)), td(e.vendor), td(e.description), td(e.category), td(eur(e.amount)), act];
      if (e.void) row.forEach((c) => c.classList.add("void"));
      return row;
    }));
  }

  // --- Einnahmen ---
  async function loadSales() {
    const { sales } = await api("sales");
    fill("saleTable", sales.map((s) => [td(s.number), td(de(s.date)), td(s.email), td(eur(s.amount))]));
  }

  function load(tab) {
    const f = { reports: loadReports, expenses: loadExpenses, sales: loadSales }[tab];
    f().catch((e) => { if (e.status === 401) location.reload(); });
  }

  async function start() {
    const me = await api("me");
    $("login").hidden = true; $("app").hidden = false; $("logout").hidden = false;
    $("eCat").replaceChildren(...me.categories.map((c) => new Option(c, c)));
    $("eDate").value = ymd(new Date());
    [$("rFrom").value, $("rTo").value] = ranges.lastmonth().map(ymd);
    load("reports");
  }
  api("me").then(start).catch(() => {});
})();
