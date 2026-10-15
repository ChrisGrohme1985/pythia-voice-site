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

  // --- Klangband: Balken wie im Logo, jeder mit eigenem Takt ----------------------------------------------
  const pulse = document.querySelector(".pulse");
  if (pulse) {
    const n = Math.min(110, Math.floor(innerWidth / 13));
    for (let i = 0; i < n; i++) {
      const b = document.createElement("i"), x = i / (n - 1);
      const shape = Math.pow(Math.sin(x * Math.PI), 0.8);
      b.style.setProperty("--h", (10 + 78 * shape * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7)))).toFixed(0) + "px");
      b.style.setProperty("--d", (1.6 + (i * 37 % 17) / 10).toFixed(2) + "s");
      b.style.setProperty("--o", (-(i * 53 % 23) / 10).toFixed(2) + "s");
      b.style.setProperty("--x", (x * 100).toFixed(0) + "%");
      pulse.appendChild(b);
    }
  }
  // --- Licht folgt der Maus auf Karten ----------------------------------------------------------------------
  document.addEventListener("pointermove", (e) => {
    const c = e.target.closest && e.target.closest(".rules div, .suite a, .get-card, .tablet, .steps li");
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty("--mx", e.clientX - r.left + "px");
    c.style.setProperty("--my", e.clientY - r.top + "px");
  });

  if (P.recapBuyUrl) for (const id of ["buy-recap", "buy-recap-2"]) document.getElementById(id).href = P.recapBuyUrl;
  if (P.recapApkUrl) {
    const a = document.getElementById("rc-apk");
    a.href = P.recapApkUrl; a.hidden = false;
    document.getElementById("rc-soon").hidden = true;
  }
})();
