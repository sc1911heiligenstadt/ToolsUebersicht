// Pruefstand fuer die login-losen Fussballcamp-Aktionen im admin-worker.
//
// ⚠️ Der Code wird AUS DER DATEI GEZOGEN, nicht nachgebaut. Ein nachgebauter
// Pruefstand belegt nur, dass die Kopie tut, was man beim Abschreiben dachte.
// Findet die Extraktion ihre Marken nicht, bricht der Lauf ab statt gruen zu
// melden -- ein Pruefstand, der nichts mehr prueft, ist schlimmer als keiner.
//
// Beruehrt KEINE Live-Daten: readJson/writeJson und fetch sind Attrappen.
//
//   node test-fussballcamp.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Ohne Argument die Datei nebenan. Mit Argument eine andere Fassung -- so lässt
// sich auch prüfen, was in einem Commit steht, ohne das Arbeitsverzeichnis
// anzufassen (auf E:\ laufen mehrere Sitzungen auf denselben Repos).
const HIER = dirname(fileURLToPath(import.meta.url));
// ⚠️ Zeilenenden vereinheitlichen. Die Schnittmarken unten enthalten "\n";
// ein Auschecken mit CRLF (core.autocrlf=true) liess sie ins Leere greifen, und der
// Pruefstand brach beim Einlesen ab statt zu pruefen. Gemessen am 06.09.2026.
const QUELLE = readFileSync(process.argv[2] || join(HIER, "admin-worker.js"), "utf8")
  .replace(/\r\n/g, "\n");

function schneide(vonMarke, bisMarke, name) {
  const a = QUELLE.indexOf(vonMarke);
  if (a < 0) throw new Error("ABBRUCH: Startmarke fuer " + name + " nicht gefunden: " + vonMarke);
  const b = bisMarke === null ? QUELLE.length : QUELLE.indexOf(bisMarke, a);
  if (b < 0) throw new Error("ABBRUCH: Endmarke fuer " + name + " nicht gefunden: " + bisMarke);
  return QUELLE.slice(a, b);
}

const capStrQ = schneide("function capStr(v, max) {", "\n}\n", "capStr") + "\n}\n";
const kboQ    = schneide("function kboBremse(map, max, request) {", "function kboNormalize(", "kboBremse/kboHexToken");
// ⚠️ Der Fussballcamp-Schnitt laeuft bis zum DATEIENDE. Alles, was spaeter unten
// angehaengt wird, landet damit mit im Block -- so kam VK_POSTAUSGANG_URL herein und
// mit ihm ein Bezug nach draussen auf DAV_APPS; der Pruefstand starb seither beim
// Einlesen an einem ReferenceError. Also wird DAV_APPS ECHT mitgeschnitten (kein
// Nachbau), damit der Block fuer sich allein lauffaehig bleibt.
const davQ    = schneide("const DAV_APPS = {", "\n};\n", "DAV_APPS") + "\n};\n";
const fcQ     = schneide("const FUSSBALLCAMP_URL =", null, "Fussballcamp-Abschnitt");

for (const [was, wo] of [
  ["handleFcAnmelden", fcQ], ["handleFcMeineInfo", fcQ], ["fcBestaetigungMail", fcQ],
  ["FC_LINK_ERNEUT_PAUSE_MS", fcQ], ["fcFelderPruefen", fcQ],
  ["function kboHexToken", kboQ], ["function kboBremse", kboQ]
]) {
  if (!wo.includes(was)) throw new Error("ABBRUCH: " + was + " fehlt im gezogenen Code.");
}

// ---- Attrappen -----------------------------------------------------------
let DOC = null;
let MAILS = [];
let MAIL_KAPUTT = false;

