// Pruefstand fuer die fuenf Erweiterungen vom 2026-09-03:
//
//   1. Anmeldeschluss schliesst das Camp von selbst
//   2. Konfektionsgroesse auf der Betreuer-Liste
//   3. Mail "Beitrag eingegangen" mit dem Tagesablauf
//   4. Feldspieler oder Torwart
//   5. Feedbackbogen nach dem Camp (anonym)
//
// ⚠️ Der Code wird AUS DER DATEI GEZOGEN und AUSGEFUEHRT, nicht nachgebaut.
// Fehlt eine Marke, bricht der Lauf ab -- ein Pruefstand, der seinen eigenen
// Nachbau prueft, sagt nichts ueber die App.
//
//   node pruef-camp-neu.mjs [pfad-zu-admin-worker.js]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HIER = dirname(fileURLToPath(import.meta.url));
const PFAD = process.argv[2] || join(HIER, "admin-worker.js");
const QUELLE = readFileSync(PFAD, "utf8");
// Ohne Vorgabe die App nebenan; mit FC_APP_DIR eine andere Fassung.
const APP = (process.env.FC_APP_DIR || join(HIER, "..", "fussballcamp")) + "/";
const CONFIGJS = readFileSync(APP + "config.js", "utf8");
const APPJS = readFileSync(APP + "app.js", "utf8");
const OEFFJS = readFileSync(APP + "oeffentlich.js", "utf8");
const FEEDBACKJS = readFileSync(APP + "feedback.js", "utf8");
const INDEXHTML = readFileSync(APP + "index.html", "utf8");
const FEEDBACKHTML = readFileSync(APP + "feedback.html", "utf8");

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

// ⚠️ Diese Marken nageln die VERDRAHTUNG fest, nicht das Verhalten. Ohne sie
// liefen die Zusagen unten gruen durch, waehrend der Lauf gar nicht mehr an der
// Nacht haengt -- und niemand merkte es, weil jede Funktion fuer sich stimmt.
for (const marke of [
  "await fcAutoSchliessenLauf(authHeader);",
  "await fcFeedbackLauf(env, authHeader, \"\");",
  "async function fcAutoSchliessenLauf(authHeader) {",
  "async function fcFeedbackLauf(env, authHeader, nurCampId) {",
  "async function fcBezahltMail(env, camp, a, einst) {",
  "const FC_FEEDBACK_FENSTER_TAGE",
  "case \"fussballcamp-feedback-info\":",
  "case \"fussballcamp-feedback-senden\":",
  // Mailvorlagen: die Verdrahtung, nicht der Wortlaut.
  "const FC_MAIL_VORLAGEN",
  "function fcMailBauen(einst, id, werte)",
  "fcMailVorlagenPruefen(roh.mailVorlagen)",
  "mailVorlagen: ctx.canAdmin ? fcMailVorlagenFuerAdmin(einst) : null"
]) {
  if (!QUELLE.includes(marke)) throw new Error("ABBRUCH: Marke fehlt im Worker: " + marke);
}

// ---- Attrappen -----------------------------------------------------------
let DOC = null;
let RECHT = { canEdit: true, canAdmin: true };
let MAILS = [];
let BETREUER_VON = null;   // null = fcIstBetreuer bleibt im Original

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
  return { fehler: null, session: { username: __RECHT().wer || "michel", usersDoc: {} },
           canEdit: __RECHT().canEdit, canAdmin: __RECHT().canAdmin };
}
async function fcKalenderNachziehen() { return "unveraendert"; }
return { fcLeer, fcNormalisiere, fcHeuteBerlin, fcTagPlusUtc,
         fcRollenAmCamp, fcRollePruefen, fcTorwartZahl,
         fcFeedbackPruefen, fcFeedbackAuswertung,
         fcAutoSchliessenLauf, fcFeedbackLauf, fcNaechtlicherLauf,
         handleFcAnmelden, handleFcAnmeldungSpeichern, handleFcTeilnehmer,
         handleFcCampSpeichern, handleFcLoad, handleFcAufraeumen,
         handleFcFeedbackInfo, handleFcFeedbackSenden, handleFcAbsagen, handleFcMeineInfo,
         fcFelderPruefen, FC_FELDER,
         handleFcEinstellungenSpeichern,
         fcMailBauen, fcMailVorlage, fcMailVorlagenPruefen, fcMailVorlagenFuerAdmin,
         FC_BETREUER_FELDER, FC_FEEDBACK_FRAGEN, FC_FEEDBACK_NOTEN,
         FC_FEEDBACK_FENSTER_TAGE, FC_FEEDBACK_TAGE_VORGABE, FC_ROLLEN,
         FC_MAIL_VORLAGEN, FC_MAIL_PLATZHALTER, FC_MAIL_BETREFF_FELDER };
