// Pruefstand: "Wer darf das Kind abholen" haengt an "Darf das Kind allein nach
// Hause gehen?" -- das Feld steht nur bei "nein" da, und bei "ja" wird es
// geleert.
//
//   node pruef-camp-abholung.mjs             # Zusagen
//   node pruef-camp-abholung.mjs --mutation  # zeigt, dass die Zusagen rot werden koennen
//
// ⚠️ Client- UND Worker-Code werden AUS DEN DATEIEN GEZOGEN (new Function), nicht
// nachgebaut. Fehlt eine Marke, bricht der Lauf ab statt gruen zu melden.
//
// ⚠️ Die beiden Seiten sind mit ABSICHT nicht spiegelgleich:
//   Client `zeigtWenn` = zeigen bei "nein"  (verborgen also auch unbeantwortet)
//   Worker `leerWenn`  = leeren  bei "ja"   (unbeantwortet wird NICHT geleert)
// Ein Abholberechtigter neben einer unbeantworteten Frage ist eine Angabe, kein
// Widerspruch. Wer das angleicht, loescht Daten, die niemand widerrufen hat.
import { readFileSync as readFileSyncRoh } from "node:fs";
// ⚠️ Zeilenenden beim Einlesen auf LF normalisieren. Die Schnittmarken unten
// ("\n];\n" und Verwandte) gibt es in einer CRLF-Datei nicht -- und git liefert
// mit core.autocrlf=true und ohne .gitattributes genau die aus. Ohne diese
// Huelle bricht der Pruefstand nach jedem frischen Checkout mit "Endmarke
// fehlt" ab und prueft KEINE EINZIGE Zusage -- der Absturz sieht dabei aus wie
// ein Fehler am geprueften Code. Bugjagd 04.09.2026: 9 von 11 Camp-Pruefstaenden.
const readFileSync = (p, e) => {
  const r = readFileSyncRoh(p, e);
  return typeof r === "string" ? r.replace(/\r\n/g, "\n") : r;
};
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HIER = dirname(fileURLToPath(import.meta.url));
const APP = join(HIER, "..", "fussballcamp") + "/";
const WORKER_Q = readFileSync(join(HIER, "admin-worker.js"), "utf8");
const OEFF_Q = readFileSync(APP + "oeffentlich.js", "utf8");
const CONFIG_Q = readFileSync(APP + "config.js", "utf8");

function schneide(quelle, von, bis, name) {
  const a = quelle.indexOf(von);
  if (a < 0) { console.error("ABBRUCH: Anfangsmarke fehlt -- " + name + ": " + von); process.exit(2); }
  const b = bis === null ? quelle.length : quelle.indexOf(bis, a);
  if (b < 0) { console.error("ABBRUCH: Endmarke fehlt -- " + name + ": " + bis); process.exit(2); }
  return quelle.slice(a, b);
}

// ---- Quellbloecke ---------------------------------------------------------
const Q_FELDER  = schneide(CONFIG_Q, "const FORMULAR_FELDER = [", "\n];\n", "FORMULAR_FELDER") + "\n];\n";
const Q_GRUPPEN = schneide(CONFIG_Q, "const FELD_GRUPPEN = [", "\n];\n", "FELD_GRUPPEN") + "\n];\n";
const Q_JANEIN  = schneide(CONFIG_Q, "const JANEIN = [", "\n];\n", "JANEIN") + "\n];\n";
const Q_OEFF    = schneide(OEFF_Q, "function sichtbareFelder(konf) {", "// ---------- Teilnahmebedingungen ----------", "Formularbauer");
const Q_OESC    = schneide(OEFF_Q, "function oEsc(s) {", "\n}\n", "oEsc") + "\n}\n";

