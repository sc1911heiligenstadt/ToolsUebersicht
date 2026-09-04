// Pruefstand: was nach einer Absage zurueckzuueberweisen ist (Punkt 4 der
// Teilnahmebedingungen), angezeigt im Anmeldungs-Dialog der Verwaltung.
//
// ⚠️ Der Client-Code wird AUS DEN DATEIEN GEZOGEN und AUSGEFUEHRT, nicht
// nachgebaut. config.js und app.js werden ganz geladen (wie im Browser), nur
// mit einer Attrappe fuer `document` -- app.js hat genau eine Zeile auf
// oberster Ebene, und das ist der DOMContentLoaded-Horcher.
//
// ⚠️ Die Staffel steht DOPPELT: hier im Client (Anzeige) und im Worker
// (Absage-Mail an die Familie). Abschnitt 1 nagelt beide Fassungen
// gegeneinander fest -- laufen sie auseinander, nennt die Mail eine andere
// Quote als der Bildschirm, von dem aus ueberwiesen wird.
//
//   node pruef-camp-erstattung.mjs [pfad-zu-admin-worker.js]
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HIER = dirname(fileURLToPath(import.meta.url));
const WORKER_PFAD = process.argv[2] || join(HIER, "admin-worker.js");
const WORKER = fs.readFileSync(WORKER_PFAD, "utf8").replace(/\r\n/g, "\n");
// Ohne Vorgabe die App nebenan; mit FC_APP_DIR eine andere Fassung -- so laesst
// sich der Selbsttest gegen einen aelteren Commit fahren, ohne das
// Arbeitsverzeichnis anzufassen (auf E:\ laufen mehrere Sitzungen).
const APP = (process.env.FC_APP_DIR || join(HIER, "..", "fussballcamp")) + "/";
const CONFIGJS = fs.readFileSync(APP + "config.js", "utf8").replace(/\r\n/g, "\n");
const APPJS = fs.readFileSync(APP + "app.js", "utf8").replace(/\r\n/g, "\n");

let ok = 0;
const funde = [];
function pruefe(name, bedingung, detail) {
  if (bedingung) { ok++; console.log("  ok  " + name); }
  else { funde.push({ name, detail }); console.log("  X   " + name + (detail ? "\n        " + detail : "")); }
}

// =========================================================================
console.log("\n1. Die Staffel steht doppelt und muss sich decken");
// =========================================================================

function zahlAus(quelle, name) {
  const m = quelle.match(new RegExp("const " + name + "\\s*=\\s*(\\d+)\\s*;"));
  if (!m) throw new Error("ABBRUCH: " + name + " nicht gefunden in der Quelle.");
  return Number(m[1]);
}

const wVoll = zahlAus(WORKER, "FC_ERSTATTUNG_VOLL_AB_TAGEN");
const wHalb = zahlAus(WORKER, "FC_ERSTATTUNG_HALB_AB_TAGEN");
const cVoll = zahlAus(CONFIGJS, "FC_ERSTATTUNG_VOLL_AB_TAGEN");
const cHalb = zahlAus(CONFIGJS, "FC_ERSTATTUNG_HALB_AB_TAGEN");

pruefe("Voll-Grenze: Client 28 = Worker 28", cVoll === wVoll && cVoll === 28, `Client ${cVoll}, Worker ${wVoll}`);
pruefe("Halb-Grenze: Client 7 = Worker 7", cHalb === wHalb && cHalb === 7, `Client ${cHalb}, Worker ${wHalb}`);

// ⚠️ Der Rechtstext ist die Quelle beider Zahlen. Aendert jemand Punkt 4, ohne
// den Code mitzuziehen, verspricht die App etwas anderes als der Vertrag.
const AGB_BLOCK = WORKER.slice(WORKER.indexOf("4. Rücktritt und Stornierung durch Teilnehmende"),
                               WORKER.indexOf("5. Erkrankung oder vorzeitiger Abbruch"));
pruefe("Punkt 4 im Rechtstext nennt weiter 28 Tage / 100 %",
  AGB_BLOCK.includes("bis einschließlich 28 Tage vor Campbeginn: 100 %"), "Punkt-4-Block: " + AGB_BLOCK.length + " Zeichen");
