# Klare Rechte-Trennung (Sehen / Bearbeiten / Administrieren)

**Datum:** 2026-07-24
**Status:** Design freigegeben (Michel, „ja"), Implementierungsplan folgt
**Auslöser:** Nur-Seher-Test mit Gruppe `test` über alle ~25 Tools. Michel:
„Sehen soll wirklich nur sehen. Bearbeiten soll auch Sehen einschließen. Kritische
Apps sollen im Panel besonders gekennzeichnet sein."

## Ziel

Eine für jeden verständliche, saubere Rechte-Trennung über die ToolsUebersicht-Flotte:

1. **Sehen = wirklich nur sehen** — keine bearbeitbaren Felder, keine wirksamen
   Schreibwege für Nur-Seher.
2. **Bearbeiten schließt Sehen ein** — wer Bearbeiten-Recht hat, sieht die App auch
   (heute nicht so: nur „Bearbeiten" angehakt ⇒ App unsichtbar).
3. **Kritische Apps sichtbar kennzeichnen**, damit Fehl-Zuweisungen auffallen.

Reiht sich in das am 2026-07-24 fixierte Drei-Stufen-Modell ein
(Sehen `groupIds` / Bearbeiten `editGroupIds` / Administrieren `adminGroupIds`).

## Befund (gegen echte Serverdaten verifiziert)

Live-Config ausgelesen über den öffentlichen Worker-`GET`
(`https://landingpage.michel-brunner.workers.dev`, `fetchVisibility`, keine Auth).
Test-Gruppe = `test`.

**Konfiguration ist unschuldig:** `test` steht bei materialliste, trainercheckliste,
spielertool-test, kadermanager ausschließlich in `groupIds` (Sehen), nie in
`editGroupIds`. Michel hatte recht — es ist kein Einstellungsfehler.

**Serverseitige Schreibsperre** (`WRITE_REQUIRES_EDIT_PERMISSION` in
`admin-worker.js`) deckt heute ab: vereinswiki, materialliste, trainercheckliste,
spielertool-test, spielersichtung, personalkosten, busplan, vereinskalender,
kadermanager, platzbelegung, fotoauftraege, raumnutzung. `resolveEditPermission`
gibt für leere/nicht-passende Gruppen **false** zurück (nur `session.isAdmin`
bypasst). Für diese Apps ist ein Nur-Seher-Save also serverseitig 403 — die Daten
sind sicher.

**Klassifikation aller gemeldeten „bearbeiten"-Fälle:**

| Klasse | Apps | Ursache | Datenrisiko |
|---|---|---|---|
| Echtes Persist-Leck | **dokumentenvorlagen** | nutzt `dav-save` (`gatewaySaveCatalog`), steht NICHT in der Sperrliste → Nur-Seher überschreibt den Vorlagen-Katalog, persistiert | **ja** |
| Latentes Loch | **personalakte** | `dav-save` offen, aber Client nutzt es nie (Schreibzugriffe laufen über `archive-trainer`/`reactivate-trainer`, die serverseitig bereits `resolveEditPermission` prüfen — Zeile 3059/3111; Doku-Kommentar „nur Sichtrecht" ist veraltet) | nein (nur hand-crafted request) |
| UI-Illusion | materialliste, trainercheckliste, spielertool-test, kadermanager, (personalakte, dokumentenvorlagen) | Eingaben/Buttons für Nur-Seher nicht ausgegraut; Save läuft in 403 bzw. lokalen `storageMode` | nein (Server backstop) |
| Gewollte Selbstbedienung | kleiderbestellung, fahrtenbuch, materialbedarf, fahrtenbuch-extern, digitaler-stempel, abwesenheitskalender, testspielplaner | Nicht-Bearbeiter dürfen nur **eigene** Einträge | nein (per Design) |
| Außerhalb Gateway | sc1911-anmeldung (Trainerversammlung-Anmeldung), vereinsbudget (FS-Access, lokale Datei), geschaeftsstelle | kein `DAV_APP`; Sehen/Bearbeiten steuern hier keinen geteilten Schreibzugriff | separat je App |
| Korrekt nur-lesend | vereinskalender, platzbelegung, spielersichtung, personalkosten, busplan, raumnutzung, fotoauftraege, besprechung, trainerdaten | — | — |

## Design

### Baustein 1 — Echte Schreibrechte serverseitig schließen

Nur `admin-worker.js`, ein Worker-Deploy (`landingpage`).

- **dokumentenvorlagen** in `WRITE_REQUIRES_EDIT_PERMISSION` aufnehmen — schließt
  das echte Persist-Leck. `gatewaySaveCatalog` (Katalog-Bearbeitung) ist eine reine
  Bearbeiter-Tätigkeit; kein Nicht-Bearbeiter-Selbstbedienungsweg vorhanden
  (vor dem Aufnehmen bestätigen — Lehre aus der Vereinskalender-Abstimmung).
- **personalakte** in `WRITE_REQUIRES_EDIT_PERMISSION` aufnehmen — Defense-in-Depth
  gegen das latente `dav-save`-Loch. Bricht nichts (Client nutzt generisches
  `dav-save` nie; `archive-/reactivate-trainer` sind eigene Handler, unberührt von
  diesem Set).
- Kopf-Kommentar der Konstante um beide Apps ergänzen (heute „aktuell:
  vereinswiki" u. a.).

### Baustein 2 — „Bearbeiten ⟹ Sehen"

`admin-worker.js` + Panel (`app.js`, `index.html`).

- **`userMayAccessTool`** erweitern: zusätzlich `true`, wenn die Session in
  `editGroupIds` **oder** `adminGroupIds` der App steht. Sichtbarkeit =
  bestehende Logik **∪** Bearbeiten **∪** Administrieren. Reine Erweiterung
  (Union), verengt nie ein breit freigegebenes Tool. Der bestehende
  „bewusst getrennt"-Kommentar (Z. 3320–3324) wird ersetzt/aktualisiert, weil er
  das alte Verhalten beschreibt.
  - Empty-`groupIds`-Zweig (= alles Personal, außer Spieler) bleibt unverändert.
  - Ein explizit in `editGroupIds`/`adminGroupIds` gesetzter Spieler bekommt
    dadurch Sicht — gewollt (expliziter Grant), Randfall dokumentieren.
- **Panel-Kopplung** in beiden Ansichten (Tool-Ansicht + Gruppen-Ansicht):
  Bearbeiten anhaken → Sehen mit anhaken; Sehen abwählen → Bearbeiten (und damit
  Administrieren) mit abwählen. Analog zur bestehenden Administrieren→Bearbeiten-
  Kopplung. Nur Anzeige-Kopplung; maßgeblich ist die Server-Union.
- Sichtbarkeits-Dropdown-Interaktion beachten: der Modus „Nur bestimmte Gruppen"
  ist die Ebene, auf der die Kopplung sichtbar wird.

### Baustein 3 — „Wirklich nur sehen" (UX-Lockdown)

Je App, Frontend. Betroffen: materialliste, trainercheckliste, spielertool-test,
kadermanager, personalakte, dokumentenvorlagen.

- Für Nur-Seher (`!canEdit()`) die Bearbeiten-**Affordanzen echt sperren**:
  Eingabefelder `disabled`/ausgegraut, Buttons ausblenden — nicht nur den
  Save-Handler abbrechen. Ziel: die Maske sieht für Nur-Seher unmissverständlich
  read-only aus.
- Ursache je App gezielt bestimmen und schließen:
  - **materialliste / spielertool-test:** `canEdit()` enthält den Kurzschluss
    `storageMode !== "gateway"` (⇒ immer `true` im lokalen Datei-Modus). Prüfen,
    ob eingeloggte Nur-Seher zuverlässig in `"gateway"` landen; unabhängig davon
    die Eingabefelder an `canEdit()` koppeln (heute vor allem Buttons via
    `.editor-only`, Felder bleiben offen).
  - **kadermanager:** eigenes internes Rollen-/Rechte-System (`meta.rollenRechte`,
    `hasRecht()`). Klären, wie es mit dem Gateway-`canEdit` zusammenspielt und wo
    ein Nur-Seher noch editieren kann.
  - **trainercheckliste / personalakte / dokumentenvorlagen:** fehlende
    `.editor-only`/`disabled`-Kennzeichnung an den eigentlichen Feldern/Buttons.
- **Verifikation:** dieselbe Live-Config-Prüfung mit Gruppe `test` (oder
  Admin-Testansicht `set-view-as` → Gruppe der Sicht) — Maske muss read-only
  erscheinen, kein editierbares Feld.

### Baustein 4 — Kritische Apps im Panel kennzeichnen

Panel (`app.js`, `index.html`, ggf. `config.js` für das Kritisch-Flag).

- **Aufklappbare, benannte Sektion** in der Sichtbarkeits-/Tool-Liste, z. B.
  „⚠️ Sensible Tools — Rechte besonders sorgfältig vergeben", die die kritischen
  Apps gruppiert.
- **⚠️-Badge pro Zeile** (mit Tooltip) an jeder kritischen App, auch außerhalb der
  aufgeklappten Sektion sichtbar. (Michel-Entscheidung: nur diese beiden
  visuellen Mittel — **keine** Bestätigungs-Rückfrage, **keine** Sperre gegen
  „Alle eingeloggten".)
- **Kritisch-Set** (aus Michels Markierung, App-IDs):
  `trainercheckliste`, `sc1911-anmeldung`, `vereinsbudget`, `geschaeftsstelle`,
  `spielertool-test`, `personalkosten`, `kadermanager`, `digitaler-stempel`,
  `personalakte`, `dokumentenvorlagen`.
- Umsetzung als Flag `kritisch: true` im `TOOLS`-Eintrag (`config.js`) — eine
  Datenquelle, Panel liest sie aus. Kein Server-Zwang.

### Nicht-Gateway-Apps (Randnotiz)

Trainerversammlung-Anmeldung (`sc1911-anmeldung`), Vereinsbudget (`vereinsbudget`),
Geschäftsstelle (`geschaeftsstelle`) laufen nicht über das Sehen/Bearbeiten-
Schreibmodell:
- Vereinsbudget = FS-Access-API, lokale Datei je Gerät → kein geteiltes Schreib-Leck.
- sc1911-anmeldung = Teilnehmer-Aktion per Aktions-Passwort (`PW_ANMELDUNG_TEILNEHMER`).
- Geschäftsstelle = im Zuge der Umsetzung kurz prüfen, wie sie schreibt.

Sie werden in Baustein 4 mit gekennzeichnet; ein echter offener Schreibweg wird
gemeldet, nicht stillschweigend „gefixt".

## Reihenfolge & Deploy

1. **Baustein 1** zuerst (Sicherheit) — `admin-worker.js`, Deploy `landingpage`
   via `deploy-worker.ps1 -Worker landingpage -Deploy`.
2. **Baustein 2** — Worker (gleiche Datei/Deploy) + Panel-Push.
3. **Baustein 3** — je App Frontend-Push, `?v=`-Bump im selben Commit.
4. **Baustein 4** — Panel-Push.

Konventionen: `APP_VERSION` bleibt überall **1.0**, Cache-Busting nur per `?v=`
im selben Commit; Changelog-Eintrag je geänderter App; vor jedem Commit
`git status` (geteilte Working Copy). Commit-Messages mit Quotes/Umlauten via
`git commit -F <scratchpad-datei>`.

## Verifikation

- `node --check` aller geänderten JS-Dateien.
- Worker: `deploy-worker.ps1 -Worker landingpage` (byte-genauer Live-Vergleich),
  Gesundheitsproben 400/401/403; unauth. Aktionsprobe.
- **Kernprobe Baustein 1/2/3:** öffentlicher `GET` + gezielte Prüfung, dass
  `test` bei den betroffenen Apps in `groupIds`, nicht `editGroupIds` steht, und
  dass ein `dav-save` als Nicht-Bearbeiter 403 liefert (live eingeloggt aus
  PowerShell, zerstörungsfrei).
- Panel lokal (Browser-Preview): Kopplung Bearbeiten↔Sehen, Kritisch-Sektion +
  Badges rendern; Save-Payload enthält die erwarteten `groupIds`.
- Pages-Apps: Live-`?v=`-Check pro App.

## Bewusst NICHT in dieser Runde

- Kein Umbau der gewollten Selbstbedienungs-Apps (kleiderbestellung/fahrtenbuch/
  materialbedarf/digitaler-stempel etc.) auf serverseitige Owner-Filter — sie
  funktionieren wie vorgesehen.
- Keine Bestätigungs-Rückfrage / keine „Alle eingeloggten"-Sperre für kritische
  Apps (Michel-Entscheidung: rein visuell).
- Kein gemeinsamer Client-Helfer für den View-Only-Lockdown (YAGNI); je App im
  bestehenden Muster (`canEdit()` + `.editor-only` + `disabled`).
