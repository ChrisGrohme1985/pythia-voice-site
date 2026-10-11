// Öffnet die App mit dem Lizenzschlüssel aus dem Link-Fragment (#PV-…). Das Fragment geht nie an einen Server.
(() => {
  const de = (navigator.language || "").toLowerCase().startsWith("de");
  const L = de
    ? { t: "Lizenz freischalten", ok: "Tippe auf den Knopf, dann öffnet sich die App und schaltet sich selbst frei.", go: "In der App freischalten", bad: "Dieser Link ist unvollständig. Öffne die Mail erneut und tippe noch einmal auf den Knopf.", f: "Öffnet sich nichts? Dann ist die App auf diesem Gerät nicht installiert. Öffne diese Seite auf deinem Android-Handy.", dl: "App herunterladen" }
    : { t: "Activate license", ok: "Tap the button. The app opens and unlocks itself.", go: "Activate in the app", bad: "This link is incomplete. Open the e-mail again and tap the button once more.", f: "Nothing happens? The app is not installed on this device. Open this page on your Android phone.", dl: "Download the app" };
  const key = decodeURIComponent(location.hash.slice(1));
  const valid = /^PV-[0-9A-Za-z-]{20,400}$/.test(key);
  const $ = (id) => document.getElementById(id);
  document.documentElement.lang = de ? "de" : "en";
  document.title = L.t + " – Pythia Voice";
  $("t").textContent = L.t; $("x").textContent = valid ? L.ok : L.bad; $("go").textContent = L.go; $("f").textContent = L.f; $("dl").textContent = L.dl;
  if (window.PV && window.PV.apkUrl) $("dl").href = window.PV.apkUrl;
  if (!valid) { $("go").hidden = true; return; }
  const link = "intent://activate?k=" + encodeURIComponent(key) + "#Intent;scheme=pythiavoice;package=app.pythiavoice;end";
  $("go").href = link;
  if (/android/i.test(navigator.userAgent)) location.href = link; // ohne Fingertipp lassen manche Browser das nicht zu, der Knopf bleibt als Weg
})();