const kopf = `
class ConflictError extends Error {}
function json(obj, status, corsHeaders) { return { __json: obj, status }; }
const NOTIFY_FROM_EMAIL = "test@example.org";
const NOTIFY_FROM_NAME = "Test";
const USER_ART_SPIELER = "spieler";
function aufgabenAnzeigeName() { return ""; }
async function getVerifiedSession() { return null; }
async function userMayAccessTool() { return false; }
async function resolveEditPermission() { return false; }
async function resolveAdminPermission() { return false; }
async function readJson(url, auth, fallback) { return JSON.parse(JSON.stringify(__DOC() ?? fallback)); }
async function readJsonWithRev(url, auth, fallback) { return { data: JSON.parse(JSON.stringify(__DOC() ?? fallback)), rev: "r1" }; }
async function writeJson(url, auth, doc, rev) { __SETDOC(JSON.parse(JSON.stringify(doc))); }
`;

const bau = new Function("__DOC", "__SETDOC", "fetch",
  kopf + davQ + "\n" + capStrQ + "\n" + kboQ + "\n" + fcQ +
  "\nreturn { handleFcAnmelden, handleFcMeineInfo, fcLeer, kboHexToken, FC_LINK_ERNEUT_PAUSE_MS };"
)(
  () => DOC,
  (d) => { DOC = d; },
  async (url, opt) => {
    if (MAIL_KAPUTT) return { ok: false };
    MAILS.push(JSON.parse(opt.body));
    return { ok: true };
  }
);

// ---- Zusagen -------------------------------------------------------------
let gruen = 0, rot = 0;
function zusage(nr, text, bedingung) {
  if (bedingung) { gruen++; console.log("  ok  " + nr + " " + text); }
  else { rot++; console.log("  ✗   " + nr + " " + text); }
}

const ENV = { BREVO_API_KEY: "k" };
const anfrage = (ip) => ({ headers: { get: (h) => (h === "CF-Connecting-IP" ? ip : null) } });

function frischesCamp(campToken) {
  const doc = bau.fcLeer();
  doc.einstellungen.iban = "DE02120300000000202051";
  doc.einstellungen.agbText = "Bedingungen";
  doc.einstellungen.agbStand = "stand-1";
  doc.camps.push({
    id: "c1", token: campToken, name: "Sommercamp", status: "offen",
    vonDatum: "2026-12-01", bisDatum: "2026-12-05",
    taeglichVon: "09:00", taeglichBis: "16:00", ort: "Sportplatz",
    plaetze: 20, preis: 5000,
    felder: { allergien: "pflicht", elternTelefon: "optional" },
    anmeldungVon: "", anmeldungBis: "", tage: [], verlauf: [], anmeldungen: []
  });
  return doc;
}

const anmeldeKoerper = (campToken, extra) => Object.assign({
  token: campToken, datenschutz: true, agb: true, agbStand: "stand-1",
  daten: {
    kindVorname: "Lena", kindNachname: "Muster",
    elternName: "Anja Muster", elternEmail: "anja.muster@example.org",
    elternTelefon: "0170 1234567",
    // ⚠️ "allergien" ist im Katalog FC_FELDER vom Typ "janein_text" und braucht
    // ZWEI Werte: den Schalter allergienHat und den Text. Bis zum 06.09.2026 stand
    // hier nur der Text -- die Attrappe hatte die Form, die der Lesecode einmal
    // erwartete, nicht die, die das Formular wirklich schickt. Der Worker wies jede
    // Anmeldung mit "Es fehlen noch Pflichtangaben" ab und der ganze Pruefstand war rot.
    allergienHat: "ja", allergien: "Erdnuss — Notfallset im Rucksack"
  }
}, extra || {});

// =========================================================================
console.log("\nA — Erste Anmeldung");
// =========================================================================
const CAMP = bau.kboHexToken(24);
DOC = frischesCamp(CAMP);
MAILS = [];

const a1 = await bau.handleFcAnmelden(anfrage("203.0.113.10"), anmeldeKoerper(CAMP), ENV, "auth", {}, null);
zusage("A1", "Die erste Anmeldung wird angenommen", a1.status === 200 && a1.__json.ok === true);
zusage("A2", "Sie ist KEIN Doppel", a1.__json.schonDa === false);
zusage("A3", "Der Aendern-Link kommt zurueck", /meine-anmeldung\.html\?a=[0-9a-f]{48}/.test(a1.__json.aendernLink || ""));
zusage("A4", "Die Zahlungsangaben kommen mit", !!(a1.__json.zahlung && a1.__json.zahlung.iban));
zusage("A5", "Eine Bestaetigungsmail ging raus", MAILS.length === 1);
zusage("A6", "Die Mail ging an die eingegebene Adresse",
       !!MAILS[0] && MAILS[0].to[0].email === "anja.muster@example.org");

