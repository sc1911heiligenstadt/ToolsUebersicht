// Prueft die Umfragen am ECHTEN Worker-Code, nicht an einer Nachbildung:
// admin-worker.js wird als Modul geladen, nur fetch/Nextcloud werden gestubbt.
// (Muster: pruef-versandprotokoll.mjs.)
//
// Der Schwerpunkt liegt auf den vier Zusagen, die sich im Client NICHT halten
// lassen und die beim Umbauen als Erstes brechen:
//   1. Bei GEHEIM steht der Nutzername nie an der Antwort.
//   2. Wer das Ergebnis nicht sehen darf, bekommt keine Antworten geliefert.
//   3. Freitexte gehen nur an Bearbeitende oder nach ausdruecklicher Freigabe.
//   4. Der oeffentliche Link-Token geht nur an Administrierende.
//
// Aufruf:  node pruef-umfragen.mjs
//          node pruef-umfragen.mjs --selbsttest   (muss gegen HEAD FEHLSCHLAGEN)
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";

const selbsttest = process.argv.includes("--selbsttest");
const quelle = selbsttest
  ? execSync("git -C E:/ToolsUebersicht show HEAD:admin-worker.js", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  : fs.readFileSync("E:/ToolsUebersicht/admin-worker.js", "utf8");

const exportBlock = `
export const __test = {
  handleUmLoad, handleUmSpeichern, handleUmStatus, handleUmFreigeben,
  handleUmFreigabeBitten, handleUmAntworten, handleUmAntwortZuruecknehmen,
  handleUmFreitextFreigeben, handleUmLoeschen, handleUmErinnern,
  handleUmOeffentlichInfo, handleUmOeffentlichAbsenden, handleUmOeffentlichBild,
  umWertePruefen, umErgebnisSichtbar, umNormalisiere, umLeer,
  UMFRAGEN_URL, signToken, jsonCache
};
`;
const tmp = path.join(os.tmpdir(), "__pruef-umfragen-worker.mjs");
fs.writeFileSync(tmp, quelle + exportBlock, "utf8");

// ---------------------------------------------------------------------------
// Nextcloud-Attrappe
// ---------------------------------------------------------------------------
const dateien = new Map();
let revZaehler = 0;
const echteFetch = globalThis.fetch;
let letzterBildAbruf = null;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = (opts.method || "GET").toUpperCase();
  if (u.includes("api.brevo.com")) return new Response("{}", { status: 201 });
  if (u.includes("your-storageshare.de")) {
    if (u.includes("/Umfragen/dateien/")) {
      if (m === "GET") {
        letzterBildAbruf = u;
        return new Response("BILDBYTES", { status: 200, headers: { "Content-Type": "image/png" } });
      }
      return new Response(null, { status: 204 });
    }
    if (m === "GET") {
      if (!dateien.has(u)) return new Response("", { status: 404 });
      const e = dateien.get(u);
      return new Response(e.inhalt, { status: 200, headers: { ETag: e.rev } });
    }
    if (m === "PUT") {
      const vorhanden = dateien.get(u);
      const ifMatch = (opts.headers && (opts.headers["If-Match"] || opts.headers["if-match"])) || null;
      if (ifMatch && vorhanden && ifMatch !== vorhanden.rev) return new Response("", { status: 412 });
      dateien.set(u, { inhalt: opts.body, rev: '"r' + (++revZaehler) + '"' });
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 204 });
  }
  return echteFetch(url, opts);
};

const { __test } = await import("file://" + tmp);
const T = __test;

// ---------------------------------------------------------------------------
// Umgebung, Nutzer, Rechte
// ---------------------------------------------------------------------------
const NUTZER_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/nutzer.json";
const SICHT_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/sichtbarkeit.json";

const env = {
  NEXTCLOUD_URL: SICHT_URL,
  NEXTCLOUD_NUTZER_URL: NUTZER_URL,
  NEXTCLOUD_USERNAME: "admin",
  NEXTCLOUD_PASSWORD: "geheim",
  SESSION_SECRET: "test-geheimnis",
  BREVO_API_KEY: "k"
};
const auth = "Basic " + btoa("admin:geheim");

