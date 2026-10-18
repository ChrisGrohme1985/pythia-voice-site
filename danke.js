// Danke-Seite: nimmt die Sprache der Hauptseite (pv-lang) bzw. des Browsers und lässt sich über die Auswahl ändern; APK-Link aus config.js.
(() => {
  const P = window.PV || {};
  const sel = document.getElementById("lang");
  const secs = [...document.querySelectorAll("[data-l]")];
  const SUPPORTED = secs.map((s) => s.dataset.l);
  let saved = null;
  try { saved = localStorage.getItem("pv-lang"); } catch (_) {}
  const b = (navigator.language || "en").toLowerCase();
  const first = [saved, b, b.split("-")[0]].find((c) => c && SUPPORTED.includes(c)) || "en";
  const show = (l) => {
    secs.forEach((s) => { s.hidden = s.dataset.l !== l; if (s.dataset.l === l) { document.title = s.dataset.title; document.documentElement.lang = l; document.documentElement.dir = s.dir; } });
    sel.value = l;
  };
  sel.addEventListener("change", () => { try { localStorage.setItem("pv-lang", sel.value); } catch (_) {} show(sel.value); });
  // danke?app=recap (Erfolgsadresse des Recap-Zahlungslinks): App-Name, Schritt 3 und Download auf Pythia Recap umstellen
  const recap = new URLSearchParams(location.search).get("app") === "recap";
  if (recap) {
    document.querySelectorAll(".for-voice").forEach((e) => (e.hidden = true));
    document.querySelectorAll(".for-recap").forEach((e) => (e.hidden = false));
    secs.forEach((s) => { s.dataset.title = s.dataset.title.replace("Pythia Voice", "Pythia Recap"); });
    const w = document.createTreeWalker(document.querySelector("main") || document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) if (n.nodeValue.includes("Pythia Voice")) n.nodeValue = n.nodeValue.replaceAll("Pythia Voice", "Pythia Recap");
  }
  const apk = recap ? P.recapApkUrl : P.apkUrl;
  if (apk) document.querySelectorAll("a.apk").forEach((a) => (a.href = apk));
  show(first);
})();
