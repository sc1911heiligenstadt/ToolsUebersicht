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
const APPS = [
  { name: "spielstatistik",  gate: "showConnectScreen", trichter: ["renderAll"],   start: "startApp",  dbPaare: 1 },
  { name: "spieltagscrew",   gate: "zeigeLoginGate",    trichter: ["renderAll"],   startAnker: 'document.getElementById("app-shell").style.display = "";', dbPaare: 1 },
  { name: "ablaufplan",      gate: "zeigeAbmeldung",    trichter: ["renderAlles"], startAnker: 'document.getElementById("app-shell").style.display = "";', dbPaare: 2 },
  { name: "schulsport",      gate: "showConnectScreen", trichter: ["renderAlles"], start: "startApp",  dbPaare: 1 },
  { name: "ausbildungsplan", gate: "showConnectScreen", trichter: ["renderAlles"], start: "startApp",  dbPaare: 1 },
  { name: "kleiderboerse",   gate: "showConnectScreen", trichter: ["renderAlles"], start: "startApp",  dbPaare: 2 },
  { name: "kontakte",        gate: "showConnectScreen", trichter: ["renderListe", "renderMannschaften"], start: "showApp", dbPaare: 1 },
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
const MUTATIONEN = [
  { id: "M1", was: "app.js", beschreibung: "innerHTML-Leeren der Huelle entfernt",
    tun: (s) => s.replace('  if (huelle) huelle.innerHTML = "";\n', "") },
  // ⚠️ Diese Mutation lief beim ersten Versuch ins Leere, weil sie auf den
  // damaligen Selektor-Wortlaut zielte -- und der hatte sich geaendert. Jetzt
  // trifft sie den Selektor, egal was drinsteht.
  { id: "M2", was: "app.js", beschreibung: "Selektor entkernt (alles neben der Huelle faellt raus)",
    tun: (s) => s.replace(/querySelectorAll\("[^"]*"\)\.forEach\(\(el\) => \{/, 'querySelectorAll("#gibtesnicht").forEach((el) => {') },
  { id: "M3", was: "app.js", beschreibung: "display:none der Dialoge entfernt",
    tun: (s) => s.replace('    el.style.display = "none";\n', "") },
  { id: "M4", was: "app.js", beschreibung: "innerHTML-Leeren der Dialoge entfernt",
    tun: (s) => s.replace('    el.innerHTML = "";\n', "") },
  { id: "M5", was: "app.js", beschreibung: "Merker bildschirmGeraeumt wird nicht gesetzt",
    tun: (s) => s.replace("  bildschirmGeraeumt = true;\n", "") },
  { id: "M6", was: "app.js", beschreibung: "Riegel gegen den Start-Fall entfernt",
    tun: (s) => s.replace("  if (!appLaeuft) return;\n", "") },
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

  let appJs = readFileSync(join(ordner, "app.js"), "utf8");
  let dbJs = readFileSync(join(ordner, "db.js"), "utf8");
  const html = readFileSync(join(ordner, "index.html"), "utf8");

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

  zusage("A8", "der Name im Seitenkopf ist weg", dom.nachId.get("header-user").innerHTML === "");

  // Gegenprobe: der Anmeldeschirm darf NICHT mitgeraeumt werden, sonst stuende
  // der Nutzer vor einer weissen Seite ohne Hinweis.
  zusage("A9", "der Anmeldeschirm bleibt stehen", dom.nachId.get("cloud-error").innerHTML !== "" && dom.nachId.get("connect-error").innerHTML !== "");

  // ========================= C: die Verdrahtung =========================
  const gateRumpf = rumpfVon(appJs, `function ${cfg.gate}(`);
  zusage("C1", `${cfg.gate}() raeumt als erste Zeile`,
    /^function [^\n]*\{\n\s*raeumeBildschirm\(\);/.test(gateRumpf));

  const wuerfe = (dbJs.match(/throw new NotLoggedInError/g) || []).length;
  const haken = (dbJs.match(/typeof raeumeBeiSitzungsverlust === "function"/g) || []).length;
  zusage("C2", `db.js: jeder der ${wuerfe} Sitzungs-Wuerfe traegt den Haken`,
    wuerfe === cfg.dbPaare * 2 && haken === wuerfe);

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
// Lauf
// =============================================================================
console.log("Prueft: Bildschirm raeumen bei Sitzungsverlust\n");

let gefunden = 0;
for (const cfg of APPS) if (pruefeApp(cfg, null)) gefunden++;

// Ein stiller No-Op ist schlimmer als ein roter Lauf: ohne Apps kein Urteil.
if (gefunden === 0) abbruch("keine einzige App gefunden -- lief der Prueflauf im richtigen Ordner?");
if (gefunden < APPS.length) console.log(`Hinweis: ${APPS.length - gefunden} App(s) nicht gefunden, uebersprungen.\n`);

for (const z of rot) console.log("  ROT  " + z);
console.log(`\n${gruen} Zusagen gruen, ${rot.length} rot (${gefunden}/${APPS.length} Apps).`);

if (MUTATION) {
  console.log("\n--- Mutationsprobe: jede Aenderung muss auffallen ---");
  let gefangen = 0;
  for (const m of MUTATIONEN) {
    let entdeckt = false;
    for (const cfg of APPS) {
      const vorher = rot.length, vorherGruen = gruen;
      try { pruefeApp(cfg, m); } catch (_) { entdeckt = true; }
      if (rot.length > vorher) entdeckt = true;
      rot.length = vorher; gruen = vorherGruen;
      if (entdeckt) break;
    }
    console.log(`  ${entdeckt ? "gefangen " : "DURCH    "} ${m.id} (${m.was}) ${m.beschreibung}`);
    if (entdeckt) gefangen++;
  }
  console.log(`\n${gefangen}/${MUTATIONEN.length} Mutationen gefangen.`);
  if (gefangen < MUTATIONEN.length) process.exit(1);
}

process.exit(rot.length ? 1 : 0);