pruefe("Punkt 4 nennt weiter 27 bis 7 Tage / 50 %",
  AGB_BLOCK.includes("27 bis einschließlich 7 Tage vor Campbeginn: 50 %"));
pruefe("Punkt 4 nennt weiter ab 6 Tage / keine Erstattung",
  AGB_BLOCK.includes("ab 6 Tage vor Campbeginn: keine Erstattung"));
pruefe("Punkt 4 macht den EINGANG der Stornierung massgeblich",
  AGB_BLOCK.includes("ist der Eingang der Stornierung beim Verein maßgeblich"));

// Der Marker, an dem der Client eine Eltern-Absage erkennt.
const cMarker = (CONFIGJS.match(/const FC_ABSAGE_GRUND_ELTERN = "([^"]*)"/) || [])[1];
const wSetzt = (WORKER.match(/anmeldung\.absageGrund = "([^"]*)"/) || [])[1];
pruefe("Marker deckt sich mit dem, was der Worker in absageGrund schreibt",
  !!cMarker && cMarker === wSetzt, `Client ${JSON.stringify(cMarker)}, Worker ${JSON.stringify(wSetzt)}`);

// =========================================================================
console.log("\n2. Die Stufe haengt am Absagedatum, NICHT an der Systemuhr");
// =========================================================================
// ⚠️ Der Kern dieser Anzeige. Wuerde sie mit "heute" rechnen, saenke die Quote
// mit jedem Tag, den die Verwaltung den Vorgang spaeter aufschlaegt -- aus den
// per Mail zugesagten 100 % wuerden stillschweigend 50 %.
function fnQuelle(name) {
  const a = APPJS.indexOf("function " + name + "(");
  if (a < 0) throw new Error("ABBRUCH: " + name + " nicht in app.js gefunden.");
  const b = APPJS.indexOf("\n}\n", a);
  if (b < 0) throw new Error("ABBRUCH: Ende von " + name + " nicht gefunden.");
  return APPJS.slice(a, b + 3);
}

const qStufe = fnQuelle("erstattungsStufe");
pruefe("erstattungsStufe liest die Uhr nicht (kein Date.now/new Date()/heuteIso)",
  !/Date\.now\(\)/.test(qStufe) && !/new Date\(\s*\)/.test(qStufe) && !/heuteIso/.test(qStufe), qStufe);
pruefe("erstattungsStufe geht von a.geaendertAm aus", qStufe.includes("a.geaendertAm"));
pruefe("berlinTag rechnet in Europe/Berlin, wie fcHeuteBerlin im Worker",
  fnQuelle("berlinTag").includes('timeZone: "Europe/Berlin"') &&
  WORKER.includes('function fcHeuteBerlin() {\n  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });'));
pruefe("tageZwischenIso ankert auf T12:00:00Z (Sommerzeitgrenze)",
  fnQuelle("tageZwischenIso").includes('T12:00:00Z'));

// ⚠️ Diese Zusage ist mit ABSICHT statisch. Der `gross`-Helfer im Dialog
// bekommt heute ausschliesslich feste Texte und gerechnete Betraege -- kein
// Eingabefeld reicht bis dorthin. Sein escapeHtml laesst sich deshalb durch
// kein Verhalten belegen: eine Mutation, die es entfernt, aendert an der
// Ausgabe nichts. Genau dafuer steht die Zeile hier. Faellt sie, ist der naechste
// Text, den jemand durch `gross` schickt, ungeprueft im Markup.
const qGross = APPJS.slice(APPJS.indexOf("    const gross = (label, text) =>"),
                           APPJS.indexOf("    if (!absageVonEltern(a)) {"));
pruefe("Der gross-Helfer escapet, auch wenn ihn heute nichts Fremdes erreicht",
  qGross.includes("escapeHtml(text)") && qGross.includes("escapeHtml(label)"), qGross);

// =========================================================================
console.log("\n3. Client laden und ausfuehren");
// =========================================================================
const docStub = {
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} } },
  body: { appendChild() {}, removeChild() {} }
};
const winStub = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
                  innerWidth: 1280, location: { href: "", search: "" } };
const lsStub = { getItem: () => null, setItem() {}, removeItem() {} };

