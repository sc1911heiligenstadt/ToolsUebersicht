# Erinnerung an ablaufende Nachweise (Trainerdaten)

**Datum:** 2026-08-03
**Status:** Design freigegeben (Michel), Implementierungsplan folgt
**Auslöser:** Michel: „Auch hier soll eine Push Benachrichtigung kommen, wenn eines der
eingereichten Dokumente abläuft. Der Führerschein zum Beispiel hat ja eine sechsmonatige
Ablauffrist, wenn der abgelaufen ist, soll eine Push Nachricht kommen, dass der
Führerschein erneuert werden soll. Und das soll tendenziell für alle dieser eingereichten
Daten dort sein."
**Baut auf:** `2026-08-03-push-nachrichten-design.md` (Anlässe, Abos, `push`-Worker)

## Ziel

Wessen Führerschein, Trainerkodex, Jugendschutzkonzept, Trainerlizenz oder Führungszeugnis
abläuft, bekommt eine Push-Nachricht auf sein Handy — vorgewarnt und danach erinnert, bis
er den Nachweis erneuert hat.

## Befund (am echten Code geprüft, 2026-08-03)

**Die Fristen rechnet `landingpage` bereits.** `buildTrainerdatenSummary(td)` in
`admin-worker.js` (Zeile ~5538) liefert `fuehrerscheinGueltigBis`, `kodexGueltigBis`,
`jugendschutzGueltigBis` und reicht `trainerlizenzGueltigBis` durch — gebaut für das
Ampel-Badge auf der Kachel. **Der Cron benutzt genau diese Funktion**, statt eine dritte
Kopie derselben Formel anzulegen.

**`landingpage` liest `trainerdaten.json` ohnehin** (`PROVISION_ONLY_PATHS.trainerdaten`,
Zeile 524) — für Geburtstage, Kontakt-Lookup, Mailadressen und die eigene Ampel. Es
entsteht kein neuer Zugriffsweg auf die Datei mit den IBAN-Daten.

**Was fehlt, ist einzig der Auslöser.** Alle sieben bestehenden Push-Anlässe hängen an
einer Handlung (jemand legt an, entscheidet, kommentiert). Ein Ablauf ist kein Klick. In
der ganzen Flotte gibt es bislang **keinen einzigen zeitgesteuerten Trigger** — der
einzige Fundstellen-Treffer zu „cron" ist ein Kommentar in `admin-worker.js` (Zeile 754),
der für die selbstaufräumenden Listen bewusst *gegen* einen Cron entschied: „die
Bereinigung braucht keine Pünktlichkeit". **Diese Begründung greift hier nicht** — eine
Ablauffrist ist ein Kalenderereignis, und es gibt keinen Request, an den man sich hängen
könnte.

## Michels Entscheidungen (alle abgefragt, nicht geraten)

| Frage | Entscheidung |
|---|---|
| Empfänger | **Nur die betroffene Person** — nicht zusätzlich die Geschäftsstelle |
| Zeitpunkt | **14 Tage vorher + bei Ablauf + danach monatlich** |
| Führungszeugnis | Bekommt eine Frist: **3 Jahre** |
| Rückfallweg für Leute ohne Push | **Keiner** — nur Push, keine Mail, keine neue Liste |
| Nachrichtentext | **Neutral, ohne Dokumentart** |

### Begründungen, die nicht verlorengehen dürfen

**Nur die betroffene Person.** Handeln muss der, dessen Nachweis abläuft. Bei 54
Datensätzen mit je fünf Fristen bekäme die Geschäftsstelle sonst dauerhaft Meldungen über
Vorgänge, die sie nicht selbst erledigen kann.