function setzeDatei(url, obj) {
  dateien.set(url, { inhalt: JSON.stringify(obj), rev: '"r' + (++revZaehler) + '"' });
}

// vier Rollen: admin (administriert), bearbeiter, seher, fremd (andere Gruppe)
setzeDatei(NUTZER_URL, {
  version: 1,
  users: {
    chef:       { username: "chef",       vorname: "Chef",  nachname: "Admin", isAdmin: false, passwordHash: "x", art: "personal" },
    bearbeiter: { username: "bearbeiter", vorname: "Bea",   nachname: "Arbeit", isAdmin: false, passwordHash: "x", art: "personal" },
    seher:      { username: "seher",      vorname: "Sig",   nachname: "Seher", isAdmin: false, passwordHash: "x", art: "personal" },
    fremd:      { username: "fremd",      vorname: "Fred",  nachname: "Fremd", isAdmin: false, passwordHash: "x", art: "personal" }
  },
  groups: {
    verwaltung: { id: "verwaltung", name: "Verwaltung", memberUsernames: ["chef"] },
    redaktion:  { id: "redaktion",  name: "Redaktion",  memberUsernames: ["bearbeiter"] },
    trainer:    { id: "trainer",    name: "Trainer",    memberUsernames: ["bearbeiter", "seher"] },
    andere:     { id: "andere",     name: "Andere",     memberUsernames: ["fremd"] }
  }
});
// Sehen: alle Angemeldeten (leere groupIds). Damit hat auch "fremd" Zugriff auf
// das WERKZEUG — und genau dadurch prueft Abschnitt 4 wirklich die ZIELGRUPPE
// der Umfrage und nicht bloss die Tool-Sichtbarkeit.
setzeDatei(SICHT_URL, {
  version: 1,
  tools: {
    umfragen: { visible: true, groupIds: [], editGroupIds: ["redaktion"], adminGroupIds: ["verwaltung"] }
  }
});

// ⚠️ `exp` ist Pflicht — verifyToken verwirft jedes Token ohne Ablaufzeit, und
// dann sieht JEDER Handler wie ein kaputtes Rechte-Gate aus (401 statt 403).
async function tokenFuer(username) {
  const iat = Math.floor(Date.now() / 1000);
  return T.signToken({ username, isAdmin: false, iat, exp: iat + 3600 }, env.SESSION_SECRET);
}
const tokens = {};
for (const n of ["chef", "bearbeiter", "seher", "fremd"]) tokens[n] = await tokenFuer(n);

// Ein Request-Objekt mit Bearer-Token und (optional) Client-IP.
function req(user, ip) {
  const h = new Headers();
  if (user) h.set("Authorization", "Bearer " + tokens[user]);
  if (ip) h.set("CF-Connecting-IP", ip);
  return new Request("https://w/", { method: "POST", headers: h });
}
const cors = {};

// ⚠️ jsonCache ueberlebt im Modul-Scope. Ohne Leeren liest der naechste Aufruf
// den Stand von vor der Aenderung und die Pruefung ist wertlos.
function frisch() { T.jsonCache.clear(); }

async function ruf(fn, user, body, ip) {
  frisch();
  const r = fn.length >= 5
    ? await fn(req(user, ip), body, env, auth, cors, { waitUntil: () => {} })
    : await fn(req(user, ip), env, auth, cors);
  let daten = null;
  try { daten = await r.clone().json(); } catch (_) { daten = null; }
  return { status: r.status, daten };
}

function doc() { return T.umNormalisiere(JSON.parse(dateien.get(T.UMFRAGEN_URL).inhalt)); }

let fehler = 0;
const pruefe = (name, ok, zusatz) => {
  if (ok) console.log("  [ok]   " + name);
  else { console.log("  [FEHL] " + name + (zusatz ? "  -> " + zusatz : "")); fehler++; }
};

