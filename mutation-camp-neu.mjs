// Mutationsprobe zu pruef-camp-neu.mjs.
//
// Jede Mutation verschlechtert Worker oder Client GEZIELT. Bleibt der Pruefstand
// dabei gruen, ist die zugehoerige Zusage blind und muss nachgeschaerft werden.
// Ein Pruefstand, der beim ersten Anlauf gruen ist, sagt fuer sich genommen
// nichts -- erst diese Probe zeigt, ob er ueberhaupt etwas anfassen wuerde.
//
// ⚠️ Eine Mutation, deren Suchtext nicht gefunden wird, laeuft ins Leere und
// saehe aus wie eine blinde Zusage. Deshalb bricht der Lauf ab, statt sie als
// "durchgerutscht" zu melden.
//
//   node mutation-camp-neu.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

const HIER = dirname(fileURLToPath(import.meta.url));
const APP = join(HIER, "..", "fussballcamp");
const PRUEF = join(HIER, "pruef-camp-neu.mjs");
const TMP = fs.mkdtempSync(join(os.tmpdir(), "fc-mut-neu-"));

// Alles, was der Pruefstand liest.
const CLIENT_DATEIEN = ["config.js", "app.js", "oeffentlich.js", "feedback.js",
                        "anmeldung.js", "meine-anmeldung.js", "index.html", "feedback.html"];
const ORIG = { "admin-worker.js": fs.readFileSync(join(HIER, "admin-worker.js"), "utf8") };
CLIENT_DATEIEN.forEach((d) => { ORIG[d] = fs.readFileSync(join(APP, d), "utf8"); });

