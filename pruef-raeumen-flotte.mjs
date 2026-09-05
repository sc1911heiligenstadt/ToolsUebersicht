// =============================================================================
// pruef-raeumen-flotte.mjs
//
// Zusage: Faellt die Sitzung weg, WAEHREND eine App offen ist, verschwindet das
// Angezeigte wirklich -- und nicht nur hinter display:none.
//
// Geprueft werden sieben Apps auf einmal, weil die Bauform in allen dieselbe ist
// und eine Zusage, die nur in einer Datei steht, beim naechsten Repo vergessen
// wird.
//
// Aufruf:   node pruef-raeumen-flotte.mjs
//           node pruef-raeumen-flotte.mjs --mutation
//
// Der eigentliche Zweck ist nicht der heutige Stand, sondern der NAECHSTE
// Dialog: Zusage C6 faellt um, sobald jemand ein Overlay neben die Huelle baut,
// das der Raeum-Selektor nicht trifft.
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HIER = dirname(fileURLToPath(import.meta.url));
const FLOTTE = join(HIER, "..");
const MUTATION = process.argv.includes("--mutation");

// -----------------------------------------------------------------------------
// Die Apps und ihre app-spezifischen Namen.
// Wer eine App ergaenzt, traegt sie hier ein -- und C6 prueft ihre Dialoge mit.
// -----------------------------------------------------------------------------
// dbWuerfe = wie viele "throw new NotLoggedInError" in db.js stehen. Jeder davon
// muss den Haken tragen (Zusage C2) -- deshalb die genaue Zahl und nicht "min. 1".
const SHELL_AN = 'document.getElementById("app-shell").style.display = "";';
const APPS = [
  { name: "spielstatistik",  gate: "showConnectScreen", trichter: ["renderAll"],   start: "startApp",  dbWuerfe: 2 },
  { name: "spieltagscrew",   gate: "zeigeLoginGate",    trichter: ["renderAll"],   startAnker: SHELL_AN, dbWuerfe: 2 },
  { name: "ablaufplan",      gate: "zeigeAbmeldung",    trichter: ["renderAlles"], startAnker: SHELL_AN, dbWuerfe: 4 },
  { name: "schulsport",      gate: "showConnectScreen", trichter: ["renderAlles"], start: "startApp",  dbWuerfe: 2 },
  { name: "ausbildungsplan", gate: "showConnectScreen", trichter: ["renderAlles"], start: "startApp",  dbWuerfe: 2 },
  { name: "kleiderboerse",   gate: "showConnectScreen", trichter: ["renderAlles"], start: "startApp",  dbWuerfe: 4 },
  { name: "kontakte",        gate: "showConnectScreen", trichter: ["renderListe", "renderMannschaften"], start: "showApp", dbWuerfe: 2 },

  // Zweite Runde (30.08.2026): raeumten schon die Huelle, aber nicht, was daneben steht.
  { name: "kadermanager",         gate: "showConnectScreen", trichter: ["renderAll"], start: "startApp", dbWuerfe: 6 },
  { name: "Vereinsaufgaben",      gate: "zeigeLoginGate",    trichter: ["renderAll"], startAnker: SHELL_AN, dbWuerfe: 6 },
  { name: "busplan",              gate: "showConnectScreen", trichter: ["renderAll"], start: "startApp", dbWuerfe: 2 },
  { name: "Personalkosten",       gate: "showConnectScreen", trichter: ["renderAll"], start: "startApp", dbWuerfe: 2 },
  { name: "fahrtenbuch",          gate: "showConnectScreen", trichter: ["renderAll"], start: "startApp", dbWuerfe: 6 },
  { name: "platzbelegung",        gate: "showConnectScreen", trichter: ["renderAll"], start: "startApp", dbWuerfe: 4 },
  { name: "spielersichtung",      gate: "showConnectScreen", trichter: ["renderAll"], start: "startApp", dbWuerfe: 2 },
  { name: "abwesenheitskalender", gate: "showConnectScreen", trichter: ["renderAll"], start: "startApp", dbWuerfe: 2 },
  { name: "vereinskalender",      gate: "showConnectScreen", trichter: ["renderAll"], start: "startApp", dbWuerfe: 4 },
  { name: "raumnutzung",          gate: "showConnectScreen", trichter: ["renderListen"], startAnker: 'el("app-shell").style.display = "";', dbWuerfe: 3 },
];

// -----------------------------------------------------------------------------
// Was NEBEN der Huelle stehen DARF, ohne geraeumt zu werden -- ausdruecklich
// benannt, damit ein neues Element dort auffaellt statt durchzurutschen.
// -----------------------------------------------------------------------------
const AUSNAHMEN = [
  { was: "header-right", warum: "Logo und Zurueck-Link. Das einzige Datenfeld darin ist #header-user, und das wird geraeumt (siehe C7). Ohne den Zurueck-Link staende man vor einer weissen Seite." },
];

