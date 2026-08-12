const APP_VERSION = "1.0";

// WhatsApp-Kontakt für die Hilfe-Kachel im Feedback-Tab (intl. Format ohne "+"/Leerzeichen,
// direkt für eine wa.me-URL nutzbar — siehe setupWhatsappLink() in app.js).
const WHATSAPP_CONTACT = "491778587294";

// Statische Stammdaten aller Tool-Links. Die Sichtbarkeit (visible) wird NICHT
// hier gepflegt, sondern zur Laufzeit vom Admin-Worker geladen/überschrieben
// (siehe admin-worker.js) — nur die Existenz eines Tools + seine Metadaten
// ändern sich hier, das braucht einen Code-Push.
//
// Eine Versionsnummer je Tool gibt es hier bewusst NICHT mehr (2026-08-03): die
// Kacheln zeigen keine, das Badge im Kopfbereich ist weg, und damit hätte das Feld
// nur noch Pflegeaufwand ohne Anzeige bedeutet. Die einzige Versionsangabe der
// Übersicht steht im Info-Tab (APP_VERSION + APP_CHANGELOG unten).
//
// Aus demselben Grund gibt es seit 2026-08-10 auch kein Feld `devices` mehr
// (Michel-Vorgabe): die 📱/💻-Symbole oben rechts auf der Kachel sind entfallen,
// damit war das Feld Pflegeaufwand ohne Anzeige. Soll je wieder ein Gerätehinweis
// erscheinen, kommen Feld UND Anzeige zusammen zurück, nicht das Feld allein.
//
// Optionales Flag `mail: true` -> Briefumschlag-Symbol unten links auf der Kachel
// (siehe renderToolGrid() in app.js). Es markiert Werkzeuge, die im Betrieb
// tatsächlich E-Mails nach außen verschicken -- damit vor dem Klick sichtbar ist,
// wo eine Handlung beim Empfänger im Postfach landet. **Maßgeblich ist der
// admin-worker.js**, dort laufen ALLE Mails der Flotte über Brevo: vier
// Sendestellen (`raumnutzung-mail-antrag`, `notify-user` -> Vereinskalender,
// `vereinsaufgabe-anlegen`, `beleg-eingang-notify` -> Beleg-Eingang, ausgelöst
// vom Worker sc-heiligenstadt-beleg-upload). Kommt eine Sendestelle dazu oder
// weg, muss dieses Flag mitgezogen werden -- es gibt keine automatische
// Verbindung zwischen Worker und Kachel.
//
// Optionales Flag `push: true` -> Glocken-Symbol daneben (seit 2026-08-03).
// Gleiche Logik, anderer Kanal: es markiert Werkzeuge, in denen eine Handlung
// eine Push-Nachricht auf die Handys der Betroffenen auslöst.
//
// ⚠️ Es markiert die AUSLÖSENDE Kachel, nicht die empfangende -- genau wie
// `mail`, wo `beleg-eingang` das Flag trägt und nicht `geschaeftsstelle`.
// Deshalb steht es bei `fahrtenbuch-extern` (dort wird eingereicht) und NICHT
// bei `fahrtenbuch` (dort landet die Meldung nur). Wer das umdreht, muss beide
// Flags umdrehen, sonst widersprechen sich die beiden Symbole.
//
// Maßgeblich sind PUSH_ANLAESSE in admin-worker.js **plus** die Stelle, die den
// Versand tatsächlich auslöst. Der Anlass "unterschriften" hat bewusst keine
// Kachel: er gehört zur Tools-Übersicht selbst. Dieselbe Handpflege wie bei
// `mail` -- es gibt keine automatische Verbindung zwischen Worker und Kachel.
const TOOLS = [
  {
    id: "trainerdaten",
    name: "Trainerdaten",
    description: "Trainer-Stammdaten erfassen, Trainerverträge automatisch als Word-Dokument erzeugen und digital unterschreiben, dazu Führerschein, Führungszeugnis und Trainerlizenz zentral hochladen und verwalten.",
    url: "https://sc1911heiligenstadt.github.io/Trainerdaten/",
    icon: "📝",
    category: "Verein"
  },
  {
    id: "vereinsverwaltung",
    name: "Vereinsverwaltung",
    description: "Mitglieder, Beiträge und Vereinsfinanzen an einer Stelle — mit Sparten, Haushalten und Beitragsklassen. Löst den GLS Vereinsmeister ab. Abteilungsleitungen sehen ausschließlich ihre eigene Sparte, ohne Bankdaten.",
    url: "https://sc1911heiligenstadt.github.io/vereinsverwaltung/",
    icon: "👥",
    category: "Verein"
  },
  {
    // Eigene Kachel für den öffentlichen Teil der Vereinsverwaltung -- dasselbe
    // Muster wie `fahrtenbuch-extern` neben `fahrtenbuch`. Sie führt auf eine
    // Seite OHNE Anmeldung: wer Mitglied werden will, hat noch kein Konto.
    // ⚠️ Sie gehört deshalb im Sichtbarkeits-Panel auf "Öffentlich" -- steht sie
    // auf "eingeloggt", erreicht sie genau die Leute nicht, für die sie da ist.
    id: "mitgliedsantrag",
    name: "Mitgliedsantrag",
    description: "Aufnahmeantrag zum Ausfüllen und Unterschreiben am Handy — ohne Anmeldung, ohne Ausdruck. Der Antrag geht an die Geschäftsstelle; über die Aufnahme entscheidet nach § 4 der Satzung der Gesamtvorstand.",
    url: "https://sc1911heiligenstadt.github.io/vereinsverwaltung/antrag.html",
    icon: "🙋",
    category: "Verein"
  },
  {
    // Zweite öffentliche Kachel der Vereinsverwaltung, neben
    // `mitgliedsantrag`. Eigene Seite statt einer Weiche im Antrag
    // (Michel-Entscheidung 2026-08-06): Eltern sollen einen Link bekommen,
    // hinter dem alles steht, was der Verein für ein neues Nachwuchskind
    // braucht — nicht ein allgemeines Formular mit einem Fußball-Abschnitt.
    // ⚠️ Gehört wie der Mitgliedsantrag im Sichtbarkeits-Panel auf
    // "Öffentlich". Eltern eines Neuzugangs haben kein Vereinskonto; steht
    // sie auf "eingeloggt", erreicht sie genau die Leute nicht, für die sie
    // da ist.
    id: "nachwuchs-anmeldung",
    name: "Anmeldung Nachwuchs",
    description: "Neue Jugendspieler in einem Durchgang anmelden: Aufnahmeantrag nach § 4 und Antrag auf Spielerlaubnis beim Thüringer Fußball-Verband, unterschrieben am Handy. Nachweise wie Geburtsurkunde oder Spielerpass lassen sich als Foto mitschicken.",
    url: "https://sc1911heiligenstadt.github.io/vereinsverwaltung/nachwuchs.html",
    icon: "⚽",
    category: "Verein"
  },
  {
    id: "vereinsaufgaben",
    name: "Vereinsaufgaben",
    description: "Aufgaben an Funktionäre vergeben — mit verbindlicher Frist, Zuständigkeit über Ressorts, Abnahme und dauerhaft einsehbarer Historie. Zeigt auf einen Blick, wer was offen hat und wo etwas liegen bleibt.",
    url: "https://sc1911heiligenstadt.github.io/Vereinsaufgaben/",
    icon: "🗂️",
    category: "Verein",
    mail: true,
    push: true
  },
  {
    id: "trainercheckliste",
    name: "TrainerCheckliste",
    description: "Digitale Checkliste für Trainerzu- und -abgang im Nachwuchsbereich.",
    url: "https://sc1911heiligenstadt.github.io/TrainerCheckliste/",
    icon: "📋",
    category: "Verein"
  },
  {
    id: "materialliste",
    name: "Materialliste",
    description: "Vereinsmaterial (Trikots, Bälle, Leibchen) pro Mannschaft verwalten.",
    url: "https://sc1911heiligenstadt.github.io/Materialliste/",
    icon: "🎽",
    category: "Verein"
  },
  {
    id: "sc1911-anmeldung",
    name: "Trainerversammlung-Anmeldung",
    description: "Digitales Anmeldesystem für Trainerversammlungen beim 1. SC 1911 Heiligenstadt.",
    url: "https://sc1911heiligenstadt.github.io/sc1911-anmeldung/verwaltung.html",
    icon: "🗳️",
    category: "Verein"
  },
  {
    id: "vereinsbudget",
    name: "Vereinsbudget",
    description: "Budgetübersicht, Einnahmen/Ausgaben und Belegverwaltung für den Kassierer.",
    url: "https://sc1911heiligenstadt.github.io/sc-heiligenstadt-budget/vereinsbudget.html",
    icon: "💶",
    category: "Verein"
  },
  {
    id: "beleg-eingang",
    name: "Beleg-Eingang",
    description: "Mobiles Formular für Helfer zum Einreichen von Belegen.",
    url: "https://sc1911heiligenstadt.github.io/sc-heiligenstadt-budget/beleg-eingang.html",
    icon: "🧾",
    category: "Verein",
    mail: true
  },
  {
    id: "geschaeftsstelle",
    name: "Geschäftsstelle",
    description: "Eingegangene Belege prüfen, korrigieren und als geprüft markieren — ohne Einblick in die Budgetplanung.",
    url: "https://sc1911heiligenstadt.github.io/sc-heiligenstadt-budget/geschaeftsstelle.html",
    icon: "📋",
    category: "Verein"
  },
  {
    id: "spielertool-test",
    name: "Spielertool",
    description: "Bewertung und Förderung von Nachwuchsspielern im Vereinsbetrieb.",
    url: "https://sc1911heiligenstadt.github.io/spielertool-test/",
    icon: "⚽",
    category: "Verein"
  },
  {
    id: "vereinskalender",
    name: "Vereinskalender",
    description: "Kommende Vereinstermine im Überblick (gesperrte Hallen/Plätze, Trainingszeiten, Veranstaltungen) — Pflege durch die Geschäftsstelle.",
    url: "https://sc1911heiligenstadt.github.io/vereinskalender/",
    icon: "📅",
    category: "Verein",
    mail: true,
    push: true
  },
  {
    id: "platzbelegung",
    name: "Platzbelegung",
    description: "Belegungsplan für Trainingsplätze und Halle — wer nutzt wann welchen Platz.",
    url: "https://sc1911heiligenstadt.github.io/platzbelegung/",
    icon: "🏟️",
    category: "Verein"
  },
  {
    id: "spielersichtung",
    name: "Spielersichtung",
    description: "Sichtung und Bewertung von Nachwuchsspielern für Kader- und Förderentscheidungen.",
    url: "https://sc1911heiligenstadt.github.io/spielersichtung/",
    icon: "🔍",
    category: "Verein"
  },
  {
    id: "personalkosten",
    name: "Personalkosten",
    description: "Personalkosten / Aufwandsentschädigungen der Mannschaften planen und auswerten (nur für berechtigte Gruppe).",
    url: "https://sc1911heiligenstadt.github.io/Personalkosten/",
    icon: "💶",
    category: "Verein"
  },
  {
    id: "kadermanager",
    name: "Kadermanager",
    description: "Vereinsinterne Alternative zu SpielerPlus: Termine mit An-/Abmeldung, Aufgaben, Aufstellung/Taktikboard, Spielberichte, Urlaub/Krank, Umfragen und Mannschaftskasse je Mannschaft.",
    url: "https://sc1911heiligenstadt.github.io/kadermanager/",
    icon: "⚽",
    category: "Verein"
  },
  {
    id: "busplan",
    name: "Busplan",
    description: "Bus-/Transportplanung für die Auswärtsspiele der Nachwuchsmannschaften (nur für berechtigte Gruppe).",
    url: "https://sc1911heiligenstadt.github.io/busplan/",
    icon: "🚌",
    category: "Verein"
  },
  {
    id: "digitaler-stempel",
    name: "Digitaler Stempel",
    description: "PDF- und Word-Dokumente digital stempeln (Position, Größe, Drehung und Deckkraft frei wählbar) — jede Stempelung wird mit Nutzer und Zeitpunkt archiviert (nur für berechtigte Gruppe).",
    url: "https://sc1911heiligenstadt.github.io/digitaler-stempel/",
    icon: "🖋️",
    category: "Verein"
  },
  {
    id: "kleiderbestellung",
    name: "Kleiderbestellung",
    description: "Trainer:innen bestellen Vereinskleidung/-ausrüstung mit ihrer Größe aus einem Artikelkatalog; Admin verwaltet Katalog und Bestellfenster und exportiert eine Lieferanten-Bestellliste.",
    url: "https://sc1911heiligenstadt.github.io/kleiderbestellung/",
    icon: "👕",
    category: "Verein"
  },
  {
    id: "fahrtenbuch",
    name: "Fahrtenbuch",
    description: "Digitale Fahrer-Checkliste für Vereinsfahrzeuge: Fahrt mit Fahrzeug-/Fahrtdaten und Sicherheits-Checklisten erfassen, Mängel mit Fotos hochladen, unterschreiben.",
    url: "https://sc1911heiligenstadt.github.io/fahrtenbuch/",
    icon: "🚐",
    category: "Verein"
  },
  {
    id: "fahrtenbuch-extern",
    name: "Fahrtenbuch (extern)",
    description: "Für Eltern ohne Vereinskonto: Fahrt mit einem Vereinsfahrzeug eintragen und Führerschein-Kopie hochladen — zugriffscode-geschützt statt Login.",
    url: "https://sc1911heiligenstadt.github.io/fahrtenbuch/extern.html",
    icon: "🔗",
    category: "Verein",
    push: true
  },
  {
    id: "spiele",
    name: "Spiele",
    description: "Mini-Spiele-Sammlung fürs Team: Auto-, Fußball- und Fußball-Vereine-Quartett, Der Maulwurf als Verräterspiel und Depot-Duell als Börsenspiel mit Spielgeld (beide auch solo gegen KI) — ideal für die Busfahrt zur Auswärtsfahrt.",
    url: "https://sc1911heiligenstadt.github.io/spiele/",
    icon: "🎮",
    category: "Verein"
  },
  {
    id: "materialbedarf",
    name: "Materialbedarf",
    description: "Trainer:innen melden Materialbedarf (z.B. neue Bälle, Erste-Hilfe-Set) an den Verein; Admin entscheidet über Annahme/Ablehnung und verfolgt danach Bestellung und Verteilung.",
    url: "https://sc1911heiligenstadt.github.io/materialbedarf/",
    icon: "🛒",
    category: "Verein",
    push: true
  },
  {
    id: "raumnutzung",
    name: "Raumnutzung",
    description: "Anträge auf Raumnutzung für Veranstaltungen (Landkreis Eichsfeld) digital erfassen und daraus das ausgefüllte Original-Formular als PDF für das Liegenschaftsamt erzeugen.",
    url: "https://sc1911heiligenstadt.github.io/raumnutzung/",
    icon: "🏛️",
    category: "Verein",
    mail: true,
    push: true
  },
  {
    id: "testspielplaner",
    name: "Testspielplaner",
    description: "Testspiele und Leistungsvergleiche planen: Termin anfragen, Admin genehmigt nach DFBnet-Eintragung, Gegner wird nachgetragen — mit Saison-Kontingent je Trainer.",
    url: "https://sc1911heiligenstadt.github.io/testspielplaner/",
    icon: "🆚",
    category: "Verein",
    push: true
  },
  {
    id: "personalakte",
    name: "Personalakte",
    description: "Zusammengeführte Trainer-Übersicht für die Geschäftsstelle: Stammdaten, Vertrags-/Kodex-Status, Checklisten, Führerschein, Personalkosten und Kadermanager-Rolle auf einen Blick, inkl. Archivieren/Reaktivieren ausgeschiedener Trainer (nur für berechtigte Gruppe).",
    url: "https://sc1911heiligenstadt.github.io/personalakte/",
    icon: "🗂️",
    category: "Verein"
  },
  {
    id: "fotoauftraege",
    name: "Fotoaufträge",
    description: "Das Social-Media-Team fragt Fotos von einer Mannschaft an; der zuständige Trainer legt per Klick einen eigenen, freigegebenen Nextcloud-Ordner für den Bilder-Upload an und bekommt einen teilbaren Link.",
    url: "https://sc1911heiligenstadt.github.io/fotoauftraege/",
    icon: "📸",
    category: "Verein",
    push: true
  },
  {
    id: "abwesenheitskalender",
    name: "Abwesenheitskalender",
    description: "Übersicht, wer wann abwesend ist (Urlaub, Krankheit, Fortbildung u.a.) — jede:r Berechtigte trägt eigene Abwesenheiten ein, alle mit Tool-Zugriff sehen die komplette Übersicht.",
    url: "https://sc1911heiligenstadt.github.io/abwesenheitskalender/",
    icon: "🧳",
    category: "Verein"
  },
  {
    id: "besprechung",
    name: "Besprechung",
    description: "Digitaler Treffpunkt für Trainer: Sprachraum direkt im Browser, inklusive Bildschirm teilen — z. B. für die hybride Trainerversammlung.",
    url: "https://sc1911heiligenstadt.github.io/besprechung/",
    icon: "🎙️",
    category: "Verein",
    newTab: true
  },
  {
    id: "dokumentenvorlagen",
    name: "Dokumentenvorlagen",
    description: "Word-Vorlagen (Trainervertrag, Anfragen, Bescheinigungen) mit Platzhaltern zentral verwalten und in einem Rutsch für viele Empfänger befüllen — Daten aus dem Trainerprofil oder, mit der Stufe „Administrieren“ für Trainerdaten, inkl. Adresse und Bankverbindung; Ausgabe als Word-Dokumente, originalgetreue PDFs über ein beiliegendes Skript (nur für berechtigte Gruppe).",
    url: "https://sc1911heiligenstadt.github.io/dokumentenvorlagen/",
    icon: "📄",
    category: "Verein"
  },
  {
    id: "ausbildungsplan",
    name: "Ausbildungsplan",
    description: "Trainingsschwerpunkte und passende Übungen für jede Altersklasse von den Bambini bis zur U23, auf Grundlage der Trainingsphilosophie Deutschland — dazu der Spieltag als Leistungsnachweis: nach dem Spiel wird je Mannschaft auf einer Ampel bewertet, wie weit das Erlernte bereits umgesetzt wird. Die Auswertung folgt wahlweise der Mannschaft oder dem Geburtsjahrgang, sodass sich die Entwicklung einer Kohorte über mehrere Jahre und Altersstufen hinweg verfolgen lässt.",
    url: "https://sc1911heiligenstadt.github.io/ausbildungsplan/",
    icon: "🎯",
    category: "Verein"
  },
  {
    id: "schulsport",
    name: "Schulsport",
    description: "Wochenplan und Nachweis der Sport- und Fußball-AGs an Schulen und im Hort sowie der Ferien-Camps: Eine AG wird einmal als Serie angelegt, die Termine des Schuljahres entstehen daraus von selbst und lassen Ferien automatisch aus. Nach jeder Einheit meldet der Übungsleiter am Handy, ob sie stattgefunden hat und wie viele Kinder da waren — daraus entsteht auf Knopfdruck der Durchführungsnachweis als PDF, den die Schule über einen Link auch digital gegenzeichnen kann.",
    url: "https://sc1911heiligenstadt.github.io/schulsport/",
    icon: "🏫",
    category: "Verein",
    mail: true,
    push: true
  },
  {
    id: "spieltagscrew",
    name: "Spieltagscrew",
    description: "Wer übernimmt bei den Heimspielen der 1. Mannschaft welchen Posten: Kassenhäuschen, Ordnungsdienst, Grill, Sprecher, Auf- und Abbau. Die Posten werden einmal als Katalog gepflegt und jedem Heimspieltag als eigene Kopie mitgegeben, dort mit benötigter Personenzahl und einem Zeitfenster relativ zum Anstoß. Wer helfen kann, trägt sich selbst ein; frei gebliebene Posten melden sich rechtzeitig von selbst aufs Handy, und zu jedem Spieltag lässt sich ein Aushang mit Namen und Uhrzeiten drucken.",
    url: "https://sc1911heiligenstadt.github.io/spieltagscrew/",
    icon: "🦺",
    category: "Verein",
    push: true
  },
  {
    id: "spielstatistik",
    name: "Spielstatistik",
    description: "Einsätze, Minuten, Tore und Karten der Mannschaften — Saison für Saison. Ein Spiel wird einmal erfasst: Startelf und Bank, Wechsel mit Minute, Tore mit Schütze, Karten und der Grund, warum jemand fehlte. Daraus rechnet die App die gewohnte Tabelle aus Spieltagen und Spielern samt allen Summen, die Vereinsbilanz über die Jahre hinweg und den fertigen Spielbericht als Word-Datei mit Aufstellungsgrafik. Löst die bisherigen Excel-Dateien ab.",
    url: "https://sc1911heiligenstadt.github.io/spielstatistik/",
    icon: "📊",
    category: "Verein"
  },
  {
    id: "ablaufplan",
    name: "Ablaufplan",
    description: "Getaktete Tage des Vereins an einer Stelle: Medientag, Turniertag, Trainingslager, Feriencamp. Ein Ablauf besteht aus Punkten mit Uhrzeit, beteiligten Mannschaften, Ort und einer Notiz zum Mitbringen; die Ansicht ist ein Zeitstrahl mit einer Marke, wo gerade „jetzt“ ist. Wer angemeldet ist, sieht seine eigenen Punkte farbig und kann alles andere ausblenden. Eine fertige Liste lässt sich einfügen, statt jeden Punkt zu tippen, und wenn es am Tag verrutscht, schiebt ein Knopf alles ab einer Stelle um ein paar Minuten. Zum Weitergeben gibt es einen Link, der ohne Anmeldung funktioniert — für Eltern und Spieler.",
    url: "https://sc1911heiligenstadt.github.io/ablaufplan/",
    icon: "⏱️",
    category: "Verein",
    push: true
  }
];

