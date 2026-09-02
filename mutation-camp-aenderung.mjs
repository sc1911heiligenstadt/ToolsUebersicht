// Mutationsprobe zur Aenderungsmeldung. Jede Verschlechterung MUSS rot werden.
//
// ⚠️ Jeder Suchtext wird auf genau EINEN Treffer geprueft — eine Mutation, die
// ins Leere laeuft, sieht sonst aus wie eine blinde Zusage.
//
//   node mutation-aenderung.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HIER = dirname(fileURLToPath(import.meta.url));
const QUELL = join(HIER, "admin-worker.js");
// ⚠️ Die Mutanten-Datei liegt im Temp-Ordner, NICHT im Repo — sonst landet
// eine absichtlich kaputte Worker-Fassung im nächsten Commit.
const ZIEL = join(os.tmpdir(), "mutant-aenderung.js");
const ORIGINAL = readFileSync(QUELL, "utf8");

const MUTATIONEN = [
  ["Es wird wieder blind markiert, auch ohne Aenderung",
    `      if (geaendert.length) {
        anmeldung.elternAenderung = "geaendert";
        anmeldung.elternAenderungFelder = geaendert;
        fcVerlaufNotiz(camp, { was: "geaendert", nr: anmeldung.nummer || 0, quelle: "eltern" });
      }`,
    `      anmeldung.elternAenderung = "geaendert";
      anmeldung.elternAenderungFelder = geaendert;
      fcVerlaufNotiz(camp, { was: "geaendert", nr: anmeldung.nummer || 0, quelle: "eltern" });`],

  // ⚠️ Suchtext muss den ELTERN-Weg eindeutig treffen. `const felder =
  // fcFelderPruefen(...)` allein steht zweimal in der Datei — die Mutation liefe
  // dann ins Leere und das sähe aus wie eine blinde Zusage.
  ["Der ALTE Wert wird zusaetzlich aufbewahrt",
    `      const geaendert = Object.keys(felder).filter((id) => fcWertSchluessel(anmeldung[id]) !== fcWertSchluessel(felder[id]));`,
    `      const geaendert = Object.keys(felder).filter((id) => fcWertSchluessel(anmeldung[id]) !== fcWertSchluessel(felder[id]));
      anmeldung.elternAenderungVorher = geaendert.map((id) => String(anmeldung[id] || "")).join("|");`],

  ["Ein nie gesetzter Haken zaehlt als Aenderung",
    `  if (v === undefined || v === null || v === false) return "";`,
    `  if (v === undefined || v === null) return "";`],

  ["Die Feldliste bleibt nach Zur-Kenntnis-genommen stehen",
    `        if (ids.includes(a.id) && a.elternAenderung) { a.elternAenderung = ""; a.elternAenderungFelder = []; n++; }`,
    `        if (ids.includes(a.id) && a.elternAenderung) { a.elternAenderung = ""; n++; }`],

  ["Eine Absage behaelt die Feldliste der letzten Aenderung",
    `      anmeldung.elternAenderung = "abgesagt";
      // Eine Absage spricht fuer sich -- eine Feldliste dazu waere die Feldliste
      // einer frueheren Aenderung und damit schlicht falsch.
      anmeldung.elternAenderungFelder = [];`,
    `      anmeldung.elternAenderung = "abgesagt";`],

  ["Neu bestaetigte Bedingungen werden nicht gemeldet",
    `      if (agbNeuBestaetigt) geaendert.push("agb");\n`, ``],

  ["Eine geaenderte Zusatzantwort wird nicht gemeldet",
    `        if (String(anmeldung.zusatzantwort || "") !== String(antwortNeu || "")) geaendert.push("zusatzantwort");\n`, ``],

  ["Der Verlauf bekommt die Feldnamen mit",
    `        fcVerlaufNotiz(camp, { was: "geaendert", nr: anmeldung.nummer || 0, quelle: "eltern" });`,
    `        fcVerlaufNotiz(camp, { was: "geaendert", nr: anmeldung.nummer || 0, quelle: "eltern", felder: geaendert.join(",") });`],

  ["Das Verwaltungs-Speichern raeumt die Feldliste nicht",
    `      a.elternAenderung = "";
      a.elternAenderungFelder = [];
      return {};`,
    `      a.elternAenderung = "";
      return {};`],

  ["Die Feldliste geht ohne Bearbeiten-Recht mit heraus",
    `      belegt: fcBelegt(c), warteliste: fcWartende(c).length, jobsFrei: fcJobsFrei(c),`,
    `      belegt: fcBelegt(c), warteliste: fcWartende(c).length, jobsFrei: fcJobsFrei(c),
      elternAenderungFelder: (c.anmeldungen || []).flatMap((a) => a.elternAenderungFelder || []),`]
];

let gefangen = 0, durchgerutscht = 0, fehltreffer = 0;

for (const [name, suche, ersatz] of MUTATIONEN) {
  const treffer = ORIGINAL.split(suche).length - 1;
  if (treffer !== 1) {
    fehltreffer++;
    console.log(`  ?   [Suchtext trifft ${treffer}x statt 1x] ${name}`);
    continue;
  }
  writeFileSync(ZIEL, ORIGINAL.replace(suche, ersatz), "utf8");
  let rot = false, abbruch = "";
  try {
    execFileSync("node", [join(HIER, "pruef-camp-aenderung.mjs"), ZIEL], { stdio: "pipe" });
  } catch (e) {
    rot = true;
    const aus = String(e.stdout || "") + String(e.stderr || "");
    if (aus.includes("ABBRUCH")) abbruch = " (Extraktion brach ab)";
  }
  if (rot) { gefangen++; console.log(`  ok  gefangen${abbruch}: ${name}`); }
  else { durchgerutscht++; console.log(`  X   DURCHGERUTSCHT: ${name}`); }
}

console.log("\n" + "=".repeat(60));
console.log(`${gefangen} von ${MUTATIONEN.length} Mutationen gefangen.`);
if (durchgerutscht) console.log(`${durchgerutscht} durchgerutscht — dort ist eine Zusage blind.`);
if (fehltreffer) console.log(`${fehltreffer} Suchtexte passten nicht — diese Mutationen liefen ins Leere.`);
if (durchgerutscht || fehltreffer) process.exit(1);