`;

const bau = new Function("__DOC", "__SETDOC", "__RECHT", "fetch", "crypto",
  kopf + capStrQ + "\n" + kboQ + "\n" + fcQ + "\n" + fuss
)(
  () => DOC, (d) => { DOC = d; }, () => RECHT,
  async (url, opt) => { try { MAILS.push(JSON.parse(opt.body)); } catch (_) {} return { ok: true }; },
  globalThis.crypto
);

// ---- Client-Code laden und AUSFUEHREN --------------------------------------
//
// ⚠️ config.js und app.js werden GANZ geladen, wie im Browser, nur mit einer
// Attrappe fuer `document` -- app.js hat auf oberster Ebene nur den
// DOMContentLoaded-Horcher. So laeuft die echte Funktion, nicht ein Nachbau.
const docStub = {
  addEventListener() {}, getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }; },
  body: { appendChild() {}, removeChild() {} }
};
const CLIENT = new Function("document", "window", "localStorage", "navigator", "fetch",
  CONFIGJS + "\n" + APPJS + "\nreturn { istLeereAngabe, teilnehmerHinweise, LEERE_ANGABEN };"
)(docStub,
  { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1280, location: { href: "", search: "" } },
  { getItem: () => null, setItem() {}, removeItem() {} }, { userAgent: "node" },
  async () => { throw new Error("kein Netz im Pruefstand"); });

// ---- Zusagen -------------------------------------------------------------
let gruen = 0;
const funde = [];
function zusage(text, bedingung, detail) {
  if (bedingung) { gruen++; console.log("  ok  " + text); }
  else { funde.push({ text, detail }); console.log("  X   " + text + (detail ? "\n        " + detail : "")); }
}
function abschnitt(t) { console.log("\n" + t); }

const AUTH = "Basic x";
const ENV = { BREVO_API_KEY: "k" };
let ipZaehler = 0;
const anfrage = () => ({ headers: { get: (h) => (h === "CF-Connecting-IP" ? "10.0.0." + (++ipZaehler) : null) } });

const heute = bau.fcHeuteBerlin();
const inTagen = (n) => new Date(Date.parse(heute + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Ein frisches Dokument mit genau einem Camp.
function frisch(campExtra, anmeldungen) {
  DOC = bau.fcLeer();
  DOC.einstellungen.iban = "DE02120300000000202051";
  DOC.einstellungen.agbText = "Bedingungen";
  DOC.einstellungen.agbStand = "stand-1";
  const camp = Object.assign({
    id: "c1", token: "tok1", name: "Herbstcamp 2026", status: "offen",
    vonDatum: inTagen(30), bisDatum: inTagen(34),
    taeglichVon: "09:00", taeglichBis: "16:00", ort: "Sportplatz",
    plaetze: 20, preis: 18000, preisFrueh: 0, preisFruehBis: "",
    anmeldungVon: "", anmeldungBis: "",
    ablauf: "", fuerFeldspieler: true, fuerTorwart: false,
    felder: { geburtsdatum: "optional", trikotgroesse: "optional", elternTelefon: "optional",
              elternAnschrift: "optional", allergien: "optional" },
    tage: [], anmeldungen: [], verlauf: [], feedback: [], aufgeraeumtAm: ""
  }, campExtra || {});
  camp.anmeldungen = (anmeldungen || []).map((a, i) => Object.assign({
    id: "a" + (i + 1), token: "atok" + (i + 1), nummer: i + 1, status: "angemeldet",
    bezahlt: false, bezahltAm: "", bezahltVon: "", notiz: "",
    kindVorname: "Kind" + (i + 1), kindNachname: "Test",
    elternName: "Eltern", elternEmail: "eltern" + (i + 1) + "@example.org",
    elternAnschrift: "Musterweg 1", elternTelefon: "0170 1", trikotgroesse: "152",
    allergien: "", betrag: 18000, rolle: "feldspieler",
    erstelltAm: new Date().toISOString(), geaendertAm: "",
    agbStand: "stand-1", feedbackGebetenAm: "", feedbackAm: ""
  }, a));
  DOC.camps.push(camp);
  MAILS = [];
  return camp;
}
const camp0 = () => DOC.camps[0];
const anm0 = (i) => DOC.camps[0].anmeldungen[i || 0];

// =========================================================================
abschnitt("1. Der Anmeldeschluss schliesst das Camp von selbst");
// =========================================================================

frisch({ status: "offen", anmeldungBis: inTagen(-1) });
await bau.fcAutoSchliessenLauf(AUTH);
zusage("Frist gestern abgelaufen -> Status geschlossen", camp0().status === "geschlossen", camp0().status);
zusage("Der Verlauf haelt fest, dass es automatisch war",
  (camp0().verlauf || []).some((e) => e.was === "status" && e.von === "automatisch" && e.grund === "anmeldeschluss"),
  JSON.stringify(camp0().verlauf));

// ⚠️ Die Grenze ist EINSCHLIESSLICH: fcNimmtAn lehnt erst ab, wenn heute GROESSER
// als anmeldungBis ist. Schloesse der Lauf schon am Stichtag selbst, waere die
// Anmeldung einen Tag frueher zu als angekuendigt.
frisch({ status: "offen", anmeldungBis: heute });
await bau.fcAutoSchliessenLauf(AUTH);
zusage("Am Stichtag selbst bleibt das Camp offen", camp0().status === "offen", camp0().status);

frisch({ status: "offen", anmeldungBis: "" });
await bau.fcAutoSchliessenLauf(AUTH);
zusage("Camp ohne Anmeldeschluss bleibt offen", camp0().status === "offen");

frisch({ status: "entwurf", anmeldungBis: inTagen(-5) });
await bau.fcAutoSchliessenLauf(AUTH);
zusage("Ein Entwurf wird nicht geschlossen", camp0().status === "entwurf", camp0().status);

frisch({ status: "geschlossen", anmeldungBis: inTagen(-5) });
await bau.fcAutoSchliessenLauf(AUTH);
zusage("Ein schon geschlossenes Camp bekommt keinen zweiten Verlaufseintrag",
  camp0().status === "geschlossen" && (camp0().verlauf || []).length === 0);

frisch({ status: "offen", anmeldungBis: inTagen(-5), aufgeraeumtAm: new Date().toISOString() });
await bau.fcAutoSchliessenLauf(AUTH);
zusage("Ein aufgeraeumtes Camp bleibt unangetastet", camp0().status === "offen");

// ⚠️ Der Lauf darf nichts verschicken. Ein Statuswechsel ist keine Nachricht an
// die Eltern -- ginge hier eine Mail raus, bekaeme jede Familie eines
// abgelaufenen Camps nachts Post.
frisch({ status: "offen", anmeldungBis: inTagen(-1) }, [{}, {}]);
await bau.fcAutoSchliessenLauf(AUTH);
zusage("Das automatische Schliessen verschickt nichts", MAILS.length === 0, JSON.stringify(MAILS));

// =========================================================================
abschnitt("2. Konfektionsgroesse auf der Betreuer-Liste");
// =========================================================================

zusage("FC_BETREUER_FELDER traegt trikotgroesse", bau.FC_BETREUER_FELDER.includes("trikotgroesse"),
  JSON.stringify(bau.FC_BETREUER_FELDER));

// ⚠️ Die Liste steht DOPPELT (Worker wirksam, config.js nur Anzeige). Laufen sie
// auseinander, zeigt die App eine Spalte, die gar nicht ankommt -- oder
// umgekehrt gibt der Worker etwas heraus, das niemand erwartet.
const cBetreuer = JSON.parse((CONFIGJS.match(/const BETREUER_FELDER = (\[[^\]]*\])/) || [])[1] || "[]");
zusage("Worker- und config.js-Liste sind identisch",
  JSON.stringify(cBetreuer) === JSON.stringify(bau.FC_BETREUER_FELDER),
  "config: " + JSON.stringify(cBetreuer) + "\n        worker: " + JSON.stringify(bau.FC_BETREUER_FELDER));

frisch({}, [{ trikotgroesse: "140", rolle: "torwart" }]);
// Betreuer ohne Bearbeiten-Recht: das Gate ist "steht auf einer Aufgabe".
camp0().tage = [{ datum: inTagen(30), jobs: [{ id: "j1", besetzung: [{ username: "betreuer" }] }] }];
RECHT = { canEdit: false, canAdmin: false, wer: "betreuer" };
let r = await bau.handleFcTeilnehmer(anfrage(), { campId: "c1" }, ENV, AUTH, {});
const t0 = r.__json.teilnehmer[0];
zusage("Der Betreuer bekommt die Konfektionsgroesse", t0.trikotgroesse === "140", JSON.stringify(t0));
zusage("Der Betreuer bekommt die Ausrichtung", t0.rolle === "torwart", JSON.stringify(t0));
// ⚠️ Die Gegenprobe ist der eigentliche Datenschutz dieser Aktion.
zusage("Der Betreuer bekommt WEITERHIN keine Anschrift", t0.elternAnschrift === undefined);
zusage("Der Betreuer bekommt WEITERHIN keine E-Mail", t0.elternEmail === undefined);
zusage("Der Betreuer bekommt WEITERHIN keinen Beitragsstand",
  t0.bezahlt === undefined && t0.betrag === undefined);
zusage("Der Betreuer bekommt WEITERHIN keinen Aendern-Token", t0.token === undefined);
RECHT = { canEdit: true, canAdmin: true };

// =========================================================================
abschnitt("3. Mail 'Beitrag eingegangen' mit dem Tagesablauf");
// =========================================================================

const ABLAUF = "08:30 Ankunft\n09:00 Training\n12:00 Mittagessen";
frisch({ ablauf: ABLAUF }, [{}]);
r = await bau.handleFcAnmeldungSpeichern(anfrage(), { campId: "c1", anmeldung: { id: "a1", bezahlt: true } }, ENV, AUTH, {});
zusage("Haken auf bezahlt -> genau eine Mail", MAILS.length === 1, JSON.stringify(MAILS.map((m) => m.subject)));
zusage("Betreff nennt das Camp", MAILS[0] && /Beitrag eingegangen: Herbstcamp 2026/.test(MAILS[0].subject), MAILS[0] && MAILS[0].subject);
zusage("Die Mail traegt den Ablauf", MAILS[0] && MAILS[0].textContent.includes(ABLAUF));
zusage("Die Mail nennt den Betrag", MAILS[0] && MAILS[0].textContent.includes("180,00 €"));
zusage("Die Mail geht an die Eltern", MAILS[0] && MAILS[0].to[0].email === "eltern1@example.org");
zusage("bezahltMailAm ist vermerkt", !!anm0().bezahltMailAm, anm0().bezahltMailAm);

// ⚠️ Der Haken laesst sich beliebig oft hin und her stellen (Korrektur einer
// Fehlbuchung). Jedes Mal eine Mail hiesse, der Familie dreimal dieselbe
// Zahlung zu bestaetigen.
MAILS = [];
await bau.handleFcAnmeldungSpeichern(anfrage(), { campId: "c1", anmeldung: { id: "a1", bezahlt: false } }, ENV, AUTH, {});
zusage("Haken zuruecknehmen verschickt nichts", MAILS.length === 0);
await bau.handleFcAnmeldungSpeichern(anfrage(), { campId: "c1", anmeldung: { id: "a1", bezahlt: true } }, ENV, AUTH, {});
zusage("Zweites Setzen verschickt KEINE zweite Mail", MAILS.length === 0, JSON.stringify(MAILS.map((m) => m.subject)));

frisch({ ablauf: "" }, [{}]);
await bau.handleFcAnmeldungSpeichern(anfrage(), { campId: "c1", anmeldung: { id: "a1", bezahlt: true } }, ENV, AUTH, {});
zusage("Camp ohne Ablauf: die Mail geht trotzdem raus", MAILS.length === 1);
zusage("...und traegt keine leere Ablauf-Ueberschrift",
  MAILS[0] && !MAILS[0].textContent.includes("So läuft das Camp ab"), MAILS[0] && MAILS[0].textContent.slice(0, 400));

frisch({}, [{ bezahlt: true, bezahltAm: heute }]);
await bau.handleFcAnmeldungSpeichern(anfrage(), { campId: "c1", anmeldung: { id: "a1", bezahlt: false } }, ENV, AUTH, {});
zusage("Alte bezahlte Anmeldung ohne bezahltMailAm: Zuruecknehmen schickt KEINE Mail",
  MAILS.length === 0, JSON.stringify(MAILS.map((m) => m.subject)));

frisch({}, [{ status: "warteliste" }]);
await bau.handleFcAnmeldungSpeichern(anfrage(), { campId: "c1", anmeldung: { id: "a1", bezahlt: true } }, ENV, AUTH, {});
zusage("Warteliste: keine Mail (dort soll niemand ueberwiesen haben)", MAILS.length === 0);

frisch({}, [{ elternEmail: "" }]);
await bau.handleFcAnmeldungSpeichern(anfrage(), { campId: "c1", anmeldung: { id: "a1", bezahlt: true } }, ENV, AUTH, {});
zusage("Ohne hinterlegte Adresse: keine Mail, aber der Haken steht",
  MAILS.length === 0 && anm0().bezahlt === true);

// ⚠️ Der Ablauf wird beim SPEICHERN des Camps uebernommen -- ohne diesen Weg
// stuende er nie in der Datei, und alle Zusagen darueber liefen ins Leere.
frisch({}, []);
await bau.handleFcCampSpeichern(anfrage(), { camp: {
  id: "c1", name: "Herbstcamp 2026", vonDatum: inTagen(30), bisDatum: inTagen(34),
  plaetze: 20, ablauf: ABLAUF, fuerFeldspieler: true, fuerTorwart: false
} }, ENV, AUTH, {});
zusage("Camp speichern uebernimmt den Ablauf", camp0().ablauf === ABLAUF, camp0().ablauf);

// =========================================================================
abschnitt("4. Feldspieler oder Torwart");
// =========================================================================

zusage("fcRollenAmCamp: nur Feldspieler",
  JSON.stringify(bau.fcRollenAmCamp({ fuerFeldspieler: true, fuerTorwart: false })) === '["feldspieler"]');
zusage("fcRollenAmCamp: nur Torwart",
  JSON.stringify(bau.fcRollenAmCamp({ fuerFeldspieler: false, fuerTorwart: true })) === '["torwart"]');
zusage("fcRollenAmCamp: beides",
  JSON.stringify(bau.fcRollenAmCamp({ fuerFeldspieler: true, fuerTorwart: true })) === '["feldspieler","torwart"]');
// ⚠️ Ein Camp aus der Zeit vor diesen Feldern gilt als FELDSPIELER-Camp, nicht
// als "beides". Sonst bekaemen alle bestehenden Camps ueber Nacht eine
// Pflichtfrage, die ihre schon vorliegenden Anmeldungen nie beantwortet haben.
zusage("fcRollenAmCamp: Altbestand ohne Felder -> Feldspieler",
  JSON.stringify(bau.fcRollenAmCamp({})) === '["feldspieler"]');
zusage("fcNormalisiere macht den Altbestand ausdruecklich",
  (() => { const d = bau.fcLeer(); d.camps.push({ id: "x", status: "offen" }); bau.fcNormalisiere(d);
           return d.camps[0].fuerFeldspieler === true && d.camps[0].fuerTorwart === false; })());

async function melde(daten) {
  return bau.handleFcAnmelden(anfrage(), {
    token: "tok1", datenschutz: true, agb: true, agbStand: "stand-1",
    daten: Object.assign({ kindVorname: "Max", kindNachname: "Muster",
                           elternName: "Eltern", elternEmail: "e@example.org" }, daten || {})
  }, ENV, AUTH, {}, null);
}

frisch({ status: "offen", fuerFeldspieler: true, fuerTorwart: true }, []);
r = await melde({});
zusage("Camp mit beiden Ausrichtungen: ohne Angabe -> 400", r.status === 400, JSON.stringify(r.__json));
zusage("...und die Meldung nennt beide Begriffe",
  r.__json.error.includes("Feldspieler") && r.__json.error.includes("Torwart"), r.__json.error);
zusage("...und es entsteht KEINE halbe Anmeldung", camp0().anmeldungen.length === 0);

r = await melde({ rolle: "torwart" });
zusage("Camp mit beiden: rolle torwart wird uebernommen",
  r.status === 200 && camp0().anmeldungen[0].rolle === "torwart", JSON.stringify(r.__json));

// ⚠️ Der Client entscheidet NICHT mit: bei einem Camp mit nur einer Ausrichtung
// gilt sie, egal was mitgeschickt wird.
frisch({ status: "offen", fuerFeldspieler: true, fuerTorwart: false }, []);
r = await melde({ rolle: "torwart" });
zusage("Reines Feldspieler-Camp: mitgeschicktes 'torwart' wird verworfen",
  r.status === 200 && camp0().anmeldungen[0].rolle === "feldspieler", camp0().anmeldungen[0] && camp0().anmeldungen[0].rolle);

frisch({ status: "offen", fuerFeldspieler: false, fuerTorwart: true }, []);
r = await melde({});
zusage("Reines Torwartcamp: ohne Angabe wird 'torwart' gesetzt",
  r.status === 200 && camp0().anmeldungen[0].rolle === "torwart", camp0().anmeldungen[0] && camp0().anmeldungen[0].rolle);

frisch({}, []);
r = await bau.handleFcCampSpeichern(anfrage(), { camp: {
  id: "c1", name: "X", vonDatum: inTagen(3), bisDatum: inTagen(4), plaetze: 5,
  fuerFeldspieler: false, fuerTorwart: false
} }, ENV, AUTH, {});
zusage("Camp ohne jede Ausrichtung wird abgelehnt (400)", r.status === 400, JSON.stringify(r.__json));

// ⚠️ Ein aelterer Client schickt die Haken gar nicht mit -- dann darf die
// Ausrichtung eines bestehenden Camps nicht stillschweigend zurueckfallen.
frisch({ fuerFeldspieler: false, fuerTorwart: true }, []);
r = await bau.handleFcCampSpeichern(anfrage(), { camp: {
  id: "c1", name: "X", vonDatum: inTagen(3), bisDatum: inTagen(4), plaetze: 5
} }, ENV, AUTH, {});
// ⚠️ Der Statuscode gehoert dazu. Ohne ihn sieht eine ABGELEHNTE Speicherung
// (400) genauso aus wie eine gelungene, bei der die Ausrichtung stehenblieb --
// in beiden Faellen steht am Camp noch der alte Wert.
zusage("...und das Speichern gelingt ueberhaupt", r.status === 200, JSON.stringify(r.__json));
zusage("Fehlende Haken lassen die Ausrichtung stehen",
  camp0().fuerTorwart === true && camp0().fuerFeldspieler === false,
  JSON.stringify({ f: camp0().fuerFeldspieler, t: camp0().fuerTorwart }));

frisch({ fuerFeldspieler: true, fuerTorwart: true },
  [{ rolle: "torwart" }, { rolle: "torwart", status: "warteliste" }, { rolle: "feldspieler" }, { rolle: "torwart", status: "abgesagt" }]);
zusage("fcTorwartZahl zaehlt nur die ANGEMELDETEN Torhueter", bau.fcTorwartZahl(camp0()) === 1, String(bau.fcTorwartZahl(camp0())));
r = await bau.handleFcLoad(anfrage(), ENV, AUTH, {});
zusage("handleFcLoad liefert die Torwart-Zahl mit", r.__json.camps[0].torwarte === 1, String(r.__json.camps[0].torwarte));
zusage("handleFcLoad liefert die Ausrichtung mit",
  r.__json.camps[0].fuerFeldspieler === true && r.__json.camps[0].fuerTorwart === true);

// =========================================================================
abschnitt("5. Feedbackbogen: Versand");
// =========================================================================

// ⚠️ Aus ist aus. Der Bogen verschickt Post an Familien, deren Camp schon
// gelaufen ist -- das soll jemand bewusst einschalten.
frisch({ status: "abgeschlossen", vonDatum: inTagen(-8), bisDatum: inTagen(-4) }, [{}, {}]);
r = await bau.fcFeedbackLauf(ENV, AUTH, "");
zusage("Ausgeschaltet: nichts verschickt, und der Lauf sagt das auch",
  MAILS.length === 0 && r.aus === true, JSON.stringify(r));

DOC.einstellungen.feedbackAktiv = true;
DOC.einstellungen.feedbackTage = 2;
r = await bau.fcFeedbackLauf(ENV, AUTH, "");
zusage("Eingeschaltet, Camp vor 4 Tagen zu Ende: zwei Boegen", MAILS.length === 2, JSON.stringify(r));
zusage("Der Betreff fragt nach dem Camp", /Wie war das Herbstcamp 2026\?/.test(MAILS[0].subject), MAILS[0].subject);
zusage("Die Mail nennt die Anonymitaet ausdruecklich", MAILS[0].textContent.includes("anonym"));
zusage("Die Mail traegt den Feedback-Link mit dem Eltern-Token",
  MAILS[0].textContent.includes("feedback.html?a=atok1"), MAILS[0].textContent.slice(0, 500));
zusage("feedbackGebetenAm ist vermerkt", !!anm0().feedbackGebetenAm);

MAILS = [];
await bau.fcFeedbackLauf(ENV, AUTH, "");
zusage("Zweiter Lauf schickt nichts nach", MAILS.length === 0);

// ⚠️⚠️ Die OBERE Fenstergrenze -- der wichtigste Fall dieses Abschnitts. Ohne
// sie ginge in der Nacht, in der jemand den Haken das erste Mal setzt, an die
// Eltern JEDES je gelaufenen Camps eine Mail. Das ist der Fehler, den man genau
// einmal macht.
frisch({ status: "abgeschlossen", vonDatum: inTagen(-400), bisDatum: inTagen(-396) }, [{}, {}]);
DOC.einstellungen.feedbackAktiv = true;
DOC.einstellungen.feedbackTage = 2;
await bau.fcFeedbackLauf(ENV, AUTH, "");
zusage("Camp von vor einem Jahr bekommt KEINEN Bogen mehr", MAILS.length === 0, JSON.stringify(MAILS.map((m) => m.subject)));
zusage("Das Fenster ist auf 21 Tage begrenzt", bau.FC_FEEDBACK_FENSTER_TAGE === 21, String(bau.FC_FEEDBACK_FENSTER_TAGE));

// Genau an der oberen Kante muss er noch gehen, einen Tag darueber nicht mehr.
const kante = 2 + bau.FC_FEEDBACK_FENSTER_TAGE;
frisch({ status: "abgeschlossen", vonDatum: inTagen(-kante - 4), bisDatum: inTagen(-kante) }, [{}]);
DOC.einstellungen.feedbackAktiv = true; DOC.einstellungen.feedbackTage = 2;
await bau.fcFeedbackLauf(ENV, AUTH, "");
zusage("Am letzten Tag des Fensters geht der Bogen noch", MAILS.length === 1);

frisch({ status: "abgeschlossen", vonDatum: inTagen(-kante - 5), bisDatum: inTagen(-kante - 1) }, [{}]);
DOC.einstellungen.feedbackAktiv = true; DOC.einstellungen.feedbackTage = 2;
await bau.fcFeedbackLauf(ENV, AUTH, "");
zusage("Einen Tag spaeter nicht mehr", MAILS.length === 0);

frisch({ status: "offen", vonDatum: inTagen(2), bisDatum: inTagen(6) }, [{}]);
DOC.einstellungen.feedbackAktiv = true; DOC.einstellungen.feedbackTage = 2;
await bau.fcFeedbackLauf(ENV, AUTH, "");
zusage("Ein Camp, das noch laeuft, bekommt keinen Bogen", MAILS.length === 0);

frisch({ status: "abgeschlossen", vonDatum: inTagen(-8), bisDatum: inTagen(-4) },
  [{ status: "abgesagt" }, { status: "warteliste" }, { elternEmail: "" }]);
DOC.einstellungen.feedbackAktiv = true; DOC.einstellungen.feedbackTage = 2;
await bau.fcFeedbackLauf(ENV, AUTH, "");
zusage("Abgesagte, Wartende und Anmeldungen ohne Adresse bekommen nichts", MAILS.length === 0);

// =========================================================================
abschnitt("6. Feedbackbogen: antworten (und die Anonymitaet)");
// =========================================================================

function bogenCamp() {
  frisch({ status: "abgeschlossen", vonDatum: inTagen(-8), bisDatum: inTagen(-4) }, [{}, {}, {}]);
  DOC.einstellungen.feedbackAktiv = true;
  DOC.einstellungen.feedbackTage = 2;
}

bogenCamp();
r = await bau.handleFcFeedbackInfo(anfrage(), { token: "atok1" }, ENV, AUTH, {});
zusage("feedback-info liefert die Fragen", r.status === 200 && r.__json.fragen.length === bau.FC_FEEDBACK_FRAGEN.length);
zusage("feedback-info nennt das Camp", r.__json.campName === "Herbstcamp 2026");
// ⚠️ KEIN Kindername und keine Elterndaten. Den Bogen mit "Hallo Familie Meier"
// zu eroeffnen waere das Gegenteil der Zusage in der Mail.
zusage("feedback-info gibt KEINEN Kindernamen heraus",
  !JSON.stringify(r.__json).includes("Kind1") && !JSON.stringify(r.__json).includes("eltern1@"),
  JSON.stringify(r.__json).slice(0, 300));
zusage("feedback-info sagt, dass noch nicht geantwortet wurde", r.__json.schonBeantwortet === false);

r = await bau.handleFcFeedbackInfo(anfrage(), { token: "gibtsnicht" }, ENV, AUTH, {});
zusage("Unbekannter Token -> 404", r.status === 404);

frisch({ status: "offen", vonDatum: inTagen(2), bisDatum: inTagen(6) }, [{}]);
r = await bau.handleFcFeedbackInfo(anfrage(), { token: "atok1" }, ENV, AUTH, {});
zusage("Camp laeuft noch -> 410, nicht 200", r.status === 410, JSON.stringify(r.__json));

bogenCamp();
r = await bau.handleFcFeedbackSenden(anfrage(), { token: "atok1", antworten: {
  gesamt: 1, training: 2, essen: 3, organisation: 2, anlage: 1, wieder: "ja",
  gut: "Die Trainer waren super", besser: "Mehr Schatten"
} }, ENV, AUTH, {});
zusage("Antwort wird angenommen", r.status === 200, JSON.stringify(r.__json));
zusage("Sie liegt am Camp, nicht an der Anmeldung", camp0().feedback.length === 1);
zusage("feedbackAm ist gesetzt (damit niemand zweimal abstimmt)", !!anm0().feedbackAm);

// ⚠️ HIER steht die Anonymitaet oder faellt. Der Eintrag darf keinen Verweis auf
// die Anmeldung tragen -- keine Id, keine Nummer, keinen Token -- und keinen
// Zeitstempel, ueber den er sich mit feedbackAm wieder zusammenbringen liesse.
const eintrag = camp0().feedback[0];
zusage("Der Eintrag traegt NUR 'antworten'",
  JSON.stringify(Object.keys(eintrag)) === '["antworten"]', JSON.stringify(eintrag));
const eintragText = JSON.stringify(eintrag);
zusage("...keine Anmeldungs-Id, keine Nummer, kein Token",
  !eintragText.includes("a1") && !eintragText.includes("atok1"), eintragText);
zusage("...und keinen Zeitstempel",
  !/\d{4}-\d{2}-\d{2}T/.test(eintragText), eintragText);
// ⚠️ feedbackAm ist bewusst nur ein DATUM. Eine Uhrzeit auf die Sekunde waere
// eine Angabe, die niemand braucht, und neben einem Zeitstempel am Eintrag die
// Zuordnung selbst.
zusage("feedbackAm ist nur ein Datum, keine Uhrzeit",
  /^\d{4}-\d{2}-\d{2}$/.test(anm0().feedbackAm), anm0().feedbackAm);
// ⚠️ Ein Verlaufseintrag traegt einen Zeitstempel und liefe damit parallel zur
// Antwortliste -- die Reihenfolge waere ueber ihn wieder herstellbar.
zusage("Es entsteht KEIN Verlaufseintrag zum Feedback",
  !(camp0().verlauf || []).some((e) => String(e.was || "").includes("feedback")),
  JSON.stringify(camp0().verlauf));

r = await bau.handleFcFeedbackSenden(anfrage(), { token: "atok1", antworten: { gesamt: 5 } }, ENV, AUTH, {});
zusage("Zweite Antwort derselben Familie -> 409", r.status === 409, JSON.stringify(r.__json));
zusage("...und sie landet nicht doch in der Liste", camp0().feedback.length === 1);

r = await bau.handleFcFeedbackSenden(anfrage(), { token: "atok2", antworten: {} }, ENV, AUTH, {});
zusage("Leerer Bogen -> 400", r.status === 400, JSON.stringify(r.__json));
zusage("...und feedbackAm bleibt leer, der Bogen also weiter offen",
  !camp0().anmeldungen[1].feedbackAm);

r = await bau.handleFcFeedbackSenden(anfrage(), { token: "atok2", antworten: {
  gesamt: 9, erfunden: "hallo", wieder: "vielleicht", gut: "  ok  "
} }, ENV, AUTH, {});
const e2 = camp0().feedback.find((x) => x.antworten.gut === "ok");
zusage("Ungueltige Note, unbekannte Frage und unklares Ja/Nein fallen weg",
  !!e2 && e2.antworten.gesamt === undefined && e2.antworten.erfunden === undefined && e2.antworten.wieder === undefined,
  JSON.stringify(e2));

// Die zufaellige Einfuegestelle laesst sich nur statistisch belegen: bei 40
// Durchgaengen mit je zwei vorhandenen Eintraegen darf die neue Antwort nicht
// jedes Mal hinten landen.
let vorneMal = 0;
for (let i = 0; i < 40; i++) {
  bogenCamp();
  camp0().feedback = [{ antworten: { gesamt: 1 } }, { antworten: { gesamt: 2 } }];
  await bau.handleFcFeedbackSenden(anfrage(), { token: "atok1", antworten: { gesamt: 4 } }, ENV, AUTH, {});
  if (camp0().feedback.findIndex((x) => x.antworten.gesamt === 4) !== 2) vorneMal++;
}
zusage("Die Antwort landet an zufaelliger Stelle, nicht immer hinten",
  vorneMal > 5, `${vorneMal} von 40 Durchgaengen nicht am Ende`);

// =========================================================================
abschnitt("7. Feedbackbogen: Auswertung und Aufraeumen");
// =========================================================================

bogenCamp();
camp0().feedback = [
  { antworten: { gesamt: 1, wieder: "ja", gut: "Toll" } },
  { antworten: { gesamt: 2, wieder: "ja" } },
  { antworten: { gesamt: 3, wieder: "nein", besser: "Mehr Pausen" } }
];
camp0().anmeldungen.forEach((a) => { a.feedbackGebetenAm = new Date().toISOString(); });
const aus = bau.fcFeedbackAuswertung(camp0());
zusage("Auswertung zaehlt die Antworten", aus.anzahl === 3, String(aus.anzahl));
zusage("Auswertung zaehlt die verschickten Boegen", aus.gebeten === 3, String(aus.gebeten));
zusage("Der Schnitt stimmt (1+2+3)/3 = 2", aus.schnitte.gesamt === 2, String(aus.schnitte.gesamt));
// ⚠️ Die Erwartung wird AUS DER SKALA gebaut, nicht als "[1,1,1,0,0]"
// getippt: sonst muss diese Zeile bei jeder Änderung der Notenskala von Hand
// nachgezogen werden, und wer das vergisst, sieht einen Fund, wo keiner ist.
const erwartet = bau.FC_FEEDBACK_NOTEN.map((n) => (n <= 3 ? 1 : 0));
zusage("Die Verteilung stimmt",
  JSON.stringify(aus.verteilung.gesamt.verteilung) === JSON.stringify(erwartet),
  JSON.stringify(aus.verteilung.gesamt.verteilung) + " erwartet " + JSON.stringify(erwartet));
zusage("...und ist genau so lang wie die Skala",
  aus.verteilung.gesamt.verteilung.length === bau.FC_FEEDBACK_NOTEN.length,
  aus.verteilung.gesamt.verteilung.length + " gegen " + bau.FC_FEEDBACK_NOTEN.length);
zusage("Ja/Nein wird gezaehlt", aus.janein.wieder.ja === 2 && aus.janein.wieder.nein === 1, JSON.stringify(aus.janein));
zusage("Freitexte kommen paarweise heraus", aus.texte.length === 2, JSON.stringify(aus.texte));
// ⚠️ Ein Schnitt wie 1.6666666666666667 wuerde so in der Anzeige stehen.
camp0().feedback = [{ antworten: { gesamt: 1 } }, { antworten: { gesamt: 2 } }, { antworten: { gesamt: 2 } }];
zusage("Der Schnitt wird auf eine Nachkommastelle gerundet",
  bau.fcFeedbackAuswertung(camp0()).schnitte.gesamt === 1.7,
  String(bau.fcFeedbackAuswertung(camp0()).schnitte.gesamt));
camp0().feedback = [];
zusage("Ohne Antwort ist der Schnitt null, nicht NaN",
  bau.fcFeedbackAuswertung(camp0()).schnitte.gesamt === null);

// ⚠️ Die Auswertung geht ab BEARBEITEN heraus (sie enthaelt nichts
// Personenbezogenes) -- ohne Bearbeiten-Recht aber gar nicht.
bogenCamp();
camp0().feedback = [{ antworten: { gesamt: 1 } }];
r = await bau.handleFcLoad(anfrage(), ENV, AUTH, {});
zusage("Bearbeiter bekommt die Auswertung", r.__json.camps[0].feedback && r.__json.camps[0].feedback.anzahl === 1);
RECHT = { canEdit: false, canAdmin: false };
r = await bau.handleFcLoad(anfrage(), ENV, AUTH, {});
zusage("Ohne Bearbeiten-Recht kommt gar keine Auswertung mit",
  r.__json.camps[0].feedback === undefined, JSON.stringify(r.__json.camps[0].feedback));
RECHT = { canEdit: true, canAdmin: true };

// ⚠️ In einem Freitext kann ein Name stehen -- der eines Trainers, eines
// anderen Kindes oder des eigenen. Das Aufraeumen verspricht, dass danach
// niemand mehr aus dieser Datei zu erkennen ist; anonym eingegangen zu sein
// reicht dafuer nicht.
frisch({ status: "abgeschlossen", vonDatum: inTagen(-400), bisDatum: inTagen(-396) }, [{}]);
camp0().feedback = [{ antworten: { gesamt: 2, wieder: "ja", gut: "Trainer Meier war super mit unserem Ben", besser: "nichts" } }];
r = await bau.handleFcAufraeumen(anfrage(), { campId: "c1" }, ENV, AUTH, {});
zusage("Aufraeumen laeuft durch", r.status === 200, JSON.stringify(r.__json));
zusage("Die Noten bleiben stehen",
  camp0().feedback[0].antworten.gesamt === 2 && camp0().feedback[0].antworten.wieder === "ja",
  JSON.stringify(camp0().feedback));
zusage("Die Freitexte sind weg",
  camp0().feedback[0].antworten.gut === undefined && camp0().feedback[0].antworten.besser === undefined,
  JSON.stringify(camp0().feedback));
zusage("Und in der ganzen Datei steht der Name nicht mehr",
  !JSON.stringify(DOC).includes("Ben"), "");

// =========================================================================
abschnitt("8. Client und Worker muessen sich decken");
// =========================================================================

// ⚠️ Die Fragen stehen doppelt (Worker wirksam, config.js als Rueckfall fuer die
// Auswertung). Laufen sie auseinander, traegt die Auswertung Ueberschriften, die
// niemand gefragt wurde.
// ⚠️ Verglichen wird Id, Typ UND WORTLAUT. Bis 2026-09-03 nur Id und Typ -- damit
// hätte der Fragetext auseinanderlaufen können, und sowohl die Auswertung im
// Reiter Feedback als auch die neue Vorschau nehmen ihn aus config.js. Dann
// stünden dort Überschriften über Antworten auf eine andere Frage.
const cFragen = [...CONFIGJS.matchAll(/\{ id: "(\w+)",\s+typ: "(note|janein|text)",\s+frage: "([^"]*)"/g)]
  .map((m) => m[1] + ":" + m[2] + ":" + m[3]);
const wFragen = bau.FC_FEEDBACK_FRAGEN.map((f) => f.id + ":" + f.typ + ":" + f.frage);
zusage("Fragenliste in config.js deckt sich mit der im Worker (Id, Typ UND Wortlaut)",
  cFragen.length === wFragen.length && JSON.stringify(cFragen) === JSON.stringify(wFragen),
  "config: " + JSON.stringify(cFragen) + "\n        worker: " + JSON.stringify(wFragen));
zusage("...und es sind wirklich alle acht gefunden worden",
  cFragen.length === 8, "gefunden: " + cFragen.length);

const cNoten = [...CONFIGJS.matchAll(/\{ wert: (\d), label: "/g)].map((m) => Number(m[1]));
zusage("Die Skala geht von 1 bis 6",
  JSON.stringify(bau.FC_FEEDBACK_NOTEN) === "[1,2,3,4,5,6]", JSON.stringify(bau.FC_FEEDBACK_NOTEN));
zusage("Eine 6 wird angenommen, eine 7 nicht",
  bau.fcFeedbackPruefen({ gesamt: 6 }).gesamt === 6 &&
  bau.fcFeedbackPruefen({ gesamt: 6, training: 7 }).training === undefined);
zusage("Notenskala deckt sich", JSON.stringify(cNoten) === JSON.stringify(bau.FC_FEEDBACK_NOTEN),
  "config: " + JSON.stringify(cNoten) + "\n        worker: " + JSON.stringify(bau.FC_FEEDBACK_NOTEN));

const cRollen = [...CONFIGJS.matchAll(/\{ id: "(feldspieler|torwart)",\s+label:/g)].map((m) => m[1]);
zusage("Rollenliste deckt sich", JSON.stringify(cRollen) === JSON.stringify(bau.FC_ROLLEN),
  "config: " + JSON.stringify(cRollen));

// ⚠️ Ohne `:checked` laege bei den Radio-Knoepfen immer der ERSTE vor -- also bei
// jeder Frage eine 1 und bei jeder Anmeldung "Feldspieler", auch wenn niemand
// etwas angeklickt hat. Genau diese Falle steckte schon einmal in den
// Ja/Nein-Feldern.
zusage("feedback.js liest die Knoepfe mit :checked", FEEDBACKJS.includes('[data-frage="${CSS.escape(f.id)}"]:checked'));
zusage("oeffentlich.js liest die Rollen-Knoepfe mit :checked", OEFFJS.includes('querySelector("[data-rolle]:checked")'));
// ⚠️ Keine Vorauswahl: eine vorgewaehlte 3 kaeme bei jedem durch, der eine Frage
// ueberspringt, und waere dann keine Antwort, sondern eine erfundene.
zusage("Der Feedbackbogen waehlt keine Note vor", !/name="\$\{oEsc\(id\)\}"[^>]*checked/.test(FEEDBACKJS));

zusage("baueFormular nimmt die Rollen entgegen", OEFFJS.includes("function baueFormular(ziel, konf, werte, rollen)"));
zusage("...und stellt die Frage nur bei ZWEI Ausrichtungen",
  OEFFJS.includes("if (liste.length < 2) return \"\";"));
zusage("anmeldung.js reicht camp.rollen durch", readFileSync(APP + "anmeldung.js", "utf8").includes("camp.felder, letzteEltern || {}, camp.rollen"));
zusage("meine-anmeldung.js reicht camp.rollen durch", readFileSync(APP + "meine-anmeldung.js", "utf8").includes("camp.felder, a, camp.rollen"));

// Verdrahtung in der Oberflaeche.
for (const [id, wo] of [
  ["c-fuer-feldspieler", "Camp-Dialog: Haken Feldspieler"],
  ["c-fuer-torwart", "Camp-Dialog: Haken Torwart"],
  ["c-ablauf", "Camp-Dialog: Ablauf"],
  ["e-feedback", "Verwaltung: Haken Feedbackbogen"],
  ["e-feedbacktage", "Verwaltung: Tage"],
  ["btn-test-feedback", "Verwaltung: Jetzt ausloesen"],
  ["fb-camp", "Feedback-Reiter: Camp-Auswahl"],
  ["fb-inhalt", "Feedback-Reiter: Inhalt"]
]) {
  zusage(`${wo} steht in index.html (#${id})`, INDEXHTML.includes(`id="${id}"`));
  zusage(`...und app.js fasst ihn an (#${id})`, APPJS.includes(`"${id}"`));
}
zusage("Der Feedback-Reiter ist an das BEARBEITEN-Recht gebunden",
  /data-tab="feedback" class="editor-only hidden"/.test(INDEXHTML));