const API = new Function("document", "window", "localStorage", "navigator", "fetch",
  CONFIGJS + "\n" + APPJS + "\n" +
  "return { anmDetails, erstattungsStufe, erstattungCent, absageVonEltern, berlinTag," +
  " tageZwischenIso, anmBetrag, euro, kindName," +
  " VOLL: FC_ERSTATTUNG_VOLL_AB_TAGEN, HALB: FC_ERSTATTUNG_HALB_AB_TAGEN," +
  " MARKER: FC_ABSAGE_GRUND_ELTERN, setDaten: (d) => { daten = d; } };"
)(docStub, winStub, lsStub, { userAgent: "node" }, async () => { throw new Error("kein Netz im Pruefstand"); });

pruefe("config.js und app.js laden zusammen ohne Fehler", typeof API.anmDetails === "function");
pruefe("Die Konstanten sind im Client wirklich sichtbar", API.VOLL === 28 && API.HALB === 7 && API.MARKER === cMarker);

// ---- Attrappen -----------------------------------------------------------
const CAMP_START = "2026-10-05";
function camp(zusatz) {
  return Object.assign({ id: "c1", name: "Herbstcamp 2026", vonDatum: CAMP_START, bisDatum: "2026-10-09",
                         preis: 16000, felder: {}, anmeldungen: [] }, zusatz || {});
}
// Ein ISO-Zeitstempel n Tage vor Camp-Beginn, mittags Berliner Zeit.
function absageTage(n) {
  const d = new Date(CAMP_START + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}
function anm(zusatz) {
  return Object.assign({ id: "a1", nummer: 3, status: "abgesagt", absageGrund: API.MARKER,
                         kindVorname: "Lena", kindNachname: "Muster", betrag: 16000,
                         bezahlt: true, bezahltAm: "2026-08-01", erstelltAm: "2026-07-20T09:00:00Z",
                         geaendertAm: absageTage(40) }, zusatz || {});
}
API.setDaten({ einstellungen: { agbStand: "vorgabe-august-2026" } });

// =========================================================================
console.log("\n4. Die Staffel an ihren Grenzen");
// =========================================================================
const GRENZEN = [
  ["29 Tage vorher", 29, 100], ["genau 28 Tage vorher (Grenze, noch voll)", 28, 100],
  ["27 Tage vorher", 27, 50], ["8 Tage vorher", 8, 50],
  ["genau 7 Tage vorher (Grenze, noch halb)", 7, 50], ["6 Tage vorher", 6, 0],
  ["1 Tag vorher", 1, 0], ["am Tag des Camp-Beginns", 0, 0], ["nach Camp-Beginn", -3, 0]
];
for (const [name, tage, soll] of GRENZEN) {
  const s = API.erstattungsStufe(camp(), anm({ geaendertAm: absageTage(tage) }));
  pruefe(`${name} → ${soll} %`, s === soll, `bekommen: ${s}`);
}

// =========================================================================
console.log("\n5. Der Berliner Kalendertag entscheidet, nicht der UTC-Tag");
// =========================================================================
// 2026-09-07T22:30:00Z ist in Berlin bereits der 08.09. (Sommerzeit, UTC+2).
// UTC-Tag 07.09. waeren 28 Tage → 100 %; Berliner Tag 08.09. sind 27 → 50 %.
// Der Worker rechnet zum Absagezeitpunkt mit fcHeuteBerlin() und sagt in der
// Mail deshalb 50 % -- der Dialog muss dasselbe sagen.
const spaetAbends = "2026-09-07T22:30:00Z";
pruefe("berlinTag(22:30Z im Sommer) ist der Folgetag", API.berlinTag(spaetAbends) === "2026-09-08",
  "bekommen: " + API.berlinTag(spaetAbends));
pruefe("Absage 22:30Z an der 28-Tage-Grenze ergibt 50 %, nicht 100 %",
  API.erstattungsStufe(camp(), anm({ geaendertAm: spaetAbends })) === 50,
  "bekommen: " + API.erstattungsStufe(camp(), anm({ geaendertAm: spaetAbends })));
pruefe("Gegenprobe: der reine UTC-Tag laege bei 28 Tagen (also anders)",
  API.tageZwischenIso(spaetAbends.slice(0, 10), CAMP_START) === 28);
// Winter: 2026-11-xx ist UTC+1, 23:30Z waere der Folgetag.
pruefe("berlinTag(23:30Z im Winter) ist der Folgetag",
  API.berlinTag("2026-11-10T23:30:00Z") === "2026-11-11");
pruefe("berlinTag(10:00Z) bleibt derselbe Tag", API.berlinTag("2026-09-07T10:00:00Z") === "2026-09-07");

// =========================================================================
console.log("\n6. Der Betrag");
// =========================================================================
pruefe("bezahlt + 100 % von 160,00 → 160,00",
  API.erstattungCent(camp(), anm(), 100) === 16000);
pruefe("bezahlt + 50 % von 160,00 → 80,00",
  API.erstattungCent(camp(), anm(), 50) === 8000);
pruefe("bezahlt + 0 % → 0 (nicht null)",
  API.erstattungCent(camp(), anm(), 0) === 0);
// ⚠️ 12345 Cent halbiert sind 61,725 € -- abgeschnitten ginge der kleinste Cent
// verloren. Gerundet wird auf 61,73 €.
pruefe("ungerader Cent-Betrag wird gerundet, nicht abgeschnitten",
  API.erstattungCent(camp(), anm({ betrag: 12345 }), 50) === 6173,
  "bekommen: " + API.erstattungCent(camp(), anm({ betrag: 12345 }), 50));
pruefe("NICHT bezahlt → null, nicht ein Anteil auf nie gezahltes Geld",
  API.erstattungCent(camp(), anm({ bezahlt: false }), 100) === null);
pruefe("Stufe null → null (keine Aussage moeglich)",
  API.erstattungCent(camp(), anm(), null) === null);
// ⚠️ Der festgeschriebene Fruehbucherbetrag zaehlt, nicht der heutige Camp-Preis.
pruefe("Fruehbucher: erstattet wird der festgeschriebene Betrag, nicht camp.preis",
  API.erstattungCent(camp({ preis: 18000 }), anm({ betrag: 14000 }), 100) === 14000,
  "bekommen: " + API.erstattungCent(camp({ preis: 18000 }), anm({ betrag: 14000 }), 100));

// =========================================================================
console.log("\n7. Wer hat abgesagt");
// =========================================================================
pruefe("Eltern-Absage wird erkannt", API.absageVonEltern(anm()) === true);
pruefe("Verwaltungs-Absage mit Grund ist KEINE Eltern-Absage",
  API.absageVonEltern(anm({ absageGrund: "Familie hat angerufen" })) === false);
pruefe("Verwaltungs-Absage OHNE Grund ist keine Eltern-Absage",
  API.absageVonEltern(anm({ absageGrund: "" })) === false);
pruefe("Eine gar nicht abgesagte Anmeldung ist keine Eltern-Absage",
  API.absageVonEltern(anm({ status: "angemeldet" })) === false);

// =========================================================================
console.log("\n8. Kein Datum heisst NICHT null Prozent");
// =========================================================================
pruefe("Camp ohne vonDatum → Stufe null", API.erstattungsStufe(camp({ vonDatum: "" }), anm()) === null);
pruefe("Anmeldung ohne geaendertAm → Stufe null", API.erstattungsStufe(camp(), anm({ geaendertAm: "" })) === null);
pruefe("kaputter Zeitstempel → Stufe null", API.erstattungsStufe(camp(), anm({ geaendertAm: "irgendwas" })) === null);

// =========================================================================
console.log("\n9. Der Dialog selbst");
// =========================================================================
const html = (c, a) => API.anmDetails(c, a);
const h100 = html(camp(), anm({ geaendertAm: absageTage(40) }));
const h50  = html(camp(), anm({ geaendertAm: absageTage(10) }));
const h0   = html(camp(), anm({ geaendertAm: absageTage(2) }));

pruefe("Eine NICHT abgesagte Anmeldung bekommt keinen Absage-Block",
  !html(camp(), anm({ status: "angemeldet" })).includes("Absage und Erstattung"));
pruefe("Abgesagt → der Block steht da", h100.includes("Absage und Erstattung"));
pruefe("100 %: nennt den vollen Beitrag", h100.includes("voller Beitrag (100 %)"));
pruefe("100 %: Zurueckzuueberweisen 160,00", /Zur.ck.*160,00/s.test(h100), h100.slice(h100.indexOf("Absage und")));
pruefe("50 %: nennt die Haelfte", h50.includes("die Hälfte des Beitrages (50 %)"));
pruefe("50 %: nennt 80,00 UND woraus (von 160,00)", h50.includes("80,00") && h50.includes("von 160,00"));
pruefe("0 %: nennt keine Erstattung", h0.includes("keine Erstattung (0 %)"));
pruefe("0 %: nennt trotzdem einen Betrag, naemlich 0,00", h0.includes("0,00"));
pruefe("Vorlauf steht da", h50.includes("10 Tage vor Camp-Beginn"));
pruefe("Vorlauf im Einzahl bei genau einem Tag",
  html(camp(), anm({ geaendertAm: absageTage(1) })).includes("1 Tag vor Camp-Beginn"));

const hUnbezahlt = html(camp(), anm({ bezahlt: false, geaendertAm: absageTage(40) }));
pruefe("Nicht bezahlt → 'nichts', kein Rueckzahlbetrag", hUnbezahlt.includes("nichts") && !hUnbezahlt.includes("160,00 €</strong>"));
pruefe("Nicht bezahlt → sagt auch warum", hUnbezahlt.includes("nie eingegangen"));

const hFrei = html(camp(), anm({ betrag: 0, geaendertAm: absageTage(40) }));
pruefe("Freiplatz → 'nichts', ohne Quote", hFrei.includes("nichts") && !hFrei.includes("100 %"));

// ⚠️ Der wichtigste Fall des Abschnitts: bei einer Absage der VERWALTUNG darf
// keine Quote behauptet werden. Punkt 4 gilt nur bei Stornierung durch die
// Familie; sagt der Verein ab, greift Punkt 11.
const hVerw = html(camp(), anm({ absageGrund: "Kind ist krank, Mutter hat angerufen" }));
pruefe("Verwaltungs-Absage: 'von Hand klären'", hVerw.includes("von Hand klären"));
pruefe("Verwaltungs-Absage nennt KEINE Quote",
  !hVerw.includes("100 %") && !hVerw.includes("50 %") && !hVerw.includes("(0 %)"),
  hVerw.slice(hVerw.indexOf("Absage und")));
pruefe("Verwaltungs-Absage nennt Punkt 11 als den anderen Fall", hVerw.includes("Punkt 11"));
pruefe("Verwaltungs-Absage nennt trotzdem, was eingegangen ist", hVerw.includes("160,00"));

const hOhneDatum = html(camp({ vonDatum: "" }), anm());
pruefe("Camp ohne Datum: 'nicht bestimmbar', NICHT 'keine Erstattung'",
  hOhneDatum.includes("nicht bestimmbar") && !hOhneDatum.includes("keine Erstattung"));

pruefe("Spielraum-Satz steht bei 50 % da", h50.includes("Spielraum") && h50.includes("Neuvergabe"));
pruefe("Spielraum-Satz steht bei 100 % NICHT da", !h100.includes("Spielraum"));
pruefe("Spielraum-Satz steht bei unbezahlt NICHT da",
  !html(camp(), anm({ bezahlt: false, geaendertAm: absageTage(2) })).includes("Spielraum"));

// ⚠️ absageGrund kommt bei der Verwaltung aus einem Eingabefeld. Angezeigt wird
// er in der Status-Zeile (BESTEHENDER Code, nicht der neue Block) -- diese
// Zusage belegt also, dass der neue Zweig ihn nicht an der Escape-Stelle
// vorbeischleust, nicht dass der neue Block selbst escapet. Letzteres steht als
// statische Zusage in Abschnitt 2.
const hXss = html(camp(), anm({ absageGrund: '<img src=x onerror=alert(1)>' }));
pruefe("Ein Grund mit Markup steht escapet da, auch im Verwaltungs-Zweig",
  !hXss.includes("<img src=x") && hXss.includes("&lt;img") && hXss.includes("von Hand klären"));

// =========================================================================
const gesamt = ok + funde.length;
console.log(`\n${ok}/${gesamt} Zusagen erfuellt.`);
if (funde.length) {
  console.log("\nFUNDE:");
  funde.forEach((f) => console.log("  - " + f.name + (f.detail ? "\n      " + f.detail : "")));
  process.exit(1);
}
