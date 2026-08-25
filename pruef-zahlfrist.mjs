// Prueft das Zahlungsziel des Fussballcamps gegen den ECHTEN Worker-Code.
//
//   node pruef-zahlfrist.mjs                  # 28 Zusagen
//   node pruef-zahlfrist.mjs --mutation       # zeigt, dass die Zusagen rot werden koennen
//   node pruef-zahlfrist.mjs <pfad>           # eine andere Fassung pruefen
//   WORKER_DATEI=<pfad> node pruef-zahlfrist.mjs
//
// ⚠️ Der Code wird AUS DER DATEI GEZOGEN (new Function), nicht nachgebaut. Fehlt
// eine Marke, bricht der Lauf ab -- ein Pruefstand, der seine eigene Kopie prueft,
// belegt nichts. Der Pfad ist parametrisiert, damit die Mutationsprobe wirklich
// die mutierte Fassung liest.

import { readFileSync } from "node:fs";

const DATEI = process.env.WORKER_DATEI
  || process.argv.find((a) => !a.startsWith("--") && a.endsWith(".js"))
  || "E:/ToolsUebersicht/admin-worker.js";

const Q = readFileSync(DATEI, "utf8");

function schneide(von, bis, name) {
  const a = Q.indexOf(von);
  if (a < 0) { console.error("ABBRUCH: Anfangsmarke fehlt -- " + name); process.exit(2); }
  const b = bis ? Q.indexOf(bis, a) : Q.length;
  if (b < 0) { console.error("ABBRUCH: Endmarke fehlt -- " + name); process.exit(2); }
  return Q.slice(a, b);
}

const BLOCK_HEUTE = schneide("function fcHeuteBerlin() {", "function fcTagPlus(", "fcHeuteBerlin");
const BLOCK_FRIST = schneide("const FC_ZAHLFRIST_TAGE", "// Was eine Anmeldung an diesem Tag kosten", "Zahlfrist-Block");

function laden(blockFrist) {
  return new Function(
    BLOCK_HEUTE + blockFrist +
    "return { fcZahlfrist, fcZahlfristOffen, fcHeuteBerlin, FC_ZAHLFRIST_TAGE };"
  )();
}