// Als "sensibel" markierte Tools (Baustein 4, Spec klare-rechte-trennung 2026-07-24):
// werden im Sichtbarkeits-Panel in einer eigenen, benannten Sektion gruppiert und je
// Zeile mit einem Warn-Badge versehen, damit Rechte-Zuweisungen hier besonders bewusst
// passieren. Rein visuell -- kein Server-Zwang, keine Sperre. Enthaelt bewusst auch die
// Nicht-Gateway-Apps (vereinsbudget/geschaeftsstelle/sc1911-anmeldung), deren
// Schreibschutz je App separat liegt.
const KRITISCHE_TOOLS = [
  "trainercheckliste", "sc1911-anmeldung", "vereinsbudget", "geschaeftsstelle",
  "spielertool-test", "personalkosten", "kadermanager", "digitaler-stempel",
  "personalakte", "dokumentenvorlagen", "vereinsverwaltung",
  // spielstatistik: hält je Spiel fest, warum jemand fehlte — darunter „verletzt"
  // und „krank". Gesundheitsangaben über erwachsene Spieler, deshalb hier.
  "spielstatistik"
];

// Neuigkeiten über den Kacheln. Werden ausschließlich vom Admin im Einstellungen-Tab
// gepflegt und serverseitig in Nextcloud (news-Key der Config) gespeichert; renderNews()
// läuft erst, wenn die Server-Antwort da ist. Dieses Array ist NUR noch der Fallback für
// den Erstbetrieb (Admin hat noch nie gespeichert) bzw. einen nicht erreichbaren Worker.
// **Bewusst leer** — vorher standen hier 13 alte Meldungen aus dem Juli 2026, die beim
// Laden jedes Mal kurz als Karussell aufblitzten, bevor die echte Server-News sie ersetzte.
// Wer hier wieder etwas einträgt, holt sich dieses Aufblitzen zurück.
// Felder: date "YYYY-MM-DD" | type "neu"|"update"|"fix"|"hinweis" | title | text
//         | toolId (optional; verlinkt auf den passenden TOOLS-Eintrag)
const NEWS = [];

