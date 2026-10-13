// Produktseite Pythia Recap: Sprache wechseln, Kauf- und Download-Links aus config.js (solange sie leer sind, steht "bald verfügbar" da).
(() => {
  const P = window.PV || {};
  const SUPPORTED = ["en", "de", "it", "es", "fr", "pt", "ru", "tr", "nl", "pl", "ja", "zh", "ko", "ar", "hi", "id", "vi", "uk", "th", "sv", "cs", "ro", "el", "he"];
  const sel = document.getElementById("lang");
  const remember = (c) => { try { localStorage.setItem("pv-lang", c); } catch (_) {} };
  sel.addEventListener("change", () => { remember(sel.value); location.href = "/" + sel.value + "/recap"; });
  if (document.body.dataset.root) {
    let saved = null;
    try { saved = localStorage.getItem("pv-lang"); } catch (_) {}
    const b = (navigator.language || "en").toLowerCase();
    const want = saved || [b, b.split("-")[0]].find((c) => SUPPORTED.includes(c)) || "en";
    if (want !== "en") { location.replace("/" + want + "/recap"); return; }
  }
  if (P.recapBuyUrl) for (const id of ["buy-recap", "buy-recap-2"]) document.getElementById(id).href = P.recapBuyUrl;
  if (P.recapApkUrl) {
    const a = document.getElementById("rc-apk");
    a.href = P.recapApkUrl; a.hidden = false;
    document.getElementById("rc-soon").hidden = true;
  }
})();
