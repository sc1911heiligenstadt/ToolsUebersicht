// Pruefstand: der Meldekasten muss sagen, WAS die Eltern geaendert haben.
//
// ⚠️ Der Code wird AUS DER DATEI GEZOGEN. Fehlt eine Marke, bricht der Lauf ab
// statt gruen zu melden.
//
//   node pruef-aenderung.mjs [pfad-zu-admin-worker.js]
import { readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HIER = dirname(fileURLToPath(import.meta.url));
// Ohne Argument die Datei nebenan; mit Argument eine andere Fassung — so lässt
// sich auch prüfen, was in einem Commit steht, ohne das Arbeitsverzeichnis
// anzufassen (auf E:\ laufen mehrere Sitzungen auf denselben Repos).
const PFAD = process.argv[2] || join(HIER, "admin-worker.js");
const QUELLE = readFileSync(PFAD, "utf8").replace(/\r\n/g, "\n");

function schneide(vonMarke, bisMarke, name) {
  const a = QUELLE.indexOf(vonMarke);
  if (a < 0) throw new Error("ABBRUCH: Startmarke fuer " + name + " nicht gefunden: " + vonMarke);
  const b = bisMarke === null ? QUELLE.length : QUELLE.indexOf(bisMarke, a);
  if (b < 0) throw new Error("ABBRUCH: Endmarke fuer " + name + " nicht gefunden: " + bisMarke);
  return QUELLE.slice(a, b);
}

const capStrQ = schneide("function capStr(v, max) {", "\n}\n", "capStr") + "\n}\n";
const kboQ    = schneide("function kboBremse(map, max, request) {", "function kboNormalize(", "kboBremse/kboHexToken");
const fcQ     = schneide("const FUSSBALLCAMP_URL =", null, "Fussballcamp-Abschnitt");

for (const marke of [
  "anmeldung.elternAenderungFelder = geaendert;",
  "if (agbNeuBestaetigt) geaendert.push(\"agb\");",
  "a.elternAenderungFelder = [];"
]) {
  if (!fcQ.includes(marke)) throw new Error("ABBRUCH: " + marke + " fehlt im gezogenen Code.");
}
// Der Client muss die Feldliste ueberhaupt bekommen -- sie haengt an der Anmeldung,
// und die geht nur mit Bearbeiten-Recht heraus.
if (!QUELLE.includes("token: undefined")) throw new Error("ABBRUCH: handleFcLoad-Marke fehlt.");

// ---- Attrappen -----------------------------------------------------------
let DOC = null;
let RECHT = { canEdit: true, canAdmin: true };

const kopf = `
class ConflictError extends Error {}
function json(obj, status, corsHeaders) { return { __json: obj, status }; }
const NOTIFY_FROM_EMAIL = "test@example.org";
const NOTIFY_FROM_NAME = "Test";
const USER_ART_SPIELER = "spieler";
const DAV_APPS = { vereinskalender: "https://example.invalid/vereinskalender.json" };
const jsonCache = new Map();
function aufgabenAnzeigeName() { return ""; }
async function getVerifiedSession() { return null; }
async function userMayAccessTool() { return true; }
async function resolveEditPermission() { return true; }
async function resolveAdminPermission() { return true; }
async function readJson(url, auth, fallback) { return JSON.parse(JSON.stringify(__DOC() ?? fallback)); }
async function readJsonWithRev(url, auth, fallback) { return { data: JSON.parse(JSON.stringify(__DOC() ?? fallback)), rev: "r1" }; }
async function writeJson(url, auth, doc, rev) { __SETDOC(JSON.parse(JSON.stringify(doc))); }
`;

const fuss = `
async function fcSession(request, env, authHeader, corsHeaders) {
  return { fehler: null, session: { username: "michel", usersDoc: {} },
           canEdit: __RECHT().canEdit, canAdmin: __RECHT().canAdmin };
}
// Der Kalender-Abgleich haengt an einer fremden Datei, die es hier nicht gibt.
// Er ist NICHT Gegenstand dieses Laufs -- pruef-kalender.mjs deckt ihn ab.
async function fcKalenderNachziehen() { return "unveraendert"; }
return { fcLeer, fcNormalisiere, handleFcMeineSpeichern, handleFcMeineAbsagen,
         handleFcAnmeldungSpeichern, handleFcAbsagen, handleFcGesehen, handleFcLoad };
`;

const bau = new Function("__DOC", "__SETDOC", "__RECHT", "fetch", "crypto",
  kopf + capStrQ + "\n" + kboQ + "\n" + fcQ + "\n" + fuss
)(
  () => DOC, (d) => { DOC = d; }, () => RECHT,
  async () => ({ ok: true }), globalThis.crypto
);

// ---- Zusagen -------------------------------------------------------------
let gruen = 0, rot = 0;
function zusage(nr, text, bedingung) {
  if (bedingung) { gruen++; console.log("  ok  " + nr + " " + text); }
  else { rot++; console.log("  X   " + nr + " " + text); }
}
function abschnitt(t) { console.log("\n" + t); }

const AUTH = "Basic x";
const ENV = {};
let ipZaehler = 0;
// ⚠️ Je Aufruf eine andere IP: die echte Schreibbremse laeuft mit und wuerde den
// Lauf sonst nach 20 Aenderungen mit 429 abwuergen -- und das saehe aus wie ein
// Fehler im geprueften Code.
const anfrage = () => ({ headers: { get: (h) => (h === "CF-Connecting-IP" ? "10.0.0." + (++ipZaehler) : null) } });

function frisch(anmeldungExtra, campExtra) {
  DOC = bau.fcLeer();
  DOC.einstellungen.iban = "DE02120300000000202051";
  DOC.einstellungen.agbText = "Bedingungen";
  DOC.einstellungen.agbStand = "stand-1";
  DOC.camps.push(Object.assign({
    id: "c1", token: "tok1", name: "Herbstcamp 2026", status: "offen",
    vonDatum: "2026-12-01", bisDatum: "2026-12-05",
    taeglichVon: "09:00", taeglichBis: "16:00", ort: "Sportplatz",
    plaetze: 20, preis: 5000, zusatzfrage: "",
    felder: { elternTelefon: "optional", allergien: "pflicht", trikotgroesse: "optional", vegetarisch: "optional" },
    anmeldungVon: "", anmeldungBis: "", tage: [], verlauf: [],
    anmeldungen: [Object.assign({
      id: "a1", token: "elterntok", nummer: 1, status: "angemeldet", bezahlt: false,
      kindVorname: "Gracjan", kindNachname: "Jozwiak",
      elternName: "Anna Jozwiak", elternEmail: "anna@example.org",
      elternTelefon: "0170 1234567", allergienHat: "ja", allergien: "Erdnuss",
      agbStand: "stand-1", agbAm: "2026-08-01T10:00:00Z",
      erstelltAm: "2026-08-01T10:00:00Z", geaendertAm: "", elternAenderung: "", absageGrund: ""
    }, anmeldungExtra || {})]
  }, campExtra || {}));
  bau.fcNormalisiere(DOC);
}
const anm = () => DOC.camps[0].anmeldungen[0];
const camp = () => DOC.camps[0];
// Die vollen Daten, wie sie die Aenderungsseite immer mitschickt.
const daten = (aenderung) => Object.assign({
  kindVorname: "Gracjan", kindNachname: "Jozwiak",
  elternName: "Anna Jozwiak", elternEmail: "anna@example.org",
  elternTelefon: "0170 1234567", allergienHat: "ja", allergien: "Erdnuss"
}, aenderung || {});

// =========================================================================
abschnitt("1. Was die Eltern geaendert haben");
// =========================================================================
frisch();
let r = await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten({ elternTelefon: "0171 9999999" }) }, ENV, AUTH, {});
zusage(1.1, "Gespeichert", r.status === 200);
zusage(1.2, "Genau das eine geaenderte Feld ist vermerkt",
  JSON.stringify(anm().elternAenderungFelder) === JSON.stringify(["elternTelefon"]));
