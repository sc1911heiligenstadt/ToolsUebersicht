// Prüfstand für das Auto-Provisioning von Trainerdaten-Einträgen.
//
// Zusage: Wer beim Anlegen KEINEN Trainervertrag braucht (kein Häkchen "Vertrag
// benötigt" und nicht in der Gruppe "Trainer"), bekommt seinen Trainerdaten-Eintrag
// mit vertragspflichtig:false — daraus leitet Trainerdaten den Status "Nur
// Kontaktdaten" ab und blendet Bankverbindung, Vertragsdaten, Anlage 1 und die
// Vertrags-Knöpfe aus.
//
// Gefahren werden die ECHTEN Funktionen aus admin-worker.js (herausgeschnitten,
// nicht nachgebaut). Mit --mutation läuft die Gegenprobe.
//
// Aufruf:  node pruef-provision-vertrag.mjs --mutation
//          node pruef-provision-vertrag.mjs --selbsttest   (muss ABBRECHEN)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SELBSTTEST = process.argv.includes("--selbsttest");
const QUELLE = SELBSTTEST
  ? execFileSync("git", ["-C", "E:/ToolsUebersicht", "show", "HEAD:admin-worker.js"], { maxBuffer: 1e9 }).toString("utf8")
  : readFileSync(new URL("./admin-worker.js", import.meta.url), "utf8");
const CODE = QUELLE.split("\r\n").join("\n");

// ─── Funktionen aus der echten Datei schneiden ────────────────────────────────
function holeFunktion(name, quelle = CODE) {
  const kopf = `function ${name}(`;
  const start = quelle.indexOf(kopf);
  if (start === -1) throw new Error(`NICHT GEFUNDEN in der Datei: ${name}`);
  const ende = quelle.indexOf("\n}\n", start);
  if (ende === -1) throw new Error(`Ende von ${name} nicht gefunden`);
  return quelle.slice(start, ende + 3);
}

const TEILE = ["getOwn", "sameText", "sameNamePair", "isVertragspflichtig", "provisionProfile", "provisionTrainerdaten"];

function baue(quelle) {
  const quellText = TEILE.map((n) => holeFunktion(n, quelle)).join("\n");
  const fn = new Function("crypto", `const TRAINER_GROUP_NAME = "Trainer";\n${quellText}\nreturn { ${TEILE.join(", ")} };`);
  let zaehler = 0;
  return fn({ randomUUID: () => `uuid-${++zaehler}` });
}

// ─── Testdaten ────────────────────────────────────────────────────────────────
function usersDoc() {
  return {
    users: {
      "anna.trainer":   { username: "anna.trainer",   vorname: "Anna",   nachname: "Trainer" },
      "bernd.buero":    { username: "bernd.buero",    vorname: "Bernd",  nachname: "Buero" },
      "clara.helfer":   { username: "clara.helfer",   vorname: "Clara",  nachname: "Helfer", vertragBenoetigt: true },
      "dieter.vorstand":{ username: "dieter.vorstand",vorname: "Dieter", nachname: "Vorstand" }
    },
    groups: {
      trainer: { id: "trainer", name: "Trainer", memberUsernames: ["anna.trainer"] },
      buero:   { id: "buero",   name: "Geschäftsstelle", memberUsernames: ["bernd.buero", "dieter.vorstand"] }
    }
  };
}

const NEU = () => ({ trainer: [] });