// ---------------------------------------------------------------------------
console.log("== 1. Anlegen: nur mit Bearbeiten-Recht, Zustand immer Entwurf");
// ---------------------------------------------------------------------------
const vorlage = (extra = {}) => Object.assign({
  titel: "Maskottchen",
  beschreibung: "Wie soll es heissen?",
  intern: true, zielgruppen: ["trainer"], geheim: false,
  willExtern: true, externName: "optional",
  ergebnisSicht: "nachEnde", endeAm: "",
  fragen: [
    { id: "f1", text: "Tier oder Figur?", art: "einzel", pflicht: true,
      optionen: [{ id: "o1", text: "Tier" }, { id: "o2", text: "Figur" }] },
    { id: "f2", text: "Dein Vorschlag", art: "text", pflicht: false, optionen: [] },
    { id: "f3", text: "Mehrere?", art: "mehrfach", pflicht: false,
      optionen: [{ id: "m1", text: "A" }, { id: "m2", text: "B" }] }
  ]
}, extra);

let r = await ruf(T.handleUmSpeichern, "seher", { umfrage: vorlage() });
pruefe("Nur-Seher darf nicht anlegen (403)", r.status === 403, "war " + r.status);

r = await ruf(T.handleUmSpeichern, "bearbeiter", { umfrage: vorlage() });
pruefe("Bearbeiter darf anlegen (200)", r.status === 200, "war " + r.status);
const uid = r.daten.id;
pruefe("Zustand ist Entwurf", doc().umfragen[0].status === "entwurf");
pruefe("extern ist AUS, obwohl willExtern gesetzt war", doc().umfragen[0].extern === false);
pruefe("kein Token vergeben", !doc().umfragen[0].token);

r = await ruf(T.handleUmSpeichern, "bearbeiter", { umfrage: vorlage({ intern: false, willExtern: false }) });
pruefe("weder intern noch extern wird abgelehnt", r.status === 400, "war " + r.status);

r = await ruf(T.handleUmSpeichern, "bearbeiter", {
  umfrage: vorlage({ fragen: [{ id: "x", text: "Nur eine Wahl", art: "einzel", pflicht: true, optionen: [{ id: "a", text: "A" }] }] })
});
pruefe("Auswahlfrage mit nur einer Moeglichkeit abgelehnt", r.status === 400, "war " + r.status);

// ---------------------------------------------------------------------------
console.log("== 2. Freigabe nach aussen: ausdruecklich Administrieren");
// ---------------------------------------------------------------------------
r = await ruf(T.handleUmFreigeben, "bearbeiter", { id: uid, frei: true });
pruefe("Bearbeiter darf NICHT freigeben (403)", r.status === 403, "war " + r.status);
pruefe("weiterhin kein Token vergeben", !doc().umfragen[0].token);

r = await ruf(T.handleUmFreigabeBitten, "bearbeiter", { id: uid });
pruefe("Bearbeiter darf um Freigabe bitten", r.status === 200, "war " + r.status);
pruefe("Bitte ist vermerkt (Gegenstueck zum Gate)", doc().umfragen[0].freigabeAngefragt === true);

r = await ruf(T.handleUmFreigeben, "chef", { id: uid, frei: true });
pruefe("Administrator darf freigeben", r.status === 200, "war " + r.status);
const linkToken = doc().umfragen[0].token;
pruefe("Token vergeben, lang genug", !!linkToken && linkToken.length >= 20, String(linkToken));
pruefe("Bitte ist danach erledigt", doc().umfragen[0].freigabeAngefragt === false);

const altToken = linkToken;
r = await ruf(T.handleUmFreigeben, "chef", { id: uid, frei: true, neu: true });
pruefe("Erneuern liefert einen ANDEREN Token", doc().umfragen[0].token !== altToken);
const token2 = doc().umfragen[0].token;

// ---------------------------------------------------------------------------
console.log("== 3. Der Link-Token verlaesst den Server nur Richtung Verwaltung");
// ---------------------------------------------------------------------------
await ruf(T.handleUmStatus, "bearbeiter", { id: uid, status: "offen" });
pruefe("Umfrage ist offen", doc().umfragen[0].status === "offen");

