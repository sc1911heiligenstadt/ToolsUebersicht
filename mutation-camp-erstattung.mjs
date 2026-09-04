// Mutationsprobe zu pruef-camp-erstattung.mjs.
//
// Jede Mutation verschlechtert den Client GEZIELT. Bleibt der Pruefstand dabei
// gruen, ist die zugehoerige Zusage blind und muss nachgeschaerft werden.
//
// ⚠️ Eine Mutation, deren Suchtext nicht gefunden wird, laeuft ins Leere und
// sieht aus wie eine blinde Zusage. Deshalb bricht der Lauf hier ab, statt sie
// als "durchgerutscht" zu melden.
//
//   node mutation-camp-erstattung.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

const HIER = dirname(fileURLToPath(import.meta.url));
const APP = join(HIER, "..", "fussballcamp");
const PRUEF = join(HIER, "pruef-camp-erstattung.mjs");
const TMP = fs.mkdtempSync(join(os.tmpdir(), "fc-mut-"));

const ORIG = {
  "config.js": fs.readFileSync(join(APP, "config.js"), "utf8").replace(/\r\n/g, "\n"),
  "app.js": fs.readFileSync(join(APP, "app.js"), "utf8").replace(/\r\n/g, "\n")
};

// [Name, Datei, Suchtext, Ersatz]
const MUTATIONEN = [
  ["Stufe rechnet mit HEUTE statt mit dem Absagedatum", "app.js",
   "  const absageTag = berlinTag(a.geaendertAm);",
   '  const absageTag = new Date().toLocaleDateString("sv-SE");'],

  ["berlinTag schneidet den UTC-Tag ab, statt umzurechnen", "app.js",
   '  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });\n}',
   "  return String(iso).slice(0, 10);\n}"],

  ["Voll-Grenze im Client auf 30 Tage verschoben", "config.js",
   "const FC_ERSTATTUNG_VOLL_AB_TAGEN = 28;", "const FC_ERSTATTUNG_VOLL_AB_TAGEN = 30;"],

  ["Halb-Grenze im Client auf 3 Tage verschoben", "config.js",
   "const FC_ERSTATTUNG_HALB_AB_TAGEN = 7;", "const FC_ERSTATTUNG_HALB_AB_TAGEN = 3;"],

  ["Voll-Grenze wird ausschliessend (genau 28 Tage faellt raus)", "app.js",
   "  if (tage >= FC_ERSTATTUNG_VOLL_AB_TAGEN) return 100;",
   "  if (tage > FC_ERSTATTUNG_VOLL_AB_TAGEN) return 100;"],

  ["Halb-Grenze wird ausschliessend (genau 7 Tage faellt raus)", "app.js",
   "  if (tage >= FC_ERSTATTUNG_HALB_AB_TAGEN) return 50;",
   "  if (tage > FC_ERSTATTUNG_HALB_AB_TAGEN) return 50;"],

  ["Betrag wird abgeschnitten statt gerundet (kleinster Cent geht verloren)", "app.js",
   "  return Math.round(anmBetrag(camp, a) * stufe / 100);",
   "  return Math.floor(anmBetrag(camp, a) * stufe / 100);"],

  ["Nie gezahltes Geld wird trotzdem erstattet", "app.js",
   "  if (!a.bezahlt || stufe === null) return null;",
   "  if (stufe === null) return null;"],

  ["Stufe 0 wird wie 'keine Aussage' behandelt", "app.js",
   "  if (!a.bezahlt || stufe === null) return null;",
   "  if (!a.bezahlt || !stufe) return null;"],

  ["Jede Absage gilt als Eltern-Absage (Punkt 4 auch bei Vereins-Absage)", "app.js",
   '  return a.status === "abgesagt" && String(a.absageGrund || "") === FC_ABSAGE_GRUND_ELTERN;',
   '  return a.status === "abgesagt";'],

  ["Marker laeuft vom Worker weg", "config.js",
   'const FC_ABSAGE_GRUND_ELTERN = "von den Eltern abgesagt";',
   'const FC_ABSAGE_GRUND_ELTERN = "Eltern-Absage";'],

  ["Camp-Preis statt festgeschriebenem Fruehbucherbetrag", "app.js",
   "  return Math.round(anmBetrag(camp, a) * stufe / 100);",
   "  return Math.round((camp.preis || 0) * stufe / 100);"],

  ["Der Absage-Block erscheint auch bei einer laufenden Anmeldung", "app.js",
   '  if (a.status === "abgesagt") {\n    zeilen.push(`<h3>Absage und Erstattung</h3>`);',
   '  if (true) {\n    zeilen.push(`<h3>Absage und Erstattung</h3>`);'],

  ["Verwaltungs-Absage bekommt doch eine Quote genannt", "app.js",
   '      gross("Zurückzuüberweisen", "von Hand klären");',
   '      gross("Zurückzuüberweisen", "100 % des Beitrages");'],

  ["Fehlendes Datum wird als 'keine Erstattung' ausgegeben", "app.js",
   '        gross("Zurückzuüberweisen", "nicht bestimmbar");',
   '        gross("Zurückzuüberweisen", "keine Erstattung");'],

  ["Der Spielraum-Satz verschwindet", "app.js",
   "        if (stufe !== 100 && a.bezahlt) {",
   "        if (false) {"],

  ["Der Grund der Verwaltung wird ungeprueft ins Markup gesetzt", "app.js",
   '<dd><strong>${escapeHtml(text)}</strong></dd>',
   '<dd><strong>${text}</strong></dd>'],

  ["T12:00:00Z-Anker faellt weg", "app.js",
   '  const a = new Date(String(vonIso) + "T12:00:00Z");\n  const b = new Date(String(bisIso) + "T12:00:00Z");',
   '  const a = new Date(String(vonIso));\n  const b = new Date(String(bisIso));'],

  ["erstattungsStufe geht nicht mehr von geaendertAm aus", "app.js",
   "  const absageTag = berlinTag(a.geaendertAm);",
   "  const absageTag = berlinTag(a.erstelltAm);"]
];

let gefangen = 0;
const durchgerutscht = [];

for (const [name, datei, suche, ersatz] of MUTATIONEN) {
  if (!ORIG[datei].includes(suche)) {
    throw new Error("ABBRUCH: Suchtext dieser Mutation fehlt, sie liefe ins Leere:\n  " + name + "\n  " + JSON.stringify(suche));
  }
  for (const d of Object.keys(ORIG)) fs.writeFileSync(join(TMP, d), ORIG[d], "utf8");
  fs.writeFileSync(join(TMP, datei), ORIG[datei].replace(suche, ersatz), "utf8");

  let rot = false, wie = "";
  try {
    execFileSync(process.execPath, [PRUEF], { env: { ...process.env, FC_APP_DIR: TMP }, stdio: "pipe" });
  } catch (e) {
    rot = true;
    wie = String(e.stdout || "").includes("Zusagen erfuellt") ? "rot" : "abgebrochen";
  }
  if (rot) { gefangen++; console.log(`  ok  gefangen (${wie}): ${name}`); }
  else { durchgerutscht.push(name); console.log("  X   DURCHGERUTSCHT: " + name); }
}

console.log(`\n${gefangen}/${MUTATIONEN.length} Mutationen gefangen.`);
fs.rmSync(TMP, { recursive: true, force: true });
if (durchgerutscht.length) process.exit(1);
