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
  if (P.apkUrl) document.querySelectorAll("a.apk").forEach((a) => (a.href = P.apkUrl));
  show(first);
})();
