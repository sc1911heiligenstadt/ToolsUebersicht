// Pruefstand: Fruehbucherpreis bis Tag X, danach regulaer.
//
// ⚠️ Der Code wird AUS DER DATEI GEZOGEN. Fehlt eine Marke, bricht der Lauf ab.
//
//   node pruef-preis.mjs [pfad-zu-admin-worker.js]
import { readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HIER = dirname(fileURLToPath(import.meta.url));
// Ohne Argument die Datei nebenan; mit Argument eine andere Fassung — so lässt
// sich auch prüfen, was in einem Commit steht, ohne das Arbeitsverzeichnis
// anzufassen (auf E:\ laufen mehrere Sitzungen auf denselben Repos).
const PFAD = process.argv[2] || join(HIER, "admin-worker.js");
const QUELLE = readFileSync(PFAD, "utf8");

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
  "function fcPreisAmTag(camp, tag) {",
  "function fcBetrag(camp, a) {",
  "betrag: fcPreisAmTag(camp),",
  "camp.preisFrueh = fruehPreis;",
  "preisRegulaer: camp.preis || 0,"
]) {
  if (!fcQ.includes(marke)) throw new Error("ABBRUCH: " + marke + " fehlt im gezogenen Code.");
}

// ---- Attrappen -----------------------------------------------------------
let DOC = null;
let RECHT = { canEdit: true, canAdmin: true };
let MAILS = [];

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
async function fcKalenderNachziehen() { return "unveraendert"; }
return { fcLeer, fcNormalisiere, fcPreisAmTag, fcBetrag, fcHeuteBerlin, fcZahlungsBlock,
         handleFcCampSpeichern, handleFcAnmelden, handleFcMeineInfo, handleFcLoad,
         handleFcOeffentlich, handleFcAnmeldeInfo, handleFcAufraeumen, fcErinnerungslauf };
