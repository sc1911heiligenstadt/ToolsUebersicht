// Pruefstand: die Bestaetigung, wenn Eltern selbst absagen.
//
// Bis 2026-08-28 bekamen sie gar nichts -- der Klick auf "Anmeldung absagen"
// blieb ohne jede Rueckmeldung per Mail. Der heikle Teil ist nicht der Versand,
// sondern der Geld-Absatz: er darf weder eine Rueckzahlung versprechen, die
// Punkt 4 der Teilnahmebedingungen nicht hergibt, noch einen Verzicht
// aussprechen, den niemand erklaert hat.
//
// ⚠️ Der Code wird AUS DER DATEI GEZOGEN. Fehlt eine Marke, bricht der Lauf ab.
//
//   node pruef-camp-absage.mjs [pfad-zu-admin-worker.js]
import { readFileSync } from "node:fs";

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

// ⚠️ Diese Marken nageln die VERDRAHTUNG fest. Ohne die letzte liefen alle
// Zusagen zum Mailtext gruen durch, waehrend der Handler die Mail nie ruft.
for (const marke of [
  "function fcErstattungsStufe(camp) {",
  "function fcTageBisCamp(camp) {",
  "function fcAbsageGeldBlock(camp, a, quelle) {",
  "async function fcAbsageMail(env, camp, a, einst, quelle) {",
  // ⚠️⚠️ Diese drei sind BEWUSST locker. Sie sollen nur belegen, DASS der Aufruf
  // und die beiden Weichen im Code stehen -- nicht, wie sie formuliert sind.
  // Beim ersten Anlauf standen hier die vollen Zeilen (`…, "verwaltung")` und
  // `const willMail = body.mail === true;`). Ergebnis: fuenf Mutationen an genau
  // diesen Zeilen sprengten die Extraktion und wurden als "gefangen" gezaehlt,
  // ohne dass eine einzige Verhaltenszusage lief. Derselbe Fehler wie in
  // pruef-camp-zahlerinnerung.mjs -- er sieht in der Bilanz gut aus und ist
  // genau deshalb gefaehrlich.
  "fcAbsageMail(env, mailDaten.camp",
  // Seit dem Umbau auf Mailvorlagen (2026-09-03) heisst die Weiche nicht mehr
  // `const vonVerwaltung`, sondern waehlt die Vorlage aus. Bewusst weiter LOCKER:
  // nur der Vergleich, nicht die ganze Zeile.
  'quelle === "verwaltung"',
  "const willMail ="
]) {
  if (!fcQ.includes(marke)) throw new Error("ABBRUCH: " + marke + " fehlt im gezogenen Code.");
}

// ---- Attrappen -----------------------------------------------------------
let DOC = null;
let RECHT = { canEdit: true, canAdmin: true };
let MAILS = [];
let MAIL_KAPUTT = false;

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
return { fcLeer, fcNormalisiere, fcHeuteBerlin, fcEuro, fcBetrag,
         fcTageBisCamp, fcErstattungsStufe, fcAbsageGeldBlock, fcAbsageMail,
         FC_ERSTATTUNG_VOLL_AB_TAGEN, FC_ERSTATTUNG_HALB_AB_TAGEN,
         handleFcAnmelden, handleFcMeineAbsagen, handleFcAbsagen, handleFcMeineSpeichern };
