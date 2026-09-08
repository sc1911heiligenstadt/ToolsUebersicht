// Prueft die Tabellen-Ausgabe mit dem ECHTEN Quelltext aus app.js (die drei
// Funktionen werden aus der Datei geschnitten und ausgefuehrt, nicht nachgebaut).
import fs from "fs";
import vm from "vm";

const app = fs.readFileSync("E:/ToolsUebersicht/app.js", "utf8");

function schneide(startMarke) {
  const i = app.indexOf(startMarke);
  if (i < 0) throw new Error("nicht gefunden: " + startMarke);
  // Bis zur naechsten Zeile, die genau "}" ist.
  const ende = app.indexOf("\n}\n", i);
  if (ende < 0) throw new Error("Ende nicht gefunden: " + startMarke);
  return app.slice(i, ende + 2);
}

const teile = [
  schneide("function escapeHtml("),
  schneide("function versandDatum("),
  schneide("function versandTabelleZeichnen("),
  app.slice(app.indexOf("const VERSAND_QUELLEN = {"), app.indexOf("};", app.indexOf("const VERSAND_QUELLEN = {")) + 2)
];

// Winziger DOM-Ersatz: nur was die Funktion anfasst.
const knoten = {};
const mach = (id) => (knoten[id] = { id, textContent: "", innerHTML: "", value: "", style: {} });
["admin-versand-status", "admin-versand-liste", "admin-versand-art", "admin-versand-app"].forEach(mach);

const sandbox = {
  document: { getElementById: (id) => knoten[id] || null },
  console,
  versandEintraege: [],
  versandGesamt: 0
};
vm.createContext(sandbox);
vm.runInContext(teile.join("\n\n"), sandbox);

let fehler = 0;
const pruefe = (n, b, z) => {
  if (b) console.log("  [ok]   " + n);
  else { console.log("  [FEHL] " + n + (z ? "  -> " + z : "")); fehler++; }
};

const beispiele = [
  { id: "1", am: "2026-09-08T18:30:00.000Z", art: "push", quelle: "vereinsaufgabe-status",
    app: "vereinsaufgaben", vonName: "Uwe M.", anzahl: 0, ohne: 1,
    empfaenger: [], ohneEmpfaenger: ["Michel B."] },
  { id: "2", am: "2026-09-08T17:00:00.000Z", art: "mail", quelle: "vereinsaufgabe-anlegen",
    app: "vereinsaufgaben", vonName: "Michel B.", anzahl: 2, ohne: 0,
    empfaenger: ["Uwe M.", "Anna K."], ohneEmpfaenger: [] },
  { id: "3", am: "2026-09-07T06:00:00.000Z", art: "mail", quelle: "busplan-erinnerung",
    app: "busplan", vonName: "", anzahl: 4, ohne: 0, empfaenger: [], ohneEmpfaenger: [] }
];

console.log("== 1. Leerer Bestand");
sandbox.versandEintraege = [];
sandbox.versandTabelleZeichnen();
pruefe("sagt, dass nichts da ist", knoten["admin-versand-status"].textContent.includes("noch nichts"));
pruefe("keine Tabelle", knoten["admin-versand-liste"].innerHTML === "");

console.log("== 2. Drei Vorgaenge, kein Filter");
sandbox.versandEintraege = beispiele;
sandbox.versandGesamt = 12;
sandbox.versandTabelleZeichnen();
let html = knoten["admin-versand-liste"].innerHTML;
pruefe("drei Zeilen", (html.match(/<tr>/g) || []).length === 4, String((html.match(/<tr>/g) || []).length));
pruefe("Klartext statt Kennung", html.includes("Aufgabe: Status ge") && !html.includes("vereinsaufgabe-status"));
pruefe("Nicht-Erreichte hervorgehoben", html.includes('class="versand-ohne"'));
pruefe("Name des Nicht-Erreichten steht da", html.includes("Michel B."));
pruefe("automatischer Lauf heisst 'automatisch'", html.includes("automatisch"));
pruefe("Scroll-Container da (Handy)", html.includes("pn-tabelle-wrap"));
pruefe("Zaehler nennt beide Zahlen", knoten["admin-versand-status"].textContent.includes("3 von 3")
  && knoten["admin-versand-status"].textContent.includes("12"));

console.log("== 3. Filter 'nur Push'");
knoten["admin-versand-art"].value = "push";
sandbox.versandTabelleZeichnen();
html = knoten["admin-versand-liste"].innerHTML;
pruefe("nur eine Zeile", (html.match(/<tr>/g) || []).length === 2);
pruefe("nur Push", html.includes(">Push<") && !html.includes(">Mail<"));

console.log("== 4. Filter, auf den nichts passt");
knoten["admin-versand-app"].value = "busplan";
sandbox.versandTabelleZeichnen();
pruefe("sagt es statt leer zu bleiben", knoten["admin-versand-status"].textContent.includes("Kein Versand passt"));
pruefe("Tabelle geraeumt", knoten["admin-versand-liste"].innerHTML === "");

console.log("== 5. Boesartiger Name wird entschaerft");
knoten["admin-versand-art"].value = "";
knoten["admin-versand-app"].value = "";
sandbox.versandEintraege = [{
  id: "x", am: "2026-09-08T10:00:00.000Z", art: "mail", quelle: "notify-user",
  app: "ToolsUebersicht", vonName: '<img src=x onerror="alert(1)">', anzahl: 1, ohne: 0,
  empfaenger: ["<script>bad()</script>"], ohneEmpfaenger: []
}];
sandbox.versandTabelleZeichnen();
html = knoten["admin-versand-liste"].innerHTML;
pruefe("kein rohes <img", !html.includes("<img"));
pruefe("kein rohes <script", !html.includes("<script"));

console.log("== 6. Kaputtes Datum kippt nichts");
sandbox.versandEintraege = [{ id: "y", am: "unsinn", art: "mail", quelle: "", app: "",
  vonName: "", anzahl: 0, ohne: 0, empfaenger: [], ohneEmpfaenger: [] }];
sandbox.versandTabelleZeichnen();
pruefe("zeigt einen Strich", knoten["admin-versand-liste"].innerHTML.includes("\u2014"));

console.log(fehler === 0 ? "\nALLES GRUEN" : "\n" + fehler + " FEHLER");
process.exit(fehler === 0 ? 0 : 1);
