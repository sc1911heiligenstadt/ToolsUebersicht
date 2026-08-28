// Mutationsprobe zur Absage-Bestaetigung. Jede Verschlechterung MUSS rot werden.
//
//   node mutation-camp-absage.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HIER = dirname(fileURLToPath(import.meta.url));
const QUELL = join(HIER, "admin-worker.js");
// ⚠️ Die Mutanten-Datei liegt im Temp-Ordner, NICHT im Repo — sonst landet
// eine absichtlich kaputte Worker-Fassung im nächsten Commit.
const ZIEL = join(os.tmpdir(), "mutant-camp-absage.js");
const ORIGINAL = readFileSync(QUELL, "utf8");

const MUTATIONEN = [
  // ---- Die Verdrahtung -------------------------------------------------
  ["Die Absage verschickt gar keine Mail",
    `        sent = await fcAbsageMail(env, mailDaten.camp, mailDaten.anmeldung, mailDaten.einstellungen);`,
    `        sent = false;`],

  ["Die Antwort verschweigt, ob die Mail rausging",
    `    return json({ ...antwort, sent }, 200, corsHeaders);`,
    `    return json(antwort, 200, corsHeaders);`],

  ["Eine zweite Absage schickt eine zweite Mail",
    `      if (anmeldung.status === "abgesagt") return { schonAbgesagt: true };

      anmeldung.status = "abgesagt";
      anmeldung.absageGrund = "von den Eltern abgesagt";`,
    `      const schonWeg = anmeldung.status === "abgesagt";

      anmeldung.status = "abgesagt";
      anmeldung.absageGrund = schonWeg ? anmeldung.absageGrund : "von den Eltern abgesagt";`],

  // ⚠️ NICHT mutierbar und deshalb bewusst nicht in dieser Liste: das aeussere
  // try/catch um fcAbsageMail. `fcMailSenden` faengt jeden fetch-Fehler bereits
  // selbst und gibt `false` zurueck — die beiden sind eine doppelte
  // Absicherung, und die aeussere allein zu entfernen ist verhaltensgleich.
  // Die Zusagen 7.1–7.3 sind trotzdem nicht blind: sie belegen, dass ein
  // Mailfehler die Absage nicht kippt. Nur eben ueber die innere Schranke.

  ["Die Fusszeile sagt nicht mehr, warum die Mail kam",
    `--
Diese E-Mail wurde automatisch verschickt, weil über unsere Seite eine Absage
für dieses Camp abgeschickt wurde.\`;`,
    `--
Diese E-Mail wurde automatisch verschickt.\`;`],

  ["Die Mail nennt das Kind nicht mehr beim Namen",
    `wir haben deine Absage für \${fcKindName(a)} erhalten. Der Platz beim Fußballcamp`,
    `wir haben deine Absage erhalten. Der Platz beim Fußballcamp`],

  ["Die Camp-Angaben fehlen in der Absage-Mail",
    `\${fcCampBlock(camp)}

\${fcAbsageGeldBlock(camp, a)}`,
    `\${fcAbsageGeldBlock(camp, a)}`],

  ["Der Betreff verraet nicht mehr, worum es geht",
    "  return fcMailSenden(env, a.elternEmail, `Absage bestätigt: ${camp.name}`, text);",
    "  return fcMailSenden(env, a.elternEmail, `Nachricht vom Verein`, text);"],

  // ⚠️ Der Aendern-Link waere hier eine Sackgasse: nach der Absage antwortet
  // handleFcMeineSpeichern mit 410. Und er traegt den Eltern-Token.
  ["Die Absage-Mail traegt wieder den Aendern-Link samt Eltern-Token",
    `\${fcAbsageGeldBlock(camp, a)}

War die Absage ein Versehen?`,
    `\${fcAbsageGeldBlock(camp, a)}

\${fcAendernBlock(a)}

War die Absage ein Versehen?`],

  // ---- Die Erstattungsstaffel -----------------------------------------
  ["Der 28. Tag zaehlt schon zur halben Erstattung",
    `  if (tage >= FC_ERSTATTUNG_VOLL_AB_TAGEN) return 100;`,
    `  if (tage > FC_ERSTATTUNG_VOLL_AB_TAGEN) return 100;`],

  ["Der 7. Tag zaehlt schon zu 'keine Erstattung'",
    `  if (tage >= FC_ERSTATTUNG_HALB_AB_TAGEN) return 50;`,
    `  if (tage > FC_ERSTATTUNG_HALB_AB_TAGEN) return 50;`],

  ["Die Staffel steht auf den falschen Grenzen",
    `const FC_ERSTATTUNG_VOLL_AB_TAGEN = 28;
const FC_ERSTATTUNG_HALB_AB_TAGEN = 7;`,
    `const FC_ERSTATTUNG_VOLL_AB_TAGEN = 14;
const FC_ERSTATTUNG_HALB_AB_TAGEN = 3;`],

  // ⚠️ null heisst "keine Aussage moeglich". Als 0 behauptet die Mail bei einem
  // Camp ohne Datum "keine Erstattung" -- eine Zusage, die niemand gedeckt hat.
  ["Ein Camp ohne Datum gilt als 'keine Erstattung' statt als unbekannt",
    `  const tage = fcTageBisCamp(camp);
  if (tage === null) return null;`,
    `  const tage = fcTageBisCamp(camp);
  if (tage === null) return 0;`],

  // ⚠️ „lokal statt UTC" und „floor statt round" stehen hier bewusst NICHT.
  // Beide sind mit einem heutigen Datum im August verhaltensgleich: Node laeuft
  // in Europe/Berlin, und der Zeitzonen-Versatz zwischen heute und jedem Ziel
  // der naechsten 400 Tage ist nie negativ — floor rundet dann genauso wie
  // round. Eine Mutation, die je nach Jahreszeit mal faengt und mal nicht, ist
  // schlimmer als keine: sie sieht ein halbes Jahr lang aus wie ein Beleg.
  // Festgenagelt wird die Rechnung stattdessen ueber die zwei Mutationen unten.

  ["fcTageBisCamp zaehlt um einen Tag daneben",
    `  return Math.round((start.getTime() - heute.getTime()) / 86400000);`,
    `  return Math.round((start.getTime() - heute.getTime()) / 86400000) + 1;`],

  ["fcTageBisCamp vertauscht Start und Heute",
    `  return Math.round((start.getTime() - heute.getTime()) / 86400000);`,
    `  return Math.round((heute.getTime() - start.getTime()) / 86400000);`],

  // ---- Der Geld-Absatz -------------------------------------------------
  // ⚠️ 0 ist ein gueltiger Betrag (Freiplatz). Auf Wahrheitswert geprueft
  // faellt er in den Zweig "unbezahlt" -- und die Familie bekaeme eine
  // Zahlungsansage ueber nichts.
  ["Ein Freiplatz (Betrag 0) faellt in den Zahlungs-Zweig",
    `  if (betrag === undefined || betrag === null || Number(betrag) === 0) {
    return \`Für diesen Platz war kein Beitrag zu zahlen. Es ist also nichts weiter zu tun.\`;
  }`,
    `  if (betrag === undefined || betrag === null) {
    return \`Für diesen Platz war kein Beitrag zu zahlen. Es ist also nichts weiter zu tun.\`;
  }`],

  // ⚠️ Der Verzicht darf NUR bei voller Erstattung ausgesprochen werden.
  ["'Du musst nichts mehr überweisen' steht in jedem unbezahlten Fall",
    `  if (stufe === 100) {
    return \`Ein Beitrag ist bei uns nicht eingegangen. Du musst nichts mehr überweisen.\`;
  }`,
    `  if (stufe !== undefined) {
    return \`Ein Beitrag ist bei uns nicht eingegangen. Du musst nichts mehr überweisen.\`;
  }`],

  ["Bei 'keine Erstattung' wird trotzdem eine Rueckzahlung versprochen",
    `    if (stufe === 0) {
      return \`Den Beitrag von \${fcEuro(betrag)} hast du bereits überwiesen. Weil das Camp in
weniger als sieben Tagen beginnt, ist nach Punkt 4 der Teilnahmebedingungen
keine Erstattung vorgesehen. Wenn es dafür einen besonderen Grund gibt, melde
dich bitte bei uns — wir sehen uns das an.\`;
    }\n`, ``],

  ["Die Mail nennt den bezahlten Betrag nicht mehr",
    `    return \`Den Beitrag von \${fcEuro(betrag)} hast du bereits überwiesen. Nach Punkt 4 der`,
    `    return \`Den Beitrag hast du bereits überwiesen. Nach Punkt 4 der`],

  ["Volle und halbe Erstattung werden vertauscht",
    `  const quote = stufe === 100 ? "der volle Beitrag" : stufe === 50 ? "die Hälfte des Beitrages" : "";`,
    `  const quote = stufe === 100 ? "die Hälfte des Beitrages" : stufe === 50 ? "der volle Beitrag" : "";`]
];

