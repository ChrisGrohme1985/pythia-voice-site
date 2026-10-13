# Stripe einrichten für pythiavoice.app

Diese Anleitung beschreibt, was im Stripe-Dashboard und in Vercel eingestellt werden muss, damit Verkäufe von Pythia Voice (Diktat und Sprachnachrichten) und Pythia Recap automatisch laufen: Zahlung, Lizenzschlüssel per Mail, Beleg, Buchung und Erstattung.

Stripe ändert die Menüs regelmäßig. Die Namen unten stimmen für Stand Oktober 2026 meist, können aber leicht abweichen. Im Zweifel die Suchfunktion im Dashboard nutzen.

Geheime Werte gehören **nur** in die Vercel-Umgebungsvariablen, nie in dieses Repo, nie in einen Chat.

---

## 1. Stripe-Konto

1. Konto unter stripe.com anlegen bzw. öffnen. Geschäftsdaten vollständig angeben (Name, Anschrift, Steuer-ID bzw. Kleinunternehmer-Status).
2. **Einstellungen → Auszahlungen**: Bankkonto (IBAN) hinterlegen und die Identitätsprüfung abschließen. Solange die Prüfung offen ist, werden keine Auszahlungen gemacht.
3. **Einstellungen → Geschäftsdaten → Öffentliche Details**: Name „Pythia Voice“ und Support-E-Mail (support@pythiavoice.app) eintragen. Der Name erscheint auf dem Kontoauszug des Kunden. Optional den Statement-Descriptor „PYTHIA VOICE“ setzen.
4. Steuern und Rechnungen: Die Rechnungen erzeugt die eigene Anwendung (fortlaufende Nummern, PDF per Mail). **Stripe Tax und Stripe-Rechnungen werden nicht genutzt.** Ob und wie Umsatzsteuer ausgewiesen wird, bitte mit Steuerberater klären.

**Prüfen:** Die Konto-Startseite zeigt keinen Hinweis „Verifizierung erforderlich“.

---

## 2. Test- oder Live-Modus

Stripe hat zwei getrennte Welten: **Testmodus** (Schalter oben rechts „Testmodus“) und **Live**. Jede Einstellung unten gibt es zweimal, und die Werte sind verschieden.

Empfehlung: zuerst alles im Testmodus durchspielen (Test-Kreditkarte `4242 4242 4242 4242`, beliebiges Datum in der Zukunft, beliebige CVC), dann im Live-Modus wiederholen.

Der Webhook akzeptiert mehrere Secrets, durch Komma getrennt. So laufen Test und Live parallel (siehe Abschnitt 5).

---

## 3. Zahlungslinks anlegen

Pro Produkt ein Zahlungslink. Es gibt drei:

| Produkt | Preis | Vercel-Variable |
|---|---|---|
| Pythia Voice (Diktat) | 19,99 € einmalig | `PYTHIA_PAYMENT_LINKS` |
| Pythia Voice (Sprachnachrichten) | 19,99 € einmalig | `PYTHIA_VOICE_LINKS` |
| Pythia Recap | 19,99 € einmalig | `PYTHIA_RECAP_LINKS` |

So legst du einen Link an:

1. **Produkte → + Produkt hinzufügen**: Name (z. B. „Pythia Recap“), Beschreibung kurz, Preis **19,99 € → Einmalzahlung**.
   - Wichtig: Der Produktname erscheint im Beleg und in der Buchung. Er muss zum Produkt passen.
2. **Zahlungslinks → + Zahlungslink erstellen**: das Produkt auswählen.
3. **Zahlungslink-Einstellungen** (wichtig für Lizenz und Beleg):
   - **E-Mail-Adresse erfassen**: an (Pflicht, sonst keine Lizenzmail).
   - **Name erfassen**: an. Der Name steht auf der Rechnung und in der Buchung.
   - **Rechnungsadresse erfassen**: an. Für den Beleg im Dashboard nötig.
   - **Mengen anpassen**: aus. Ein Link = eine Lizenz.
   - **Nach der Zahlung**: Weiterleitung auf `https://www.pythiavoice.app/danke` (Seite existiert bereits).