// ⚠️ Verstecken ist nicht Raeumen: was einmal gezeichnet ist, bleibt sonst im
// DOM stehen, wenn ein Recht wegfaellt.
zusage("Bei Rechteverlust wird der Feedback-Inhalt geraeumt",
  /raeumeWasNichtMehrErlaubtIst[\s\S]{0,3000}leere\("fb-inhalt"\)/.test(APPJS));

zusage("feedback.html laedt config.js, oeffentlich.js und feedback.js",
  FEEDBACKHTML.includes("config.js?v=") && FEEDBACKHTML.includes("oeffentlich.js?v=") && FEEDBACKHTML.includes("feedback.js?v="));
zusage("feedback.html sagt den Eltern, dass es anonym ist",
  /anonym/i.test(FEEDBACKHTML));
// ⚠️ noindex: die Seite haengt an einem Token und gehoert in keine Suchmaschine.
zusage("feedback.html traegt noindex", FEEDBACKHTML.includes('name="robots" content="noindex'));

// =========================================================================
abschnitt("9. Mailvorlagen: sichtbar und aenderbar");
// =========================================================================

zusage("Es gibt neun Vorlagen", bau.FC_MAIL_VORLAGEN.length === 9, String(bau.FC_MAIL_VORLAGEN.length));
const ids = bau.FC_MAIL_VORLAGEN.map((v) => v.id);
zusage("...und zwar genau diese",
  JSON.stringify(ids) === JSON.stringify(["bestaetigung", "warteliste", "zusage", "start",
    "zahlung", "bezahlt", "absage-eltern", "absage-verwaltung", "feedback"]), JSON.stringify(ids));

