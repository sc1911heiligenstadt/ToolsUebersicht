// Pruefstand fuer den Uebertrag Fussballcamp -> Vereinskalender.
//
// ⚠️ Der Code wird AUS DER DATEI GEZOGEN, nicht nachgebaut. Findet die
// Extraktion ihre Marken nicht, bricht der Lauf ab statt gruen zu melden.
// Geprueft werden die ECHTEN Handler -- fcSession ist die einzige Attrappe, das
// Rechte-Gate fcVerlangeEdit/fcVerlangeAdmin laeuft echt.
//
// Beruehrt keine Live-Daten: readJson/writeJson arbeiten auf zwei Objekten im
// Speicher, eines je Datei-URL.
//
//   node pruef-kalender.mjs [pfad-zu-admin-worker.js]
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

// Ohne diese Marken prueft der Lauf nicht das, wofuer er gebaut ist.
for (const marke of [
  "function fcGehoertInKalender", "function fcKalenderEinarbeiten",
  "async function fcKalenderAbgleich", "async function fcKalenderLauf",
  "async function fcKalenderNachziehen", "function fcKalenderSchnappschuss",
  "FC_KALENDER_KATEGORIE", "FC_KALENDER_QUELLE"
]) {
  if (!fcQ.includes(marke)) throw new Error("ABBRUCH: " + marke + " fehlt im gezogenen Code.");
}
// Die Verdrahtung an den vier Handlern -- ohne sie liefe der Abgleich nie an.
for (const [handler, marke] of [
  ["Camp speichern", "antwort.kalender = await fcKalenderNachziehen(authHeader, antwort.schnappschuss);"],
  ["Statuswechsel",  "return { status: ziel, schnappschuss: fcKalenderSchnappschuss(camp) };"],
  ["Camp loeschen",  "fcKalenderNachziehen(authHeader, antwort.schnappschuss, { geloescht: true })"],
  ["Aufraeumen",     "return { geloescht: vorher, schnappschuss: fcKalenderSchnappschuss(camp) };"],
  ["Naechtlicher Lauf", "await fcKalenderLauf(authHeader);"]
]) {
  if (!fcQ.includes(marke)) throw new Error("ABBRUCH: Verdrahtung fehlt (" + handler + "): " + marke);
}
if (!QUELLE.includes("kalenderUebertragen: !!c.kalenderTerminId")) {
  throw new Error("ABBRUCH: handleFcLoad gibt den Kalender-Zustand nicht heraus.");
}

// ---- Attrappen -----------------------------------------------------------
const KAL_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Vereinskalender/vereinskalender.json";
let CAMPS = null;   // fussballcamp.json
let KAL = null;     // vereinskalender.json
let SCHREIBT = { camps: 0, kal: 0 };
let RECHT = { canEdit: true, canAdmin: true };

const kopf = `
class ConflictError extends Error {}
function json(obj, status, corsHeaders) { return { __json: obj, status }; }
const NOTIFY_FROM_EMAIL = "test@example.org";
const NOTIFY_FROM_NAME = "Test";
const USER_ART_SPIELER = "spieler";
const DAV_APPS = { vereinskalender: ${JSON.stringify(KAL_URL)} };
const jsonCache = new Map();
function aufgabenAnzeigeName() { return ""; }
async function getVerifiedSession() { return null; }
async function userMayAccessTool() { return true; }
async function resolveEditPermission() { return true; }
async function resolveAdminPermission() { return true; }
async function readJson(url, auth, fallback) { return JSON.parse(JSON.stringify(__LESE(url) ?? fallback)); }
async function readJsonWithRev(url, auth, fallback) { return { data: JSON.parse(JSON.stringify(__LESE(url) ?? fallback)), rev: "r1" }; }
async function writeJson(url, auth, doc, rev) { __SCHREIBE(url, JSON.parse(JSON.stringify(doc))); }
`;

// fcSession wird NACH dem gezogenen Code noch einmal deklariert und gewinnt
// damit -- alles andere am Rechteweg bleibt der echte Code.
const fuss = `
async function fcSession(request, env, authHeader, corsHeaders) {
  return { fehler: null, session: { username: "michel", usersDoc: {} },
           canEdit: __RECHT().canEdit, canAdmin: __RECHT().canAdmin };
}
return { fcLeer, fcNormalisiere, fcGehoertInKalender, fcKalenderEinarbeiten,
         fcKalenderAbgleich, fcKalenderLauf, fcKalenderNachziehen,
         fcKalenderSchnappschuss, fcKalenderNotiz, fcHeuteBerlin,
         handleFcCampSpeichern, handleFcCampStatus, handleFcCampLoeschen,
         handleFcAufraeumen, handleFcLoad, FC_KALENDER_KATEGORIE };
`;