// ─── Zusagen ──────────────────────────────────────────────────────────────────
function pruefe(F) {
  const fehler = [];
  const sag = (ok, text) => { if (!ok) fehler.push(text); };
  const doc = usersDoc();
  const profil = (u) => F.provisionProfile(doc.users[u], doc);

  // A) Vertragspflicht richtig abgeleitet
  sag(profil("anna.trainer").vertragspflichtig === true,   "A1 Gruppe Trainer zählt nicht als vertragspflichtig");
  sag(profil("clara.helfer").vertragspflichtig === true,   "A2 Häkchen 'Vertrag benötigt' zählt nicht");
  sag(profil("bernd.buero").vertragspflichtig === false,   "A3 Geschäftsstelle gilt fälschlich als vertragspflichtig");
  sag(profil("dieter.vorstand").vertragspflichtig === false,"A4 Vorstand gilt fälschlich als vertragspflichtig");

  // B) Beim Anlegen landet das Feld im Datensatz — DIE Zusage
  {
    const data = NEU();
    sag(F.provisionTrainerdaten(data, profil("bernd.buero")) === "created", "B1 Eintrag wurde nicht angelegt");
    const t = data.trainer[0];
    sag(t && t.vertragspflichtig === false, `B2 ohne Häkchen wird nicht vertragspflichtig:false gesetzt (${t && JSON.stringify(t.vertragspflichtig)})`);
    sag(t && t.linkedUsername === "bernd.buero", "B3 linkedUsername fehlt");
    // Das ist die Bedingung, die _trainerStatus in Trainerdaten auf "kontaktdaten" schaltet
    sag(t && t.vertragspflichtig === false && !t.status && !t.username,
        "B4 der Eintrag erfüllt die Bedingung für den Status 'Nur Kontaktdaten' nicht");
  }
  {
    const data = NEU();
    F.provisionTrainerdaten(data, profil("anna.trainer"));
    sag(data.trainer[0].vertragspflichtig === true, "B5 ein echter Trainer wird fälschlich auf false gesetzt");
  }

  // C) Bestehende Einträge: nachtragen ja, überschreiben nein
  {
    // C1 Alt-Stub ohne Feld -> wird ergänzt
    const data = { trainer: [{ id: "x", vorname: "Bernd", nachname: "Buero", linkedUsername: "bernd.buero" }] };
    sag(F.provisionTrainerdaten(data, profil("bernd.buero")) === "aktualisiert", "C1 Alt-Stub wird nicht ergänzt");
    sag(data.trainer[0].vertragspflichtig === false, "C2 ergänzter Wert falsch");
    sag(data.trainer.length === 1, "C3 es wurde ein Duplikat angelegt");
    // zweiter Lauf tut nichts mehr
    sag(F.provisionTrainerdaten(data, profil("bernd.buero")) === "exists", "C4 zweiter Lauf ist nicht idempotent");
  }
  {
    // C5 hat selbst eingereicht -> unangetastet (der Einreichzeitpunkt gilt)
    const data = { trainer: [{ id: "x", vorname: "Bernd", nachname: "Buero", username: "bernd.buero", vertragspflichtig: true }] };
    sag(F.provisionTrainerdaten(data, profil("bernd.buero")) === "exists", "C5 eingereichter Datensatz wird angefasst");
    sag(data.trainer[0].vertragspflichtig === true, "C6 der Einreich-Stand wurde überschrieben");
  }
  {
    // C7 Admin hat den Status von Hand gesetzt -> unangetastet
    const data = { trainer: [{ id: "x", vorname: "Bernd", nachname: "Buero", status: "ausstehend" }] };
    sag(F.provisionTrainerdaten(data, profil("bernd.buero")) === "exists", "C7 Handauswahl des Admins wird übergangen");
    sag(data.trainer[0].vertragspflichtig === undefined, "C8 trotz Handauswahl wurde geschrieben");
  }
  {
    // C9 Feld schon gesetzt -> nie überschreiben
    const data = { trainer: [{ id: "x", vorname: "Bernd", nachname: "Buero", vertragspflichtig: true }] };
    sag(F.provisionTrainerdaten(data, profil("bernd.buero")) === "exists", "C9 gesetztes Feld wird erneut angefasst");
    sag(data.trainer[0].vertragspflichtig === true, "C10 gesetztes Feld wurde überschrieben");
  }
  {
    // C11 Treffer auch über den Namen (Stub aus dem Personalkosten-Import, ohne linkedUsername)
    const data = { trainer: [{ id: "x", vorname: "Bernd", nachname: "Buero" }] };
    sag(F.provisionTrainerdaten(data, profil("bernd.buero")) === "aktualisiert", "C11 Namens-Treffer wird nicht ergänzt");
  }

  // D) Verdrahtung im Rest der Datei
  sag(/function provisionProfile\(user, usersDoc\)/.test(CODE), "D1 provisionProfile nimmt usersDoc nicht entgegen");
  sag(/provisionProfile\(u, usersDoc\)/.test(CODE), "D2 provisionAppBatch reicht usersDoc nicht an provisionProfile");
  sag(/async function provisionAppBatch\([^)]*usersDoc\)/.test(CODE), "D3 provisionAppBatch hat keinen usersDoc-Parameter");
  sag(/async function provisionUsers\([^)]*usersDoc\)/.test(CODE), "D4 provisionUsers hat keinen usersDoc-Parameter");
  sag(/provisionAppBatch\(app, adapter, url, members, env, authHeader, usersDoc\)/.test(CODE), "D5 provisionUsers reicht usersDoc nicht durch");
  {
    // alle drei Aufrufstellen von provisionUsers müssen usersDoc mitgeben
    const aufrufe = CODE.match(/provisionUsers\([^)]*\)/g) || [];
    const ohneDoc = aufrufe.filter((a) => !/usersDoc\)$/.test(a));
    sag(aufrufe.length >= 4, `D6 zu wenige provisionUsers-Vorkommen gefunden (${aufrufe.length}) — Definition plus drei Aufrufstellen erwartet`);
    sag(ohneDoc.length === 0, "D7 eine Aufrufstelle von provisionUsers gibt usersDoc nicht mit: " + ohneDoc.join(" | "));
  }
  // D8) Kreuzprobe gegen das ANDERE Repo: der erzeugte Datensatz muss dort wirklich
  // als "Nur Kontaktdaten" ankommen. Gefahren wird das echte _trainerStatus aus
  // E:\Trainerdaten\app.js — ohne diese Zusage könnte die Bedingung dort geändert
  // werden, ohne dass hier etwas auffällt.
  {
    let trainerStatus = null;
    try {
      const tdCode = readFileSync("E:/Trainerdaten/app.js", "utf8").split("\r\n").join("\n");
      trainerStatus = new Function(`${holeFunktion("_trainerStatus", tdCode)}\nreturn _trainerStatus;`)();
    } catch (e) {
      sag(false, "D8 _trainerStatus aus E:/Trainerdaten/app.js nicht ladbar: " + e.message);
    }
    if (trainerStatus) {
      const data = NEU();
      F.provisionTrainerdaten(data, profil("bernd.buero"));
      sag(trainerStatus(data.trainer[0]) === "kontaktdaten",
          `D9 Trainerdaten leitet daraus nicht "Nur Kontaktdaten" ab, sondern "${trainerStatus(data.trainer[0])}"`);
      const data2 = NEU();
      F.provisionTrainerdaten(data2, profil("anna.trainer"));
      sag(trainerStatus(data2.trainer[0]) !== "kontaktdaten",
          "D10 ein echter Trainer landet fälschlich auf 'Nur Kontaktdaten'");
    }
  }

  // E) "aktualisiert" muss geschrieben und angezeigt werden
  sag(/o === "created" \|\| o === "aktualisiert"/.test(CODE), "E1 ein reines Nachtragen löst keinen Schreibvorgang aus");
  sag(/outcomes\[k\] === "created" \|\| outcomes\[k\] === "aktualisiert"/.test(CODE), "E2 Fehlerpfad markiert 'aktualisiert' nicht als Fehler");
  {
    const app = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    sag(/count\("aktualisiert"\)/.test(app), "E3 die Oberfläche zeigt nachgetragene Einträge nicht an");
  }

  return fehler;
}