zusage(1.3, "Die Markierung steht wie bisher", anm().elternAenderung === "geaendert");

frisch();
await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok",
  daten: daten({ elternTelefon: "0171 9999999", allergien: "Erdnuss, Laktose" }) }, ENV, AUTH, {});
zusage(1.4, "Zwei geaenderte Felder, beide vermerkt",
  JSON.stringify(anm().elternAenderungFelder.slice().sort()) === JSON.stringify(["allergien", "elternTelefon"]));

frisch();
await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten({ trikotgroesse: "140" }) }, ENV, AUTH, {});
zusage(1.5, "Ein vorher LEERES Feld, das gefuellt wird, zaehlt",
  anm().elternAenderungFelder.includes("trikotgroesse"));

frisch();
await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten({ vegetarisch: true }) }, ENV, AUTH, {});
zusage(1.6, "Ein Haken von nein auf ja zaehlt", anm().elternAenderungFelder.includes("vegetarisch"));

// =========================================================================
abschnitt("2. Kein Laerm, wenn nichts anders ist");
// =========================================================================
frisch();
r = await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten() }, ENV, AUTH, {});
zusage(2.1, "Unveraendertes Speichern gelingt trotzdem", r.status === 200);
zusage(2.2, "…meldet aber KEINE Aenderung", anm().elternAenderung === "");
zusage(2.3, "…und schreibt keinen Verlaufseintrag", (camp().verlauf || []).length === 0);
zusage(2.4, "…sagt dem Client, dass nichts anders war", r.__json.geaendert === 0);
zusage(2.5, "…haelt geaendertAm trotzdem nach", !!anm().geaendertAm);

