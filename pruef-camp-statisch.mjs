// Statische Durchsicht der Fussballcamp-App. Findet, was ohne Ausfuehren
// sichtbar ist: Namenskollisionen, auseinandergelaufene Doppel-Listen, tote
// Element-Ids, vergessene Cache-Busts.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HIER = dirname(fileURLToPath(import.meta.url));
// Die App liegt neben diesem Repo, nicht darin.
const APP = join(HIER, "..", "fussballcamp") + "/";
const WORKER = fs.readFileSync(join(HIER, "admin-worker.js"), "utf8");
const lies = (f) => fs.readFileSync(APP + f, "utf8");

const funde = [];
const ok = [];
function pruefe(name, bedingung, detail) {
  if (bedingung) ok.push(name);
  else funde.push({ name, detail });
}

// =========================================================================
console.log("1. Namenskollisionen ueber Dateigrenzen");
// =========================================================================
// ⚠️ Alle Seiten laden mehrere klassische <script src>, die sich EINEN globalen
// lexikalischen Scope teilen. Derselbe const-Name in zwei davon ist ein
// SyntaxError, der die zweite Datei komplett abwuergt -- node --check sieht das
// nicht, weil es je Datei prueft.
const SEITEN = {
  "index.html":            ["config.js", "db.js", "app.js"],
  "anmeldung.html":        ["config.js", "oeffentlich.js", "anmeldung.js"],
  "meine-anmeldung.html":  ["config.js", "oeffentlich.js", "meine-anmeldung.js"]
};
for (const [seite, dateien] of Object.entries(SEITEN)) {
  const wo = new Map();
  for (const d of dateien) {
    for (const m of lies(d).matchAll(/^(const|let|class|function)\s+(\w+)/gm)) {
      if (!wo.has(m[2])) wo.set(m[2], []);
      wo.get(m[2]).push(d);
    }
  }
  const doppelt = [...wo].filter(([, ds]) => ds.length > 1);
  pruefe(`${seite}: keine doppelten Top-Level-Namen`, doppelt.length === 0, JSON.stringify(doppelt));
}

// =========================================================================
console.log("2. Doppelt gefuehrte Listen (Worker vs. Client)");
// =========================================================================
const config = lies("config.js");