// =============================================================================
// Papp-DOM
// =============================================================================
class PappEl {
  constructor(tag, id, klassen) {
    this.tagName = tag.toUpperCase();
    this.id = id || "";
    this._html = "";
    this.kinder = [];
    this.eltern = null;
    this.style = { display: "" };
    this.type = "";
    this.value = "";
    this.checked = false;
    const satz = new Set((klassen || "").split(/\s+/).filter(Boolean));
    this.classList = {
      add: (k) => satz.add(k),
      remove: (k) => satz.delete(k),
      contains: (k) => satz.has(k),
      toggle: (k, an) => (an === undefined ? (satz.has(k) ? satz.delete(k) : satz.add(k)) : (an ? satz.add(k) : satz.delete(k))),
      _satz: satz,
    };
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    // Genau die Wirkung, um die es geht: ein leeres innerHTML entfernt die
    // Kinder -- damit auch jedes <input> samt seinem Wert.
    if (this._html === "") { this.kinder.forEach((k) => { k.eltern = null; }); this.kinder = []; }
  }
  get textContent() { return this._html; }
  set textContent(v) { this.innerHTML = v; }
  querySelectorAll(sel) {
    const teile = sel.split(",").map((s) => s.trim()).filter(Boolean);
    return this.kinder.filter((k) => teile.some((t) => k.passt(t)));
  }
  passt(sel) {
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
}

function bauePappDom(elemente) {
  const alle = [];
  const nachId = new Map();
  for (const e of elemente) {
    const el = new PappEl(e.tag, e.id, e.klasse);
    alle.push(el);
    if (el.id) nachId.set(el.id, el);
  }
  const haengtDran = (el) => {
    let n = el, tiefe = 0;
    while (n && tiefe++ < 50) { if (!n.eltern) return n._wurzel === true; n = n.eltern; }
    return false;
  };
  return {
    alle, nachId, haengtDran,
    document: {
      getElementById: (id) => nachId.get(id) || null,
      querySelectorAll: (sel) => {
        const teile = sel.split(",").map((s) => s.trim()).filter(Boolean);
        return alle.filter((el) => haengtDran(el) && teile.some((t) => el.passt(t)));
      },
      addEventListener: () => {},
    },
  };
}

// =============================================================================
// index.html: was steht auf oberster Ebene NEBEN der Huelle?
// =============================================================================
function obersteEbene(html) {
  const body = html.slice(html.indexOf("<body"), html.lastIndexOf("</body>"));
  const ohneScript = body.replace(/<script[\s\S]*?<\/script>/g, "");
  const tags = [...ohneScript.matchAll(/<(\/?)(div|dialog|section|aside)\b([^>]*)>/g)];
  const raus = [];
  let tiefe = 0;
  for (const t of tags) {
    const zu = t[1] === "/";
    if (zu) { tiefe = Math.max(0, tiefe - 1); continue; }
    const attr = t[3] || "";
    const selbstschliessend = attr.trim().endsWith("/");
    if (tiefe === 0) {
      const id = (/\bid="([^"]*)"/.exec(attr) || [])[1] || "";
      const klasse = (/\bclass="([^"]*)"/.exec(attr) || [])[1] || "";
      raus.push({ tag: t[2], id, klasse });
    }
    if (!selbstschliessend) tiefe++;
  }
  return raus;
}

// =============================================================================
// Quelltext-Werkzeug
// =============================================================================
function schneideFunktion(quelle, kopf) {
  const a = quelle.indexOf(kopf);
  if (a < 0) return null;
  const e = quelle.indexOf("\n}\n", a);
  if (e < 0) return null;
  return quelle.slice(a, e + 3);
}

function rumpfVon(quelle, kopf) {
  const f = schneideFunktion(quelle, kopf);
  return f === null ? "" : f;
}

// =============================================================================
// Zusagen
// =============================================================================
let gruen = 0;
const rot = [];
let aktuelleApp = "";

function zusage(id, text, bedingung) {
  if (bedingung) { gruen++; return; }
  rot.push(`${aktuelleApp} ${id}: ${text}`);
}

function abbruch(text) {
  console.error("ABBRUCH: " + text);
  process.exit(1);
}