const Q_CAPSTR  = schneide(WORKER_Q, "function capStr(v, max) {", "\n}\n", "capStr") + "\n}\n";
const Q_FCFELD  = schneide(WORKER_Q, "const FC_FELDER = {", "\n};\n", "FC_FELDER") + "\n};\n";
const Q_FEHLER  = schneide(WORKER_Q, "class FcFehler extends Error {", "\n}\n", "FcFehler") + "\n}\n";
const Q_DATUM   = schneide(WORKER_Q, "function fcDatum(roh) {", "\nfunction fcDatumDe(", "fcDatum");
const Q_PRUEF   = schneide(WORKER_Q, "function fcFelderPruefen(camp, roh) {", "\nasync function handleFcAnmelden", "fcFelderPruefen");

// ⚠️ Ohne diese Marken prueft der Lauf etwas anderes als gemeint.
for (const [q, m, n] of [
  [Q_FELDER, 'zeigtWenn: { feld: "alleinNachHause", wert: "nein" }', "config.js: zeigtWenn am Abholfeld"],
  [Q_OEFF, "function feldSteuerung(", "oeffentlich.js: feldSteuerung"],
  [Q_OEFF, "data-zeigt-fuer=", "oeffentlich.js: Huelle"],
  [Q_FCFELD, 'leerWenn: { feld: "alleinNachHause", wert: "ja" }', "admin-worker.js: leerWenn"],
  [Q_PRUEF, "FC_FELDER[id].leerWenn", "admin-worker.js: Nachlauf in fcFelderPruefen"]
]) if (!q.includes(m)) { console.error("ABBRUCH: " + n + " fehlt."); process.exit(2); }

// ---- Papp-DOM -------------------------------------------------------------
// ⚠️ Wirft bei einem unbekannten Selektor, statt null zu liefern. Ein stiller
// Fehlgriff saehe sonst wie eine bestandene Zusage aus.
function papDom(stand, felder) {
  return {
    querySelector: (sel) => {
      let m = /^\[data-feld="([^"]+)"\](:checked)?$/.exec(sel);
      if (m) {
        const id = m[1];
        if (!felder.some((f) => f.id === id)) throw new Error("Pruefstand kennt das Feld nicht: " + id);
        const v = stand[id];
        if (m[2]) return v ? { value: String(v) } : null;
        if (v === undefined) return null;
        return { value: String(v), checked: v === true };
      }
      m = /^\[data-feld-hat="([^"]+)"\]:checked$/.exec(sel);
      if (m) { const v = stand[m[1] + "Hat"]; return v ? { value: String(v) } : null; }
      if (sel === "[data-rolle]" || sel === "[data-rolle]:checked") return null;
      throw new Error("Unbekannter Selektor im Pruefstand: " + sel);
    }
  };
}

// ---- Module bauen ---------------------------------------------------------
function baueClient(qOeff) {
  const quelle =
    "const CSS = { escape: (s) => s };\n" +
    "const ROLLEN = [{ id: 'feldspieler', label: 'Feldspieler' }, { id: 'torwart', label: 'Torwart' }];\n" +
    "function rolleLabel(id) { return (ROLLEN.find((r) => r.id === id) || {}).label || id; }\n" +
    Q_FELDER + Q_GRUPPEN + Q_JANEIN + Q_OESC + qOeff +
    "return { FORMULAR_FELDER, sichtbareFelder, istPflicht, feldSteuerung, janeinWert, feldHtml, leseFormular };";
  return new Function(quelle)();
}

function baueWorker(qPruef) {
  const quelle = Q_FEHLER + Q_CAPSTR + Q_DATUM + Q_FCFELD + qPruef +
    "return { FC_FELDER, fcFelderPruefen, FcFehler };";
  return new Function(quelle)();
}

const FEST = { kindVorname: "Mia", kindNachname: "Musterkind", elternName: "A. Musterkind", elternEmail: "a@example.org" };