const bau = new Function("__LESE", "__SCHREIBE", "__RECHT", "fetch", "crypto",
  kopf + capStrQ + "\n" + kboQ + "\n" + fcQ + "\n" + fuss
)(
  (url) => (url === KAL_URL ? KAL : CAMPS),
  (url, d) => { if (url === KAL_URL) { KAL = d; SCHREIBT.kal++; } else { CAMPS = d; SCHREIBT.camps++; } },
  () => RECHT,
  async () => ({ ok: true }),
  globalThis.crypto
);

// ---- Zusagen -------------------------------------------------------------
let gruen = 0, rot = 0;
function zusage(nr, text, bedingung) {
  if (bedingung) { gruen++; console.log("  ok  " + nr + " " + text); }
  else { rot++; console.log("  X   " + nr + " " + text); }
}
function abschnitt(t) { console.log("\n" + t); }

const heute = bau.fcHeuteBerlin();
const inTagen = (n) => new Date(Date.parse(heute + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

function frisch(camps) {
  CAMPS = bau.fcLeer();
  CAMPS.camps = camps.map((c) => Object.assign({
    id: "c1", token: "tok1", name: "Sommercamp", status: "offen",
    vonDatum: inTagen(30), bisDatum: inTagen(34),
    taeglichVon: "09:00", taeglichBis: "16:00", ort: "Sportplatz",
    jahrgangVon: 2014, jahrgangBis: 2018, kurzbeschreibung: "",
    plaetze: 20, preis: 5000, felder: {}, erstelltVon: "michel",
    anmeldungVon: "", anmeldungBis: "", tage: [], verlauf: [], anmeldungen: [],
    aufgeraeumtAm: ""
  }, c));
  bau.fcNormalisiere(CAMPS);
  KAL = { meta: {}, kategorien: [{ id: "veranstaltung", name: "Veranstaltung", farbe: "#2d8c4e" }], termine: [] };
  SCHREIBT = { camps: 0, kal: 0 };
  RECHT = { canEdit: true, canAdmin: true };
}
const camp = (id) => CAMPS.camps.find((c) => c.id === (id || "c1"));
const schnapp = (id) => bau.fcKalenderSchnappschuss(camp(id));
const termine = () => KAL.termine;
const anfrage = { headers: { get: () => null } };
const AUTH = "Basic x";

// =========================================================================
abschnitt("1. Wann ein Camp in den Kalender gehoert");
// =========================================================================
frisch([{ status: "entwurf" }]);
zusage(1.1, "Ein Entwurf gehoert nicht hinein", bau.fcGehoertInKalender(camp()) === false);
frisch([{ status: "offen" }]);
zusage(1.2, "Ein offenes Camp gehoert hinein", bau.fcGehoertInKalender(camp()) === true);
frisch([{ status: "geschlossen" }]);
zusage(1.3, "Ein geschlossenes Camp bleibt drin (es findet ja statt)", bau.fcGehoertInKalender(camp()) === true);
frisch([{ status: "offen", vonDatum: inTagen(-10), bisDatum: inTagen(-6) }]);
zusage(1.4, "Ein vergangenes Camp gehoert nicht hinein", bau.fcGehoertInKalender(camp()) === false);
frisch([{ status: "offen", vonDatum: inTagen(-2), bisDatum: heute }]);
zusage(1.5, "Ein Camp, das HEUTE endet, gehoert noch hinein", bau.fcGehoertInKalender(camp()) === true);
frisch([{ status: "abgeschlossen", aufgeraeumtAm: "2026-01-01T00:00:00Z" }]);
zusage(1.6, "Ein aufgeraeumtes Camp gehoert nicht hinein", bau.fcGehoertInKalender(camp()) === false);
frisch([{ status: "offen", vonDatum: "", bisDatum: "" }]);
zusage(1.7, "Ohne Datum kein Termin", bau.fcGehoertInKalender(camp()) === false);

// =========================================================================
abschnitt("2. Der Termin selbst");
// =========================================================================
frisch([{ status: "offen" }]);
await bau.fcKalenderNachziehen(AUTH, schnapp());
let t = termine()[0];
zusage(2.1, "Genau ein Termin angelegt", termine().length === 1);
zusage(2.2, "Titel ist der Camp-Name", t.titel === "Sommercamp");
zusage(2.3, "Datum ist der erste Camp-Tag", t.datum === inTagen(30));
zusage(2.4, "Enddatum ist der letzte Camp-Tag", t.endDatum === inTagen(34));
zusage(2.5, "Ort kommt mit", t.ort === "Sportplatz");
zusage(2.6, "Kategorie ist Veranstaltung", t.kategorie === bau.FC_KALENDER_KATEGORIE);
zusage(2.7, "Herkunft steht am Termin", t.quelle && t.quelle.app === "fussballcamp" && t.quelle.campId === "c1");
zusage(2.8, "Der Termin ist NIE privat", !t.privat);
zusage(2.9, "Die Termin-Id steht am Camp", camp().kalenderTerminId === t.id);
zusage(2.10, "Mehrtaegig: ganztags, keine Uhrzeit", t.ganztags === true && !t.startZeit && !t.endZeit);
zusage(2.11, "Die taegliche Zeit steht in der Notiz", /Täglich 09:00–16:00 Uhr/.test(t.notiz || ""));
zusage(2.12, "Die Jahrgaenge stehen in der Notiz", /Jahrgänge 2014 bis 2018/.test(t.notiz || ""));
zusage(2.13, "Der Anmeldelink steht in der Notiz", (t.notiz || "").includes("anmeldung.html?c=tok1"));

frisch([{ status: "offen", vonDatum: inTagen(20), bisDatum: inTagen(20) }]);
await bau.fcKalenderNachziehen(AUTH, schnapp());
t = termine()[0];
zusage(2.14, "Eintaegig: mit Uhrzeit statt ganztags", t.ganztags === false && t.startZeit === "09:00" && t.endZeit === "16:00");
zusage(2.15, "Eintaegig: kein Enddatum", !t.endDatum);
zusage(2.16, "Eintaegig: Notiz ohne das Wort Täglich", !/Täglich/.test(t.notiz || "") && /09:00–16:00 Uhr/.test(t.notiz || ""));

frisch([{ status: "geschlossen" }]);
await bau.fcKalenderNachziehen(AUTH, schnapp());
zusage(2.17, "Geschlossen: KEIN Anmeldelink in der Notiz", !(termine()[0].notiz || "").includes("anmeldung.html"));

// =========================================================================
abschnitt("3. Nachziehen, Herausnehmen, nicht wieder anlegen");
// =========================================================================
frisch([{ status: "offen" }]);
await bau.fcKalenderNachziehen(AUTH, schnapp());
const idVorher = termine()[0].id;
camp().name = "Herbstcamp";
camp().ort = "Halle";
await bau.fcKalenderNachziehen(AUTH, schnapp());
zusage(3.1, "Aenderung zieht nach, ohne einen zweiten Termin", termine().length === 1 && termine()[0].titel === "Herbstcamp");
zusage(3.2, "Es bleibt derselbe Termin (gleiche Id)", termine()[0].id === idVorher);
zusage(3.3, "Der geaenderte Ort kommt mit", termine()[0].ort === "Halle");

let schreibVorher = SCHREIBT.kal;
await bau.fcKalenderNachziehen(AUTH, schnapp());
zusage(3.4, "Ein Abgleich ohne Aenderung schreibt die fremde Datei NICHT", SCHREIBT.kal === schreibVorher);

camp().status = "entwurf";
await bau.fcKalenderNachziehen(AUTH, schnapp());
zusage(3.5, "Zurueck auf Entwurf nimmt den Termin heraus", termine().length === 0);
zusage(3.6, "Und raeumt die Id am Camp weg", !camp().kalenderTerminId);

camp().status = "offen";
await bau.fcKalenderNachziehen(AUTH, schnapp());
zusage(3.7, "Wieder oeffnen legt ihn erneut an", termine().length === 1);

// Von Hand im Kalender geloescht: Id bleibt am Camp stehen.
KAL.termine = [];
await bau.fcKalenderNachziehen(AUTH, schnapp());
zusage(3.8, "Von Hand geloescht: wird NICHT wieder angelegt", termine().length === 0);
zusage(3.9, "Und die Id bleibt am Camp stehen", !!camp().kalenderTerminId);

frisch([{ status: "entwurf" }]);
schreibVorher = SCHREIBT.kal;
await bau.fcKalenderNachziehen(AUTH, schnapp());
zusage(3.10, "Ein nie uebertragener Entwurf fasst die fremde Datei nie an", SCHREIBT.kal === schreibVorher && termine().length === 0);

// =========================================================================
abschnitt("4. Zwei Camps, gleicher Name");
// =========================================================================
frisch([
  { id: "c1", token: "t1", name: "Sommercamp" },
  { id: "c2", token: "t2", name: "Sommercamp", vonDatum: inTagen(60), bisDatum: inTagen(64) }
]);
await bau.fcKalenderNachziehen(AUTH, schnapp("c1"));
await bau.fcKalenderNachziehen(AUTH, schnapp("c2"));
zusage(4.1, "Zwei gleichnamige Camps ergeben ZWEI Termine", termine().length === 2);
zusage(4.2, "Jedes Camp haelt seine eigene Termin-Id",
  camp("c1").kalenderTerminId && camp("c2").kalenderTerminId &&
  camp("c1").kalenderTerminId !== camp("c2").kalenderTerminId);
camp("c1").ort = "Nur hier";
await bau.fcKalenderNachziehen(AUTH, schnapp("c1"));
const zuC2 = termine().find((x) => x.quelle.campId === "c2");
// ⚠️ Nicht auf "leer" pruefen — c2 hat einen eigenen Ort. Geprueft wird, dass
// er UNVERAENDERT bei seinem eigenen Wert steht, nicht bei dem von c1.
zusage(4.3, "Eine Aenderung an c1 fasst den Termin von c2 nicht an",
  zuC2.ort === "Sportplatz" && zuC2.titel === "Sommercamp");

// =========================================================================
abschnitt("5. Was im Kalender bleiben darf");
// =========================================================================
frisch([{ status: "offen" }]);
await bau.fcKalenderNachziehen(AUTH, schnapp());
t = termine()[0];
t.kategorie = "training";
t.anhaenge = [{ id: "a1", name: "Ablauf.pdf", mime: "application/pdf", size: 10 }];
camp().name = "Neuer Name";
await bau.fcKalenderNachziehen(AUTH, schnapp());
t = termine()[0];
zusage(5.1, "Eine im Kalender geaenderte Kategorie bleibt", t.kategorie === "training");
zusage(5.2, "Anhaenge bleiben", Array.isArray(t.anhaenge) && t.anhaenge.length === 1);
zusage(5.3, "Der Titel wird dagegen ueberschrieben", t.titel === "Neuer Name");

// =========================================================================
abschnitt("6. Die echten Handler");
// =========================================================================
frisch([{ status: "entwurf" }]);
let r = await bau.handleFcCampStatus(anfrage, { id: "c1", status: "offen" }, {}, AUTH, {});
zusage(6.1, "Anmeldung oeffnen legt den Termin an", termine().length === 1);
zusage(6.2, "Und meldet das dem Client", r.__json.kalender === "angelegt");

r = await bau.handleFcCampStatus(anfrage, { id: "c1", status: "entwurf" }, {}, AUTH, {});
zusage(6.3, "Zurueck auf Entwurf nimmt ihn heraus", termine().length === 0 && r.__json.kalender === "entfernt");

frisch([{ status: "offen" }]);
await bau.fcKalenderNachziehen(AUTH, schnapp());
r = await bau.handleFcCampSpeichern(anfrage, { camp: {
  id: "c1", name: "Umbenannt", vonDatum: inTagen(30), bisDatum: inTagen(34),
  taeglichVon: "10:00", taeglichBis: "15:00", ort: "Neuer Platz", plaetze: 20, felder: {}
} }, {}, AUTH, {});
zusage(6.4, "Camp speichern zieht den Termin nach", termine()[0].titel === "Umbenannt" && termine()[0].ort === "Neuer Platz");
zusage(6.5, "Und meldet den Zustand", r.__json.kalender === "aktualisiert");
zusage(6.6, "Der Schnappschuss geht NICHT an den Client", !("schnappschuss" in r.__json));

frisch([{ status: "offen" }]);
await bau.fcKalenderNachziehen(AUTH, schnapp());
r = await bau.handleFcCampLoeschen(anfrage, { id: "c1" }, {}, AUTH, {});
zusage(6.7, "Camp loeschen nimmt den Termin mit", termine().length === 0);
zusage(6.8, "Und meldet es", r.__json.kalender === "entfernt");

frisch([{ status: "offen" }]);
RECHT = { canEdit: false, canAdmin: false };
r = await bau.handleFcCampStatus(anfrage, { id: "c1", status: "geschlossen" }, {}, AUTH, {});
zusage(6.9, "Ohne Bearbeiten-Recht kein Statuswechsel und kein Termin",
  r.status === 403 && termine().length === 0);

// =========================================================================
abschnitt("7. Der Lauf ueber alle Camps");
// =========================================================================
frisch([
  { id: "c1", token: "t1", name: "Altbestand offen" },
  { id: "c2", token: "t2", name: "Entwurf", status: "entwurf" },
  { id: "c3", token: "t3", name: "Vorbei", vonDatum: inTagen(-9), bisDatum: inTagen(-5) }
]);
let lauf = await bau.fcKalenderLauf(AUTH);
zusage(7.1, "Der Lauf prueft alle Camps", lauf.geprueft === 3);
zusage(7.2, "Nur das anstehende Camp kommt in den Kalender", termine().length === 1 && termine()[0].titel === "Altbestand offen");
zusage(7.3, "Die Id landet am richtigen Camp", !!camp("c1").kalenderTerminId && !camp("c2").kalenderTerminId && !camp("c3").kalenderTerminId);

schreibVorher = SCHREIBT.kal;
const campsVorher = SCHREIBT.camps;
lauf = await bau.fcKalenderLauf(AUTH);
zusage(7.4, "Ein zweiter Lauf ohne Aenderung schreibt gar nichts",
  SCHREIBT.kal === schreibVorher && SCHREIBT.camps === campsVorher && lauf.geaendert === 0);

// Ein Camp laeuft ueber Nacht ab.
camp("c1").vonDatum = inTagen(-6);
camp("c1").bisDatum = inTagen(-2);
lauf = await bau.fcKalenderLauf(AUTH);
zusage(7.5, "Ein ueber Nacht abgelaufenes Camp fliegt heraus", termine().length === 0);
zusage(7.6, "Und die Id am Camp wird geraeumt", !camp("c1").kalenderTerminId);

// =========================================================================
abschnitt("8. Ein Fehler am Kalender kostet die Camp-Aenderung nicht");
// =========================================================================
frisch([{ status: "entwurf" }]);
const echtSchreibe = KAL;
// Kalender-Datei kaputt: jeder Schreibversuch scheitert.
const bauKaputt = new Function("__LESE", "__SCHREIBE", "__RECHT", "fetch", "crypto",
  kopf.replace("__SCHREIBE(url, JSON.parse(JSON.stringify(doc)));",
    "if (url === DAV_APPS.vereinskalender) throw new Error('Nextcloud klemmt'); __SCHREIBE(url, JSON.parse(JSON.stringify(doc)));")
  + capStrQ + "\n" + kboQ + "\n" + fcQ + "\n" + fuss
)(
  (url) => (url === KAL_URL ? KAL : CAMPS),
  (url, d) => { if (url === KAL_URL) { KAL = d; } else { CAMPS = d; } },
  () => RECHT,
  async () => ({ ok: true }),
  globalThis.crypto
);
r = await bauKaputt.handleFcCampStatus(anfrage, { id: "c1", status: "offen" }, {}, AUTH, {});
zusage(8.1, "Der Statuswechsel selbst gelingt trotzdem", r.status === 200 && camp().status === "offen");
zusage(8.2, "Der ausgebliebene Uebertrag wird GEMELDET, nicht verschwiegen", r.__json.kalender === "fehler");
zusage(8.3, "Und es steht keine falsche Id am Camp", !camp().kalenderTerminId);
void echtSchreibe;

// =========================================================================
abschnitt("9. Was der Load herausgibt");
// =========================================================================
frisch([{ status: "offen" }]);
await bau.fcKalenderNachziehen(AUTH, schnapp());
r = await bau.handleFcLoad(anfrage, {}, AUTH, {});
let sicht = r.__json.camps[0];
zusage(9.1, "Der Load meldet den Uebertrag", sicht.kalenderUebertragen === true && sicht.kalenderSoll === true);
zusage(9.2, "Die Termin-Id selbst geht NICHT an den Client", !("kalenderTerminId" in sicht));

frisch([{ status: "entwurf" }]);
r = await bau.handleFcLoad(anfrage, {}, AUTH, {});
sicht = r.__json.camps[0];
zusage(9.3, "Ein Entwurf meldet beides als nein", sicht.kalenderUebertragen === false && sicht.kalenderSoll === false);

// =========================================================================
console.log("\n" + "=".repeat(60));
console.log(gruen + " von " + (gruen + rot) + " Zusagen erfuellt.");
if (rot) { console.log(rot + " ROT."); process.exit(1); }