**Neutraler Text trotz der Nachfrage nach dem Führerschein.** Michels Formulierung („dass
der Führerschein erneuert werden soll") legte einen konkreten Text nahe; die Push-Regel
vom selben Tag verlangt aber „App + Art des Vorgangs, keine Namen und keine Titel". Der
Widerspruch wurde ausdrücklich vorgelegt und zugunsten der Regel entschieden: **eine
Push-Nachricht steht auf dem Sperrbildschirm, den auch jemand anders sehen kann** — und
unter den fünf Nachweisen sind Führungszeugnis und Jugendschutzkonzept. Welcher Nachweis
gemeint ist, zeigen beim Öffnen die Badges, die es in der App längst gibt.

**Kein Rückfallweg.** Push erreicht nie alle (abgelegte App, erteilte Erlaubnis, Gerät ab
iPhone 8). Eine Brevo-Mail wäre der naheliegende zweite Weg, landet ohne DKIM/DMARC aber
bei Gmail und Yahoo im Spam — eine Erinnerung, auf deren Zustellung man sich verlässt, ist
dort schlechter als keine. Die Ablauf-Badges in der App bleiben der verlässliche Kanal.

## Architektur: Cron-Trigger auf `landingpage`

Ein zweiter Export neben `fetch` in `admin-worker.js`:

```js
export default {
  async fetch(request, env, ctx) { … },
  async scheduled(event, env, ctx) { await ablaufErinnerungenSenden(env, ctx); }
}
```

Cron-Ausdruck `0 5 * * *` — 07:00 deutscher Sommerzeit, 06:00 im Winter. Der
Sommer-/Winter-Versatz wird hingenommen: bei einer Erinnerung ist eine Stunde ohne Belang,
und eine Zeitzonen-Korrektur im Cron-Ausdruck gibt es nicht.

**Warum `landingpage` und nicht der Trainerdaten-Worker.** Nur dieser Worker hat alle drei
Zutaten gleichzeitig: er liest `trainerdaten.json`, er hält `push-abos.json`, und er hat
das Service Binding `PUSH`. `trainerdaten1` hätte weder Abos noch Binding und bräuchte eine
neue, **sitzungslose** Aktion in `landingpage`, die auf Zuruf an beliebige Konten pusht —
genau die Angriffsfläche, die der `push`-Worker mit seinem Shared Secret gerade vermeidet.

**Verworfen: Prüfung bei Gelegenheit** (an einen beliebigen Request gehängt). Ein Nutzer
zahlte die Rechnung für den ganzen Verein, ohne Marker feuerte es mehrfach, und öffnet
niemand die App, kommt nichts an — ausgerechnet bei den Trainern, die ohnehin nicht
hineinschauen.

⚠️ **Der Cron-Trigger ist Konfiguration außerhalb des Repos.** `deploy-worker.ps1` deployt
ihn nicht mit; ein Worker-Deploy löscht ihn zwar nicht (getrennter API-Pfad
`/schedules`), aber wer den Worker neu anlegt, hat ihn lautlos verloren, und es fällt
niemandem auf — es kommen einfach keine Nachrichten mehr. **`deploy-worker.ps1` bekommt
deshalb eine Anzeige „Cron-Trigger: vorhanden/FEHLT"** in der Analyse, dieselbe Rolle wie
die Bindings-Anzeige heute.

⚠️ **Der `scheduled`-Handler hat keine Sitzung.** `authHeader` wird dort genauso gebaut wie
in `fetch` (Zeile 822): `"Basic " + btoa(env.NEXTCLOUD_USERNAME + ":" + env.NEXTCLOUD_PASSWORD)`.

## Was ablaufen kann

| Nachweis | Feld | Frist | Woher die Frist |
|---|---|---|---|
| Führerschein | `fuehrerscheinHochgeladenAm` | +6 Monate | `buildTrainerdatenSummary` |
| Trainerkodex | `kodexBestaetigtAm` | +6 Monate | `buildTrainerdatenSummary` |
| Jugendschutzkonzept | `jugendschutzBestaetigtAm` | +6 Monate | `buildTrainerdatenSummary` |
| Trainerlizenz | `trainerlizenzGueltigBis` | gepflegtes Datum | Feld selbst |
| Führungszeugnis | `fuehrungszeugnisEingereichtAm` | **+36 Monate (neu)** | neue Konstante |

**Nicht erinnert wird bei:**

- **Nie eingereicht.** Ohne Ausgangsdatum gibt es kein Ablaufdatum. Dieses Feature erinnert
  an *ablaufenden*, nicht an *fehlenden* Nachweisen — so war der Auftrag formuliert
  („wenn eines der eingereichten Dokumente abläuft").
- **`trainerlizenzNichtVorhanden` angehakt.** Die Person hat aktiv erklärt, keine Lizenz zu
  haben.
- **Nicht-Vertragspflichtigen** (`vertragspflichtig === false`). Sie sehen diese Dokumente
  in der App gar nicht (`NUR_VERTRAGSPFLICHTIG_ACTIONS` in `submit-worker.js`) — eine
  Erinnerung wäre für sie unerfüllbar. **`=== false` prüfen, nicht falsy:** die
  Bestandsdatensätze führen das Feld nicht.

⚠️ **Die 6-Monats-Frist steht schon heute doppelt** — als `FUEHRERSCHEIN_GUELTIGKEIT_MONATE`
/`KODEX_GUELTIGKEIT_MONATE`/`JUGENDSCHUTZKONZEPT_GUELTIGKEIT_MONATE` in Trainerdatens
`config.js` (Anzeige) und hartkodiert als `+ 6` in `buildTrainerdatenSummary` (Ampel). Die
neue Führungszeugnis-Frist erbt diese Doppelung (`FUEHRUNGSZEUGNIS_GUELTIGKEIT_MONATE = 36`
plus `+ 36` im Worker). **Die Doppelung wird nicht ausgeweitet, aber im Code an beiden
Stellen benannt** — läuft sie auseinander, widersprechen sich Badge und Push-Nachricht.

## Empfänger aus dem Datensatz

`username` (setzt `handleSubmit` server-verifiziert bei jeder Einreichung) oder ersatzweise
`linkedUsername`. **Kein Namensabgleich als dritte Stufe** — anders als beim
Raumnutzungs-Kontakt-Lookup, wo ein Fehlgriff nur ein falsches Prefill wäre; hier ginge
eine Erinnerung an die falsche Person. Import-Stubs ohne Konto haben ohnehin nie etwas
eingereicht und damit kein Ablaufdatum.

⚠️ **Abos liegen unter `normalizeUsername(...)`** — dieselbe Falle wie bei den fünf
bestehenden Push-Handlern. Weicht die Schreibweise ab, liegt das Abo da und wird nie
gefunden.

## Der Merker

Eigene Datei `push-erinnerungen.json`, Geschwister von `push-abos.json`:

```json
{ "version": 1,
  "gesendet": {
    "<trainerId>:fuehrerschein": { "basis": "2026-09-14", "stufe": "faellig", "zuletzt": "2026-09-14" }
  } }
```

**Nicht in `trainerdaten.json`:** das ist Versand-Buchhaltung, kein Trainer-Datum, und in
die Datendatei schreibt jede Einreichung. Gleiche Linie wie die Auftraggeber-Angaben des
Bank-Exports, die bewusst im `localStorage` liegen.

**`basis` ist das errechnete Ablaufdatum und die Sollbruchstelle.** Reicht die Person den
Nachweis neu ein, ändert sich `basis`, und der Eintrag ist damit hinfällig — **ohne dieses
Feld liefe die Erinnerung nach der Erneuerung weiter**, und das ist der Fehler, den man dem
Feature am meisten übelnähme.

Daraus die Regel je (Trainer, Nachweis):

1. Ablaufdatum berechnen. Kein Datum → nichts zu tun, Eintrag aufräumen.
2. Eintrag mit abweichendem `basis` → verwerfen und wie ein neuer behandeln.
3. **Vorwarnung**: heute liegt in den letzten 14 Tagen vor `basis`, und für dieses `basis`
   wurde noch keine Vorwarnung gesendet → senden, `stufe: "vorwarnung"`.
4. **Fällig**: heute ≥ `basis`, und entweder noch keine „faellig"-Meldung für dieses
   `basis` oder `zuletzt` liegt ≥ 30 Tage zurück → senden, `stufe: "faellig"`,
   `zuletzt` = heute.

Ein zweiter Lauf am selben Tag sendet dadurch nichts doppelt.

⚠️ **Datumsvergleich als String gegen `Europe/Berlin`**, nie über `Date`-Momente:
`new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" })`. Genau diese
Konvention steht im Worker schon bei `trainerlizenzGueltigBis` (Zeile ~2598) samt der
Begründung — ein Momentvergleich wertet „gültig bis heute" ab Mitternacht UTC als
abgelaufen, während die App es den ganzen Tag als gültig zeigt. **Michel hat diesen Bug
schon einmal live erlebt.**

⚠️ **`buildTrainerdatenSummary` liefert die berechneten Fristen als `toISOString()`, also
UTC.** Ein `.slice(0, 10)` darauf ergibt in deutscher Sommerzeit den **Vortag**, wenn der
Upload-Zeitstempel zwischen 22:00 und 24:00 UTC lag. Der Kalendertag ist deshalb über
`toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" })` aus dem Zeitpunkt abzuleiten.
Dieselbe Falle wie `_heuteIsoDatum()` im Bank-Export.

⚠️ **Read-modify-write mit Konflikt-Wiederholung**, wie `pushAbosMutieren`. Zwar schreibt
nur der Cron in diese Datei, aber ein zweiter Lauf darf einen ersten nicht überholen.

## Der neue Anlass

Ein Eintrag in `PUSH_ANLAESSE` — mehr kostet er nicht, seit die Liste die einzige Quelle
für Schalter, Titel und Ziel ist:

```js
{ id: "nachweise", titel: "Trainerdaten", ziel: "/Trainerdaten/",
  label: "Trainerdaten — ablaufende Nachweise" }
```

| Stufe | Titel | Text |
|---|---|---|
| Vorwarnung | `Trainerdaten` | `Ein Nachweis läuft in den nächsten 14 Tagen ab` |
| Fällig | `Trainerdaten` | `Ein Nachweis ist abgelaufen und muss erneuert werden` |

**Ein Push je Person und Lauf, nicht je Nachweis.** Laufen zwei Fristen gleichzeitig ab,
wäre die zweite Nachricht wortgleich zur ersten. Gesendet wird die dringlichere Stufe
(fällig vor Vorwarnung); der Merker wird trotzdem für **jeden** betroffenen Nachweis
gesetzt, sonst käme der zweite beim nächsten Lauf einzeln nach.

**Der Schalter ist voreingestellt an**, wie alle anderen — `pushAnlaesseFuer` liest
`!== false`. Wer keinen fehlenden Nachweis hat, merkt ohnehin nichts.

⚠️ **Die Kachel `trainerdaten` in `config.js` bekommt `push: true`.** Es gibt keine
Automatik zwischen Anlass und Symbol; das ist von Hand nachzuziehen. Anders als bei den
übrigen Symbolen markiert es hier keine auslösende Handlung, sondern „diese App meldet
sich von selbst" — das ist beim Eintragen zu bedenken, denn die bestehende Regel lautet
„die auslösende Kachel, nicht die empfangende".

## Prüfbarkeit: die Aktion `ablauf-vorschau`

Ein Cron-Lauf ist von außen unsichtbar — dieselbe Lage, die schon `push-test` nötig machte.
Eine Admin-Aktion rechnet denselben Durchlauf und meldet zurück, **wer heute was bekäme,
ohne zu senden**: je Treffer Nutzername, Nachweis, Ablaufdatum, Stufe und der Grund, warum
nicht gesendet würde (kein Konto, kein Abo, Schalter aus, Merker frisch). Ohne das ist die
Frage „warum kam gestern nichts?" ein Blindflug.

## Was der Datenbestand sagt (gemessen, nicht geschätzt)

Gerechnet über `trainerdaten.backup.20260716-190101.json` (50 Datensätze; live sind es
inzwischen 54 — die Zahlen sind eine Größenordnung, keine Live-Messung):

| Monat | Ablaufende Fristen |
|---|---|
| 12/2026 | 1 (Trainerlizenz) |
| **01/2027** | **84 — Führerschein 21, Trainerkodex 36, Jugendschutz 27** |
| 12/2027 – 01/2030 | je 1–3 (Trainerlizenzen) |
| 07/2029 | 8 (Führungszeugnisse) |

**Zwei Folgerungen, die das Design berühren:**

⚠️ **Das Feature sendet die nächsten vier Monate gar nichts.** Alle Nachweise wurden im
Juli 2026 erfasst, der erste echte Ablauf ist Dezember 2026. Wer nach dem Deploy auf eine
Nachricht wartet, um zu sehen, ob es geht, wartet bis Weihnachten. **Deshalb ist
`ablauf-vorschau` keine Kür, sondern der einzige Weg, das Feature überhaupt abzunehmen** —
zusammen mit einem testweise vorgezogenen `trainerlizenzGueltigBis`.

⚠️ **Im Januar 2027 laufen 84 Fristen bei 36 Personen ab**, verteilt auf 11 Kalendertage,
am stärksten am 13.01.2027 mit 20 Fristen. Das ist kein Fehler, sondern die Folge davon,
dass Kodex und Jugendschutzkonzept im Juli 2026 flächendeckend auf einmal bestätigt wurden
— und es ist genau der Zweck des Features. Zwei Dinge folgen daraus: der Fan-out in
Häppchen zu zehn ist an diesem Tag wirklich gefordert (drei Binding-Aufrufe), und die
**Vorwarnungen fallen auf die Tage um den 30.12.**, also mitten in die Feiertage. Wer das
vermeiden will, muss die Bestätigungen vorher gestaffelt erneuern lassen — am Feature
ändert es nichts.

## Reihenfolge (bindend)

1. **`landingpage`**: `FUEHRUNGSZEUGNIS`-Frist in `buildTrainerdatenSummary`, neuer Anlass,
   `scheduled`-Export, Merker-Datei, `ablauf-vorschau` — deployen
2. **Cron-Trigger** im Cloudflare-Dashboard bzw. per API setzen; `deploy-worker.ps1` um die
   Anzeige erweitern
3. **Trainerdaten** (Pages): `FUEHRUNGSZEUGNIS_GUELTIGKEIT_MONATE`, Badge am
   Führungszeugnis wie bei den anderen Nachweisen, Changelog-Block
4. **ToolsUebersicht** (Pages): `push: true` an der Trainerdaten-Kachel

Schritt 1 allein sendet noch nichts (ohne Trigger läuft nichts); Schritt 3 ist reine
Anzeige. Die Reihenfolge ist damit in beide Richtungen verträglich.

## Als erbracht gilt es erst, wenn

- `ablauf-vorschau` an den **echten Live-Daten** eine plausible Trefferliste liefert
  (gegen die Badges in der App gegengeprüft, nicht nur gegen sich selbst),
- ein Ablauf mit testweise gesetztem Datum eine echte Nachricht auf ein Gerät bringt,
- ein zweiter Lauf am selben Tag **nichts** sendet,
- und eine Neu-Einreichung die Erinnerung nachweislich beendet (`basis` wechselt).

## Nicht enthalten (bewusst)

- **Erinnerung an fehlende Nachweise** (nie eingereicht) — anderer Vorgang, andere
  Population, und für Import-Stubs ohne Konto gar nicht zustellbar
- **Eskalation an die Geschäftsstelle**, wenn niemand reagiert
- **Eine Mail als zweiter Weg** — siehe Begründung oben
- **Ablauf-Erinnerungen in anderen Apps der Flotte** — erst wenn diese läuft
- **Ein konfigurierbarer Vorwarn-Zeitraum** — 14 Tage stehen als Konstante im Code