// ⚠️ Negativ-Kontrolle: liefe der Test gegen eine App, die gar nichts speichert,
// waere 2.2 auch gruen. Deshalb hart pruefen, dass der Weg ueberhaupt wirkt.
frisch();
await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten({ elternTelefon: "0171 000" }) }, ENV, AUTH, {});
zusage(2.6, "Gegenprobe: eine ECHTE Aenderung kommt sehr wohl an",
  anm().elternTelefon === "0171 000" && anm().elternAenderung === "geaendert");

// =========================================================================
abschnitt("3. Der alte Wert wird NICHT aufbewahrt");
// =========================================================================
frisch();
await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok",
  daten: daten({ allergien: "Neu: Nussallergie" }) }, ENV, AUTH, {});
const alsText = JSON.stringify(DOC);
zusage(3.1, "Der ALTE Allergie-Wert steht nirgends mehr in der Datei", !alsText.includes("Erdnuss"));
zusage(3.2, "Vermerkt ist nur die Feld-Id", anm().elternAenderungFelder.every((x) => typeof x === "string" && x.length < 40));
zusage(3.3, "Der Verlauf traegt KEINE Feldnamen",
  !JSON.stringify(camp().verlauf).includes("allergien"));
zusage(3.4, "Der Verlauf traegt auch keinen Kindernamen",
  !JSON.stringify(camp().verlauf).includes("Gracjan"));

// =========================================================================
abschnitt("4. Zusatzfrage und Teilnahmebedingungen");
// =========================================================================
frisch({ zusatzantwort: "nein" }, { zusatzfrage: "Fährt das Kind im Bus mit?" });
await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok",
  daten: Object.assign(daten(), { zusatzantwort: "ja" }) }, ENV, AUTH, {});
zusage(4.1, "Eine geaenderte Zusatzantwort wird vermerkt", anm().elternAenderungFelder.includes("zusatzantwort"));

frisch({ agbStand: "stand-alt" });
r = await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten(),
  agb: true, agbStand: "stand-1" }, ENV, AUTH, {});
zusage(4.2, "Neu bestaetigte Bedingungen sind eine meldenswerte Aenderung",
  r.status === 200 && anm().elternAenderungFelder.includes("agb"));

