// Öffnet die App mit dem Lizenzschlüssel aus dem Link-Fragment (#PV-…). Das Fragment geht nie an einen Server.
(() => {
  const de = (navigator.language || "").toLowerCase().startsWith("de");
  const L = de
    ? { t: "Lizenz freischalten", ok: "Tippe auf den Knopf, dann öffnet sich die App und schaltet sich selbst frei.", go: "In der App freischalten", bad: "Dieser Link ist unvollständig. Öffne die Mail erneut und tippe noch einmal auf den Knopf.", f: "Öffnet sich nichts? Dann ist die App auf diesem Gerät nicht installiert. Öffne diese Seite auf deinem Android-Handy.", dl: "App herunterladen" }
    : { t: "Activate license", ok: "Tap the button. The app opens and unlocks itself.", go: "Activate in the app", bad: "This link is incomplete. Open the e-mail again and tap the button once more.", f: "Nothing happens? The app is not installed on this device. Open this page on your Android phone.", dl: "Download the app" };
  const key = decodeURIComponent(location.hash.slice(1));
  const valid = /^PV-[0-9A-Za-z-]{20,400}$/.test(key);
  // Erstes Byte des Schlüssels = Produkt (1 Standard, 2 Record, 3 Recap); steckt in den ersten zwei Base32-Zeichen
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", c = key.slice(3).replace(/-/g, "").toUpperCase();
  const recap = valid && ((A.indexOf(c[0]) << 3) | (A.indexOf(c[1]) >> 2)) === 3;
  const app = recap ? { name: "Pythia Recap", scheme: "pythiarecap", pkg: "app.pythiarecap", apk: "recapApkUrl" } : { name: "Pythia Voice", scheme: "pythiavoice", pkg: "app.pythiavoice", apk: "apkUrl" };
  const $ = (id) => document.getElementById(id);
  document.documentElement.lang = de ? "de" : "en";
  document.title = L.t + " – " + app.name;
  $("t").textContent = L.t; $("x").textContent = valid ? L.ok : L.bad; $("go").textContent = L.go; $("f").textContent = L.f; $("dl").textContent = L.dl;
  if (window.PV && window.PV[app.apk]) $("dl").href = window.PV[app.apk];
  if (!valid) { $("go").hidden = true; return; }
  const link = "intent://activate?k=" + encodeURIComponent(key) + "#Intent;scheme=" + app.scheme + ";package=" + app.pkg + ";end";
  $("go").href = link;
  if (/android/i.test(navigator.userAgent)) location.href = link; // ohne Fingertipp lassen manche Browser das nicht zu, der Knopf bleibt als Weg
})();
