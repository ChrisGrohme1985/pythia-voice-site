// Interner Bereich: Anmeldung mit Passwort, Finanzen, Beleg-Inbox, Berichte, Lizenzen. Alle Daten kommen von /api/admin.
(() => {
  const $ = (id) => document.getElementById(id);
  const eur = (c) => (c / 100).toFixed(2).replace(".", ",") + " €";
  const de = (ymd) => ymd.split("-").reverse().join(".");
  const ymd = (d) => d.toISOString().slice(0, 10);
  const day = (unix) => (unix ? ymd(new Date(unix * 1000)) : "");
  let me = null, entries = [], inboxItems = [], licenses = [], editType = "expense", editing = null;
  // Eindeutig zugeordnet (Stripe-Verkauf oder Beleg zugeordnet) = gesperrt; muss mit lockReason im Server übereinstimmen
  const lockOf = (e) => (e.source === "stripe" ? "Stripe-Verkauf" : e.source === "flowunion" ? "FlowUnion-Zahlung" : e.receiptStatus === "ready" ? "Beleg zugeordnet" : "");
  const projectOf = (e) => (me.projects.includes(e.project) ? e.project : e.source === "stripe" ? "Pythia Voice" : "Allgemein");

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
    if (!rows.length) { const tr = document.createElement("tr"); const c = td("Nichts gefunden.", "empty"); c.colSpan = cols; tr.append(c); body.append(tr); }
  };
  const msg = (id, text, bad) => { const e = $(id); e.textContent = text; e.className = "msg" + (bad ? " bad" : ""); };
  const btn = (label, fn) => { const b = document.createElement("button"); b.className = "link"; b.type = "button"; b.textContent = label; b.onclick = fn; return b; };
  const link = (href, label, blank) => { const a = document.createElement("a"); a.href = href; a.textContent = label; a.className = "dl"; if (blank) { a.target = "_blank"; a.rel = "noopener"; } return a; };
  const opts = (sel, list, first) => sel.replaceChildren(...(first ? [new Option(first, "")] : []), ...list.map((x) => (Array.isArray(x) ? new Option(x[1], x[0]) : new Option(x, x))));

  // Seitenumbruch: Zustand je Tabelle, Auswahl der Zeilen je Seite, Zurück/Weiter
  function pager(el, st, total, render) {
    const pages = Math.max(1, Math.ceil(total / st.size));
    st.page = Math.min(Math.max(1, st.page), pages);
    const from = total ? (st.page - 1) * st.size + 1 : 0, to = Math.min(total, st.page * st.size);
    const size = document.createElement("select");
    size.setAttribute("aria-label", "Zeilen je Seite");
    [25, 50, 100, 200].forEach((n) => size.append(new Option(`${n} je Seite`, n, false, n === st.size)));
    size.onchange = () => { st.size = Number(size.value); st.page = 1; render(); };
    const go = (d, label) => { const b = btn(label, () => { st.page += d; render(); }); b.classList.add("pg"); b.disabled = d < 0 ? st.page <= 1 : st.page >= pages; return b; };
    const info = document.createElement("span");
    info.textContent = `${from}–${to} von ${total}`;
    el.replaceChildren(info, go(-1, "‹ Zurück"), document.createTextNode(`Seite ${st.page} von ${pages}`), go(1, "Weiter ›"), size);
  }

  // Rückfrage im Seitenstil statt confirm(): liefert true bei Bestätigung. danger = unumkehrbare Aktion (roter Knopf).
  const ICO = {
    danger: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
    ask: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1.1.9-1.1 1.7M12 17v.01"/></svg>',
  };
  function ask({ title, text, yes = "OK", no = "Abbrechen", danger = false }) {
    return new Promise((resolve) => {
      const d = $("cdlg");
      $("cTitle").textContent = title; $("cText").textContent = text;
      $("cYes").textContent = yes; $("cNo").textContent = no;
      $("cYes").classList.toggle("danger", danger);
      $("cIcon").className = "c-icon" + (danger ? " danger" : ""); $("cIcon").innerHTML = danger ? ICO.danger : ICO.ask;
      let ok = false;
      $("cForm").onsubmit = () => { ok = true; };
      $("cNo").onclick = () => d.close();
      d.onclose = () => resolve(ok);
      d.showModal();
      $("cNo").focus(); // Standard auf "Abbrechen": ein versehentliches Enter löst nichts aus
    });
  }

  // Auge neben jedem Passwortfeld: Passwort ein- und ausblenden
  const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10.5 7 10.5 7a17 17 0 0 1-3.2 4M6.5 6.6C3.4 8.6 1.5 12 1.5 12S5.5 19 12 19c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    const wrap = document.createElement("span");
    wrap.className = "pw";
    input.replaceWith(wrap);
    const b = document.createElement("button");
    b.type = "button"; b.className = "eye"; b.setAttribute("aria-label", "Passwort anzeigen"); b.setAttribute("aria-pressed", "false");
    b.innerHTML = EYE;
    b.onclick = () => {
      const on = input.type === "password";
      input.type = on ? "text" : "password";
      b.innerHTML = on ? EYE_OFF : EYE;
      b.setAttribute("aria-label", on ? "Passwort verbergen" : "Passwort anzeigen");
      b.setAttribute("aria-pressed", String(on));
      input.focus();
    };
    wrap.append(input, b);
  });

  // --- Anmeldung: E-Mail + Passwort; Passwort festlegen oder vergessen läuft über einen Code per Mail ---
  const show = (resetMode) => { $("loginForm").hidden = resetMode; $("resetForm").hidden = !resetMode; msg("loginMsg", ""); };
  $("forgot").onclick = () => show(true);
  $("backLogin").onclick = () => show(false);
  $("loginForm").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api("login", { method: "POST", body: { email: $("lMail").value, password: $("lPw").value } }); start(); }
    catch (e) { msg("loginMsg", e.status === 429 ? "Zu viele Versuche, bitte später erneut." : "E-Mail oder Passwort stimmt nicht.", true); }
  };
  $("sendCode").onclick = async () => {
    try { await api("pw-request", { method: "POST" }); $("resetFields").hidden = false; msg("loginMsg", "Code gesendet. Er gilt 10 Minuten."); $("rCode").focus(); }
    catch (e) { msg("loginMsg", e.status === 429 ? "Zu viele Anfragen, bitte später erneut." : "Senden nicht möglich.", true); }
  };
  $("resetForm").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api("pw-reset", { method: "POST", body: { code: $("rCode").value, password: $("rPw").value } }); start(); }
    catch (e) { msg("loginMsg", e.message && e.message !== "invalid" ? e.message : "Code falsch oder abgelaufen.", true); }
  };
  $("logout").onclick = async () => { await api("logout", { method: "POST" }).catch(() => {}); location.reload(); };

  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    ["fin", "reports", "inbox", "lic"].forEach((t) => ($("tab-" + t).hidden = t !== b.dataset.tab));
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
  const markRange = () => document.querySelectorAll("[data-range]").forEach((b) => {
    const [a, z] = ranges[b.dataset.range]();
    b.classList.toggle("on", $("fFrom").value === ymd(a) && $("fTo").value === ymd(z));
  });
  const finPage = { page: 1, size: 50 };
  document.querySelectorAll("[data-range]").forEach((b) => (b.onclick = () => {
    const [a, z] = ranges[b.dataset.range]();
    $("fFrom").value = ymd(a); $("fTo").value = ymd(z);
    finPage.page = 1; markRange(); renderFin();
  }));
  ["fFrom", "fTo", "fProj", "fType", "fQ"].forEach((i) => ($(i).oninput = () => { finPage.page = 1; markRange(); renderFin(); }));

  // --- Finanzen ---
  function visible(skipProject = false) {
    const from = $("fFrom").value || "0000-01-01", to = $("fTo").value || "9999-12-31", type = $("fType").value, proj = $("fProj").value, q = $("fQ").value.trim().toLowerCase();
    return entries.filter((e) => e.date >= from && e.date <= to && (!type || e.type === type) && (skipProject || !proj || projectOf(e) === proj)
      && (!q || `${e.number} ${e.party} ${e.description} ${e.category}`.toLowerCase().includes(q))).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  }
  const sums = (list) => {
    const live = list.filter((e) => !e.void);
    const s = (t, k = "amount") => live.filter((e) => e.type === t).reduce((a, e) => a + (e[k] || 0), 0);
    const r = { income: s("income"), refunds: s("income", "refunded"), fees: s("income", "fee"), exp: s("expense") };
    r.result = r.income - r.refunds - r.fees - r.exp;
    return r;
  };
  function renderFin() {
    const list = visible(), t = sums(list);
    const kpi = (l, v, cls = "") => `<div class="kpi ${cls}"><span>${l}</span><strong>${eur(v)}</strong></div>`;
    $("kpis").innerHTML = kpi("Einnahmen", t.income) + kpi("Erstattungen", t.refunds) + kpi("Stripe-Gebühren", t.fees) + kpi("Ausgaben", t.exp)
      + kpi("Ergebnis", t.result, "result " + (t.result < 0 ? "neg" : "pos"));

    // Je Projekt (über die aktuelle Auswahl von Zeitraum, Art und Suche)
    const noProj = visible(true);
    const rows = me.projects.map((p) => [p, noProj.filter((e) => projectOf(e) === p)]).filter(([, l]) => l.length);
    $("projBlock").hidden = rows.length < 2 && !$("fProj").value;
    fill("projTable", rows.map(([p, l]) => { const s = sums(l); return [td(p), td(String(l.filter((x) => !x.void).length), "r"), td(eur(s.income), "r"), td(s.refunds ? "-" + eur(s.refunds) : eur(0), "r"), td(s.fees ? "-" + eur(s.fees) : eur(0), "r"), td(s.exp ? "-" + eur(s.exp) : eur(0), "r"), td(eur(s.result), "r " + (s.result < 0 ? "neg" : "pos"))]; }), 7);

    const pageRows = list.slice((finPage.page - 1) * finPage.size, finPage.page * finPage.size);
    fill("finTable", pageRows.map((e) => {
      const rcpt = document.createElement("td");
      if (e.receiptStatus === "ready") rcpt.append(link(`/api/admin?action=receipt&id=${encodeURIComponent(e.id)}`, "PDF", true));
      else if (e.source === "stripe" || e.source === "flowunion") rcpt.append(link(`/api/admin?action=invoice&id=${encodeURIComponent(e.id)}`, e.type === "refund" ? "Gutschrift" : "Rechnung", true));
      else if (e.type === "expense" && !e.void) rcpt.append(btn("zuordnen", () => openAssign({ entry: e })));
      const act = document.createElement("td");
      act.className = "cell-actions";
      if (e.void) { act.textContent = "storniert"; act.classList.add("muted"); }
      else if (e.type === "refund") { if (e.pending) { act.textContent = "wird erstattet …"; act.classList.add("muted"); } }
      else if (lockOf(e)) {
        if (e.source === "stripe") {
          if (e.amount - (e.refunded || 0) > 0) act.append(btn("Erstatten", () => openRefund(e)));
        }
        else if (e.source === "flowunion") { act.textContent = "FlowUnion"; act.classList.add("muted"); }
        else act.append(btn("Stornieren", async () => {
          if (await ask({ title: `${e.number} stornieren?`, text: "Der Posten wird als storniert markiert. Die Nummer bleibt erhalten und wird nicht neu vergeben.", yes: "Stornieren", danger: true })) { await api("entry-void", { method: "POST", body: { id: e.id } }); loadFin(); }
        }));
      } else {
        act.append(btn("Bearbeiten", () => openEntry(e.type, e)), " ", btn("Stornieren", async () => {
          if (await ask({ title: `${e.number} stornieren?`, text: "Der Posten wird als storniert markiert. Die Nummer bleibt erhalten und wird nicht neu vergeben.", yes: "Stornieren", danger: true })) { await api("entry-void", { method: "POST", body: { id: e.id } }); loadFin(); }
        }));
      }
      const kind = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = "pill " + (e.type === "refund" ? "expense" : e.type); pill.textContent = e.type === "income" ? "Einnahme" : e.type === "refund" ? "Erstattung" : "Ausgabe";
      kind.append(pill);
      const proj = document.createElement("td");
      proj.className = "nw";
      if (e.void || lockOf(e)) proj.textContent = projectOf(e);
      else {
        const sel = document.createElement("select");
        sel.className = "mini"; sel.setAttribute("aria-label", `Projekt für ${e.number}`);
        opts(sel, me.projects); sel.value = projectOf(e);
        sel.onchange = async () => {
          try { await api("entry-project", { method: "POST", body: { id: e.id, project: sel.value } }); e.project = sel.value; renderFin(); msg("finMsg", `${e.number}: Projekt ${sel.value}.`); }
          catch (err) { msg("finMsg", "Fehler: " + err.message, true); sel.value = projectOf(e); }
        };
        proj.append(sel);
      }
      const desc = document.createElement("td");
      desc.className = "clip";
      desc.append(document.createTextNode(e.description + (e.refunded ? ` (erstattet ${eur(e.refunded)})` : "")));
      const cat = document.createElement("small");
      cat.textContent = e.category;
      desc.append(cat);
      const row = [td(e.number, "nw"), td(de(e.date), "nw"), kind, proj, td(e.party, "nw"), desc,
        td((e.type === "income" ? "" : "-") + eur(e.amount), "r nw " + (e.type === "income" ? "pos" : "neg")), rcpt, act];
      if (e.void) row.forEach((c) => c.classList.add("void"));
      return row;
    }), 9);
    pager($("finPager"), finPage, list.length, renderFin);
  }
  async function loadFin() { entries = (await api("entries")).entries; renderFin(); }

  const q = () => `&from=${$("fFrom").value || "2000-01-01"}&to=${$("fTo").value || "2099-12-31"}&project=${encodeURIComponent($("fProj").value)}`;
  $("csvBtn").onclick = () => (location.href = `/api/admin?action=csv${q()}`);
  $("zipBtn").onclick = () => (location.href = `/api/admin?action=tax-package${q()}`);
  $("syncBtn").onclick = async () => {
    $("syncBtn").classList.add("spin"); $("syncBtn").disabled = true;
    msg("finMsg", "Gleiche mit Stripe ab …");
    try { const r = await api("sync", { method: "POST", body: { from: $("fFrom").value || ymd(new Date(Date.now() - 365 * 864e5)), to: $("fTo").value < ymd(new Date()) ? $("fTo").value : ymd(new Date()) } }); msg("finMsg", `${r.synced} Verkäufe geprüft.`); loadFin(); }
    catch (e) { msg("finMsg", "Fehler: " + e.message, true); }
    finally { $("syncBtn").classList.remove("spin"); $("syncBtn").disabled = false; }
  };

  $("fuBtn").onclick = async () => {
    $("fuBtn").classList.add("spin"); $("fuBtn").disabled = true;
    msg("finMsg", "Hole Zahlungseingänge aus FlowUnion …");
    try {
      const to = $("fTo").value < ymd(new Date()) ? $("fTo").value : ymd(new Date());
      const r = await api("sync-flowunion", { method: "POST", body: { from: $("fFrom").value || ymd(new Date(Date.now() - 365 * 864e5)), to } });
      msg("finMsg", `FlowUnion: ${r.total} Zahlungen im Zeitraum, ${r.created} neu gebucht.`); loadFin();
    } catch (e) { msg("finMsg", "Fehler: " + e.message, true); }
    finally { $("fuBtn").classList.remove("spin"); $("fuBtn").disabled = false; }
  };

  // --- Posten anlegen / bearbeiten (mit Vorschau des gewählten Belegs) ---
  const framePdf = (frame, wrap, id) => {
    frame.src = id ? `/api/admin?action=inbox-preview&id=${encodeURIComponent(id)}#toolbar=0&navpanes=0` : "about:blank";
    wrap.hidden = !id;
    $("dlg").classList.toggle("with-preview", Boolean(id));
  };
  async function openEntry(type, entry, preset = {}) {
    editing = entry || null; editType = type;
    const exp = type === "expense";
    $("dlgTitle").textContent = (entry ? "Bearbeiten: " : preset.inboxId ? "Beleg buchen: " : "Neu: ") + (exp ? "Ausgabe" : "Einnahme");
    $("partyLbl").firstChild.textContent = exp ? "Lieferant" : "Kunde / Quelle";
    opts($("eCat"), exp ? me.expenseCategories : me.incomeCategories);
    opts($("eProj"), me.projects);
    $("eDate").value = entry?.date || ymd(new Date());
    $("eAmount").value = entry ? (entry.amount / 100).toFixed(2).replace(".", ",") : "";
    $("eParty").value = entry?.party || ""; $("eParty").required = exp;
    $("eDesc").value = entry?.description || ""; if (entry) $("eCat").value = entry.category;
    $("eProj").value = entry ? projectOf(entry) : $("fProj").value || "Allgemein";
    $("eRec").value = ""; $("eUntil").value = "";
    ["recWrap", "recUntilWrap", "rcptWrap"].forEach((w) => ($(w).hidden = !exp || Boolean(entry)));
    const items = exp && !entry ? (await api("inbox")).items : [];
    inboxItems = items;
    opts($("eInbox"), items.map((i) => [i.id, i.filename]), "Keiner");
    $("eInbox").value = preset.inboxId || "";
    framePdf($("eFrame"), $("ePrev"), $("eInbox").value);
    $("dlg").showModal();
  }
  $("eInbox").onchange = () => framePdf($("eFrame"), $("ePrev"), $("eInbox").value);
  $("newExp").onclick = () => openEntry("expense");
  $("newInc").onclick = () => openEntry("income");
  const closeDlg = () => { framePdf($("eFrame"), $("ePrev"), ""); $("dlg").close(); };
  $("entCancel").onclick = closeDlg;
  $("dlg").addEventListener("cancel", () => framePdf($("eFrame"), $("ePrev"), ""));
  $("entForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { type: editType, date: $("eDate").value, amount: $("eAmount").value, party: $("eParty").value, category: $("eCat").value, description: $("eDesc").value, project: $("eProj").value };
    if (!editing) { body.recurrence = $("eRec").value; body.recurrenceUntil = $("eUntil").value; body.receiptInboxId = $("eInbox").value; }
    try {
      if (editing) await api("entry-update", { method: "POST", body: { ...body, id: editing.id } });
      else { const r = await api("entry-add", { method: "POST", body }); msg("finMsg", `Gespeichert als ${r.entry.number}${r.entries.length > 1 ? ` (+${r.entries.length - 1} Folgetermine)` : ""}.`); }
      closeDlg(); loadFin();
      if (!$("tab-inbox").hidden) loadInbox();
    } catch (e) { msg("finMsg", "Fehler: " + e.message, true); closeDlg(); }
  };

  // --- Erstattung auslösen (Stripe + Gutschrift) ---
  let refunding = null;
  function openRefund(e) {
    refunding = e;
    const rest = e.amount - (e.refunded || 0);
    $("rInfo").textContent = `${e.number} · ${e.party} · bezahlt ${eur(e.amount)}${e.refunded ? `, bereits erstattet ${eur(e.refunded)}` : ""}, noch erstattbar ${eur(rest)}`;
    $("rAmount").value = (rest / 100).toFixed(2).replace(".", ",");
    $("rNote").value = ""; $("rNotify").checked = Boolean(e.email);
    $("rdlg").showModal();
  }
  $("rCancel").onclick = () => $("rdlg").close();
  $("refundForm").onsubmit = async (ev) => {
    ev.preventDefault();
    if (!(await ask({ title: `${$("rAmount").value} € jetzt erstatten?`, text: "Der Betrag wird sofort bei Stripe erstattet und als Gutschrift gebucht. Das lässt sich nicht zurücknehmen.", yes: "Jetzt erstatten", danger: true }))) return;
    $("rSave").disabled = true;
    try {
      const r = await api("refund", { method: "POST", body: { id: refunding.id, amount: $("rAmount").value, reason: $("rReason").value, note: $("rNote").value, notify: $("rNotify").checked } });
      $("rdlg").close();
      msg("finMsg", `Erstattet: ${r.credit.number}${r.mailed ? ", Kunde per Mail informiert" : ""}.`);
      loadFin();
    } catch (e) { $("rdlg").close(); msg("finMsg", "Fehler: " + e.message, true); }
    finally { $("rSave").disabled = false; }
  };

  // --- Beleg einem Posten zuordnen: aus der Inbox heraus (Ausgabe wählen) oder aus der Tabelle (Beleg wählen) ---
  let assignCtx = null;
  async function openAssign(ctx) {
    assignCtx = ctx;
    if (ctx.item) {
      const open = (await api("entries")).entries.filter((e) => e.type === "expense" && !e.void && e.receiptStatus !== "ready").sort((a, b) => b.date.localeCompare(a.date));
      $("aTitle").textContent = "Beleg einer Ausgabe zuordnen";
      $("aHint").textContent = `${ctx.item.filename}: Ausgaben ohne Beleg.`;
      $("aLbl").firstChild.textContent = "Ausgabe";
      opts($("aSel"), open.map((e) => [e.id, `${e.number} · ${de(e.date)} · ${e.party} · ${eur(e.amount)}`]));
      if (!open.length) { msg("inboxMsg", "Keine Ausgabe ohne Beleg vorhanden. Mit „Buchen“ legst du eine neue an.", true); return; }
    } else {
      const items = (await api("inbox")).items;
      $("aTitle").textContent = `Beleg für ${ctx.entry.number} wählen`;
      $("aHint").textContent = `${ctx.entry.party}, ${eur(ctx.entry.amount)}`;
      $("aLbl").firstChild.textContent = "Beleg aus der Inbox";
      opts($("aSel"), items.map((i) => [i.id, i.filename]));
      if (!items.length) { msg("finMsg", "Die Beleg-Inbox ist leer. Zuerst einen Beleg hochladen.", true); return; }
    }
    $("adlg").showModal();
  }
  $("aCancel").onclick = () => $("adlg").close();
  $("assignForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const entryId = assignCtx.item ? $("aSel").value : assignCtx.entry.id;
    const inboxId = assignCtx.item ? assignCtx.item.id : $("aSel").value;
    try {
      await api("receipt-assign", { method: "POST", body: { id: entryId, inboxId } });
      $("adlg").close(); msg(assignCtx.item ? "inboxMsg" : "finMsg", "Beleg zugeordnet.");
      await Promise.all([loadFin(), loadInbox()]);
    } catch (e) { $("adlg").close(); msg(assignCtx.item ? "inboxMsg" : "finMsg", "Fehler: " + e.message, true); }
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
  async function uploadAll(files) {
    const list = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!list.length) return msg("inboxMsg", "Nur PDF-Dateien werden angenommen.", true);
    $("drop").classList.add("busy");
    for (const f of list) {
      msg("inboxMsg", `Lade ${f.name} hoch …`);
      try { await upload(f); msg("inboxMsg", list.length > 1 ? `${list.length} Belege hochgeladen.` : `${f.name} hochgeladen.`); }
      catch (e) { msg("inboxMsg", `${f.name}: ${e.message}`, true); }
    }
    $("drop").classList.remove("busy");
    loadInbox();
  }
  $("inboxFile").onchange = (ev) => { uploadAll(ev.target.files).finally(() => { ev.target.value = ""; }); };
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => uploadAll(e.dataTransfer.files));

  const preview = (item) => { $("pTitle").textContent = item.filename; $("pFrame").src = `/api/admin?action=inbox-preview&id=${encodeURIComponent(item.id)}#navpanes=0`; $("pdlg").showModal(); };
  $("pClose").onclick = () => $("pdlg").close();
  $("pdlg").addEventListener("close", () => { $("pFrame").src = "about:blank"; });
  async function loadInbox() {
    const { items } = await api("inbox");
    inboxItems = items;
    fill("inboxTable", items.map((i) => {
      const c = document.createElement("td");
      c.className = "cell-actions";
      c.append(btn("Ansehen", () => preview(i)), btn("Buchen", () => openEntry("expense", null, { inboxId: i.id })), btn("Zuordnen", () => openAssign({ item: i })), btn("Löschen", async () => {
        if (await ask({ title: "Beleg löschen?", text: `${i.filename} wird aus der Inbox entfernt.`, yes: "Löschen", danger: true })) { await api("inbox-delete", { method: "POST", body: { id: i.id } }); loadInbox(); }
      }));
      return [td(i.filename), td(de(day(i.createdAt)) || ""), td(`${Math.max(1, Math.round(i.size / 1024))} KB`, "r"), c];
    }), 4);
  }

  // --- Berichte ---
  $("repForm").onsubmit = async (ev) => {
    ev.preventDefault();
    msg("repMsg", "Bericht wird erzeugt …");
    try {
      const r = await api("report-create", { method: "POST", body: { from: $("rFrom").value, to: $("rTo").value, project: $("rProj").value, mail: $("rMail").checked } });
      msg("repMsg", `Bericht ${r.report.number} erzeugt${r.mailed ? " und per Mail gesendet" : ""}.`);
      loadReports();
    } catch (e) { msg("repMsg", "Fehler: " + e.message, true); }
  };
  async function loadReports() {
    const { reports } = await api("reports");
    fill("repTable", reports.map((r) => {
      const files = document.createElement("td");
      for (const [t, l] of [["pdf", "PDF"], ["einnahmen", "Einnahmen CSV"], ["ausgaben", "Ausgaben CSV"]]) files.append(link(`/api/admin?action=download&number=${encodeURIComponent(r.number)}&type=${t}`, l));
      return [td(r.number), td(`${de(r.from)} – ${de(r.to)}`), td(r.project || "Alle"), td(eur(r.totals.income), "r"), td(eur(r.totals.expenses), "r"), td(eur(r.totals.result), "r"), files];
    }), 7);
  }

  // --- Lizenzen (nur Systemadmin): filtern und seitenweise anzeigen ---
  const licPage = { page: 1, size: 25 };
  function licVisible() {
    const qv = $("lQ").value.trim().toLowerCase(), prod = $("lProd").value, src = $("lSrc").value, from = $("lFrom").value, to = $("lTo").value;
    return licenses.filter((l) => (!qv || `${l.number} ${l.firstName} ${l.lastName} ${l.email} ${l.note}`.toLowerCase().includes(qv))
      && (!prod || l.product === prod) && (!src || l.source === src) && (!from || l.date >= from) && (!to || l.date <= to));
  }
  function renderLic() {
    const list = licVisible();
    const rows = list.slice((licPage.page - 1) * licPage.size, licPage.page * licPage.size);
    fill("licTable", rows.map((l) => {
      const k = document.createElement("td");
      if (l.key) k.append(btn("Kopieren", async () => { await navigator.clipboard.writeText(l.key); msg("licMsg", `Schlüssel von ${l.number} kopiert.`); }));
      if (l.boundAt) {
        k.append(" ", Object.assign(document.createElement("span"), { className: "muted", textContent: `Gerät seit ${de(new Date(l.boundAt).toISOString().slice(0, 10))}` }), " ",
          btn("Gerät freigeben", async () => {
            if (await ask({ title: `${l.number}: Gerät freigeben?`, text: "Der Schlüssel lässt sich danach auf einem neuen Gerät aktivieren. Auf dem alten Gerät bleibt die Freischaltung bestehen, sie lässt sich aus der Ferne nicht löschen.", yes: "Freigeben", danger: true })) {
              await api("license-release", { method: "POST", body: { id: l.deviceId } }); msg("licMsg", `Gerät von ${l.number} freigegeben.`); loadLic();
            }
          }));
      }
      const money = l.source === "manuell" ? "–" : eur(l.amount) + (l.refunded ? ` (erstattet ${eur(l.refunded)})` : "");
      const src = td(l.source === "manuell" ? (l.note ? `manuell · ${l.note}` : "manuell") : "Stripe");
      return [td(l.number, "nw"), td(de(l.date), "nw"), td(l.product, "wrap"), td(l.firstName), td(l.lastName), td(l.email, "wrap"), src, td(money, "r nw"), k];
    }), 9);
    pager($("licPager"), licPage, list.length, renderLic);
  }
  ["lQ", "lProd", "lSrc", "lFrom", "lTo"].forEach((i) => ($(i).oninput = () => { licPage.page = 1; renderLic(); }));
  $("lReset").onclick = () => { ["lQ", "lProd", "lSrc", "lFrom", "lTo"].forEach((i) => ($(i).value = "")); licPage.page = 1; renderLic(); };
  async function loadLic() { licenses = (await api("licenses")).licenses; renderLic(); }
  $("grantForm").onsubmit = async (ev) => {
    ev.preventDefault();
    msg("licMsg", "Schlüssel wird erzeugt …");
    try {
      const r = await api("license-create", { method: "POST", body: {
        firstName: $("gFirst").value, lastName: $("gLast").value, email: $("gMail").value,
        product: $("gProd").value, note: $("gNote").value, send: $("gSend").checked } });
      const l = r.license;
      $("grantInfo").textContent = `${l.number} · ${l.product} · ${[l.firstName, l.lastName].filter(Boolean).join(" ")}${r.mailed ? " · per Mail gesendet" : ""}`;
      $("grantKey").textContent = l.key;
      $("grantResult").hidden = false;
      $("grantCopy").onclick = async () => { await navigator.clipboard.writeText(l.key); msg("licMsg", "Schlüssel kopiert."); };
      msg("licMsg", `Gespeichert als ${l.number}.`);
      ["gFirst", "gLast", "gMail", "gNote"].forEach((i) => ($(i).value = "")); $("gSend").checked = false;
      loadLic();
    } catch (e) { msg("licMsg", "Fehler: " + e.message, true); }
  };

  function load(tab) {
    const f = { fin: loadFin, reports: loadReports, inbox: loadInbox, lic: loadLic }[tab];
    f().catch((e) => { if (e.status === 401) location.reload(); });
  }
  async function start() {
    me = await api("me");
    me.projects = me.projects || ["Pythia Voice", "FlowUnion", "Allgemein"];
    $("login").hidden = true; $("app").hidden = false; $("logout").hidden = false;
    opts($("fProj"), me.projects, "Alle Projekte");
    opts($("rProj"), me.projects, "Alle Projekte");
    [$("fFrom").value, $("fTo").value] = ranges.month().map(ymd);
    [$("rFrom").value, $("rTo").value] = ranges.lastmonth().map(ymd);
    markRange();
    load("fin");
  }
  api("me").then(start).catch(() => {});
})();