4. Die **Zahlungslink-ID** kopieren. Sie beginnt mit `plink_`. Die öffentliche URL (`buy.stripe.com/…`) reicht dafür nicht.
5. ID in Vercel eintragen (Abschnitt 6). Mehrere Test- und Live-IDs gehen komma-getrennt in dieselbe Variable.

**Prüfen:** Im Testmodus den Link öffnen, mit der Testkarte zahlen. Auf der Danke-Seite sollte die Weiterleitung erscheinen, und die Lizenzmail kommt an (Abschnitt 8).

Die öffentlichen Live-Links (`buy.stripe.com/...`) tragen wir zusätzlich in `site/config.js` ein (`buyUrl`, `voiceBuyUrl`, `recapBuyUrl`). Das sind keine Geheimnisse.

---

## 4. Restricted Keys (eingeschränkte Schlüssel)

Nicht den Standard-Geheimschlüssel (`sk_…`) verwenden. Stattdessen zwei eingeschränkte Schlüssel anlegen: **Entwickler → API-Schlüssel → + Eingeschränkten Schlüssel erstellen**.

**Schlüssel 1: `STRIPE_READ_KEY` (nur lesen)**
- Lesezugriff auf: Checkout-Sitzungen, Zahlungsabsichten (PaymentIntents), Charges, Guthabentransaktionen (Balance).
- Alles andere auf „Kein Zugriff“.
- Wird für den Stripe-Abgleich (Finanzen) und die Gebühren gebraucht.

**Schlüssel 2: `STRIPE_REFUND_KEY` (nur Erstattungen)**
- **Refunds: Schreiben**. Sonst nichts.
- Wird für den Button „Erstatten“ im internen Bereich gebraucht.

Der Schlüssel wird nur einmal angezeigt. Sofort in Vercel eintragen.

**Prüfen:** Ohne `STRIPE_REFUND_KEY` lehnt der interne Bereich Erstattungen ab (gewollt). Ohne `STRIPE_READ_KEY` gibt es keinen Stripe-Abgleich.

---

## 5. Webhook

Der Webhook meldet Stripe bezahlte Verkäufe und Erstattungen an unsere Funktion. Ohne ihn gibt es keine Lizenzmail.

1. **Entwickler → Webhooks → + Endpoint hinzufügen**.
2. Endpoint-URL: `https://www.pythiavoice.app/api/license-webhook`
3. **Ereignisse auswählen** (genau diese):
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `charge.refunded` (damit Erstattungen aus dem Stripe-Dashboard als Gutschrift gebucht werden)
   - optional `refund.created` und `refund.updated` (werden ebenfalls verarbeitet)
4. Endpoint speichern. Unter dem Endpoint **Signing-Secret anzeigen** und den Wert (`whsec_…`) kopieren. → `STRIPE_WEBHOOK_SECRET` in Vercel.
5. Der Testmodus braucht einen eigenen Endpoint mit eigenem Secret. Beide Secrets komma-getrennt in `STRIPE_WEBHOOK_SECRET` eintragen, z. B. `whsec_test…,whsec_live…`.

**Prüfen:** Im Endpoint **Ereignisse senden** oder eine Testzahlung machen. Die Antwort sollte `200` sein. Eine `401` heißt: falsches Secret.

---

## 6. Umgebungsvariablen in Vercel

Projekt **pythia-voice-site** → Settings → Environment Variables. Dann **neu deployen**, sonst greifen die Werte nicht.

| Variable | Inhalt |
|---|---|
| `STRIPE_WEBHOOK_SECRET` | Signing-Secret(s) `whsec_…`, komma-getrennt |
| `PYTHIA_PAYMENT_LINKS` | `plink_…` Diktat, komma-getrennt (Test und Live) |
| `PYTHIA_VOICE_LINKS` | `plink_…` Sprachnachrichten |
| `PYTHIA_RECAP_LINKS` | `plink_…` Recap |
| `STRIPE_READ_KEY` | eingeschränkter Lese-Schlüssel (Abschnitt 4) |
| `STRIPE_REFUND_KEY` | eingeschränkter Erstattungs-Schlüssel (Abschnitt 4) |

