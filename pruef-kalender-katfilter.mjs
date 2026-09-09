// Prueft den Kategorie-Filter der Karte "Naechste Termine" mit dem ECHTEN
// Quelltext aus app.js: renderSidebarWidget und der Klick-Handler werden aus der
// Datei geschnitten und ausgefuehrt, nicht nachgebaut. Kein Netz, keine Daten.
//
// Gestubbt ist nur, was mit dem Filter nichts zu tun hat (Datumsformate,
// Stimmenzaehler, toolById). Was hier gemessen wird -- welche Zeilen die Karte
// zeigt, welche Knoepfe entstehen, welcher Satz im Leerzustand steht, was der
// Klick tut -- laeuft im Originalcode.
//
// Aufruf: node pruef-kalender-katfilter.mjs [pfad/zu/app.js]
import fs from "fs";
import vm from "vm";

const PFAD = process.argv[2] || "E:/ToolsUebersicht/app.js";
// Zeilenenden vereinheitlichen: die Schnittmarken suchen eine Zeile, die genau
// aus einer schliessenden Klammer besteht -- mit LF geschrieben. app.js liegt im
// Arbeitsverzeichnis mit CRLF; ohne das hier braeche der Lauf ab statt zu messen.
const app = fs.readFileSync(PFAD, "utf8").replace(/\r\n/g, "\n");

function schneide(startMarke) {
  const i = app.indexOf(startMarke);
  if (i < 0) throw new Error("ABBRUCH: nicht gefunden: " + startMarke);
  const ende = app.indexOf("\n}\n", i);
  if (ende < 0) throw new Error("ABBRUCH: Ende nicht gefunden: " + startMarke);
  return app.slice(i, ende + 2);
}
function schneideZeile(marke) {
  const i = app.indexOf(marke);
  if (i < 0) throw new Error("ABBRUCH: nicht gefunden: " + marke);
  return app.slice(i, app.indexOf("\n", i));
}

const echterCode = [
  schneideZeile("const KAL_KAT_FILTER_KEY ="),
  schneide("function ladeKalKatFilter("),
  schneide("function speichereKalKatFilter("),
  schneide("function renderSidebarWidget("),
  schneide("async function onCalendarWidgetClick(")
].join("\n\n");

// ---------- Winziger DOM-Ersatz ----------
const widget = { id: "calendar-widget", dataset: {}, addEventListener: () => {} };
const inhalt = { id: "termine-widget-inhalt", innerHTML: "" };
const speicher = {};
let neuGezeichnet = 0;

const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (k in speicher ? speicher[k] : null),
    setItem: (k, v) => { speicher[k] = String(v); }
  },
  document: {
    getElementById: (id) => (id === "termine-widget-inhalt" ? inhalt : id === "calendar-widget" ? widget : null)
  },
  // --- Stubs: mit dem Filter nicht verwandt ---
  currentUser: { username: "michel" },
  calendarWidgetOpts: null,
  escapeHtml: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  formatCalendarDate: (iso) => String(iso).slice(8, 10) + "." + String(iso).slice(5, 7) + ".",
  formatAbsenceRange: (a, b) => a + "-" + b,
  calendarVoteCounts: () => ({ ja: 0, nein: 0, meins: "" }),
  toolById: () => ({ url: "https://beispiel.test/vereinskalender/" }),
  absencePersonName: (a) => a.name || "",
  updateSidebarSichtbarkeit: () => {},
  CALENDAR_WIDGET_APP_ID: "vereinskalender",
  ABSENCE_WIDGET_APP_ID: "abwesenheit",
  ABLAUF_WIDGET_APP_ID: "ablaufplan"
};
vm.createContext(sandbox);
vm.runInContext(echterCode, sandbox);

// renderSidebarWidget mitzaehlen, ohne es zu ersetzen: der Klick-Handler soll
// belegbar neu zeichnen, nicht nur den Filter umlegen.
const echtRender = sandbox.renderSidebarWidget;
sandbox.renderSidebarWidget = function () { neuGezeichnet++; return echtRender.apply(null, arguments); };

