# App-Icon auf dem Handy ablegen (PWA-Installation)

**Datum:** 2026-08-01
**Status:** Design freigegeben (Michel, „ja"), Implementierungsplan folgt
**Auslöser:** Michel: „können wir da einen button in die oberfläche bauen um ein app
icon auf dem handy screen abzulegen?" — Vorgeschichte war die Frage, ob sich die
Flotte bei Hostinger hosten und daraus eine iOS-/Android-App bauen ließe. Ergebnis
jener Prüfung: Umzug bringt nichts (die sechs Cloudflare-Worker können dort nicht
laufen, Service Bindings gibt es nur bei Cloudflare), Store-Veröffentlichung
scheitert an Mac/Xcode-Zwang und Apples Regel gegen reine Website-Hüllen. Der
tragfähige Weg ist die PWA — und die kostet nichts.

## Ziel

Ein Knopf in der Kopfzeile der Tools-Übersicht, über den ein angemeldeter Nutzer
die Flotte als App-Icon auf dem Startbildschirm ablegt. Danach startet sie im
Vollbild ohne Browserleiste, mit eigenem Icon im App-Umschalter.

## Befund (am echten Code und an den echten Dateien geprüft)

**ToolsUebersicht ist heute keine PWA.** Kein `manifest.json`, kein Service Worker,
kein `<link rel="manifest">` und kein `apple-touch-icon` in `index.html`
(Glob + Grep über das Repo, 2026-08-01).

**Die Flotte kennt das Muster aber schon.** PWAs mit Manifest und Service Worker:
`Materialliste`, `spielertool-test`, `kassenbuch`, `agelan`, `familien-quartett`,
`spiele/*`. Keine davon ist eine Gateway-App im engeren Sinn.
`Materialliste/sw.js` ist ein **bewusst leerer** Service Worker mit dem Kommentar
„Kein Offline-Caching" — genau die Variante, die hier gebraucht wird.

**`beforeinstallprompt` kommt in der gesamten Flotte nirgends vor** (Grep über
`E:\`). Es gibt also noch keinen Installations-Knopf, den man kopieren könnte; die
bestehenden PWAs verlassen sich auf das Browsermenü.

**Die Kopfzeile ist eng.** Bei 375 px ist sie schon 243 px hoch (als Admin 290 px),
und `CLAUDE.md` hält fest: „Wer hier weiter Höhe sparen will, muss den
Materialcontainer-Knopf am Handy kürzen — das ist die einzige verbliebene
Stellschraube." Michel hat die Kopfzeile trotz dieses Hinweises bewusst als Platz
gewählt; die Gegenmaßnahmen stehen unter „Der Knopf".

**Es gibt kein Wurzel-Repo.** `E:\` enthält kein `sc1911heiligenstadt.github.io`, die nackte
Adresse läuft heute ins Leere.

**Das Vereinswappen ist zu klein.** `ToolsUebersicht/logo.png` misst 223 × 211 px
und ist nicht quadratisch. Ein Startbildschirm-Icon wird auf heutigen Geräten
physisch mit rund 360–540 px dargestellt — Hochskalieren würde matschen.

## Entscheidungen

| Frage | Entscheidung | Begründung |
|---|---|---|
| Geltungsbereich | **Ganze Flotte** (`scope: "/"`) | Sonst wirft jeder Kachel-Klick den Nutzer aus der App; auf iOS in ein separates Safari-Fenster. Ausgerechnet das Weiterklicken ist der Zweck der Übersicht. |
| Ort des Knopfes | **Kopfzeile** | Michel-Vorgabe. Höhenrisiko wird über Kurzbeschriftung und Verschwinden nach Installation abgefangen. |
| Sichtbarkeit | **Nur Angemeldete** | Gleiche Linie wie Info-Tab (seit 2026-07-25) und Neuigkeiten. |
| Caching | **Keines** | Ein cachender Service Worker wäre eine zweite Cache-Ebene neben den `?v=`-Bumps. |

## Architektur

### Neues Repo `sc1911heiligenstadt/sc1911heiligenstadt.github.io`

Trägt das Wurzelverzeichnis, das heute ins Leere läuft. ⚠️ **Das Manifest muss
dort liegen** — ein Manifest kann keinen Geltungsbereich oberhalb seines eigenen
Verzeichnisses beanspruchen. Ein Manifest unter `/ToolsUebersicht/` könnte den
Vereinskalender also niemals einschließen.

| Datei | Zweck |
|---|---|
| `manifest.json` | Name, Icons, `scope: "/"`, `start_url: "/ToolsUebersicht/"` |
| `sw.js` | Leerer Service Worker, Muster aus `Materialliste/sw.js` |
| `icon-192.png`, `icon-512.png` | Startbildschirm-Icons |
| `icon-maskable-512.png` | Android-Variante mit Sicherheitsrand |
| `apple-touch-icon.png` | 180 × 180, iOS ignoriert die Manifest-Icons |
| `index.html` | Weiterleitung auf `/ToolsUebersicht/` |
| `README.md`, `.gitignore`, `CLAUDE.md` | wie in der übrigen Flotte |

Anlage über `gh repo create --public` — **nur auf Michels ausdrückliche Anforderung**,
nicht eigenmächtig. GitHub Pages muss für das Repo eingeschaltet werden.

### Änderungen in `ToolsUebersicht`

Das einzige bestehende Repo, das angefasst wird.

- `index.html`: `<link rel="manifest" href="/manifest.json">`, `apple-touch-icon`,
  `theme-color`, der Knopf in `.header-btns`, das Anleitungs-Fenster für iOS
- `app.js`: Service-Worker-Registrierung, `beforeinstallprompt`-Abfang,
  Knopf-Sichtbarkeit, Klick-Verhalten je Plattform, `appinstalled`-Aufräumen
- `style.css`: Kurzbeschriftung unter 860 px, Fenster-Optik
- `config.js`: Changelog-Block über 1.0, `?v=`-Bump im selben Commit

**Der Worker wird nicht angefasst.** Kein Deploy von `admin-worker.js`, keine
Änderung an `ALLOWED_ORIGINS` — es ist dieselbe Origin. Die übrigen 27 App-Repos
bleiben unberührt.

## Manifest

```json
{
  "name": "SC 1911 Vereinswerkzeuge",
  "short_name": "SC 1911",
  "start_url": "/ToolsUebersicht/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#eef1f6",
  "theme_color": "#1a56a0",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

Farben aus dem bestehenden Flotten-Muster (identisch zu `Materialliste/manifest.json`).
`short_name` erscheint unter dem Icon und ist deshalb kurz gehalten.

## Service Worker

Wortgleich zum Muster der Materialliste: `install` → `skipWaiting()`, `activate` →
`clients.claim()`, `fetch` → leerer Handler ohne `respondWith`. Der Browser lädt
damit unverändert aus dem Netz; der Service Worker existiert ausschließlich, weil
Chrome ihn für die Installierbarkeit verlangt.

⚠️ **Er hat Geltungsbereich `/` und wird damit bei jedem Aufruf jeder App der Flotte
aktiv.** Solange er leer ist, greift er nirgends ein. Wer dort jemals Caching
einbaut, legt eine Ebene über alle 28 Tools und hebelt das `?v=`-Verfahren aus.
Dieser Satz gehört in die CLAUDE.md beider betroffener Repos.

**Kein Konflikt mit den bestehenden PWAs:** `Materialliste`, `spielertool-test`,
`kassenbuch`, `agelan`, `familien-quartett` und `spiele/*` registrieren eigene
Service Worker mit engerem Geltungsbereich; bei Überschneidung gewinnt der
speziellere. Beim Bauen ist das nachzuprüfen, nicht anzunehmen.

Registriert wird aus `ToolsUebersicht/app.js` heraus über den absoluten Pfad
`/sw.js`. Der Geltungsbereich richtet sich nach dem Ort der Skriptdatei, nicht nach
der registrierenden Seite — eine Seite im Unterverzeichnis darf einen Wurzel-Worker
registrieren.

## Der Knopf

Beschriftung „📲 Als App ablegen", unter 860 px per bestehender `.btn-lang`-Mechanik
verkürzt auf „📲 App". Sitzt in `.header-btns` neben den vorhandenen Knöpfen.

**Sichtbar nur, wenn alle drei Bedingungen zutreffen:**

1. Nutzer ist angemeldet (`currentUser`)
2. Die App läuft nicht bereits im Standalone-Modus
   (`matchMedia("(display-mode: standalone)")` oder `navigator.standalone` auf iOS)
3. Die Plattform kann überhaupt etwas anbieten — entweder liegt ein abgefangenes
   `beforeinstallprompt`-Ereignis vor, oder es ist iOS-Safari

Nachgezogen wird die Sichtbarkeit aus `renderNavTabs()`, analog zu
`updateKopfKnoepfe()`. ⚠️ Das `beforeinstallprompt`-Ereignis kann **nach** dem
Seitenaufbau eintreffen — der Abfang-Handler muss die Sichtbarkeit deshalb selbst
noch einmal anstoßen, sonst bliebe der Knopf beim ersten Besuch aus.

| Plattform | Klick bewirkt |
|---|---|
| Android/Chrome, Edge, Samsung Internet | `prompt()` auf dem gemerkten Ereignis → echter Installationsdialog des Systems |
| Chrome/Edge am Rechner | derselbe Dialog, App landet im Startmenü |
| iOS/iPadOS Safari | Fenster mit Anleitung: Teilen-Symbol → „Zum Home-Bildschirm" |
| Firefox, iOS-Fremdbrowser | Knopf erscheint nicht (Bedingung 3 nicht erfüllt) |

⚠️ **Auf iOS gibt es keinen programmatischen Weg.** Apple hat `beforeinstallprompt`
nie umgesetzt; der Knopf kann dort nur anleiten. Das ist keine Lücke im Entwurf,
sondern eine Grenze der Plattform.

Das Anleitungsfenster nutzt die bestehende `.code-overlay`/`.code-dialog`-Mechanik,
die seit `76989c7` `max-height: calc(100vh - 40px)` und eigenes Scrollen von der
Basisklasse erbt — **keine neue Sonderklasse anlegen.**

Nach erfolgreicher Installation (`appinstalled`) verschwindet der Knopf sofort; das
gemerkte Ereignis wird verworfen (es ist ohnehin verbraucht).

## Was bewusst nicht gebaut wird

- **Kein Offline-Betrieb.** Die Apps hängen an Worker und Nextcloud; eine
  offline-fähige Hülle würde Verfügbarkeit vortäuschen, die es nicht gibt.
- **Keine Push-Nachrichten.** Benachrichtigungen laufen über Brevo, und iOS
  verlangt dafür ohnehin eine installierte PWA plus eigene Zustimmung.
- **Keine 28 einzelnen PWAs.** Eine Hülle, 28 Kacheln.
- **Kein `APP_VERSION`-Bump.** Bleibt bei 1.0, Änderung kommt in den Changelog-Block.
- **Kein Wegklick-Streifen und kein Fußzeilen-Eintrag.** Beides wurde erwogen und
  zugunsten des Kopfzeilen-Knopfes verworfen.

## Risiken und Prüfpunkte

| Risiko | Umgang |
|---|---|
| Kopfzeile wächst am Handy | Kurzbeschriftung + Verschwinden nach Installation. **Bei 375, 414 und 1280 px nachmessen**, ob „📲 App" sich eine Zeile mit „✍ Unterschriften" teilt. |
| Wurzel-Service-Worker wirkt flottenweit | Leer halten. Warnung in beide CLAUDE.md. |
| Bestehende PWAs der Flotte | Überschneidende Geltungsbereiche beim Bauen prüfen. |
| Wurzeladresse ist heute 404 | Weiterleitung auf `/ToolsUebersicht/` im neuen Repo. |
| Zwei Repos, ein Zustand | Manifest-Verweis in ToolsUebersicht ist wertlos, solange das Wurzel-Repo nicht live ist. **Reihenfolge bindend: erst Wurzel-Repo veröffentlichen, dann ToolsUebersicht.** |

## Nachweis vor dem „fertig"

- Kopfzeilenhöhe bei 375, 414 und 1280 px gemessen, kein seitlicher Überlauf
- Installierbarkeit im Preview geprüft (Manifest geladen, Service Worker aktiv,
  Icons erreichbar)
- Gegenprobe: Knopf verschwindet abgemeldet und im Standalone-Modus
- Beide Live-Adressen nach dem Push per `curl` verifiziert, nicht „gepusht = live"
- ⚠️ **Nicht durch mich prüfbar: der echte Ablauf auf Michels iPhone und einem
  Android-Gerät.** Das ist Michels Durchstich.

## Ergebnis der Umsetzung (2026-08-01, Commit `ba5bdc8`)

**Die Kopfzeilen-Frage ist entschieden, und zwar gegen die Hoffnung im Entwurf.**
Gemessen als Vorher-Nachher im selben Zustand: der Knopf kostet bei **375 px und
414 px je 38 px, also eine volle Zeile** — er passt *nicht* neben „✍ Unterschriften".
Grund ist nachgerechnet, nicht geschätzt: `.header-btns` ist dort 309 px breit,
Materialcontainer (164) + Unterschriften (120) belegen davon bereits 292 px. Auch
als reines Emoji bliebe der Knopf zu breit. Bei **1280 px kostet er für normales
Personal nichts** (passt in die Zeile), als Admin 47 px. Kein seitlicher Überlauf in
allen drei Breiten. Wer die Zeile sparen will, muss „🔐 Materialcontainercode" am
Handy kürzen — das bleibt die einzige Stellschraube.

**Sieben Sichtbarkeitsfälle im Preview belegt:** abgemeldet trotz vorliegendem
Ereignis → versteckt; angemeldet + Ereignis → sichtbar; angemeldet ohne Ereignis und
ohne iOS → versteckt; iOS-Safari → sichtbar; iOS-Chrome → versteckt; iOS bereits
abgelegt → versteckt; Android bereits abgelegt → versteckt.

**Der Wurzel-Geltungsbereich funktioniert:** der Service Worker registriert sich aus
`/ToolsUebersicht/` heraus mit Bereich `/`, im Testserver nachgewiesen. Manifest,
`sw.js` und alle Icons antworten live mit 200.

**Icons gezeichnet statt skaliert:** weißes Wappenschild mit blauem „SC" auf
Vereinsblau `#1a56a0`, per GDI+. Die maskable-Variante hat mehr Rand (Pad 0.25),
damit Androids Kreiszuschnitt die Schildecken nicht abschneidet.

⚠️ **Parallelsitzung im selben Repo:** während der Umsetzung arbeitete eine zweite
Sitzung an den Namen der Neuigkeiten-Reaktionen — in `admin-worker.js`, `app.js`,
`style.css` und `config.js`. Gestaged wurden ausschließlich die eigenen Hunks
(`git apply --cached --unidiff-zero`, 20 Hunks in `app.js` davon 2 eigene, 3 in
`style.css` davon 1). Im Changelog teilten sich beide dieselbe Einfügestelle; die
andere Sitzung hatte sauber als 1.19 über 1.18 einsortiert, der eigene Block wurde
auf Blockebene herausgeschnitten. Der gestagte Baum wurde vor dem Commit per
`git checkout-index` ausgecheckt und mit `node --check` geprüft — nicht bloß die
Arbeitskopie.

## Offener Punkt

**Icon-Quelle.** Das Wappen liegt nur in 223 × 211 px vor. Entweder liefert Michel
es in höherer Auflösung oder als Vektor, oder das Icon wird nach dem Muster von
`kassenbuch/icons/` neu gezeichnet (Wappen-Silhouette bzw. „SC" auf Vereinsblau
`#1a56a0`) statt hochskaliert. Die Entscheidung blockiert den Rest nicht — Icons
sind austauschbar, ohne dass sich sonst etwas ändert.