// ---------------------------------------------------------------------------
// Verhalten -- das, was die Mutationsprobe rot machen koennen muss.
// ---------------------------------------------------------------------------
function verhalten(m) {
  const heute = m.fcHeuteBerlin();
  // Tag relativ zu heute, in derselben Bauform wie der Worker rechnet.
  const plus = (t) => {
    const d = new Date(heute + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + t);
    return d.toISOString().slice(0, 10);
  };
  const T = m.FC_ZAHLFRIST_TAGE;

  return [
    // A -- die Rechnung selbst
    ["A1 20.10. -> 13.10. (sieben Tage vorher)", m.fcZahlfrist({ vonDatum: "2026-10-20" }) === "2026-10-13"],
    ["A2 ueber die Sommerzeitgrenze: 02.04. -> 26.03.", m.fcZahlfrist({ vonDatum: "2026-04-02" }) === "2026-03-26"],
    ["A3 ueber die Winterzeitgrenze: 01.11. -> 25.10.", m.fcZahlfrist({ vonDatum: "2026-11-01" }) === "2026-10-25"],
    ["A4 ueber den Jahreswechsel: 03.01.2026 -> 27.12.2025", m.fcZahlfrist({ vonDatum: "2026-01-03" }) === "2025-12-27"],
    ["A5 ueber den 29.02.: 01.03.2028 -> 23.02.2028", m.fcZahlfrist({ vonDatum: "2028-03-01" }) === "2028-02-23"],
    ["A6 ueber den Monatsanfang: 03.05. -> 26.04.", m.fcZahlfrist({ vonDatum: "2026-05-03" }) === "2026-04-26"],
    ["A7 die Frist liegt VOR dem Camp, nie danach", m.fcZahlfrist({ vonDatum: "2026-10-20" }) < "2026-10-20"],
    ["A8 genau FC_ZAHLFRIST_TAGE Tage Abstand", T === 7],

    // B -- die Wachen: kaputte Daten duerfen kein Datum erfinden und nicht werfen
    ["B1 ohne camp: leer", m.fcZahlfrist(null) === ""],
    ["B2 ohne vonDatum: leer", m.fcZahlfrist({}) === ""],
    ["B3 leeres vonDatum: leer", m.fcZahlfrist({ vonDatum: "" }) === ""],
    ["B4 Muell statt Datum: leer, kein Absturz", m.fcZahlfrist({ vonDatum: "kaputt" }) === ""],
    ["B5 unmoegliches Datum (2026-13-45): leer", m.fcZahlfrist({ vonDatum: "2026-13-45" }) === ""],
    ["B6 dasselbe fuer fcZahlfristOffen", m.fcZahlfristOffen({ vonDatum: "kaputt" }) === ""],

    // C -- eine abgelaufene Frist darf NICHT dastehen
    ["C1 Camp in 30 Tagen: Frist steht (23 Tage hin)", m.fcZahlfristOffen({ vonDatum: plus(30) }) === plus(23)],
    ["C2 Camp in 8 Tagen: Frist ist morgen, steht", m.fcZahlfristOffen({ vonDatum: plus(8) }) === plus(1)],
    ["C3 Camp in 7 Tagen: Frist ist HEUTE, steht noch", m.fcZahlfristOffen({ vonDatum: plus(7) }) === heute],
    ["C4 Camp in 6 Tagen: Frist war gestern -> leer", m.fcZahlfristOffen({ vonDatum: plus(6) }) === ""],
    ["C5 Camp in 3 Tagen -> leer", m.fcZahlfristOffen({ vonDatum: plus(3) }) === ""],
    ["C6 Camp heute -> leer", m.fcZahlfristOffen({ vonDatum: plus(0) }) === ""],
    ["C7 Camp war gestern -> leer", m.fcZahlfristOffen({ vonDatum: plus(-1) }) === ""],
    ["C8 fcZahlfrist rechnet auch dann, fcZahlfristOffen schweigt", m.fcZahlfrist({ vonDatum: plus(3) }) !== "" && m.fcZahlfristOffen({ vonDatum: plus(3) }) === ""]
  ];
}

// ---------------------------------------------------------------------------
// Quelltext -- Zusagen, die kein Aufruf zeigen kann.
// ---------------------------------------------------------------------------
function quelltext() {
  return [
    ["D1 Die Antwort an die Eltern nimmt die OFFENE Frist", Q.includes("frist: fcZahlfristOffen(camp)")],
    ["D2 Die Bestaetigungsmail nimmt dieselbe Funktion", Q.includes("const frist = fcZahlfristOffen(camp);")],
    ["D3 Nirgends steht wieder der erste Camp-Tag als Frist", !Q.includes("frist: camp.vonDatum")],
    ["D4 Ist die Frist weg, steht \"moeglichst umgehend\"", Q.includes("\" m\u00f6glichst umgehend\"")],
    // ⚠️ Die Frist ist kein Darstellungsdetail, sondern vertraglich. Verschwindet
    // der Satz aus den Teilnahmebedingungen, ist die genannte Frist nicht mehr
    // gedeckt -- dann soll dieser Pruefstand rot werden, nicht schweigen.
    ["D5 Punkt 3 der Bedingungen nennt die Zahlungsfrist", Q.includes("innerhalb der in der Anmeldebest\u00e4tigung genannten Zahlungsfrist")],
    ["D6 Punkt 3 deckt auch die kurzfristige Anmeldung ab", Q.includes("Erfolgt die Anmeldung weniger als 14 Tage vor Beginn des Camps")]
  ];
}

// ---------------------------------------------------------------------------

function melde(zeilen) {
  let rot = 0;
  for (const [name, ok] of zeilen) {
    if (!ok) rot++;
    console.log(`  ${ok ? "ok  " : "ROT "} ${name}`);
  }
  return rot;
}