// ---------- Zusagen ----------
let fehler = 0;
const pruefe = (name, bedingung, zusatz) => {
  if (bedingung) { console.log("  [ok]   " + name); return; }
  fehler++;
  console.log("  [FEHL] " + name + (zusatz === undefined ? "" : "  ->  " + JSON.stringify(zusatz)));
};

const KATS = [
  { id: "halle", name: "Halle gesperrt", farbe: "#c0392b" },
  { id: "training", name: "Training", farbe: "#1a56a0" },
  { id: "veranstaltung", name: "Veranstaltung", farbe: "#2d8c4e" },
  { id: "ohne-termin", name: "Kommt hier nicht vor", farbe: "#999999" }
];
const reihe = (id, kat, titel) => ({ termin: { id, kategorie: kat, titel }, datum: "2026-10-0" + id.slice(1), zeit: "", candId: null });
const OEFFENTLICH = [
  reihe("t1", "halle", "Halle A gesperrt"),
  reihe("t2", "training", "Training E-Jugend"),
  reihe("t3", "training", "Training D-Jugend"),
  reihe("t4", "veranstaltung", "Adventsmarkt"),
  reihe("t5", "gibt-es-nicht-mehr", "Alte Kategorie")
];
const PRIVAT = [reihe("p1", "training", "Mein Termin")];

function zeichne(ausgeblendet, extra) {
  neuGezeichnet = 0;
  sandbox.kalKatAus = new Set(ausgeblendet || []);
  const opts = Object.assign({
    showCalendar: true, oeffentlich: OEFFENTLICH, privat: PRIVAT, kategorien: KATS, geburtstage: [],
    showAbsences: false, absences: [], absenceKategorien: [],
    showAblauf: false, ablauf: null
  }, extra || {});
  sandbox.renderSidebarWidget(widget, opts);
  return inhalt.innerHTML;
}
const zeigt = (html, id) => html.includes("termin=" + id);

console.log("== 1. Ohne Filter ist alles da");
let h = zeichne([]);
pruefe("alle fuenf oeffentlichen Zeilen", ["t1", "t2", "t3", "t4", "t5"].every((i) => zeigt(h, i)));
pruefe("und die private", zeigt(h, "p1"));
pruefe("kein 'Alle zeigen'", !h.includes("Alle zeigen"));

console.log("== 2. Knoepfe nur fuer Kategorien, die vorkommen");
pruefe("Halle hat einen Knopf", h.includes('data-kat="halle"'));
pruefe("die leere Kategorie NICHT", !h.includes('data-kat="ohne-termin"'), h.slice(0, 400));

