// Gegenprobe: der Verwendungszweck aus WORKER und CLIENT über dieselben Fälle.
//
// ⚠️ Beide Funktionen werden AUS DER DATEI GEZOGEN und ausgeführt, nicht
// nachgebaut. Ein Vergleich zweier Quelltexte hätte den Unterschied "doppeltes
// Leerzeichen" nie gezeigt — er entsteht erst beim Ausführen.
import fsRoh from "node:fs";
// ⚠️ Zeilenenden beim Einlesen auf LF normalisieren. Die Schnittmarken unten
// ("\n];\n" und Verwandte) gibt es in einer CRLF-Datei nicht -- und git liefert
// mit core.autocrlf=true und ohne .gitattributes genau die aus. Ohne diese
// Huelle bricht der Pruefstand nach jedem frischen Checkout mit "Endmarke
// fehlt" ab und prueft KEINE EINZIGE Zusage -- der Absturz sieht dabei aus wie
// ein Fehler am geprueften Code. Bugjagd 04.09.2026: 9 von 11 Camp-Pruefstaenden.
const fs = Object.create(fsRoh);
fs.readFileSync = (p, e) => {
  const r = fsRoh.readFileSync(p, e);
  return typeof r === "string" ? r.replace(/\r\n/g, "\n") : r;
};

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HIER = dirname(fileURLToPath(import.meta.url));
const WORKER = fs.readFileSync(join(HIER, "admin-worker.js"), "utf8");
const APPJS  = fs.readFileSync(join(HIER, "..", "fussballcamp", "app.js"), "utf8");

function schneide(quelle, marke, name) {
  const a = quelle.indexOf(marke);
  if (a < 0) throw new Error("ABBRUCH: " + name + " nicht gefunden: " + marke);
  const b = quelle.indexOf("\n}\n", a);
  if (b < 0) throw new Error("ABBRUCH: Ende von " + name + " nicht gefunden");
  return quelle.slice(a, b + 3);
}

const wCode = schneide(WORKER, "function fcVerwendungszweck(camp, a) {", "fcVerwendungszweck")
            + schneide(WORKER, "function fcKindName(a) {", "fcKindName");
const cCode = schneide(APPJS, "function verwendungszweck(camp, a) {", "verwendungszweck")
            + "function kindName(a) { return `${a.kindVorname || \"\"} ${a.kindNachname || \"\"}`.trim() || \"Ohne Namen\"; }\n";

// ⚠️ kindName wird oben nicht geschnitten, sondern aus app.js geholt — sonst
// prüft man den Nachbau. Gegenprobe, dass die Zeile wirklich so dasteht:
if (!APPJS.includes('function kindName(a) { return `${a.kindVorname || ""} ${a.kindNachname || ""}`.trim() || "Ohne Namen"; }')) {
  throw new Error("ABBRUCH: kindName in app.js sieht anders aus als hier angenommen.");
}

const W = new Function(wCode + "\nreturn fcVerwendungszweck;")();
const C = new Function(cCode + "\nreturn verwendungszweck;")();

const FAELLE = [
  ["Normalfall",                 { name: "Herbstcamp 2026" }, { kindVorname: "Lena", kindNachname: "Muster" }],
  ["Nachname fehlt",             { name: "Herbstcamp 2026" }, { kindVorname: "Lena", kindNachname: "" }],
  ["Vorname fehlt",              { name: "Herbstcamp 2026" }, { kindVorname: "", kindNachname: "Muster" }],
  ["Beide fehlen (aufgeräumt)",  { name: "Herbstcamp 2026" }, { kindVorname: "", kindNachname: "" }],
  ["Felder gar nicht da",        { name: "Herbstcamp 2026" }, {}],
  ["Camp ohne Namen",            { name: "" },                { kindVorname: "Lena", kindNachname: "Muster" }],
  ["Beides leer",                { name: "" },                {}],
  ["Umlaute",                    { name: "Fußballcamp Ostern" }, { kindVorname: "Jörg", kindNachname: "Jóźwiak" }],
  ["Sehr langer Campname",       { name: "C".repeat(200) },   { kindVorname: "Lena", kindNachname: "Muster" }],
  ["Sehr langer Kindname",       { name: "Camp" },            { kindVorname: "L".repeat(100), kindNachname: "M".repeat(100) }],
  ["Leerzeichen am Rand",        { name: " Camp " },          { kindVorname: " Lena ", kindNachname: " Muster " }]
];

let gleich = 0, ungleich = 0;
for (const [name, camp, a] of FAELLE) {
  const w = W(camp, a), c = C(camp, a);
  if (w === c) { gleich++; console.log(`  ok  ${name.padEnd(28)} → ${JSON.stringify(w)}`); }
  else { ungleich++; console.log(`  X   ${name.padEnd(28)} Worker ${JSON.stringify(w)} ≠ Client ${JSON.stringify(c)}`); }
  // ⚠️ 140 Zeichen sind die Grenze, die im Verwendungszweck einer Überweisung
  // noch ankommt — bei beiden.
  if (w.length > 140 || c.length > 140) { ungleich++; console.log(`  X   ${name}: länger als 140 Zeichen`); }
}

console.log("\n" + "=".repeat(64));
console.log(`${gleich} von ${FAELLE.length} Fällen zeichengenau gleich.`);
if (ungleich) { console.log(`${ungleich} ABWEICHUNGEN.`); process.exit(1); }