r = await ruf(T.handleUmLoad, "chef");
pruefe("Administrator sieht den Token", r.daten.umfragen[0].token === token2);
r = await ruf(T.handleUmLoad, "bearbeiter");
pruefe("Bearbeiter sieht den Token NICHT", r.daten.umfragen[0].token === undefined);
r = await ruf(T.handleUmLoad, "seher");
pruefe("Seher sieht den Token NICHT", r.daten.umfragen[0].token === undefined);
pruefe("Token steht in KEINER Antwort an den Bearbeiter",
  !JSON.stringify((await ruf(T.handleUmLoad, "bearbeiter")).daten).includes(token2));

// ---------------------------------------------------------------------------
console.log("== 4. Zielgruppe: wer nicht dazugehoert, sieht nichts");
// ---------------------------------------------------------------------------
r = await ruf(T.handleUmLoad, "fremd");
pruefe("Fremde Gruppe bekommt keine Umfrage geliefert", r.daten.umfragen.length === 0,
  "sind " + r.daten.umfragen.length);
r = await ruf(T.handleUmAntworten, "fremd", { id: uid, werte: { f1: "o1" } });
pruefe("Fremde Gruppe darf nicht antworten (403)", r.status === 403, "war " + r.status);

// ---------------------------------------------------------------------------
console.log("== 5. Werte-Pruefung: der Client ist nicht die Schranke");
// ---------------------------------------------------------------------------
r = await ruf(T.handleUmAntworten, "seher", { id: uid, werte: { f1: "gibtsnicht" } });
pruefe("Erfundene Antwort-Id + Pflichtfrage -> 400", r.status === 400, "war " + r.status);

r = await ruf(T.handleUmAntworten, "seher", { id: uid, werte: {} });
pruefe("Pflichtfrage fehlt -> 400", r.status === 400, "war " + r.status);

r = await ruf(T.handleUmAntworten, "seher", {
  id: uid, werte: { f1: "o1", f2: "Kicki", f3: ["m1", "m1", "m2", "erfunden"] }
});
pruefe("Nur-Seher DARF antworten (Selbstantwort)", r.status === 200, "war " + r.status);
let a = doc().umfragen[0].antworten[0];
pruefe("Mehrfachwahl dedupliziert und gefiltert",
  JSON.stringify(a.werte.f3) === JSON.stringify(["m1", "m2"]), JSON.stringify(a.werte.f3));
pruefe("Herkunft intern", a.herkunft === "intern");
pruefe("Namentliche Umfrage: Nutzername steht an der Antwort", a.username === "seher");

// ---------------------------------------------------------------------------
console.log("== 6. Ergebnis-Sicht: nachEnde haelt Antworten zurueck");
// ---------------------------------------------------------------------------
r = await ruf(T.handleUmLoad, "seher");
let u = r.daten.umfragen[0];
pruefe("Seher: Feld antworten FEHLT ganz (nicht leer)", !("antworten" in u), JSON.stringify(Object.keys(u)));
pruefe("Seher sieht nur die Zahl", u.stimmen === 1);
pruefe("Seher weiss, dass er geantwortet hat", u.habeGeantwortet === true);
pruefe("kein fremder Nutzername in der ganzen Antwort",
  !JSON.stringify(r.daten.umfragen).includes("\"username\""));

r = await ruf(T.handleUmLoad, "bearbeiter");
pruefe("Bearbeiter bekommt die Antworten", Array.isArray(r.daten.umfragen[0].antworten));

// ---------------------------------------------------------------------------
console.log("== 7. Freitext: nie automatisch, erst nach Freigabe");
// ---------------------------------------------------------------------------
await ruf(T.handleUmStatus, "bearbeiter", { id: uid, status: "geschlossen" });
r = await ruf(T.handleUmLoad, "seher");
u = r.daten.umfragen[0];
pruefe("nach Ende sieht der Seher Antworten", Array.isArray(u.antworten));
pruefe("Freitext NICHT dabei, solange nicht freigegeben",
  u.antworten.every((x) => x.werte.f2 === undefined), JSON.stringify(u.antworten));