const ECHTER_TOKEN = /[?&]a=([0-9a-f]{48})/.exec(a1.__json.aendernLink)[1];

// =========================================================================
console.log("\nB — Zweites Absenden gibt NICHTS heraus");
// =========================================================================
MAILS = [];
// Gross/klein anders geschrieben, damit die Doppel-Erkennung wirklich greift.
const b1 = await bau.handleFcAnmelden(anfrage("198.51.100.5"), anmeldeKoerper(CAMP, {
  daten: {
    kindVorname: "LENA", kindNachname: "muster",
    elternName: "Wer auch immer", elternEmail: "Anja.Muster@Example.ORG",
    // ⚠️ allergienHat gehoert dazu -- dieser Block ersetzt "daten" ganz und
    // erbt den Vorgabewert nicht. Ohne den Schalter wies fcFelderPruefen die
    // Anfrage mit "Pflichtangaben fehlen" ab, BEVOR die Doppel-Erkennung dran war.
    // B1 lief rot -- und B2 bis B7 wurden gruen, weil ein 400er-Fehlerkoerper die
    // abgefragten Felder ohnehin nicht hat. Falsches Gruen ist schlimmer als Rot.
    allergienHat: "ja", allergien: "egal"
  }
}), ENV, "auth", {}, null);

const b = b1.__json;
zusage("B1", "Der Server meldet 'schonDa'", b1.status === 200 && b.schonDa === true);
zusage("B2", "KEIN Aendern-Link in der Antwort", b.aendernLink === undefined);
zusage("B3", "Der echte Token steht NIRGENDS in der Antwort",
       !JSON.stringify(b).includes(ECHTER_TOKEN));
zusage("B4", "KEIN Kindername in der Antwort", b.kind === undefined);
zusage("B5", "KEINE Mailadresse in der Antwort", b.email === undefined);
zusage("B6", "KEIN Status / Wartelistenplatz", b.status === undefined && b.wartePlatz === undefined);
zusage("B7", "KEINE Zahlungsangaben", b.zahlung === undefined);
zusage("B8", "Die Antwort hat genau zwei Felder (ok, schonDa)",
       Object.keys(b).sort().join(",") === "ok,schonDa");
zusage("B9", "Es entstand KEINE zweite Anmeldung", DOC.camps[0].anmeldungen.length === 1);
zusage("B10", "Die echte Anmeldung ist unveraendert",
       DOC.camps[0].anmeldungen[0].elternName === "Anja Muster" &&
       DOC.camps[0].anmeldungen[0].allergien === "Erdnuss — Notfallset im Rucksack");

// =========================================================================
console.log("\nC — Der Link geht per Mail an die HINTERLEGTE Adresse");
// =========================================================================
zusage("C1", "Genau eine Mail ging raus", MAILS.length === 1);
zusage("C2", "Sie ging an die gespeicherte Adresse, nicht an den Absender",
       !!MAILS[0] && MAILS[0].to[0].email === "anja.muster@example.org");
zusage("C3", "Sie enthaelt den echten Aendern-Link",
       !!MAILS[0] && MAILS[0].textContent.includes(ECHTER_TOKEN));
zusage("C4", "Der Merker steht in der Anmeldung", !!DOC.camps[0].anmeldungen[0].linkErneutAm);

// =========================================================================
console.log("\nD — Die Pause verhindert eine Mailflut");
// =========================================================================
MAILS = [];
for (let i = 0; i < 5; i++) {
  await bau.handleFcAnmelden(anfrage("198.51.100." + (20 + i)), anmeldeKoerper(CAMP), ENV, "auth", {}, null);
}
zusage("D1", "Fuenf weitere Versuche loesen KEINE Mail aus", MAILS.length === 0);
zusage("D2", "Und legen keine zweite Anmeldung an", DOC.camps[0].anmeldungen.length === 1);

