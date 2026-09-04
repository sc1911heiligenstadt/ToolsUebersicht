// Mutationsprobe zum Frühbucherpreis. Jede Verschlechterung MUSS rot werden.
//
//   node mutation-preis.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HIER = dirname(fileURLToPath(import.meta.url));
const QUELL = join(HIER, "admin-worker.js");
// ⚠️ Die Mutanten-Datei liegt im Temp-Ordner, NICHT im Repo — sonst landet
// eine absichtlich kaputte Worker-Fassung im nächsten Commit.
const ZIEL = join(os.tmpdir(), "mutant-preis.js");
const ORIGINAL = readFileSync(QUELL, "utf8").replace(/\r\n/g, "\n");

const MUTATIONEN = [
  ["Der Betrag wird NICHT festgeschrieben, sondern immer neu gerechnet",
    `function fcBetrag(camp, a) {
  const roh = a ? a.betrag : undefined;
  if (roh === undefined || roh === null || !Number.isFinite(Number(roh))) return Number(camp.preis || 0);
  return Number(roh);
}`,
    `function fcBetrag(camp, a) {
  void a;
  return fcPreisAmTag(camp);
}`],

  ["Ein Betrag von 0 gilt als fehlend und faellt auf den Camp-Preis zurueck",
    `  if (roh === undefined || roh === null || !Number.isFinite(Number(roh))) return Number(camp.preis || 0);`,
    `  if (!roh || !Number.isFinite(Number(roh))) return Number(camp.preis || 0);`],

  ["Der Stichtag selbst zaehlt schon zum regulaeren Preis",
    `  if (frueh > 0 && bis && String(tag || fcHeuteBerlin()) <= bis) return frueh;`,
    `  if (frueh > 0 && bis && String(tag || fcHeuteBerlin()) < bis) return frueh;`],

  ["Die neue Anmeldung bekommt gar keinen Betrag",
    `        betrag: fcPreisAmTag(camp),\n`, ``],

  ["Die neue Anmeldung bekommt den REGULAEREN statt des Fruehbucherpreises",
    `        betrag: fcPreisAmTag(camp),`,
    `        betrag: camp.preis || 0,`],

  ["Ein halbes Fruehbucherpaar bleibt stehen",
    `      if (fruehPreis > 0 && fruehBis) {`,
    `      if (fruehPreis > 0 || fruehBis) {`],

  ["Ein Fruehbucherpreis UEBER dem regulaeren wird angenommen",
    `        if (fruehPreis >= camp.preis) {
          throw new FcFehler("Der Frühbucherpreis muss unter dem regulären Beitrag liegen.", 400);
        }\n`, ``],

  ["Das Fenster auf der Vereinsseite zeigt den regulaeren statt des heutigen Preises",
    `    preis: fcPreisAmTag(camp),
    preisRegulaer: camp.preis || 0,`,
    `    preis: camp.preis || 0,
    preisRegulaer: camp.preis || 0,`],

  ["Die Mail nennt den aktuellen Camp-Preis statt des festgeschriebenen",
    `  Betrag            \${fcEuro(fcBetrag(camp, a))}`,
    `  Betrag            \${fcEuro(camp.preis)}`],

  ["Die Zahlungserinnerung haengt wieder am Camp-Preis",
    `        if (!fcBetrag(camp, a)) return;`,
    `        if (!camp.preis) return;`],

  ["Das Aufraeumen wirft den Betrag weg",
    `        betrag: fcBetrag(camp, a),\n`, ``],

  ["Der Load verraet das Fruehbucherpaar nicht mehr",
    `      preisFrueh: c.preisFrueh || 0, preisFruehBis: c.preisFruehBis || "",\n`, ``],

  ["Der Betrag fehlt in der Eltern-Sicht",
    `                    betrag: fcBetrag(camp, anmeldung), zusatzantwort: anmeldung.zusatzantwort || "" };`,
    `                    zusatzantwort: anmeldung.zusatzantwort || "" };`],

  // ⚠️ `betrag: fcPreisAmTag(camp)` waere an DIESER Stelle verhaltensgleich: die
  // Anmeldung ist gerade eben mit genau diesem Wert angelegt worden, die beiden
  // koennen im Bestaetigungs-Zweig gar nicht auseinanderlaufen. Eine solche
  // Mutation rutscht durch und sieht aus wie eine blinde Zusage, ist aber
  // schlicht nicht unterscheidbar. Geprueft wird deshalb ein echter Fehler.
  ["Die Bestaetigung nennt einen falschen Betrag",
    `      zahlung: anmeldung.status === "angemeldet" ? {
        betrag: fcBetrag(camp, anmeldung),`,
    `      zahlung: anmeldung.status === "angemeldet" ? {
        betrag: camp.preis || 0,`]
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
    execFileSync("node", [join(HIER, "pruef-camp-preis.mjs"), ZIEL], { stdio: "pipe" });
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