// ─── Ausführen ────────────────────────────────────────────────────────────────
const echt = baue(CODE);
const fehler = pruefe(echt);
console.log(fehler.length === 0
  ? "OK  echte Fassung: alle Zusagen erfüllt"
  : "FEHLER  echte Fassung:\n  " + fehler.join("\n  "));
if (fehler.length) process.exitCode = 1;

if (process.argv.includes("--mutation")) {
  const mutationen = [
    ["Feld beim Anlegen weglassen", (s) => s.replace(/\n    vertragspflichtig: p\.vertragspflichtig,/, "")],
    ["immer vertragspflichtig",     (s) => s.replace("return inTrainerGroup || !!(user && user.vertragBenoetigt);", "return true;")],
    ["Gruppe Trainer ignorieren",   (s) => s.replace("return inTrainerGroup || !!(user && user.vertragBenoetigt);", "return !!(user && user.vertragBenoetigt);")],
    ["Häkchen ignorieren",          (s) => s.replace("return inTrainerGroup || !!(user && user.vertragBenoetigt);", "return inTrainerGroup;")],
    ["Alt-Stub nicht ergänzen",     (s) => s.replace(/if \(!vorhanden\.username && !vorhanden\.status && vorhanden\.vertragspflichtig === undefined\) \{/, "if (false) {")],
    ["Eingereichtes überschreiben", (s) => s.replace("!vorhanden.username && !vorhanden.status && vorhanden.vertragspflichtig === undefined", "true")],
    ["Handauswahl übergehen",       (s) => s.replace("!vorhanden.username && !vorhanden.status && vorhanden.vertragspflichtig === undefined", "!vorhanden.username && vorhanden.vertragspflichtig === undefined")],
    ["Profil ohne Vertragspflicht", (s) => s.replace("vertragspflichtig: isVertragspflichtig(usersDoc, user.username)", "vertragspflichtig: undefined")]
  ];
  let gefangen = 0;
  for (const [name, mut] of mutationen) {
    const kaputt = mut(CODE);
    if (kaputt === CODE) { console.log(`  !! ${name}: Mutation hat nichts geändert (Probe stumpf!)`); continue; }
    let f;
    try { f = pruefe(baue(kaputt)); } catch (e) { f = ["Absturz: " + e.message]; }
    if (f.length) { gefangen++; console.log(`  OK  gefangen: ${name}`); }
    else          { console.log(`  !!  DURCHGERUTSCHT: ${name}`); }
  }
  console.log(`Mutationen: ${gefangen}/${mutationen.length} gefangen`);
  if (gefangen !== mutationen.length) process.exitCode = 1;
}