`;

const bau = new Function("__DOC", "__SETDOC", "__RECHT", "fetch", "crypto",
  kopf + capStrQ + "\n" + kboQ + "\n" + fcQ + "\n" + fuss
)(
  () => DOC, (d) => { DOC = d; }, () => RECHT,
  async (url, opt) => { try { MAILS.push(JSON.parse(opt.body)); } catch (_) {} return { ok: true }; },
  globalThis.crypto
);

// ---- Zusagen -------------------------------------------------------------
let gruen = 0, rot = 0;
function zusage(nr, text, bedingung) {
  if (bedingung) { gruen++; console.log("  ok  " + nr + " " + text); }
  else { rot++; console.log("  X   " + nr + " " + text); }
}
function abschnitt(t) { console.log("\n" + t); }

const AUTH = "Basic x";
const ENV = { BREVO_API_KEY: "k" };
let ipZaehler = 0;
// ⚠️ Je Aufruf eine andere IP -- die echte Schreibbremse laeuft mit.
const anfrage = () => ({ headers: { get: (h) => (h === "CF-Connecting-IP" ? "10.0.0." + (++ipZaehler) : null) } });

const heute = bau.fcHeuteBerlin();
const inTagen = (n) => new Date(Date.parse(heute + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

const REGULAER = 18000, FRUEH = 16000;

function frisch(campExtra, anmeldungen) {
  DOC = bau.fcLeer();
  DOC.einstellungen.iban = "DE02120300000000202051";
  DOC.einstellungen.kontoinhaber = "1. SC 1911 Heiligenstadt e.V.";
  DOC.einstellungen.agbText = "Bedingungen";
  DOC.einstellungen.agbStand = "stand-1";
  DOC.camps.push(Object.assign({
    id: "c1", token: "tok1", name: "Herbstcamp 2026", status: "offen",
    vonDatum: inTagen(60), bisDatum: inTagen(64),
    taeglichVon: "09:00", taeglichBis: "16:00", ort: "Sportplatz",
    plaetze: 20, preis: REGULAER, preisFrueh: FRUEH, preisFruehBis: inTagen(10),
    zusatzfrage: "", felder: { allergien: "pflicht", elternTelefon: "optional" },
    anmeldungVon: "", anmeldungBis: "", tage: [], verlauf: [],
    anmeldungen: anmeldungen || []
  }, campExtra || {}));
  bau.fcNormalisiere(DOC);
  MAILS = [];
  RECHT = { canEdit: true, canAdmin: true };
}
const camp = () => DOC.camps[0];
const anmKoerper = (nachname) => ({
  token: "tok1", datenschutz: true, agb: true, agbStand: "stand-1",
  daten: { kindVorname: "Lena", kindNachname: nachname || "Muster",
           elternName: "Anja Muster", elternEmail: (nachname || "muster").toLowerCase() + "@example.org",
           // ⚠️ Seit `janein_text` ist „keine“ keine Eingabe mehr, sondern die
           // Antwort „nein“ auf die Frage — der Text bleibt leer.
           allergienHat: "nein", allergien: "" }
});

// =========================================================================
abschnitt("1. Welcher Preis gilt wann");
// =========================================================================
frisch();
zusage(1.1, "Innerhalb des Fensters gilt der Fruehbucherpreis", bau.fcPreisAmTag(camp()) === FRUEH);
zusage(1.2, "Am Stichtag SELBST noch der Fruehbucherpreis", bau.fcPreisAmTag(camp(), inTagen(10)) === FRUEH);
zusage(1.3, "Am Tag danach der regulaere", bau.fcPreisAmTag(camp(), inTagen(11)) === REGULAER);

frisch({ preisFrueh: 0, preisFruehBis: "" });
zusage(1.4, "Ohne Fruehbucherpaar immer der regulaere", bau.fcPreisAmTag(camp()) === REGULAER);
frisch({ preisFrueh: FRUEH, preisFruehBis: "" });
zusage(1.5, "Preis ohne Stichtag bewirkt nichts", bau.fcPreisAmTag(camp()) === REGULAER);
frisch({ preisFrueh: 0, preisFruehBis: inTagen(10) });
zusage(1.6, "Stichtag ohne Preis bewirkt nichts", bau.fcPreisAmTag(camp()) === REGULAER);

// =========================================================================
abschnitt("2. Der Betrag wird beim Anmelden FESTGESCHRIEBEN");
// =========================================================================
frisch();
let r = await bau.handleFcAnmelden(anfrage(), anmKoerper(), ENV, AUTH, {}, null);
zusage(2.1, "Anmeldung gelingt", r.status === 200);
let a = camp().anmeldungen[0];
zusage(2.2, "Der Fruehbucherbetrag steht an der Anmeldung", a.betrag === FRUEH);
zusage(2.3, "Die Bestaetigung nennt denselben Betrag", r.__json.zahlung && r.__json.zahlung.betrag === FRUEH);

// ⚠️ Der Kern: Stichtag laeuft ab, die Anmeldung bleibt beim alten Betrag.
camp().preisFruehBis = inTagen(-1);
zusage(2.4, "Nach dem Stichtag kostet eine NEUE Anmeldung regulaer", bau.fcPreisAmTag(camp()) === REGULAER);
zusage(2.5, "Die alte Anmeldung schuldet weiterhin den Fruehbucherbetrag", bau.fcBetrag(camp(), a) === FRUEH);

r = await bau.handleFcAnmelden(anfrage(), anmKoerper("Zweit"), ENV, AUTH, {}, null);
const b = camp().anmeldungen[1];
zusage(2.6, "Die neue Anmeldung traegt den regulaeren Betrag", b.betrag === REGULAER);
zusage(2.7, "Beide stehen nebeneinander mit verschiedenen Betraegen",
  bau.fcBetrag(camp(), a) === FRUEH && bau.fcBetrag(camp(), b) === REGULAER);

// =========================================================================
abschnitt("3. Der Rueckfall fuer Altbestand");
// =========================================================================
frisch({}, [{ id: "alt", token: "t", nummer: 1, status: "angemeldet", bezahlt: false,
              kindVorname: "Alt", kindNachname: "Bestand", elternEmail: "alt@example.org",
              erstelltAm: "2026-08-01T10:00:00Z" }]);
zusage(3.1, "Eine Anmeldung ohne Betrag faellt auf den Camp-Preis zurueck",
  bau.fcBetrag(camp(), camp().anmeldungen[0]) === REGULAER);
zusage(3.2, "0 ist ein GUELTIGER Betrag, kein fehlender",
  bau.fcBetrag(camp(), { betrag: 0 }) === 0);
zusage(3.3, "null faellt zurueck, 0 nicht",
  bau.fcBetrag(camp(), { betrag: null }) === REGULAER && bau.fcBetrag(camp(), { betrag: 0 }) === 0);

// =========================================================================
abschnitt("4. Camp speichern: das Paar haelt zusammen");
// =========================================================================
frisch();
const campKoerper = (extra) => ({ camp: Object.assign({
  id: "c1", name: "Herbstcamp 2026", vonDatum: inTagen(60), bisDatum: inTagen(64),
  taeglichVon: "09:00", taeglichBis: "16:00", ort: "Sportplatz", plaetze: 20,
  preis: REGULAER, felder: {} }, extra || {}) });

r = await bau.handleFcCampSpeichern(anfrage(), campKoerper({ preisFrueh: FRUEH, preisFruehBis: inTagen(10) }), ENV, AUTH, {});
zusage(4.1, "Beide Angaben werden uebernommen",
  r.status === 200 && camp().preisFrueh === FRUEH && camp().preisFruehBis === inTagen(10));

r = await bau.handleFcCampSpeichern(anfrage(), campKoerper({ preisFrueh: FRUEH, preisFruehBis: "" }), ENV, AUTH, {});
zusage(4.2, "Preis ohne Stichtag: BEIDES faellt weg, kein halbes Paar",
  camp().preisFrueh === 0 && camp().preisFruehBis === "");

r = await bau.handleFcCampSpeichern(anfrage(), campKoerper({ preisFrueh: 0, preisFruehBis: inTagen(10) }), ENV, AUTH, {});
zusage(4.3, "Stichtag ohne Preis: ebenso", camp().preisFrueh === 0 && camp().preisFruehBis === "");

r = await bau.handleFcCampSpeichern(anfrage(), campKoerper({ preisFrueh: 20000, preisFruehBis: inTagen(10) }), ENV, AUTH, {});
zusage(4.4, "Ein Fruehbucherpreis UEBER dem regulaeren wird abgelehnt", r.status === 400);
r = await bau.handleFcCampSpeichern(anfrage(), campKoerper({ preisFrueh: REGULAER, preisFruehBis: inTagen(10) }), ENV, AUTH, {});
zusage(4.5, "Ein gleich hoher ebenfalls", r.status === 400);

// =========================================================================
abschnitt("5. Was nach draussen geht");
// =========================================================================
frisch();
r = await bau.handleFcOeffentlich(anfrage(), {}, ENV, AUTH, {});
let oc = r.__json.camps[0];
zusage(5.1, "Das Fenster zeigt den HEUTE gueltigen Preis", oc.preis === FRUEH);
zusage(5.2, "…und den regulaeren daneben", oc.preisRegulaer === REGULAER);
zusage(5.3, "…und bis wann", oc.preisFruehBis === inTagen(10));

frisch({ preisFrueh: 0, preisFruehBis: "" });
r = await bau.handleFcOeffentlich(anfrage(), {}, ENV, AUTH, {});
oc = r.__json.camps[0];
zusage(5.4, "Ohne Fruehbucher steht dort der regulaere und KEINE Frist",
  oc.preis === REGULAER && oc.preisFruehBis === "");

frisch();
r = await bau.handleFcAnmeldeInfo(anfrage(), { token: "tok1" }, ENV, AUTH, {});
zusage(5.5, "Die Anmeldeseite zeigt den heute gueltigen Preis", r.__json.camp.preis === FRUEH);
zusage(5.6, "…mit dem regulaeren zum Vergleich", r.__json.camp.preisRegulaer === REGULAER);
// ⚠️ handleFcAnmeldeInfo hat KEINEN Zahlungsblock — den gibt es erst nach dem
// Absenden. Was die Seite zeigt, kommt aus fcOeffentlicheSicht.
zusage(5.7, "…und bis wann der Frühbucherpreis gilt", r.__json.camp.preisFruehBis === inTagen(10));
camp().preisFruehBis = inTagen(-1);
r = await bau.handleFcAnmeldeInfo(anfrage(), { token: "tok1" }, ENV, AUTH, {});
zusage(5.8, "Nach dem Stichtag zeigt die Anmeldeseite den regulaeren Preis",
  r.__json.camp.preis === REGULAER);

// =========================================================================
abschnitt("6. Mail und Meine-Anmeldung");
// =========================================================================
frisch();
await bau.handleFcAnmelden(anfrage(), anmKoerper(), ENV, AUTH, {}, null);
a = camp().anmeldungen[0];
camp().preisFruehBis = inTagen(-1);   // Fenster zu
const block = bau.fcZahlungsBlock(camp(), a, DOC.einstellungen);
zusage(6.1, "Der Zahlungsblock nennt den festgeschriebenen Betrag", block.includes("160,00"));
zusage(6.2, "…und NICHT den inzwischen regulaeren", !block.includes("180,00"));

r = await bau.handleFcMeineInfo(anfrage(), { token: a.token }, ENV, AUTH, {});
zusage(6.3, "Meine Anmeldung zeigt den festgeschriebenen Betrag",
  r.__json.zahlung && r.__json.zahlung.betrag === FRUEH);
zusage(6.4, "Er steht auch an der Anmeldung selbst (fuer die Warteliste)",
  r.__json.anmeldung && r.__json.anmeldung.betrag === FRUEH);

// =========================================================================
abschnitt("7. Die Verwaltung");
// =========================================================================
frisch();
await bau.handleFcAnmelden(anfrage(), anmKoerper(), ENV, AUTH, {}, null);
r = await bau.handleFcLoad(anfrage(), ENV, AUTH, {});
let sicht = r.__json.camps[0];
zusage(7.1, "Der Load gibt den REGULAEREN Preis heraus", sicht.preis === REGULAER);
zusage(7.2, "…plus das Fruehbucherpaar roh", sicht.preisFrueh === FRUEH && sicht.preisFruehBis === inTagen(10));
zusage(7.3, "…plus den heute gueltigen", sicht.preisJetzt === FRUEH);
zusage(7.4, "Der Betrag steht an jeder Anmeldung", sicht.anmeldungen[0].betrag === FRUEH);

RECHT = { canEdit: false, canAdmin: false };
r = await bau.handleFcLoad(anfrage(), ENV, AUTH, {});
zusage(7.5, "Ohne Bearbeiten-Recht kommen die Betraege nicht mit",
  !("anmeldungen" in r.__json.camps[0]));

// =========================================================================
abschnitt("8. Aufraeumen und Erinnerung");
// =========================================================================
// ⚠️ Erst anmelden, DANN abschließen und zurückdatieren — ein abgeschlossenes
// Camp nimmt gar keine Anmeldung mehr an, und der Lauf hätte nichts zum Aufräumen.
frisch();
await bau.handleFcAnmelden(anfrage(), anmKoerper(), ENV, AUTH, {}, null);
camp().status = "abgeschlossen";
camp().vonDatum = inTagen(-400);
camp().bisDatum = inTagen(-396);
RECHT = { canEdit: true, canAdmin: true };
r = await bau.handleFcAufraeumen(anfrage(), { campId: "c1" }, ENV, AUTH, {});
zusage(8.1, "Aufraeumen gelingt", r.status === 200);
zusage(8.2, "Der Betrag ueberlebt das Aufraeumen (Zahl ohne Personenbezug)",
  camp().anmeldungen[0].betrag === FRUEH);
zusage(8.3, "Der Name ueberlebt es NICHT", !camp().anmeldungen[0].kindVorname);

// Kostenloser Platz bei einem Camp, das GELD kostet.
//
// ⚠️ Der Camp-Preis muss hier > 0 sein, sonst sind `camp.preis` und
// `fcBetrag()` derselbe Wert und die Zusage kann die beiden gar nicht
// auseinanderhalten — genau daran lief die Mutationsprobe zuerst ins Leere.
frisch({ preisFrueh: 0, preisFruehBis: "" });
DOC.einstellungen.zahlErinnerung = true;
DOC.einstellungen.zahlErinnerungTage = 1;
await bau.handleFcAnmelden(anfrage(), anmKoerper(), ENV, AUTH, {}, null);
camp().anmeldungen[0].erstelltAm = inTagen(-30) + "T10:00:00Z";
camp().anmeldungen[0].betrag = 0;   // Freiplatz, das Camp kostet weiterhin 180 €
MAILS = [];
await bau.fcErinnerungslauf(ENV, AUTH, "zahlung", "");
zusage(8.4, "Ein Freiplatz loest KEINE Zahlungserinnerung aus, obwohl das Camp Geld kostet",
  MAILS.length === 0);

// Gegenprobe: mit Betrag geht sie sehr wohl raus.
//
// ⚠️ Das Camp muss dafuer NAH liegen. Seit 2026-08-28 haengt die Erinnerung an
// ZWEI Bedingungen -- Tage seit der Anmeldung UND die Zahlfrist in Sichtweite.
// Mit dem Standard-Camp aus frisch() (Start in 60 Tagen) ist die Frist noch 53
// Tage hin, und die Erinnerung bleibt zu Recht aus. Die feste Verdrahtung auf
// das alte Verhalten stand genau hier; wer sie zurueckdreht, holt die
// Zahlungserinnerung Monate vor der Faelligkeit zurueck. Festgenagelt wird die
// neue Regel in pruef-camp-zahlerinnerung.mjs.
frisch({ preisFrueh: 0, preisFruehBis: "", vonDatum: inTagen(9), bisDatum: inTagen(13) });
DOC.einstellungen.zahlErinnerung = true;
DOC.einstellungen.zahlErinnerungTage = 1;
await bau.handleFcAnmelden(anfrage(), anmKoerper(), ENV, AUTH, {}, null);
camp().anmeldungen[0].erstelltAm = inTagen(-30) + "T10:00:00Z";
MAILS = [];
await bau.fcErinnerungslauf(ENV, AUTH, "zahlung", "");
zusage(8.5, "Gegenprobe: mit Betrag und naher Zahlfrist geht die Erinnerung raus", MAILS.length === 1);

// =========================================================================
console.log("\n" + "=".repeat(60));
console.log(gruen + " von " + (gruen + rot) + " Zusagen erfuellt.");
if (rot) { console.log(rot + " ROT."); process.exit(1); }