Die Lizenz- und Mailvariablen (`PYTHIA_LICENSE_PRIVATE`, `RESEND_API_KEY` usw.) stehen in `DEPLOY.md` im Projektordner.

**Wichtig:** Die Variablen für Live und Test gehören in **Production**. Für Vorschau-Deployments nur Test-Werte eintragen, damit keine Live-Lizenzen aus Tests entstehen.

---

## 7. Auszahlung, Gebühren, Erstattung

- **Einstellungen → Auszahlungen → Zeitplan**: Standard ist täglich oder wöchentlich. Passt so.
- Gebühren fallen pro Zahlung an. Die Anwendung holt sie im Abgleich aus Stripe und bucht sie.
- Erstattung nur über den internen Bereich (Finanzen → Zeile des Verkaufs → „Erstatten“). Dort wird zuerst die Gutschrift gebucht und dann bei Stripe erstattet. Scheitert Stripe, wird die Gutschrift storniert.
- Erstattungen direkt im Stripe-Dashboard sind ebenfalls möglich. Sie werden über `charge.refunded` als Gutschrift gebucht. Der Code sperrt die Lizenz dabei **nicht** automatisch; das ist bei Erstattungen zu beachten (Stand Code, bitte bei Änderungen prüfen).

---

## 8. Ende-zu-Ende-Test (vor dem Live-Start)

1. Testmodus: Pythia Recap über den Testlink kaufen.
2. Erwartet:
   - Weiterleitung auf `/danke`.
   - Mail mit Lizenzschlüssel (`PV-…`) und Rechnungs-PDF im Anhang.
   - Im internen Bereich (`/intern`, Finanzen) steht der Verkauf mit Rechnungsnummer.
3. Schlüssel in der App eingeben oder per Link aktivieren. Die App sollte freigeschaltet werden.
4. Im internen Bereich „Erstatten“ testen. Stripe-Status: erstattet. Gutschrift gebucht.
5. Dasselbe **einmal im Live-Modus** mit einem echten Kauf zu 19,99 € und Erstattung. Stripe gibt die Gebühr dabei in der Regel nicht zurück; das ist der Preis des Tests.

---

## 9. Datenschutz und rechtliche Seiten

- Die Datenschutzseiten (`/datenschutz`, `/privacy`) nennen Stripe als Zahlungsdienstleister. Das ist bereits enthalten.
- Auftragsverarbeitung: Der Vertrag mit Stripe wird über die Stripe-Nutzungsbedingungen geschlossen. Die Unterlagen stehen unter **Einstellungen → Rechtliches**. Dort nachsehen, ob alles hinterlegt ist.
- Widerrufsrecht und AGB: bitte rechtlich prüfen lassen. Dieses Dokument ist keine Rechtsberatung. Insbesondere das Erlöschen des Widerrufsrechts bei digitalen Inhalten sollte mit Zustimmung beim Kauf geregelt sein.

---

## Checkliste

- [ ] Konto verifiziert, Bankkonto hinterlegt
- [ ] Support-E-Mail und Name „Pythia Voice“ hinterlegt
- [ ] 3 Produkte à 19,99 € einmalig angelegt
- [ ] Zahlungslinks mit E-Mail-, Namens- und Adressabfrage, Weiterleitung auf `/danke`
- [ ] Zwei eingeschränkte Schlüssel angelegt (Lesen, Erstattung)
- [ ] Webhook mit 4 (bzw. 6) Ereignissen, Secret in Vercel
- [ ] Alle Variablen in Vercel gesetzt, neu deployt
- [ ] Testkauf je Produkt, Mail und Beleg angekommen
- [ ] Testerstattung im internen Bereich
- [ ] Live-Kauf und Live-Erstattung einmal durchgespielt
- [ ] Links `buyUrl`, `voiceBuyUrl`, `recapBuyUrl` in `config.js` gesetzt
