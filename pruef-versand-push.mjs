// Der eigentliche Fall, wegen dem das Protokoll gebaut wurde: eine Push, die
// niemanden erreicht, MUSS im Protokoll stehen -- vorher war sie unsichtbar.
// Laeuft gegen den echten pushSenden aus admin-worker.js.
import fs from "fs";

const quelle = fs.readFileSync("E:/ToolsUebersicht/admin-worker.js", "utf8");
import os from "os"; import path from "path";
const tmp = path.join(os.tmpdir(), "__pruef-versand-push.mjs");
fs.writeFileSync(tmp, quelle + `
export const __test = { pushSenden, versandNotieren, normalisiereVersandDoc, VERSAND_URL, PUSH_ABOS_URL, jsonCache };
`, "utf8");

const dateien = new Map();
let rev = 0;
const echteFetch = globalThis.fetch;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || "GET").toUpperCase();
  if (u.includes("your-storageshare.de")) {
    if (m === "GET") {
      if (!dateien.has(u)) return new Response("", { status: 404 });
      const e = dateien.get(u);
      return new Response(e.inhalt, { status: 200, headers: { ETag: e.rev } });
    }
    if (m === "PUT") {
      dateien.set(u, { inhalt: opts.body, rev: '"r' + (++rev) + '"' });
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 201 });
  }
  return echteFetch(url, opts);
};

const { __test } = await import("file://" + tmp);
const { pushSenden, normalisiereVersandDoc, VERSAND_URL, PUSH_ABOS_URL, jsonCache } = __test;

let anPushWorker = [];
const env = {
  NEXTCLOUD_URL: "https://nx88695.your-storageshare.de/",
  NEXTCLOUD_USERNAME: "admin",
  NEXTCLOUD_PASSWORD: "geheim",
  PUSH_SHARED_SECRET: "s",
  PUSH: {
    fetch: async (_u, o) => {
      anPushWorker.push(JSON.parse(o.body));
      return new Response(JSON.stringify({ tot: [] }), { status: 200 });
    }
  }
};
const auth = "Basic " + btoa("admin:geheim");

let fehler = 0;
const pruefe = (n, b, z) => {
  if (b) console.log("  [ok]   " + n);
  else { console.log("  [FEHL] " + n + (z ? "  -> " + z : "")); fehler++; }
};
const letzterEintrag = () => {
  const d = dateien.get(VERSAND_URL);
  if (!d) return null;
  return normalisiereVersandDoc(JSON.parse(d.inhalt)).eintraege[0];
};

// Ausgangslage wie bei Michel: uwe hat ein Geraet, michel keines.
dateien.set(PUSH_ABOS_URL, {
  rev: '"r0"',
  inhalt: JSON.stringify({
    version: 1,
    anlaesse: {},
    abos: { uwe: [{ id: "a1", endpoint: "https://fcm.example/1", p256dh: "p", auth: "a" }] }
  })
});

console.log("== 1. Michel hat KEIN Geraet -- die Push erreicht ihn nicht");
// pushSenden ohne ctx gibt das Promise zurueck (siehe Ende der Funktion).
await pushSenden(env, auth, null, ["michel"], "aufgaben",
  "Eine Aufgabe wurde als erledigt gemeldet",
  { quelle: "vereinsaufgabe-status", von: "uwe" });
let e = letzterEintrag();
pruefe("es gibt trotzdem einen Eintrag", !!e);
pruefe("art=push", e && e.art === "push");
pruefe("quelle durchgereicht", e && e.quelle === "vereinsaufgabe-status", e && e.quelle);
pruefe("app aus dem Anlass-Ziel", e && e.app === "vereinsaufgaben", e && e.app);
pruefe("zugestellt = 0", e && e.anzahl === 0);
pruefe("nicht erreicht = michel", e && e.ohneEmpfaenger.join() === "michel", e && JSON.stringify(e.ohneEmpfaenger));
pruefe("nichts an den Push-Worker geschickt", anPushWorker.length === 0);

console.log("== 2. Uwe hat ein Geraet -- die Push geht raus und wird gezaehlt");
anPushWorker = []; jsonCache.clear();
await pushSenden(env, auth, null, ["uwe", "michel"], "aufgaben",
  "Dir wurde eine neue Aufgabe zugewiesen",
  { quelle: "vereinsaufgabe-anlegen", von: "michel" });
e = letzterEintrag();
pruefe("Push-Worker genau einmal beauftragt", anPushWorker.length === 1);
pruefe("zugestellt = 1 (Personen, nicht Geraete)", e && e.anzahl === 1, e && String(e.anzahl));
pruefe("erreicht = uwe", e && e.empfaenger.join() === "uwe", e && JSON.stringify(e.empfaenger));
pruefe("nicht erreicht = michel", e && e.ohneEmpfaenger.join() === "michel");

console.log("== 3. Schalter aus zaehlt genauso als 'nicht erreicht'");
dateien.set(PUSH_ABOS_URL, {
  rev: '"r0"',
  inhalt: JSON.stringify({
    version: 1,
    anlaesse: { uwe: { aufgaben: false } },
    abos: { uwe: [{ id: "a1", endpoint: "https://fcm.example/1", p256dh: "p", auth: "a" }] }
  })
});
anPushWorker = []; jsonCache.clear();
await pushSenden(env, auth, null, ["uwe"], "aufgaben", "x",
  { quelle: "vereinsaufgabe-status", von: "michel" });
e = letzterEintrag();
pruefe("nichts verschickt", anPushWorker.length === 0);
pruefe("uwe steht als nicht erreicht", e && e.ohneEmpfaenger.join() === "uwe", e && JSON.stringify(e.ohneEmpfaenger));

console.log("== 4. Kein Inhalt im Protokoll");
pruefe("kein Nachrichtentext gespeichert",
  !JSON.stringify(e).toLowerCase().includes("gemeldet") && !JSON.stringify(e).includes("zugewiesen"),
  JSON.stringify(e));

fs.unlinkSync(tmp);
console.log(fehler === 0 ? "\nALLES GRUEN" : "\n" + fehler + " FEHLER");
process.exit(fehler === 0 ? 0 : 1);