// Merker kuenstlich altern lassen -- die Pause ist abgelaufen.
DOC.camps[0].anmeldungen[0].linkErneutAm =
  new Date(Date.now() - bau.FC_LINK_ERNEUT_PAUSE_MS - 1000).toISOString();
MAILS = [];
await bau.handleFcAnmelden(anfrage("198.51.100.30"), anmeldeKoerper(CAMP), ENV, "auth", {}, null);
zusage("D3", "Nach Ablauf der Pause geht der Link wieder raus", MAILS.length === 1);

// =========================================================================
console.log("\nE — Klemmt der Versand, oeffnet das die Bremse nicht");
// =========================================================================
DOC.camps[0].anmeldungen[0].linkErneutAm =
  new Date(Date.now() - bau.FC_LINK_ERNEUT_PAUSE_MS - 1000).toISOString();
MAIL_KAPUTT = true; MAILS = [];
await bau.handleFcAnmelden(anfrage("198.51.100.40"), anmeldeKoerper(CAMP), ENV, "auth", {}, null);
MAIL_KAPUTT = false;
const merkerNachFehler = DOC.camps[0].anmeldungen[0].linkErneutAm;
MAILS = [];
await bau.handleFcAnmelden(anfrage("198.51.100.41"), anmeldeKoerper(CAMP), ENV, "auth", {}, null);
zusage("E1", "Der Merker wurde trotz Mailfehler gesetzt",
       Date.now() - Date.parse(merkerNachFehler) < bau.FC_LINK_ERNEUT_PAUSE_MS);
zusage("E2", "Der naechste Versuch schickt darum nichts nach", MAILS.length === 0);

// =========================================================================
console.log("\nF — Der echte Weg funktioniert weiter");
// =========================================================================
const f1 = await bau.handleFcMeineInfo(anfrage("203.0.113.10"), { token: ECHTER_TOKEN }, ENV, "auth", {});
zusage("F1", "Mit dem echten Token sehen die Eltern ihre Anmeldung",
       f1.status === 200 && f1.__json.anmeldung.allergien === "Erdnuss — Notfallset im Rucksack");
const f2 = await bau.handleFcMeineInfo(anfrage("203.0.113.10"), { token: bau.kboHexToken(24) }, ENV, "auth", {});
zusage("F2", "Ein erfundener Token bekommt 404", f2.status === 404);

// Ein zweites, anderes Kind derselben Familie bleibt eine eigene Anmeldung.
MAILS = [];
const f3 = await bau.handleFcAnmelden(anfrage("203.0.113.11"), anmeldeKoerper(CAMP, {
  daten: {
    kindVorname: "Jonas", kindNachname: "Muster",
    elternName: "Anja Muster", elternEmail: "anja.muster@example.org",
    // "keine Allergien" heisst beim Typ janein_text: Schalter auf "nein", kein
    // Text. Der Worker raeumt den Text bei "nein" ohnehin weg -- damit prueft
    // dieser Fall nebenbei auch den Nein-Zweig von fcFelderPruefen mit.
    allergienHat: "nein"
  }
}), ENV, "auth", {}, null);
zusage("F3", "Ein Geschwisterkind wird normal angemeldet",
       f3.__json.schonDa === false && DOC.camps[0].anmeldungen.length === 2);
zusage("F4", "Und bekommt seinen eigenen Link",
       !String(f3.__json.aendernLink).includes(ECHTER_TOKEN));

// Eine ABGESAGTE Anmeldung gilt nicht als Doppel.
DOC.camps[0].anmeldungen[0].status = "abgesagt";
const f5 = await bau.handleFcAnmelden(anfrage("203.0.113.12"), anmeldeKoerper(CAMP), ENV, "auth", {}, null);
zusage("F5", "Nach einer Absage kann dasselbe Kind neu angemeldet werden",
       f5.__json.schonDa === false && DOC.camps[0].anmeldungen.length === 3);

// =========================================================================
console.log("\n" + gruen + " Zusagen gruen, " + rot + " rot.");
if (rot) process.exit(1);
