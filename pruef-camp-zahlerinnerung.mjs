// Pruefstand: die Zahlungserinnerung haengt an ZWEI Bedingungen.
//
// Bis 2026-08-28 haengte sie allein an "X Tage nach der Anmeldung". Wer sich
// drei Monate vor dem Camp anmeldete, bekam nach vierzehn Tagen eine
// Zahlungsaufforderung -- obwohl der Beitrag erst eine Woche vor Campbeginn
// faellig ist. Seitdem muss zusaetzlich die Zahlfrist in Sichtweite sein.
//
// ⚠️ Der Code wird AUS DER DATEI GEZOGEN. Fehlt eine Marke, bricht der Lauf ab.
//
//   node pruef-camp-zahlerinnerung.mjs [pfad-zu-admin-worker.js]
import { readFileSync as readFileSyncRoh } from "node:fs";
// ⚠️ Zeilenenden beim Einlesen auf LF normalisieren. Die Schnittmarken unten
// ("\n];\n" und Verwandte) gibt es in einer CRLF-Datei nicht -- und git liefert
// mit core.autocrlf=true und ohne .gitattributes genau die aus. Ohne diese
// Huelle bricht der Pruefstand nach jedem frischen Checkout mit "Endmarke
// fehlt" ab und prueft KEINE EINZIGE Zusage -- der Absturz sieht dabei aus wie
// ein Fehler am geprueften Code. Bugjagd 04.09.2026: 9 von 11 Camp-Pruefstaenden.
const readFileSync = (p, e) => {
  const r = readFileSyncRoh(p, e);
  return typeof r === "string" ? r.replace(/\r\n/g, "\n") : r;
};

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HIER = dirname(fileURLToPath(import.meta.url));
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
// ⚠️ Der Mail-Drossler steht seit dem 05.09.2026 OBERHALB des
// Fussballcamp-Abschnitts, weil Busplan und Vereinskalender ihn mitbenutzen.
// Er wird deshalb eigens dazugeschnitten -- nicht abgeschrieben.
const haeppchenQ = schneide("const MAIL_HAEPPCHEN =", "// Titel und Ziel stehen in PUSH_ANLAESSE", "mailsHaeppchenweise");


