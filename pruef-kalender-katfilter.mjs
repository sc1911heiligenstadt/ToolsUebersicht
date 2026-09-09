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
  schneideZeile("let kalFilterOffen ="),
  schneide("function ladeKalKatFilter("),
  schneide("function zeichneKalenderKarteNeu("),
  schneide("function onCalendarWidgetChange("),
  schneide("function schliesseKalFilterBeiKlickDaneben("),
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
    getElementById: (id) => (id === "termine-widget-inhalt" ? inhalt : id === "calendar-widget" ? widget : null),
    // Die Klappliste sucht ihren eigenen Behaelter, um "Klick daneben" von "Klick
    // darin" zu unterscheiden.
    querySelector: (sel) => (sel === ".cw-katfilter" ? { contains: (nn) => !!(nn && nn.imFilter) } : null),
    // Die Karte haengt beim ersten Zeichnen zwei Handler ans Dokument (Klick
    // daneben, Escape). Hier interessieren sie nicht -- gerufen werden die
    // Funktionen unten direkt.
    addEventListener: () => {}
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

console.log("== 2. Haken nur fuer Kategorien, die vorkommen");
pruefe("Halle hat eine Zeile", h.includes('data-kat="halle"'));
pruefe("die leere Kategorie NICHT", !h.includes('data-kat="ohne-termin"'), h.slice(0, 400));
pruefe("die Liste startet zugeklappt", h.includes("cw-katfilter-menu") && h.includes(" hidden>"));

console.log("== 3. Eine Kategorie aus");
h = zeichne(["training"]);
pruefe("die zwei Trainingstermine fehlen", !zeigt(h, "t2") && !zeigt(h, "t3"));
pruefe("auch der PRIVATE Trainingstermin fehlt", !zeigt(h, "p1"));
pruefe("der Rest ist da", zeigt(h, "t1") && zeigt(h, "t4"));
pruefe("'Alle zeigen' erscheint", h.includes("Alle zeigen"));
pruefe("der Haken bei Training ist raus", h.includes('data-kat="training">'), h.slice(h.indexOf("cw-katfilter-menu"), h.indexOf("cw-katfilter-menu") + 600));
pruefe("die anderen sind angehakt", h.includes('data-kat="halle" checked'));
pruefe("die Zeile ist als aus gekennzeichnet", h.includes('class="cwk-zeile aus"'));
pruefe("am Knopf steht, wie viele aus sind", h.includes(">1 aus<"));
const nachTraining = h.slice(h.indexOf('data-kat="training"'));
pruefe("und zaehlt weiter 3 (2 oeffentlich + 1 privat)", nachTraining.indexOf('cwk-zahl">3<') > -1 && nachTraining.indexOf('cwk-zahl">3<') < nachTraining.indexOf("</label>"), nachTraining.slice(0, 400));

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
pruefe("kein Filterknopf", !h.includes("cw-katfilter"));

console.log("== 7. Nur eine Kategorie vorhanden -> keine Leiste");
h = zeichne([], { oeffentlich: [reihe("t1", "halle", "Nur Halle")], privat: [] });
pruefe("Knopf fehlt", !h.includes("cw-katfilter"), h.slice(0, 300));

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
  imFilter: true,
  target: { closest: (sel) => (sel === ".cw-katfilter-toggle" ? (ziel === "toggle" ? {} : null) : sel === "[data-kat-alle]" ? (ziel === "alle" ? {} : null) : null) }
});
// Ein Haken, wie ihn der Browser meldet: das <input> traegt data-kat und den
// neuen Zustand in .checked.
const haken = (kat, angehakt) => ({ target: { closest: (sel) => (sel === "input[data-kat]" ? { dataset: { kat }, checked: angehakt } : null) } });
neuGezeichnet = 0;
sandbox.onCalendarWidgetChange(haken("halle", false));
pruefe("Halle ist aus", sandbox.kalKatAus.has("halle"));
pruefe("im Speicher steht sie", JSON.parse(speicher["tu-kal-kat-ausgeblendet"] || "[]").includes("halle"), speicher["tu-kal-kat-ausgeblendet"]);
pruefe("die Karte wurde neu gezeichnet", neuGezeichnet === 1, neuGezeichnet);
pruefe("und zeigt t1 nicht mehr", !zeigt(inhalt.innerHTML, "t1"));
sandbox.onCalendarWidgetChange(haken("halle", true));
pruefe("Haken zurueck holt sie wieder", !sandbox.kalKatAus.has("halle") && zeigt(inhalt.innerHTML, "t1"));
sandbox.onCalendarWidgetChange(haken("training", false));
sandbox.onCalendarWidgetClick(klick("alle"));
pruefe("'Alle zeigen' raeumt den Filter", sandbox.kalKatAus.size === 0);
pruefe("und schreibt das weg", JSON.parse(speicher["tu-kal-kat-ausgeblendet"] || "[]").length === 0, speicher["tu-kal-kat-ausgeblendet"]);

console.log("== 9b. Auf- und Zuklappen");
pruefe("startet zu", inhalt.innerHTML.includes(" hidden>"));
sandbox.onCalendarWidgetClick(klick("toggle"));
pruefe("Knopf macht auf", !inhalt.innerHTML.includes(" hidden>") && inhalt.innerHTML.includes('aria-expanded="true"'));
// Der Kern: ein Haken darf die Liste NICHT zuklappen.
sandbox.onCalendarWidgetChange(haken("training", false));
pruefe("ein Haken laesst sie offen", !inhalt.innerHTML.includes(" hidden>"));
sandbox.schliesseKalFilterBeiKlickDaneben({ target: { irgendwo: true } });
pruefe("Klick daneben macht zu", inhalt.innerHTML.includes(" hidden>"));
sandbox.onCalendarWidgetClick(klick("toggle"));
sandbox.schliesseKalFilterBeiKlickDaneben({ target: { imFilter: true } });
pruefe("Klick IN der Liste macht nicht zu", !inhalt.innerHTML.includes(" hidden>"));
sandbox.onCalendarWidgetClick(klick("toggle"));
pruefe("Knopf macht wieder zu", inhalt.innerHTML.includes(" hidden>"));
sandbox.onCalendarWidgetClick(klick("alle"));

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