frisch({ agbStand: "stand-alt" });
r = await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten() }, ENV, AUTH, {});
zusage(4.3, "Ohne frische Zustimmung wird weiterhin gar nicht gespeichert", r.status === 409);

// =========================================================================
abschnitt("5. Wann die Feldliste wieder weggeht");
// =========================================================================
frisch();
await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten({ elternTelefon: "0171 1" }) }, ENV, AUTH, {});
await bau.handleFcGesehen(anfrage(), { campId: "c1", anmeldungIds: ["a1"] }, ENV, AUTH, {});
zusage(5.1, "Zur Kenntnis genommen raeumt Markierung UND Feldliste",
  anm().elternAenderung === "" && JSON.stringify(anm().elternAenderungFelder) === "[]");

frisch();
await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten({ elternTelefon: "0171 2" }) }, ENV, AUTH, {});
// ⚠️ Der Handler liest `body.anmeldung`, nicht `body.felder` — mit dem falschen
// Schlüssel läuft er ins 404 und die Zusage misst gar nichts.
r = await bau.handleFcAnmeldungSpeichern(anfrage(), { campId: "c1", anmeldung: { id: "a1", notiz: "gesehen" } }, ENV, AUTH, {});
zusage(5.15, "Gegenprobe: das Verwaltungs-Speichern lief ueberhaupt durch", r.status === 200);
zusage(5.2, "Speichern durch die Verwaltung raeumt sie ebenso",
  anm().elternAenderung === "" && JSON.stringify(anm().elternAenderungFelder) === "[]");

frisch();
await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten({ elternTelefon: "0171 3" }) }, ENV, AUTH, {});
await bau.handleFcMeineAbsagen(anfrage(), { token: "elterntok" }, ENV, AUTH, {});
zusage(5.3, "Eine Absage setzt die Feldliste LEER, nicht die alte weiter",
  anm().elternAenderung === "abgesagt" && JSON.stringify(anm().elternAenderungFelder) === "[]");

// =========================================================================
abschnitt("6. Was der Client bekommt");
// =========================================================================
frisch();
await bau.handleFcMeineSpeichern(anfrage(), { token: "elterntok", daten: daten({ allergien: "Nuss" }) }, ENV, AUTH, {});
RECHT = { canEdit: true, canAdmin: true };
r = await bau.handleFcLoad(anfrage(), ENV, AUTH, {});
let a = r.__json.camps[0].anmeldungen[0];
zusage(6.1, "Mit Bearbeiten-Recht kommt die Feldliste mit",
  Array.isArray(a.elternAenderungFelder) && a.elternAenderungFelder.includes("allergien"));

RECHT = { canEdit: false, canAdmin: false };
r = await bau.handleFcLoad(anfrage(), ENV, AUTH, {});
zusage(6.2, "Ohne Bearbeiten-Recht fehlt die ganze Anmeldungsliste",
  !("anmeldungen" in r.__json.camps[0]));
// ⚠️ Die Zusage darueber allein reicht NICHT: sie prueft nur das eine Feld
// `anmeldungen`. Wer die Feldliste an anderer Stelle in die Camp-Sicht haengt,
// kaeme daran vorbei — genau das ist beim Mutationslauf durchgerutscht. Deshalb
// die ganze Antwort durchsuchen.
// ⚠️ Nicht auf den Feldnamen "allergien" prüfen — der steht als Formular-
// KONFIGURATION (camp.felder) zu Recht in jeder Antwort. Geprüft wird die
// Feldliste selbst und der eingetragene WERT.
zusage(6.3, "Ohne Bearbeiten-Recht steht NIRGENDS in der Antwort eine Feldliste",
  !JSON.stringify(r.__json).includes("elternAenderungFelder") &&
  !JSON.stringify(r.__json).includes("Nuss") &&
  !JSON.stringify(r.__json).includes("Gracjan"));

// =========================================================================
console.log("\n" + "=".repeat(60));
console.log(gruen + " von " + (gruen + rot) + " Zusagen erfuellt.");
if (rot) { console.log(rot + " ROT."); process.exit(1); }