// Feste Auswahl an Reaktions-Emojis unter jeder Neuigkeit. MUSS mit
// NEWS_REACTION_EMOJIS im admin-worker.js übereinstimmen — der Worker validiert
// jeden Klick strikt gegen seine eigene Kopie. Reihenfolge = Anzeigereihenfolge.
const NEWS_REACTION_EMOJIS = ["👍", "❤️", "🎉", "👏", "🔥", "😍", "😮", "😂", "🙏", "💪"];

// Emoji-Auswahl für die Nachricht an alle Handys (seit 2026-08-07). Bewusst NICHT
// NEWS_REACTION_EMOJIS wiederverwendet: das sind Reaktionen (Zustimmung, Applaus),
// hier geht es um den ANLASS einer Mitteilung -- Absage, Wetter, Anfahrt, Platz.
// Rein clientseitig, der Worker kennt die Liste nicht und muss sie nicht kennen:
// eingefügt wird nur Text in ein Textfeld, das ohnehin frei geschrieben wird.
// `name` steht im title und im aria-label -- ohne ihn wäre der Knopf für
// Vorlese-Programme namenlos.
const MITTEILUNG_EMOJIS = [
  { e: "⚠️", name: "Achtung" },
  { e: "❌", name: "Fällt aus" },
  { e: "✅", name: "Findet statt" },
  { e: "ℹ️", name: "Hinweis" },
  { e: "📢", name: "Ankündigung" },
  { e: "🔔", name: "Erinnerung" },
  { e: "📅", name: "Termin" },
  { e: "⏰", name: "Uhrzeit" },
  { e: "⚽", name: "Fußball" },
  { e: "🥅", name: "Tor" },
  { e: "🏆", name: "Pokal" },
  { e: "🏟️", name: "Stadion" },
  { e: "🚌", name: "Bus" },
  { e: "🚗", name: "Fahrgemeinschaft" },
  { e: "🅿️", name: "Parken" },
  { e: "🌧️", name: "Regen" },
  { e: "⛈️", name: "Gewitter" },
  { e: "❄️", name: "Schnee und Frost" },
  { e: "☀️", name: "Sonne" },
  { e: "🚧", name: "Baustelle" },
  { e: "🔒", name: "Gesperrt" },
  { e: "🔑", name: "Schlüssel" },
  { e: "🎉", name: "Feier" },
  { e: "🎂", name: "Geburtstag" },
  { e: "👏", name: "Applaus" },
  { e: "💪", name: "Anfeuern" },
  { e: "🙏", name: "Bitte" },
  { e: "👍", name: "Daumen hoch" },
  { e: "📸", name: "Foto" },
  { e: "📝", name: "Formular" },
  { e: "🍽️", name: "Essen" },
  { e: "💧", name: "Trinken" },
  { e: "👕", name: "Kleidung" },
  { e: "🚑", name: "Erste Hilfe" }
];