// ⚠️ Diese Marken nageln die VERDRAHTUNG fest, nicht nur das Verhalten. Ohne sie
// liefen alle Zusagen unten gruen durch, waehrend die zweite Bedingung gar nicht
// mehr im Erinnerungslauf steht.
//
// ⚠️ Sie sind bewusst LOCKER gefasst — die genaue Vergleichsform steht
// absichtlich NICHT drin. Eine Marke, die die ganze Zeile zeichengenau
// verlangt, laesst jede Mutation an dieser Zeile schon bei der Extraktion
// abbrechen: der Lauf wird rot, aber das VERHALTEN wurde nie geprueft. Beim
// ersten Anlauf sahen so fuenf Mutationen wie gefangen aus, obwohl keine
// einzige Zusage sie wirklich fing.
for (const marke of [
  "function fcTagPlusUtc(tag, tage) {",
  "const FC_ZAHL_ERINNERUNG_VORLAUF",
  "const frist = fcZahlfrist(camp);",
  "fcTagPlusUtc(frist,"
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
return { fcLeer, fcNormalisiere, fcHeuteBerlin, fcTagPlusUtc, fcZahlfrist,
         FC_ZAHL_ERINNERUNG_VORLAUF, FC_ZAHLFRIST_TAGE,
         handleFcAnmelden, fcErinnerungslauf };
`;

const bau = new Function("__DOC", "__SETDOC", "__RECHT", "fetch", "crypto",
  kopf + capStrQ + "\n" + kboQ + "\n" + haeppchenQ + "\n" + fcQ + "\n" + fuss
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
const anfrage = () => ({ headers: { get: (h) => (h === "CF-Connecting-IP" ? "10.0.0." + (++ipZaehler) : null) } });

const heute = bau.fcHeuteBerlin();
const inTagen = (n) => new Date(Date.parse(heute + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

function frisch(campExtra) {
  DOC = bau.fcLeer();
  DOC.einstellungen.iban = "DE02120300000000202051";
  DOC.einstellungen.kontoinhaber = "1. SC 1911 Heiligenstadt e.V.";
  DOC.einstellungen.agbText = "Bedingungen";
  DOC.einstellungen.agbStand = "stand-1";
  DOC.einstellungen.zahlErinnerung = true;
  DOC.einstellungen.zahlErinnerungTage = 14;
  DOC.camps.push(Object.assign({
    id: "c1", token: "tok1", name: "Herbstcamp 2026", status: "offen",
    vonDatum: inTagen(60), bisDatum: inTagen(64),
    taeglichVon: "09:00", taeglichBis: "16:00", ort: "Sportplatz",
    plaetze: 20, preis: 180, preisFrueh: 0, preisFruehBis: "",
    zusatzfrage: "", felder: { allergien: "pflicht" },
    anmeldungVon: "", anmeldungBis: "", tage: [], verlauf: [], anmeldungen: []
  }, campExtra || {}));
  bau.fcNormalisiere(DOC);
  MAILS = [];
  RECHT = { canEdit: true, canAdmin: true };
}
const camp = () => DOC.camps[0];
const anmKoerper = () => ({
  token: "tok1", datenschutz: true, agb: true, agbStand: "stand-1",
  daten: { kindVorname: "Lena", kindNachname: "Muster",
           elternName: "Anja Muster", elternEmail: "eltern@example.org",
           // ⚠️ Seit `janein_text` ist „keine“ die Antwort „nein“ auf die
           // Frage, keine Eingabe mehr.
           allergienHat: "nein", allergien: "" }
});

// Anmeldung anlegen und so datieren, dass Bedingung 1 (Schonfrist) erfuellt ist.
async function anmeldenVorTagen(tage) {
  await bau.handleFcAnmelden(anfrage(), anmKoerper(), ENV, AUTH, {}, null);
  camp().anmeldungen[0].erstelltAm = inTagen(-tage) + "T10:00:00Z";
}
async function lauf() { MAILS = []; await bau.fcErinnerungslauf(ENV, AUTH, "zahlung", ""); return MAILS.length; }

// =========================================================================
abschnitt("1. Der Helfer fcTagPlusUtc");
// =========================================================================
zusage(1.1, "plus 7 Tage", bau.fcTagPlusUtc("2026-10-13", 7) === "2026-10-20");
zusage(1.2, "minus 7 Tage", bau.fcTagPlusUtc("2026-10-20", -7) === "2026-10-13");
zusage(1.3, "ueber die Sommerzeitgrenze bleibt es bei genau 7 Tagen",
  bau.fcTagPlusUtc("2026-03-26", 7) === "2026-04-02");
zusage(1.4, "ueber die Winterzeitgrenze ebenso",
  bau.fcTagPlusUtc("2026-10-25", 7) === "2026-11-01");
zusage(1.5, "ueber den Jahreswechsel", bau.fcTagPlusUtc("2025-12-27", 7) === "2026-01-03");
zusage(1.6, "ueber den 29.02.", bau.fcTagPlusUtc("2028-02-23", 7) === "2028-03-01");
zusage(1.7, "plus 0 gibt den Tag selbst", bau.fcTagPlusUtc("2026-10-20", 0) === "2026-10-20");
zusage(1.8, "Muell statt Datum: leer, kein Absturz", bau.fcTagPlusUtc("kaputt", 7) === "");
zusage(1.9, "leere Eingabe: leer", bau.fcTagPlusUtc("", 7) === "");
zusage("1.10", "null: leer", bau.fcTagPlusUtc(null, 7) === "");
zusage("1.11", "unmoegliches Datum: leer", bau.fcTagPlusUtc("2026-13-45", 7) === "");
// ⚠️ Der Kern: dieselbe Rechnung wie fcZahlfrist, nur allgemein. Laufen die
// beiden auseinander, stimmt die Erinnerung nicht mehr zur genannten Frist.
zusage("1.12", "deckungsgleich mit fcZahlfrist ueber ein ganzes Jahr", (() => {
  for (let i = 0; i < 365; i++) {
    const tag = inTagen(i);
    if (bau.fcZahlfrist({ vonDatum: tag }) !== bau.fcTagPlusUtc(tag, -bau.FC_ZAHLFRIST_TAGE)) return false;
  }
  return true;
})());

// =========================================================================
abschnitt("2. Der Fix: nicht Monate vor der Faelligkeit erinnern");
// =========================================================================
// Das ist der ganze Anlass. Anmeldung vor 30 Tagen (Schonfrist 14 laengst um),
// Camp aber erst in 60 Tagen -- die Frist ist noch 53 Tage hin.
frisch();
await anmeldenVorTagen(30);
zusage(2.1, "Camp in 60 Tagen, Anmeldung vor 30: KEINE Erinnerung", (await lauf()) === 0);
zusage(2.2, "und der Merker wurde NICHT gesetzt (sie kommt spaeter noch)",
  !camp().anmeldungen[0].zahlErinnertAm);

frisch({ vonDatum: inTagen(30), bisDatum: inTagen(34) });
await anmeldenVorTagen(30);
zusage(2.3, "Camp in 30 Tagen (Frist in 23): noch keine Erinnerung", (await lauf()) === 0);

frisch({ vonDatum: inTagen(11), bisDatum: inTagen(15) });
await anmeldenVorTagen(30);
zusage(2.4, "Camp in 11 Tagen (Frist in 4): noch nicht", (await lauf()) === 0);

frisch({ vonDatum: inTagen(10), bisDatum: inTagen(14) });
await anmeldenVorTagen(30);
zusage(2.5, "Camp in 10 Tagen (Frist in genau 3): JETZT geht sie raus", (await lauf()) === 1);

frisch({ vonDatum: inTagen(7), bisDatum: inTagen(11) });
await anmeldenVorTagen(30);
zusage(2.6, "Camp in 7 Tagen (Frist ist heute): geht raus", (await lauf()) === 1);

frisch({ vonDatum: inTagen(2), bisDatum: inTagen(6) });
await anmeldenVorTagen(30);
zusage(2.7, "Frist ist ABGELAUFEN: geht erst recht raus", (await lauf()) === 1);

// =========================================================================
abschnitt("3. Bedingung 1 bleibt: die spaetere der beiden bindet");
// =========================================================================
frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(2);
zusage(3.1, "Frist ist nah, aber die Anmeldung ist erst 2 Tage alt: nichts",
  (await lauf()) === 0);

frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
DOC.einstellungen.zahlErinnerungTage = 1;
await anmeldenVorTagen(2);
zusage(3.2, "mit Schonfrist 1 geht dieselbe Lage raus", (await lauf()) === 1);

frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(14);
zusage(3.3, "Schonfrist genau erreicht (14 von 14 Tagen)", (await lauf()) === 1);

frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(13);
zusage(3.4, "einen Tag zu frueh: nichts", (await lauf()) === 0);

// ⚠️ Ein unlesbares `erstelltAm` muss die Schonfrist SCHLIESSEN, nicht oeffnen.
// Andersherum bekaeme eine Anmeldung mit kaputtem Zeitstempel die Erinnerung
// sofort — und niemand faende den Grund.
frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(30);
camp().anmeldungen[0].erstelltAm = "kaputt-kein-datum";
zusage(3.5, "unlesbare Anmeldezeit: KEINE Erinnerung", (await lauf()) === 0);

frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(30);
camp().anmeldungen[0].erstelltAm = "";
zusage(3.6, "fehlende Anmeldezeit: ebenso nichts", (await lauf()) === 0);

// =========================================================================
abschnitt("4. Rueckfall: Camp ohne brauchbares Datum");
// =========================================================================
// ⚠️ Ohne Frist bleibt es bei Bedingung 1 -- lieber einmal zu frueh erinnern
// als gar nicht. Eine ausbleibende Zahlungserinnerung faellt niemandem auf.
frisch();
await anmeldenVorTagen(30);
camp().vonDatum = "";
zusage(4.1, "Camp ohne vonDatum: Bedingung 1 allein entscheidet, Mail geht raus",
  (await lauf()) === 1);

frisch();
await anmeldenVorTagen(30);
camp().vonDatum = "kaputt";
zusage(4.2, "kaputtes Datum: ebenso, und kein Absturz", (await lauf()) === 1);

frisch();
await anmeldenVorTagen(2);
camp().vonDatum = "";
zusage(4.3, "ohne Frist gilt die Schonfrist trotzdem", (await lauf()) === 0);

// =========================================================================
abschnitt("5. Die alten Wachen sind unberuehrt");
// =========================================================================
frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(30);
DOC.einstellungen.zahlErinnerung = false;
zusage(5.1, "Erinnerung abgeschaltet: nichts", (await lauf()) === 0);

frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(30);
camp().anmeldungen[0].bezahlt = true;
zusage(5.2, "schon bezahlt: nichts", (await lauf()) === 0);

frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(30);
camp().anmeldungen[0].betrag = 0;
zusage(5.3, "Freiplatz (Betrag 0): nichts, obwohl das Camp Geld kostet",
  (await lauf()) === 0);

frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(30);
camp().anmeldungen[0].status = "warteliste";
zusage(5.4, "auf der Warteliste: nichts", (await lauf()) === 0);

frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(30);
camp().anmeldungen[0].elternEmail = "";
zusage(5.5, "ohne Mailadresse: nichts", (await lauf()) === 0);

frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(30);
camp().status = "entwurf";
zusage(5.6, "Entwurf: nichts", (await lauf()) === 0);

// =========================================================================
abschnitt("6. Genau einmal je Familie");
// =========================================================================
frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(30);
const ersteRunde = await lauf();
const merker = camp().anmeldungen[0].zahlErinnertAm;
const zweiteRunde = await lauf();
zusage(6.1, "erste Runde: eine Mail", ersteRunde === 1);
zusage(6.2, "der Merker steht danach", !!merker);
zusage(6.3, "zweite Runde: keine zweite Mail", zweiteRunde === 0);

// =========================================================================
abschnitt("7. Was in der Mail steht");
// =========================================================================
frisch({ vonDatum: inTagen(8), bisDatum: inTagen(12) });
await anmeldenVorTagen(30);
await lauf();
const m = MAILS[0] || {};
const text = String(m.textContent || "");
zusage(7.1, "Betreff nennt das Camp", m.subject === "Beitrag noch offen: Herbstcamp 2026");
zusage(7.2, "geht an die Eltern-Adresse", (m.to || [])[0] && m.to[0].email === "eltern@example.org");
zusage(7.3, "der Kindname steht drin", text.includes("Lena Muster"));
// ⚠️ Die Frist ist an diesem Tag noch offen (Camp in 8 Tagen, Frist morgen) --
// sie MUSS also als Datum dastehen, nicht als "möglichst umgehend".
zusage(7.4, "die noch offene Frist steht als Datum da", /bis zum \d{2}\.\d{2}\.\d{4}/.test(text));
zusage(7.5, "der Verwendungszweck steht drin", text.includes("Herbstcamp 2026, Lena Muster"));

frisch({ vonDatum: inTagen(2), bisDatum: inTagen(6) });
await anmeldenVorTagen(30);
await lauf();
const textSpaet = String((MAILS[0] || {}).textContent || "");
zusage(7.6, "abgelaufene Frist: 'möglichst umgehend' statt eines vergangenen Datums",
  textSpaet.includes("möglichst umgehend") && !/bis zum \d{2}\./.test(textSpaet));

// =========================================================================
console.log("\n" + "=".repeat(60));
console.log(gruen + " von " + (gruen + rot) + " Zusagen erfuellt.");
if (rot) { console.log(rot + " ROT."); process.exit(1); }