`;

const bau = new Function("__DOC", "__SETDOC", "__RECHT", "fetch", "crypto",
  kopf + capStrQ + "\n" + kboQ + "\n" + fcQ + "\n" + fuss
)(
  () => DOC, (d) => { DOC = d; }, () => RECHT,
  async (url, opt) => {
    if (MAIL_KAPUTT) throw new Error("Brevo antwortet nicht");
    try { MAILS.push(JSON.parse(opt.body)); } catch (_) {}
    return { ok: true };
  },
  globalThis.crypto
);

// ---- Zusagen -------------------------------------------------------------
let gruen = 0, rot = 0;
function zusage(nr, text, bedingung) {
  if (bedingung) { gruen++; console.log("  ok  " + nr + " " + text); }
  else { rot++; console.log("  X   " + nr + " " + text); }
}
function abschnitt(t) { console.log("\n" + t); }

// ⚠️ Zeilenumbrueche sind Formatierung, kein Inhalt. Ohne dieses Flachklopfen
// wird eine Zusage rot, sobald ein Satz im Mailtext anders umbricht -- und das
// sieht aus wie ein Fund, ist aber ein Testfehler.
const flach = (s) => String(s || "").replace(/\s+/g, " ").trim();

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
  DOC.einstellungen.kontaktName = "dem Nachwuchsbereich";
  DOC.einstellungen.kontaktEmail = "nachwuchs@example.org";
  DOC.einstellungen.agbText = "Bedingungen";
  DOC.einstellungen.agbStand = "stand-1";
  DOC.camps.push(Object.assign({
    id: "c1", token: "tok1", name: "Herbstcamp 2026", status: "offen",
    vonDatum: inTagen(60), bisDatum: inTagen(64),
    taeglichVon: "09:00", taeglichBis: "16:00", ort: "Sportplatz",
    plaetze: 20, preis: 18000, preisFrueh: 0, preisFruehBis: "",
    zusatzfrage: "", felder: { allergien: "pflicht" },
    anmeldungVon: "", anmeldungBis: "", tage: [], verlauf: [], anmeldungen: []
  }, campExtra || {}));
  bau.fcNormalisiere(DOC);
  MAILS = [];
  MAIL_KAPUTT = false;
  RECHT = { canEdit: true, canAdmin: true };
}
const camp = () => DOC.camps[0];
const anm = () => camp().anmeldungen[0];
const anmKoerper = () => ({
  token: "tok1", datenschutz: true, agb: true, agbStand: "stand-1",
  daten: { kindVorname: "Lena", kindNachname: "Muster",
           elternName: "Anja Muster", elternEmail: "eltern@example.org",
           allergien: "keine" }
});

async function anmelden() {
  await bau.handleFcAnmelden(anfrage(), anmKoerper(), ENV, AUTH, {}, null);
  MAILS = [];                       // die Bestaetigungsmail interessiert hier nicht
  return anm().token;
}
async function absagen(tok) {
  return bau.handleFcMeineAbsagen(anfrage(), { token: tok }, ENV, AUTH, {});
}

// =========================================================================
abschnitt("1. Die Erstattungsstufe nach Punkt 4 der Teilnahmebedingungen");
// =========================================================================
const stufe = (tage) => bau.fcErstattungsStufe({ vonDatum: inTagen(tage) });
zusage(1.1, "Grenzwerte stehen als Konstanten (28 / 7)",
  bau.FC_ERSTATTUNG_VOLL_AB_TAGEN === 28 && bau.FC_ERSTATTUNG_HALB_AB_TAGEN === 7);
zusage(1.2, "100 Tage vorher: volle Erstattung", stufe(100) === 100);
zusage(1.3, "29 Tage vorher: volle Erstattung", stufe(29) === 100);
zusage(1.4, "genau 28 Tage vorher: NOCH volle Erstattung ('bis einschliesslich')", stufe(28) === 100);
zusage(1.5, "27 Tage vorher: die Haelfte", stufe(27) === 50);
zusage(1.6, "8 Tage vorher: die Haelfte", stufe(8) === 50);
zusage(1.7, "genau 7 Tage vorher: NOCH die Haelfte ('bis einschliesslich')", stufe(7) === 50);
zusage(1.8, "6 Tage vorher: keine Erstattung", stufe(6) === 0);
zusage(1.9, "am Camptag selbst: keine Erstattung", stufe(0) === 0);
zusage("1.10", "nach dem Camp: keine Erstattung", stufe(-5) === 0);
// ⚠️ null ist NICHT 0. Ohne Datum darf die Mail keine Quote behaupten.
zusage("1.11", "Camp ohne Datum: null, nicht 0", bau.fcErstattungsStufe({}) === null);
zusage("1.12", "kaputtes Datum: null", bau.fcErstattungsStufe({ vonDatum: "kaputt" }) === null);
zusage("1.13", "kein Camp: null", bau.fcErstattungsStufe(null) === null);
zusage("1.14", "fcTageBisCamp zaehlt vorwaerts", bau.fcTageBisCamp({ vonDatum: inTagen(9) }) === 9);
zusage("1.15", "und rueckwaerts negativ", bau.fcTageBisCamp({ vonDatum: inTagen(-3) }) === -3);
// ⚠️ Ueber die Zeitumstellung: rein lokal gerechnet kaeme hier 27 oder 29 heraus.
zusage("1.16", "die Tageszaehlung ueberlebt beide Zeitumstellungen", (() => {
  for (let i = 0; i < 400; i++) if (bau.fcTageBisCamp({ vonDatum: inTagen(i) }) !== i) return false;
  return true;
})());

// =========================================================================
abschnitt("2. Der Geld-Absatz: bezahlt");
// =========================================================================
const geld = (tage, bezahlt, betrag) =>
  flach(bau.fcAbsageGeldBlock({ vonDatum: tage === null ? "" : inTagen(tage), preis: 18000 },
                                   { bezahlt, betrag }));

zusage(2.1, "bezahlt, 40 Tage vorher: nennt die VOLLE Erstattung",
  geld(40, true, 18000).includes("der volle Beitrag") && geld(40, true, 18000).includes("erstattet"));
zusage(2.2, "bezahlt, 10 Tage vorher: nennt die HAELFTE",
  geld(10, true, 18000).includes("die Hälfte des Beitrages"));
zusage(2.3, "bezahlt, 3 Tage vorher: sagt KEINE Erstattung zu",
  geld(3, true, 18000).includes("keine Erstattung vorgesehen"));
zusage(2.4, "und verspricht dabei nichts",
  !geld(3, true, 18000).includes("erstattet") && !geld(3, true, 18000).includes("zurück"));
zusage(2.5, "bezahlt, aber ohne Camp-Datum: nennt gar keine Quote",
  geld(null, true, 18000).includes("richtet sich nach Punkt 4")
  && !geld(null, true, 18000).includes("volle") && !geld(null, true, 18000).includes("Hälfte"));
zusage(2.6, "der bezahlte Betrag steht in jedem der drei Faelle",
  [40, 10, 3].every((t) => geld(t, true, 18000).includes("180,00 €")));
zusage(2.7, "jeder bezahlte Fall nennt Punkt 4 der Teilnahmebedingungen",
  [40, 10, 3, null].every((t) => geld(t, true, 18000).includes("Punkt 4")));

// =========================================================================
abschnitt("3. Der Geld-Absatz: nicht bezahlt");
// =========================================================================
// ⚠️ "Du musst nichts mehr überweisen" darf NUR bei voller Erstattung stehen --
// sonst spricht die App einen Verzicht aus, den niemand erklaert hat.
zusage(3.1, "unbezahlt, 40 Tage vorher: 'nichts mehr überweisen'",
  geld(40, false, 18000).includes("nichts mehr überweisen"));
zusage(3.2, "unbezahlt, 10 Tage vorher: sagt das NICHT",
  !geld(10, false, 18000).includes("nichts mehr überweisen"));
zusage(3.3, "sondern kuendigt eine Rueckmeldung an",
  geld(10, false, 18000).includes("melden uns bei dir"));
zusage(3.4, "und bittet, jetzt noch nichts zu ueberweisen",
  geld(10, false, 18000).includes("überweise jetzt noch nichts"));
zusage(3.5, "unbezahlt, 3 Tage vorher: ebenso kein Verzicht",
  !geld(3, false, 18000).includes("nichts mehr überweisen"));
zusage(3.6, "unbezahlt ohne Camp-Datum: keine Quote, aber Rueckmeldung",
  geld(null, false, 18000).includes("Punkt 4") && geld(null, false, 18000).includes("melden uns bei dir"));

// =========================================================================
abschnitt("4. Der Freiplatz");
// =========================================================================
// ⚠️ 0 ist ein gueltiger Betrag. Auf Wahrheitswert geprueft, faellt er in den
// Zweig "unbezahlt" und die Familie bekaeme eine Zahlungsansage ueber nichts.
zusage(4.1, "Betrag 0: 'kein Beitrag zu zahlen'", geld(3, false, 0).includes("kein Beitrag zu zahlen"));
zusage(4.2, "und keine Rede von Erstattung", !geld(3, false, 0).includes("Punkt 4"));
zusage(4.3, "auch kurz vor dem Camp nicht", !geld(0, false, 0).includes("überweisen"));
zusage(4.4, "auch als 'bezahlt' markiert bleibt es dabei", geld(3, true, 0).includes("kein Beitrag zu zahlen"));

// =========================================================================
abschnitt("5. Der Weg: Eltern sagen ab");
// =========================================================================
frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
let tok = await anmelden();
let r = await absagen(tok);
zusage(5.1, "die Absage gelingt", r.status === 200);
zusage(5.2, "der Status steht auf abgesagt", anm().status === "abgesagt");
zusage(5.3, "GENAU eine Mail geht raus", MAILS.length === 1);
zusage(5.4, "die Antwort meldet den Versand", r.__json && r.__json.sent === true);

let m = MAILS[0] || {};
let text = flach(m.textContent);
zusage(5.5, "Betreff: 'Absage bestätigt: <Camp>'", m.subject === "Absage bestätigt: Herbstcamp 2026");
zusage(5.6, "geht an die Eltern-Adresse", (m.to || [])[0] && m.to[0].email === "eltern@example.org");
zusage(5.7, "der Kindname steht drin", text.includes("Lena Muster"));
zusage(5.8, "die Anrede nennt die Eltern", text.includes("Hallo Anja Muster"));
zusage(5.9, "die Camp-Angaben stehen drin", text.includes("Herbstcamp 2026") && text.includes("Sportplatz"));
zusage("5.10", "der Kontakt steht drin", text.includes("nachwuchs@example.org"));
// ⚠️ KEIN Aenderungs-Link: nach der Absage weist der Worker jede Aenderung mit
// 410 ab, und ein Link, der nur noch "geht nicht" sagt, ist schlechter als
// keiner. Der Weg zurueck laeuft ueber den Verein.
zusage("5.11", "KEIN Link auf meine-anmeldung.html", !text.includes("meine-anmeldung.html"));
zusage("5.12", "der Anmelde-Token steht nirgends in der Mail", !text.includes(tok));
zusage("5.13", "stattdessen der Weg zurueck ueber den Verein", text.includes("melde dich in dem Fall bitte direkt bei uns"));
zusage("5.14", "die Fusszeile sagt, warum die Mail kam", text.includes("weil über unsere Seite eine Absage"));

// =========================================================================
abschnitt("6. Zweimal absagen schickt nicht zweimal");
// =========================================================================
frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
await absagen(tok);
const nachErster = MAILS.length;
r = await absagen(tok);
zusage(6.1, "erste Absage: eine Mail", nachErster === 1);
zusage(6.2, "zweite Absage: keine zweite Mail", MAILS.length === 1);
zusage(6.3, "und sie meldet 'schon abgesagt'", r.__json && r.__json.schonAbgesagt === true);
zusage(6.4, "sent ist dann false, nicht true", r.__json && r.__json.sent === false);

// =========================================================================
abschnitt("7. Die Absage steht, auch wenn die Mail klemmt");
// =========================================================================
frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
MAIL_KAPUTT = true;
r = await absagen(tok);
zusage(7.1, "die Absage gelingt trotzdem", r.status === 200);
zusage(7.2, "der Status steht auf abgesagt", anm().status === "abgesagt");
zusage(7.3, "und die Antwort sagt ehrlich sent:false", r.__json && r.__json.sent === false);

// =========================================================================
abschnitt("8. Was die Mail zum Geld sagt, haengt an der Lage");
// =========================================================================
frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
anm().bezahlt = true;
await absagen(tok);
zusage(8.1, "bezahlt und 40 Tage vorher: volle Erstattung in der Mail",
  flach((MAILS[0] || {}).textContent).includes("der volle Beitrag"));

frisch({ vonDatum: inTagen(3), bisDatum: inTagen(7) });
tok = await anmelden();
anm().bezahlt = true;
await absagen(tok);
zusage(8.2, "bezahlt und 3 Tage vorher: keine Erstattung in der Mail",
  flach((MAILS[0] || {}).textContent).includes("keine Erstattung vorgesehen"));

frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44), preis: 0 });
tok = await anmelden();
await absagen(tok);
zusage(8.3, "Freiplatz: die Mail spricht gar nicht von Geld",
  flach((MAILS[0] || {}).textContent).includes("kein Beitrag zu zahlen"));

// =========================================================================
abschnitt("9. Die Wachen des Handlers bleiben");
// =========================================================================
frisch();
tok = await anmelden();
r = await absagen("gibtesnicht");
zusage(9.1, "unbekannter Token: 404 und keine Mail", r.status === 404 && MAILS.length === 0);

frisch();
tok = await anmelden();
camp().aufgeraeumtAm = new Date().toISOString();
MAILS = [];
r = await absagen(tok);
zusage(9.2, "aufgeraeumtes Camp: 410 und keine Mail", r.status === 410 && MAILS.length === 0);

// ⚠️ Die Absage durch die VERWALTUNG verschickt nur auf ausdrueckliches
// `mail: true`. Ein aelterer Client, der das Feld gar nicht kennt, loest damit
// keine Mail aus, von der die Bedienende nichts weiss.
frisch();
tok = await anmelden();
MAILS = [];
r = await bau.handleFcAbsagen(anfrage(), { campId: "c1", anmeldungId: anm().id, grund: "doppelt" }, ENV, AUTH, {});
zusage(9.3, "Absage durch die Verwaltung ohne mail-Feld: gelingt", r.status === 200);
zusage(9.4, "und verschickt KEINE Mail (alter Client verhaelt sich wie vorher)", MAILS.length === 0);

// ⚠️ Nach einer Absage laesst sich die Anmeldung nicht mehr aendern -- genau
// deshalb traegt die Mail keinen Aenderungs-Link.
frisch();
tok = await anmelden();
await absagen(tok);
r = await bau.handleFcMeineSpeichern(anfrage(), { token: tok, daten: { allergien: "doch" } }, ENV, AUTH, {});
zusage(9.5, "Aendern nach der Absage: 410", r.status === 410);

// =========================================================================
abschnitt("10. Absage durch die Verwaltung, auf Haekchen");
// =========================================================================
const sagAb = (mail, extra) => bau.handleFcAbsagen(
  anfrage(),
  Object.assign({ campId: "c1", anmeldungId: anm().id, grund: "Eltern haben angerufen" }, extra || {}, mail === undefined ? {} : { mail }),
  ENV, AUTH, {});

frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
MAILS = [];
r = await sagAb(true);
zusage("10.1", "mit mail:true gelingt die Absage", r.status === 200);
zusage("10.2", "der Status steht auf abgesagt", anm().status === "abgesagt");
zusage("10.3", "GENAU eine Mail geht raus", MAILS.length === 1);
zusage("10.4", "die Antwort meldet den Versand", r.__json && r.__json.sent === true);
zusage("10.5", "und dass er gewuenscht war", r.__json && r.__json.mailGewuenscht === true);

m = MAILS[0] || {};
text = flach(m.textContent);
zusage("10.6", "gleicher Betreff wie bei der Eltern-Absage", m.subject === "Absage bestätigt: Herbstcamp 2026");
zusage("10.7", "geht an die Eltern-Adresse", (m.to || [])[0] && m.to[0].email === "eltern@example.org");
zusage("10.8", "der Kindname steht drin", text.includes("Lena Muster"));
// ⚠️ Der Kern des eigenen Textes: sie darf den Eltern NICHT unterstellen, sie
// haetten selbst abgesagt.
zusage("10.9", "sagt NICHT 'wir haben deine Absage erhalten'", !text.includes("deine Absage"));
zusage("10.10", "sondern nennt die Anmeldung als abgesagt", text.includes("ist abgesagt"));
// ⚠️⚠️ Der Absagegrund ist der Verwaltung als INTERN zugesagt -- die Maske sagt
// das beim Eintragen ausdruecklich. Er darf nirgends in der Mail auftauchen.
zusage("10.11", "der interne Absagegrund steht NICHT in der Mail", !text.includes("Eltern haben angerufen"));
zusage("10.12", "kein Aendern-Link", !text.includes("meine-anmeldung.html"));
zusage("10.13", "kein Eltern-Token", !text.includes(anm().token || "xxx"));
zusage("10.14", "eigene Fusszeile", text.includes("weil die Anmeldung deines Kindes zu diesem Camp"));

// ⚠️⚠️ Punkt 4 heisst "Rücktritt und Stornierung durch TEILNEHMENDE". Sagt der
// Verein ab, greift er nicht -- und welcher der beiden Faelle vorliegt, weiss
// die App nicht. Also darf sie keine der beiden Regeln behaupten.
frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
anm().bezahlt = true;
MAILS = [];
await sagAb(true);
text = flach((MAILS[0] || {}).textContent);
zusage("10.15", "bezahlt: nennt den Betrag", text.includes("180,00 €"));
zusage("10.16", "kuendigt die Klaerung an", text.includes("klären, was davon zurückgeht"));
zusage("10.17", "nennt KEINE Erstattungsquote", !text.includes("Punkt 4") && !text.includes("volle Beitrag") && !text.includes("Hälfte"));

frisch({ vonDatum: inTagen(3), bisDatum: inTagen(7) });
tok = await anmelden();
anm().bezahlt = true;
MAILS = [];
await sagAb(true);
text = flach((MAILS[0] || {}).textContent);
zusage("10.18", "auch drei Tage vorher keine Quote und kein 'keine Erstattung'",
  !text.includes("Punkt 4") && !text.includes("keine Erstattung"));

frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
MAILS = [];
await sagAb(true);
text = flach((MAILS[0] || {}).textContent);
zusage("10.19", "unbezahlt: bittet, nichts mehr zu ueberweisen", text.includes("überweise jetzt nichts mehr"));
zusage("10.20", "spricht aber keinen Verzicht aus", !text.includes("musst nichts mehr überweisen"));

frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44), preis: 0 });
tok = await anmelden();
MAILS = [];
await sagAb(true);
zusage("10.21", "Freiplatz: gar keine Rede von Geld",
  flach((MAILS[0] || {}).textContent).includes("kein Beitrag zu zahlen"));

// ---- Das Haekchen ist eine echte Weiche -------------------------------
frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
MAILS = [];
r = await sagAb(false);
zusage("10.22", "mit mail:false: keine Mail", MAILS.length === 0);
zusage("10.23", "die Absage steht trotzdem", anm().status === "abgesagt");
zusage("10.24", "und die Antwort sagt mailGewuenscht:false", r.__json && r.__json.mailGewuenscht === false);

// ⚠️ Nur ein echtes `true` zaehlt -- ein truthy Wert aus einem umgebauten Client
// darf keine Mail ausloesen.
frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
MAILS = [];
await sagAb("ja");
zusage("10.25", "mail:'ja' ist kein true: keine Mail", MAILS.length === 0);

frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
MAILS = [];
await sagAb(1);
zusage("10.26", "mail:1 ebenso wenig", MAILS.length === 0);

// ---- Wachen ------------------------------------------------------------
frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
await sagAb(true);
MAILS = [];
r = await sagAb(true);
zusage("10.27", "zweimal absagen schickt keine zweite Mail", MAILS.length === 0);
zusage("10.28", "und meldet schonAbgesagt", r.__json && r.__json.schonAbgesagt === true);

frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
MAIL_KAPUTT = true;
r = await sagAb(true);
zusage("10.29", "Mailfehler kippt die Absage nicht", r.status === 200 && anm().status === "abgesagt");
zusage("10.30", "und wird ehrlich als sent:false gemeldet", r.__json && r.__json.sent === false);

// ⚠️ Ohne Bearbeiten-Recht gar nichts -- weder Absage noch Mail.
frisch({ vonDatum: inTagen(40), bisDatum: inTagen(44) });
tok = await anmelden();
RECHT = { canEdit: false, canAdmin: false };
MAILS = [];
r = await sagAb(true);
zusage("10.31", "ohne Bearbeiten-Recht: 403", r.status === 403);
zusage("10.32", "und keine Mail", MAILS.length === 0);
zusage("10.33", "und die Anmeldung steht unveraendert", anm().status === "angemeldet");

// =========================================================================
console.log("\n" + "=".repeat(60));
console.log(gruen + " von " + (gruen + rot) + " Zusagen erfuellt.");
if (rot) { console.log(rot + " ROT."); process.exit(1); }