const APP_CHANGELOG = [
  {
    version: "1.8",
    groups: [
      {
        title: "Mannschaften: ab jetzt eine einzige Liste",
        items: [
          "Neuer Bereich „Mannschaften“ in den Einstellungen. Dort steht jede Mannschaft genau einmal — mit Kurznamen (B1), langem Namen (B-Junioren 1) und Liga.",
          "An jeder Mannschaft hängen die Leute, die sie betreuen, mit ihrer Rolle: Trainer, Co-Trainer, Torwarttrainer oder Betreuer. So sieht man sofort, welche Mannschaft noch niemanden hat.",
          "Die Liste gilt je Saison. Beim Saisonwechsel einmal „Saison kopieren“ drücken und anpassen — der alte Stand bleibt zum Nachschlagen stehen.",
          "„Vorschlag aus den Profilen“ liest, was heute in den Trainerprofilen steht, fasst gleiche Mannschaften zusammen und schlägt Kurznamen vor. Einträge, die nach einem Altersbereich oder einer Rolle aussehen statt nach einer Mannschaft, werden rot markiert.",
          "Der Schalter „Trainerprofile aus dieser Liste füllen“ ist zunächst AUS. Erst einschalten, wenn die Liste steht: ab dann wird das Feld „Mannschaft(en)“ beim Nutzer berechnet statt getippt — und wer an keiner Mannschaft hängt, hat auch im Profil keine mehr."
        ]
      },
      {
        title: "Alte Schreibweisen in den Daten",
        items: [
          "Für die Umstellung gab es kurzzeitig einen Umschreib-Lauf über die Daten aller Werkzeuge. Er hat nichts mehr gefunden — in den Daten stand keine alte Schreibweise mehr — und ist deshalb wieder ausgebaut.",
          "Das Feld „Frühere Schreibweisen“ an der Mannschaft bleibt. Es dient jetzt nur noch zum Nachschlagen, wie eine Mannschaft früher hieß."
        ]
      }
    ]
  },
  {
    version: "1.7",
    groups: [
      {
        title: "Auswertung: alle benutzten Werkzeuge je Person",
        items: [
          "In der Aktivitäts-Auswertung standen je Person nur die drei meistgenutzten Werkzeuge. Jetzt stehen dort alle, die sie im Monat benutzt hat — weiterhin sortiert, das Häufigste zuerst.",
          "Die Spalte heißt deshalb jetzt „Genutzte Werkzeuge“ statt „Meistgenutzt“."
        ]
      }
    ]
  },
  {
    version: "1.6",
    groups: [
      {
        title: "Neue Kachel „Ablaufplan“",
        items: [
          "Getaktete Tage des Vereins stehen jetzt an einer Stelle: Medientag, Turniertag, Trainingslager, Feriencamp.",
          "Ein Ablauf besteht aus Punkten mit Uhrzeit, beteiligten Mannschaften, Ort und einer Notiz zum Mitbringen. Angezeigt wird er als Zeitstrahl mit einer Marke, wo gerade „jetzt“ ist.",
          "Wer angemeldet ist, sieht die Punkte seiner eigenen Mannschaften farbig und kann alles andere ausblenden.",
          "Zum Weitergeben an Eltern und Spieler gibt es je Ablauf einen Link, der ohne Anmeldung funktioniert — wahlweise gleich auf eine Mannschaft eingestellt."
        ]
      },
      {
        title: "Der nächste Ablauf steht auf der Startseite",
        items: [
          "Über den nächsten Terminen steht eine Zeile mit dem nächsten Ablauf samt Datum und Anzahl der Punkte; ein Klick führt hinein.",
          "Es ist bewusst nur der eine nächste Ablauf und nur eine Zeile — jeder Punkt einzeln hätte die Terminliste daneben verdrängt."
        ]
      },
      {
        title: "Neue Handy-Nachricht: Ablaufplan",
        items: [
          "Wer eine beteiligte Mannschaft im Profil hat, bekommt 15 Minuten vor seinem Punkt eine Erinnerung aufs Handy.",
          "Der Schalter dafür steht wie bei den anderen Anlässen unter „Mein Konto“ und heißt „Ablaufplan — Erinnerung kurz vor meinem eigenen Punkt“."
        ]
      }
    ]
  },
  {
    version: "1.5",
    groups: [
      {
        title: "Handy- und Laptop-Symbole auf den Kacheln entfallen",
        items: [
          "Die kleinen 📱/💻-Symbole oben rechts auf jeder Kachel sind weg — in der Kachel- wie in der Listenansicht. Praktisch alle Werkzeuge lassen sich ohnehin an beiden Geräten bedienen; das Symbolpaar stand auf fast jeder Kachel gleich und sagte damit nichts mehr.",
          "An der Bedienung ändert sich nichts. Der Greifpunkt ⠿ zum Verschieben, die Statushinweise und die Symbole für E-Mail ✉️ und Handy-Nachricht 🔔 bleiben unverändert."
        ]
      }
    ]
  },
  {
    version: "1.4",
    groups: [
      {
        title: "Admin-Dashboard: längere Liste der letzten Anmeldungen",
        items: [
          "Die Karte „Zuletzt aktiv“ heißt jetzt „Zuletzt angemeldet“ und zeigt die zehn jüngsten Anmeldungen statt fünf.",
          "Das Auswahlfeld darüber ist weg. Die drei anderen Listen (Trainervertrag zuletzt eingereicht, Trainerkodex und Jugendschutzkonzept zuletzt bestätigt) entfallen damit — den Stand dazu zeigen weiterhin die Quoten-Kacheln oben und die Personalakte."
        ]
      }
    ]
  },
  {
    version: "1.3",
    groups: [
      {
        title: "Greifpunkt zum Verschieben steht jetzt vorne",
        items: [
          "Beim Anordnen sitzt der Greifpunkt ⠿ dort, wo man hingreift: in der Kachelansicht oben links, in der Listenansicht ganz am Anfang der Zeile. Vorher stand er am rechten Ende, hinter Beschreibung und Symbolen.",
          "An der Bedienung ändert sich sonst nichts — die Geräte-Symbole bleiben rechts, und der Greifpunkt erscheint weiterhin nur, solange „Anordnen“ eingeschaltet ist."
        ]
      }
    ]
  },
  {
    version: "1.2",
    groups: [
      {
        title: "Werkzeug Spieltagscrew",
        items: [
          "Wer bei den Heimspielen der 1. Mannschaft welchen Posten übernimmt, steht jetzt an einer Stelle — Kassenhäuschen, Ordnungsdienst, Grill, Sprecher, Auf- und Abbau.",
          "Die Posten werden einmal als Katalog gepflegt und jedem Spieltag als eigene Kopie mitgegeben. Beim Derby lassen sich dort vier Ordner statt zwei eintragen, ohne dass sich am Katalog etwas ändert — und eine spätere Änderung am Katalog fasst bereits besetzte Spieltage nicht an.",
          "Die Zeiten stehen relativ zum Anstoß. Bei einem Spiel um 13:00 Uhr steht am Kassenhäuschen automatisch eine andere Uhrzeit als bei einem um 15:00 Uhr.",
          "Wer helfen kann, trägt sich selbst ein. Ein voller Posten nimmt niemanden mehr an, und je Spieltag übernimmt jede Person höchstens einen Posten.",
          "Sieben Tage vor dem Spieltag meldet sich die App bei allen, die noch keinen Posten haben — aber nur, wenn wirklich etwas frei ist. Am Vortag bekommt jeder Eingetragene seine eigene Erinnerung mit Posten und Uhrzeit.",
          "Zu jedem Spieltag lässt sich ein Aushang drucken: alle Posten mit Namen und Uhrzeiten, für das Kassenhäuschen oder das Schwarze Brett."
        ]
      }
    ]
  },
  {
    version: "1.1",
    groups: [
      {
        title: "Neuigkeiten räumen sich selbst auf",
        items: [
          "Meldungen verschwinden 14 Tage nach ihrem Datum automatisch — samt angehängter Bilder und Videos und der Reaktionen darauf. Alte Meldungen müssen nicht mehr von Hand gelöscht werden.",
          "Die 14 Tage zählen ab dem Datum, das an der Meldung steht. Wer eine Meldung länger stehen lassen will, setzt ihr Datum einfach neu — dann läuft die Frist von vorn."
        ]
      }
    ]
  },
  {
    version: "1.0",
    groups: [
      {
        title: "Bildschirmvideos für die Neuigkeiten",
        items: [
          "Beim Schreiben einer Meldung gibt es neben „Bild oder Video hinzufügen“ auch „Bildschirmvideo aufnehmen“: eine kurze Vorführung selbst aufzeichnen, statt sie in Worten zu beschreiben.",
          "Unter dem Mauszeiger liegt im Video ein Kreis, und jeder Klick hinterlässt einen kurzen roten Ring — so ist beim Zusehen wirklich zu erkennen, wo gedrückt wurde. Bei einer reinen Bildschirmaufnahme zeichnet der Browser den Mauszeiger nicht mit; ohne diesen Kreis wäre gar nicht zu sehen, wohin die Maus zeigt.",
          "Aufnehmen lässt sich ein einzelnes Vereins-Werkzeug, das Dashboard, die Tools-Übersicht selbst, oder frei ein beliebiges Fenster des Rechners. Die Klick-Kreise gibt es bei den ersten dreien — von Klicks außerhalb des Browsers erfährt eine Internetseite grundsätzlich nichts.",
          "Beginnt die Aufnahme im Rahmen auf dem Dashboard, lässt sich von dort in ein Werkzeug klicken und die Aufnahme läuft mit — so wird ein ganzer Weg am Stück gezeigt, von der Kachel bis in die App. Die Werkzeuge stehen dabei in derselben Reihenfolge zur Wahl, in der sie auch auf der eigenen Übersicht liegen.",
          "Die Länge ist begrenzt und die Bildqualität wird vorher passend eingestellt, damit das fertige Video sicher unter die Anhang-Grenze von 10 MB passt. Während der Aufnahme laufen Zeit und Größe in einer Leiste am unteren Rand mit; diese Leiste wird aus dem Bild herausgeschnitten und steht nicht im fertigen Video.",
          "Die Aufnahme beginnt immer oben auf der Übersicht, obwohl der Knopf im Einstellungen-Bereich steht — sonst wäre das erste Bild jeder Vorführung das Pflege-Formular. Nach dem Beenden geht es automatisch zurück zum angefangenen Meldungs-Entwurf.",
          "Ist die Aufnahme fertig, lässt sie sich ansehen und mit einem Knopf direkt an die Meldung hängen — oder herunterladen, wenn sie woanders gebraucht wird.",
          "Aufgenommen wird als MP4, damit das Video auch auf älteren iPhones abspielt. Auf dem Handy selbst gibt es das Aufnehmen nicht: Bildschirmaufnahme im Browser können nur die Rechner-Browser."
        ]
      },
      {
        title: "Kacheln oder Liste — und die eigene Reihenfolge",
        items: [
          "Über den Werkzeugen steht ein Umschalter: Kacheln oder eine kompakte Liste, in der mehr auf einen Blick zu sehen ist.",
          "Der Knopf „Anordnen“ schaltet das Verschieben ein. Erst dann erscheinen die Greifpunkte, und erst dann lassen sich die Werkzeuge innerhalb ihrer Kategorie umsortieren — mit Maus wie mit dem Finger. Solange angeordnet wird, führt kein Klick versehentlich in ein Werkzeug.",
          "Ansicht und Reihenfolge hängen am Konto, nicht am Browser: am Laptop, am Handy und nach jeder Neuanmeldung steht die Übersicht gleich."
        ]
      },
      {
        title: "Nachricht an alle Handys",
        items: [
          "Administratoren können im Einstellungen-Bereich eine eigene Push-Nachricht schreiben und sofort verschicken — für Kurzfristiges, das zu keinem Werkzeug gehört: Training fällt aus, Platz gesperrt, Halle zu.",
          "Zur Wahl steht, ob nur die Mitarbeiter oder alle Konten einschließlich der Spieler angeschrieben werden.",
          "Unter dem Empfängerkreis steht „Eingrenzen“. Dort lassen sich einzelne Gruppen anhaken (Geschäftsstelle, Trainer, Vorstand …) und zusätzlich einzelne Personen — mit Suchfeld, weil die Liste alle Konten führt. Ohne Haken geht die Nachricht an den ganzen gewählten Kreis.",
          "Die Haken können den Kreis nur verkleinern, nie erweitern. Wer ein Spielerkonto auswählt, während oben „Mitarbeiter — ohne Spielerkonten“ steht, erreicht es nicht — beim Umschalten des Kreises wird es aus der Auswahl genommen und das steht auch da.",
          "Eine Auswahl, die niemanden trifft (leere Gruppe), wird abgelehnt statt stillschweigend an alle zu gehen — der häufigste und teuerste Bedienfehler an dieser Stelle.",
          "Nach dem Absenden fällt die Eingrenzung zurück auf „alle im gewählten Kreis“: sie gilt für die eine Nachricht und soll die nächste nicht heimlich beschneiden.",
          "Vor dem Absenden steht da, wie viele Personen und Geräte gerade wirklich erreicht werden, und wie viele es insgesamt sind — „erreicht 15 von 87 Personen“. Eine Zahl ohne Vergleich klingt nach einer vollständigen Zustellung, und genau das ist sie meistens nicht. Die Sicherheitsabfrage nennt dieselbe Zahl noch einmal, denn zurückholen lässt sich eine Push-Nachricht nicht.",
          "Darunter lassen sich zwei Listen aufklappen: wer die Nachricht bekommt und wer nicht. Die zweite ist die wichtigere — an ihr ist zu sehen, wen man ansprechen muss, damit er die Benachrichtigungen einschaltet. Beide Listen sieht nur, wer die Nachricht auch verschicken darf.",
          "Eine Push-Nachricht erreicht nur, wer die Übersicht als App auf dem Startbildschirm abgelegt und danach in seinem Konto die Benachrichtigungen eingeschaltet hat. Auf dem iPhone gibt es Push ausschließlich für abgelegte Apps, im Safari-Fenster gar nicht.",
          "Unter der Überschrift und unter dem Text steht je ein Knopf „🙂 Emoji“. Ein Druck darauf klappt eine Auswahl auf; ein Druck auf ein Zeichen setzt es genau dort ein, wo die Schreibmarke gerade steht. Zur Wahl stehen die Zeichen, um die es in einer kurzfristigen Mitteilung tatsächlich geht: Achtung, Fällt aus, Findet statt, Termin, Uhrzeit, Bus, Parken, Regen, Gewitter, Frost, Gesperrt, Feier und weitere.",
          "Ein Emoji zählt wie zwei Zeichen. Passt es nicht mehr in die 100 bzw. 200 Zeichen, sagt die App das — angehängt und dann vom Server halbiert würde daraus auf dem Sperrbildschirm ein leeres Kästchen.",
          "Unter „Zuletzt verschickt“ stehen die drei neuesten Nachrichten mit Absender, Zeitpunkt, erreichter Anzahl und der Eingrenzung. Protokolliert werden 30 — eine Push-Nachricht lässt sich nicht zurückholen, wer wann was an alle geschickt hat, ist der Nachweis dahinter.",
          "Empfangen wird sie nur von denen, die im Tab „Mein Konto“ unter „Benachrichtigungen“ den Schalter „Mitteilungen des Vereins“ anhaben. Er ist wie alle anderen von Anfang an eingeschaltet und lässt sich einzeln abstellen."
        ]
      },
      {
        title: "Kachel Mitgliedsantrag",
        items: [
          "Der Aufnahmeantrag der Vereinsverwaltung hat eine eigene Kachel bekommen — sie führt direkt auf das Formular zum Ausfüllen und Unterschreiben am Handy.",
          "Die Kachel ist bewusst öffentlich: wer Mitglied werden will, hat noch kein Vereinskonto. Der Link lässt sich weitergeben und auf der Vereinsseite verlinken.",
          "Ausgefüllt und unterschrieben geht der Antrag an die Geschäftsstelle. Über die Aufnahme entscheidet nach § 4 der Satzung der Gesamtvorstand — der Antrag allein ist noch keine Mitgliedschaft."
        ]
      },
      {
        title: "Kachel Anmeldung Nachwuchs",
        items: [
          "Neue Jugendspieler werden über einen Link angemeldet — Aufnahmeantrag und Antrag auf Spielerlaubnis beim Thüringer Fußball-Verband entstehen daraus zusammen. Zweimal dieselben Angaben einzutragen entfällt.",
          "Die Kachel ist wie der Mitgliedsantrag öffentlich: Eltern eines Neuzugangs haben noch kein Vereinskonto. Der Link lässt sich weitergeben und auf der Vereinsseite verlinken.",
          "Erstausstellung, Vereinswechsel, Rückkehrer und Namensänderung stehen zur Wahl. Beim Wechsel fragt das Formular nach dem bisherigen Verein und danach, ob die Abmeldung schon erfolgt ist oder der Verein sie übernehmen soll.",
          "Die Nachweise, die der Verband als Anlage verlangt, lassen sich als Foto mit dem Handy mitschicken. Sie liegen getrennt von den übrigen Daten und sind nur für die Geschäftsstelle einsehbar.",
          "Aus der eingegangenen Anmeldung erzeugt die Geschäftsstelle das ausgefüllte Verbandsformular auf Knopfdruck — mit den Unterschriften darauf. Zu tun bleibt der Vereinsstempel."
        ]
      },
      {
        title: "Antworten auf Feedback und Wünsche",
        items: [
          "Auf jede Einreichung aus dem Tab „Feedback & Hilfe“ kann jetzt geantwortet werden — direkt beim Eintrag im Einstellungen-Bereich.",
          "Wer etwas eingereicht hat, findet die Antwort im Tab „Feedback & Hilfe“ unter „Meine Einreichungen“, zusammen mit dem eigenen Text und dem Stand (offen oder erledigt).",
          "Zur Antwort kommt eine Push-Nachricht aufs Handy. Sie lässt sich im Tab „Mein Konto“ unter „Benachrichtigungen“ einzeln abschalten wie jeder andere Anlass auch.",
          "Eine Antwort lässt sich nachträglich ändern; das Leeren des Feldes nimmt sie wieder zurück. Eine erneute Push-Nachricht geht nur raus, wenn wirklich neu geantwortet wurde."
        ]
      },
      {
        title: "Werkzeug Schulsport",
        items: [
          "Die Sport- und Fußball-AGs, die der Verein an Schulen und im Hort anbietet, haben ein eigenes Werkzeug — zusammen mit den Fußballcamps in den Ferien.",
          "Eine AG wird einmal als Serie angelegt: Schule, Ort, Wochentag, Uhrzeit und Zeitraum. Alle Termine des Schuljahres entstehen daraus von selbst und lassen Ferien und Feiertage automatisch aus. Camps liegen umgekehrt genau in den Ferien.",
          "Nach jeder Einheit meldet der Übungsleiter am Handy, ob sie stattgefunden hat und wie viele Kinder da waren. Fällt etwas aus, wird der Grund aus einer Liste gewählt.",
          "Daraus entsteht auf Knopfdruck der Durchführungsnachweis als PDF, den Behörden und Fördermittelgeber verlangen. Die Schule kann ihn zusätzlich über einen Link digital gegenzeichnen — ohne eigenen Zugang zu den Vereins-Werkzeugen.",
          "Von den teilnehmenden Kindern wird ausschließlich die Anzahl erfasst. Namen von Schülerinnen und Schülern werden dort nicht gespeichert."
        ]
      },
      {
        title: "Die Übersicht",
        items: [
          "Kachelraster mit allen Vereins-Werkzeugen, nach Kategorie gruppiert. Jede Kachel nennt das geeignete Gerät — Handy, Laptop oder beides.",
          "Die Werkzeuge lassen sich innerhalb ihrer Kategorie neu anordnen, mit Maus wie mit dem Finger — seit 1.5 über den Knopf „Anordnen“ über den Kacheln. Die eigene Reihenfolge hängt am Konto und gilt auf jedem Gerät.",
          "Ein Briefumschlag unten links auf einer Kachel bedeutet: dieses Werkzeug verschickt E-Mails. Die Handlung landet dort also im Postfach eines Empfängers und nicht nur in einer Liste.",
          "Eine Glocke daneben bedeutet: hier kommt eine Handlung als Nachricht auf einem Handy an. Betroffen sind Vereinsaufgaben, Vereinskalender, Testspielplaner, Materialbedarf, Raumnutzung, Fotoaufträge, Schulsport, Spieltagscrew und der externe Fahrtenbuch-Link.",
          "Beide Symbole stehen bei dem Werkzeug, in dem die Nachricht ENTSTEHT — beim Fahrtenbuch also am externen Link, über den eingereicht wird, nicht am Fahrtenbuch selbst.",
          "Nach dem Anmelden steht der eigene Name oben im Kopfbereich, bei Administratoren mit Kennzeichnung.",
          "Ist niemand angemeldet und dadurch keine Kachel sichtbar, erscheint ein Hinweis mit Anmelde-Knopf statt einer leeren Seite.",
          "Kacheln, Verlinkungen aus Neuigkeiten und das Termine-Widget öffnen im selben Tab; jedes Werkzeug hat oben einen Weg zurück zum Dashboard."
        ]
      },
      {
        title: "Als App auf dem Startbildschirm",
        items: [
          "Angemeldete Nutzer finden im Kopfbereich den Knopf „Als App ablegen“. Danach startet die Toolbox wie eine eigene App, ohne Browser-Adressleiste.",
          "Auf Android übernimmt das der Systemdialog. Auf dem iPhone geht es nur über Safari von Hand — der Knopf öffnet dort eine Anleitung: Teilen-Symbol, dann „Zum Home-Bildschirm“.",
          "Ist die App abgelegt, verschwindet der Knopf. Er erscheint auch gar nicht erst, wo der Browser nichts anbieten kann."
        ]
      },
      {
        title: "Neuigkeiten",
        items: [
          "Über den Kacheln laufen die Vereinsneuigkeiten als Karussell: eine Meldung sichtbar, per Pfeil blätterbar, mit Positionsanzeige.",
          "Gepflegt werden sie im Reiter „Einstellungen“ — anlegen, ändern, löschen, mit Typ, Datum, Titel, Text und wahlweise einer Verknüpfung zu einem Werkzeug.",
          "Jede Meldung lässt sich mit einem Emoji bereagieren. Eine Reaktion je Person und Meldung; ein erneuter Klick nimmt sie zurück, ein anderes Emoji wechselt.",
          "Wer mit der Maus über ein Emoji fährt, sieht die Namen der Personen, die so reagiert haben. Am Handy gibt es kein Überfahren, dort bleibt es beim Zähler.",
          "An eine Meldung lassen sich bis zu vier Bilder oder Videos hängen (JPEG, PNG, GIF, WebP, MP4, WebM — je bis 10 MB). Sie erscheinen als kleine Vorschau unter der Meldung; ein Klick öffnet sie formatfüllend.",
          "Für längere Videos gibt es zusätzlich ein Link-Feld — etwa für YouTube oder eine Nextcloud-Freigabe. Der Link wird als Knopf angezeigt und erst auf Klick geöffnet, nie ungefragt eingebettet.",
          "Die Dateien liegen auf der Vereins-Nextcloud und sind nur für Angemeldete abrufbar — genau wie die Meldungen selbst. Wird eine Meldung gelöscht, sind ihre Bilder sofort nicht mehr erreichbar.",
          "Neuigkeiten sind Vereinsinterna und erscheinen erst nach dem Anmelden, samt Zählern und Namen. Wer nicht angemeldet ist, bekommt sie gar nicht erst übertragen."
        ]
      },
      {
        title: "Nächste Termine",
        items: [
          "Das Widget zeigt bis zu acht anstehende Vereinstermine aus dem Vereinskalender, dazu die nächsten Einträge aus dem Abwesenheitskalender, sofern man darauf Zugriff hat.",
          "Private Termine stehen in einem eigenen Bereich darunter und nur bei denen, die sie angelegt haben oder mit denen sie geteilt wurden.",
          "Hat laut Trainerdaten jemand Geburtstag, steht das am Tag selbst ganz oben im Widget — ohne Geburtsjahr.",
          "Zu Terminen mit Umfrage lässt sich direkt aus dem Dashboard zusagen."
        ]
      },
      {
        title: "Meine ToDos",
        items: [
          "Der Knopf „Meine ToDos“ im Kopfbereich öffnet die persönliche Liste: Text und wahlweise ein Fälligkeitsdatum, abhaken, aufräumen.",
          "Der Zähler am Knopf meldet, was offen ist. Er wird rot, wenn etwas überfällig ist.",
          "Hier steht nur, was man sich selbst notiert. Was einem anderen aufgetragen wird, gehört in die Vereinsaufgaben — dorthin führt ein Knopf."
        ]
      },
      {
        title: "Unterschriften anfordern",
        items: [
          "Der Knopf „Unterschriften anfordern“ auf der anderen Seite des Kopfbereichs trägt den Unterschriften-Weg: ein PDF an eine Person schicken, die es am Bildschirm unterschreiben muss.",
          "Der Absender legt fest, wo die Unterschrift stehen soll. Tut er es nicht, darf der Unterzeichner die Stelle selbst wählen; wählt niemand eine, kommt eine Nachweisseite ans Ende.",
          "Unterschrieben wird per Freihand-Pad in der eigenen Sitzung. Den Zeitstempel setzt der Server — dadurch ist die Unterschrift an die Person gebunden.",
          "Nur PDF, hart geprüft. Ein unterschriebenes Word-Dokument bliebe editierbar und wäre als Nachweis wertlos.",
          "Bei mehreren Empfängern unterschreibt jeder eine eigene Kopie. Ablehnen ist möglich, verlangt aber eine Begründung.",
          "Auf Wunsch wird der Empfänger zusätzlich per E-Mail benachrichtigt. Das ist ein Häkchen je Vorgang und steht bei jedem Öffnen wieder auf aus; der Betreff nennt den Dokumenttitel bewusst nicht.",
          "Den Knopf sieht nur, wer Unterschriften anfordern darf — oder wer selbst ein offenes Dokument hat. Nach dem Unterschreiben verschwindet er wieder.",
          "Das unterschriebene Dokument bleibt erhalten, auch wenn die zugehörige Erinnerung nach 14 Tagen abläuft. Einsehen dürfen es die Beteiligten und Administratoren."
        ]
      },
      {
        title: "Materialcontainer-Code",
        items: [
          "Der Knopf im Kopfbereich zeigt den Code des Zahlenschlosses am Materialcontainer.",
          "Gepflegt wird er von Administratoren im Reiter „Einstellungen“, samt Hinweistext.",
          "Der Code wird erst beim Öffnen des Fensters geholt und nirgends zwischengespeichert. An unangemeldete Besucher geht er nie, und Spielerkonten bekommen ihn nicht — bei rund 200 Konten wäre das das Gegenteil eines Schlosses."
        ]
      },
      {
        title: "Anmelden und eigenes Konto",
        items: [
          "Echte Nutzerkonten statt eines geteilten Zugangs. Angelegt wird über Vor- und Nachname, der Nutzername entsteht daraus; das Passwort vergibt sich jeder beim ersten Anmelden selbst.",
          "Die Anmeldung läuft zweistufig: erst der Nutzername, danach je nach Konto entweder das Passwortfeld oder das Formular „Konto einrichten“. Beide Schritte haben einen Weg zurück.",
          "Zum Anmelden genügt auch die eigene E-Mail-Adresse. Ebenso werden die üblichen Schreibweisen des Namens erkannt: „Max Mustermann“, „max.mustermann“, „max_mustermann“, „max-mustermann“ oder „MaxMustermann“ führen alle zum selben Konto. Groß- und Kleinschreibung sowie Umlaute spielen keine Rolle.",
          "Steht die E-Mail-Adresse in den Trainerdaten, wird das Konto auch dann gefunden, wenn die Adresse nichts mit dem Namen zu tun hat.",
          "Passt eine Eingabe auf mehr als ein Konto, wird bewusst nicht geraten — die Anmeldung wird dann abgelehnt, damit niemand im fremden Konto landet.",
          "Ein neues Passwort braucht mindestens 12 Zeichen mit Groß- und Kleinbuchstaben sowie einer Zahl oder einem Sonderzeichen.",
          "Passwörter werden nie im Klartext gespeichert. Die Anmeldung gilt sieben Tage, danach ist eine neue nötig.",
          "„Abmelden“ steht oben rechts neben dem eigenen Namen und ist damit aus jedem Reiter erreichbar.",
          "Der Reiter „Mein Konto“ zeigt Name, Nutzername, Trainerlizenz und Mannschaften, die eigenen Gruppen im Klartext, in welchen Werkzeugen man mehr als zusehen darf, wann das Passwort zuletzt geändert wurde und bis wann die Anmeldung gilt. Solange niemand angemeldet ist, heißt derselbe Reiter „Anmelden“.",
          "Dort lässt sich auch das eigene Passwort ändern. Dabei werden alle Geräte abgemeldet — auch das eigene; eine neue Anmeldung danach ist normal."
        ]
      },
      {
        title: "Benachrichtigungen aufs Handy",
        items: [
          "Die Toolbox kann sich direkt auf dem Gerät melden, ohne den Umweg über eine E-Mail. Eingeschaltet wird das im Reiter „Mein Konto“ unter „Benachrichtigungen aufs Handy“ — für jedes Gerät einmal.",
          "Jeder Anlass ist einzeln an- und abschaltbar: ein im Vereinskalender geteilter oder geänderter Termin, eine Vereinsaufgabe samt Rückfragen und Statusmeldungen, ein Dokument, das auf deine Unterschrift wartet, sowie Testspielplaner, Materialbedarf, Raumnutzung, Fotoaufträge und das Fahrtenbuch.",
          "Die Nachricht nennt nie einen Namen, einen Termin- oder Dokumenttitel — nur, worum es geht. Sie steht auf dem Sperrbildschirm, wo auch andere mitlesen können. Was drinsteht, sieht man nach dem Antippen in der App.",
          "Nachrichten gehen mit hoher Dringlichkeit raus, damit das Handy sie nicht im Energiesparmodus zurückhält und gesammelt zustellt.",
          "Die E-Mails bestehen unverändert weiter. Benachrichtigungen kommen dazu, sie ersetzen nichts — wer sie nicht einschaltet, merkt keinen Unterschied.",
          "In der Liste der angemeldeten Geräte lässt sich jedes einzeln wieder abmelden, auch von einem anderen Gerät aus.",
          "Auf dem iPhone geht es nur, wenn die Übersicht als App auf dem Startbildschirm liegt — Apple bietet Benachrichtigungen im normalen Safari-Fenster nicht an. Nötig ist außerdem iOS 16.4 oder neuer, also ein iPhone 8 oder jünger. Auf Android und am Rechner genügt der Browser.",
          "Wird die Abfrage einmal abgelehnt, lässt sie sich nicht erneut stellen — das erlaubt nur der Browser selbst. In dem Fall steht in der Karte, wo es sich wieder freischalten lässt.",
          "Die Schalter werden vom Server geliefert. Kommt ein Anlass dazu, erscheint er dort von selbst."
        ]
      },
      {
        title: "Eigenes Foto im Konto",
        items: [
          "Unter „Mein Konto“ lässt sich ein Bild von dir hinterlegen — aus deinen Fotos ausgewählt oder am Handy direkt mit der Kamera aufgenommen.",
          "Vor dem Speichern ziehst du den Ausschnitt zurecht und stellst die Größe ein. Liegt ein Handyfoto quer, dreht ein Tipp es gerade.",
          "Im Kadermanager erscheint dein Foto damit von selbst in der Kaderliste und auf dem Aufstellungsfeld — der Trainer muss nichts für dich hochladen. Hat er dort schon ein Bild von dir eingestellt, gilt deines. Für Spieler ohne eigenen Zugang bleibt der Weg über den Trainer bestehen.",
          "In der Besprechung steht es auf deiner Teilnehmerkachel an der Stelle, an der sonst die Initialen stehen. Wer kein Bild hinterlegt hat, sieht dort weiterhin seine Initialen.",
          "Wer angemeldet ist, kann die hinterlegten Fotos sehen. Ein Foto ist freiwillig, und du kannst deines jederzeit wieder entfernen.",
          "Administratoren können im Nutzer-Bereich ein Bild setzen oder entfernen — für Spieler ohne eigenes Gerät und als Notfallknopf bei einem unpassenden Bild."
        ]
      },
      {
        title: "Aktivitätspunkte",
        items: [
          "Unter „Mein Konto“ steht ein Punktestand: Wer mit den Vereins-Werkzeugen arbeitet, sammelt dabei Punkte.",
          "Punkte gibt es fürs Tun, nicht fürs Angemeldetsein — ein offener Tab allein zählt nicht. Am meisten bringt ein abgeschlossener Vorgang: eine erledigte Aufgabe, ein gestellter Antrag, eine geleistete Unterschrift.",
          "Dazu kommen: <strong>10 Punkte für jeden Tag</strong>, an dem überhaupt etwas passiert ist, <strong>5 Punkte fürs Zu- oder Absagen eines Termins</strong>, <strong>20 Punkte für einen Passwortwechsel</strong> (höchstens alle drei Monate) und <strong>10 Punkte fürs Wiederkommen</strong>, nachdem die Anmeldung abgelaufen war.",
          "Wochenweise: <strong>10 Punkte für jede Woche, in der du drangeblieben bist</strong> — also auch in der Woche davor schon aktiv warst —, und <strong>10 Punkte für jede Woche mit mindestens drei verschiedenen Werkzeugen</strong>. Bewusst wochenweise: eine Tagesserie würde jeden Urlaub bestrafen. Die Serie hält auch über Silvester, weil nach der amtlichen Kalenderwoche gerechnet wird.",
          "Einmalig: <strong>40 Punkte, sobald die Trainer-Unterlagen vollständig sind</strong> — Vertrag, Kodex, Jugendschutz und der Rest, der höchste Einzelwert überhaupt —, sowie je <strong>15 Punkte</strong> fürs Hinterlegen eines Fotos und fürs Einschalten der Benachrichtigungen.",
          "Diese Zugaben zählen immer, auch an einem Tag, an dem die Obergrenze von 100 Punkten schon erreicht ist.",
          "Deinen Stand siehst nur du selbst; es gibt keine für alle sichtbare Rangliste. Administratoren sehen zusätzlich, wer welches Werkzeug wie oft nutzt — daran hängt die Frage, welches Werkzeug eigentlich niemand mehr braucht.",
          "Wozu die Punkte einmal gut sein werden, entscheidet der Verein später. Das System wird erprobt, die Regeln können sich also noch ändern; neu gerechnet wird dabei die Zeit, für die noch Einzelaufzeichnungen vorliegen.",
          "In der Karte lässt sich einsehen, was gespeichert ist. Wer nicht mitzählen möchte, schaltet die Erfassung dort ab — die bisherigen Aufzeichnungen werden dabei gelöscht.",
          "Spielerkonten nehmen nicht teil und werden auch nicht erfasst."
        ]
      },
      {
        title: "Nutzer und Gruppen verwalten",
        items: [
          "Nutzer bearbeiten, löschen oder ihr Passwort zurücksetzen. Dem letzten Administrator lässt sich der Status nicht entziehen, und löschen lässt er sich auch nicht.",
          "Wird ein Vor- oder Nachname korrigiert, zieht der Anmeldename automatisch mit um. Kollidiert er mit einem bestehenden Konto, bleibt er unverändert und es kommt ein Warnhinweis.",
          "Text-Massenimport für größere Listen: ein Name je Zeile. Alle durchlaufen danach den normalen Erstanmelde-Weg.",
          "Die Nutzerliste hat genau zwei Abschnitte, Personal und Spieler, damit jedes Konto an genau einer Stelle steht. Darüber filtern eine Namenssuche und eine Gruppenauswahl.",
          "Gruppen anlegen und Mitglieder zuordnen, direkt in der Nutzerliste oder in der Gruppenverwaltung.",
          "Ein Knopf „Umbenennen“ korrigiert einen Tippfehler im Gruppennamen. Geändert wird ausschließlich die Beschriftung — Mitglieder, Sichtbarkeiten, Bearbeiten- und Administrieren-Rechte bleiben unangetastet, intern führt die Gruppe weiter denselben unveränderlichen Schlüssel.",
          "Beim allerersten Besuch, wenn es noch kein Konto gibt, öffnet sich das Formular zum Anlegen des ersten Administrators. Danach ist dieser Weg dauerhaft zu."
        ]
      },
      {
        title: "Die drei Rechte-Stufen",
        items: [
          "Je Werkzeug und Gruppe gibt es Sehen, Bearbeiten und Administrieren.",
          "Sehen wird über ein Dropdown mit vier Zuständen gesteuert: versteckt, öffentlich, alle angemeldeten Nutzer oder nur bestimmte Gruppen.",
          "Bearbeiten erlaubt das Ändern von Daten und schließt Export, Druck und PDF ein.",
          "Administrieren schaltet die app-internen Verwaltungsfunktionen frei — etwa den vollen Trainerdaten-Zugriff samt Bankverbindung oder die Rechte-Matrix im Kadermanager. Dafür muss niemand globaler Administrator sein.",
          "Administrieren schließt Bearbeiten ein, und wer bearbeiten oder administrieren darf, sieht das Werkzeug automatisch. „Bearbeiten ohne Sehen“ lässt eine App nicht länger unsichtbar.",
          "Als sensibel eingestufte Werkzeuge stehen im Sichtbarkeits-Bereich in einer eigenen aufklappbaren Sektion ganz oben und tragen ein Warnzeichen, damit ihre Rechtevergabe bewusst passiert. Alle übrigen stehen darunter in der Sektion „Weitere Tools“.",
          "Welches Werkzeug als sensibel gilt, legt ein Häkchen je Zeile fest — dafür braucht es keine Code-Änderung.",
          "Entfernt man einer Gruppe die letzte Zuordnung, wird das Werkzeug wieder versteckt statt für alle sichtbar. Eine gelöschte Gruppe verschwindet automatisch aus allen Zuordnungen."
        ]
      },
      {
        title: "Gemeinsame Anmeldung für alle Werkzeuge",
        items: [
          "Alle Vereins-Apps, die ihre Daten in derselben Nextcloud ablegen, nutzen diese eine Anmeldung. Kein eigenes Verbindungsformular, kein zusätzliches Passwort auf dem Gerät.",
          "Der Server prüft bei jedem Zugriff Anmeldung und Gruppenrechte und greift dann selbst auf die Cloud zu. Die Zugangsdaten dazu liegen nur dort.",
          "Ändern zwei Geräte gleichzeitig dieselbe Datei, wird das erkannt und gemeldet, statt still zu überschreiben.",
          "Auch der gesamte E-Mail-Versand der Flotte läuft über diese Stelle — keine App verschickt selbst."
        ]
      },
      {
        title: "Bedienung am Handy",
        items: [
          "Die Übersicht ist für das Handy gebaut; die Kacheln stapeln sich auf schmalen Bildschirmen.",
          "Eingabefelder sind mindestens 16 Pixel groß, damit der iPhone-Browser beim Antippen nicht ungefragt in die Seite hineinzoomt und verschoben stehen bleibt.",
          "Auf schmalen Bildschirmen tragen die Kopfknöpfe kürzere Beschriftungen, damit die Kopfzeile nicht unnötig wächst."
        ]
      }
    ]
  }
];
