// Prueft, dass die beiden ueber ihren NAMEN gefundenen Gruppen ("Trainer",
// "Spieler") nicht umbenannt, nicht geloescht und nicht doppelt angelegt werden
// koennen -- gegen den ECHTEN Worker-Code.
//
//   node pruef-systemgruppen.mjs              # 12 Zusagen
//   node pruef-systemgruppen.mjs --mutation   # zeigt, dass die Zusagen rot werden koennen
//   node pruef-systemgruppen.mjs <pfad>       # eine andere Fassung pruefen
//
// Warum es diesen Pruefstand gibt (Bugjagd 2026-08-30): isVertragspflichtig
// sucht die Gruppe "Trainer" ueber den Namen. handleRenameGroup liess jeden
// Admin diesen Namen aendern -- danach war NIEMAND mehr vertragspflichtig, die
// Vertrags-Ampel wurde flottenweit gruen und keine Erinnerung ging mehr raus,
// ohne eine einzige Fehlermeldung. Genau dieser stille Ausfall wird hier
// festgenagelt.
//
// ⚠️ Der Code wird AUS DER DATEI GEZOGEN (new Function), nicht nachgebaut.

import { readFileSync } from "node:fs";

const DATEI = process.env.WORKER_DATEI
  || process.argv.find((a) => !a.startsWith("--") && a.endsWith(".js"))
  || "E:/ToolsUebersicht/admin-worker.js";

const Q = readFileSync(DATEI, "utf8").replace(/\r\n/g, "\n");
const MUTATION = process.argv.includes("--mutation");

function schneide(von, bis, name) {
  const a = Q.indexOf(von);
  if (a < 0) { console.error("ABBRUCH: Anfangsmarke fehlt -- " + name); process.exit(2); }
  const b = bis ? Q.indexOf(bis, a) : Q.length;
  if (b < 0) { console.error("ABBRUCH: Endmarke fehlt -- " + name); process.exit(2); }
  return Q.slice(a, b);
}

const ZEILE_TRAINER = schneide('const TRAINER_GROUP_NAME =', "\n", "TRAINER_GROUP_NAME");
const ZEILE_SPIELER = schneide('const SPIELER_GROUP_NAME =', "\n", "SPIELER_GROUP_NAME");
let BLOCK_FN = schneide("function istSystemGruppenName(", "\n}", "istSystemGruppenName") + "\n}";

// Mutation 1: der Waechter erkennt nichts mehr. Zusagen 1-4 muessen rot werden.
if (MUTATION) BLOCK_FN = BLOCK_FN.replace(/return name === [^;]+;/, "return false;");

const m = new Function(
  ZEILE_TRAINER + ZEILE_SPIELER + BLOCK_FN +
  "return { istSystemGruppenName, TRAINER_GROUP_NAME, SPIELER_GROUP_NAME };"
)();

// ---------------------------------------------------------------------------
// Reihenfolge im Quelltext: der Waechter muss VOR dem Schreibvorgang stehen.
// Steht er dahinter, ist die Gruppe schon umbenannt bzw. geloescht, wenn die
// Ablehnung kommt -- eine Fehlermeldung ohne Wirkung.
function guardVorSchreiben(handlerAnfang, handlerEnde, schreibMarke, name) {
  let block = schneide(handlerAnfang, handlerEnde, name);
  // Mutation 2: ALLE Waechter des Handlers entfernen. Zwei Fallen, beide beim
  // Bauen aufgelaufen: (1) ohne /g und ohne das geschonte "\n" am Anfang blieb
  // in handleRenameGroup der zweite von zwei direkt aufeinanderfolgenden
  // Waechtern stehen; (2) die Suche nach dem blossen Bezeichner traf den
  // KOMMENTAR ("Siehe istSystemGruppenName") und war deshalb immer gruen.
  if (MUTATION) block = block.replace(/[ \t]*if \(istSystemGruppenName[\s\S]*?\n[ \t]*\}\n/g, "");
  const guard = block.indexOf("if (istSystemGruppenName");
  const schreiben = block.indexOf(schreibMarke);
  if (schreiben < 0) { console.error("ABBRUCH: Schreibmarke fehlt -- " + name); process.exit(2); }
  return guard >= 0 && guard < schreiben;
}

const zusagen = [
  ['Konstante "Trainer" unveraendert', m.TRAINER_GROUP_NAME === "Trainer"],
  ['Konstante "Spieler" unveraendert', m.SPIELER_GROUP_NAME === "Spieler"],
  ['"Trainer" gilt als Systemgruppe', m.istSystemGruppenName("Trainer") === true],
  ['"Spieler" gilt als Systemgruppe', m.istSystemGruppenName("Spieler") === true],
  ['"Foerdertrainer" gilt NICHT als Systemgruppe', m.istSystemGruppenName("Foerdertrainer") === false],
  ['Leerer Name gilt NICHT als Systemgruppe', m.istSystemGruppenName("") === false],
  ['Kleinschreibung trifft nicht ("trainer")', m.istSystemGruppenName("trainer") === false],

  ["Umbenennen: Waechter vor group.name = name",
   guardVorSchreiben("async function handleRenameGroup(", "async function handleListGroups(", "group.name = name;", "handleRenameGroup")],
  ["Loeschen: Waechter vor delete usersDoc.groups",
   guardVorSchreiben("async function handleDeleteGroup(", "\n}\n\n", "delete usersDoc.groups[groupId];", "handleDeleteGroup")],
  ["Anlegen: Waechter vor usersDoc.groups[id] = {",
   guardVorSchreiben("async function handleCreateGroup(", "async function handleRenameGroup(", "usersDoc.groups[id] = {", "handleCreateGroup")],

  ["Umbenennen lehnt mit 409 ab, nicht still",
   /istSystemGruppenName\(group\.name\)[\s\S]{0,300}?\}, 409,/.test(Q)],
  ["Loeschen lehnt mit 409 ab, nicht still",
   /istSystemGruppenName\(zuLoeschen\.name\)[\s\S]{0,300}?\}, 409,/.test(Q)]
];

let rot = 0;
for (const [text, ok] of zusagen) {
  if (!ok) rot++;
  console.log((ok ? "  ok   " : "  ROT  ") + text);
}
console.log("");
if (MUTATION) {
  console.log(rot > 0
    ? `Mutationsprobe bestanden: ${rot} von ${zusagen.length} Zusagen wurden rot.`
    : "MUTATIONSPROBE FEHLGESCHLAGEN: keine Zusage wurde rot -- der Pruefstand misst nichts.");
  process.exit(rot > 0 ? 0 : 1);
}
console.log(rot === 0
  ? `Alle ${zusagen.length} Zusagen gruen (${DATEI}).`
  : `${rot} von ${zusagen.length} Zusagen ROT.`);
process.exit(rot === 0 ? 0 : 1);
