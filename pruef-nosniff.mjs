// Prueft, dass JEDER Weg, auf dem dieser Worker eine Datei ausliefert, sie
// mit nosniff und einem geprueften Typ herausgibt.
//
//   node pruef-nosniff.mjs                 # 28 Zusagen
//   node pruef-nosniff.mjs --mutation      # zeigt, dass die Zusagen rot werden koennen
//   node pruef-nosniff.mjs <pfad-zum-worker>
//   WORKER_DATEI=<pfad> node pruef-nosniff.mjs
//
// ⚠️ Der eigentliche Zweck ist NICHT der heutige Stand, sondern der naechste
// Dateiweg. Die Zusage C1 faellt um, sobald jemand seine Kopfzeilen wieder von
// Hand baut — genau so sind die neun Wege auseinandergelaufen.
//
// ⚠️ Zwei verschiedene Loecher, und nosniff schliesst nur eines:
//   1. Der Browser RAET den Typ  -> nosniff hilft.
//   2. Der gemeldete Typ IST text/html -> nosniff hilft NICHT, nur die weisse Liste.
// Deshalb pruefen die Abschnitte A und B getrennt.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HIER = dirname(fileURLToPath(import.meta.url));
const DATEI = process.env.WORKER_DATEI
  || process.argv.find((a) => !a.startsWith("--") && a.endsWith(".js"))
  || join(HIER, "admin-worker.js");
const W = readFileSync(DATEI, "utf8");

function schneide(von, bis, name) {
  const a = W.indexOf(von);
  if (a < 0) { console.error("ABBRUCH: Anfangsmarke fehlt -- " + name); process.exit(2); }
  const b = W.indexOf(bis, a);
  if (b < 0) { console.error("ABBRUCH: Endmarke fehlt -- " + name); process.exit(2); }
  return W.slice(a, b);
}

const BLOCK = schneide("const DATEI_TYP_ERLAUBT = new Set([",
  "// Verzeichnis-URL", "Typ-Helfer");

function lade(quelle) {
  return new Function(quelle + "\nreturn { sichererDateiTyp, dateiKopfzeilen, DATEI_TYP_ERLAUBT };")();
}

// ⚠️ Diese Wege bauen ihre Kopfzeilen bewusst selbst und tragen nosniff dort.
// Die Liste steht hier, damit eine NEUE Ausnahme auffaellt statt durchzurutschen.
const EIGENE_KOEPFE = ["handleVvNachweisGet", "handleUnterlagenDatei", "handleFcBildGet", "handleKsBildGet"];
// Diese liefern keine Datei, sondern selbst erzeugten Text mit festem Typ.
const KEIN_DATEIWEG = ["function json(", "function vkTextAntwort(", "handleVkIcsFeed"];

