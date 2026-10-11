// Danke-Seite: Sprache aus der Browsereinstellung (Deutsch, sonst Englisch), per Knopf umschaltbar; APK-Link aus config.js.
(() => {
  const P = window.PV || {};
  const secs = [...document.querySelectorAll("[data-l]")];
  const btn = document.getElementById("toggle");
  let saved = null;
  try { saved = localStorage.getItem("pv-lang"); } catch (_) {}
  const pick = saved || (navigator.language || "en").toLowerCase();
  let cur = pick.startsWith("de") ? "de" : "en";
  const show = (l) => {
    cur = l;
    secs.forEach((s) => (s.hidden = s.dataset.l !== l));
    document.documentElement.lang = l;
    btn.textContent = l === "de" ? "English" : "Deutsch";
    document.title = l === "de" ? "Vielen Dank für deinen Kauf – Pythia Voice" : "Thank you for your purchase – Pythia Voice";
  };
  btn.onclick = () => show(cur === "de" ? "en" : "de");
  if (P.apkUrl) for (const id of ["apk", "apk-en"]) document.getElementById(id).href = P.apkUrl;
  show(cur);
})();