pruefe("die Auswahlfrage kommt sehr wohl an", u.antworten[0].werte.f1 === "o1");

const antwortId = doc().umfragen[0].antworten[0].id;
r = await ruf(T.handleUmFreitextFreigeben, "seher", { id: uid, freigaben: { f2: [antwortId] } });
pruefe("Nur-Seher darf nicht freigeben (403)", r.status === 403, "war " + r.status);
r = await ruf(T.handleUmFreitextFreigeben, "bearbeiter", { id: uid, freigaben: { f2: [antwortId, "erfunden"] } });
pruefe("Bearbeiter darf freigeben", r.status === 200, "war " + r.status);
pruefe("erfundene Antwort-Id faellt aus der Freigabe",
  JSON.stringify(doc().umfragen[0].freitextFreigabe.f2) === JSON.stringify([antwortId]),
  JSON.stringify(doc().umfragen[0].freitextFreigabe.f2));

r = await ruf(T.handleUmLoad, "seher");
pruefe("nach Freigabe sieht der Seher den Freitext",
  r.daten.umfragen[0].antworten[0].werte.f2 === "Kicki");

// ---------------------------------------------------------------------------
console.log("== 8. Struktur ist nach der ersten Antwort eingefroren");
// ---------------------------------------------------------------------------
r = await ruf(T.handleUmSpeichern, "bearbeiter", {
  umfrage: vorlage({ id: uid, fragen: [{ id: "f1", text: "Tier oder Figur?", art: "einzel", pflicht: true, optionen: [{ id: "o1", text: "Tier" }, { id: "o2", text: "Figur" }, { id: "o3", text: "Neu dazu" }] }] })
});
pruefe("nachtraeglich eine Antwortmoeglichkeit -> 409", r.status === 409, "war " + r.status);
r = await ruf(T.handleUmSpeichern, "bearbeiter", { umfrage: vorlage({ id: uid, titel: "Anderer Titel" }) });
pruefe("Titel bleibt aenderbar", r.status === 200, "war " + r.status);
pruefe("Titel ist angekommen", doc().umfragen[0].titel === "Anderer Titel");

// ---------------------------------------------------------------------------
console.log("== 9. Geheim: Name und Inhalt bleiben getrennt");
// ---------------------------------------------------------------------------
r = await ruf(T.handleUmSpeichern, "bearbeiter", {
  umfrage: vorlage({ titel: "Zufriedenheit", geheim: true, willExtern: false, ergebnisSicht: "verwaltung",
    fragen: [{ id: "g1", text: "Wie zufrieden?", art: "note", pflicht: true, optionen: [] }] })
});
const gid = r.daten.id;
await ruf(T.handleUmStatus, "bearbeiter", { id: gid, status: "offen" });
r = await ruf(T.handleUmAntworten, "seher", { id: gid, werte: { g1: "2" } });
pruefe("geheime Antwort angenommen", r.status === 200, "war " + r.status);

const g = doc().umfragen.find((x) => x.id === gid);
pruefe("GESPEICHERT: kein Nutzername an der Antwort", g.antworten[0].username === undefined,
  JSON.stringify(g.antworten[0]));
pruefe("GESPEICHERT: Teilnehmer getrennt vermerkt", g.teilnehmer[0].username === "seher");

r = await ruf(T.handleUmLoad, "chef");
const gsicht = r.daten.umfragen.find((x) => x.id === gid);
pruefe("AUSGELIEFERT: auch der Administrator bekommt keinen Namen",
  gsicht.antworten.every((x) => !x.username && !x.name), JSON.stringify(gsicht.antworten));

r = await ruf(T.handleUmAntworten, "seher", { id: gid, werte: { g1: "5" } });
pruefe("geheime Stimme laesst sich NICHT aendern (409)", r.status === 409, "war " + r.status);
r = await ruf(T.handleUmAntwortZuruecknehmen, "seher", { id: gid });
pruefe("geheime Stimme laesst sich NICHT zuruecknehmen (409)", r.status === 409, "war " + r.status);
pruefe("die Note steht unveraendert", doc().umfragen.find((x) => x.id === gid).antworten[0].werte.g1 === "2");