// ----------------------------------------------------------------------------
function verhalten(m) {
  const t = m.sichererDateiTyp;
  const z = [];
  const ok = (name, b) => z.push([name, b]);

  // --- A: die weisse Liste (gegen "der Typ IST text/html")
  ok("A1 text/html wird zu octet-stream", t("text/html") === "application/octet-stream");
  ok("A2 auch mit Anhang dahinter", t("text/html; charset=utf-8") === "application/octet-stream");
  ok("A3 auch in Grossbuchstaben", t("TEXT/HTML") === "application/octet-stream");
  ok("A4 auch mit Leerzeichen davor", t("  text/html  ") === "application/octet-stream");
  ok("A5 SVG wird zu octet-stream (kann Skript tragen)", t("image/svg+xml") === "application/octet-stream");
  ok("A6 JavaScript wird zu octet-stream", t("application/javascript") === "application/octet-stream"
     && t("text/javascript") === "application/octet-stream");
  ok("A7 XML wird zu octet-stream", t("application/xhtml+xml") === "application/octet-stream");
  ok("A8 leer und null werden zu octet-stream", t("") === "application/octet-stream" && t(null) === "application/octet-stream");
  ok("A9 PDF bleibt PDF", t("application/pdf") === "application/pdf");
  ok("A10 Bilder bleiben Bilder", ["image/jpeg", "image/png", "image/webp", "image/gif"].every((x) => t(x) === x));
  ok("A11 Word und Excel bleiben (Serienbriefe, Listen)",
     t("application/vnd.openxmlformats-officedocument.wordprocessingml.document").startsWith("application/vnd.openxml")
     && t("application/vnd.ms-excel") === "application/vnd.ms-excel");
  ok("A12 Video bleibt (Bildschirmvideo an einer Neuigkeit)", t("video/mp4") === "video/mp4");
  // ⚠️ Diese zwei tragen das Abschneiden und das Kleinschreiben. Fuer die
  // SICHERHEIT braucht es beides nicht — was nicht auf der Liste steht, faellt
  // ohnehin auf octet-stream. Ohne sie liefen die zwei Mutationen ins Leere und
  // sahen aus wie blinde Zusagen. Der Schaden waere Nutzbarkeit: ein voellig
  // harmloses PDF kaeme als octet-stream heraus, nur weil Nextcloud einen
  // Zusatz hinter den Typ schreibt.
  ok("A14 Ein erlaubter Typ MIT Zusatz bleibt erhalten", t("application/pdf; charset=binary") === "application/pdf");
  ok("A15 Ein erlaubter Typ in Grossbuchstaben bleibt erhalten", t("APPLICATION/PDF") === "application/pdf"
     && t("Image/JPEG") === "image/jpeg");
  ok("A13 Die weisse Liste enthaelt KEIN svg und KEIN html",
     ![...m.DATEI_TYP_ERLAUBT].some((x) => /svg|html|javascript|xhtml/.test(x)));

  // --- B: die Kopfzeilen (gegen "der Browser raet")
  const k = m.dateiKopfzeilen({ "Access-Control-Allow-Origin": "*" }, "application/pdf");
  ok("B1 nosniff steht drin", k["X-Content-Type-Options"] === "nosniff");
  ok("B2 Der CORS-Kopf bleibt erhalten", k["Access-Control-Allow-Origin"] === "*");
  ok("B3 Vorgabe ist private, no-store", k["Cache-Control"] === "private, no-store");
  ok("B4 Ein eigener Cache-Wert geht durch",
     m.dateiKopfzeilen({}, "image/png", "private, max-age=300")["Cache-Control"] === "private, max-age=300");
  ok("B5 Der Typ laeuft durch die weisse Liste",
     m.dateiKopfzeilen({}, "text/html")["Content-Type"] === "application/octet-stream");
  ok("B6 Die uebergebenen CORS-Kopfzeilen werden NICHT veraendert", (() => {
    const cors = { "Access-Control-Allow-Origin": "*" };
    m.dateiKopfzeilen(cors, "text/html");
    return Object.keys(cors).length === 1 && !cors["Content-Type"];
  })());

  return z;
}

// Rumpf einer Funktion: vom Kopf bis zur naechsten Zeile, die nur "}" traegt.
function rumpfHat(name, was) {
  const i = W.indexOf("function " + name + "(");
  if (i < 0) return false;
  const ende = W.indexOf("\n}\n", i);
  return W.slice(i, ende < 0 ? W.length : ende).includes(was);
}

// ----------------------------------------------------------------------------
// C: die eigentliche Zusage — kein Dateiweg baut seine Kopfzeilen von Hand.
function quelltext() {
  const zeilen = W.split("\n");
  const nackt = [];
  for (let i = 0; i < zeilen.length; i++) {
    if (!/new Response\(/.test(zeilen[i])) continue;
    // ⚠️ NUR bis zum Ende DIESER Response schauen. Ein festes Fenster von zwoelf
    // Zeilen lief in den naechsten Rueckgabewert hinein: die drei
    // 404-Antworten in handleKsBildGet haben gar keinen Content-Type, erbten ihn
    // aber aus dem Erfolgszweig darunter und wurden faelschlich rot.
    let block = "";
    for (let k = i; k < Math.min(i + 12, zeilen.length); k++) {
      block += zeilen[k] + "\n";
      if (k > i && /^\s*\}\);?\s*$/.test(zeilen[k])) break;
      if (/\}\);\s*$/.test(zeilen[k])) break;
    }
    if (!/"Content-Type"/.test(block)) continue;
    if (/X-Content-Type-Options|dateiKopfzeilen/.test(block)) continue;
    // In welcher Funktion stehen wir?
    let fn = "?";
    for (let k = i; k >= 0; k--) {
      const m = /^(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/.exec(zeilen[k]);
      if (m) { fn = m[1]; break; }
    }
    if (KEIN_DATEIWEG.some((x) => x.includes(fn) || x.replace("function ", "").replace("(", "") === fn)) continue;
    nackt.push({ zeile: i + 1, fn });
  }

  return [
    ["C1 KEIN Dateiweg baut seine Kopfzeilen von Hand" +
      (nackt.length ? " — offen: " + nackt.map((x) => x.fn + " Z." + x.zeile).join(", ") : ""), nackt.length === 0],
    ["C2 Alle neun Wege rufen dateiKopfzeilen()",
      (W.match(/headers: dateiKopfzeilen\(corsHeaders/g) || []).length === 9],
    ["C3 Die vier Wege mit eigenen Koepfen tragen nosniff selbst",
      EIGENE_KOEPFE.every((f) => {
        const i = W.indexOf("function " + f + "(");
        return i > 0 && /X-Content-Type-Options/.test(W.slice(i, i + 3000));
      })],
    // ⚠️ Den ganzen Funktionsrumpf nehmen, kein festes Zeichenfenster. Der erste
    // Anlauf suchte in den ersten 900 Zeichen — beide Aufrufe stehen weiter
    // hinten, und beide Zusagen wurden zu Unrecht rot.
    ["C4 Der login-lose Weg der Kleiderboerse ist dabei", rumpfHat("handleKboExternFotoGet", "dateiKopfzeilen(")],
    ["C5 Der Weg fuer die Fuehrerscheine ist dabei", rumpfHat("handleDavRestrictedGet", "dateiKopfzeilen(")],
    ["C6 Die zwei Wege mit client-behauptetem Typ sind dabei",
      (W.match(/headers: dateiKopfzeilen\(corsHeaders, meta\.mime\)/g) || []).length === 2],
    ["C7 Nirgends steht mehr der alte ungefilterte meta.mime-Kopf",
      !W.includes('"Content-Type": meta.mime || "application/octet-stream"')]
  ];
}

