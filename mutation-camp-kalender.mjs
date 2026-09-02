// Mutationsprobe: jede gezielte Verschlechterung MUSS den Pruefstand rot machen.
// Eine Mutation, die durchrutscht, bedeutet eine blinde Zusage.
//
// ⚠️ Eine Mutation, deren Suchtext gar nicht passt, laeuft ins Leere und sieht
// dabei aus wie ein Erfolg. Deshalb wird jeder Suchtext auf GENAU EINEN Treffer
// geprueft und ein Fehltreffer getrennt gemeldet.
//
//   node mutation-kalender.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HIER = dirname(fileURLToPath(import.meta.url));
const QUELL = join(HIER, "admin-worker.js");
// ⚠️ Die Mutanten-Datei liegt im Temp-Ordner, NICHT im Repo — sonst landet
// eine absichtlich kaputte Worker-Fassung im nächsten Commit.
const ZIEL = join(os.tmpdir(), "mutant-worker.js");
const ORIGINAL = readFileSync(QUELL, "utf8");

const MUTATIONEN = [
  ["Ein Entwurf kommt trotzdem in den Kalender",
    `  if (camp.status === "entwurf") return false;\n`, ``],
  ["Ein vergangenes Camp kommt in den Kalender",
    `  return camp.bisDatum >= fcHeuteBerlin();`, `  return true;`],
  ["Ein aufgeraeumtes Camp kommt in den Kalender",
    `  if (!camp || camp.aufgeraeumtAm) return false;`, `  if (!camp) return false;`],
  ["Ein von Hand geloeschter Termin wird wieder angelegt",
    `    if (alteId) return { geaendert: false, zustand: "fehlt", terminId: alteId };\n`, ``],
  ["Ein mehrtaegiges Camp bekommt doch eine Uhrzeit",
    `  const mitZeit = !mehrtaegig && !!camp.taeglichVon && !!camp.taeglichBis;`,
    `  const mitZeit = !!camp.taeglichVon && !!camp.taeglichBis;`],
  ["Der Anmeldelink steht auch bei einem geschlossenen Camp drin",
    `  if (camp.status === "offen" && camp.token) {`, `  if (camp.token) {`],
  ["Der uebertragene Termin wird privat",
    `  t.privat = undefined;\n  t.geteiltUsers = undefined;`,
    `  t.privat = true;\n  t.geteiltUsers = undefined;`],
  ["Der Abgleich ueberschreibt auch die Kategorie",
    `  t.titel = camp.name;\n  t.datum = camp.vonDatum;`,
    `  t.titel = camp.name;\n  t.kategorie = FC_KALENDER_KATEGORIE;\n  t.datum = camp.vonDatum;`],
  ["Der Abgleich wirft die Anhaenge weg",
    `  t.notiz = fcKalenderNotiz(camp) || undefined;`,
    `  t.notiz = fcKalenderNotiz(camp) || undefined;\n  t.anhaenge = undefined;`],
  ["Die Termin-Id wird nicht ans Camp zurueckgeschrieben",
    `      await fcMutiere(authHeader, (doc) => {\n        const c = doc.camps.find((x) => x.id === camp.id);\n        if (c) c.kalenderTerminId = neueId;\n      });`,
    `      void neueId;`],
  ["Ein fehlgeschlagener Uebertrag wird verschwiegen",
    `  } catch (e) {\n    return "fehler";\n  }\n}`, `  } catch (e) {\n    return "unveraendert";\n  }\n}`],
  ["Ein Termin, der nicht mehr hineingehoert, bleibt stehen",
    `    doc.termine.splice(i, 1);\n    return { geaendert: true, zustand: "entfernt", terminId: "" };`,
    `    return { geaendert: true, zustand: "entfernt", terminId: "" };`],
  ["Der naechtliche Lauf schreibt die fremde Datei auch ohne Aenderung",
    `    if (!geaendert) return { nichtsZuTun: true, ids, geaendert: 0 };\n`, ``],
  ["Die Termin-Id geht mit an den Client",
    `      kalenderUebertragen: !!c.kalenderTerminId,`,
    `      kalenderUebertragen: !!c.kalenderTerminId,\n      kalenderTerminId: c.kalenderTerminId || "",`],
  ["Der Statuswechsel loest keinen Abgleich mehr aus",
    `    // Der wichtigste Ausloeser: "Anmeldung oeffnen" stellt das Camp zugleich in\n    // den Vereinskalender, "zurueck auf Entwurf" nimmt es wieder heraus.\n    antwort.kalender = await fcKalenderNachziehen(authHeader, antwort.schnappschuss);`,
    `    antwort.kalender = "unveraendert";`],
  ["Camp loeschen laesst den Termin im Kalender stehen",
    `    antwort.kalender = await fcKalenderNachziehen(authHeader, antwort.schnappschuss, { geloescht: true });`,
    `    antwort.kalender = "unveraendert";`],
  ["Der Termin wird ueber den TITEL wiedergefunden statt ueber die Id",
    `  const i = alteId ? doc.termine.findIndex((t) => t && t.id === alteId) : -1;`,
    `  const i = doc.termine.findIndex((t) => t && t.titel === camp.name);`],
  ["Camp speichern zieht den Termin nicht mehr nach",
    `    antwort.kalender = await fcKalenderNachziehen(authHeader, antwort.schnappschuss);\n    delete antwort.schnappschuss;\n\n    return json(antwort, 200, corsHeaders);`,
    `    delete antwort.schnappschuss;\n\n    return json(antwort, 200, corsHeaders);`]
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
    execFileSync("node", [join(HIER, "pruef-camp-kalender.mjs"), ZIEL], { stdio: "pipe" });
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
