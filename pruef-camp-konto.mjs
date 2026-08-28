// Prüfstand für das Schloss an der Kontoverbindung (Fußballcamp).
//
// Warum es das gibt: die Kontoverbindung ist die einzige Stelle der App, an der
// ein Vertipper Geld kostet — sie steht in jeder Bestätigungsmail, und die Eltern
// überweisen dorthin. Die vier Felder sind deshalb gesperrt und müssen vor einer
// Änderung erst freigegeben werden.
//
// ⚠️ Die Verhaltenszusagen führen den ECHTEN Code aus app.js aus (über einen
// winzigen DOM-Ersatz), nicht eine Kopie davon. Ein Vergleich von Quelltexten
// hätte den Verwendungszweck-Fehler vom 25.08. auch nicht gefunden.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HIER = dirname(fileURLToPath(import.meta.url));
const APP = join(HIER, "..", "fussballcamp") + "/";
const lies = (f) => fs.readFileSync(APP + f, "utf8");
const APP_JS = lies("app.js");
const INDEX = lies("index.html");

const funde = [];
const ok = [];
function pruefe(name, bedingung, detail) {
  if (bedingung) ok.push(name);
  else funde.push({ name, detail });
}

// ---------------------------------------------------------------
//  Ein DOM, klein genug zum Nachlesen
// ---------------------------------------------------------------
function baueDom() {
  const felder = {};
  const mach = (id) => (felder[id] = {
    id, value: "", readOnly: false, textContent: "",
    classList: {
      _set: new Set(),
      toggle(k, an) { if (an) this._set.add(k); else this._set.delete(k); },
      contains(k) { return this._set.has(k); }
    }
  });
  ["e-kontoinhaber", "e-iban", "e-bic", "e-bank", "konto-schloss",
    "konto-schloss-status", "btn-konto-freigeben"].forEach(mach);
  return { felder, getElementById: (id) => felder[id] || null };
}

// Der zusammenhängende Block aus app.js — von der Überschrift bis zur nächsten
// Funktion dahinter. ⚠️ Verschwindet die Überschrift, schlägt das hier fehl
// statt stillschweigend nichts mehr zu prüfen.
const ANFANG = "// ---------- Schloss an der Kontoverbindung ----------";
const ENDE = "function fuelleVerwaltung() {";
const von = APP_JS.indexOf(ANFANG);
const bis = APP_JS.indexOf(ENDE);
if (von < 0 || bis < 0 || bis < von) {
  console.log("ABBRUCH: der Schloss-Block ist in app.js nicht auffindbar.");
  process.exit(1);
}
const SCHLOSS_QUELLE = APP_JS.slice(von, bis);

// Führt den echten Block in einem eigenen Rahmen aus. `daten` und `confirm`
// kommen von außen, damit jede Prüfung ihren eigenen Zustand hat.
function ladeSchloss(dom, daten, confirmAntwort) {
  const rahmen = new Function("document", "daten", "confirm", "KONTO_FELDER", `
    let kontoFrei = false;
    const setzeWert = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v === null || v === undefined ? "" : v;
    };
    ${SCHLOSS_QUELLE}
    return {
      setzeKontoSchloss, fuelleKontofelder, kontoFreigabeUmschalten, ibanPruefzifferOk,
      frei: () => kontoFrei
    };
  `);
  return rahmen(dom, daten, () => confirmAntwort(), ["e-kontoinhaber", "e-iban", "e-bic", "e-bank"]);
}

// ⚠️ NUR neutrale Beispielwerte. Die echte Vereins-Kontoverbindung gehört NICHT
// in dieses öffentliche Repo — auch nicht in einen Prüfstand. Am 2026-08-10 stand
// sie schon einmal in drei Prüfständen der Vereinsverwaltung, und ein Force-Push
// bekommt sie von GitHub nicht wieder weg. Siehe [[f-keine-daten-repo]].
const KONTO = {
  kontoinhaber: "Musterverein e.V.",
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  bank: "Musterbank eG"
};

console.log("1. Die Prüfziffer der IBAN");

{
  const f = ladeSchloss(baueDom(), { einstellungen: KONTO }, () => true);
  const faelle = [
    ["DE02120300000000202051", true, "Standard-Beispiel-IBAN, 22 Stellen wie eine deutsche"],
    ["DE89370400440532013000", true, "bekannte Beispiel-IBAN"],
    ["AT611904300234573201", true, "Österreich, andere Länge"],
    ["GB33BUKB20201555555555", true, "Buchstaben mitten im Rumpf"],
    ["DE02120300000000202015", false, "die letzten zwei Stellen vertauscht"],
    ["DE20120300000000202051", false, "Prüfziffer selbst verdreht"],
    ["DE02120300000000202052", false, "eine einzelne Stelle verändert"]
  ];
  for (const [iban, soll, was] of faelle) {
    const ist = f.ibanPruefzifferOk(iban);
    pruefe("IBAN " + iban + " — " + was, ist === soll, "erwartet " + soll + ", ist " + ist);
  }
}

console.log("2. Gesperrt ist der Grundzustand");