// =============================================================================
// Mutationen -- jede muss auffallen
// =============================================================================
// ⚠️ Zwei Fallen, beide hier aufgeschlagen:
//
//   1. Eine Mutation, die auf den WORTLAUT zielt, laeuft ins Leere, sobald sich
//      der Wortlaut aendert. Also auf die Struktur zielen.
//   2. Eine Mutation, die einfach das erste Vorkommen im FILE ersetzt, trifft
//      irgendeine andere Stelle -- `el.innerHTML = "";` steht in kadermanager
//      schon 500 Zeilen frueher. Sie aendert dann etwas Belangloses und meldet
//      "gefangen"/"durch" ueber eine Zeile, die gar nicht gemeint war.
//
// Deshalb wird jede Mutation, die auf den Raeum-Code zielt, auf DESSEN Rumpf
// eingegrenzt.
function nurIn(kopf, wandle) {
  return (s) => {
    const f = schneideFunktion(s, kopf);
    if (f === null) return s;
    return s.replace(f, wandle(f));
  };
}

const RB = "function raeumeBildschirm() {";
const RS = "function raeumeBeiSitzungsverlust() {";

const MUTATIONEN = [
  { id: "M1", was: "app.js", beschreibung: "innerHTML-Leeren der Huelle entfernt",
    tun: nurIn(RB, (f) => f.replace('  if (huelle) huelle.innerHTML = "";\n', "")) },
  { id: "M2", was: "app.js", beschreibung: "Selektor entkernt (alles neben der Huelle faellt raus)",
    tun: nurIn(RB, (f) => f.replace(/querySelectorAll\("[^"]*"\)/, 'querySelectorAll("#gibtesnicht")')) },
  { id: "M3", was: "app.js", beschreibung: "display:none neben der Huelle entfernt",
    tun: nurIn(RB, (f) => f.replace('    el.style.display = "none";\n', "")) },
  { id: "M4", was: "app.js", beschreibung: "innerHTML-Leeren neben der Huelle entfernt",
    tun: nurIn(RB, (f) => f.replace('    el.innerHTML = "";\n', "")) },
  { id: "M5", was: "app.js", beschreibung: "Merker bildschirmGeraeumt wird nicht gesetzt",
    tun: nurIn(RB, (f) => f.replace("  bildschirmGeraeumt = true;\n", "")) },
  { id: "M6", was: "app.js", beschreibung: "Riegel gegen den Start-Fall entfernt",
    tun: nurIn(RS, (f) => f.replace("  if (!appLaeuft) return;\n", "")) },
  { id: "M7", was: "app.js", beschreibung: "Gate raeumt nicht mehr",
    tun: (s, cfg) => s.replace(`function ${cfg.gate}(`, `function ${cfg.gate}(`).replace(
      new RegExp(`(function ${cfg.gate}\\([^)]*\\) \\{\\n)  raeumeBildschirm\\(\\);\\n`), "$1") },
  { id: "M8", was: "db.js", beschreibung: "Haken in db.js entfernt",
    tun: (s) => s.replace(/\{ if \(typeof raeumeBeiSitzungsverlust === "function"\) raeumeBeiSitzungsverlust\(\); throw ([^\n]*); \}/g, "throw $1;") },
  { id: "M9", was: "app.js", beschreibung: "Nachzuegler-Riegel im Zeichen-Trichter entfernt",
    tun: (s) => s.replace(/  if \(bildschirmGeraeumt\) return;\n/g, "") },
];

// =============================================================================
// Ein Durchlauf fuer eine App
// =============================================================================
function pruefeApp(cfg, mutation) {
  aktuelleApp = cfg.name.padEnd(15);
  const ordner = join(FLOTTE, cfg.name);
  if (!existsSync(ordner)) return false;

  // ⚠️ Vier der Repos haben CRLF- oder gemischte Zeilenenden. Hier wird nur
  // GELESEN, nie geschrieben -- deshalb darf normalisiert werden, und die
  // Zusagen unten kommen mit einem einzigen Zeilenende aus.
  const lf = (p) => readFileSync(join(ordner, p), "utf8").replace(/\r\n/g, "\n");
  let appJs = lf("app.js");
  let dbJs = lf("db.js");
  const html = lf("index.html");

  // --- Anfangsmarken. Fehlt eine, ist der Prueflauf wertlos -> lauter Abbruch.
  if (!mutation) {
    if (!appJs.includes("function raeumeBildschirm() {")) abbruch(`Anfangsmarke fehlt -- raeumeBildschirm in ${cfg.name}/app.js`);
    if (!appJs.includes("function raeumeBeiSitzungsverlust() {")) abbruch(`Anfangsmarke fehlt -- raeumeBeiSitzungsverlust in ${cfg.name}/app.js`);
    if (!appJs.includes(`function ${cfg.gate}(`)) abbruch(`Anfangsmarke fehlt -- Gate ${cfg.gate} in ${cfg.name}/app.js`);
  }

  if (mutation) {
    if (mutation.was === "app.js") appJs = mutation.tun(appJs, cfg);
    else dbJs = mutation.tun(dbJs, cfg);
  }

  // -------------------------------------------------------------------------
  // Szene aus dem ECHTEN index.html: Huelle plus alles, was daneben steht.
  // -------------------------------------------------------------------------
  const oben = obersteEbene(html);
  const daneben = oben.filter((e) => e.id !== "app-shell" && e.id !== "connect-screen");

  const elemente = [
    { tag: "div", id: "app-shell", klasse: "" },
    { tag: "div", id: "connect-screen", klasse: "connect-screen" },
    { tag: "p", id: "cloud-error", klasse: "muted" },
    { tag: "p", id: "connect-error", klasse: "muted" },
    ...daneben,
    { tag: "span", id: "header-user", klasse: "header-user" },
    { tag: "input", id: "test-feld-im-dialog", klasse: "" },
    { tag: "input", id: "test-feld-in-huelle", klasse: "" },
  ];

  const dom = bauePappDom(elemente);
  dom.alle.forEach((el) => { el._wurzel = true; });

  const huelle = dom.nachId.get("app-shell");
  const feldHuelle = dom.nachId.get("test-feld-in-huelle");
  feldHuelle.eltern = huelle; feldHuelle._wurzel = false; huelle.kinder.push(feldHuelle);

  const dialoge = daneben.map((e) => dom.nachId.get(e.id)).filter(Boolean);
  const ersterDialog = dialoge[0] || null;
  const feldDialog = dom.nachId.get("test-feld-im-dialog");
  if (ersterDialog) {
    feldDialog.eltern = ersterDialog; feldDialog._wurzel = false; ersterDialog.kinder.push(feldDialog);
  }

  // Alles voll mit Daten, die niemand mehr sehen darf, und ein OFFENER Dialog.
  huelle.innerHTML = "GEHEIM-HUELLE";
  dialoge.forEach((d) => { d.innerHTML = "GEHEIM-DIALOG"; d.classList.remove("hidden"); d.style.display = "flex"; });
  dom.nachId.get("cloud-error").innerHTML = "Bitte neu anmelden.";
  dom.nachId.get("connect-error").innerHTML = "Bitte neu anmelden.";
  dom.nachId.get("header-user").innerHTML = "Max Mustermann";

  // -------------------------------------------------------------------------
  // Den ECHTEN Code aus der Datei ausfuehren -- nicht eine Kopie davon.
  // -------------------------------------------------------------------------
  const teile = [
    "let bildschirmGeraeumt = false;",
    "let appLaeuft = false;",
    rumpfVon(appJs, "function raeumeBildschirm() {"),
    rumpfVon(appJs, "function raeumeBeiSitzungsverlust() {"),
  ];
  if (!teile[2] || !teile[3]) {
    if (!mutation) abbruch(`Funktionen nicht ausschneidbar in ${cfg.name}/app.js`);
    return true;
  }

  const gateAufrufe = [];
  const quelle = teile.join("\n") +
    `\nfunction ${cfg.gate}() { gateAufrufe.push(1); raeumeBildschirm(); }\n` +
    "\nreturn { raeumeBildschirm, raeumeBeiSitzungsverlust," +
    " flags: () => ({ bildschirmGeraeumt, appLaeuft }), start: () => { appLaeuft = true; } };";

  let api;
  try {
    api = new Function("document", "gateAufrufe", quelle)(dom.document, gateAufrufe);
  } catch (e) {
    if (!mutation) abbruch(`Quelle nicht ausfuehrbar in ${cfg.name}/app.js: ${e.message}`);
    return true;
  }

  // ======================= B: der Riegel vor dem Start =======================
  api.raeumeBeiSitzungsverlust();
  zusage("B1", "vor dem Start wird das Gate nicht gezeigt", gateAufrufe.length === 0);
  zusage("B2", "vor dem Start bleibt die Huelle unangetastet", huelle.innerHTML === "GEHEIM-HUELLE");

  api.start();
  api.raeumeBeiSitzungsverlust();
  zusage("B3", "nach dem Start fuehrt der Sitzungsverlust auf das Gate", gateAufrufe.length === 1);

  // ============================ A: wirklich leer ============================
  zusage("A1", "die Huelle ist leer", huelle.innerHTML === "");
  zusage("A2", "ein Eingabefeld in der Huelle ist nicht mehr erreichbar", !dom.haengtDran(feldHuelle));
  zusage("A3", "der Merker bildschirmGeraeumt steht", api.flags().bildschirmGeraeumt === true);

  if (dialoge.length) {
    zusage("A4", "jeder Dialog neben der Huelle ist leer", dialoge.every((d) => d.innerHTML === ""));
    zusage("A5", "jeder Dialog ist unsichtbar", dialoge.every((d) => d.style.display === "none"));
    zusage("A6", "jeder Dialog traegt hidden", dialoge.every((d) => d.classList.contains("hidden")));
    zusage("A7", "ein Feld im offenen Dialog ist nicht mehr erreichbar", !dom.haengtDran(feldDialog));
  }

  // Der Name im Kopf ist in JEDER App der Flotte da -- er traegt die Zusage auch
  // dort, wo neben der Huelle sonst nichts steht (kontakte, kleiderboerse,
  // raumnutzung). Ohne ihn haetten die drei Apps gar keine Probe fuer den
  // Selektor.
  zusage("A8", "der Name im Seitenkopf ist weg", dom.nachId.get("header-user").innerHTML === "");
  zusage("A8b", "der Name im Seitenkopf ist auch unsichtbar", dom.nachId.get("header-user").style.display === "none");

  // Gegenprobe: der Anmeldeschirm darf NICHT mitgeraeumt werden, sonst stuende
  // der Nutzer vor einer weissen Seite ohne Hinweis.
  zusage("A9", "der Anmeldeschirm bleibt stehen", dom.nachId.get("cloud-error").innerHTML !== "" && dom.nachId.get("connect-error").innerHTML !== "");

  // ========================= C: die Verdrahtung =========================
  const gateRumpf = rumpfVon(appJs, `function ${cfg.gate}(`);
  zusage("C1", `${cfg.gate}() raeumt als erste Zeile`,
    /^function [^\n]*\{\n\s*raeumeBildschirm\(\);/.test(gateRumpf));

  const wuerfe = (dbJs.match(/throw new NotLoggedInError/g) || []).length;
  const haken = (dbJs.match(/typeof raeumeBeiSitzungsverlust === "function"/g) || []).length;
  zusage("C2", `db.js: alle ${cfg.dbWuerfe} Sitzungs-Wuerfe tragen den Haken (gefunden: ${wuerfe} Wuerfe, ${haken} Haken)`,
    wuerfe === cfg.dbWuerfe && haken === wuerfe);

  // Kein zweiter, handgebauter Raeum-Ort: sonst weiss niemand mehr, welcher gilt.
  const eigenhaendig = (appJs.match(/app-shell"\)\.innerHTML|__huelle\.innerHTML/g) || []).length;
  zusage("C3", "es gibt genau EINEN Raeum-Ort", eigenhaendig === 0);

  for (const t of cfg.trichter) {
    const r = rumpfVon(appJs, `function ${t}(`);
    zusage("C4", `${t}() traegt den Nachzuegler-Riegel`, /^function [^\n]*\{\n\s*if \(bildschirmGeraeumt\) return;/.test(r));
  }

  if (cfg.start) {
    const r = rumpfVon(appJs, `function ${cfg.start}(`);
    zusage("C5", `${cfg.start}() setzt appLaeuft`, /appLaeuft = true;/.test(r));
  } else {
    const i = appJs.indexOf(cfg.startAnker);
    zusage("C5", "appLaeuft wird gesetzt, wo die Huelle sichtbar wird",
      i > 0 && appJs.slice(Math.max(0, i - 120), i).includes("appLaeuft = true;"));
  }

  // ---- C6: die eigentliche Zusage fuer die Zukunft -------------------------
  // Alles, was NEBEN der Huelle steht, muss der Raeum-Selektor treffen -- oder
  // ausdruecklich auf der Ausnahmeliste stehen. Wer morgen ein Overlay mit einer
  // neuen Klasse daneben baut, faellt hier auf, statt still durchzurutschen.
  const selektorZeile = /querySelectorAll\("([^"]+)"\)/.exec(rumpfVon(appJs, "function raeumeBildschirm() {"));
  const selektoren = selektorZeile ? selektorZeile[1].split(",").map((s) => s.trim()) : [];
  const gedeckt = (e) => {
    const el = new PappEl(e.tag, e.id, e.klasse);
    return selektoren.some((s) => el.passt(s));
  };
  const ungedeckt = daneben.filter((e) => !gedeckt(e) && !AUSNAHMEN.some((a) => e.id === a.was || e.klasse.split(/\s+/).includes(a.was)));
  zusage("C6", `kein Element neben der Huelle bleibt ungedeckt (offen: ${ungedeckt.map((u) => u.id || u.klasse).join(", ")})`,
    ungedeckt.length === 0);

  // ---- C7: die Ausnahme muss ehrlich bleiben -------------------------------
  // .header-right darf stehenbleiben, WEIL das einzige Datenfeld darin --
  // der Name des Angemeldeten -- eigens geraeumt wird. Faellt das weg, ist die
  // Ausnahme keine mehr.
  if (html.includes('id="header-user"')) {
    zusage("C7", "der Name im Seitenkopf wird geraeumt", selektoren.includes("#header-user"));
  }

  return true;
}

// =============================================================================
// Trainerdaten -- eigene Bauform, eigener Abschnitt
//
// Diese App hat KEINE app-shell, sondern zwei Ablaeufe nebeneinander. Der
// Trainer-Ablauf raeumt seit dem 25.08. seine fuenf Bildschirme; der
// Admin-Ablauf raeumte gar nicht, obwohl dort die Liste ALLER Trainer steht.
// =============================================================================
const TD_MUTATIONEN = [
  { id: "T-M1", was: "app.js", beschreibung: "Leeren des Admin-Panels entfernt",
    tun: nurIn("function raeumeAdminBildschirm() {", (f) => f.replace('    panel.innerHTML = "";\n', "")) },
  { id: "T-M2", was: "app.js", beschreibung: "Formularwerte im Admin-Panel bleiben stehen",
    tun: nurIn("function raeumeAdminBildschirm() {", (f) => f.replace(/    panel\.querySelectorAll\("input, textarea"\)[\s\S]*?\n    \}\);\n/, "")) },
  { id: "T-M3", was: "app.js", beschreibung: "Zwischenspeicher davConfig/appData bleiben stehen",
    tun: nurIn("function raeumeAdminBildschirm() {", (f) => f.replace("  davConfig = null;\n", "")) },
  { id: "T-M4", was: "app.js", beschreibung: "Riegel gegen den Start-Fall entfernt",
    tun: nurIn("function raeumeBeiSitzungsverlust() {", (f) => f.replace("  if (!appLaeuft) return;\n", "")) },
  { id: "T-M5", was: "db.js", beschreibung: "Haken in db.js entfernt",
    tun: (s) => s.replace(/if \(typeof raeumeBeiSitzungsverlust === "function"\) raeumeBeiSitzungsverlust\(\); /g, "") },
];

function pruefeTrainerdaten(mutation) {
  aktuelleApp = "Trainerdaten".padEnd(15);
  const ordner = join(FLOTTE, "Trainerdaten");
  if (!existsSync(ordner)) return false;
  const lf = (p) => readFileSync(join(ordner, p), "utf8").replace(/\r\n/g, "\n");
  let appJs = lf("app.js"), dbJs = lf("db.js");
  const html = lf("index.html");

  if (!mutation) {
    if (!appJs.includes("function raeumeAdminBildschirm() {")) abbruch("Anfangsmarke fehlt -- raeumeAdminBildschirm in Trainerdaten/app.js");
    if (!appJs.includes("function _showTrainerConnectScreen(")) abbruch("Anfangsmarke fehlt -- _showTrainerConnectScreen in Trainerdaten/app.js");
  }
  if (mutation) {
    if (mutation.was === "app.js") appJs = mutation.tun(appJs);
    else dbJs = mutation.tun(dbJs);
  }

  // ---- Szene: das Admin-Panel voller Daten, die niemand mehr sehen darf -----
  const elemente = [
    { tag: "div", id: "admin-flow", klasse: "" },
    { tag: "div", id: "admin-panel", klasse: "" },
    { tag: "div", id: "admin-connect-screen", klasse: "connect-screen" },
    { tag: "p", id: "admin-connect-error", klasse: "" },
    { tag: "div", id: "file-status", klasse: "" },
    { tag: "input", id: "d-iban", klasse: "" },
    { tag: "input", id: "d-anschrift", klasse: "" },
    { tag: "textarea", id: "d-notiz", klasse: "" },
  ];
  const dom = bauePappDom(elemente);
  dom.alle.forEach((el) => { el._wurzel = true; });
  const panel = dom.nachId.get("admin-panel");
  ["d-iban", "d-anschrift", "d-notiz"].forEach((id) => {
    const f = dom.nachId.get(id);
    f.eltern = panel; f._wurzel = false; panel.kinder.push(f);
    f.value = "GEHEIM";
  });
  panel.innerHTML = "Trainerliste: Anna Beispiel, DE00 1234";
  panel._html = "Trainerliste: Anna Beispiel, DE00 1234";
  ["d-iban", "d-anschrift", "d-notiz"].forEach((id) => {
    const f = dom.nachId.get(id);
    f.eltern = panel; f._wurzel = false;
  });
  panel.kinder = ["d-iban", "d-anschrift", "d-notiz"].map((id) => dom.nachId.get(id));
  dom.nachId.get("admin-panel").style.display = "";
  dom.nachId.get("admin-connect-screen").style.display = "none";
  dom.nachId.get("file-status").style.display = "";

  const rumpf = rumpfVon(appJs, "function raeumeAdminBildschirm() {");
  if (!rumpf) { if (!mutation) abbruch("raeumeAdminBildschirm nicht ausschneidbar"); return true; }

  // ⚠️ Seit dem 06.09.2026 ruft raeumeAdminBildschirm auch _snapshotBase(), damit
  // der Drei-Wege-Abgleich in _saveMerged nach dem Raeumen keine alte Basis behaelt.
  // Dieser Pruefstand schneidet die Funktion heraus und fuehrt sie ALLEIN aus -- ein
  // Bezug nach draussen laesst ihn beim Bauen mit einem ReferenceError sterben, und
  // ein Pruefstand, der beim Einlesen stirbt, meldet keinen Fehlschlag, sondern gar
  // nichts. Also wird der Helfer ECHT mitgeschnitten (kein Nachbau), samt der
  // Variablen, auf der er arbeitet.
  const snapRumpf = rumpfVon(appJs, "function _snapshotBase() {");
  if (!snapRumpf) { if (!mutation) abbruch("_snapshotBase nicht ausschneidbar"); return true; }
  const baseZeile = (appJs.match(/^let _baseTrainer = .*$/m) || [])[0];
  if (!baseZeile) { if (!mutation) abbruch("_baseTrainer nicht gefunden"); return true; }

  let api;
  try {
    api = new Function("document", "zustand",
      "let bildschirmGeraeumt = false;\nlet davConfig = { url: 'x' };\nlet appData = { version: 1, trainer: [{ iban: 'DE00' }] };\n" +
      baseZeile + "\n" + snapRumpf + "\n" +
      rumpf +
      "\nreturn { raeumeAdminBildschirm, stand: () => ({ bildschirmGeraeumt, davConfig, appData, basis: _baseTrainer }) };")(dom.document, {});
  } catch (e) {
    if (!mutation) abbruch("Trainerdaten-Quelle nicht ausfuehrbar: " + e.message);
    return true;
  }

  api.raeumeAdminBildschirm();

  zusage("T1", "das Admin-Panel ist leer", panel.innerHTML === "");
  zusage("T2", "die Eingabefelder darin sind geleert",
    ["d-iban", "d-anschrift", "d-notiz"].every((id) => dom.nachId.get(id).value === ""));
  zusage("T3", "das Admin-Panel ist unsichtbar", panel.style.display === "none");
  zusage("T4", "der Anmeldeschirm des Verwaltungsteils steht", dom.nachId.get("admin-connect-screen").style.display === "");
  zusage("T5", "der Hinweis nennt die abgelaufene Sitzung", /Sitzung ist abgelaufen/.test(dom.nachId.get("admin-connect-error").innerHTML));
  zusage("T6", "die Zwischenspeicher sind geleert",
    api.stand().davConfig === null && (api.stand().appData.trainer || []).length === 0);
  zusage("T7", "der Merker steht", api.stand().bildschirmGeraeumt === true);
  // Der Abgleichs-Schnappschuss ist ein Zwischenspeicher wie davConfig: bleibt er
  // nach dem Raeumen stehen, misst der naechste _saveMerged gegen eine Basis aus
  // einer Sitzung, die es nicht mehr gibt.
  zusage("T7b", "die Basis des Drei-Wege-Abgleichs ist leer", api.stand().basis.size === 0);

  // ---- Quelltext ------------------------------------------------------------
  const rs = rumpfVon(appJs, "function raeumeBeiSitzungsverlust() {");
  zusage("T8", "der Start-Riegel steht vorn", /^function [^\n]*\{\n\s*if \(!appLaeuft\) return;/.test(rs));
  zusage("T9", "auch der Trainer-Ablauf wird mitgeraeumt", /_showTrainerConnectScreen\(/.test(rs));

  const wuerfe = (dbJs.match(/new NotLoggedInError/g) || []).length;
  const haken = (dbJs.match(/typeof raeumeBeiSitzungsverlust === "function"/g) || []).length;
  // ⚠️ Hier stand bis zum 06.09.2026 `wuerfe === 30 && haken === 30`. Die
  // geschuetzte Eigenschaft ist aber nicht die Zahl 30, sondern das PAAR: jede
  // Stelle, die einen Sitzungsfehler wirft, muss den Raeum-Haken tragen. db.js hat
  // 28 solche Stellen, alle 28 mit Haken -- der Pruefstand lief trotzdem rot und
  // zeigte damit ueber Laeufe hinweg einen Fehler an, den es nicht gab.
  // Die Untergrenze > 0 bleibt: greift der Regex einmal ins Leere, waere 0 === 0
  // sonst still gruen, und der Pruefstand pruefte gar nichts mehr.
  zusage("T10", `db.js: alle ${wuerfe} Sitzungs-Fehler tragen den Haken (gefunden ${haken})`,
    wuerfe > 0 && wuerfe === haken);

  // ⚠️ Die Falle aus dem Durchgang vom 25.08.: wer einen SECHSTEN Trainer-Bildschirm
  // ergaenzt, muss ihn in die Raeum-Liste eintragen -- sonst wird er versteckt,
  // aber nicht geraeumt. Deshalb hier gegen das echte index.html geprueft.
  const imMarkup = [...html.matchAll(/id="(trainer-(?:form|success)-screen|trainer-\w+-panel)"/g)].map((m) => m[1]);
  const inDerListe = rumpfVon(appJs, "function _showTrainerConnectScreen(errorMsg) {");
  const fehlend = imMarkup.filter((id) => !inDerListe.includes('"' + id + '"'));
  zusage("T11", `jeder Trainer-Bildschirm steht in der Raeum-Liste (fehlt: ${fehlend.join(", ")})`, fehlend.length === 0);

  // Nach dem Raeumen gibt es #admin-detail-error nicht mehr -- kein blinder Zugriff.
  const blind = (appJs.match(/document\.getElementById\("admin-detail-error"\)\.(textContent|classList)/g) || []).length;
  zusage("T12", `kein blinder Zugriff auf das Detail-Banner (gefunden: ${blind})`, blind <= 1);

  return true;
}

// =============================================================================
// Lauf
// =============================================================================
console.log("Prueft: Bildschirm raeumen bei Sitzungsverlust\n");

let gefunden = 0;
for (const cfg of APPS) if (pruefeApp(cfg, null)) gefunden++;
if (pruefeTrainerdaten(null)) gefunden++;

// Ein stiller No-Op ist schlimmer als ein roter Lauf: ohne Apps kein Urteil.
const SOLL = APPS.length + 1; // + Trainerdaten
if (gefunden === 0) abbruch("keine einzige App gefunden -- lief der Prueflauf im richtigen Ordner?");
if (gefunden < SOLL) console.log(`Hinweis: ${SOLL - gefunden} App(s) nicht gefunden, uebersprungen.\n`);

for (const z of rot) console.log("  ROT  " + z);
console.log(`\n${gruen} Zusagen gruen, ${rot.length} rot (${gefunden}/${SOLL} Apps).`);

if (MUTATION) {
  console.log("\n--- Mutationsprobe: jede Aenderung muss auffallen ---");
  // ⚠️ Nicht beim ersten Treffer aufhoeren. Sonst belegt die Probe nur, dass die
  // Mutation in EINER App auffaellt -- und eine App, in der sie durchrutscht,
  // faellt nie auf. Jede Mutation muss in JEDER App auffallen.
  let gefangen = 0;
  for (const m of MUTATIONEN) {
    const durch = [];
    for (const cfg of APPS) {
      const vorher = rot.length, vorherGruen = gruen;
      let entdeckt = false;
      try { pruefeApp(cfg, m); } catch (_) { entdeckt = true; }
      if (rot.length > vorher) entdeckt = true;
      rot.length = vorher; gruen = vorherGruen;
      if (!entdeckt) durch.push(cfg.name);
    }
    const alle = durch.length === 0;
    console.log(`  ${alle ? "gefangen " : "DURCH    "} ${m.id} (${m.was}) ${m.beschreibung}` +
      (alle ? ` [${APPS.length}/${APPS.length}]` : `  -> durchgerutscht bei: ${durch.join(", ")}`));
    if (alle) gefangen++;
  }
  console.log(`\n${gefangen}/${MUTATIONEN.length} Mutationen in ALLEN ${APPS.length} Apps gefangen.`);

  console.log("\n--- Mutationsprobe Trainerdaten (eigene Bauform) ---");
  let tdGefangen = 0;
  for (const m of TD_MUTATIONEN) {
    const vorher = rot.length, vorherGruen = gruen;
    let entdeckt = false;
    try { pruefeTrainerdaten(m); } catch (_) { entdeckt = true; }
    if (rot.length > vorher) entdeckt = true;
    rot.length = vorher; gruen = vorherGruen;
    console.log(`  ${entdeckt ? "gefangen " : "DURCH    "} ${m.id} (${m.was}) ${m.beschreibung}`);
    if (entdeckt) tdGefangen++;
  }
  console.log(`\n${tdGefangen}/${TD_MUTATIONEN.length} Trainerdaten-Mutationen gefangen.`);

  if (gefangen < MUTATIONEN.length || tdGefangen < TD_MUTATIONEN.length) process.exit(1);
}

process.exit(rot.length ? 1 : 0);
