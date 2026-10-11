(() => {
  const P = window.PV || {};
  const html = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SUPPORTED = ["en", "de", "it", "es", "fr", "pt", "ru", "tr", "nl", "pl", "ja", "zh", "ko", "ar", "hi", "id", "vi", "uk", "th", "sv", "cs", "ro", "el", "he"];

  // --- Sprache: Auswahl merken, auf der Startseite einmalig zur Browser-Sprache wechseln --------------------
  const sel = document.getElementById("lang");
  const remember = (c) => { try { localStorage.setItem("pv-lang", c); } catch (_) {} };
  sel.addEventListener("change", () => { remember(sel.value); location.href = "/" + sel.value + "/"; });
  if (document.body.dataset.root) {
    let saved = null;
    try { saved = localStorage.getItem("pv-lang"); } catch (_) {}
    const b = (navigator.language || "en").toLowerCase();
    const want = saved || [b, b.split("-")[0]].find((c) => SUPPORTED.includes(c)) || "en";
    if (want !== "en") { location.replace("/" + want + "/"); return; }
  }

  // --- Links aus config.js ---------------------------------------------------------------------------------
  if (P.buyUrl) document.getElementById("buy").href = P.buyUrl;
  if (P.voiceBuyUrl) document.getElementById("buy-voice").href = P.voiceBuyUrl;
  if (P.apkUrl) document.getElementById("apk").href = P.apkUrl;

  // --- Demo: Balken steigen, der gesprochene Satz erscheint, dann der bereinigte ----------------------------
  const o = document.getElementById("oracle").dataset;
  const said = document.getElementById("said");
  const wrote = document.getElementById("wrote");
  const wave = document.getElementById("wave");
  for (let i = 0; i < 17; i++) wave.appendChild(document.createElement("i"));
  const bars = [...wave.children];
  // gesprochener Satz = Füllwort + Anfang + verworfene Fassung + Rest; gestrichen werden Füllwort und verworfene Fassung
  const parts = [[o.fill, true], [o.a, false], [o.s, true], [o.b, false]];
  const sep = /[　-鿿฀-๿]/.test(o.out) ? "" : " "; // Japanisch, Chinesisch, Thai ohne Leerzeichen
  let token = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Ruhezustand: die Balken des Logos (hoch in der Mitte); beim Sprechen zufällig, mit derselben Silhouette
  const level = (on) => bars.forEach((b, i) => {
    const shape = Math.sin((i + 1) / 18 * Math.PI);
    b.style.height = (on ? 10 + Math.random() * 62 * shape : 8 + 30 * shape * shape) + "px";
  });
  const piece = (t, strike) => Object.assign(document.createElement(strike ? "s" : "span"), { textContent: t });

  async function play() {
    const my = ++token;
    said.textContent = ""; wrote.textContent = ""; level(false);
    if (reduce) {
      parts.forEach(([t, s]) => { said.append(piece(t, s), sep); });
      wrote.textContent = o.out;
      return;
    }
    await sleep(500);
    const ticker = setInterval(() => level(true), 110);
    const spans = [];
    for (const [t, s] of parts) {
      for (const w of t.split(" ")) {
        if (my !== token) return clearInterval(ticker);
        const sp = piece(w, false); sp.dataset.s = s ? "1" : "";
        said.append(sp, sep); spans.push(sp);
        await sleep(230);
      }
    }
    clearInterval(ticker); level(false);
    await sleep(500);
    spans.forEach((sp) => { if (sp.dataset.s) sp.replaceWith(piece(sp.textContent, true)); });
    await sleep(700);
    const words = sep ? o.out.split(" ") : [...o.out];
    for (const w of words) {
      if (my !== token) return;
      wrote.textContent += (wrote.textContent && sep ? " " : "") + w;
      await sleep(sep ? 120 : 70);
    }
  }
  document.getElementById("replay").addEventListener("click", play);
  play();
})();