// ⚠️ Jede Vorlage MUSS ihre eigenen Pflicht-Platzhalter selbst enthalten -- sonst
// waere die mitgelieferte Fassung schon unbrauchbar und liesse sich nicht einmal
// speichern.
bau.FC_MAIL_VORLAGEN.forEach((v) => {
  const fehlend = (v.pflicht || []).filter((p) => !v.text.includes("{" + p + "}"));
  zusage(`Vorgabe "${v.id}" traegt ihre eigenen Pflicht-Bausteine`, fehlend.length === 0, JSON.stringify(fehlend));
  const unbekannt = [...v.text.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
    .filter((n) => !v.felder.includes(n));
  zusage(`Vorgabe "${v.id}" benutzt nur Platzhalter, die sie kennt`, unbekannt.length === 0, JSON.stringify(unbekannt));
  const unbekanntB = [...v.betreff.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
    .filter((n) => !bau.FC_MAIL_BETREFF_FELDER.includes(n));
  zusage(`Betreff "${v.id}" benutzt nur erlaubte Platzhalter`, unbekanntB.length === 0, JSON.stringify(unbekanntB));
});

// ⚠️ Der Betreff darf den KINDERNAMEN nicht tragen: er steht in der Handy-Vorschau
// auf dem Sperrbildschirm und im Versandprotokoll von Brevo.
zusage("`kind` ist im Betreff NICHT erlaubt", !bau.FC_MAIL_BETREFF_FELDER.includes("kind"),
  JSON.stringify(bau.FC_MAIL_BETREFF_FELDER));
zusage("Keine Vorgabe traegt {kind} im Betreff",
  bau.FC_MAIL_VORLAGEN.every((v) => !v.betreff.includes("{kind}")));

// Jeder Platzhalter, den eine Vorlage anbietet, muss auch erklaert sein --
// sonst steht in der Maske ein Baustein ohne Bedeutung.
const alleFelder = new Set();
bau.FC_MAIL_VORLAGEN.forEach((v) => v.felder.forEach((f) => alleFelder.add(f)));
const ohneErklaerung = [...alleFelder].filter((f) => !bau.FC_MAIL_PLATZHALTER[f]);
zusage("Jeder angebotene Platzhalter ist erklaert", ohneErklaerung.length === 0, JSON.stringify(ohneErklaerung));

// ---- Ersetzen ------------------------------------------------------------
let m = bau.fcMailBauen({}, "bestaetigung", { eltern: "Eltern", kind: "Max Muster", camp: "Herbstcamp 2026",
  campblock: "BLOCK", zahlungsblock: "ZAHLUNG", aendernblock: "AENDERN", kontakt: "", fuss: "GRUSS" });
zusage("Platzhalter werden ersetzt",
  m.text.includes("Max Muster") && m.text.includes("ZAHLUNG") && m.text.includes("AENDERN"), m.text.slice(0, 200));
zusage("Kein `{...}` bleibt stehen", !/\{\w+\}/.test(m.text), (m.text.match(/\{\w+\}/g) || []).join(","));
zusage("Betreff nimmt {camp}", m.betreff === "Anmeldung bestätigt: Herbstcamp 2026", m.betreff);

// ⚠️ Ein Platzhalter, den DIESE Mail nicht kennt, darf nicht ersetzt werden --
// sonst schleuste eine Vorlage etwas aus einer anderen Mail ein.
const eigen = { mailVorlagen: { feedback: { betreff: "", text: "Hallo {eltern}, hier {zahlungsblock} und {feedbacklink}." } } };
m = bau.fcMailBauen(eigen, "feedback", { eltern: "E", zahlungsblock: "GEHEIME-IBAN", feedbacklink: "LINK" });
zusage("Ein fremder Platzhalter wird NICHT ersetzt",
  m.text.includes("{zahlungsblock}") && !m.text.includes("GEHEIME-IBAN"), m.text);
zusage("...der eigene aber schon", m.text.includes("LINK"));

// ---- Rueckfall -----------------------------------------------------------
const nurBetreff = { mailVorlagen: { zusage: { betreff: "Eigener Betreff: {camp}", text: "" } } };
const v = bau.fcMailVorlage(nurBetreff, "zusage");
zusage("Eigener Betreff wirkt", v.betreff === "Eigener Betreff: {camp}", v.betreff);
// ⚠️ Betreff und Text fallen EINZELN zurueck.
zusage("...und der Text faellt trotzdem auf die Vorgabe",
  v.text === bau.FC_MAIL_VORLAGEN.find((x) => x.id === "zusage").text && !v.eigenerText);
zusage("Ohne Eintrag gilt ueberall die Vorgabe",
  bau.fcMailVorlage({}, "start").text === bau.FC_MAIL_VORLAGEN.find((x) => x.id === "start").text);

// ---- Pflicht-Platzhalter -------------------------------------------------
let fehler = null;
try { bau.fcMailVorlagenPruefen({ bestaetigung: { betreff: "", text: "Hallo {eltern}, ohne alles." } }); }
catch (e) { fehler = e; }
zusage("Vorlage ohne Pflicht-Baustein wird abgelehnt", !!fehler && fehler.status === 400, fehler && fehler.message);
zusage("...und die Meldung nennt die fehlenden Bausteine",
  !!fehler && fehler.message.includes("{zahlungsblock}") && fehler.message.includes("{aendernblock}"),
  fehler && fehler.message);

fehler = null;
try { bau.fcMailVorlagenPruefen({ feedback: { betreff: "", text: "Hallo {eltern}, danke." } }); }
catch (e) { fehler = e; }
zusage("Feedback-Mail ohne {feedbacklink} wird abgelehnt", !!fehler && fehler.status === 400, fehler && fehler.message);

fehler = null;
try { bau.fcMailVorlagenPruefen({ "absage-eltern": { betreff: "", text: "Hallo {eltern}, schade." } }); }
catch (e) { fehler = e; }
zusage("Absage-Mail ohne {geldblock} wird abgelehnt", !!fehler && fehler.status === 400, fehler && fehler.message);

// ---- Saeubern ------------------------------------------------------------
let sauber = bau.fcMailVorlagenPruefen({ gibtsnicht: { betreff: "x", text: "y" } });
zusage("Eine erfundene Vorlagen-Id faellt weg", Object.keys(sauber).length === 0, JSON.stringify(sauber));
sauber = bau.fcMailVorlagenPruefen({ __proto__: { betreff: "x", text: "y" } });
zusage("`__proto__` als Id trifft nicht den Prototyp",
  Object.keys(sauber).length === 0 && Object.getPrototypeOf(sauber) === null, JSON.stringify(sauber));

// ⚠️ Wer die Vorgabe unveraendert speichert, bekommt KEINE eingefrorene Kopie --
// sonst kaeme eine spaetere Verbesserung des Textes bei ihm nie an.
const def = bau.FC_MAIL_VORLAGEN.find((x) => x.id === "bezahlt");
sauber = bau.fcMailVorlagenPruefen({ bezahlt: { betreff: def.betreff, text: def.text } });
zusage("Unveraenderte Vorgabe wird als LEER gespeichert", Object.keys(sauber).length === 0, JSON.stringify(sauber));
sauber = bau.fcMailVorlagenPruefen({ bezahlt: { betreff: def.betreff, text: def.text + "\n\nBis bald!" } });
zusage("Ein wirklich geaenderter Text wird gespeichert",
  !!sauber.bezahlt && sauber.bezahlt.text.includes("Bis bald!") && sauber.bezahlt.betreff === "",
  JSON.stringify(sauber));

// ---- Speichern und wirken ------------------------------------------------
frisch({}, [{}]);
RECHT = { canEdit: true, canAdmin: true };
const einstBasis = { iban: "DE02120300000000202051", kontoinhaber: "SC", bic: "", bank: "",
  kontaktName: "", kontaktEmail: "", agbText: "Bedingungen",
  startErinnerung: true, startErinnerungTage: 3, zahlErinnerung: true, zahlErinnerungTage: 14,
  feedbackAktiv: false, feedbackTage: 2, aufraeumenNachMonaten: 6 };

r = await bau.handleFcAnmeldungSpeichern(anfrage(), { campId: "c1", anmeldung: { id: "a1", bezahlt: true } }, ENV, AUTH, {});
const vorher = MAILS[0] && MAILS[0].textContent;
zusage("Ohne eigene Vorlage geht die Vorgabe raus",
  !!vorher && vorher.includes("der Beitrag für Kind1 Test ist bei uns eingegangen"), vorher && vorher.slice(0, 120));

// Jetzt eine eigene Fassung speichern und dieselbe Mail noch einmal ausloesen.
r = await bau.handleFcEinstellungenSpeichern(anfrage(), { einstellungen: Object.assign({}, einstBasis, {
  mailVorlagen: { bezahlt: { betreff: "Danke für {camp}!", text: "Servus {eltern}!\n\n{kind} ist dabei.\n\n{aendernblock}" } }
}) }, ENV, AUTH, {});
zusage("Eigene Vorlage laesst sich speichern", r.status === 200, JSON.stringify(r.__json));
zusage("...und liegt in der Datei",
  !!(DOC.einstellungen.mailVorlagen && DOC.einstellungen.mailVorlagen.bezahlt), JSON.stringify(DOC.einstellungen.mailVorlagen));

frisch({}, [{}]);
DOC.einstellungen.mailVorlagen = { bezahlt: { betreff: "Danke für {camp}!", text: "Servus {eltern}!\n\n{kind} ist dabei.\n\n{aendernblock}" } };
await bau.handleFcAnmeldungSpeichern(anfrage(), { campId: "c1", anmeldung: { id: "a1", bezahlt: true } }, ENV, AUTH, {});
zusage("Die eigene Fassung geht wirklich raus",
  MAILS[0] && MAILS[0].textContent.startsWith("Servus Eltern!"), MAILS[0] && MAILS[0].textContent.slice(0, 80));
zusage("...mit dem eigenen Betreff", MAILS[0] && MAILS[0].subject === "Danke für Herbstcamp 2026!", MAILS[0] && MAILS[0].subject);
zusage("...und der Aendern-Link ist eingesetzt",
  MAILS[0] && MAILS[0].textContent.includes("meine-anmeldung.html?a="), MAILS[0] && MAILS[0].textContent);

// ---- Jede Vorlage muss auch WIRKLICH ihre eigene sein ---------------------
//
// ⚠️ Ohne diese zwei Zusagen war die Trennung in vier Vorlagen (Bestaetigung /
// Warteliste, Absage-Eltern / Absage-Verwaltung) nur behauptet: die Mutation
// "nimm ueberall dieselbe Vorlage" lief glatt durch. Beide Paare unterscheiden
// sich in dem, was den Eltern gesagt wird -- das ist keine Formsache.

// Volles Camp -> die Anmeldung landet auf der Warteliste.
frisch({ status: "offen", plaetze: 1 }, [{}]);
DOC.einstellungen.agbText = "Bedingungen";
DOC.einstellungen.agbStand = "stand-1";
MAILS = [];
r = await bau.handleFcAnmelden(anfrage(), { token: "tok1", datenschutz: true, agb: true, agbStand: "stand-1",
  daten: { kindVorname: "Max", kindNachname: "Muster", elternName: "Eltern", elternEmail: "e@example.org" } },
  ENV, AUTH, {}, null);
zusage("Volles Camp: die Anmeldung geht auf die Warteliste", r.status === 200 && r.__json.status === "warteliste",
  JSON.stringify(r.__json));
const wMail = MAILS[MAILS.length - 1] || {};
zusage("Die Wartelisten-Mail nimmt IHRE eigene Vorlage",
  String(wMail.textContent || "").includes("Das Camp ist im Moment ausgebucht"), String(wMail.textContent || "").slice(0, 200));
zusage("...mit dem Betreff 'Warteliste: <Camp>'", wMail.subject === "Warteliste: Herbstcamp 2026", wMail.subject);
// ⚠️ Der Kern der Trennung: auf der Warteliste soll niemand ueberweisen.
zusage("...und OHNE Zahlungsblock und ohne IBAN",
  !String(wMail.textContent || "").includes("DE02120300000000202051") &&
  String(wMail.textContent || "").includes("BITTE ÜBERWEISE JETZT NOCH NICHTS"),
  String(wMail.textContent || "").slice(0, 400));

// Absage durch die VERWALTUNG -> eigene Vorlage, anderer Wortlaut.
frisch({}, [{}]);
MAILS = [];
r = await bau.handleFcAbsagen(anfrage(), { campId: "c1", anmeldungId: "a1", grund: "intern gemerkt", mail: true }, ENV, AUTH, {});
const aMail = MAILS[MAILS.length - 1] || {};
zusage("Die Verwaltungs-Absage nimmt IHRE eigene Vorlage",
  String(aMail.textContent || "").includes("ist abgesagt") &&
  !String(aMail.textContent || "").includes("wir haben deine Absage"),
  String(aMail.textContent || "").slice(0, 250));
// ⚠️ Der Absagegrund bleibt intern -- die Maske sagt das beim Eintragen zu.
zusage("...und der interne Absagegrund steht NICHT darin",
  !String(aMail.textContent || "").includes("intern gemerkt"), String(aMail.textContent || ""));

// ---- Rechte + alter Client ------------------------------------------------
frisch({}, []);
DOC.einstellungen.mailVorlagen = { bezahlt: { betreff: "X", text: "{eltern} {aendernblock}" } };
// ⚠️ Ein FEHLENDES Feld heisst "unveraendert" -- ein alter Client schickt es nicht.
await bau.handleFcEinstellungenSpeichern(anfrage(), { einstellungen: einstBasis }, ENV, AUTH, {});
zusage("Ein alter Client ohne das Feld raeumt die Vorlagen NICHT weg",
  !!(DOC.einstellungen.mailVorlagen && DOC.einstellungen.mailVorlagen.bezahlt),
  JSON.stringify(DOC.einstellungen.mailVorlagen));
await bau.handleFcEinstellungenSpeichern(anfrage(), { einstellungen: Object.assign({}, einstBasis, { mailVorlagen: {} }) }, ENV, AUTH, {});
zusage("Ein ausdrueckliches {} leert sie", Object.keys(DOC.einstellungen.mailVorlagen || {}).length === 0);

frisch({}, []);
r = await bau.handleFcLoad(anfrage(), ENV, AUTH, {});
zusage("Der Admin bekommt alle neun Vorlagen mit", r.__json.mailVorlagen && r.__json.mailVorlagen.length === 9);
zusage("...samt Vorgabe UND wirksamem Stand",
  !!(r.__json.mailVorlagen[0].textVorgabe && r.__json.mailVorlagen[0].text));
zusage("...und der Erklaerung der Platzhalter", !!(r.__json.mailPlatzhalter && r.__json.mailPlatzhalter.kind));
RECHT = { canEdit: true, canAdmin: false };
r = await bau.handleFcLoad(anfrage(), ENV, AUTH, {});
zusage("Ohne Administrieren-Recht kommen KEINE Vorlagen mit",
  r.__json.mailVorlagen === null && r.__json.mailPlatzhalter === null,
  JSON.stringify(r.__json.mailVorlagen));
RECHT = { canEdit: true, canAdmin: true };

// ---- Client: Vorschau + Maske --------------------------------------------
zusage("feedback.js kennt den Vorschau-Betrieb", FEEDBACKJS.includes('oQuery("vorschau") === "1"'));
// ⚠️ Die Sperre muss VOR dem Einlesen stehen, sonst liefe ein Absenden in der
// Vorschau doch noch gegen den Worker.
zusage("Die Vorschau kann nichts absenden",
  /if \(VORSCHAU\) \{[\s\S]{0,400}?return;\n  \}/.test(FEEDBACKJS.slice(FEEDBACKJS.indexOf("async function absenden"))),
  "");
zusage("Der Vorschau-Knopf steht in index.html", INDEXHTML.includes('id="btn-feedback-vorschau"'));
zusage("...und app.js oeffnet damit feedback.html?vorschau=1",
  APPJS.includes('feedback.html?vorschau=1'));
zusage("Die Vorschau-Warnung steht in feedback.html", FEEDBACKHTML.includes('id="vorschau-hinweis"'));
// ⚠️ Ausdrueckliche STATISCHE Zusage: dass der Kasten im Markup steht, belegt
// nicht, dass er auch aufgedeckt wird -- er ist per Vorgabe `fc-hidden`. Im
// Browser gegengeprueft; hier festgenagelt, damit die Zeile nicht still
// herausfaellt.
zusage("...und zeigeVorschau deckt sie auch auf",
  /function zeigeVorschau\(\)[\s\S]{0,900}?getElementById\("vorschau-hinweis"\)\.classList\.remove\("fc-hidden"\)/.test(FEEDBACKJS));

zusage("Die Mail-Karte steht in index.html", INDEXHTML.includes('id="mail-vorlagen"'));
zusage("app.js zeichnet sie", APPJS.includes("function zeichneMailVorlagen"));
zusage("...und liest sie beim Speichern zurueck", APPJS.includes("mailVorlagen: leseMailVorlagen()"));
// ⚠️ Verstecken ist nicht Raeumen: die Kaesten nennen Betreff und Anlass jeder
// Vereinsmail und bleiben sonst nach einem Rechteverlust im DOM stehen.
zusage("Bei Rechteverlust wird die Mail-Karte geraeumt",
  /raeumeWasNichtMehrErlaubtIst[\s\S]{0,4000}leere\("mail-vorlagen"\)/.test(APPJS));
// ⚠️ leseMailVorlagen MUSS undefined liefern, wenn die Karte fehlt -- sonst
// schickte ein Nicht-Admin ein leeres Objekt und raeumte alle Vorlagen weg.
zusage("leseMailVorlagen liefert undefined ohne Karte",
  /function leseMailVorlagen\(\)[\s\S]{0,400}?return undefined;/.test(APPJS));
// ⚠️ Die ZWEITE Wache, und die wichtigere: der Kasten steht im Markup, ist
// aber leer (Rechteverlust hat ihn ausgeraeumt, oder das Zeichnen lief nicht
// durch). Ohne sie liefert die Funktion `{}` -- und `{}` heisst fuer den Worker
// "leere alle Vorlagen". Im Browser gefunden, nicht ausgedacht.
zusage("...UND auch dann, wenn der Kasten da, aber leer ist",
  /function leseMailVorlagen\(\)[\s\S]{0,1400}?if \(!gefunden\) return undefined;/.test(APPJS));

// =========================================================================
abschnitt("10. \"Keine\" ist eine Nicht-Angabe (Teilnehmerliste)");
// =========================================================================

zusage("config.js und app.js laufen zusammen", typeof CLIENT.istLeereAngabe === "function");

// Was verschwinden SOLL.
[["keine", "Keine", "KEINE", "keine.", "keine!", " keine ", "kein", "keiner", "keins"],
 ["nein", "Nein", "nichts", "nix", "ohne", "entfällt", "n/a", "0"],
 ["-", "–", "/", ".", "", "   ", "keine bekannt", "Keine bekannten", "keine Allergien", "keine Medikamente"]]
  .flat().forEach((v) => {
    zusage(`gilt als nichts: ${JSON.stringify(v)}`, CLIENT.istLeereAngabe(v));
  });
zusage("gilt als nichts: undefined", CLIENT.istLeereAngabe(undefined));
zusage("gilt als nichts: null", CLIENT.istLeereAngabe(null));

// ⚠️⚠️ DER wichtige Teil. Jede dieser Angaben ist echt und darf NIE verschluckt
// werden -- ein Anfangs- oder Teilstueck-Vergleich ("startsWith(\"kein\")")
// wuerde genau sie treffen, also die Angaben, wegen derer es die Liste gibt.
[
  "keine Nüsse", "keine Nuesse", "kein Schweinefleisch", "keine Laktose",
  "keine Medikamente, aber Asthmaspray", "keine bekannten Allergien, Kind hat aber Asthma",
  "Asthma", "Heuschnupfen", "Nussallergie", "0,5 mg Insulin", "Ohne Zwiebeln",
  "nichts Scharfes", "Geschwisterkind Sebastian C. Blase",
  "Konfektionsgröße eigentlich 134 (stand nicht zur Auswahl)"
].forEach((v) => {
  zusage(`bleibt stehen: ${JSON.stringify(v)}`, !CLIENT.istLeereAngabe(v), "wurde verschluckt!");
});

// Zusammensetzung der Hinweiszeile -- die Faelle aus Michels Bildschirmfoto.
const hin = (t) => CLIENT.teilnehmerHinweise(t);
zusage("Allergien und Medikamente beide \"Keine\" -> gar keine Zeile",
  hin({ allergien: "Keine", medikamente: "Keine" }).length === 0,
  JSON.stringify(hin({ allergien: "Keine", medikamente: "Keine" })));
zusage("Eine echte Allergie steht da",
  JSON.stringify(hin({ allergien: "Asthma" })) === '["Allergien: Asthma"]');
zusage("\"Keine\" faellt weg, der Geschwister-Hinweis bleibt",
  JSON.stringify(hin({ allergien: "Keine", krankheiten: "Geschwisterkind Sebastian C. Blase" }))
    === '["Geschwisterkind Sebastian C. Blase"]');
zusage("Zwei Nicht-Angaben plus ein echter Hinweis -> nur der Hinweis",
  JSON.stringify(hin({ allergien: "keine", medikamente: "keine", krankheiten: "Größe eigentlich 134" }))
    === '["Größe eigentlich 134"]');
zusage("Alles echt -> alles da",
  hin({ allergien: "Nüsse", medikamente: "Insulin", krankheiten: "Asthma", essenHinweis: "vegetarisch" }).length === 4);

// ⚠️ Der Marker haengt an DIESER Liste. Ist sie leer, gibt es keinen "beachten".
zusage("Der Beachten-Marker haengt an der Hinweisliste",
  /\$\{hinweise\.length \? `<span class="marker gesundheit">beachten<\/span>` : ""\}/.test(APPJS));
zusage("...und die Hinweisliste kommt aus teilnehmerHinweise",
  /const hinweise = teilnehmerHinweise\(t\);/.test(APPJS));
// ⚠️ Dieselbe Regel in der Anmeldeliste -- ein "Gesundheit"-Marker, der auch bei
// "keine" leuchtet, leuchtet bei jedem und ist damit wertlos.
zusage("Die Anmeldeliste benutzt dieselbe Regel",
  /const gesund = \[a\.allergien, a\.medikamente, a\.krankheiten, a\.essenHinweis\]\.some\(\(w\) => !istLeereAngabe\(w\)\);/.test(APPJS));

// ⚠️ Gespeichert wird weiter alles. "keine" ist eine BEANTWORTETE Frage und
// damit etwas anderes als ein leeres Feld -- die Anzeige darf das nicht
// einebnen, und der Worker fasst die Werte gar nicht erst an.
zusage("Der Worker wirft \"keine\" NICHT weg",
  !QUELLE.includes("LEERE_ANGABEN") && !QUELLE.includes("istLeereAngabe"),
  "im Worker gefunden -- dort gehoert die Anzeige-Regel nicht hin");

// =========================================================================
abschnitt("11. Die Verwaltung korrigiert eine Anmeldung");
// =========================================================================

const korr = async (felder, extra) => {
  RECHT = { canEdit: true, canAdmin: true };
  return bau.handleFcAnmeldungSpeichern(anfrage(),
    { campId: "c1", anmeldung: Object.assign({ id: "a1", felder }, extra || {}) }, ENV, AUTH, {});
};

frisch({}, [{ geburtsdatum: "2015-05-05", trikotgroesse: "140", allergien: "Nüsse", alleinNachHause: "nein" }]);
r = await korr({ trikotgroesse: "134" });
zusage("Eine Groesse laesst sich korrigieren", r.status === 200 && anm0().trikotgroesse === "134", anm0().trikotgroesse);
zusage("...und der Rest bleibt unangetastet",
  anm0().allergien === "Nüsse" && anm0().geburtsdatum === "2015-05-05");
// ⚠️ Der einzige Weg, auf dem sich Angaben zu einem Kind aendern, ohne dass die
// Eltern es ausloesen -- ohne Eintrag waere das der einzige stille Vorgang.
const korrEintrag = (camp0().verlauf || []).find((e) => e.was === "geaendert-verwaltung");
zusage("Die Korrektur steht im Verlauf", !!korrEintrag, JSON.stringify(camp0().verlauf));
zusage("...mit den Feld-Ids", !!korrEintrag && JSON.stringify(korrEintrag.felder) === '["trikotgroesse"]', korrEintrag && JSON.stringify(korrEintrag.felder));
// ⚠️ NIE die Werte: ein aufbewahrter alter Wert waere eine zweite Kopie
// derselben Gesundheitsangabe, die keine Loeschung mehr erwischt.
zusage("...aber OHNE den alten oder neuen Wert",
  !JSON.stringify(korrEintrag).includes("140") && !JSON.stringify(korrEintrag).includes("134"), JSON.stringify(korrEintrag));
zusage("...und ohne Kindernamen (fcVerlaufNotiz streicht `wen`)",
  !JSON.stringify(camp0().verlauf).includes("Kind1"), JSON.stringify(camp0().verlauf));

// Ohne echte Aenderung kein Eintrag -- sonst waechst der Verlauf bei jedem
// Hinsehen, und niemand geht ihm mehr nach.
frisch({}, [{ trikotgroesse: "140" }]);
await korr({ trikotgroesse: "140" });
zusage("Gleicher Wert -> kein Verlaufseintrag",
  !(camp0().verlauf || []).some((e) => e.was === "geaendert-verwaltung"), JSON.stringify(camp0().verlauf));

// ---- Normalisierung wie im Eltern-Weg ------------------------------------
frisch({ felder: { geburtsdatum: "optional", alleinNachHause: "optional", vegetarisch: "optional" } },
       [{ geburtsdatum: "2015-05-05", alleinNachHause: "nein" }]);
await korr({ geburtsdatum: "morgen" });
zusage("Ein kaputtes Datum wird verworfen, nicht gespeichert", anm0().geburtsdatum === "", anm0().geburtsdatum);
await korr({ alleinNachHause: "vielleicht" });
zusage("Ja/Nein nimmt nur ja, nein oder leer", anm0().alleinNachHause === "", anm0().alleinNachHause);
await korr({ alleinNachHause: "ja" });
zusage("...ein gueltiges ja kommt durch", anm0().alleinNachHause === "ja");
await korr({ vegetarisch: true });
zusage("Ein Haken wird ein echtes true", anm0().vegetarisch === true, String(anm0().vegetarisch));

frisch({}, [{ elternEmail: "gut@example.org" }]);
r = await korr({ elternEmail: "kaputt" });
zusage("Eine kaputte Mailadresse wird abgelehnt (400)", r.status === 400, JSON.stringify(r.__json));
zusage("...und die alte bleibt stehen", anm0().elternEmail === "gut@example.org", anm0().elternEmail);

// ⚠️ Ohne diese Sperre liesse sich der Kindername auf nichts setzen -- die
// Anmeldung hiesse ueberall "Ohne Namen", auch im Verwendungszweck.
frisch({}, [{}]);
r = await korr({ kindVorname: "   " });
zusage("Ein festes Feld laesst sich nicht leeren (400)", r.status === 400, JSON.stringify(r.__json));
zusage("...und der Name steht noch da", anm0().kindVorname === "Kind1", anm0().kindVorname);

// ⚠️ Ein am Camp ABGESCHALTETES Feld wird verworfen -- sonst legte eine
// Korrektur Daten an, die dieses Camp gar nicht erhebt.
frisch({ felder: {} }, [{}]);
await korr({ krankenkasse: "AOK" });
zusage("Ein abgeschaltetes Feld wird verworfen", anm0().krankenkasse === undefined, String(anm0().krankenkasse));

// Zusatzfrage
frisch({ zusatzfrage: "In welche Gruppe?" }, [{ zusatzantwort: "egal" }]);
await korr({}, { zusatzantwort: "zu Ben" });
zusage("Die Zusatzantwort laesst sich aendern", anm0().zusatzantwort === "zu Ben", anm0().zusatzantwort);
frisch({ zusatzfrage: "" }, [{}]);
await korr({}, { zusatzantwort: "erfunden" });
zusage("Ohne Zusatzfrage wird keine Antwort angelegt", !anm0().zusatzantwort, String(anm0().zusatzantwort));

// ---- Rechte ---------------------------------------------------------------
frisch({}, [{}]);
RECHT = { canEdit: false, canAdmin: false };
r = await bau.handleFcAnmeldungSpeichern(anfrage(),
  { campId: "c1", anmeldung: { id: "a1", felder: { trikotgroesse: "999" } } }, ENV, AUTH, {});
zusage("Ohne Bearbeiten-Recht: 403", r.status === 403, JSON.stringify(r.__json));
zusage("...und nichts geaendert", anm0().trikotgroesse === "152", anm0().trikotgroesse);
RECHT = { canEdit: true, canAdmin: true };

// ---- Client ---------------------------------------------------------------
zusage("Der Bearbeiten-Knopf steht in index.html", INDEXHTML.includes('id="btn-anm-bearbeiten"'));
zusage("app.js verdrahtet ihn", APPJS.includes("anmBearbeitenUmschalten"));
// ⚠️ Beim Oeffnen zurueck auf Ansehen -- Flag UND Beschriftung.
zusage("Beim Oeffnen faellt der Modus zurueck",
  /function oeffneAnmDialog[\s\S]{0,600}?anmBearbeiten = false;/.test(APPJS));
zusage("...und die Beschriftung des Knopfes mit",
  /function oeffneAnmDialog[\s\S]{0,1400}?bearbKnopf\.textContent = "Bearbeiten";/.test(APPJS));
// ⚠️ Im Bearbeiten-Modus gibt es `ad-notiz` gar nicht -- ein wert() darauf waere
// ein leerer String und LOESCHTE die Notiz.
// \u26a0\ufe0f `nutzlast` MUSS nur mit der Id anfangen. Steht dort schon ein
// `notiz: wert("ad-notiz")`, ist es im Bearbeiten-Modus ein leerer String --
// das Feld gibt es im Rumpf dann gar nicht -- und ein Speichern loescht die
// interne Notiz. Die if/else-Form allein faengt das nicht.
zusage("Die Nutzlast faengt NUR mit der Id an",
  APPJS.includes("const nutzlast = { id: anmEntwurf.id };"),
  (APPJS.match(/const nutzlast = \{[^}]*\}/) || [])[0]);
zusage("Im Bearbeiten-Modus werden bezahlt/Notiz NICHT mitgeschickt",
  /if \(felder\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,200}?nutzlast\.notiz = wert\("ad-notiz"\);/.test(APPJS));
zusage("Das Formular nimmt nur eingeschaltete Felder",
  APPJS.includes('FORMULAR_FELDER.filter((f) => f.fest || konf[f.id] === "optional" || konf[f.id] === "pflicht")'));
// ⚠️ Ja/Nein braucht DREI Zustaende, sonst wird aus "nicht beantwortet" ein "nein".
// ⚠️ ZWEIMAL: einmal fuer `janein`, einmal fuer `janein_text`. Ein blosses
// includes bliebe gruen, wenn eine der beiden Auswahlen den Zustand verliert --
// und aus "nicht beantwortet" wuerde dort still ein "nein".
zusage("Beide Ja/Nein-Auswahlen bieten \"nicht beantwortet\" an",
  (APPJS.match(/— nicht beantwortet —/g) || []).length === 2,
  String((APPJS.match(/— nicht beantwortet —/g) || []).length));
zusage("Bei Rechteverlust faellt der Modus zurueck",
  /raeumeWasNichtMehrErlaubtIst[\s\S]{0,3000}anmBearbeiten = false;/.test(APPJS));

// =========================================================================
abschnitt("12. Ja/Nein mit Nachfrage (Allergien, Medikamente ...)");
// =========================================================================

const JN = ["allergien", "medikamente", "krankheiten", "essenHinweis"];
JN.forEach((id) => zusage(`${id} ist vom Typ janein_text`, bau.FC_FELDER[id].typ === "janein_text",
  bau.FC_FELDER[id].typ));
// ⚠️ Gegenprobe: nicht ALLE Textfelder umstellen. Bei der Krankenkasse und der
// Anschrift gibt es nichts mit Ja/Nein zu beantworten.
zusage("krankenkasse bleibt ein Textfeld", bau.FC_FELDER.krankenkasse.typ === "text");
zusage("bemerkung bleibt ein Textfeld", bau.FC_FELDER.bemerkung.typ === "text");

// ⚠️ Die Liste steht doppelt (Worker wirksam, config.js fuer die Anzeige).
const cTypen = {};
[...CONFIGJS.matchAll(/\{ id: "(\w+)",\s+gruppe: "\w+",\s+label: "[^"]*",\s+typ: "(\w+)"/g)]
  .forEach((m) => { cTypen[m[1]] = m[2]; });
JN.forEach((id) => zusage(`...und config.js kennt ${id} auch so`, cTypen[id] === "janein_text", cTypen[id]));

// ---- Speichern -----------------------------------------------------------
const konfPflicht = { allergien: "pflicht", medikamente: "optional" };
const campJN = { felder: konfPflicht };

let p = bau.fcFelderPruefen(campJN, { kindVorname: "A", kindNachname: "B", elternName: "C",
  elternEmail: "c@example.org", allergienHat: "nein", allergien: "wird verworfen" });
zusage("\"nein\" wird gespeichert", p.allergienHat === "nein", p.allergienHat);
// ⚠️ Sonst stuende an der Anmeldung "nein" und daneben ein alter Text -- zwei
// Stellen, die dieselbe Frage unterschiedlich beantworten.
zusage("...und der Text wird dabei GELEERT", p.allergien === "", JSON.stringify(p.allergien));

p = bau.fcFelderPruefen(campJN, { kindVorname: "A", kindNachname: "B", elternName: "C",
  elternEmail: "c@example.org", allergienHat: "ja", allergien: "  Nüsse  " });
zusage("\"ja\" speichert beides", p.allergienHat === "ja" && p.allergien === "Nüsse", JSON.stringify(p));

// ⚠️ Ein PFLICHTfeld waere mit nur einem Wert gar nicht erfuellbar: "nein" saehe
// aus wie eine fehlende Antwort. Genau dafuer gibt es das Paar.
let jnFehler = null;
try {
  bau.fcFelderPruefen(campJN, { kindVorname: "A", kindNachname: "B", elternName: "C",
    elternEmail: "c@example.org" });
} catch (e) { jnFehler = e; }
zusage("Pflichtfrage ohne Antwort -> 400", !!jnFehler && jnFehler.status === 400, jnFehler && jnFehler.message);

// ⚠️ "ja" ohne Text ist KEINE Antwort -- unabhaengig von der Pflichtstufe. Sonst
// stuende am Platz "Allergien: (nichts)" und niemand wuesste, ob das ein
// Versehen war.
jnFehler = null;
try {
  bau.fcFelderPruefen({ felder: { medikamente: "optional" } }, { kindVorname: "A", kindNachname: "B",
    elternName: "C", elternEmail: "c@example.org", medikamenteHat: "ja", medikamente: "   " });
} catch (e) { jnFehler = e; }
zusage("\"ja\" ohne Text -> 400, auch bei einem FREIWILLIGEN Feld",
  !!jnFehler && jnFehler.status === 400, jnFehler && jnFehler.message);

// ⚠️ Ein erfundener Wert ist keine Antwort.
// ⚠️ An einem FREIWILLIGEN Feld pruefen: bei einem Pflichtfeld wirft die
// Pflichtpruefung, und dann belegt der Lauf nur, dass etwas fehlte -- nicht,
// dass der erfundene Wert verworfen wurde.
p = bau.fcFelderPruefen({ felder: { allergien: "optional" } }, { kindVorname: "A", kindNachname: "B",
  elternName: "C", elternEmail: "c@example.org", allergienHat: "vielleicht", allergien: "x" });
zusage("Ein erfundener Ja/Nein-Wert wird nicht angenommen", p.allergienHat === "", p.allergienHat);
zusage("...und der Text faellt mit weg", p.allergien === "", JSON.stringify(p.allergien));

// ---- Ende zu Ende ---------------------------------------------------------
frisch({ status: "offen", felder: { allergien: "pflicht", medikamente: "optional" } }, []);
r = await bau.handleFcAnmelden(anfrage(), { token: "tok1", datenschutz: true, agb: true, agbStand: "stand-1",
  daten: { kindVorname: "Max", kindNachname: "Muster", elternName: "E", elternEmail: "e@example.org",
           allergienHat: "ja", allergien: "Nüsse", medikamenteHat: "nein", medikamente: "egal" } },
  ENV, AUTH, {}, null);
zusage("Anmeldung mit Ja/Nein geht durch", r.status === 200, JSON.stringify(r.__json));
zusage("...\"ja\" landet mit Text in der Datei",
  anm0().allergienHat === "ja" && anm0().allergien === "Nüsse", JSON.stringify({ h: anm0().allergienHat, t: anm0().allergien }));
zusage("...\"nein\" landet ohne Text",
  anm0().medikamenteHat === "nein" && anm0().medikamente === "", JSON.stringify({ h: anm0().medikamenteHat, t: anm0().medikamente }));

// ⚠️ Die Eltern-Ansicht MUSS `<id>Hat` mitbekommen -- es steht nicht in
// FC_FELDER und faellt aus der Feldschleife heraus. Ohne das saehen sie beim
// Aendern eine unbeantwortete Frage, obwohl sie laengst geantwortet haben.
r = await bau.handleFcMeineInfo(anfrage(), { token: anm0().token }, ENV, AUTH, {});
zusage("meine-info gibt die Ja/Nein-Antwort mit",
  r.__json.anmeldung.allergienHat === "ja" && r.__json.anmeldung.medikamenteHat === "nein",
  JSON.stringify(r.__json.anmeldung));

// ---- Verwaltungs-Korrektur ------------------------------------------------
frisch({ felder: { allergien: "pflicht" } }, [{ allergienHat: "ja", allergien: "Nüsse" }]);
RECHT = { canEdit: true, canAdmin: true };
r = await bau.handleFcAnmeldungSpeichern(anfrage(),
  { campId: "c1", anmeldung: { id: "a1", felder: { allergienHat: "nein", allergien: "Nüsse" } } }, ENV, AUTH, {});
zusage("Die Verwaltung kann auf \"nein\" stellen", r.status === 200, JSON.stringify(r.__json));
zusage("...und der Text geht dabei mit weg",
  anm0().allergienHat === "nein" && anm0().allergien === "", JSON.stringify({ h: anm0().allergienHat, t: anm0().allergien }));
zusage("...beide Haelften stehen im Verlauf",
  (camp0().verlauf || []).some((e) => e.was === "geaendert-verwaltung" &&
    (e.felder || []).includes("allergienHat") && (e.felder || []).includes("allergien")),
  JSON.stringify(camp0().verlauf));

frisch({ felder: { allergien: "pflicht" } }, [{ allergienHat: "nein", allergien: "" }]);
r = await bau.handleFcAnmeldungSpeichern(anfrage(),
  { campId: "c1", anmeldung: { id: "a1", felder: { allergienHat: "ja", allergien: "" } } }, ENV, AUTH, {});
zusage("Verwaltung: \"ja\" ohne Text -> 400", r.status === 400, JSON.stringify(r.__json));
zusage("...und der alte Stand bleibt", anm0().allergienHat === "nein");

// ---- Client ---------------------------------------------------------------
zusage("oeffentlich.js rendert den neuen Typ", OEFFJS.includes('if (f.typ === "janein_text")'));
zusage("...der Textkasten haengt an der Antwort", OEFFJS.includes('data-detail-fuer='));
// ⚠️ Und er startet ZUGEKLAPPT, wenn die Antwort nicht "ja" ist. Steht er
// von Anfang an offen, ist der ganze Umbau umsonst -- die Eltern schreiben dann
// wieder "keine" hinein.
zusage("...und startet zugeklappt, wenn nicht \"ja\"",
  OEFFJS.includes('<div class="jn-detail${hatWert === "ja" ? "" : " fc-hidden"}"'));
// ⚠️ Ohne `:checked` laege immer der erste Knopf vor -- also ueberall "ja".
zusage("...gelesen wird mit :checked", OEFFJS.includes('[data-feld-hat="${CSS.escape(f.id)}"]:checked'));
zusage("...bei \"nein\" wird kein Text mitgeschickt",
  OEFFJS.includes('daten[f.id] = hat === "ja" ? String((el && el.value) || "").trim() : "";'));
// ⚠️ Das Aufklappen wird in baueFormular verdrahtet -- beide Eltern-Seiten
// bekommen es damit, ohne dass jemand daran denken muss.
zusage("Das Aufklappen haengt an baueFormular",
  /function baueFormular[\s\S]{0,3000}?querySelectorAll\("\[data-feld-hat\]"\)/.test(OEFFJS));
// ⚠️ Ohne das Paar stuende beim Aendern nie ein Knopf vorgewaehlt da.
zusage("baueFormular reicht BEIDE Werte durch",
  OEFFJS.includes('f.typ === "janein_text" ? { hat: w[f.id + "Hat"], text: w[f.id] } : w[f.id]'));

zusage("app.js liest die Ja/Nein-Haelfte beim Korrigieren",
  APPJS.includes('querySelectorAll("[data-af-hat]")'));
// ⚠️ Ein `janein_text` mit "nein" hat einen LEEREN Text und faellt sonst aus der
// Detailansicht -- eine beantwortete Frage saehe aus wie eine offene.
zusage("Die Detailansicht zeigt auch ein \"nein\"",
  APPJS.includes('if (hat === "nein") return zeile(f.label, "nein");'));
zusage("Der Export traegt \"nein\" statt einer leeren Zelle",
  /if \(f\.typ === "janein_text"\)[\s\S]{0,200}?return "nein";/.test(APPJS));

// =========================================================================
const gesamt = gruen + funde.length;
console.log(`\n${gruen}/${gesamt} Zusagen erfuellt.`);
if (funde.length) {
  console.log("\nFUNDE:");
  funde.forEach((f) => console.log("  - " + f.text + (f.detail ? "\n      " + f.detail : "")));
  process.exit(1);
}