// FC_FELDER (Worker, wirksam) gegen FORMULAR_FELDER (config.js, Anzeige)
const workerFelder = [...WORKER.matchAll(/^  (\w+):\s+\{ typ: "/gm)].map((m) => m[1]);
const clientFelder = [...config.matchAll(/\{ id: "(\w+)",\s+gruppe:/g)].map((m) => m[1]);
pruefe("FC_FELDER und FORMULAR_FELDER decken sich",
  workerFelder.length > 0 && clientFelder.length > 0 &&
  workerFelder.slice().sort().join(",") === clientFelder.slice().sort().join(","),
  `Worker: ${workerFelder.join(",")}\n   Client: ${clientFelder.join(",")}`);

// FC_BETREUER_FELDER (Worker) gegen BETREUER_FELDER (config.js)
const bw = (WORKER.match(/const FC_BETREUER_FELDER = \[([^\]]+)\]/) || [])[1] || "";
const bc = (config.match(/const BETREUER_FELDER = \[([^\]]+)\]/) || [])[1] || "";
const norm = (s) => s.split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean).sort().join(",");
pruefe("BETREUER_FELDER decken sich", bw && bc && norm(bw) === norm(bc),
  `Worker: ${norm(bw)}\n   Client: ${norm(bc)}`);

// DEFAULT_FELDER darf nur Feld-Ids nennen, die es wirklich gibt
const defBlock = (config.match(/const DEFAULT_FELDER = \{([\s\S]*?)\};/) || [])[1] || "";
const defIds = [...defBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
const unbekannt = defIds.filter((id) => !clientFelder.includes(id));
pruefe("DEFAULT_FELDER nennt nur bekannte Felder", unbekannt.length === 0, unbekannt.join(","));

// Feste Felder duerfen nicht in DEFAULT_FELDER stehen (sie sind immer Pflicht)
const feste = [...config.matchAll(/\{ id: "(\w+)",[^}]*fest: true/g)].map((m) => m[1]);
const festeInDefault = defIds.filter((id) => feste.includes(id));
pruefe("Keine festen Felder in DEFAULT_FELDER", festeInDefault.length === 0, festeInDefault.join(","));

// Verwendungszweck: Worker und Client muessen zeichengenau dasselbe liefern
const vzW = (WORKER.match(/function fcVerwendungszweck\(camp, a\) \{([\s\S]*?)\n\}/) || [])[1] || "";
const vzC = (lies("app.js").match(/function verwendungszweck\(camp, a\) \{([\s\S]*?)\n\}/) || [])[1] || "";
// ⚠️ Die Namensfunktion heißt drüben fcKindName und hier kindName — nur das darf
// abweichen. Beide werden darunter selbst gegeneinander geprüft; ohne das würde
// das Angleichen der Namen einen echten Unterschied verstecken.
const kern = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ")
  .replace(/\bfcKindName\b/g, "kindName").replace(/capStr|cap\b/g, "K").trim();
pruefe("Verwendungszweck: Worker und Client bauen gleich",
  vzW && vzC && kern(vzW) === kern(vzC), `Worker: ${kern(vzW)}\n   Client: ${kern(vzC)}`);

const knW = (WORKER.match(/function fcKindName\(a\) \{([\s\S]*?)\n\}/) || [])[1] || "";
const knC = (lies("app.js").match(/function kindName\(a\) \{([^\n]*)\}/) || [])[1] || "";
pruefe("Die Namensfunktion selbst ist auf beiden Seiten gleich",
  knW && knC && kern(knW) === kern(knC), `Worker: ${kern(knW)}\n   Client: ${kern(knC)}`);

// =========================================================================
console.log("3. Element-Ids: was der Code sucht, muss im HTML stehen");
// =========================================================================
// ⚠️ Falsch-Positive sind hier die Regel: viele Ids erzeugt app.js selbst in
// Modals. Deshalb wird der von der App GESCHRIEBENE Markup mitgezaehlt.
for (const [seite, dateien] of Object.entries(SEITEN)) {
  const html = lies(seite);
  const js = dateien.map(lies).join("\n");
  const imHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const imJs   = new Set([...js.matchAll(/id="([^"$]+)"/g)].map((m) => m[1]));
  const gesucht = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
  const fehlend = [...new Set(gesucht)].filter((id) => !imHtml.has(id) && !imJs.has(id));
  pruefe(`${seite}: jede gesuchte Id existiert`, fehlend.length === 0, fehlend.join(", "));
}

// =========================================================================
console.log("4. Cache-Bust: jede geaenderte Datei traegt eine frische Nummer");
// =========================================================================
for (const [seite, dateien] of Object.entries(SEITEN)) {
  const html = lies(seite);
  for (const d of dateien) {
    const m = html.match(new RegExp(d.replace(".", "\\.") + '\\?v=([0-9.]+)'));
    pruefe(`${seite}: ${d} hat ?v=`, !!m, "fehlt");
  }
}
// config.js muss auf ALLEN Seiten dieselbe Nummer tragen -- es ist dieselbe Datei
const vNums = Object.keys(SEITEN).map((s) => (lies(s).match(/config\.js\?v=([0-9.]+)/) || [])[1]);
pruefe("config.js hat ueberall dieselbe ?v=-Nummer",
  new Set(vNums).size === 1, vNums.join(" / "));

// APP_VERSION darf NICHT hochgezaehlt werden
pruefe("APP_VERSION steht auf 1.0", /const APP_VERSION = "1\.0"/.test(config),
  (config.match(/const APP_VERSION = "[^"]*"/) || [])[0]);

// Changelog-Nummern muessen absteigend und eindeutig sein
const versionen = [...config.matchAll(/^    version: "([^"]+)"/gm)].map((m) => m[1]);
const alsZahl = versionen.map((v) => v.split(".").map(Number));
let absteigend = true;
for (let i = 1; i < alsZahl.length; i++) {
  const [a1, a2] = alsZahl[i - 1], [b1, b2] = alsZahl[i];
  if (a1 < b1 || (a1 === b1 && a2 <= b2)) absteigend = false;
}
pruefe("Changelog: Nummern absteigend und eindeutig", absteigend && new Set(versionen).size === versionen.length,
  versionen.join(", "));

// =========================================================================
console.log("5. Die Adressen, die mehrfach dastehen");
// =========================================================================
const popup = lies("popup.js");
const appUrlConfig = (config.match(/const APP_URL = "([^"]+)"/) || [])[1];
const appUrlWorker = (WORKER.match(/const FC_APP_URL = "([^"]+)"/) || [])[1];
pruefe("APP_URL: config.js und Worker gleich", appUrlConfig && appUrlConfig === appUrlWorker,
  `${appUrlConfig} / ${appUrlWorker}`);

const bildConfig = (config.match(/const CAMP_BILD_BASIS = "([^"]+)"/) || [])[1];
// ⚠️ popup.js setzt die Adresse aus GATEWAY + Pfad zusammen, statt sie als
// String hinzuschreiben. Ein Regex auf ein String-Literal findet dort nichts und
// meldet „läuft auseinander", wo nichts auseinanderläuft.
const gatewayPopup = (popup.match(/var GATEWAY = "([^"]+)"/) || [])[1];
const bildTeil     = (popup.match(/var BILD_BASIS = GATEWAY \+ "([^"]+)"/) || [])[1];
const bildPopup    = (gatewayPopup && bildTeil) ? gatewayPopup + bildTeil : undefined;
pruefe("Bild-Adresse: config.js und popup.js gleich", bildConfig && bildConfig === bildPopup,
  `${bildConfig} / ${bildPopup}`);

// Bild-Groessengrenze steht in beiden
const maxW = (WORKER.match(/const FC_MAX_BILD_BYTES = ([^;]+);/) || [])[1];
const maxC = (config.match(/const CAMP_BILD_MAX_BYTES = ([^;]+);/) || [])[1];
const rechne = (s) => { try { return Function('"use strict";return (' + s + ')')(); } catch { return null; } };
pruefe("Bild-Groessengrenze: Worker und Client gleich",
  maxW && maxC && rechne(maxW) === rechne(maxC), `${maxW} / ${maxC}`);

// =========================================================================
console.log("6. Gerade Anfuehrungszeichen in deutschem Text");
// =========================================================================
// ⚠️ Ein gerades " mitten in einem deutschen Satz in einem "..."-String zerlegt
// die Datei lautlos. node --check faengt das -- aber nur, wenn daraus wirklich
// ungueltiger Code wird.
for (const d of ["config.js", "app.js", "db.js", "oeffentlich.js", "anmeldung.js", "meine-anmeldung.js", "popup.js"]) {
  const s = lies(d);
  let gut = true;
  try { new Function(s); } catch (e) { if (String(e).includes("SyntaxError")) gut = false; }
  pruefe(`${d}: laesst sich als Funktion bauen`, gut, "SyntaxError");
}

// =========================================================================
console.log("\n" + "=".repeat(64));
console.log(`${ok.length} Prüfungen ohne Befund.`);
if (funde.length) {
  console.log(`\n${funde.length} BEFUNDE:\n`);
  funde.forEach((f, i) => console.log(`${i + 1}. ${f.name}\n   ${f.detail}\n`));
  process.exit(1);
} else {
  console.log("Keine Befunde.");
}