// [Name, Datei, Suchtext, Ersatz] -- oder mit zwei weiteren Feldern eine ZWEITE
// Ersetzung in derselben Datei.
//
// ⚠️ Zwei Ersetzungen braucht es dort, wo eine Pruefung mit Absicht DOPPELT
// steht (Vorfilter und Wache im Closure). Faellt nur eine von beiden, faengt die
// andere den Fehler auf -- die Mutation laeuft ins Leere und saehe aus wie eine
// blinde Zusage, obwohl die Zusage in Ordnung ist.
const MUTATIONEN = [
  // ---------- 1. Anmeldeschluss schliesst das Camp ----------
  ["Das automatische Schliessen haengt nicht mehr an der Nacht", "admin-worker.js",
   "    await fcAutoSchliessenLauf(authHeader);",
   "    void fcAutoSchliessenLauf;"],

  // ⚠️ Vorfilter UND Closure-Wache sind mit Absicht doppelt. Die naechsten
  // beiden Mutationen fassen deshalb jeweils BEIDE Stellen an.
  ["Es schliesst schon AM Stichtag, einen Tag zu frueh (beide Wachen)", "admin-worker.js",
   '    c.status === "offen" && !c.aufgeraeumtAm && c.anmeldungBis && heute > c.anmeldungBis);',
   '    c.status === "offen" && !c.aufgeraeumtAm && c.anmeldungBis && heute >= c.anmeldungBis);',
   "      if (!camp.anmeldungBis || fcHeuteBerlin() <= camp.anmeldungBis) return;",
   "      if (!camp.anmeldungBis || fcHeuteBerlin() < camp.anmeldungBis) return;"],

  ["Auch ein Entwurf wird geschlossen (beide Wachen)", "admin-worker.js",
   '      if (!camp || camp.status !== "offen") return;',
   "      if (!camp) return;",
   '    c.status === "offen" && !c.aufgeraeumtAm && c.anmeldungBis && heute > c.anmeldungBis);',
   '    !c.aufgeraeumtAm && c.anmeldungBis && heute > c.anmeldungBis);'],

  ["Ein aufgeraeumtes Camp wird mit geschlossen", "admin-worker.js",
   '    c.status === "offen" && !c.aufgeraeumtAm && c.anmeldungBis',
   '    c.status === "offen" && c.anmeldungBis'],

  ["Der Verlauf verschweigt, dass es automatisch war", "admin-worker.js",
   'fcVerlaufNotiz(camp, { was: "status", von: "automatisch", vorher: "offen", nachher: "geschlossen", grund: "anmeldeschluss" });',
   'fcVerlaufNotiz(camp, { was: "status", von: "michel", vorher: "offen", nachher: "geschlossen" });'],

  // ---------- 2. Konfektionsgroesse ----------
  ["Die Konfektionsgroesse faellt aus der Betreuer-Liste", "admin-worker.js",
   'const FC_BETREUER_FELDER = ["kindVorname", "kindNachname", "geburtsdatum", "trikotgroesse",',
   'const FC_BETREUER_FELDER = ["kindVorname", "kindNachname", "geburtsdatum",'],

  ["Die Betreuer-Liste gibt ploetzlich die Anschrift heraus", "admin-worker.js",
   '"essenHinweis", "elternTelefon", "alleinNachHause"];',
   '"essenHinweis", "elternTelefon", "elternAnschrift", "alleinNachHause"];'],

  ["Die Rolle faellt aus der Betreuer-Liste", "admin-worker.js",
   '      kurz.rolle = a.rolle || "feldspieler";',
   "      void a;"],

  ["Nur die config.js-Liste wird erweitert, der Worker bleibt zurueck", "config.js",
   'const BETREUER_FELDER = ["kindVorname", "kindNachname", "geburtsdatum", "trikotgroesse",',
   'const BETREUER_FELDER = ["kindVorname", "kindNachname", "geburtsdatum", "krankenkasse", "trikotgroesse",'],

  // ---------- 3. Bezahlt-Mail ----------
  ["Die Bezahlt-Mail geht bei JEDEM Setzen des Hakens raus", "admin-worker.js",
   '          if (neu && !a.bezahltMailAm && a.status === "angemeldet" && a.elternEmail) {',
   '          if (neu && a.status === "angemeldet" && a.elternEmail) {'],

  ["Die Bezahlt-Mail geht auch an Wartende", "admin-worker.js",
   '          if (neu && !a.bezahltMailAm && a.status === "angemeldet" && a.elternEmail) {',
   "          if (neu && !a.bezahltMailAm && a.elternEmail) {"],

  // Seit dem Umbau auf Mailvorlagen (2026-09-03) steht die Zeile in der Vorgabe,
  // nicht mehr als Template-Literal in der Funktion.
  ["Der Ablauf faellt aus der Bezahlt-Mail", "admin-worker.js",
   "  Beitrag  {betrag} — bezahlt{ablaufblock}",
   "  Beitrag  {betrag} — bezahlt"],

  ["Ein leerer Ablauf erzeugt eine Ueberschrift ueber nichts", "admin-worker.js",
   '  const t = String((camp && camp.ablauf) || "").trim();\n  if (!t) return "";',
   '  const t = String((camp && camp.ablauf) || "").trim();',
   ],

  ["Der Ablauf wird beim Speichern des Camps verworfen", "admin-worker.js",
   "      camp.ablauf = capStr(roh.ablauf, FC_ABLAUF_MAX).trim();",
   "      void roh.ablauf;"],

  ["Auch das Zuruecknehmen des Hakens verschickt eine Mail", "admin-worker.js",
   '          if (neu && !a.bezahltMailAm && a.status === "angemeldet" && a.elternEmail) {',
   '          if (!a.bezahltMailAm && a.status === "angemeldet" && a.elternEmail) {'],

  // ---------- 4. Feldspieler oder Torwart ----------
  ["Ein Camp mit beiden Ausrichtungen fragt gar nicht mehr", "admin-worker.js",
   "  const erlaubt = fcRollenAmCamp(camp);\n  if (erlaubt.length === 1) return erlaubt[0];",
   "  const erlaubt = fcRollenAmCamp(camp);\n  return erlaubt[0];\n  // eslint-disable-next-line"],

  ["Der Client darf die Rolle mitbestimmen, auch wo es nichts zu waehlen gibt", "admin-worker.js",
   "  const erlaubt = fcRollenAmCamp(camp);\n  if (erlaubt.length === 1) return erlaubt[0];\n  const wert = String((roh && roh.rolle) || \"\");",
   "  const erlaubt = fcRollenAmCamp(camp);\n  const wert = String((roh && roh.rolle) || erlaubt[0]);"],

  ["Altbestand ohne Felder gilt ploetzlich als 'beides'", "admin-worker.js",
   "    c.fuerFeldspieler = c.fuerFeldspieler === undefined ? !c.fuerTorwart : !!c.fuerFeldspieler;\n    c.fuerTorwart = !!c.fuerTorwart;",
   "    c.fuerFeldspieler = c.fuerFeldspieler === undefined ? true : !!c.fuerFeldspieler;\n    c.fuerTorwart = c.fuerTorwart === undefined ? true : !!c.fuerTorwart;"],

  ["Ein Camp ganz ohne Ausrichtung wird durchgelassen", "admin-worker.js",
   '        if (!feld && !tw) throw new FcFehler("Bitte kreuze an, für wen das Camp ist — Feldspieler, Torwart oder beides.", 400);',
   "        void 0;"],

  ["Fehlende Haken setzen die Ausrichtung still zurueck", "admin-worker.js",
   "      if (roh.fuerFeldspieler !== undefined || roh.fuerTorwart !== undefined) {\n        const feld = roh.fuerFeldspieler === true;",
   "      if (true) {\n        const feld = roh.fuerFeldspieler === true;"],

  ["fcTorwartZahl zaehlt auch Wartende und Abgesagte", "admin-worker.js",
   '  return (camp.anmeldungen || []).filter((a) => a.status === "angemeldet" && a.rolle === "torwart").length;',
   '  return (camp.anmeldungen || []).filter((a) => a.rolle === "torwart").length;'],

  ["Die Rolle wird bei der Anmeldung gar nicht erst gespeichert", "admin-worker.js",
   "        rolle,\n        erstelltAm: new Date().toISOString(),",
   "        erstelltAm: new Date().toISOString(),"],

  ["Das Anmeldeformular stellt die Rollenfrage auch bei nur EINER Ausrichtung", "oeffentlich.js",
   '  if (liste.length < 2) return "";',
   '  if (liste.length < 1) return "";'],

  ["Das Formular liest den ersten Knopf statt den gedrueckten", "oeffentlich.js",
   'const gewaehlt = wurzel.querySelector("[data-rolle]:checked");',
   'const gewaehlt = wurzel.querySelector("[data-rolle]");'],

  ["anmeldung.js reicht die Rollen nicht mehr durch", "anmeldung.js",
   "camp.felder, letzteEltern || {}, camp.rollen);",
   "camp.felder, letzteEltern || {});"],

  // ---------- 5. Feedbackbogen: Versand ----------
  ["Der Feedbackbogen haengt nicht mehr an der Nacht", "admin-worker.js",
   '    await fcFeedbackLauf(env, authHeader, "");',
   "    void fcFeedbackLauf;"],

  ["Die OBERE Fenstergrenze faellt weg (alle alten Camps bekommen Post)", "admin-worker.js",
   "    if (!ab || !bis || heute < ab || heute > bis) return;",
   "    if (!ab || heute < ab) return;"],

  ["Das Fenster wird auf ein Jahr geweitet", "admin-worker.js",
   "const FC_FEEDBACK_FENSTER_TAGE = 21;",
   "const FC_FEEDBACK_FENSTER_TAGE = 365;"],

  ["Der Bogen laeuft auch, wenn er ausgeschaltet ist", "admin-worker.js",
   "  if (!einst.feedbackAktiv) return { gesendet: 0, gefunden: 0, aus: true };",
   "  void einst.feedbackAktiv;"],

  ["Der Bogen geht auch an Abgesagte und Wartende", "admin-worker.js",
   '      if (a.status !== "angemeldet" || !a.elternEmail) return;\n      if (a.feedbackGebetenAm) return;',
   "      if (!a.elternEmail) return;\n      if (a.feedbackGebetenAm) return;"],

  ["Der Bogen wird bei jedem Lauf erneut verschickt", "admin-worker.js",
   "      if (a.feedbackGebetenAm) return;\n      faellig.push({ camp, a });",
   "      faellig.push({ camp, a });"],

  ["Ein noch laufendes Camp bekommt schon einen Bogen", "admin-worker.js",
   "    const ab = fcTagPlusUtc(camp.bisDatum, tage);\n    const bis = fcTagPlusUtc(camp.bisDatum, tage + FC_FEEDBACK_FENSTER_TAGE);",
   "    const ab = fcTagPlusUtc(camp.bisDatum, -30);\n    const bis = fcTagPlusUtc(camp.bisDatum, tage + FC_FEEDBACK_FENSTER_TAGE);"],

  // ---------- 6. Feedbackbogen: Anonymitaet ----------
  ["Die Antwort traegt einen Zeitstempel", "admin-worker.js",
   "      camp.feedback.splice(pos, 0, { antworten });",
   "      camp.feedback.splice(pos, 0, { antworten, am: new Date().toISOString() });"],

  ["Die Antwort traegt die Anmeldungs-Id", "admin-worker.js",
   "      camp.feedback.splice(pos, 0, { antworten });",
   "      camp.feedback.splice(pos, 0, { antworten, anmeldungId: anmeldung.id });"],

  ["Die Antwort landet immer hinten, nicht an zufaelliger Stelle", "admin-worker.js",
   "      const pos = Math.floor(Math.random() * ((camp.feedback || []).length + 1));\n      camp.feedback.splice(pos, 0, { antworten });",
   "      camp.feedback.push({ antworten });"],

  ["feedbackAm bekommt eine Uhrzeit auf die Sekunde", "admin-worker.js",
   "      anmeldung.feedbackAm = fcHeuteBerlin();",
   "      anmeldung.feedbackAm = new Date().toISOString();"],

  ["Es entsteht doch ein Verlaufseintrag mit Zeitstempel", "admin-worker.js",
   "      const pos = Math.floor(Math.random() * ((camp.feedback || []).length + 1));",
   '      fcVerlaufNotiz(camp, { was: "feedback", nr: anmeldung.nummer || 0 });\n      const pos = Math.floor(Math.random() * ((camp.feedback || []).length + 1));'],

  ["Dieselbe Familie darf zweimal antworten", "admin-worker.js",
   '      if (anmeldung.feedbackAm) throw new FcFehler("Für diese Anmeldung liegt schon eine Antwort vor. Vielen Dank!", 409);',
   "      void anmeldung.feedbackAm;"],

  ["Ein leerer Bogen wird angenommen", "admin-worker.js",
   '  if (!inhalt) throw new FcFehler("Bitte beantworte mindestens eine Frage.", 400);',
   "  void inhalt;"],

  ["Unbekannte Fragen werden mitgespeichert", "admin-worker.js",
   "function fcFeedbackPruefen(roh) {\n  const ant = {};",
   "function fcFeedbackPruefen(roh) {\n  const ant = Object.assign({}, roh);"],

  ["Eine Note ausserhalb der Skala wird uebernommen", "admin-worker.js",
   "      if (FC_FEEDBACK_NOTEN.includes(n)) { ant[f.id] = n; inhalt++; }",
   "      if (Number.isFinite(n)) { ant[f.id] = n; inhalt++; }"],

  ["Der Bogen gibt den Kindernamen mit heraus", "admin-worker.js",
   "      fragen: FC_FEEDBACK_FRAGEN,",
   "      kind: fcKindName(anmeldung),\n      fragen: FC_FEEDBACK_FRAGEN,"],

  ["Der Bogen oeffnet schon waehrend des Camps", "admin-worker.js",
   '    if (!camp.bisDatum || camp.bisDatum >= fcHeuteBerlin()) {\n      return json({ error: "Dieses Camp läuft noch. Der Bogen öffnet nach dem letzten Camptag." }, 410, corsHeaders);',
   '    if (false) {\n      return json({ error: "Dieses Camp läuft noch. Der Bogen öffnet nach dem letzten Camptag." }, 410, corsHeaders);'],

  // ---------- 7. Auswertung und Aufraeumen ----------
  ["Der Schnitt wird nicht mehr gerundet", "admin-worker.js",
   "    schnitte[id] = noten[id].anzahl\n      ? Math.round((noten[id].summe / noten[id].anzahl) * 10) / 10\n      : null;",
   "    schnitte[id] = noten[id].anzahl\n      ? noten[id].summe / noten[id].anzahl\n      : null;"],

  ["Ohne Antwort kommt NaN statt null heraus", "admin-worker.js",
   "    schnitte[id] = noten[id].anzahl\n      ? Math.round((noten[id].summe / noten[id].anzahl) * 10) / 10\n      : null;",
   "    schnitte[id] = Math.round((noten[id].summe / noten[id].anzahl) * 10) / 10;"],

  ["Das Aufraeumen laesst die Freitexte stehen", "admin-worker.js",
   '          if (f.typ !== "text" && e && e.antworten && e.antworten[f.id] !== undefined) {',
   "          if (e && e.antworten && e.antworten[f.id] !== undefined) {"],

  ["Die Auswertung geht auch ohne Bearbeiten-Recht heraus", "admin-worker.js",
   "    if (ctx.canEdit) sicht.feedback = fcFeedbackAuswertung(c);",
   "    sicht.feedback = fcFeedbackAuswertung(c);"],

  ["Die verschickten Boegen werden nicht mehr gezaehlt", "admin-worker.js",
   "  const gebeten = (camp.anmeldungen || []).filter((a) => a && a.feedbackGebetenAm).length;",
   "  const gebeten = 0;"],

  // ---------- 8. Client ----------
  ["Die Fragenliste im Client laeuft von der im Worker weg", "config.js",
   '{ id: "essen",        typ: "note",   frage: "Verpflegung und Essen" },',
   '{ id: "verpflegung",  typ: "note",   frage: "Verpflegung und Essen" },'],

  ["Die Notenskala im Client wird umgedreht", "config.js",
   '  { wert: 1, label: "sehr gut" },',
   '  { wert: 6, label: "sehr gut" },'],

  ["Die Skala im Client verliert die 6", "config.js",
   '  { wert: 6, label: "ungenügend" }',
   '  { wert: 5, label: "ungenügend" }'],

  ["Die Verteilung bleibt bei fuenf Plaetzen stehen", "admin-worker.js",
   "verteilung: FC_FEEDBACK_NOTEN.map(() => 0) };",
   "verteilung: [0, 0, 0, 0, 0] };"],

  ["Die Note landet ueber n-1 statt ueber ihren Platz in der Liste", "admin-worker.js",
   "        noten[f.id].verteilung[FC_FEEDBACK_NOTEN.indexOf(n)]++;",
   "        noten[f.id].verteilung[n - 2]++;"],

  ["feedback.js liest den ersten Knopf statt den gedrueckten", "feedback.js",
   'const gewaehlt = document.querySelector(`input[data-frage="${CSS.escape(f.id)}"]:checked`);',
   'const gewaehlt = document.querySelector(`input[data-frage="${CSS.escape(f.id)}"]`);'],

  ["Der Feedback-Reiter steht ploetzlich allen Angemeldeten offen", "index.html",
   '<button data-tab="feedback" class="editor-only hidden">Feedback</button>',
   '<button data-tab="feedback">Feedback</button>'],

  ["Bei Rechteverlust bleibt die Feedback-Auswertung im DOM stehen", "app.js",
   '    leere("fb-inhalt");\n  }',
   "  }"],

  ["feedback.html darf in Suchmaschinen", "feedback.html",
   '<meta name="robots" content="noindex, nofollow" />',
   ""],

  // ---------- 9. Mailvorlagen ----------
  ["Der Pflicht-Baustein-Check faellt weg", "admin-worker.js",
   "    const fehlend = (def.pflicht || []).filter((p) => !t.includes(\"{\" + p + \"}\"));",
   "    const fehlend = [];"],

  ["Der Zahlungsblock ist in der Bestaetigung nicht mehr Pflicht", "admin-worker.js",
   'pflicht: ["zahlungsblock", "aendernblock"],\n    betreff: "Anmeldung bestätigt: {camp}",',
   'pflicht: [],\n    betreff: "Anmeldung bestätigt: {camp}",'],

  ["Der Geldblock ist in der Eltern-Absage nicht mehr Pflicht", "admin-worker.js",
   'pflicht: ["geldblock"],\n    betreff: "Absage bestätigt: {camp}",\n    text: `Hallo {eltern},\n\nwir haben deine Absage',
   'pflicht: [],\n    betreff: "Absage bestätigt: {camp}",\n    text: `Hallo {eltern},\n\nwir haben deine Absage'],

  ["Der Feedback-Link ist nicht mehr Pflicht", "admin-worker.js",
   'pflicht: ["feedbacklink"],',
   "pflicht: [],"],

  ["Der Kindername wird im Betreff erlaubt", "admin-worker.js",
   'const FC_MAIL_BETREFF_FELDER = ["camp"];',
   'const FC_MAIL_BETREFF_FELDER = ["camp", "kind"];'],

  ["Ersetzt wird ueber ALLE Platzhalter statt nur die erlaubten", "admin-worker.js",
   "function fcMailFuellen(text, felder, werte) {\n  let out = String(text || \"\");\n  (felder || []).forEach((name) => {",
   "function fcMailFuellen(text, felder, werte) {\n  let out = String(text || \"\");\n  Object.keys(werte || {}).forEach((name) => {"],

  ["Ein fehlendes mailVorlagen raeumt die gespeicherten weg", "admin-worker.js",
   "        mailVorlagen: roh.mailVorlagen === undefined\n          ? ((doc.einstellungen && doc.einstellungen.mailVorlagen) || {})\n          : fcMailVorlagenPruefen(roh.mailVorlagen),",
   "        mailVorlagen: fcMailVorlagenPruefen(roh.mailVorlagen),"],

  ["Eine erfundene Vorlagen-Id wird mitgespeichert", "admin-worker.js",
   "  FC_MAIL_VORLAGEN.forEach((def) => {\n    const eintrag = roh[def.id];",
   "  Object.keys(roh).forEach((__id) => {\n    const def = fcMailVorlageDef(__id) || { id: __id, name: __id, pflicht: [], betreff: \"\", text: \"\" };\n    const eintrag = roh[def.id];"],

  ["Die unveraenderte Vorgabe wird als Kopie eingefroren", "admin-worker.js",
   "    const betreff = sauber.betreff === def.betreff.trim() ? \"\" : sauber.betreff;\n    const text = sauber.text === def.text.trim() ? \"\" : sauber.text;",
   "    const betreff = sauber.betreff;\n    const text = sauber.text;"],

  ["Der Text faellt nicht mehr einzeln auf die Vorgabe zurueck", "admin-worker.js",
   "  return {\n    betreff: betreff || def.betreff,\n    text: text || def.text,",
   "  return {\n    betreff: betreff || def.betreff,\n    text: betreff ? text : def.text,"],

  ["Die Vorlagen gehen auch ohne Administrieren-Recht heraus", "admin-worker.js",
   "    mailVorlagen: ctx.canAdmin ? fcMailVorlagenFuerAdmin(einst) : null,",
   "    mailVorlagen: fcMailVorlagenFuerAdmin(einst),"],

  ["Die Bezahlt-Mail geht an der Vorlage vorbei", "admin-worker.js",
   'const m = fcMailBauen(einst, "bezahlt", fcMailWerte(camp, a, einst));\n  return fcMailSenden(env, a.elternEmail, m.betreff, m.text);',
   'return fcMailSenden(env, a.elternEmail, "Beitrag eingegangen: " + camp.name, "Hallo.");'],

  ["Die Wartelisten-Mail nimmt die Bestaetigungs-Vorlage", "admin-worker.js",
   'const id = a.status === "warteliste" ? "warteliste" : "bestaetigung";',
   'const id = "bestaetigung";'],

  ["Die Verwaltungs-Absage nimmt die Eltern-Vorlage", "admin-worker.js",
   'const id = quelle === "verwaltung" ? "absage-verwaltung" : "absage-eltern";',
   'const id = "absage-eltern";'],

  // ---------- 10. Vorschau ----------
  ["Die Vorschau kann doch absenden", "feedback.js",
   "  if (VORSCHAU) {\n    fehlerBox.textContent = \"Das ist die Vorschau",
   "  if (false) {\n    fehlerBox.textContent = \"Das ist die Vorschau"],

  ["Der Vorschau-Hinweis bleibt versteckt", "feedback.js",
   'document.getElementById("vorschau-hinweis").classList.remove("fc-hidden");',
   "void 0;"],

  ["Der Fragetext im Client laeuft weg", "config.js",
   '{ id: "training",     typ: "note",   frage: "Training und Betreuung durch die Trainer" }',
   '{ id: "training",     typ: "note",   frage: "Training und Betreuung" }'],

  ["Bei Rechteverlust bleibt die Mail-Karte im DOM stehen", "app.js",
   '    leere("mail-vorlagen");\n    leere("mail-platzhalter-liste");',
   "    void 0;"],

  ["leseMailVorlagen liefert ein leeres Objekt statt undefined", "app.js",
   "  if (!ziel || !liste.length) return undefined;",
   "  if (!ziel || !liste.length) return {};"],

  ["Leerer Kasten liefert {} und raeumt damit alle Vorlagen weg", "app.js",
   "  if (!gefunden) return undefined;\n  return raus;",
   "  return raus;"],

  // ---------- 11. "Keine" ist eine Nicht-Angabe ----------
  // ⚠️ Die gefaehrlichste Verschlechterung ueberhaupt: ein Teilstueck-
  // Vergleich verschluckt "keine Nuesse" -- also genau die Allergie, wegen der es
  // die Liste am Sportplatz gibt.
  ["Aus dem Volltreffer wird ein Anfangsvergleich (verschluckt 'keine Nuesse')", "app.js",
   "  return LEERE_ANGABEN.includes(w);",
   "  return LEERE_ANGABEN.some((x) => w.startsWith(x));"],

  ["Aus dem Volltreffer wird ein Teilstueck-Vergleich", "app.js",
   "  return LEERE_ANGABEN.includes(w);",
   "  return LEERE_ANGABEN.some((x) => w.includes(x));"],

  ["Die Nicht-Angaben werden wieder angezeigt", "app.js",
   'istLeereAngabe(t.allergien) ? "" : "Allergien: " + t.allergien,',
   't.allergien ? "Allergien: " + t.allergien : "",'],

  ["Gross- und Kleinschreibung zaehlt wieder ('Keine' rutscht durch)", "app.js",
   "  const w = String(wert).trim().toLowerCase()",
   "  const w = String(wert).trim()"],

  // ---------- 12. Verwaltung korrigiert eine Anmeldung ----------
  ["Ein am Camp abgeschaltetes Feld wird doch geschrieben", "admin-worker.js",
   '          if (!def.fest && ((camp.felder || {})[id] || "aus") === "aus") return;',
   '          if (!def.fest && (camp.felder || {})[id] === "aus") return;'],

  ["Ein kaputtes Datum wird ungeprueft gespeichert", "admin-worker.js",
   '            if (def.typ === "datum") wert = fcDatum(wert);',
   "            void 0;"],

  ["Eine kaputte Mailadresse geht durch", "admin-worker.js",
   'if (def.typ === "email" && wert &&',
   "if (false &&"],

  ["Ja/Nein nimmt beliebigen Text an", "admin-worker.js",
   '            wert = roheingabe === true ? "ja" : (roheingabe === "ja" || roheingabe === "nein" ? roheingabe : "");',
   "            wert = String(roheingabe || \"\");"],

  ["Der Kindername laesst sich leeren", "admin-worker.js",
   'if (def.fest && def.typ !== "haken" && !wert) {',
   "if (false) {"],

  ["Die Korrektur hinterlaesst keine Spur im Verlauf", "admin-worker.js",
   "      if (feldGeaendert.length) {",
   "      if (false) {"],

  ["Der Verlauf merkt sich auch die alten WERTE", "admin-worker.js",
   "          if (fcWertSchluessel(a[id]) !== fcWertSchluessel(wert)) feldGeaendert.push(id);",
   "          if (fcWertSchluessel(a[id]) !== fcWertSchluessel(wert)) feldGeaendert.push(id + \":\" + a[id] + \"->\" + wert);"],

  ["Eine Zusatzantwort entsteht auch ohne Zusatzfrage", "admin-worker.js",
   "      if (roh.zusatzantwort !== undefined && camp.zusatzfrage) {",
   "      if (roh.zusatzantwort !== undefined) {"],

  ["Der Bearbeiten-Modus bleibt beim naechsten Oeffnen stehen", "app.js",
   "  // Zweck verloren.\n  anmBearbeiten = false;",
   "  // Zweck verloren."],

  ["Die Knopf-Beschriftung faellt nicht zurueck", "app.js",
   '  if (bearbKnopf) bearbKnopf.textContent = "Bearbeiten";',
   "  void bearbKnopf;"],

  ["Im Bearbeiten-Modus wird die Notiz mit geleert", "app.js",
   "  const nutzlast = { id: anmEntwurf.id };",
   '  const nutzlast = { id: anmEntwurf.id, notiz: wert("ad-notiz") };'],

  ["Das Formular bietet auch abgeschaltete Felder an", "app.js",
   'const felder = FORMULAR_FELDER.filter((f) => f.fest || konf[f.id] === "optional" || konf[f.id] === "pflicht");',
   "const felder = FORMULAR_FELDER.slice();"],

  ["Ja/Nein verliert den Zustand \"nicht beantwortet\"", "app.js",
   '<option value=""${g === "" ? " selected" : ""}>— nicht beantwortet —</option>',
   ""],

  ["Die Anmeldeliste faellt auf den alten Marker zurueck", "app.js",
   "const gesund = [a.allergien, a.medikamente, a.krankheiten, a.essenHinweis].some((w) => !istLeereAngabe(w));",
   "const gesund = [a.allergien, a.medikamente, a.krankheiten, a.essenHinweis].some(Boolean);"]
];

