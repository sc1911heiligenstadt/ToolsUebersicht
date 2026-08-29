// Prueft den Reiniger fuer freien Text im Kinderschutz-Modul.
//
//   node pruef-ks-html.mjs                 # 49 Zusagen
//   node pruef-ks-html.mjs --mutation      # zeigt, dass die Zusagen rot werden koennen
//   node pruef-ks-html.mjs <pfad-zum-worker>
//   WORKER_DATEI=<pfad> node pruef-ks-html.mjs
//
// ⚠️ Der Code wird AUS admin-worker.js GEZOGEN (new Function), nicht nachgebaut.
// Fehlt eine Marke, bricht der Lauf ab statt gruen zu melden.
//
// ⚠️ Warum das hier zaehlt: konzept.html und datenschutzHtml werden vom Client mit
// innerHTML gezeichnet -- in der Kinderschutz-App UND in Trainerdaten, dort neben
// dem Unterschriftenfeld. Schreiben darf sie, wer Bearbeiten auf kinderschutz hat.

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

const BLOCK = schneide("const KS_HTML_ERLAUBT = new Set([",
  "// ---------- Aktion: Info", "ksHtmlSicher");

function lade(quelle) {
  return new Function(quelle + "\nreturn { ksHtmlSicher, ksKonzeptSicher, KS_HTML_ERLAUBT };")();
}

// Der echte Konzepttext aus der App — die Gegenprobe, dass nichts kaputtgeht.
const VORGABE = readFileSync("E:/kinderschutz/inhalte-vorgabe.js", "utf8");
const zaehle = (t, tag) => (t.match(new RegExp("<" + tag + "[ >]", "gi")) || []).length;