if (process.argv.includes("--mutation")) {
  // ⚠️ Jede Mutation MUSS greifen. Griff die Ersetzung nicht, ist der Lauf
  // ungueltig -- das ist etwas anderes als "durchgerutscht" und wird auch
  // anders gemeldet.
  const MUTATIONEN = [
    ["Frist auf 0 Tage", (s) => s.replace("FC_ZAHLFRIST_TAGE = 7", "FC_ZAHLFRIST_TAGE = 0")],
    ["Frist auf 14 Tage", (s) => s.replace("FC_ZAHLFRIST_TAGE = 7", "FC_ZAHLFRIST_TAGE = 14")],
    ["Vorzeichen gedreht (+ statt -)", (s) => s.replace("getUTCDate() - FC_ZAHLFRIST_TAGE", "getUTCDate() + FC_ZAHLFRIST_TAGE")],
    // ⚠️ Es muss BEIDES weg. Nur das "Z" zu entfernen bricht nichts (die 12:00
    // absorbiert den Berliner Offset), und nur die Stunde auf 00:00 zu setzen
    // auch nicht (mit "Z" rechnet alles in UTC, da ist die Stunde egal). Erst
    // lokal geparste Mitternacht liegt auf dem UTC-Vortag. Wer hier nur eines
    // von beiden mutiert, bekommt ein gruenes Ergebnis und haelt den Anker
    // faelschlich fuer festgenagelt.
    ["Anker lokal UND Mitternacht (\"T00:00:00\")", (s) => s.replace('"T12:00:00Z"', '"T00:00:00"')],
    ["Abgelaufene Frist steht doch", (s) => s.replace("(f && f >= fcHeuteBerlin())", "f")],
    ["Frist einen Tag zu frueh weg", (s) => s.replace("f >= fcHeuteBerlin()", "f > fcHeuteBerlin()")],
    ["NaN-Wache raus", (s) => s.replace('if (Number.isNaN(d.getTime())) return "";', "")],
    ["Tage-Abstand um eins daneben", (s) => s.replace("getUTCDate() - FC_ZAHLFRIST_TAGE", "getUTCDate() - FC_ZAHLFRIST_TAGE + 1")]
  ];

  console.log("Datei: " + DATEI);
  console.log("unveraendert: " + verhalten(laden(BLOCK_FRIST)).filter(([, ok]) => !ok).length + " rot (muss 0 sein)\n");

  let gefangen = 0, ungueltig = 0;
  for (const [name, f] of MUTATIONEN) {
    const neu = f(BLOCK_FRIST);
    if (neu === BLOCK_FRIST) { ungueltig++; console.log(`  [Suchtext fehlt] ${name}`); continue; }
    let rot;
    try { rot = verhalten(laden(neu)).filter(([, ok]) => !ok).length; } catch { rot = 99; }
    if (rot > 0) gefangen++;
    console.log(`  ${rot > 0 ? "gefangen      " : "DURCHGERUTSCHT"} ${name}  (${rot} rot)`);
  }
  console.log(`\n${gefangen}/${MUTATIONEN.length} gefangen, ${ungueltig} ungueltig`);
  process.exit(gefangen === MUTATIONEN.length && ungueltig === 0 ? 0 : 1);
}

const m = laden(BLOCK_FRIST);
console.log("Datei: " + DATEI);
console.log(`Frist: ${m.FC_ZAHLFRIST_TAGE} Tage vor Camp-Beginn, heute (Berlin) ist ${m.fcHeuteBerlin()}\n`);
console.log("A/B/C — was der Code rechnet");
const rot1 = melde(verhalten(m));
console.log("\nD — was im Quelltext stehen muss");
const rot2 = melde(quelltext());
const zeilen = verhalten(m).length + quelltext().length;
console.log(`\n${zeilen - rot1 - rot2}/${zeilen} Zusagen gruen, ${rot1 + rot2} rot.`);
process.exit(rot1 + rot2 ? 1 : 0);
