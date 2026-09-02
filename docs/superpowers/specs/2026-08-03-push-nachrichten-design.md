# Push-Nachrichten aufs Handy

**Datum:** 2026-08-03
**Status:** Design freigegeben (Michel, „ja"), Implementierungsplan folgt
**Auslöser:** Michel: „Da wir das Ganze ja schon als PWA App haben, also wirklich auf
dem Handy als App installiert — wie ist es möglich, hier auch schon Push-Nachrichten
zu senden? Kann iOS die Push-Nachrichten oder immer noch nur Android?"

## Ziel

Die drei Vorgänge, bei denen heute eine Brevo-Mail rausgeht oder rausgehen sollte,
melden sich zusätzlich als Push-Nachricht auf dem Handy: **ein neuer Kalendertermin,
eine zugewiesene Vereinsaufgabe, ein Dokument zum Unterschreiben.** Die Mail bleibt
für alle unverändert bestehen; Push kommt obendrauf.

## Befund (am echten Code geprüft, 2026-08-03)

**iOS kann Push — seit iOS 16.4 (März 2023), aber nur für Web-Apps auf dem
Startbildschirm.** In einem Safari-Tab existiert das `Notification`-Objekt nicht
einmal. Die PWA-Installation vom 2026-08-01 ist damit nicht bloß hilfreich, sondern
die zwingende Voraussetzung; ohne sie wäre Push auf iPhones unmöglich. Es ist kein
Apple-Sonderweg: Safari nutzt seit 16.4 den Standard (VAPID, Push API), derselbe
Code bedient iPhone, Android und Rechner.

⚠️ **iOS 16.4 setzt iPhone 8 oder neuer voraus.** Ältere Geräte bleiben auf iOS 15
und bekommen nie Push — ohne Nachrüstmöglichkeit. In der Flotte sind solche Geräte
nachweislich unterwegs (Raumnutzung-Fall vom 2026-07-25). Push ist deshalb ein
Zusatzkanal, nie ein Ersatz für einen verlässlichen Weg.

**Die Voraussetzungen stehen.** Die Übersicht läuft installiert auf je einem
Android- und einem iOS-Gerät (Michel, 2026-08-03). Manifest (`display: standalone`,
`scope: "/"`), Service Worker und Icons liegen im Wurzel-Repo
`sc1911heiligenstadt.github.io`.

**In der ganzen Flotte gibt es keinen Push-Code.** Grep über `E:\` nach
`Notification|pushManager|showNotification|applicationServerKey|vapid`: der einzige
Treffer ist die SEPA-Vorabankündigung („Pre-Notification") in
`vereinsverwaltung-worker.js`, ohne jeden Bezug. Grüne Wiese.

**Alle drei Anlässe ermitteln ihre Empfänger bereits im `landingpage`-Worker:**
`handleNotifyUser` (Zeile 2586), `handleVaAnlegen` (4517, Empfänger als Array,
`VA_MAX_EMPFAENGER = 30` je Vorgang), `handleDokumentAnlegen` (Mail-Zweig ab 3800).
**Folge: keine der drei Apps muss angefasst oder neu ausgerollt werden.**

**CPU ist kein Architekturtreiber.** Bei jedem Login laufen 100.000
PBKDF2-Iterationen durch (`PBKDF2_ITERATIONS`, Zeile 734, mit dem Kommentar
„bewusst unter OWASP-210k, um im Cloudflare-Free-CPU-Limit zu bleiben") und passen
ins Limit. Ein Push-Paket kostet pro Empfänger eine ECDH-Ableitung, eine
HKDF-Ableitung, ein AES-GCM und eine Signatur — Größenordnung wenige tausend
Iterationen. ⚠️ **Nicht gemessen, nur eingeordnet.** Bei 30 Empfängern mit je zwei
Geräten kommen aber 60 Verschlüsselungen in einem Request zusammen; dafür siehe
„Fan-out in Häppchen".

**Der Worker ist die schwerste Datei der Flotte:** `admin-worker.js`, 7.153 Zeilen,
423 KB.

## Michels Entscheidungen (alle abgefragt, nicht geraten)

| Frage | Entscheidung |
|---|---|
| Anlässe | Alle drei: Kalender, Aufgaben, Unterschriften |
| Verhältnis zur Mail | **Mail bleibt für alle, Push kommt zusätzlich** |
| Nachrichtentext | App + Art des Vorgangs, **keine Namen und keine Titel** |
| Ort der Anmeldung | Tab „Mein Konto", **nicht** die Kopfzeile |
| Feinheit | **Drei Schalter**, alle voreingestellt an |
| Architektur | **Eigener `push`-Worker** per Service Binding (Ansatz B) |
| Unterschriften-Häkchen | **Push geht immer**, unabhängig vom Mail-Häkchen |

### Begründungen, die nicht verlorengehen dürfen

**Additiv statt ersetzend.** Push erreicht nie zuverlässig alle: es braucht eine
abgelegte App, eine erteilte Erlaubnis und ein Gerät ab iPhone 8. Die Mail-Wege
bleiben deshalb unangetastet. Für den Vereinskalender-Empfänger, dessen Brevo-Mail
im Gmail-Spam liegt, ist Push endlich ein zweiter Weg — aber der erste wird ihm
nicht weggenommen.

**Neutraler Text.** Präzedenzfall im eigenen Haus: Bei den Unterschriften-Mails
nennt der Betreff den Dokumenttitel bewusst nicht — wegen Handy-Vorschau und
Versandprotokoll. Eine Push-Nachricht ist dasselbe Problem in schärfer, weil sie auf
dem Sperrbildschirm steht, den auch jemand anders sehen kann. Also
„Vereinsaufgaben — eine neue Aufgabe für dich", nicht „Michel hat dir zugewiesen:
Trikots zählen".

**Konto-Tab statt Kopfzeile.** Die Kopfzeile ist am Handy am Anschlag (243 px bei
375 px Breite, als Admin 290 px; „📲 Als App ablegen" hat dort im August bereits eine
volle Zeile gekostet). Vor allem aber: Ein Kopf-Knopf verschwindet nach dem
einmaligen Klick, ein Schalter im Konto-Tab bleibt auffindbar — zum Abstellen und
zum Einschalten auf einem zweiten Gerät.

**Drei Schalter, nicht einer.** Der Kalender ist der lauteste der drei Anlässe. Wer
davon zugeschrieben wird und nur einen Hauptschalter hat, stellt alles ab — und
verpasst dann den Vertrag. Kostet drei Wahrheitswerte, sonst nichts.

**Push ohne Häkchen.** Das Häkchen bei den Unterschriften gibt es wegen der
Mail-Eigenheiten: externe Zustellung, Spam-Gefahr, Versandprotokoll bei Brevo. Push
hat davon nichts — interner Kanal, Ende-zu-Ende verschlüsselt, vom Empfänger selbst
eingeschaltet und selbst abstellbar. Die Entscheidung wandert damit vom Absender zum
Empfänger, was bei einem auf ihn wartenden Vertrag die richtige Seite ist.

**Eigener Worker (Ansatz B).** Verworfen wurde Ansatz A (alles in `landingpage`) und
Ansatz C (fertiger Dienst wie OneSignal/Firebase — ein weiterer Auftragsverarbeiter
mit den Gerätekennungen eurer Leute, mitten im Art.-13-Rollout, ohne dass er etwas
könnte, was der Worker nicht selbst kann).

⚠️ **Der Einwand gegen B ist ausgeräumt, nicht in Kauf genommen.** Der `push`-Worker
bekommt **keinen** Nextcloud-Zugang. `landingpage` hat ihn ohnehin, liest die Abos
selbst und übergibt sie im Aufruf. Der neue Worker ist ein zustandsloser
Versandknecht: kennt nur das VAPID-Schlüsselpaar, verschlüsselt, stellt zu, meldet
tote Abos zurück. Kein zweiter Ort mit `NEXTCLOUD_PASSWORD` — die bestehende
Worker-Aufteilung folgt Vertrauensgrenzen, und Push ist keine eigene.

## Architektur

| Baustein | Aufgabe | Zustand |
|---|---|---|
| `sc1911heiligenstadt.github.io/sw.js` | `push`- und `notificationclick`-Handler | erweitert |
| `ToolsUebersicht/app.js` | Schalter im Konto-Tab, Erlaubnis, An-/Abmeldung | erweitert |
| `admin-worker.js` (`landingpage`) | Abos verwalten, Empfänger ermitteln, Auftrag erteilen | erweitert |
| `push-worker.js` (`push`) | VAPID-Signatur, Verschlüsselung, Zustellung | **neu** |
| Nextcloud `push-abos.json` | Geräte-Abos und Anlass-Schalter | neu |

⚠️ **Im `sw.js` kommen nur die beiden neuen Handler dazu — der `fetch`-Handler
bleibt leer.** Push-Handler und Caching haben nichts miteinander zu tun. Der Worker
hat Geltungsbereich `/` und ist bei jedem Aufruf jeder App der Flotte aktiv;
Caching dort legte eine zweite Ebene neben die `?v=`-Bumps und machte sie
wirkungslos.

**Datenfluss beim Versand:** Vorgang tritt in `landingpage` ein → Abos lesen, nach
Empfänger und Anlass-Schalter filtern → in `ctx.waitUntil` den `push`-Worker rufen →
der verschlüsselt je Gerät und stellt zu → meldet tote Abos zurück → `landingpage`
räumt sie aus der Datei.

**Fan-out in Häppchen zu zehn.** 30 Empfänger mit je zwei Geräten sind 60
Verschlüsselungen. `landingpage` schickt sie in Häppchen; jeder Aufruf über das
Service Binding bekommt sein **eigenes CPU-Budget**. Genau das kann Ansatz A nicht,
dort läge alles in einem Budget. Die Häppchengröße ist eine Konstante und nach einer
echten Messung anpassbar.

## Datenmodell

Eigene Datei `push-abos.json`, **nicht** in `nutzer.json`: die wird bei jedem
authentifizierten Request gelesen (`getVerifiedSession`), Abos dort verteuerten jeden
einzelnen Aufruf der ganzen Flotte um Daten, die nur beim Versand gebraucht werden.

```json
{
  "version": 1,
  "abos": {
    "mbrunner": [
      { "id": "<uuid>", "endpoint": "https://web.push.apple.com/…",
        "p256dh": "…", "auth": "…",
        "geraet": "iPhone · Safari", "angelegtAm": "2026-08-03T18:02:11Z" }
    ]
  },
  "anlaesse": {
    "mbrunner": { "kalender": true, "aufgaben": true, "unterschriften": true }
  }
}
```

**Die Schalter hängen an der Person, nicht am Gerät.** Technisch ginge pro Gerät,
aber dann zeigte der Konto-Tab je nach Handy andere Stellungen und niemand verstünde
warum. Einmal entscheiden „Kalender nervt mich", fertig.

**Je Nutzer eine Liste von Geräten, kein Einzelwert** — sonst wirft die Anmeldung am
Rechner die vom Handy raus. Deduplizierung über den `endpoint` (eindeutig); zweimal
Einschalten auf demselben Gerät darf keinen Doppeleintrag erzeugen.

**Fehlender Eintrag = alle drei Anlässe an.** Wer sich anmeldet, bevor es die
Schalter gibt, bekommt alles; die Änderung ist in beide Richtungen verträglich.

## Oberfläche: Karte „Benachrichtigungen aufs Handy" im Konto-Tab

| Lage | Anzeige |
|---|---|
| Browser kann kein Push (altes iOS, Firefox, iOS-Fremdbrowser) | Kurzer Hinweis, kein Knopf |
| iPhone, App nicht abgelegt | Hinweis mit Verweis auf „📲 Als App ablegen" |
| Möglich, noch nicht an | Knopf „Einschalten" |
| Angemeldet | Drei Schalter + Geräteliste mit „Abmelden" je Gerät |

⚠️ **Die Erlaubnis-Abfrage muss direkt im Klick-Handler stehen.** Nach einem `await`
verwirft Safari sie stillschweigend — dieselbe Falle wie bei `window.open`, siehe
`_openBlobTab()`.

⚠️ **Jeder Zugriff auf `Notification`, `serviceWorker` und `PushManager` braucht
einen echten Feature-Test mit funktionierendem Rückfallweg**, nicht nur ein `if`.
Auf den alten iPhones der Flotte existieren die Objekte nicht, und ein ungeschützter
Zugriff reißt den Rest des Konto-Tabs mit.

## Die drei Anlässe

| Anlass | Andockstelle | Empfänger |
|---|---|---|
| Kalender | `handleNotifyUser` (2586) | Der Client ruft die Aktion je geteiltem Nutzer — Push läuft mit |
| Aufgaben | `handleVaAnlegen` (4517) | `empfaenger`-Array, bis 30 je Vorgang |
| Unterschriften | `handleDokumentAnlegen` (3800) | Die Zugewiesenen |

### Die Texte (festgelegt, nicht dem Umsetzer überlassen)

| Anlass | Titel | Text | Ziel beim Antippen |
|---|---|---|---|
| Kalender | `Vereinskalender` | `Ein Termin wurde mit dir geteilt` / `Ein geteilter Termin hat sich geändert` | `/vereinskalender/` |
| Aufgaben | `Vereinsaufgaben` | `Eine neue Aufgabe für dich` | `/vereinsaufgaben/` |
| Unterschriften | `Unterschriften` | `Ein Dokument wartet auf deine Unterschrift` | `/ToolsUebersicht/` |

Keine Namen, keine Titel, keine Anzahl — die Anzahl nicht, weil sie im Moment des
Versands stimmt und auf dem Sperrbildschirm noch Stunden später steht.

⚠️ **`notificationclick` muss ein offenes Fenster fokussieren, statt ein zweites zu
öffnen.** Über `clients.matchAll({type: "window", includeUncontrolled: true})` nach
der Ziel-Adresse suchen, bei Treffer `focus()`, sonst `openWindow()`. Ohne das
sammeln sich in der abgelegten App mehrere Ansichten derselben Seite. Die Nachricht
ist danach mit `notification.close()` zu schließen.

### Neue Aktionen in `landingpage`

Schmale eigene Aktionen statt Feldern in `me` — dieselbe Linie wie beim
Materialcontainer-Code, wo der öffentliche GET seine Felder bewusst aufzählt:

| Aktion | Zweck |
|---|---|
| `push-status` | Geräte des Anmelders + Schalterstellungen für den Konto-Tab |
| `push-abo-anlegen` | Abo speichern (Deduplizierung über `endpoint`) |
| `push-abo-loeschen` | Ein Gerät entfernen (per `id`) |
| `push-anlaesse-setzen` | Die drei Schalter schreiben |

Der Nutzer kommt **immer aus dem Token, nie aus dem Body** — sonst meldet ein
Eingeloggter fremde Geräte an oder ab. Gleiche Regel wie bei `change-password`.

⚠️ **Was Push beim Kalender NICHT löst.** Der Vereinskalender-Client schleift nur
über `geteiltUsers`. Wer über eine *Gruppe* geteilt bekommt, wird schon heute nicht
benachrichtigt — Push erbt diesen Mangel unverändert, weil es an derselben Stelle
hängt. Das Spam-Problem bei Gmail und Yahoo löst es, das Gruppen-Problem nicht. Das
wäre ein eigener Vorgang im Vereinskalender und ist hier **nicht** enthalten.

## Fehlerbehandlung, Sicherheit, Datenschutz

**Tote Abos** (HTTP 404/410 — App gelöscht, Gerät zurückgesetzt) meldet der
`push`-Worker zurück, `landingpage` entfernt sie. ⚠️ Das ist ein Schreibvorgang auf
dieselbe Datei, in die parallel eine Anmeldung laufen kann: Read-Modify-Write mit
Konflikt-Wiederholung wie bei `vaMutiere`, **kein blindes Überschreiben**. Sonst
kostet ein Aufräumen die Anmeldung von vor zwei Sekunden.

**Alle anderen Fehler werden geschluckt, aber protokolliert.** Die eigentliche
Handlung (Aufgabe anlegen, Termin speichern) ist beim Versand schon passiert — wie
bei `beleg-eingang-notify`, anders als bei `raumnutzung-mail-antrag`, wo der Versand
die Handlung ist.

⚠️ **Der `push`-Worker braucht ein gemeinsames Secret, und `workers.dev` wird
abgeschaltet.** Ein Worker ist über seine `workers.dev`-Adresse öffentlich
erreichbar, auch wenn er nur per Binding gedacht ist. Ohne Türsteher kann jeder mit
eurem VAPID-Schlüssel Nachrichten an die Geräte eurer Leute schicken; Push-Endpunkte
prüfen die Signatur, nicht wer signiert hat.

⚠️ **Das VAPID-Schlüsselpaar ist wie `SESSION_SECRET`: ein Wechsel entwertet alle
Abos.** Jeder müsste neu einschalten, ohne es zu merken — es kommen einfach keine
Nachrichten mehr. Gehört als Warnung neben die `keep_bindings`-Warnung.

**Datenschutz:** Apple und Google stellen zu und sehen dabei die Geräte-Adresse; den
Inhalt nicht, der ist Ende-zu-Ende verschlüsselt. Das gehört in die Art.-13-Texte,
**bevor** der erste Nutzer einschalten kann. Betroffen ist nur ToolsUebersicht, nicht
alle 34 Seiten — eingeschaltet wird ausschließlich dort.

## Reihenfolge (bindend)

1. **`sw.js` im Wurzel-Repo** (Branch `main`) — muss live sein, bevor sich jemand anmelden kann
2. **`push`-Worker anlegen und deployen** — ein Service Binding auf einen nicht existierenden Worker lässt Schritt 3 scheitern
3. **`landingpage`** mit Binding, Abo-Verwaltung, drei Andockstellen
4. **ToolsUebersicht** (Pages) mit Konto-Tab und Datenschutz-Ergänzung

Schritte 1–3 sind für die Nutzer unsichtbar; erst Schritt 4 macht das Einschalten
möglich. Die Reihenfolge ist damit auch die verengungsfreie.

**Der neue Worker muss in die Registry von `deploy-worker.ps1`** (Name → lokale
Datei → Gesundheitsproben). Aus sechs Workern werden sieben.

## Als erbracht gilt es erst, wenn

- auf dem **Android** und auf dem **iPhone** je eine echte Nachricht ankommt,
- der Tipp darauf die richtige App öffnet,
- ein abgeschalteter Schalter nachweislich nichts mehr durchlässt,
- und ein „Abmelden" das Gerät wirklich aus `push-abos.json` entfernt.

Lokal prüfbar ist der Weg bis zur Verschlüsselung (Round-Trip gegen die eigene
Entschlüsselung, siehe die Regel zum selbstgebauten Encoder). **Dass eine Nachricht
auf einem Sperrbildschirm erscheint, kann nur ein echtes Gerät zeigen.**

## Nicht enthalten (bewusst)

- **Das Gruppen-Problem des Vereinskalenders** (siehe oben) — eigener Vorgang
- **Push aus anderen Apps der Flotte** — erst wenn die drei laufen
- **Ein Verlauf empfangener Nachrichten** in der App — dafür gibt es die Listen selbst
- **Badges auf dem App-Icon** — möglich (iOS 16.4+), aber ohne Zählquelle im
  Service Worker ein eigenes Thema
- **Ersetzen irgendeines Mail-Wegs** — ausdrücklich nicht, siehe „Additiv"