// ----------------------------------------------------------------------------
function melde(zeilen) {
  let rot = 0;
  for (const [name, b] of zeilen) { if (!b) rot++; console.log(`  ${b ? "ok  " : "ROT "} ${name}`); }
  return rot;
}

if (process.argv.includes("--mutation")) {
  const MUT = [
    ["nosniff aus den Kopfzeilen genommen", (b) => b.replace('    "X-Content-Type-Options": "nosniff",\n', "")],
    ["weisse Liste ausgehebelt (alles erlaubt)", (b) => b.replace("return DATEI_TYP_ERLAUBT.has(t) ? t : \"application/octet-stream\";", "return t;")],
    ["html in die weisse Liste aufgenommen", (b) => b.replace('"application/pdf", "text/plain", "text/csv",', '"application/pdf", "text/plain", "text/csv", "text/html",')],
    ["svg in die weisse Liste aufgenommen", (b) => b.replace('"image/gif", "image/heic", "image/heif",', '"image/gif", "image/heic", "image/heif", "image/svg+xml",')],
    ["Anhang hinter dem Typ nicht mehr abschneiden", (b) => b.replace('.split(";")[0].trim().toLowerCase()', '.toLowerCase()')],
    ["Grossbuchstaben nicht mehr angleichen", (b) => b.replace('.split(";")[0].trim().toLowerCase()', '.split(";")[0].trim()')],
    ["Vorgabe-Cache auf oeffentlich gedreht", (b) => b.replace('cache || "private, no-store"', 'cache || "public, max-age=3600"')]
  ];

  console.log("Datei: " + DATEI);
  console.log("unveraendert: " + verhalten(lade(BLOCK)).filter(([, b]) => !b).length + " rot (muss 0 sein)\n");

  let gefangen = 0, ungueltig = 0;
  for (const [name, f] of MUT) {
    const neu = f(BLOCK);
    if (neu === BLOCK) { ungueltig++; console.log(`  [Suchtext fehlt] ${name}`); continue; }
    let rot;
    try { rot = verhalten(lade(neu)).filter(([, b]) => !b).length; } catch { rot = 99; }
    if (rot > 0) gefangen++;
    console.log(`  ${rot > 0 ? "gefangen      " : "DURCHGERUTSCHT"} ${name}  (${rot} rot)`);
  }
  console.log(`\n${gefangen}/${MUT.length} gefangen, ${ungueltig} ungueltig`);
  process.exit(gefangen === MUT.length && ungueltig === 0 ? 0 : 1);
}

const m = lade(BLOCK);
console.log("Datei: " + DATEI + "\n");
console.log("A/B — was der Helfer tut");
const rot1 = melde(verhalten(m));
console.log("\nC — dass ihn wirklich JEDER Dateiweg benutzt");
const rot2 = melde(quelltext());
const n = verhalten(m).length + quelltext().length;
console.log(`\n${n - rot1 - rot2}/${n} Zusagen gruen, ${rot1 + rot2} rot.`);
process.exit(rot1 + rot2 ? 1 : 0);