let gefangen = 0;
const durchgerutscht = [];

for (const [name, datei, suche, ersatz, suche2, ersatz2] of MUTATIONEN) {
  for (const s of [suche, suche2]) {
    if (s === undefined) continue;
    if (!ORIG[datei].includes(s)) {
      throw new Error("ABBRUCH: Suchtext dieser Mutation fehlt, sie liefe ins Leere:\n  " + name
        + "\n  Datei: " + datei + "\n  " + JSON.stringify(s));
    }
  }
  // Immer alles frisch schreiben -- sonst schleppte ein Lauf die Mutation des
  // vorigen mit, und ab der zweiten wuerde nichts mehr belegt.
  for (const d of CLIENT_DATEIEN) fs.writeFileSync(join(TMP, d), ORIG[d], "utf8");
  fs.writeFileSync(join(TMP, "admin-worker.js"), ORIG["admin-worker.js"], "utf8");
  let mutiert = ORIG[datei].replace(suche, ersatz);
  if (suche2 !== undefined) mutiert = mutiert.replace(suche2, ersatz2);
  fs.writeFileSync(join(TMP, datei), mutiert, "utf8");

  let rot = false, wie = "";
  try {
    execFileSync(process.execPath, [PRUEF, join(TMP, "admin-worker.js")],
      { env: { ...process.env, FC_APP_DIR: TMP }, stdio: "pipe" });
  } catch (e) {
    rot = true;
    wie = String(e.stdout || "").includes("Zusagen erfuellt") ? "rot" : "abgebrochen";
  }
  if (rot) { gefangen++; console.log(`  ok  gefangen (${wie}): ${name}`); }
  else { durchgerutscht.push(name); console.log("  X   DURCHGERUTSCHT: " + name); }
}

console.log(`\n${gefangen}/${MUTATIONEN.length} Mutationen gefangen.`);
fs.rmSync(TMP, { recursive: true, force: true });
if (durchgerutscht.length) process.exit(1);