// ---- Der Lauf -------------------------------------------------------------
// ⚠️ Nimmt die Quellen als Parameter. Nur so laeuft die Mutationsprobe wirklich
// durch `new Function` und nicht bloss gegen einen Textvergleich.
function lauf(qOeff, qPruef) {
  const rot = [];
  let ok = 0;
  const zusage = (name, bedingung, detail) => {
    if (bedingung) ok++;
    else rot.push(name + (detail ? "\n       " + detail : ""));
  };

  const C = baueClient(qOeff);
  const W = baueWorker(qPruef);
  const feld = (id) => C.FORMULAR_FELDER.find((f) => f.id === id);
  const AB = feld("abholberechtigt");

  // --- 1. Die Verdrahtung selbst -----------------------------------------
  zusage("config.js: abholberechtigt haengt an alleinNachHause/nein",
    !!AB && !!AB.zeigtWenn && AB.zeigtWenn.feld === "alleinNachHause" && AB.zeigtWenn.wert === "nein",
    JSON.stringify(AB && AB.zeigtWenn));
  zusage("admin-worker.js: abholberechtigt wird bei alleinNachHause=ja geleert",
    !!W.FC_FELDER.abholberechtigt.leerWenn &&
    W.FC_FELDER.abholberechtigt.leerWenn.feld === "alleinNachHause" &&
    W.FC_FELDER.abholberechtigt.leerWenn.wert === "ja",
    JSON.stringify(W.FC_FELDER.abholberechtigt.leerWenn));
  // ⚠️ Verdrahtungs-Zusage: ohne den Horcher in baueFormular waere das Markup
  // richtig und die Huelle ginge trotzdem nie auf.
  zusage("baueFormular horcht auf die Steuerfrage",
    qOeff.includes('querySelectorAll("[data-zeigt-fuer]")') &&
    /dataset\.steuer\b/.test(qOeff) && /classList\.toggle\("fc-hidden"/.test(qOeff));

  // --- 2. Markup: Huelle auf und zu --------------------------------------
  const konfAn = { alleinNachHause: "pflicht", abholberechtigt: "optional" };
  const html = (werte, konf) => C.feldHtml(AB, konf, werte.abholberechtigt, C.feldSteuerung(AB, konf, werte));

  zusage("unbeantwortet: Abholfeld verborgen", html({}, konfAn).includes("fc-hidden"));
  zusage('"nein": Abholfeld sichtbar', !html({ alleinNachHause: "nein" }, konfAn).includes("fc-hidden"));
  zusage('"ja": Abholfeld verborgen', html({ alleinNachHause: "ja" }, konfAn).includes("fc-hidden"));
  // ⚠️ Altbestand aus der Haken-Zeit: true zaehlt als "ja".
  zusage("altes true zaehlt als ja, Abholfeld verborgen", html({ alleinNachHause: true }, konfAn).includes("fc-hidden"));
  // ⚠️ Die Zusage darueber allein ist BLIND: bei `wert: "nein"` bleibt das Feld
  // verborgen, egal wie true gedeutet wird. Von der Mutationsprobe gefunden.
  // Deshalb die Umdeutung hier direkt und einmal in die andere Richtung.
  zusage("janeinWert: true wird zu ja", C.janeinWert(true) === "ja", JSON.stringify(C.janeinWert(true)));
  // ⚠️ false wird NICHT zu "nein": ein nicht gesetzter Haken war nie eine
  // belastbare Verneinung, sondern konnte genauso gut uebersehen worden sein.
  zusage("janeinWert: false bleibt unbeantwortet", C.janeinWert(false) === "", JSON.stringify(C.janeinWert(false)));
  const abJa = Object.assign({}, AB, { zeigtWenn: { feld: "alleinNachHause", wert: "ja" } });
  zusage("Huelle mit wert=ja geht bei altem true auf",
    !C.feldHtml(abJa, konfAn, "", C.feldSteuerung(abJa, konfAn, { alleinNachHause: true })).includes("fc-hidden"));
  const huelle = html({}, konfAn);
  zusage("Huelle traegt die drei Angaben, die der Horcher braucht",
    /data-zeigt-fuer="abholberechtigt"/.test(huelle) &&
    /data-steuer="alleinNachHause"/.test(huelle) &&
    /data-steuer-wert="nein"/.test(huelle), huelle.slice(0, 200));

  // --- 3. required: nie an einem verborgenen Feld ------------------------
  const konfPflicht = { alleinNachHause: "pflicht", abholberechtigt: "pflicht" };
  zusage("Pflicht + abhaengig: KEIN required im Markup",
    !/\srequired/.test(html({ alleinNachHause: "nein" }, konfPflicht)),
    "sonst verweigert der Browser das Absenden an einem Feld, das niemand sieht");
  // Gegenprobe, damit die Zusage darueber nicht trivial gruen ist.
  zusage("Gegenprobe: gewoehnliches Pflichtfeld traegt required",
    /\srequired/.test(C.feldHtml(feld("bemerkung"), { bemerkung: "pflicht" }, "", null)));
  // Steuerfrage am Camp AUS -> gewoehnliches Feld, sonst waere es unausfuellbar.
  const konfOhne = { abholberechtigt: "pflicht" };
  const ohne = C.feldHtml(AB, konfOhne, "", C.feldSteuerung(AB, konfOhne, {}));
  zusage("Steuerfrage aus: keine Huelle", !ohne.includes("data-zeigt-fuer"));
  zusage("Steuerfrage aus: required wieder da", /\srequired/.test(ohne));

  // --- 4. leseFormular: was mitgeschickt wird ----------------------------
  const lies = (stand, konf) => C.leseFormular(papDom(Object.assign({}, FEST, stand), C.FORMULAR_FELDER), konf);

  const a = lies({ alleinNachHause: "ja", abholberechtigt: "Oma Erna" }, konfAn);
  zusage('"ja": der versteckte Text wird NICHT mitgeschickt',
    a.daten.abholberechtigt === "", JSON.stringify(a.daten.abholberechtigt));
  const b = lies({ alleinNachHause: "nein", abholberechtigt: "Oma Erna" }, konfAn);
  zusage('"nein": der Text kommt mit',
    b.daten.abholberechtigt === "Oma Erna", JSON.stringify(b.daten.abholberechtigt));
  const c = lies({ alleinNachHause: "", abholberechtigt: "Oma Erna" }, konfAn);
  zusage("unbeantwortet: nichts mitgeschickt",
    c.daten.abholberechtigt === "", JSON.stringify(c.daten.abholberechtigt));

  const d = lies({ alleinNachHause: "ja", abholberechtigt: "" }, konfPflicht);
  zusage('"ja" + Pflicht: KEINE fehlende Angabe',
    !d.fehlend.some((x) => /abholen/i.test(x)), d.fehlend.join(" | "));
  const e = lies({ alleinNachHause: "nein", abholberechtigt: "" }, konfPflicht);
  zusage('"nein" + Pflicht + leer: fehlende Angabe',
    e.fehlend.some((x) => /abholen/i.test(x)), e.fehlend.join(" | "));

  // --- 5. Worker: leeren, aber nur beim echten Widerspruch ---------------
  const camp = { felder: { alleinNachHause: "optional", abholberechtigt: "optional" } };
  const p = (roh, cmp) => W.fcFelderPruefen(cmp || camp, Object.assign({}, FEST, roh));

  zusage('Worker "ja": Abholfeld wird geleert',
    p({ alleinNachHause: "ja", abholberechtigt: "Oma Erna" }).abholberechtigt === "");
  zusage('Worker "nein": Abholfeld bleibt',
    p({ alleinNachHause: "nein", abholberechtigt: "Oma Erna" }).abholberechtigt === "Oma Erna");
  // ⚠️ Bewusst NICHT geleert: unbeantwortet ist kein Widerspruch.
  zusage("Worker unbeantwortet: Abholfeld bleibt stehen",
    p({ alleinNachHause: "", abholberechtigt: "Oma Erna" }).abholberechtigt === "Oma Erna");

  const campPflicht = { felder: { alleinNachHause: "pflicht", abholberechtigt: "pflicht" } };
  let warf = false;
  try { p({ alleinNachHause: "ja", abholberechtigt: "" }, campPflicht); } catch (_) { warf = true; }
  zusage('Worker "ja" + Pflicht + leer: kein Fehler',
    !warf, "sonst waere ein solches Camp fuer diese Kinder unanmeldbar");
  warf = false;
  try { p({ alleinNachHause: "nein", abholberechtigt: "" }, campPflicht); } catch (_) { warf = true; }
  zusage('Worker "nein" + Pflicht + leer: Fehler', warf);

  // Steuerfrage am Camp aus -> gewoehnliches Feld.
  const campOhne = { felder: { abholberechtigt: "optional" } };
  zusage("Worker: Steuerfrage aus, Abholfeld bleibt",
    p({ alleinNachHause: "ja", abholberechtigt: "Oma Erna" }, campOhne).abholberechtigt === "Oma Erna");

  // Gegenprobe: die Regel greift NUR an diesem Feld.
  zusage("Gegenprobe: bemerkung wird von der Regel nicht angefasst",
    p({ alleinNachHause: "ja", bemerkung: "bitte anrufen" },
      { felder: { alleinNachHause: "optional", bemerkung: "optional" } }).bemerkung === "bitte anrufen");

  return { ok, rot };
}

// ---- Mutationsprobe -------------------------------------------------------
// ⚠️ Eine Mutation, die niemand faengt, heisst: die Zusage darueber ist blind.
const MUTATIONEN = [
  ["Client: required auch am verborgenen Feld", "client",
    'const req = pflicht && !ab ? " required" : "";', 'const req = pflicht ? " required" : "";'],
  ["Client: Huelle immer offen", "client",
    '<div class="anm-abhaengig${ab.offen ? "" : " fc-hidden"}"', '<div class="anm-abhaengig"'],
  ["Client: altes true zaehlt nicht mehr als ja", "client",
    'return roh === true ? "ja" : (roh === "ja" || roh === "nein" ? roh : "");',
    'return (roh === "ja" || roh === "nein" ? roh : "");'],
  ["Client: verstecktes Feld wird doch gelesen", "client",
    'daten[f.id] = f.typ === "haken" ? false : "";\n        return;', 'void 0;'],
  ["Client: Steuerfrage aus wird ignoriert", "client",
    "if (!sichtbareFelder(konf).some((x) => x.id === ab.feld)) return null;", ""],
  ["Worker: leert nicht", "worker",
    'sauber[id] = "";\n    const i = fehlend.indexOf(id);', "const i = fehlend.indexOf(id);"],
  ["Worker: Pflicht bleibt trotz Leerung", "worker",
    "const i = fehlend.indexOf(id);\n    if (i >= 0) fehlend.splice(i, 1);", ""],
  ["Worker: leert auch bei unbeantwortet", "worker",
    "if (sauber[ab.feld] === undefined || sauber[ab.feld] !== ab.wert) return;",
    "if (sauber[ab.feld] === undefined) return;"]
];

function mutationsprobe() {
  console.log("\nMutationsprobe -- jede Zeile MUSS rot werden:");
  let gefangen = 0;
  for (const [name, seite, alt, neu] of MUTATIONEN) {
    const q = seite === "client" ? Q_OEFF : Q_PRUEF;
    if (!q.includes(alt)) { console.log("  ABBRUCH   " + name + " -- Textstelle nicht gefunden"); continue; }
    const mut = q.replace(alt, neu);
    let rot;
    try {
      rot = lauf(seite === "client" ? mut : Q_OEFF, seite === "worker" ? mut : Q_PRUEF).rot;
    } catch (err) { rot = ["Ausnahme: " + err.message]; }
    if (rot.length) { gefangen++; console.log("  gefangen  " + name); }
    else console.log("  DURCH     " + name + "  <-- blinde Zusage!");
  }
  console.log(`\n${gefangen}/${MUTATIONEN.length} Mutationen gefangen.`);
  return gefangen === MUTATIONEN.length;
}

// ---- Ausgabe --------------------------------------------------------------
const ergebnis = lauf(Q_OEFF, Q_PRUEF);
console.log(`Pruefstand Abholberechtigte: ${ergebnis.ok} Zusagen, ${ergebnis.rot.length} rot.`);
ergebnis.rot.forEach((r) => console.log("  ROT  " + r));

let mutOk = true;
if (process.argv.includes("--mutation")) mutOk = mutationsprobe();

process.exit(ergebnis.rot.length === 0 && mutOk ? 0 : 1);
