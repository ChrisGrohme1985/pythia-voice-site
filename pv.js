// Öffentliche Seiten (Start, Recap, Familie): Sprache, Produktmenü, Links aus config.js, Einblenden, Diktat-Demo.
(() => {
  const P = window.PV || {};
  const doc = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SUPPORTED = ["en", "de", "it", "es", "fr", "pt", "ru", "tr", "nl", "pl", "ja", "zh", "ko", "ar", "hi", "id", "vi", "uk", "th", "sv", "cs", "ro", "el", "he"];
  const page = document.body.dataset.page || "home"; // home | recap | family
  const tail = { home: "", recap: "recap", family: "pythia", download: "download" }[page];
  const $ = (id) => document.getElementById(id);
  doc.classList.add("js");

  // --- Sprache: Auswahl merken, auf der Wurzel-Seite einmalig zur Browser-Sprache wechseln -------------------
  const remember = (c) => { try { localStorage.setItem("pv-lang", c); } catch (_) {} };
  $("lang").addEventListener("change", (e) => { remember(e.target.value); location.href = "/" + e.target.value + "/" + tail; });
  if (document.body.dataset.root) {
    let saved = null;
    try { saved = localStorage.getItem("pv-lang"); } catch (_) {}
    const b = (navigator.language || "en").toLowerCase();
    const want = saved || [b, b.split("-")[0]].find((c) => SUPPORTED.includes(c)) || "en";
    if (want !== "en") { location.replace("/" + want + "/" + tail + location.hash); return; } // Sprungmarke behalten (Kauf-Knopf der App zeigt auf #diktat)
  }

  // --- Produktmenü -------------------------------------------------------------------------------------------
  const dd = document.querySelector(".dd");
  if (dd) {
    const btn = dd.querySelector("button"), menu = dd.querySelector(".ddm");
    const set = (open) => { dd.classList.toggle("open", open); btn.setAttribute("aria-expanded", String(open)); menu.hidden = !open; };
    btn.addEventListener("click", (e) => { e.stopPropagation(); set(menu.hidden); });
    document.addEventListener("click", (e) => { if (!dd.contains(e.target)) set(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { set(false); btn.focus(); } });
    menu.addEventListener("click", () => set(false));
  }

  // --- Links aus config.js ----------------------------------------------------------------------------------
  const href = (ids, url) => { if (url) ids.forEach((id) => { const a = $(id); if (a) a.href = url; }); };
  href(["buy"], P.buyUrl);
  href(["buy-voice", "buy-voice-2"], P.voiceBuyUrl);
  href(["buy-recap", "buy-recap-2", "buy-recap-h"], P.recapBuyUrl);
  href(["apk"], P.apkUrl);
  if (P.recapApkUrl) {
    for (const id of ["rc-apk-h", "rc-apk"]) { const a = $(id); if (a) { a.href = P.recapApkUrl; a.hidden = false; } }
    for (const id of ["rc-soon-h", "rc-soon"]) { const a = $(id); if (a) a.hidden = true; }
  }
  // Demo-Video: Hochformat auf schmalen Bildschirmen, läuft stumm, solange es im Bild ist (nicht bei reduzierter Bewegung)
  const vid = $("demo"), vbtn = $("vtoggle");
  if (vid) {
    const tall = matchMedia("(max-width: 700px)").matches;
    const base = tall ? vid.dataset.tall : vid.dataset.wide;
    vid.poster = base + ".jpg"; vid.src = base + ".mp4";
    const sync = () => vbtn.classList.toggle("paused", vid.paused);
    let userPaused = reduce;
    const toggle = () => { if (vid.paused) { userPaused = false; vid.play().catch(() => {}); } else { userPaused = true; vid.pause(); } };
    vbtn.addEventListener("click", toggle); vid.addEventListener("click", toggle);
    vid.addEventListener("play", sync); vid.addEventListener("pause", sync); sync();
    if ("IntersectionObserver" in window) new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting && !userPaused) { vid.preload = "auto"; vid.play().catch(() => {}); } else if (!e.isIntersecting) vid.pause();
    }), { threshold: 0.5 }).observe(vid);
  }

  // --- Einblenden beim Scrollen, Licht unter der Maus -------------------------------------------------------
  const rv = document.querySelectorAll(".rv");
  if (reduce || !("IntersectionObserver" in window)) rv.forEach((e) => e.classList.add("in"));
  else {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12 });
    rv.forEach((e) => io.observe(e));
  }
  document.addEventListener("pointermove", (e) => {
    const c = e.target.closest && e.target.closest(".rules > div, .spot");
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty("--mx", e.clientX - r.left + "px");
    c.style.setProperty("--my", e.clientY - r.top + "px");
  });
  const demo = document.querySelector(".vm-demo");
  if (demo) {
    if (reduce || !("IntersectionObserver" in window)) demo.classList.add("in-view");
    else new IntersectionObserver((es, io) => es.forEach((e) => { if (e.isIntersecting) { demo.classList.add("in-view"); io.disconnect(); } }), { threshold: 0.35 }).observe(demo);
  }

})();
