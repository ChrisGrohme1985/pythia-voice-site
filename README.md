# Pythia Voice: Website

Statische, mehrsprachige Website (24 Sprachen) für Pythia Voice, Diktieren für Android. Einmal zahlen, ein Leben lang nutzen.

- `index.html` ist Englisch und leitet beim ersten Besuch zur Browsersprache weiter, `/<sprache>/` sind die Sprachseiten.
- Keine Cookies, keine externen Schriften oder Skripte.
- `api/` enthält die Vercel-Funktion, die nach einem Kauf den Lizenzschlüssel erzeugt. Alle Zugangsdaten kommen aus Umgebungsvariablen, nichts Geheimes liegt im Repo.
- `config.js` enthält die öffentlichen Links (Kauf, Download).
- Deployment: Vercel, Root Directory `./`, Framework "Other".