r = await ruf(T.handleUmLoad, "seher");
pruefe("bei ergebnisSicht=verwaltung bekommt der Seher keine Antworten",
  !("antworten" in r.daten.umfragen.find((x) => x.id === gid)));

// ⚠️ Die ZWEITE Sicherung. handleUmAntworten schreibt bei geheim gar keinen
// Nutzernamen — die Weiche in umAntwortProjektion ist deshalb auf dem normalen
// Weg totes Holz und faellt bei einer Mutationsprobe nicht auf. Sie zaehlt aber
// fuer den Fall, dass doch einmal einer in der Datei landet: eine von Hand
// bearbeitete Nextcloud-Datei, oder eine Umfrage, die nach den ersten Antworten
// auf geheim umgestellt wurde. Deshalb wird hier einer untergeschoben.
{
  const roh = JSON.parse(dateien.get(T.UMFRAGEN_URL).inhalt);
  const gg = roh.umfragen.find((x) => x.id === gid);
  gg.antworten[0].username = "seher";
  gg.antworten[0].name = "Sig Seher";
  gg.ergebnisSicht = "nachStimme";
  setzeDatei(T.UMFRAGEN_URL, roh);
  const x = await ruf(T.handleUmLoad, "chef");
  const sicht = x.daten.umfragen.find((y) => y.id === gid);
  pruefe("untergeschobener Name wird beim Ausliefern entfernt",
    sicht.antworten.every((y) => !y.username && !y.name), JSON.stringify(sicht.antworten));
  pruefe("der Name steht in der GANZEN Antwort nicht mehr",
    !JSON.stringify(sicht).includes("Sig Seher"));
}

// ---------------------------------------------------------------------------
console.log("== 10. Namentlich: aendern und zuruecknehmen geht");
// ---------------------------------------------------------------------------
r = await ruf(T.handleUmSpeichern, "bearbeiter", {
  umfrage: vorlage({ titel: "Mitfahrt", geheim: false, willExtern: false, ergebnisSicht: "nachStimme",
    fragen: [{ id: "n1", text: "Faehrst du mit?", art: "janein", pflicht: true, optionen: [] }] })
});
const nid = r.daten.id;
await ruf(T.handleUmStatus, "bearbeiter", { id: nid, status: "offen" });
await ruf(T.handleUmAntworten, "seher", { id: nid, werte: { n1: "ja" } });
r = await ruf(T.handleUmAntworten, "seher", { id: nid, werte: { n1: "nein" } });
pruefe("namentliche Stimme laesst sich aendern", r.status === 200 && r.daten.geaendert === true);
let nd = doc().umfragen.find((x) => x.id === nid);
pruefe("es bleibt EINE Antwort", nd.antworten.length === 1, "sind " + nd.antworten.length);
pruefe("der neue Wert steht drin", nd.antworten[0].werte.n1 === "nein");
r = await ruf(T.handleUmAntworten, "seher", { id: nid, werte: { n1: "vielleicht" } });
pruefe("unbekannter Ja/Nein-Wert -> 400", r.status === 400, "war " + r.status);
r = await ruf(T.handleUmAntwortZuruecknehmen, "seher", { id: nid });
pruefe("zuruecknehmen geht", r.status === 200, "war " + r.status);
nd = doc().umfragen.find((x) => x.id === nid);
pruefe("Antwort und Teilnehmer sind beide weg", nd.antworten.length === 0 && nd.teilnehmer.length === 0);

console.log("== 10b. nachStimme: erst nach der eigenen Stimme");
r = await ruf(T.handleUmLoad, "seher");
pruefe("ohne eigene Stimme kein Ergebnis",
  !("antworten" in r.daten.umfragen.find((x) => x.id === nid)));
await ruf(T.handleUmAntworten, "seher", { id: nid, werte: { n1: "ja" } });
r = await ruf(T.handleUmLoad, "seher");
pruefe("mit eigener Stimme kommt das Ergebnis",
  Array.isArray(r.daten.umfragen.find((x) => x.id === nid).antworten));

