// Prueft das Versandprotokoll am ECHTEN Worker-Code, nicht an einer Nachbildung:
// admin-worker.js wird als Modul geladen und nur fetch/Nextcloud werden gestubbt.
// (Muster: Aequivalenztest gegen den echten Code statt einer Attrappe.)
import fs from "fs";

const quelle = fs.readFileSync("E:/ToolsUebersicht/admin-worker.js", "utf8");

// Die Funktionen sind modul-lokal. Statt sie abzuschreiben, haengen wir einen
// Export-Block an eine Kopie an -- so laeuft der echte Code, Zeile fuer Zeile.
const exportBlock = `
export const __test = {
  versandNotieren, handleVersandProtokoll, normalisiereVersandDoc,
  VERSAND_URL, VERSAND_MAX, pushSenden, leerePushDoc
};
`;
import os from "os"; import path from "path";
const tmp = path.join(os.tmpdir(), "__pruef-versand-worker.mjs");
fs.writeFileSync(tmp, quelle + exportBlock, "utf8");

// ---- Nextcloud- und Brevo-Attrappe ----
const dateien = new Map();
let revZaehler = 0;
const echteFetch = globalThis.fetch;
const gesendeteMails = [];
let pushAufrufe = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || "GET").toUpperCase();

  if (u.includes("api.brevo.com")) {
    gesendeteMails.push(JSON.parse(opts.body));
    return new Response("{}", { status: 201 });
  }
  if (u.includes("your-storageshare.de")) {
    if (m === "GET") {
      if (!dateien.has(u)) return new Response("", { status: 404 });
      const eintrag = dateien.get(u);
      return new Response(eintrag.inhalt, { status: 200, headers: { ETag: eintrag.rev } });
    }
    if (m === "PUT") {
      const vorhanden = dateien.get(u);
      const ifMatch = (opts.headers && (opts.headers["If-Match"] || opts.headers["if-match"])) || null;
      if (ifMatch && vorhanden && ifMatch !== vorhanden.rev) {
        return new Response("", { status: 412 });
      }
      dateien.set(u, { inhalt: opts.body, rev: '"r' + (++revZaehler) + '"' });
      return new Response(null, { status: 204 });
    }
    if (m === "MKCOL" || m === "PROPFIND") return new Response(null, { status: 201 });
    return new Response(null, { status: 204 });
  }
  return echteFetch(url, opts);
};

const { __test } = await import("file://" + tmp);
const { versandNotieren, handleVersandProtokoll, normalisiereVersandDoc, VERSAND_URL, VERSAND_MAX } = __test;

const env = {
  NEXTCLOUD_URL: "https://nx88695.your-storageshare.de/",
  NEXTCLOUD_USERNAME: "admin",
  NEXTCLOUD_PASSWORD: "geheim",
  BREVO_API_KEY: "k"
};
const auth = "Basic " + btoa("admin:geheim");

let fehler = 0;
const pruefe = (name, bedingung, zusatz) => {
  if (bedingung) console.log("  [ok]   " + name);
  else { console.log("  [FEHL] " + name + (zusatz ? "  -> " + zusatz : "")); fehler++; }
};
const protokoll = () => normalisiereVersandDoc(JSON.parse(dateien.get(VERSAND_URL).inhalt));

console.log("== 1. Erster Eintrag legt die Datei an");
await versandNotieren(env, auth, {
  art: "push", quelle: "vereinsaufgabe-status", app: "vereinsaufgaben",
  anlass: "aufgaben", von: "uwe", anzahl: 0, ohne: 1,
  empfaenger: [], ohneEmpfaenger: ["michel"]
});
pruefe("Datei existiert", dateien.has(VERSAND_URL));
let doc = protokoll();
pruefe("genau ein Eintrag", doc.eintraege.length === 1, "sind " + doc.eintraege.length);
pruefe("art=push", doc.eintraege[0].art === "push");
pruefe("Nicht-Erreichte festgehalten", doc.eintraege[0].ohneEmpfaenger[0] === "michel");
pruefe("Kontoname, nicht Anzeigename", doc.eintraege[0].von === "uwe");

console.log("== 2. Kein Inhalt im Eintrag (die zentrale Zusage)");
const roh = JSON.stringify(doc.eintraege[0]);
pruefe("kein Feld titel/betreff/text", !/titel|betreff|subject|text/i.test(roh), roh);

console.log("== 3. Neuester Eintrag steht vorn");
await versandNotieren(env, auth, {
  art: "mail", quelle: "vereinsaufgabe-anlegen", app: "vereinsaufgaben",
  von: "michel", anzahl: 2, ohne: 0, empfaenger: ["uwe", "anna"]
});
doc = protokoll();
pruefe("zwei Eintraege", doc.eintraege.length === 2);
pruefe("neuester vorn", doc.eintraege[0].quelle === "vereinsaufgabe-anlegen");

console.log("== 4. Deckel greift");
for (let i = 0; i < VERSAND_MAX + 20; i++) {
  await versandNotieren(env, auth, { art: "mail", quelle: "fuelltest", app: "x", anzahl: 1 });
}
doc = protokoll();
pruefe("nie mehr als VERSAND_MAX", doc.eintraege.length === VERSAND_MAX, "sind " + doc.eintraege.length);

console.log("== 5. Empfaengerliste ist gedeckelt");
await versandNotieren(env, auth, {
  art: "mail", quelle: "viele", app: "x", anzahl: 60,
  empfaenger: Array.from({ length: 60 }, (_, i) => "u" + i)
});
pruefe("hoechstens 25 Namen", protokoll().eintraege[0].empfaenger.length === 25);

console.log("== 6. Ein Fehler beim Schreiben kippt nichts");
const merk = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Nextcloud weg"); };
let geworfen = false;
try { await versandNotieren(env, auth, { art: "mail", quelle: "x", app: "x" }); }
catch (e) { geworfen = true; }
globalThis.fetch = merk;
pruefe("versandNotieren wirft nie", !geworfen);

console.log("== 7. Leseaktion: nur globale Admins");
const request = new Request("https://x/", { method: "POST" });
const corsHeaders = {};
// getVerifiedSession stubben ist nicht moeglich (modul-lokal) -- stattdessen
// pruefen wir die Antwort ohne gueltige Sitzung: sie MUSS 401 sein.
const antwort = await handleVersandProtokoll(request, env, auth, corsHeaders);
pruefe("ohne Anmeldung 401", antwort.status === 401, "war " + antwort.status);

fs.unlinkSync(tmp);
console.log(fehler === 0 ? "\nALLES GRUEN" : "\n" + fehler + " FEHLER");
process.exit(fehler === 0 ? 0 : 1);
