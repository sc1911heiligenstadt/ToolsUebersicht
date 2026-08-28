// Mutationsprobe zur Zahlungserinnerung. Jede Verschlechterung MUSS rot werden.
//
//   node mutation-camp-zahlerinnerung.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HIER = dirname(fileURLToPath(import.meta.url));
const QUELL = join(HIER, "admin-worker.js");
// ⚠️ Die Mutanten-Datei liegt im Temp-Ordner, NICHT im Repo — sonst landet
// eine absichtlich kaputte Worker-Fassung im nächsten Commit.
const ZIEL = join(os.tmpdir(), "mutant-camp-zahlerinnerung.js");
const ORIGINAL = readFileSync(QUELL, "utf8");

const MUTATIONEN = [
  // Der eigentliche Fund: die zweite Bedingung faellt weg.
  ["Die Zahlfrist wird gar nicht mehr geprueft (der alte Fehler ist zurueck)",
    `        const frist = fcZahlfrist(camp);
        if (frist && fcTagPlusUtc(frist, -FC_ZAHL_ERINNERUNG_VORLAUF) > heute) return;\n`, ``],

  ["Der Vorlauf ist so gross, dass die Frist nie 'nah' ist",
    `const FC_ZAHL_ERINNERUNG_VORLAUF = 3;`,
    `const FC_ZAHL_ERINNERUNG_VORLAUF = 400;`],

  ["Der Vorlauf zeigt in die falsche Richtung (nach der Frist statt davor)",
    `        if (frist && fcTagPlusUtc(frist, -FC_ZAHL_ERINNERUNG_VORLAUF) > heute) return;`,
    `        if (frist && fcTagPlusUtc(frist, FC_ZAHL_ERINNERUNG_VORLAUF) > heute) return;`],

  ["Der Vergleich kippt: erinnert wird, SOLANGE die Frist weit weg ist",
    `        if (frist && fcTagPlusUtc(frist, -FC_ZAHL_ERINNERUNG_VORLAUF) > heute) return;`,
    `        if (frist && fcTagPlusUtc(frist, -FC_ZAHL_ERINNERUNG_VORLAUF) < heute) return;`],

  ["Der Vorlauf-Tag selbst zaehlt noch nicht (>= statt >)",
    `        if (frist && fcTagPlusUtc(frist, -FC_ZAHL_ERINNERUNG_VORLAUF) > heute) return;`,
    `        if (frist && fcTagPlusUtc(frist, -FC_ZAHL_ERINNERUNG_VORLAUF) >= heute) return;`],

  // ⚠️ Der Rueckfall ist bewusst offen: ohne Frist entscheidet Bedingung 1
  // allein. Wer ihn schliesst, laesst die Erinnerung bei einem Camp ohne Datum
  // lautlos ausfallen.
  ["Ohne brauchbares Camp-Datum wird gar nicht mehr erinnert",
    `        if (frist && fcTagPlusUtc(frist, -FC_ZAHL_ERINNERUNG_VORLAUF) > heute) return;`,
    `        if (!frist || fcTagPlusUtc(frist, -FC_ZAHL_ERINNERUNG_VORLAUF) > heute) return;`],

  // Bedingung 1 muss ebenfalls bleiben -- die spaetere der beiden bindet.
  ["Die Schonfrist nach der Anmeldung faellt weg",
    `        if (!grenze || grenze > heute) return;\n`, ``],

  ["Die Schonfrist ist einen Tag zu kurz",
    `        if (!grenze || grenze > heute) return;`,
    `        if (!grenze || grenze >= heute) return;`],

  ["Eine kaputte Anmeldezeit oeffnet die Schonfrist statt sie zu schliessen",
    `        if (!grenze || grenze > heute) return;`,
    `        if (grenze && grenze > heute) return;`],

  // Der Helfer selbst.
  ["fcTagPlusUtc rechnet lokal statt in UTC (das 'Z' faellt weg)",
    `  const d = new Date(String(tag || "") + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + tage);`,
    `  const d = new Date(String(tag || "") + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + tage);`],

  ["fcTagPlusUtc erfindet bei kaputter Eingabe ein Datum",
    `function fcTagPlusUtc(tag, tage) {
  const d = new Date(String(tag || "") + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return "";`,
    `function fcTagPlusUtc(tag, tage) {
  let d = new Date(String(tag || "") + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) d = new Date("2000-01-01T12:00:00Z");`],

  ["fcTagPlusUtc zaehlt in die falsche Richtung",
    `  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}`,
    `  d.setUTCDate(d.getUTCDate() - tage);
  return d.toISOString().slice(0, 10);
}`]
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
    execFileSync("node", [join(HIER, "pruef-camp-zahlerinnerung.mjs"), ZIEL], { stdio: "pipe" });
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