let gefangen = 0, durchgerutscht = 0, fehltreffer = 0;

for (const [name, suche, ersatz] of MUTATIONEN) {
  const treffer = ORIGINAL.split(suche).length - 1;
  if (treffer !== 1) {
    fehltreffer++;
    console.log(`  ?   [Suchtext trifft ${treffer}x statt 1x] ${name}`);
    continue;
  }
  writeFileSync(ZIEL, ORIGINAL.replace(suche, ersatz), "utf8");
  let rot = false, abbruch = "";
  try {
    execFileSync("node", [join(HIER, "pruef-camp-absage.mjs"), ZIEL], { stdio: "pipe" });
  } catch (e) {
    rot = true;
    const aus = String(e.stdout || "") + String(e.stderr || "");
    if (aus.includes("ABBRUCH")) abbruch = " (Extraktion brach ab)";
  }
  if (rot) { gefangen++; console.log(`  ok  gefangen${abbruch}: ${name}`); }
  else { durchgerutscht++; console.log(`  X   DURCHGERUTSCHT: ${name}`); }
}

console.log("\n" + "=".repeat(60));
console.log(`${gefangen} von ${MUTATIONEN.length} Mutationen gefangen.`);
if (durchgerutscht) console.log(`${durchgerutscht} durchgerutscht — dort ist eine Zusage blind.`);
if (fehltreffer) console.log(`${fehltreffer} Suchtexte passten nicht — diese Mutationen liefen ins Leere.`);
if (durchgerutscht || fehltreffer) process.exit(1);