console.log("== 3. Eine Kategorie aus");
h = zeichne(["training"]);
pruefe("die zwei Trainingstermine fehlen", !zeigt(h, "t2") && !zeigt(h, "t3"));
pruefe("auch der PRIVATE Trainingstermin fehlt", !zeigt(h, "p1"));
pruefe("der Rest ist da", zeigt(h, "t1") && zeigt(h, "t4"));
pruefe("'Alle zeigen' erscheint", h.includes("Alle zeigen"));
pruefe("der Knopf meldet sich als aus", h.includes('data-kat="training" aria-pressed="false"'));
pruefe("und zaehlt weiter 3 (2 oeffentlich + 1 privat)", /data-kat="training"[\s\S]{0,400}?cwk-zahl">3</.test(h), h.slice(h.indexOf('data-kat="training"'), h.indexOf('data-kat="training"') + 400));

console.log("== 4. Termin mit geloeschter Kategorie bleibt sichtbar");
h = zeichne(["halle", "training", "veranstaltung"]);
pruefe("t5 ist noch da", zeigt(h, "t5"));
pruefe("die anderen nicht", !zeigt(h, "t1") && !zeigt(h, "t4"));

console.log("== 5. Filter blendet alles aus -> anderer Satz");
h = zeichne(["halle", "training", "veranstaltung"], { oeffentlich: OEFFENTLICH.filter((r) => r.termin.kategorie !== "gibt-es-nicht-mehr"), privat: [] });
pruefe("sagt, dass der FILTER es ist", h.includes("Kein Termin passt zu den gewählten Kategorien"), h);
pruefe("nicht 'Keine anstehenden Termine'", !h.includes("Keine anstehenden Termine."));

console.log("== 6. Gar keine Termine -> der andere Satz");
h = zeichne([], { oeffentlich: [], privat: [] });
pruefe("sagt 'Keine anstehenden Termine'", h.includes("Keine anstehenden Termine."), h);
pruefe("keine Filterleiste", !h.includes("cw-katfilter"));

console.log("== 7. Nur eine Kategorie vorhanden -> keine Leiste");
h = zeichne([], { oeffentlich: [reihe("t1", "halle", "Nur Halle")], privat: [] });
pruefe("Leiste fehlt", !h.includes("cw-katfilter"), h.slice(0, 300));

console.log("== 8. Geburtstage stehen weiter da, auch wenn alles gefiltert ist");
h = zeichne(["halle", "training", "veranstaltung"], { geburtstage: ["Carmine Perriello"], oeffentlich: OEFFENTLICH.filter((r) => r.termin.kategorie !== "gibt-es-nicht-mehr"), privat: [] });
pruefe("Geburtstag ist da", h.includes("Carmine Perriello"), h.slice(0, 600));

console.log("== 9. Klick schaltet um, merkt es sich und zeichnet neu");
zeichne([]);
sandbox.calendarWidgetOpts = {
  showCalendar: true, oeffentlich: OEFFENTLICH, privat: PRIVAT, kategorien: KATS, geburtstage: [],
  showAbsences: false, absences: [], absenceKategorien: [], showAblauf: false, ablauf: null
};
const klick = (ziel) => ({
  preventDefault: () => {},
  target: { closest: (sel) => (sel === "[data-kat-alle]" ? (ziel === "alle" ? {} : null) : sel === ".cw-katfilter-btn" ? (ziel !== "alle" ? { dataset: { kat: ziel } } : null) : null) }
});
neuGezeichnet = 0;
sandbox.onCalendarWidgetClick(klick("halle"));
pruefe("Halle ist aus", sandbox.kalKatAus.has("halle"));
pruefe("im Speicher steht sie", JSON.parse(speicher["tu-kal-kat-ausgeblendet"] || "[]").includes("halle"), speicher["tu-kal-kat-ausgeblendet"]);
pruefe("die Karte wurde neu gezeichnet", neuGezeichnet === 1, neuGezeichnet);
pruefe("und zeigt t1 nicht mehr", !zeigt(inhalt.innerHTML, "t1"));
sandbox.onCalendarWidgetClick(klick("halle"));
pruefe("nochmal klicken holt sie zurueck", !sandbox.kalKatAus.has("halle") && zeigt(inhalt.innerHTML, "t1"));
sandbox.onCalendarWidgetClick(klick("training"));
sandbox.onCalendarWidgetClick(klick("alle"));
pruefe("'Alle zeigen' raeumt den Filter", sandbox.kalKatAus.size === 0);
pruefe("und schreibt das weg", JSON.parse(speicher["tu-kal-kat-ausgeblendet"] || "[]").length === 0, speicher["tu-kal-kat-ausgeblendet"]);

console.log("== 10. Gemerkter Filter wird gelesen, kaputte Werte kippen nichts");
speicher["tu-kal-kat-ausgeblendet"] = JSON.stringify(["veranstaltung"]);
pruefe("liest die Liste", sandbox.ladeKalKatFilter().has("veranstaltung"));
speicher["tu-kal-kat-ausgeblendet"] = "{kein json";
pruefe("kaputter Eintrag ergibt leer", sandbox.ladeKalKatFilter().size === 0);
speicher["tu-kal-kat-ausgeblendet"] = JSON.stringify({ nicht: "array" });
pruefe("falscher Typ ergibt leer", sandbox.ladeKalKatFilter().size === 0);

console.log("");
if (fehler) { console.log(fehler + " FEHLER"); process.exit(1); }
console.log("ALLES GRUEN");