// ---------------------------------------------------------------------------
console.log("== 11. Der oeffentliche Weg");
// ---------------------------------------------------------------------------
r = await ruf(T.handleUmOeffentlichInfo, null, { token: "gibtsnicht" });
pruefe("unbekannter Token -> 404", r.status === 404, "war " + r.status);
r = await ruf(T.handleUmOeffentlichInfo, null, { token: altToken });
pruefe("erneuerter Link: der ALTE Token fuehrt ins Leere", r.status === 404, "war " + r.status);
r = await ruf(T.handleUmOeffentlichInfo, null, { token: token2 });
pruefe("geschlossene Umfrage -> 410", r.status === 410, "war " + r.status);

await ruf(T.handleUmStatus, "bearbeiter", { id: uid, status: "offen" });
r = await ruf(T.handleUmOeffentlichInfo, null, { token: token2 }, "1.2.3.4");
pruefe("offene Umfrage -> 200", r.status === 200, "war " + r.status);
const oeff = JSON.stringify(r.daten);
pruefe("die oeffentliche Sicht enthaelt KEINE Antworten", !oeff.includes("antworten"));
pruefe("die oeffentliche Sicht enthaelt KEINEN Nutzernamen", !oeff.includes("seher"));
pruefe("die oeffentliche Sicht enthaelt den eigenen Token NICHT", !oeff.includes(token2));
pruefe("Fragen kommen mit", r.daten.umfrage.fragen.length === 3);

r = await ruf(T.handleUmOeffentlichAbsenden, null, { token: token2, werte: { f1: "o2" }, name: "Familie A" }, "1.2.3.4");
pruefe("Gast darf abstimmen", r.status === 200, "war " + r.status);
const gast = doc().umfragen[0].antworten.find((x) => x.herkunft === "extern");
pruefe("Gast-Antwort mit Namen gespeichert", gast && gast.name === "Familie A");
pruefe("Fingerabdruck vermerkt", doc().umfragen[0].gaeste.length === 1);
pruefe("KEINE Internet-Adresse gespeichert",
  !JSON.stringify(doc().umfragen[0].gaeste).includes("1.2.3.4"), JSON.stringify(doc().umfragen[0].gaeste));

r = await ruf(T.handleUmOeffentlichAbsenden, null, { token: token2, werte: { f1: "o1" } }, "1.2.3.4");
pruefe("zweite Stimme von derselben Leitung -> 409", r.status === 409, "war " + r.status);
r = await ruf(T.handleUmOeffentlichAbsenden, null, { token: token2, werte: { f1: "o1" } }, "9.9.9.9");
pruefe("andere Leitung darf abstimmen", r.status === 200, "war " + r.status);

r = await ruf(T.handleUmOeffentlichInfo, null, { token: token2 }, "1.2.3.4");
pruefe("die Seite weiss, dass von hier schon abgestimmt wurde", r.daten.schonAbgestimmt === true);

console.log("== 11b. Namenspflicht");
r = await ruf(T.handleUmSpeichern, "bearbeiter", { umfrage: vorlage({ id: uid, externName: "pflicht" }) });
pruefe("Namensmodus laesst sich auch spaeter aendern", r.status === 200, "war " + r.status);
r = await ruf(T.handleUmOeffentlichAbsenden, null, { token: token2, werte: { f1: "o1" } }, "7.7.7.7");
pruefe("ohne Namen bei Pflicht -> 400", r.status === 400, "war " + r.status);
await ruf(T.handleUmSpeichern, "bearbeiter", { umfrage: vorlage({ id: uid, externName: "aus" }) });
r = await ruf(T.handleUmOeffentlichAbsenden, null, { token: token2, werte: { f1: "o1" }, name: "Petzer" }, "8.8.8.8");
pruefe("bei externName=aus wird ein mitgeschickter Name verworfen",
  r.status === 200 && !JSON.stringify(doc().umfragen[0].antworten).includes("Petzer"));