// ---------------------------------------------------------------------------
function verhalten(m) {
  const rein = m.ksHtmlSicher;
  const z = [];
  const ok = (name, b) => z.push([name, b]);
  // "gefaehrlich" heisst: irgendetwas, das ein Browser ausfuehren wuerde.
  const boese = (t) => /<\s*(script|iframe|object|embed|svg|img|style|form|input)\b/i.test(t)
    || /\son[a-z]+\s*=/i.test(t) || /javascript\s*:/i.test(t);

  // --- A: die klassischen Angriffe
  ok("A1 <script> verschwindet samt Inhalt",     !boese(rein('<script>alert(1)</script>')) && !rein('<script>alert(1)</script>').includes("alert"));
  ok("A2 <SCRIPT> in Grossbuchstaben auch",      !boese(rein('<SCRIPT>alert(1)</SCRIPT>')));
  ok("A3 <img onerror> verschwindet",            !boese(rein('<img src=x onerror="alert(1)">')));
  ok("A4 onclick an einem ERLAUBTEN Tag faellt weg", rein('<p onclick="alert(1)">Hallo</p>') === "<p>Hallo</p>");
  ok("A5 onerror mit Zeilenumbruch davor auch",  !boese(rein('<p\n  onerror="alert(1)">x</p>')));
  ok("A6 <iframe> verschwindet",                 !boese(rein('<iframe src="https://boese.example"></iframe>')));
  ok("A7 <svg onload> verschwindet",             !boese(rein('<svg onload="alert(1)"></svg>')));
  ok("A8 <style> verschwindet samt Inhalt",      !boese(rein('<style>p{background:url(x)}</style>')));
  ok("A9 <form> und <input> verschwinden",       !boese(rein('<form action="https://boese.example"><input name="pw"></form>')));
  ok("A10 verschachteltes <scr<script>ipt> fuehrt zu nichts Ausfuehrbarem", !boese(rein('<scr<script>ipt>alert(1)</script>')));
  ok("A11 style-Attribut faellt weg",            rein('<div style="position:fixed;inset:0">x</div>') === "<div>x</div>");
  ok("A12 unbekanntes Tag faellt weg, Text bleibt", rein("<marquee>Text</marquee>") === "Text");
  ok("A13 Kommentar verschwindet",               rein("<!-- <script>alert(1)</script> -->x") === "x");

  // --- B: Links
  ok("B1 javascript: wird verworfen",            rein('<a href="javascript:alert(1)">x</a>') === "<a>x</a>");
  ok("B2 javascript: mit Grossbuchstaben auch",  rein('<a href="JaVaScRiPt:alert(1)">x</a>') === "<a>x</a>");
  ok("B3 javascript: mit Steuerzeichen auch",    rein('<a href="java\tscript:alert(1)">x</a>') === "<a>x</a>");
  ok("B4 data: wird verworfen",                  rein('<a href="data:text/html,<script>alert(1)</script>">x</a>').startsWith("<a>"));
  ok("B5 https bleibt, mit rel und target",      /^<a href="https:\/\/example\.org" rel="noopener noreferrer" target="_blank">x<\/a>$/.test(rein('<a href="https://example.org">x</a>')));
  ok("B6 mailto bleibt",                         rein('<a href="mailto:a@b.de">x</a>').includes('href="mailto:a@b.de"'));
  ok("B7 tel bleibt",                            rein('<a href="tel:110">x</a>').includes('href="tel:110"'));
  ok("B8 einfache Anfuehrungszeichen zaehlen auch", rein("<a href='javascript:x'>y</a>") === "<a>y</a>");
  // ⚠️ Diese Zusage ist der Grund, warum die Steuerzeichen-Zeile bleibt. Fuer die
  // SICHERHEIT braucht es sie nicht — die Schema-Pruefung laesst im Zweifel weg.
  // Fuer einen Link, der mit einem Leerzeichen aus einem Textfeld kommt, schon.
  ok("B9 Link mit Leerzeichen davor bleibt erhalten", rein('<a href=" https://example.org">y</a>').includes('href="https://example.org"'));

  // --- C: was bleiben MUSS (sonst ist der Fix schlimmer als der Fund)
  ok("C1 Absatz bleibt",         rein("<p>Hallo</p>") === "<p>Hallo</p>");
  ok("C2 Ueberschrift bleibt",   rein("<h3>Titel</h3>") === "<h3>Titel</h3>");
  ok("C3 Liste bleibt",          rein("<ul><li>a</li><li>b</li></ul>") === "<ul><li>a</li><li>b</li></ul>");
  ok("C4 Fettschrift bleibt",    rein("<strong>x</strong>") === "<strong>x</strong>");
  ok("C5 Zeilenumbruch bleibt",  rein("a<br />b") === "a<br>b");
  ok("C6 class bleibt erhalten", rein('<p class="muted">x</p>') === '<p class="muted">x</p>');
  ok("C7 class mit Anfuehrungszeichen-Ausbruch wird entschaerft", !boese(rein('<p class="a\\" onclick=\\"alert(1)">x</p>')));
  // ⚠️ Der Klassenwert MUSS in Anfuehrungszeichen stehen. Ohne sie wuerde aus einem
  // Wert mit Leerzeichen ein ZWEITES Attribut — und Leerzeichen sind erlaubt, weil
  // eine Klassenliste sie braucht.
  ok("C9 Klassenwert mit Leerzeichen wird gequotet, wird kein zweites Attribut",
     rein('<p class="eins onclick=alert(1)">x</p>') === '<p class="eins onclickalert1">x</p>');
  ok("C8 Umlaute bleiben unangetastet", rein("<p>Schutzkonzept für Kinder — größer</p>") === "<p>Schutzkonzept für Kinder — größer</p>");

  // --- D: der echte Bestand darf nicht zerbroeseln
  const echt = /VORGABE_KONZEPT_HTML\s*=\s*`([\s\S]*?)`/.exec(VORGABE);
  if (echt) {
    const vorher = echt[1], nachher = rein(vorher);
    ok("D1 Der echte Konzepttext behaelt alle <p>",      zaehle(vorher, "p") === zaehle(nachher, "p") && zaehle(nachher, "p") > 20);
    ok("D2 ...alle <li>",                                zaehle(vorher, "li") === zaehle(nachher, "li") && zaehle(nachher, "li") > 20);
    ok("D3 ...alle <h3>",                                zaehle(vorher, "h3") === zaehle(nachher, "h3") && zaehle(nachher, "h3") > 5);
    ok("D4 ...alle <strong>",                            zaehle(vorher, "strong") === zaehle(nachher, "strong"));
    ok("D5 ...und verliert keinen sichtbaren Text",       nachher.replace(/<[^>]*>/g, "").trim().length === vorher.replace(/<[^>]*>/g, "").trim().length);
  } else {
    ok("D1 VORGABE_KONZEPT_HTML gefunden", false);
  }

  // --- E: Eigenschaften
  ok("E1 Zweimal reinigen aendert nichts mehr", rein(rein('<p onclick="x">a</p><script>b</script>')) === rein('<p onclick="x">a</p><script>b</script>'));
  ok("E2 Leer und null ergeben einen leeren Text", rein(null) === "" && rein(undefined) === "" && rein("") === "");
  ok("E3 Reiner Text bleibt reiner Text", rein("Nur Text, kein Markup.") === "Nur Text, kein Markup.");
  ok("E4 ksKonzeptSicher reinigt html und laesst Fassung/Stand stehen", (() => {
    const k = m.ksKonzeptSicher({ version: "2.0", standAm: "2026-08-29", html: '<p onclick="x">a</p>', istEntwurf: true });
    return k.version === "2.0" && k.standAm === "2026-08-29" && k.istEntwurf === true && k.html === "<p>a</p>";
  })());
  ok("E5 ksKonzeptSicher vertraegt null", m.ksKonzeptSicher(null) === null);

  return z;
}