{
  const dom = baueDom();
  const f = ladeSchloss(dom, { einstellungen: KONTO }, () => true);
  f.fuelleKontofelder();
  f.setzeKontoSchloss(false);
  pruefe("alle vier Felder readonly",
    ["e-kontoinhaber", "e-iban", "e-bic", "e-bank"].every((id) => dom.felder[id].readOnly === true));
  pruefe("die Werte stehen trotzdem drin", dom.felder["e-iban"].value === KONTO.iban);
  pruefe("der Kasten ist nicht hervorgehoben", !dom.felder["konto-schloss"].classList.contains("offen"));
  pruefe("der Knopf lädt zum Freigeben ein", /freigeben/i.test(dom.felder["btn-konto-freigeben"].textContent));
}

console.log("3. Eine abgelehnte Rückfrage gibt nichts frei");

{
  const dom = baueDom();
  const f = ladeSchloss(dom, { einstellungen: KONTO }, () => false);
  f.fuelleKontofelder();
  f.setzeKontoSchloss(false);
  f.kontoFreigabeUmschalten();
  pruefe("nach Abbruch weiter gesperrt", dom.felder["e-iban"].readOnly === true && f.frei() === false);
}

console.log("4. Freigeben und wieder zusperren");

{
  const dom = baueDom();
  const f = ladeSchloss(dom, { einstellungen: KONTO }, () => true);
  f.fuelleKontofelder();
  f.setzeKontoSchloss(false);
  f.kontoFreigabeUmschalten();
  pruefe("freigegeben: beschreibbar", dom.felder["e-iban"].readOnly === false && f.frei() === true);
  pruefe("freigegeben: der Kasten wird hervorgehoben", dom.felder["konto-schloss"].classList.contains("offen"));
  pruefe("freigegeben: der Knopf bietet das Zurücknehmen an",
    /zur[uü]cknehmen/i.test(dom.felder["btn-konto-freigeben"].textContent));

  // ⚠️ Der eigentliche Punkt: eine angefangene Tipparbeit darf beim Zusperren
  // nicht stehen bleiben. Sonst sähe eine halb getippte IBAN aus wie die
  // gespeicherte.
  dom.felder["e-iban"].value = "DE00 HALB GETIPPT";
  f.kontoFreigabeUmschalten();
  pruefe("Zurücknehmen holt den gespeicherten Wert zurück", dom.felder["e-iban"].value === KONTO.iban,
    "steht: " + dom.felder["e-iban"].value);
  pruefe("Zurücknehmen sperrt wieder", dom.felder["e-iban"].readOnly === true && f.frei() === false);
}

console.log("5. Was im Quelltext festgenagelt sein muss");

// Diese sieben sind bewusst statisch: sie halten die Verdrahtung fest, die eine
// Verhaltensprüfung nicht sieht, weil sie am DOM und am Speicherweg hängt.
const FELDER = ["e-kontoinhaber", "e-iban", "e-bic", "e-bank"];
pruefe("die vier Felder tragen readonly schon im HTML",
  FELDER.every((id) => new RegExp("id=\"" + id + "\"[^>]*readonly").test(INDEX)),
  "sonst sind sie zwischen Seitenaufbau und erstem Zeichnen offen");

pruefe("der Freigabe-Knopf ist verdrahtet",
  /getElementById\("btn-konto-freigeben"\)\.addEventListener\("click", kontoFreigabeUmschalten\)/.test(APP_JS));

pruefe("fuelleVerwaltung sperrt nach jedem Neuzeichnen zu",
  /fuelleKontofelder\(\);\s*\n\s*setzeKontoSchloss\(false\);/.test(APP_JS),
  "sonst bliebe die Freigabe nach dem Speichern offen");

pruefe("beim Rechteverlust wird die Freigabe zurückgenommen",
  /raeumeWasNichtMehrErlaubtIst[\s\S]{0,3000}?setzeKontoSchloss\(false\);/.test(APP_JS),
  "sonst fände der nächste Nutzer am selben Browser die Felder offen vor");

pruefe("gesperrt gespeicherte Kontodaten kommen aus dem geladenen Stand, nicht aus der Maske",
  /kontoFrei\s*\n?\s*\?\s*\{[\s\S]{0,500}?wert\("e-iban"\)[\s\S]{0,500}?:\s*\{[\s\S]{0,400}?kontoAlt\.iban/.test(APP_JS),
  "sonst löscht ein Speichern nach dem Räumen die IBAN still weg");

pruefe("die Prüfziffer wird beim Speichern wirklich abgefragt",
  /if \(e\.iban && !ibanPruefzifferOk\(e\.iban\)\)/.test(APP_JS));

pruefe("eine geänderte Kontoverbindung wird vor dem Senden gegenübergestellt",
  /if \(kontoFrei\) \{[\s\S]{0,1600}?confirm\(/.test(APP_JS));

pruefe("der Merker liegt nicht in localStorage",
  !/localStorage[^\n]*[kK]onto/.test(APP_JS),
  "ein aufgehobener Merker bliebe auf einem geteilten Rechner hängen");

console.log("\n================================================================");
if (funde.length === 0) {
  console.log(ok.length + " Prüfungen ohne Befund.");
  console.log("Keine Befunde.");
} else {
  console.log(ok.length + " Prüfungen ohne Befund, " + funde.length + " BEFUNDE:\n");
  funde.forEach((f, i) => console.log((i + 1) + ". " + f.name + (f.detail ? "\n   " + f.detail : "")));
  process.exitCode = 1;
}