// ---------------------------------------------------------------------------
console.log("== 12. Bilder: der Token einer Umfrage oeffnet nicht alle Bilder");
// ---------------------------------------------------------------------------
const echteBildId = "11111111-1111-1111-1111-111111111111";
const fremdeBildId = "22222222-2222-2222-2222-222222222222";
await ruf(T.handleUmSpeichern, "bearbeiter", {
  umfrage: vorlage({ id: uid, kopfbild: { id: echteBildId, contentType: "image/png" } })
});
frisch();
let resp = await T.handleUmOeffentlichBild(req(null), token2, echteBildId, env, auth, cors);
pruefe("eigenes Bild wird ausgeliefert (200)", resp.status === 200, "war " + resp.status);
frisch();
resp = await T.handleUmOeffentlichBild(req(null), token2, fremdeBildId, env, auth, cors);
pruefe("fremde Bild-Id -> 404", resp.status === 404, "war " + resp.status);
frisch();
resp = await T.handleUmOeffentlichBild(req(null), "falscherToken", echteBildId, env, auth, cors);
pruefe("falscher Token -> 404", resp.status === 404, "war " + resp.status);

// ---------------------------------------------------------------------------
console.log("== 13. Schliessen raeumt die Fingerabdruecke weg");
// ---------------------------------------------------------------------------
pruefe("vor dem Schliessen liegen Fingerabdruecke vor", doc().umfragen[0].gaeste.length > 0);
await ruf(T.handleUmStatus, "bearbeiter", { id: uid, status: "geschlossen" });
pruefe("nach dem Schliessen sind sie weg", doc().umfragen[0].gaeste.length === 0);
pruefe("die Antworten bleiben stehen", doc().umfragen[0].antworten.length > 0);
r = await ruf(T.handleUmOeffentlichAbsenden, null, { token: token2, werte: { f1: "o1" } }, "5.5.5.5");
pruefe("geschlossene Umfrage nimmt nichts mehr an (410)", r.status === 410, "war " + r.status);

// ---------------------------------------------------------------------------
console.log("== 14. Erinnern trifft nur, wer noch nicht geantwortet hat");
// ---------------------------------------------------------------------------
r = await ruf(T.handleUmErinnern, "bearbeiter", { id: nid });
pruefe("Erinnern laeuft", r.status === 200, "war " + r.status);
pruefe("seher hat geantwortet und faellt raus, bearbeiter bleibt uebrig",
  r.daten.infrage === 1, "infrage=" + r.daten.infrage);
pruefe("erreicht wird nur gezaehlt, wer ein Geraet hat", r.daten.erreicht === 0);

// ---------------------------------------------------------------------------
console.log("== 15. Loeschen ist Administrieren-Sache");
// ---------------------------------------------------------------------------
r = await ruf(T.handleUmLoeschen, "bearbeiter", { id: nid });
pruefe("Bearbeiter darf nicht loeschen (403)", r.status === 403, "war " + r.status);
const vorher = doc().umfragen.length;
r = await ruf(T.handleUmLoeschen, "chef", { id: nid });
pruefe("Administrator darf loeschen", r.status === 200, "war " + r.status);
pruefe("eine Umfrage weniger", doc().umfragen.length === vorher - 1);

// ---------------------------------------------------------------------------
console.log("== 16. Ohne Anmeldung geht bei den internen Aktionen nichts");
// ---------------------------------------------------------------------------
for (const [name, fn, body] of [
  ["umfragen-load", T.handleUmLoad, undefined],
  ["umfragen-speichern", T.handleUmSpeichern, { umfrage: vorlage() }],
  ["umfragen-antworten", T.handleUmAntworten, { id: uid, werte: {} }],
  ["umfragen-freigeben", T.handleUmFreigeben, { id: uid, frei: true }]
]) {
  const x = await ruf(fn, null, body);
  pruefe(name + " ohne Token -> 401", x.status === 401, "war " + x.status);
}

// ---------------------------------------------------------------------------
console.log("");
if (fehler) { console.log("FEHLER: " + fehler); process.exit(1); }
console.log("Alles gruen.");