// ---------------------------------------------------------------------------
function quelltext() {
  return [
    ["F1 Der Konzepttext wird beim AUSLIEFERN gereinigt", W.includes("konzept: ksKonzeptSicher(doc.konzept),")],
    ["F2 Der Datenschutztext ebenfalls", W.includes("datenschutzHtml: ksHtmlSicher(e.datenschutzHtml)")],
    ["F3 Beide auch beim SPEICHERN", W.includes("datenschutzHtml: ksHtmlSicher(capStr(n.datenschutzHtml, 60000))")
      && W.includes('doc.konzept = ksKonzeptSicher(daten && typeof daten === "object" ? daten : {});')],
    ["F4 Die alte ungereinigte Auslieferung ist weg", !W.includes("konzept: doc.konzept || null,")
      && !W.includes('datenschutzHtml: String(e.datenschutzHtml || "")')],
    ["F5 Der Bild-Pfad setzt nosniff und filtert den Typ",
      /handleKsBildGet[\s\S]*?X-Content-Type-Options[\s\S]*?nosniff/.test(W)
      && /handleKsBildGet[\s\S]*?\["image\/jpeg", "image\/png", "image\/webp"\]/.test(W)],
    ["F6 Verwaiste Anhaenge werden im Nachtlauf geraeumt",
      W.includes("await ksVerwaisteDateienRaeumen(authHeader, doc, mdoc)")
      && W.includes("async function ksVerwaisteDateienRaeumen(")],
    ["F7 ...aber nur, was aelter als die Frist und von nichts gebraucht ist",
      W.includes("const KS_VERWAIST_STUNDEN = 48;")
      && /ksVerwaisteDateienRaeumen[\s\S]*?if \(gebraucht\.has\(teil\)\) continue;/.test(W)
      && /ksVerwaisteDateienRaeumen[\s\S]*?if \(!Number\.isFinite\(alter\) \|\| alter > grenze\) continue;/.test(W)],
    ["F8 Das Kern-Gate ist unveraendert: nur die Beauftragten lesen Meldungen",
      !/function ksDarfMeldungenLesen[\s\S]*?isAdmin[\s\S]*?\n\}/.test(
        schneide("function ksDarfMeldungenLesen", "function ksVerlangeEdit", "Gate"))]
  ];
}

// ---------------------------------------------------------------------------
function melde(zeilen) {
  let rot = 0;
  for (const [name, b] of zeilen) { if (!b) rot++; console.log(`  ${b ? "ok  " : "ROT "} ${name}`); }
  return rot;
}

if (process.argv.includes("--mutation")) {
  const MUT = [
    ["Weisse Liste ausgehebelt (alles erlaubt)", (b) => b.replace("if (!KS_HTML_ERLAUBT.has(tag)) return \"\";", "")],
    ["Attribute werden durchgereicht statt neu gebaut", (b) => b.replace('return "<" + tag + attr + ">";', 'return "<" + tag + rest + ">";')],
    ["script wird nur ohne Inhalt entfernt", (b) => b.replace(/  t = t\.replace\(\/<\\s\*\(script\|style\|iframe[\s\S]*?\n/, "")],
    ["Schema-Pruefung am Link faellt weg", (b) => b.replace("if (/^(https?:\\/\\/|mailto:|tel:)/i.test(ziel)) {", "if (true) {")],
    // ⚠️ Diese drei trafen im ersten Anlauf nur EINE von zwei Schichten und liefen
    // deshalb ins Leere. Das sah aus wie eine blinde Zusage, war aber in Wahrheit
    // doppelte Absicherung. Jetzt nehmen sie den ganzen Stapel weg.
    ["Steuerzeichen im Link bleiben stehen (trifft B9)", (b) => b.replace('.replace(/[\\s\\u0000-\\u001f\\u007f]/g, "");', ";")],
    ["img erlaubt UND aus der Pauschal-Liste genommen", (b) =>
      b.replace('"ul", "ol", "li", "h2", "h3", "h4", "blockquote", "a", "span", "div"',
                '"ul", "ol", "li", "h2", "h3", "h4", "blockquote", "a", "span", "div", "img"')
       .replace("|link|meta|base|img|picture", "|link|meta|base|picture")],
    ["Kommentare bleiben stehen", (b) => b.replace('  t = t.replace(/<!--[\\s\\S]*?-->/g, "");\n', "")],
    ["Klassenwert ohne Anfuehrungszeichen (trifft C9)", (b) =>
      b.replace("attr += ' class=\"' + wert + '\"';", 'attr += " class=" + wert;')]
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
console.log("A–E — was der Reiniger tut");
const rot1 = melde(verhalten(m));
console.log("\nF — was im Quelltext stehen muss");
const rot2 = melde(quelltext());
const n = verhalten(m).length + quelltext().length;
console.log(`\n${n - rot1 - rot2}/${n} Zusagen gruen, ${rot1 + rot2} rot.`);
process.exit(rot1 + rot2 ? 1 : 0);
