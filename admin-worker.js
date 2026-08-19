// Cloudflare Worker: Login/Session, Nutzergruppen + Sichtbarkeits-Konfiguration
// der Tools-Übersicht, alles gegen Nextcloud gespiegelt. Nicht Teil des
// Pages-Deployments — separat bei Cloudflare deployen.
// Deployment: dash.cloudflare.com -> Workers & Pages -> Worker "landingpage"
// -> diesen Code einfügen -> Deploy (URL bleibt https://landingpage.<subdomain>.workers.dev,
// bereits als WORKER_URL in app.js eingetragen).
//
// NACH dem Deploy folgende Worker-Secrets setzen
// (Workers -> landingpage -> Settings -> Variables -> Add secret):
//   NEXTCLOUD_URL         = https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/sichtbarkeit.json
//   NEXTCLOUD_NUTZER_URL  = https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/nutzer.json
//   NEXTCLOUD_USERNAME    = admin
//   NEXTCLOUD_PASSWORD    = <App-Passwort aus Nextcloud>
//   SESSION_SECRET         = <zufällige lange Zeichenkette, einmalig generiert>
//
// Optionale Secrets für die zentrale Aktions-Passwortprüfung (verify-action-password).
// Fehlt eines, meldet nur die jeweilige Aktion einen Konfigurationsfehler — der Rest
// des Workers läuft normal. Werte frei wählbar (die alten Client-Passwörter stehen
// in der öffentlichen Git-Historie, daher am besten NEUE Passwörter vergeben):
//   PW_CHECKLISTE_SPERRE    = TrainerCheckliste: Checkliste entsperren / Eintrag mit gesperrter Checkliste löschen
//   PW_ANMELDUNG_TEILNEHMER = Trainerversammlung: Zugang zur ganzen Verwaltungsseite verwaltung.html (deckt seit 2026-07-24 die ganze Seite ab, nicht mehr nur den Teilnehmer-Tab)
//   PW_GESCHAEFTSSTELLE     = Geschäftsstelle: Zugang zur ganzen Seite geschaeftsstelle.html
//   PW_VEREINSBUDGET        = Vereinsbudget: Zugang zur ganzen Seite vereinsbudget.html
//   PW_BUDGET_LEEREN        = Vereinsbudget: "Saison leeren"
//   PW_BUDGET_EINGANG_ZUGANG = sc-heiligenstadt-beleg-upload-Worker (eigenes Cloudflare-Deploy!): Zugriffscode in beleg-eingang.html
//
// Die letzte wird nicht vom Browser-Client, sondern vom EIGENEN Cloudflare Worker
// serverseitig abgefragt (Worker-zu-Worker-Fetch) - dieser Worker braucht dafür
// kein eigenes Passwort-Secret mehr.
// (beleg-scanner nutzte diesen Weg vorübergehend ebenfalls, seit 2026-07-05 wieder
// eigenständig mit lokalen Secrets SEARCH_PASSWORD/UPLOAD_PASSWORD - siehe dort.)
//
// Optionales Secret für den E-Mail-Versand (Aktionen "notify-user" und
// "beleg-eingang-notify", siehe unten). Fehlt es, meldet nur die jeweilige Aktion
// einen Konfigurationsfehler, der Rest des Workers läuft normal (gleiches Prinzip
// wie bei den LIVEKIT_*-Secrets):
//   BREVO_API_KEY = API-Key aus dem Brevo-Konto (Einzel-Absender-Verifizierung
//     der unten als NOTIFY_FROM_EMAIL hinterlegten Adresse dort vorher nötig)
//
// Optionale Variable (kein Secret, darf im Dashboard als Klartext-Variable stehen)
// für die Beleg-Benachrichtigung:
//   NOTIFY_BELEG_EMAIL = Empfängeradresse für "beleg-eingang-notify". Absichtlich
//     hier statt als Konstante im Code: sc-heiligenstadt-budget ist ein öffentliches
//     Repo, und der Empfänger lässt sich so ohne Deploy wechseln. Fehlt sie, bleibt
//     der Mailversand ein stiller No-Op (Beleg-Einreichung funktioniert weiter).
//
// BOOTSTRAP (einmalig, direkt nach dem Deploy, bevor die URL geteilt wird):
// Solange in nutzer.json noch kein Nutzer existiert, zeigt die Seite im
// Admin-Tab automatisch ein "Admin-Konto einrichten"-Formular. Dort einmal
// Nutzername + Passwort wählen — danach ist dieser Weg dauerhaft gesperrt
// (die Aktion "bootstrap-admin" antwortet ab dann mit 403).
//
// Passwörter werden mit PBKDF2-HMAC-SHA256 gehasht (Web-Crypto, keine
// Abhängigkeiten), Sessions sind zustandslose HMAC-signierte Bearer-Token
// (7 Tage gültig) — kein KV/D1 nötig. Nutzergruppen werden zusammen mit den
// Nutzerkonten in derselben nutzer.json gespeichert (Top-Level-Key "groups"),
// kein zusätzliches Worker-Secret nötig.
//
// API (POST-Body: { action, ... } außer beim einfachen GET):
//   GET                                                        -> { tools, links, bootstrapAvailable } ohne Auth
//   GET /kalender/<token>.ics                                  -> text/calendar, ohne Auth (der Token IM PFAD ist der Ausweis)
//     Abo-Feed des Vereinskalenders für den eigenen Kalender. Kalenderprogramme können keinen Bearer-Token
//     schicken, deshalb dieser zweite GET-Pfad. Prüft bei JEDEM Abruf Konto und Tool-Sichtbarkeit neu.
//   POST { action: "bootstrap-admin", username, password }     -> nur wenn noch keine Nutzer existieren
//   POST { action: "login", username, password }               -> { token, username, isAdmin, groupIds } | { needsPasswordSetup: true, username } | 401
//     `username` ist seit 2026-08-03 der Nutzername ODER eine Schreibvariante davon ODER die
//     E-Mail-Adresse der Person (resolveLoginUser). Der Token lautet immer auf den echten Nutzernamen.
//   POST { action: "set-password", username, password }        -> nur falls mustSetPassword=true beim Nutzer
//     Nimmt dieselben Eingabevarianten entgegen wie "login" -- der Erstlogin-Flow reicht Schritt 1 durch.
//   POST { action: "km-reg-oeffnen", teamId } + Bearer (Bearbeiten-Recht kadermanager) -> { token, teamName, expiresAt, ttlSeconds, freieSpieler }
//     Öffnet ein 15-Minuten-Registrierungsfenster für eine Mannschaft. Zustandslos: das Fenster IST das
//     signierte Token (typ "km-reg"), nichts wird gespeichert -- dafür nicht vorzeitig widerrufbar.
//   POST { action: "km-reg-info", token }        (OHNE Auth) -> { teamName, spieler:[{id,name}], expiresAt } | 401
//     Nur die noch freien Kaderplätze, nur id+name. Der Spieler hat noch kein Konto; das Token ist der Ausweis.
//   POST { action: "km-reg-abschliessen", token, spielerId, password } (Auth OPTIONAL) -> { token?, username, verknuepft, ... } | 401 | 403 | 409
//     OHNE Bearer: legt das Spielerkonto an (art:"spieler", Gruppe "Spieler", Passwort direkt gesetzt) und
//     verknüpft es per linkedUsername mit dem Kaderplatz. Antwort enthält dann `token` (neue Sitzung).
//     MIT gültigem Bearer: KEIN neues Konto, nur Verknüpfung des Kaderplatzes mit dem angemeldeten Konto
//     (kein `password` nötig, kein `token` in der Antwort) -- der Weg für Spieler, die schon in einer
//     Mannschaft stehen und sich zusätzlich für eine Gruppe (Torwart-/Athletikgruppe) eintragen. Ohne das
//     entstünde bei jedem weiteren Scan ein Doppelkonto. Zusätzlich gegated auf Tool-Sichtbarkeit.
//     verknuepft:false = Konto steht, Verknüpfung kollidierte -> "Das bin ich".
//     Die Gruppe "Spieler" muss in sichtbarkeit.json bei kadermanager.groupIds stehen, sonst bleibt die App leer.
//   POST { action: "km-self", art, teamId, ... } + Bearer (nur Tool-SICHTBARKEIT nötig, kein Bearbeiten-Recht)
//     Spieler-Selbstbedienung im Kadermanager ("Briefschlitz"): ändert serverseitig genau EINEN eigenen Eintrag.
//     art = "teilnahme" {terminId,status,grund?} | "umfrage" {umfrageId,optionIds[]} | "aufgabe" {terminId,aufgabeId,erledigt}
//         | "fahrt-angebot" {terminId,plaetze} | "fahrt-gesuch" {terminId,an} | "urlaub-add" {id?,von,bis,grund?,typ}
//         | "urlaub-del" {abwesenheitId} | "claim" {spielerId} | "unclaim"
//     Der eigene Kaderplatz kommt IMMER aus linkedUsername, nie aus dem Body -- ein manipulierter Request
//     trifft deshalb keinen fremden Eintrag. Ersetzt dav-save für Spieler: das würde die GANZE Datei
//     (alle Mannschaften, Kasse) schreiben und ist für sie per WRITE_REQUIRES_EDIT_PERMISSION gesperrt.
//   POST { action: "me", app? } + Authorization: Bearer <token> -> { username, isAdmin, groupIds, groupNames, realIsAdmin, viewAsGroupId, vertragspflichtig, passwordSetAt } (+ canEdit/canAdmin, wenn app übergeben und bekannt)
//     groupNames (seit 2026-07-21): die Namen zu groupIds, damit "Mein Konto" die Gruppen auch
//     Nicht-Admins zeigen kann (list-groups ist admin-only). Nur die EIGENEN Gruppen — kein Ersatz
//     für list-directory und kein Weg an dessen Spieler-Sperre vorbei. passwordSetAt (dito): Zeitpunkt
//     der letzten Passwortvergabe für die Anzeige, null bei Konten ohne das Feld.
//     isAdmin/groupIds sind die EFFEKTIVE Identität (siehe set-view-as); realIsAdmin ist immer der echte
//     Admin-Status aus nutzer.json, unabhängig von einer aktiven Testansicht — die Testansicht-Umschaltung
//     selbst muss also realIsAdmin prüfen, nicht isAdmin, sonst kann ein Admin sich nicht zurückschalten.
//     vertragspflichtig (bool, seit 2026-07-17): Gruppe "Trainer" ODER vertragBenoetigt-Flag, siehe
//     isVertragspflichtig. Trainerdaten gated daran Bankverbindung/Nebentätigkeit/Unterschrift/Dokumente —
//     wer keinen Vertrag braucht (z.B. Geschäftsführung), hinterlegt dort nur Kontaktdaten. Bewusst die
//     ECHTE Identität (session.username), NICHT die effektive: identisch zu handleMyTrainerdatenStatus,
//     damit Ampel-Badge und Formular nie auseinanderlaufen. Folge: eine aktive set-view-as-Testansicht
//     ändert vertragspflichtig NICHT — die reduzierte Ansicht lässt sich damit nicht durchspielen.
//   POST { action: "set-view-as", groupId } (nur wenn realIsAdmin) -> { ok:true, isAdmin, groupIds, realIsAdmin, viewAsGroupId }
//     Admin-Testansicht: ein echter Admin kann sich testweise als Mitglied einer Gruppe ausgeben (groupId:null
//     zum Zurückschalten). Wirkt zentral über getVerifiedSession() auf JEDE Aktion jeder Gateway-App (dav-load/
//     -save, canEdit, Personalakte-Sicht, ...), nicht nur auf die Landingpage selbst — kein Redeploy der
//     einzelnen Apps nötig, die lesen ohnehin nur isAdmin/groupIds aus der me()-Antwort. Persistiert je Nutzer
//     als viewAsGroupId in nutzer.json (überlebt also auch einen Reload/Gerätewechsel, bis explizit zurückgesetzt).
//   POST { action: "create-user", vorname, nachname, isAdmin, groupIds, art? } (admin) -> generiert Nutzername, legt Nutzer mit mustSetPassword=true an
//     art: "personal" (Vorgabe) | "spieler" -- trennt Vereinspersonal von Spielern/Eltern, siehe userArt()/istPersonal().
//     Spieler sind nie Admin (isAdmin wird ignoriert), erscheinen NICHT in personalakte-overview/list-directory/
//     list-trainer-profiles/get-admin-stats.users und kommen nur über explizit gesetzte groupIds an ein Tool
//     (der "keine Gruppe = alle eingeloggten"-Default gilt für sie nicht). Provisioning: nur kadermanager.
//   POST { action: "list-users" } (admin)                       -> Liste inkl. vorname/nachname/displayName/groupIds, ohne Passwort-Hashes
//   POST { action: "reset-password", username } (admin)         -> löscht Hash, mustSetPassword=true
//   POST { action: "change-password", oldPassword, newPassword } (eingeloggt) -> { token, username, ...identity }
//     Aendert das EIGENE Passwort; der Nutzer kommt aus dem Token, nie aus dem Body. Setzt passwordSetAt neu und
//     entwertet damit jede aeltere Session (siehe getVerifiedSession) — das zurueckgegebene Token muss der Client
//     speichern, sonst sperrt sich der Aendernde selbst aus.
//   POST { action: "update-user", username, vorname, nachname, isAdmin } (admin) -> ändert Vor-/Nachname und Admin-Status (letztem Admin kann Admin-Status nicht entzogen werden); zieht bei Namensänderung den Login-Nutzernamen automatisch mit um (Response-Feld usernameRename), außer die Zielkennung ist durch ein anderes Konto belegt
//   POST { action: "delete-user", username } (admin)             -> löscht Nutzer, entfernt ihn aus allen Gruppen (letzter Admin kann nicht gelöscht werden)
//   POST { action: "create-group", name } (admin)                -> legt Gruppe an (id per Slugify aus name)
//   POST { action: "list-groups" } (admin)                       -> alle Gruppen inkl. memberUsernames
//   POST { action: "trainerdaten-list-groups" } (admin ODER Trainerdaten-ADMINISTRIEREN-Stufe) -> alle Gruppen inkl. memberUsernames,
//     Mitglieder auf Personal gefiltert — schmale Variante von list-groups für die Gruppen-Auswahl/-Spalte im
//     Trainerdaten-CSV-Export (resolveAdminPermission("trainerdaten"): Administrieren-Gruppen aus dem Sichtbarkeits-Panel)
//   POST { action: "check-edit-permission", app } (jeder eingeloggte Nutzer) -> { canEdit, canAdmin } via
//     resolveEditPermission/resolveAdminPermission. Verrät nur das EIGENE Recht für EINE App (keine fremden Daten).
//     Konsumenten: der Trainerdaten-CORS-Proxy (Worker "trainerdaten", prüft darüber serverseitig die
//     ADMINISTRIEREN-Stufe, bevor er WebDAV-Zugriffe mit seinen eigenen Nextcloud-Secrets ausführt) und der
//     Trainerdaten-/Dokumentenvorlagen-Client für den Admin-Einstieg.
//     Bewusst 200 + false statt 403 bei fehlendem Recht — Aufrufer müssen "Session tot" (401) von
//     "kein Recht" unterscheiden können.
//   POST { action: "list-directory" } (jedes eingeloggte PERSONAL) -> { users:[{username,displayName}], groups:[{id,name}] } ohne
//     sensible Felder (kein isAdmin/mustSetPassword/memberUsernames) — für Teilen-mit-Picker in Gateway-Apps (z.B. Vereinskalender)
//     Liefert nur Personal; Spielerkonten bekommen 403 (kein Spieler-Tool hat einen Picker, und die vollständige
//     Namensliste des Vereins ist für ein Spielerkonto nichts zu holen).
//   POST { action: "list-tool-editors", app } + Authorization: Bearer -> { users:[{username,displayName}] }
//     Mitglieder der Bearbeiter-Gruppen (editGroupIds + adminGroupIds) EINER bestimmten App, z.B. für einen "Vertreter"-Picker
//     im Abwesenheitskalender-Formular — jeder mit Tool-Zugriff darf abrufen (gleiche Prüfung wie dav-load:
//     userMayAccessTool), kein Admin-Gate. Keine sensiblen Felder, gleiche Vertrauensstufe wie list-directory.
//   POST { action: "list-trainer-profiles" } (jeder eingeloggte Nutzer) -> { profiles:[{username,vorname,nachname,lizenz,mannschaften,vertragBenoetigt}] }
//     für alle Nutzer mit gesetztem Vor-/Nachnamen — zentrales Trainerprofil (Lizenz + betreute Mannschaft(en)),
//     damit Gateway-Apps (Personalkosten, Trainerdaten, Trainerkodex, Kadermanager, ...) NICHT nur das eigene
//     me()-Profil, sondern auch das anderer Nutzer nachschlagen können (Namensabgleich bzw. linkedUsername-Join).
//   POST { action: "list-birthdays-today" } (jeder eingeloggte Nutzer) -> { namen:["Vorname Nachname", ...] }
//     wer laut Trainerdaten (PROVISION_ONLY_PATHS, Tag+Monat, Europe/Berlin) heute Geburtstag hat — nur der
//     Name, nie das Geburtsjahr oder andere Trainerdaten-Felder (die bleiben exklusiv personalakte-overview
//     vorbehalten). Fürs "Nächste Termine"-Widget in app.js.
//   POST { action: "kontakte-liste" } (angemeldet, kein Spielerkonto, Sichtbarkeit des Tools "kontakte")
//     -> { kontakte: [{vorname, nachname, telefon?, email?, adresse?:{strasse,plz,ort}}] }
//     Die Kontaktliste des Vereins, gespeist aus Trainerdaten (PROVISION_ONLY_PATHS). Aufgenommen wird NUR,
//     wer sich in Trainerdaten selbst dafür freigegeben hat (Feld `kontaktFreigabe`, gesetzt über die dortige
//     Aktion `kontakt-freigabe-speichern`), und je Person NUR die einzeln freigegebenen Felder — ein nicht
//     freigegebenes Feld fehlt im Objekt, statt leer mitzukommen. Nie IBAN/Geburtsdatum/Dokumente/Vertrag.
//     Ohne `kontaktFreigabe.name === true` erscheint die Person überhaupt nicht.
//   POST { action: "raumnutzung-kontakt-lookup", name } (Raumnutzung-Bearbeiter via resolveEditPermission)
//     -> { treffer: {strasse, plz, ort, telefon, email} | null } — Kontaktdaten GENAU EINER namentlich
//     benannten Person aus Trainerdaten (PROVISION_ONLY_PATHS), fürs Vorbefüllen von Veranstaltungsleitung/
//     Vertretung im Raumnutzungs-Antrag. Nur diese fünf Felder, nie IBAN/Geburtsdatum/Dokumente. Gate ist das
//     Bearbeiten-Recht der Raumnutzung-App: dieselben Personen tragen die Daten dort ohnehin von Hand ein und
//     sehen sie in jedem gespeicherten Antrag — die Aktion spart nur das Abtippen, weicht aber keine Grenze auf.
//   POST { action: "raumnutzung-mail-antrag", pdfBase64, dateiname } (Administrieren-Recht raumnutzung) -> { ok, sent, to, cc }
//     Verschickt einen fertigen Raumnutzungs-Antrag als PDF-Anhang ans Schulverwaltungsamt des Landkreises,
//     CC an die Geschäftsstelle. Empfänger/CC/Betreff/Text stehen als RAUMNUTZUNG_MAIL_*-Konstanten im Code und
//     werden NIE aus dem Body übernommen — sonst wäre die Aktion ein Versandweg an beliebige Adressen unter dem
//     Absender des Vereins (gleiche Härtung wie NOTIFY_BELEG_EMAIL). Gate ist seit 2026-07-27 die DRITTE Stufe
//     (resolveAdminPermission), nicht mehr das Bearbeiten-Recht: Anträge ausfüllen dürfen alle Bearbeiter,
//     sie beim Amt einreichen nur die Geschäftsstelle (Michel-Vorgabe). Versand über Brevo inkl. attachment[];
//     ein Fehlschlag ist ein echter Fehler (kein stilles sent:false wie bei beleg-eingang-notify) — hier IST
//     der Versand die ganze Handlung.
//   POST { action: "notify-user", username, subject, message } (jeder eingeloggte Nutzer) -> { ok:true, sent:bool }
//     E-Mail-Benachrichtigung an einen ANDEREN Nutzer, erster Verwendungszweck: Vereinskalender-Teilen-Hinweis
//     bei privaten Terminen (Vorbereitung fürs geplante Mail-Tool, siehe [[project-vereinskalender]]). Die
//     Zieladresse wird SERVERSEITIG über Trainerdaten aufgelöst (PROVISION_ONLY_PATHS, gleiches Prinzip wie
//     list-birthdays-today) — der Client nennt nur einen Nutzernamen, kann also nie eine beliebige Adresse
//     erzwingen. Hat die Zielperson keine E-Mail hinterlegt, stiller No-Op (sent:false), kein Fehler. Versand
//     über Brevo (Secret BREVO_API_KEY), Absender = NOTIFY_FROM_EMAIL/-NAME-Konstanten bei PROVISION_ONLY_PATHS.
//   POST { action: "vereinskalender-vote", terminId, candId, wert } (jeder mit Tool-Zugriff) -> { ok, rev, stimmen }
//     Eigene Stimme bei einem Umfrage-Termin des Vereinskalenders setzen ("ja"/"nein") oder zurückziehen ("").
//     Eigene Aktion, weil vereinskalender in WRITE_REQUIRES_EDIT_PERMISSION steht: Termine anlegen/ändern ist
//     Bearbeitern vorbehalten, ABSTIMMEN muss aber jeder dürfen, der den Termin sieht — sonst stimmt die
//     Geschäftsstelle mit sich selbst ab. Schreibt ausschließlich umfrage.stimmen[<Token-Nutzer>][candId] eines
//     einzelnen Termins und spiegelt dafür die Sichtbarkeitsregel für Privattermine serverseitig.
//   POST { action: "vereinskalender-abo-status" } (jeder mit Tool-Zugriff)  -> { ok, aktiv, umfang?, url?, webcalUrl?, erstelltAm? }
//   POST { action: "vereinskalender-abo-anlegen", umfang } (dito)           -> { ok, aktiv:true, umfang, url, webcalUrl }
//   POST { action: "vereinskalender-abo-loeschen" } (dito)                  -> { ok, aktiv:false, entwertet }
//     Persönlicher Abo-Link, mit dem der eigene Kalender (Google/Apple/Outlook) die Vereinstermine dauerhaft
//     spiegelt. umfang = "oeffentlich" (nur allgemeine Termine, Standard) | "alle" (zusätzlich eigene und mit
//     einem geteilte Privattermine). Ein Nutzer hat höchstens EIN Abo — Neuerzeugen entwertet den alten Link.
//     Abgerufen wird der Feed NICHT hier, sondern per GET /kalender/<token>.ics (siehe unten).
//   POST { action: "my-trainerdaten-status" } (jeder eingeloggte Nutzer) -> { vorhanden, trainerdatenGesamtOk, ...restliche
//     Trainerdaten-Statusfelder (gleiche Zusammenfassung wie personalakte-overview, aber NUR für den eigenen
//     Datensatz, kein Admin-Gate) } — für das grüne/rote Ampel-Badge auf der Trainerdaten-Kachel im Dashboard.
//     trainerdatenGesamtOk ist `null`, wenn WEDER ein Trainerdaten-Datensatz existiert NOCH die Person
//     vertragspflichtig ist (Gruppe "Trainer" oder vertragBenoetigt-Flag, siehe isVertragspflichtig) — dann
//     zeigt die Kachel bewusst kein Badge ("bin gar kein Trainer"). Ist die Person vertragspflichtig, ist es
//     ein serverseitig berechnetes bool, auch wenn noch gar kein Datensatz existiert (dann false = rotes
//     Kreuz "Daten unvollständig", seit 2026-07-14 — vorher fälschlich gar kein Badge in diesem Fall): Daten
//     eingereicht + Lizenz oder "keine Lizenz" + Lizenz nicht abgelaufen + Führerschein < 6 Monate alt +
//     Führungszeugnis eingereicht + Kodex < 6 Monate alt bestätigt, seit 1.6 — Trainerkodex ist Teil von
//     Trainerdaten geworden, siehe unten; + Jugendschutzkonzept < 6 Monate alt bestätigt, seit Trainerdaten
//     1.7, gleiche Ablauflogik wie Kodex.
//   POST { action: "my-trainercheckliste-status" } (jeder eingeloggte Nutzer) -> { vorhanden, zugang, abgang }
//     eigener TrainerCheckliste-Eintrag (Namensabgleich wie personalakte-overview), NUR der eigene Datensatz,
//     kein Admin-Gate (gleiche Vertrauensstufe wie my-trainerdaten-status) — für die read-only Anzeige "meine
//     Checkliste" in Trainerdatens Trainer-Selbstbedienung (rein informativ, fließt NICHT in trainerdatenGesamtOk
//     ein, siehe [[project-trainerdaten]]). zugang/abgang je { abgeschlossen, nichtAbgeschlossen,
//     nichtAbgeschlossenGrund, headerChecked, headerDatum, ort, datum, bemerkungen, items, itemTexts,
//     unterschriftTrainer, unterschriftFunktionaer } — volle eigene Personendaten inkl. Unterschriften sind hier
//     unbedenklich (es ist ausschließlich der eigene Eintrag, gleiche Vertrauensstufe wie die eigene
//     Trainerdaten-Einreichung), NICHT das ganze trainerEintraege-Array (Minimal-Disclosure, siehe CLAUDE.md).
//     Seit TrainerCheckliste 1.2 liegen Unterschriften als eigene Dateien (dateien/<fileId>) statt inline —
//     dieser Handler lädt sie für den eigenen Eintrag serverseitig nach (attachChecklistSignaturen).
//   POST { action: "rename-group", groupId, name } (admin)      -> ändert NUR den Anzeigenamen, die Id bleibt
//   POST { action: "update-group-members", groupId, memberUsernames } (admin) -> ersetzt Mitgliederliste komplett
//   POST { action: "provision-group", groupId } (admin)          -> legt für alle Mitglieder der Gruppe Einträge in den
//     dafür konfigurierten Tools an (Auto-Provisioning, idempotent) -> { provisioned:{[app]:{[username]:ergebnis}}, apps, memberCount }
//   POST { action: "delete-group", groupId } (admin)             -> löscht Gruppe, räumt groupIds in sichtbarkeit.json auf
//   POST { action: "save-visibility", tools } (admin)            -> aktualisiert tools in sichtbarkeit.json (erhält news), tools[id] = {visible, loginRequired, groupIds, editGroupIds, adminGroupIds, provisionGroupIds}
//     (groupIds steuert die Sichtbarkeit im Modus "Nur bestimmte Gruppen"; editGroupIds ist unabhängig davon
//     und vergibt zusätzlich Bearbeiten-Rechte, unabhängig vom Sichtbarkeits-Modus des Tools; adminGroupIds ist
//     die dritte Stufe "Administrieren" (App-interne Admin-Funktionen, schließt Bearbeiten ein — resolveEditPermission
//     wertet adminGroupIds mit); provisionGroupIds steuert das Auto-Provisioning: Mitglieder dieser Gruppen
//     bekommen automatisch einen Eintrag im Tool.)
//   POST { action: "save-news", news } (admin)                   -> speichert die Neuigkeiten (Array, serverseitig validiert) im news-Key von sichtbarkeit.json (erhält tools); GET liefert news NUR an Angemeldete (optionaler Bearer-Token am GET, seit 2026-07-25), sonst news: null; Meldungen älter als 14 Tage (NEWS_MAX_ALTER_TAGE, ab dem Meldungsdatum) filtert der GET aus und löscht sie im Hintergrund samt Medien-Dateien und Reaktionen (seit 2026-08-10)
//   POST { action: "save-links", links } (admin)                 -> speichert die Linksammlung (Array, serverseitig validiert) im links-Key von sichtbarkeit.json (erhält tools/news);
//     GET liefert links AN JEDEN, auch ohne Token — anders als news. Michel-Entscheidung 2026-08-14: es sind Adressen fremder
//     Webseiten, kein Vereinsinternum. Reihenfolge des Arrays ist die Anzeigereihenfolge (seit 2026-08-14)
//   POST { action: "toggle-news-reaction", newsId, emoji } (jeder eingeloggte Nutzer) -> { newsId, counts, mine, namen }
//     (setzt/wechselt/entfernt die EINE Reaktion des Nutzers auf eine Meldung; Emoji strikt gegen NEWS_REACTION_EMOJIS
//     validiert, Nutzername aus der Session; Ablage in neuigkeiten-reaktionen.json getrennt von den News)
//   POST { action: "my-news-reactions" } (jeder eingeloggte Nutzer) -> { mine: { newsId: emoji } } (nur eigene Reaktionen)
//   GET liefert zusätzlich newsReactions: { newsId: { emoji: anzahl } } — reine Zähler, wie news nur an Angemeldete (sonst {})
//   GET liefert zusätzlich newsReactionNames: { newsId: { emoji: [anzeigename] } } — WER reagiert hat, ebenfalls nur an
//     Angemeldete (sonst {}); der Client zeigt die Namen im Tooltip der Reaktionsknöpfe (seit 2026-08-01)
//   POST { action: "submit-feedback", type, toolId?, text } (jeder eingeloggte Nutzer) -> { ok:true }
//     (legt EINEN Feedback-/Wunsch-Eintrag an; Name/Nutzername kommen serverseitig aus dem eigenen Konto,
//     der Client kann sie nicht fälschen oder für andere Nutzer einen Eintrag anlegen)
//   POST { action: "list-feedback" } (admin)                     -> { entries } (alle Feedback-/Wunsch-Einträge)
//   POST { action: "save-feedback", entries } (admin)            -> ersetzt alle Feedback-Einträge (Array, serverseitig
//     validiert) — für "erledigt"-Status togglen und Einträge löschen (kompletter Array-Ersatz wie save-news)
//   POST { action: "feedback-antwort", id, text } (admin)        -> { entry } (schreibt die Antwort an GENAU einen Eintrag
//     und schickt dem Einreicher eine Push-Nachricht; leerer Text entfernt die Antwort wieder, dann ohne Push)
//   POST { action: "meine-feedbacks" } (jeder eingeloggte Nutzer) -> { entries } (nur die EIGENEN Einreichungen samt
//     Antwort — der Weg, auf dem der Einreicher die Antwort liest, zu der die Push-Nachricht führt)
//   POST { action: "ideen-load" } (angemeldetes Personal)        -> { ideen, istAdmin } (alle Ideen in der Sicht des
//     Aufrufers: Verfassername nur wenn nicht anonym, Antwort nur für den Einreicher, Zustimmung nur als ZAHL)
//   POST { action: "idee-speichern", id?, titel, text?, anonym? } (angemeldetes Personal) -> { idee }
//     (ohne id neu, mit id die EIGENE ändern — und nur solange sie auf "neu" steht)
//   POST { action: "idee-loeschen", id } (Verfasser solange "neu", oder Admin) -> { ok:true }
//   POST { action: "idee-daumen", id } (angemeldetes Personal)   -> { id, daumen, meinDaumen } (Zustimmung umschalten)
//   POST { action: "idee-verwalten", id, status?, antwort? } (admin) -> { idee } (Status setzen und antworten;
//     fehlendes Feld heißt unverändert, mitgeschicktes leeres antwort löscht die Antwort)
//   POST { action: "get-admin-stats" } (admin)                   -> { users, trainerGroup, trainervertrag, trainerkodex,
//     jugendschutz, feedbackOpen, materialbedarfOpen, busplanOpen } — Kennzahlen fürs Admin-Dashboard, aus bestehenden
//     Datenquellen berechnet (nutzer.json, feedback.json, trainerdaten/trainerkodex/materialbedarf/busplan via
//     DAV_APPS/PROVISION_ONLY_PATHS). Trainervertrag-/Trainerkodex-/Jugendschutzkonzept-Quote beziehen sich auf Mitglieder
//     der Gruppe TRAINER_GROUP_NAME ("Trainer") — existiert diese Gruppe noch nicht, liefert trainerGroup.exists:false.
//     Archivierte Trainer zählen NICHT zum Nenner dieser Quoten (siehe archiviert-Feld unten).
//   POST { action: "personalakte-overview" } (Personalakte-Sichtrecht, siehe mayViewPersonalakte) -> { trainerGroupExists, trainers:[...] }
//     Seit 1.3: ein Datensatz je Nutzerkonto in nutzer.json, NICHT mehr auf Mitglieder der Trainer-Gruppe
//     beschränkt (`trainerGroupExists` bleibt aus Client-Kompatibilität immer `true`, ist aber bedeutungslos
//     geworden). Zusammengeführt aus nutzer.json + trainerkodex/trainerdaten/trainercheckliste/personalkosten/
//     kadermanager — inkl. archivierter Nutzer (Gruppen werden beim Archivieren NICHT entzogen). Trainerdaten-
//     Anteil liefert ausschließlich Datum/Status-Felder, nie IBAN/Adresse — seit 1.1 zusätzlich Führerschein-/
//     Führungszeugnis-Status (migriert aus Fahrtenbuch, siehe [[project-trainerdaten]]).
//     Seit 1.2 zusätzlich `trainerId` (Trainerdaten-eigene id, nicht username) -- Personalakte ruft damit
//     direkt trainerdaten1.michel-brunner.workers.dev an, um die Dokumente selbst zu öffnen.
//   POST { action: "archive-trainer", username, grund? } (Personalakte-Sichtrecht) -> { ok:true, username, archiviertAm }
//     Schreibt zuerst einen Datenschnappschuss nach personalakte.json, sperrt danach Login+Sessions des Kontos
//     (Nutzerfelder archiviert/archiviertAm/archiviertGrund/archiviertVon in nutzer.json). Gruppenzugehörigkeit
//     bleibt unangetastet. Letzter Admin kann nicht archiviert werden.
//   POST { action: "reactivate-trainer", username } (Personalakte-Sichtrecht) -> { ok:true, username }
//     Hebt die Login-Sperre wieder auf, ergänzt den Snapshot in personalakte.json um reaktiviertAm/reaktiviertVon.
//   POST { action: "aufgaben-load" } (eingeloggtes Personal) -> { meine, zugewiesenVonMir, canAssign, assignGroupIds? }
//     Persoenliche Aufgabenliste aus aufgaben.json. zugewiesenVonMir ist streng auf die selbst erzeugten Eintraege
//     gefiltert (nie die uebrige Liste des Empfaengers); assignGroupIds kommt nur fuer Admins mit (fuers Panel).
//   POST { action: "aufgabe-speichern", id?, text?, faellig?, erledigt? } -> { ok:true, aufgabe }
//     Ohne id anlegen, mit id aendern -- immer in der EIGENEN Liste (Nutzername aus der Session).
//     Bei zugewiesenen Aufgaben ist nur erledigt erlaubt (Text/Faelligkeit gehoeren dem Zuweiser) -> sonst 403.
//   POST { action: "aufgabe-loeschen", id } -> { ok:true, id }
//     Nur selbst angelegte oder bereits zurueckgezogene Eintraege; eine offene Zuweisung laesst sich nicht wegklicken.
//   POST { action: "aufgaben-aufraeumen" } -> { ok:true, entfernt }
//     Entfernt erledigte EIGENE Eintraege; erledigte Zuweisungen bleiben befristet stehen (Rueckkanal des Zuweisers).
//   POST { action: "aufgabe-zuweisen", text, faellig?, empfaenger[] } (Gruppen aus aufgaben.assignGroupIds) -> { ok:true, zugewiesen, uebersprungen }
//     Je Empfaenger eine eigene Kopie mit eigener Id. Empfaenger muessen existieren und Personal sein.
//   POST { action: "aufgabe-zurueckziehen", id, empfaenger } (nur der Zuweiser) -> { ok:true }
//     Markiert die Aufgabe beim Empfaenger als zurueckgezogen (bleibt als Hinweis stehen); Erledigtes geht nicht mehr.
//   POST { action: "zuweisung-entfernen", id?, empfaenger? } (nur der Zuweiser) -> { ok:true, entfernt }
//     Raeumt die Rueckansicht "Von mir zugewiesen" auf. Mit id+empfaenger genau einer, ohne beides alle
//     ABGESCHLOSSENEN (erledigt oder zurueckgezogen) auf einmal. Offene bleiben stehen -- dafuer gibt es
//     das Zurueckziehen. Ein daran haengendes Dokument bleibt in dokumente.json unberuehrt.
//   POST { action: "aufgaben-gesehen", ids[] } -> { ok:true, markiert }
//     Setzt gesehenAm auf eigenen Zuweisungen (geraeteuebergreifend); schreibt nur, wenn sich etwas aendert.
//   POST { action: "set-aufgaben-gruppen", groupIds?, dokumentGroupIds? } (Admin) -> { ok:true, assignGroupIds, dokumentGroupIds, ... }
//     Legt in aufgaben{} von sichtbarkeit.json ab, welche Gruppen zuweisen bzw. Unterschriften einfordern duerfen.
//     LEER = niemand (nicht "alle"). Ein FEHLENDES Feld heisst "unveraendert" -- nur ein mitgeschicktes [] leert.
//   POST { action: "dokumente-load" } (eingeloggtes Personal) -> { anMich, vonMir, canAssignDocs }
//     Zu unterschreibende Dokumente aus dokumente.json, getrennt nach Rolle. Nur Eintraege, an denen man beteiligt ist.
//   POST { action: "dokument-anlegen", titel, originalFileId, empfaenger[], faellig?, feld?, mail? } (aufgaben.dokumentGroupIds)
//         -> { ok:true, angelegt, aufgabenAngelegt, benachrichtigt, ohneAdresse[], mailAus }
//     Je Empfaenger ein eigener Eintrag auf dasselbe Original + eine Aufgabe als Erinnerung. feld = Seite + 4 Fraktionen.
//     mail:true verschickt zusaetzlich je Empfaenger eine Brevo-Benachrichtigung (Adresse serverseitig aus Trainerdaten,
//     siehe dokumentBenachrichtige). NUR auf ausdrueckliches Haekchen -- fehlendes/false Feld verschickt nichts, ein alter
//     Client verhaelt sich also unveraendert. Der Versand kippt den Vorgang nie, wird aber in der Antwort benannt.
//   POST { action: "dokument-datei-put", id, zweck:"original"|"signiert", dokId?, dataBase64 } -> { ok:true, id }
//     Ablage in unterschriften/<uuid>, NICHT in dateien/ -- dav-file-get kann diesen Ordner nicht erreichen.
//     "original" gegen das Zuweis-Recht, "signiert" nur fuer den Empfaenger des Dokuments und nur solange offen. Nur PDF.
//   POST { action: "dokument-datei-get", dokId, welche:"original"|"signiert" } -> PDF-Bytes
//     Die Datei-Id kommt NIE aus dem Body, sondern immer aus dem Dokument -- sonst liesse sich die Pruefung umgehen.
//     Zugriff nur fuer Absender, Empfaenger und globale Admins, unabhaengig von jeder Tool-Sichtbarkeit.
//   POST { action: "dokument-unterschreiben", dokId, signedFileId } (nur der Empfaenger) -> { ok:true, dokument }
//     Verbucht die geleistete Unterschrift (Zeitstempel vom Server) und hakt die zugehoerige Aufgabe ab.
//   POST { action: "dokument-ablehnen", dokId, grund } (nur der Empfaenger) -> { ok:true, dokument }
//     Begruendung ist Pflicht -- sonst laesst sich "verweigert" nicht von "uebersehen" unterscheiden.
//   POST { action: "dokument-loeschen", dokId } (Absender oder Admin) -> { ok:true }
//     Loescht Eintrag + Dateien; das Original nur, wenn keine weitere Kopie mehr darauf zeigt.
//   POST { action: "get-materialcontainer-code" } + Authorization: Bearer -> { code, hinweis, geaendertAm, geaendertVon }
//     Zahlencode des Schlosses am Materialcontainer. Eingeloggtes Personal; Spielerkonten bekommen 403.
//     Bewusst eine eigene schmale Aktion (nicht Teil von "me" und nicht im oeffentlichen GET) -- der Code oeffnet ein echtes Schloss.
//   POST { action: "set-materialcontainer-code", code, hinweis? } (Admin) -> { ok:true, code, hinweis, geaendertAm, geaendertVon }
//     Legt ihn in materialcontainer{} von sichtbarkeit.json ab (read-modify-write). Leerer code = "keiner hinterlegt".
//   POST { action: "dav-load", app } + Authorization: Bearer       -> { data, rev, me } (Inhalt der App-Datendatei aus Nextcloud, data:null wenn noch nicht vorhanden; rev = ETag)
//     me enthält dasselbe wie die Aktion "me" inkl. canEdit/canAdmin für diese App — der Client braucht dafür keinen zweiten Request.
//     Kostet den Worker keinen zusätzlichen Nextcloud-Read (nutzer.json + sichtbarkeit.json sind hier ohnehin gelesen).
//     Für Apps in AUTO_PRUNE_APPS (aktuell: fotoauftraege) werden dabei abgelaufene Listeneinträge entfernt und die Datei
//     zurückgeschrieben — ein dav-load kann also schreiben und ein neues rev liefern. Zugehörige Nextcloud-Dateien bleiben unberührt.
//   POST { action: "dav-save", app, data, rev? } + Authorization: Bearer -> { ok:true, rev } (schreibt die App-Datendatei; mit rev nur, wenn die Datei
//     serverseitig unverändert ist — sonst 409 mit { conflict:true }. Ohne rev unconditional wie früher, alte Clients bleiben kompatibel.)
//     WebDAV-Gateway: Zugriff nur, wenn der Nutzer das Tool sehen darf (Gruppen-Sichtbarkeit). App-id -> Nextcloud-Pfad in DAV_APPS.
//     Für Apps in WRITE_REQUIRES_EDIT_PERMISSION (aktuell: vereinswiki) zusätzlich ein Bearbeiten-Recht (editGroupIds/resolveEditPermission) -> sonst 403.
//   POST { action: "dav-file-put", app, id, name, contentType, dataBase64 } + Authorization: Bearer -> { ok:true }
//     (lädt eine Binärdatei in den Unterordner dateien/ der App; id = UUID, Größe <= 10 MB; Sichtbarkeits-Check wie dav-load,
//      plus Bearbeiten-Recht-Check wie dav-save für Apps in WRITE_REQUIRES_EDIT_PERMISSION)
//   POST { action: "dav-file-get", app, id } + Authorization: Bearer    -> rohe Datei-Bytes (Content-Type von Nextcloud) | 404
//   POST { action: "dav-file-delete", app, id } + Authorization: Bearer -> { ok:true } (204/404 = Erfolg beim Aufräumen; Bearbeiten-Recht-Check wie dav-file-put)
//   POST { action: "dav-restricted-put", app, contentType, dataBase64 } + Bearer -> { ok:true }
//     (abgeschotteter Datei-Upload: die Datei wird IMMER unter dem eigenen, aus dem Token stammenden
//      Nutzernamen abgelegt und ist NUR für Eigentümer/viewGroupId/Admin lesbar — für sensible
//      Dokumente wie Führerschein-Kopien, anders als dav-file-get, das jedem mit Tool-Zugriff jede Id liefert)
//   POST { action: "dav-restricted-get", app, owner } + Bearer    -> rohe Datei-Bytes | 403 | 404
//   POST { action: "dav-restricted-delete", app, owner } + Bearer -> { ok:true }
//     (dav-restricted-get/-delete nur, wenn owner==eigener Nutzer ODER Admin ODER Mitglied der viewGroupId;
//      abgeschotteter Bereich je App in RESTRICTED_FILE_APPS konfiguriert)
//   POST { action: "fahrtenbuch-extern-submit", code, fahrt:{...} } -> { ok:true, id } | 400 | 403
//     (ohne Login: externe Eltern-Fahrt. code = PW_FAHRTENBUCH_EXTERN, JEDER der drei
//      fahrtenbuch-extern-*-Aktionen prüft ihn unabhängig. fahrt entspricht dem Fahrtenbuch-Schema,
//      wird serverseitig validiert/gecappt; quelle wird IMMER hart auf "extern" gesetzt, status
//      IMMER "abgeschlossen". id vom Client vorab per crypto.randomUUID() erzeugt -> erneuter Submit
//      mit gleicher id UND quelle "extern" überschreibt denselben Eintrag (Idempotenz bei Netzwerk-
//      Retry) -- interne Einträge sind davon bewusst ausgenommen, sonst könnte ein Zugriffscode-
//      Inhaber eine bestehende interne Fahrt per erratener/bekannter Id überschreiben.)
//   POST { action: "fahrtenbuch-extern-file-put", code, id, name, contentType, dataBase64 } -> { ok:true }
//     (Mängelfoto ohne Login, offener dateien/-Ordner wie dav-file-put, id = client-UUID.)
//   POST { action: "fahrtenbuch-extern-fuehrerschein-put", code, owner?, contentType, dataBase64 } -> { ok:true, owner }
//     (Führerschein-Kopie ohne Login, abgeschotteter Bereich wie dav-restricted-put, aber owner wird
//      bei Erst-Upload VOM SERVER vergeben (kein owner aus dem Body vertraut) und in der Antwort
//      zurückgegeben; Re-Upload schickt ihn zurück. Einsehbar später nur über dav-restricted-get/
//      -delete mit Login, siehe oben.)
//   ---- Kleiderbörse, kompletter Eltern-Weg OHNE Login (Ausweis = meta.externToken) ----
//   POST { action: "kbo-extern-start", token }                    -> { hinweis, listen{}, angebote[] } | 400 | 403 | 429
//     (nur FREIGEGEBENE Angebote, und je Angebot nur die oeffentlichen Felder: Name und
//      E-Mail der anbietenden Familie sowie die Anfragen verlassen den Worker NIE hierhin.)
//   POST { action: "kbo-extern-foto-put", token, id, contentType, dataBase64 } -> { ok:true }
//     (verkleinertes Foto vor dem Angebot ablegen, id = client-UUID; Bildtyp aus den ersten Bytes)
//   POST { action: "kbo-extern-foto-get", token, angebotId, fotoId } -> rohe Bild-Bytes | 400 | 403 | 404
//     (nur Fotos eines freigegebenen Angebots, Zugehoerigkeit wird geprueft)
//   POST { action: "kbo-extern-anbieten", token, art, groesse, zustand, bemerkung, fotos[], vorname, nachname, email }
//     -> { ok:true, id } | 400 | 403 | 409 | 429 | 502   (Status server-hart "wartet", nie aus dem Body)
//   POST { action: "kbo-extern-anfragen", token, angebotId, vorname, nachname, email, telefon, nachricht }
//     -> { ok:true, sent } | 400 | 403 | 404 | 410 | 429 | 502   (Mail an die anbietende Familie)
//   POST { action: "kbo-extern-weg-info", wegToken } -> { beschreibung, schonWeg } | 400 | 404 | 429
//   POST { action: "kbo-extern-weg", wegToken }      -> { ok:true, schonWeg? } | 400 | 404 | 429 | 502
//     (der "ist weg"-Klick aus der Mail; Ausweis ist der angebotseigene wegToken, nicht der Boersen-Link)
//   POST { action: "kb-extern-start", token }                     -> { aktion:{name,offen,artikel[]} } | 400 | 404 | 410 | 429
//   POST { action: "kb-extern-anmelden", token, vorname, nachname, jahrgang, passwort? }
//     -> { status:"neu" | "passwort" | "offen" | "ok", bestellung? } | 400 | 403 | 404 | 410 | 429
//   POST { action: "kb-extern-speichern", token, vorname, nachname, jahrgang, passwort?, neuesPasswort?, positionen[], kommentar }
//     -> { ok:true, letzteAenderung, positionen } | 400 | 403 | 404 | 409 | 410 | 429 | 502
//     (Kleiderbestellung ohne Vereinskonto: Spieler bestellen über einen Link mit 64-stelligem
//      Zufallstoken, der je Bestellaktion erzeugt und widerrufen wird. Schlüssel der Bestellung ist
//      Vorname+Nachname+Geburtsjahr, geschützt durch ein selbst vergebenes Passwort (PBKDF2 wie die
//      Konten). Der Handler baut GENAU EINEN Eintrag serverseitig zusammen und setzt quelle IMMER
//      hart auf "extern" — dav-save wäre hier falsch, es vertraut dem Aufrufer die ganze Datei an.
//      Die Menge kommt immer aus dem Katalog, nie aus dem Body. Details am Handler-Block am Dateiende.)
//   POST { action: "fahrtenbuch-belege-list", app:"fahrtenbuch", fahrtId } + Bearer
//     -> { belege:[{submittedAt,amount,desc,name,files:[{fileName,fileMime}]}] }
//     (Login + userMayAccessTool("fahrtenbuch") wie dav-load; KEIN Ownership-Check der konkreten
//      Fahrt, da fahrtId eine nicht erratbare UUID ist und nach dem Sichtbarkeits-Fix oben ein
//      Normalnutzer eine fremde fahrtId über die App ohnehin nicht mehr zu Gesicht bekommt. Listet
//      per WebDAV PROPFIND den Belegeingang-Ordner von sc-heiligenstadt-budget (anderes Nextcloud-
//      Verzeichnis, gleiches Konto) und liest nur die *.meta.json, deren Dateiname auf
//      "_fahrt-<fahrtId>.meta.json" endet — sc-heiligenstadt-budget/worker.js schreibt diesen
//      Suffix nur bei gültiger UUID. fahrtId wird hier zusätzlich serverseitig gegen FAHRT_ID_RE
//      geprüft, bevor sie in den Dateinamen-Vergleich einfließt.)
//   POST { action: "fahrtenbuch-beleg-file-get", app:"fahrtenbuch", fahrtId, fileName } + Bearer
//     -> Datei-Bytes (Content-Type wie Original) | 400/403/404
//     (liest eine einzelne, zu fahrtId gehörende Beleg-Datei aus demselben Ordner wie oben, für den
//      "Beleg anzeigen"-Knopf im Fahrtenbuch-Modal. fileName kommt vom Client — wird serverseitig
//      gegen ein Muster geprüft, das zwingend den "_fahrt-<fahrtId>"-Suffix enthalten muss, sonst
//      könnte ein Nutzer über einen erratenen/kopierten Dateinamen fremde Kassierer-Belege im
//      selben geteilten Ordner lesen.)
//   POST { action: "my-testspielplaner-status" } + Bearer -> { anstehendOhneGegner }
//     (Badge auf der Testspielplaner-Kachel: Anzahl EIGENER genehmigter Reservierungen ohne Gegner in den
//      nächsten 14 Tagen. Logik spiegelt anstehendeOhneGegner() in E:\testspielplaner\app.js.)
//   POST { action: "verify-action-password", scope, password }    -> { ok:true } | 403 — ohne Login; prüft die früher im
//     Client hartkodierten Aktions-Passwörter gegen Worker-Secrets (Scope-Liste: ACTION_PASSWORD_SECRETS).
//   POST { action: "beleg-eingang-notify", code, name, desc, amount, date, note, fileCount }
//     -> { ok:true, sent:true } | { ok:true, sent:false, reason } | 400 | 403 | 502
//     (ohne Login: Benachrichtigungsmail nach einer Beleg-Einreichung aus beleg-eingang.html.
//      Wird NICHT vom Browser aufgerufen, sondern serverseitig vom eigenen Beleg-Upload-Worker
//      (sc-heiligenstadt-budget/worker.js) über dessen Service Binding, NACHDEM der Beleg schon in
//      Nextcloud liegt. code = PW_BUDGET_EINGANG_ZUGANG, hier eigenständig geprüft — die URL dieses
//      Workers ist öffentlich, ohne eigene Prüfung wäre das ein offener Mail-Versender. Empfänger
//      kommt aus der Variable NOTIFY_BELEG_EMAIL, nie aus dem Body. Fehlt die Variable oder der
//      BREVO_API_KEY, ist die Aktion ein stiller No-Op (sent:false) statt eines Fehlers: der Beleg
//      ist zu diesem Zeitpunkt bereits gespeichert, eine ausbleibende Mail darf die Einreichung
//      nicht nachträglich als gescheitert erscheinen lassen.)
//   POST { action: "fotoauftrag-ordner-anlegen", id } + Bearer -> { ok:true, auftrag, rev } | 400 | 403 | 404 | 409 | 502
//     (Fotoaufträge: legt für einen offenen Auftrag serverseitig einen dedizierten Nextcloud-Ordner an UND
//      erzeugt darauf einen echten, eigenständigen öffentlichen Freigabelink über die Nextcloud OCS-Sharing-API
//      (shareType=3, permissions=15 = Ansehen+Hochladen) — pro Auftrag ein eigener, einzeln funktionierender
//      Link, kein gemeinsamer Link für alle Teams. Nur der zuständige Trainer (eigenes mannschaften-Profil
//      enthält den Team-Namen des Auftrags) oder ein Editor/Admin darf das auslösen. Zweiphasig: Status
//      offen->wird-angelegt zuerst als ETag-gesicherte Reservierung (verhindert doppelte Freigaben bei
//      gleichzeitigen Klicks auf denselben Auftrag), erst danach MKCOL+OCS-Aufruf, dann
//      wird-angelegt->ordner-angelegt. fotoauftraege steht zusätzlich in TEAM_FILTERED_APPS (siehe dort) —
//      dav-load liefert Nicht-Editoren nur Aufträge der eigenen Mannschaft(en), und in
//      WRITE_REQUIRES_EDIT_PERMISSION — generisches dav-save ist für Nicht-Editoren komplett gesperrt.)
//   POST { action: "fotoauftrag-spielbericht-hochladen", id, text, dataBase64 } + Bearer
//     -> { ok:true, auftrag, rev } | 400 | 403 | 404 | 409 | 413 | 502
//     (Fotoaufträge: lädt eine vom Client aus dem Spielbericht-Freitext erzeugte .docx
//      in denselben Ordner wie die Fotos — landet automatisch im selben Freigabelink.
//      Nur möglich, wenn der Auftrag schon einen ordnerPfad hat (Ordner muss existieren).
//      Gleiche Berechtigung wie fotoauftrag-ordner-anlegen: Editor oder eigenes
//      mannschaften-Profil enthält den Team-Namen. Fixer Dateiname Spielbericht.docx,
//      Re-Upload überschreibt bewusst. text wird zusätzlich roh im Auftrag gespeichert,
//      damit die App ihn ohne erneuten Datei-Download anzeigen kann.)
//   POST { action: "fotoauftrag-loeschen", id } + Bearer -> { ok:true, rev } | 400 | 403 | 404 | 409 | 502
//     (Fotoaufträge, Editor/Admin-only: löscht NUR den JSON-Eintrag. Der zugehörige
//      Nextcloud-Ordner samt Fotos und Spielbericht bleibt bewusst stehen — er ist das
//      Bildarchiv des Vereins und überlebt den Arbeitszettel. Ordner räumt man bei Bedarf
//      direkt in Nextcloud auf. Gleiches gilt für die automatische Bereinigung, siehe
//      AUTO_PRUNE_APPS.)

const ALLOWED_ORIGINS = [
  "http://localhost:8767", // Materialliste (Dev-Server)
  "http://localhost:8768", // TrainerCheckliste (Dev-Server)
  "http://localhost:8769", // Trainerdaten (Dev-Server)
  "http://localhost:8770", // ToolsUebersicht (Dev-Server)
  "http://localhost:8771", // Spielertool (Dev-Server)
  "http://localhost:8772", // Vereinsbudget (Dev-Server)
  "http://localhost:8774", // Trainerversammlung-Anmeldung (Dev-Server)
  "http://localhost:8779", // Spielersichtung (Dev-Server)
  "http://localhost:8778", // Platzbelegung (Dev-Server)
  "http://localhost:8781", // Personalkosten (Dev-Server)
  "http://localhost:8777", // Vereinskalender (Dev-Server)
  "http://localhost:8792", // Busplan (Dev-Server)
  "http://localhost:8780", // Kadermanager (Dev-Server, bis 1.3 Spielerplus-Klon)
  "http://localhost:8794", // Digitaler Stempel (Dev-Server)
  "http://localhost:8795", // Kleiderbestellung (Dev-Server)
  "http://localhost:8796", // Fahrtenbuch (Dev-Server)
  "http://localhost:8782", // Spiele (Dev-Server)
  "http://localhost:8798", // Materialbedarf (Dev-Server)
  "http://localhost:8802", // Raumnutzung (Dev-Server)
  "http://localhost:8783", // Personalakte (Dev-Server)
  "http://localhost:8784", // Vereinswiki (Dev-Server)
  "http://localhost:8785", // Testspielplaner (Dev-Server)
  "http://localhost:8786", // Fotoaufträge (Dev-Server)
  "http://localhost:8787", // Abwesenheitskalender (Dev-Server)
  "http://localhost:8788", // Besprechung (Dev-Server)
  "http://localhost:8789", // Dokumentenvorlagen (Dev-Server)
  "http://localhost:8809", // Vereinsaufgaben (Dev-Server)
  "http://localhost:8811", // Ausbildungsplan (Dev-Server)
  "http://localhost:8812", // Schulsport (Dev-Server)
  "http://localhost:8813", // Spieltagscrew (Dev-Server)
  "http://localhost:8814", // Spielstatistik (Dev-Server)
  "http://localhost:8815", // Ablaufplan (Dev-Server)
  "http://localhost:8816", // Kontakte (Dev-Server)
  "http://localhost:8818", // Kleiderbörse (Dev-Server)
  // AgeLan haengt sonst an keinem Gateway (eigenes Firebase); seit dem Passwort-Gate
  // vor dem Streamplan ruft sie verify-action-password hier auf.
  "http://localhost:8791", // AgeLan (Dev-Server)
  // Vereinsverwaltung spricht sonst ihren EIGENEN Worker an (D1) und stand
  // deshalb nie hier. Seit der Nachwuchs-Anmeldung laedt sie die Nachweise
  // direkt hierher -- der Dev-Server braucht die Freigabe also doch.
  "http://localhost:8810", // Vereinsverwaltung (Dev-Server)
  "https://sc1911heiligenstadt.github.io",
  "https://tecko1985.github.io" // alte Adresse bis 2026-08: PWAs mit eigenem SW-Cache laufen dort noch
];

// Apps, die ihre Daten über das Gateway (Action dav-load/dav-save) in Nextcloud
// speichern. Key = Tool-id (wie in config.js/sichtbarkeit.json), Wert = volle
// WebDAV-URL der Datendatei. Pfade sind nicht geheim (stehen bereits in den
// öffentlichen App-Repos); geheim sind nur Konto + Passwort (Worker-Secrets).
const DAV_APPS = {
  "materialliste":     "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/06_Zeugwart/Materiallisten/materialdaten.json",
  "trainercheckliste": "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/TrainerCheckin/trainercheckin.json",
  "spielertool-test":  "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Spieler_Bewertung/spielerdaten.json",
  "spielersichtung":   "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Spielersichtung/spielersichtung.json",
  "platzbelegung":     "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Platzbelegung/platzbelegung.json",
  "personalkosten":    "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Personalkosten/personalkosten.json",
  "vereinskalender":   "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Vereinskalender/vereinskalender.json",
  "busplan":           "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Busplan/busplan.json",
  "kadermanager":      "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Spielerplus/spielerplus.json",
  "digitaler-stempel": "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/DigitalerStempel/digitaler-stempel.json",
  "kleiderbestellung": "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Kleiderbestellung/kleiderbestellung.json",
  "fahrtenbuch":       "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Fahrtenbuch/fahrtenbuch.json",
  "materialbedarf":    "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Materialbedarf/materialbedarf.json",
  "raumnutzung":       "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Raumnutzung/raumnutzung.json",
  "personalakte":      "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Personalakte/personalakte.json",
  "vereinswiki":       "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Vereinswiki/vereinswiki.json",
  "testspielplaner":   "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Testspielplaner/testspielplaner.json",
  "fotoauftraege":     "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Fotoauftraege/fotoauftraege.json",
  "abwesenheitskalender": "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Abwesenheitskalender/abwesenheitskalender.json",
  "dokumentenvorlagen": "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Dokumentenvorlagen/dokumentenvorlagen.json",
  "ausbildungsplan":   "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Ausbildungsplan/ausbildungsplan.json",
  "schulsport":        "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Schulsport/schulsport.json",
  "spielstatistik":    "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Spielstatistik/spielstatistik.json",
  "ablaufplan":        "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Ablaufplan/ablaufplan.json",
  "kleiderboerse":     "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Kleiderboerse/kleiderboerse.json"
};

// Archivdatei des Schulsport-Planers: abgeschlossene Schuljahre wandern hierhin,
// damit die laufende Datei klein bleibt (sie wird bei JEDEM Speichern vollständig
// übertragen, und unterschriebene Nachweise tragen je ~15 kB Unterschriftsbild).
//
// ⚠️ Bewusst KEIN zweiter DAV_APPS-Eintrag: eine App-Id ohne eigenen Eintrag in
// config.tools kommt an userMayAccessTool nicht vorbei (`if (!entry) return false`),
// alle Nicht-Admins bekämen also 403. Deshalb zwei eigene schmale Aktionen, die
// die Rechte des Schulsport-Tools mitbenutzen.
const SCHULSPORT_ARCHIV_URL =
  "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Schulsport/schulsport-archiv.json";

// Basis-Ordner für die von Fotoaufträge erzeugten Foto-Upload-Ordner (getrennt
// von DAV_APPS, da dort nur die JSON-Datendatei der App steht, nicht der
// Foto-Baum). "06_Social Media" ist ein eigenständiger Ordner auf oberster
// Ebene (Geschwister von 05_Nachwuchsbereich/02_Geschäftsstelle/etc.), NICHT
// unter 05_Nachwuchsbereich verschachtelt -- mit Michel am 2026-07-13
// bestätigt. Muss nicht vorher manuell angelegt werden: ensureCollection()
// legt fehlende Ebenen (auch diesen Ordner selbst) beim ersten Ordner-Anlegen
// automatisch an, wie überall sonst in dieser Datei.
const FOTOAUFTRAEGE_ORDNER_BASIS = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/06_Social Media";

// Belegeingang-Ordner von sc-heiligenstadt-budget (eigenes Repo/eigener Worker,
// aber dasselbe Nextcloud-Konto -- volle Admin-WebDAV-Credentials reichen, kein
// Service Binding nötig). Anderer Zweig als alles in DAV_APPS (Geschäftsstelle
// statt Nachwuchsbereich), deshalb eigene Konstante statt Ableitung aus DAV_APPS.
// Nur für handleFahrtenbuchBelegeList (read-only) verwendet.
const BELEGE_EINGANG_DIR =
  "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/02_Geschäftsstelle/Belege_aus_Belegtool";

// Apps, bei denen Schreiben (dav-save/dav-file-put/dav-file-delete) zusätzlich zur
// reinen Tool-Sichtbarkeit ein explizites Bearbeiten-Recht voraussetzt (editGroupIds,
// serverseitig über resolveEditPermission geprüft) — nicht nur ein UI-Hinweis wie
// bisher bei den anderen Apps mit canEdit(). Wer sehen, aber nicht bearbeiten darf,
// bekommt hier ein hartes 403 statt zu schreiben. Für Apps mit echtem Selbstbedienungs-
// Muster (jeder legt/verwaltet nur eigene Einträge, z.B. Fahrtenbuch, Materialbedarf,
// Testspielplaner) ist das NICHT die richtige Schublade — die stehen stattdessen in
// OWNER_FILTERED_APPS weiter unten (Nicht-Editoren schreiben weiterhin, aber nur ihre
// eigenen Einträge). Apps, die in KEINEM der beiden Sets stehen (z.B. kleiderbestellung,
// digitaler-stempel), behalten das alte Verhalten: wer das Tool sehen darf, darf auch
// das ganze Dokument schreiben — dort ist Bearbeiten-Recht bisher nur eine UI-Blende.
const WRITE_REQUIRES_EDIT_PERMISSION = new Set([
  "vereinswiki",
  "materialliste", "trainercheckliste", "spielertool-test", "spielersichtung",
  "personalkosten", "busplan", "vereinskalender", "kadermanager", "platzbelegung",
  "fotoauftraege", "raumnutzung",
  // seit 2026-07-24 (Spec klare-rechte-trennung, "Sehen = wirklich nur sehen"):
  // dokumentenvorlagen -- generisches dav-save pflegt den Vorlagen-Katalog, das ist
  //   eine Bearbeiter-Taetigkeit; die Dokument-Erzeugung (dav-load + lokaler Fill,
  //   IBAN ueber den canAdmin-Proxy) bleibt fuer Nur-Seher moeglich. Kehrt die
  //   fruehere Notiz "wer sehen darf, darf den Katalog pflegen" bewusst um.
  // personalakte -- Defense-in-Depth: der Client ruft generisches dav-save NIE auf
  //   (Schreibzugriffe laufen ueber archive-/reactivate-trainer, die serverseitig
  //   schon resolveEditPermission pruefen). Das Set schliesst nur das latente,
  //   handgebaute dav-save-Loch. Bricht nichts.
  "dokumentenvorlagen", "personalakte",
  // seit 2026-07-24 (2. Runde, Michel-Entscheidung "Sehen = absolut nichts editierbar"):
  // frühere Selbstbedienung braucht jetzt Bearbeiten-Recht -- ein Nur-Seher kann in diesen
  // Apps NICHTS mehr anlegen/schreiben (auch keine eigenen Einträge). Der WRITE_REQUIRES-
  // Check in handleDavSave steht VOR der OWNER_FILTERED/OWNER_WRITE-Routung, greift also
  // zuerst; materialbedarf/abwesenheitskalender bleiben in ihren Owner-Sets nur noch für
  // den LESE-Filter relevant (Editoren unberührt).
  "materialbedarf", "kleiderbestellung", "abwesenheitskalender", "digitaler-stempel",
  // ausbildungsplan (neu 2026-07-31): Nur-Seher lesen Stufen, Schwerpunkte und
  // Uebungen, schreiben aber gar nichts -- weder den Katalog noch einen
  // Spieltag-Bogen. Beides laeuft ueber generisches dav-save, deshalb reicht hier
  // der Set-Eintrag; die Trennung Boegen (Bearbeiten) vs. Katalog (Administrieren)
  // ist eine Client-Unterscheidung ueber canEdit()/canAdmin().
  "ausbildungsplan",
  // schulsport (neu 2026-08-05): Uebungsleiter haben hier BEWUSST nur Sehen-Recht.
  // Ihr einziger Schreibweg ist die schmale Aktion schulsport-meldung, deren Gate
  // die Team-Zugehoerigkeit zur Massnahme ist -- nicht resolveEditPermission.
  // Ohne diesen Set-Eintrag koennte jeder Uebungsleiter per generischem dav-save
  // die gesamte Planung UND fremde Nachweisdaten ueberschreiben; ein Nachweis
  // soll sich aber nicht von anderer Seite aendern lassen.
  "schulsport",
  // spielstatistik (neu 2026-08-10): eine einzige Datei traegt Einsaetze, Minuten,
  // Tore und Karten mehrerer Saisons. Ein versehentliches dav-save eines Nur-Sehers
  // wuerde die komplette Vereinshistorie ueberschreiben -- Merge gibt es nicht,
  // nur Last-Write-Wins. Schreiben deshalb strikt an das Bearbeiten-Recht.
  "spielstatistik",
  // ablaufplan (neu 2026-08-12): Sehen steht hier auf "alle eingeloggten Nutzer",
  // damit jeder Trainer den Ablauf nachschlagen und den Link weitergeben kann.
  // Genau deshalb MUSS Schreiben am Bearbeiten-Recht haengen: in ablaeufe[] steht
  // je Ablauf das linkToken, mit dem der login-lose Weg aufgeht. Ohne diesen
  // Eintrag koennte jeder Seher per dav-save ein fremdes Token setzen, einen
  // Widerruf zuruecknehmen oder den Medientag umschreiben.
  "ablaufplan",
  // kleiderboerse (neu 2026-08-19): Sehen steht auf "alle eingeloggten Nutzer",
  // damit jeder Trainer nachschauen kann, was in der Boerse steht. Schreiben
  // MUSS deshalb am Bearbeiten-Recht haengen: in meta.externToken steht der
  // Schluessel des login-losen Eltern-Links, und in angebote[].anbieter liegen
  // Name und E-Mail von Vereinsfamilien. Ohne diesen Eintrag koennte jeder
  // Seher per dav-save ein fremdes Token setzen, den Widerruf zuruecknehmen
  // oder ein Angebot an der Freigabe vorbei auf "frei" heben.
  "kleiderboerse"
]);
// fotoauftraege zusätzlich hier (nicht nur in TEAM_FILTERED_APPS weiter unten):
// normale Trainer dürfen generisches dav-save für diese App NIE aufrufen (auch
// nicht für eigene Aufträge) — ihr einziger Schreibzugriff ist die dedizierte,
// eigens validierte Aktion fotoauftrag-ordner-anlegen. Anlegen/Löschen von
// Aufträgen und "erledigt"-Markierung bleiben Editoren (Social-Media-Gruppe)
// vorbehalten.
// testspielplaner + fahrtenbuch: bewusst NICHT hier -- weiter Selbstbedienung
// (Testspiel-Anfrage bzw. eigene Fahrten), von Michel in dieser Runde nicht zum
// Sperren gelistet; ihr Anlege-Weg für Nicht-Editoren läuft über OWNER_FILTERED_APPS.

// Datendateien, in die das Auto-Provisioning (provisionUser) schreiben darf, die aber
// bewusst NICHT über DAV_APPS für dav-load/dav-save geöffnet sind: Trainerdaten
// enthält IBAN-Daten und läuft sonst über den eigenen submit-worker — die Datei hier
// nur intern (server-seitig) beschreiben, nie für eingeloggte Nutzer lesbar machen.
const PROVISION_ONLY_PATHS = {
  "trainerdaten": "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Trainerdaten/trainerdaten.json"
};

// Absender für handleNotifyUser (E-Mail-Adresse selbst ist nicht geheim, deshalb
// Konstante statt Secret). TODO Michel: echte Nachwuchs-Adresse eintragen UND bei
// Brevo als Einzel-Absender verifizieren (Bestätigungslink an genau diese Adresse),
// sonst lehnt Brevo den Versand ab.
const NOTIFY_FROM_EMAIL = "nachwuchs@sc1911-heiligenstadt.de";
const NOTIFY_FROM_NAME = "SC 1911 Heiligenstadt";

// Empfänger, Betreff und Text der Raumnutzungs-Antragsmail (siehe
// handleRaumnutzungMailAntrag). Beide Adressen sind öffentliche
// Funktionspostfächer — Amt des Landkreises und Geschäftsstelle des Vereins —,
// deshalb Konstanten statt Secrets, gleiche Einordnung wie NOTIFY_FROM_EMAIL.
// Sie stehen SERVERSEITIG und werden nie aus dem Request übernommen: käme die
// Zieladresse aus dem Body, wäre die Aktion für jeden Raumnutzungs-Bearbeiter
// ein Versandweg an beliebige Empfänger — mit dem Verein als Absender. Gleiche
// Härtung wie NOTIFY_BELEG_EMAIL bei handleBelegEingangNotify.
const RAUMNUTZUNG_MAIL_TO = "Schulverwaltungsamt@kreis-eic.de";
const RAUMNUTZUNG_MAIL_CC = "Info@sc1911-heiligenstadt.de";
const RAUMNUTZUNG_MAIL_SUBJECT = "Antrag auf Raumnutzung für Veranstaltungen – SC 1911 Heiligenstadt";
const RAUMNUTZUNG_MAIL_TEXT = [
  "Sehr geehrte Damen und Herren,",
  "",
  "anbei erhalten Sie den Antrag auf Raumnutzung für Fußball Hallenturniere des",
  "1.SC 1911 Heiligenstadt e.V. als PDF im Anhang.",
  "",
  "Der Antrag ist vollständig ausgefüllt und enthält alle gewünschten Termine mit",
  "Halle, Datum und Uhrzeit sowie die verantwortliche Ansprechperson des Vereins.",
  "",
  "Wir bitten um Prüfung und um eine kurze Rückmeldung, ob die beantragten Zeiten",
  "so bestätigt werden können. Sollten einzelne Termine nicht möglich sein oder",
  "Unterlagen fehlen, melden Sie sich bitte gern — wir passen den Antrag dann an.",
  "",
  "Vielen Dank für Ihre Mühe.",
  "",
  "Freundliche Grüße",
  "Uwe Meinold",
  "",
  "Geschäftsstellenleiter",
  "1.SC Heiligenstadt e.V.",
  "Leineberg 2",
  "37308 Heilbad Heiligenstadt",
  "Telefon: 03606/ 612206",
  "Mail: Info@sc1911-heiligenstadt.de"
].join("\n");

// Feedback & Wünsche aus dem Feedback-Tab (seit 1.10) — eigene Datei, damit ein
// einfacher eingeloggter Nutzer per submit-feedback schreiben darf (Einzeleintrag,
// serverseitig zusammengebaut) ohne Zugriff auf sichtbarkeit.json/nutzer.json zu
// bekommen. Nicht in DAV_APPS: kein generisches dav-load/dav-save, sondern eigene
// Aktionen mit eigener Validierung (siehe handleSubmitFeedback/handleListFeedback/
// handleSaveFeedback).
const FEEDBACK_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/feedback.json";

// Emoji-Reaktionen auf die Neuigkeiten (seit 1.13) — eigene Datei, getrennt vom
// news-Key in sichtbarkeit.json, damit Admin-News-Bearbeiten (save-news, kompletter
// Array-Ersatz) und die Reaktionen jedes Nutzers nie kollidieren. Aufbau:
//   { version:1, byNews: { "<newsId>": { "<username>": "<emoji>" } } }
// Genau EINE Reaktion pro Nutzer je Meldung -> triviales Umschalten/Entfernen,
// Zähler = auszählen. Der öffentliche GET liefert daraus NUR Zähler (keine Namen).
const NEWS_REACTIONS_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/neuigkeiten-reaktionen.json";

// Persönliche Ansicht der Startseite (seit 2026-08-07): Kacheln oder Liste, dazu die
// selbst gewählte Reihenfolge je Kategorie. Aufbau:
//   { version:1, byUser: { "<username>": { modus, reihenfolge: {"<kategorie>":[toolIds]}, gespeichertAm } } }
//
// ⚠️ BEWUSST eine eigene Datei und KEIN Feld in nutzer.json — dieselbe Überlegung wie
// bei push-abos.json und kalender-abos.json: nutzer.json wird bei jeder
// Sitzungsprüfung der GANZEN Flotte gelesen, und jedes Verschieben einer Kachel
// schriebe sie neu. Ein Last-Write-Wins-Konflikt trifft dort Passwort-Hashes und
// Gruppen; hier trifft er nur eine Anzeige-Vorliebe.
const ANSICHT_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/ansicht.json";

// Deckel gegen das Aufblähen einer Datei, die jeder Angemeldete beschreiben darf.
// Die Flotte hat rund 35 Werkzeuge in einer Handvoll Kategorien — die Grenzen liegen
// weit darüber und werden im Normalbetrieb nie erreicht.
const ANSICHT_MAX_KATEGORIEN = 40;
const ANSICHT_MAX_IDS_PRO_KATEGORIE = 200;
const ANSICHT_MODI = ["kacheln", "liste"];

// Persönliche Aufgabenlisten (seit 1.5) — eigene Datei aus demselben Grund wie die
// Neuigkeiten-Reaktionen: sichtbarkeit.json wird von Admin-Aktionen komplett
// ersetzt (save-visibility/save-news), die Aufgaben schreibt dagegen jeder
// Eingeloggte laufend. Aufbau:
//   { version:1, byUser: { "<username>": [ { id, text, faellig, erledigt, ... } ] } }
// Der Rückkanal "von mir zugewiesen" braucht KEINE zweite Struktur: er ist ein
// Filter über byUser auf von === eigener Nutzername, also ein einziger Read.
// Die KONFIGURATION (wer zuweisen darf) liegt dagegen bewusst in sichtbarkeit.json
// unter aufgaben.assignGroupIds — das ist Konfiguration, keine Nutzdaten.
const AUFGABEN_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/aufgaben.json";

// Grenzen je Nutzer. Ohne Deckel wächst eine gemeinsame Datei unbegrenzt, und sie
// wird bei JEDEM Aufgaben-Zugriff komplett gelesen und geschrieben.
const AUFGABEN_MAX_PRO_NUTZER = 200;
const AUFGABEN_MAX_TEXT = 200;
const AUFGABEN_MAX_EMPFAENGER = 20;
// Erledigte Zuweisungen bleiben stehen, damit der Zuweiser sie in seiner
// Rückansicht noch sieht — der Aufräumen-Knopf des Empfängers lässt sie deshalb
// bewusst stehen. Zurückgezogene bleiben kürzer: sie sind nur ein Hinweis.
const AUFGABEN_ZUGEWIESEN_ERLEDIGT_TAGE = 14;
const AUFGABEN_ZURUECKGEZOGEN_TAGE = 7;

// Zu unterschreibende Dokumente. BEWUSST eine eigene Datei neben aufgaben.json:
// aufgabenPrune() löscht eine erledigte Zuweisung 14 Tage nach dem Abhaken hart aus
// der Datei — ein Nachweis darf davon nicht mitgerissen werden. Die Aufgabe ist die
// Erinnerung und darf ablaufen, das unterschriebene Dokument ist das Ergebnis und
// bleibt, bis es jemand ausdrücklich löscht. Aufbau:
//   { version:1, byId: { "<dokId>": { id, titel, von, empfaenger, status, ... } } }
// Indiziert nach Dokument-Id statt nach Nutzer, weil jeder Eintrag ZWEI Beteiligte
// hat (Absender + Empfänger) — eine byUser-Map müsste ihn doppelt führen.
const DOKUMENTE_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/dokumente.json";

// Die PDFs liegen in einem EIGENEN Unterordner, ausdrücklich nicht in "dateien".
// dav-file-get ist nur durch die Tool-Sichtbarkeit gegated und liefert jedem mit
// Tool-Zugriff jede Datei-Id aus; für unterschriebene Verträge reicht das nicht.
// Da davFileDir() fest auf "dateien" zeigt, kann dav-file-get diesen Ordner gar
// nicht erreichen — der Zugriff läuft ausschließlich über dokument-datei-get mit
// eigener Beteiligten-Prüfung (gleiches Prinzip wie RESTRICTED_FILE_APPS).
const UNTERSCHRIFTEN_DIR = DOKUMENTE_URL.slice(0, DOKUMENTE_URL.lastIndexOf("/")) + "/unterschriften";

const DOKUMENT_MAX_TITEL = 200;
const DOKUMENT_MAX_ABLEHNGRUND = 500;
// Deckel für die gemeinsame Datei. Anders als bei den Aufgaben zählt hier nicht pro
// Nutzer, sondern insgesamt: ein Dokument gehört zwei Leuten.
const DOKUMENTE_MAX_GESAMT = 2000;

// ---------- Medien-Anhänge der Neuigkeiten (seit 2026-08-03) ----------
//
// Eigener Ordner neben den Unterschriften, aus demselben Grund: es gibt keinen
// generischen dav-Weg dorthin (ToolsUebersicht steht nicht in DAV_APPS).
//
// ⚠️ Die Dateien liegen NICHT in sichtbarkeit.json. Diese Datei wird bei JEDEM
// Seitenaufruf gelesen, um die Kachel-Sichtbarkeit zu bestimmen -- ein
// eingebettetes base64-Bild wuerde jeden einzelnen Aufruf der Landingpage
// mitschleppen. In der Meldung steht nur die Datei-Id.
const NEUIGKEITEN_DIR = DOKUMENTE_URL.slice(0, DOKUMENTE_URL.lastIndexOf("/")) + "/neuigkeiten";
const NEWS_MAX_MEDIEN = 4;
const NEWS_MAX_VIDEO_URL = 500;
// Nach so vielen Kalendertagen (Europe/Berlin, gerechnet ab dem DATUM der
// Meldung) verschwindet eine Neuigkeit automatisch -- siehe
// newsAbgelaufeneBereinigen weiter unten.
const NEWS_MAX_ALTER_TAGE = 14;

// Erlaubte Formate. Der Typ wird IMMER aus den ersten Bytes bestimmt, nie aus der
// Angabe des Clients -- eine umbenannte .exe soll nicht als "image/png" landen und
// spaeter mit diesem Content-Type wieder ausgeliefert werden.
function erkenneMedientyp(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", art: "bild" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", art: "bild" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mime: "image/gif", art: "bild" };
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: "image/webp", art: "bild" };
  // ISO-BMFF: Groessenfeld, dann "ftyp" -- deckt mp4, m4v und die iPhone-Aufnahme ab
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return { mime: "video/mp4", art: "video" };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: "video/webm", art: "video" };
  return null;
}

const NEWS_MIME_ERLAUBT = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm"];

// ---------- Nutzerfotos (seit 2026-08-04) ----------
//
// Ein Bild je Konto, hinterlegt im Tab "Mein Konto". Der DATEINAME IST DER
// NUTZERNAME -- deshalb braucht es keine Datei-Id, kein Feld mit einer Id und
// keinen Aufräumweg: ein neues Bild überschreibt das alte, es kann gar nichts
// verwaisen. Denselben Kniff nutzt der abgeschottete dav-restricted-Bereich.
//
// ⚠️ Der Preis steht in handleUpdateUser: wird ein Konto umbenannt (passiert bei
// jeder Namenskorrektur automatisch), muss die Datei mitwandern, sonst ist das
// Bild weg. Und in handleDeleteUser: ein Foto ist ein Personenbezug und darf ein
// gelöschtes Konto nicht überleben.
//
// Warum nicht base64 in nutzer.json: die Datei wird bei JEDER Session-Prüfung der
// gesamten Flotte gelesen. 540 Konten mit eingebettetem Bild wären mehrere MB pro
// Request -- dieselbe Überlegung wie bei den Neuigkeiten-Medien, nur schärfer.
const NUTZERFOTOS_DIR = DOKUMENTE_URL.slice(0, DOKUMENTE_URL.lastIndexOf("/")) + "/nutzerfotos";

// Eigene, viel engere Grenze als MAX_FILE_BYTES (10 MB): der Client liefert ein
// 320x320-JPEG mit 25-40 KB. 512 KB lassen jedem vernünftigen Bild Luft und
// verhindern, dass 200 Spielerkonten Rohdateien vom Handy ablegen.
const NUTZERFOTO_MAX_BYTES = 512 * 1024;

// Nur Standbilder. erkenneMedientyp() kennt auch GIF und die beiden Videoformate --
// ein animiertes Profilbild ist hier nicht gewollt, und ein Video schon gar nicht.
const NUTZERFOTO_MIME_ERLAUBT = ["image/jpeg", "image/png", "image/webp"];

// ---------- Vereinsaufgaben (eigene App) ----------
//
// Aufgaben, die Funktionären aufgetragen werden — mit Ressorts als dauerhafte
// Zuständigkeiten. BEWUSST getrennt von den persönlichen Aufgaben oben: dort steht,
// was jemand sich selbst notiert, hier ausschließlich, was einer einem anderen
// aufträgt. Deshalb auch eine eigene Datei und ein eigener Rechte-Rahmen.
//
// "vereinsaufgaben" steht mit Absicht NICHT in DAV_APPS. Es gibt damit keinen
// generischen dav-load/dav-save-Weg auf diese Datei — jeder Zugriff läuft über die
// Aktionen unten, die Rolle, Beteiligung und Statusübergang selbst prüfen. Ein
// generisches dav-save wäre die offene Hintertür an allen drei Regeln vorbei:
// vertrauliche Texte, "Empfänger darf nur abhaken" und das Protokoll.
const VEREINSAUFGABEN_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Vereinsaufgaben/vereinsaufgaben.json";

// Anhänge liegen in einem eigenen Unterordner, den dav-file-get nicht erreicht
// (davFileDir() zeigt fest auf "dateien", und ohne DAV_APPS-Eintrag gibt es keine
// App-Id, über die man den Ordner adressieren könnte). Gleiches Prinzip wie
// UNTERSCHRIFTEN_DIR: eine vertrauliche Aufgabe wäre wertlos, wenn ihr Anhang
// über eine geratene Datei-Id abrufbar bliebe.
const VA_ANHANG_DIR = VEREINSAUFGABEN_URL.slice(0, VEREINSAUFGABEN_URL.lastIndexOf("/")) + "/anhaenge";

const VA_MAX_AUFGABEN = 5000;      // Deckel für die gemeinsame Datei
const VA_MAX_TITEL = 200;
const VA_MAX_BESCHREIBUNG = 4000;
const VA_MAX_GRUND = 1000;
const VA_MAX_KOMMENTAR = 1000;
const VA_MAX_KOMMENTARE = 100;     // je Aufgabe
const VA_MAX_ANHAENGE = 10;        // je Aufgabe
const VA_MAX_EMPFAENGER = 30;      // je Zuweisungsvorgang
const VA_MAX_ANHANG_BYTES = 8 * 1024 * 1024;
const VA_MAX_PROTOKOLL = 2000;
const VA_PRIORITAETEN = ["hoch", "normal", "niedrig"];
// Sperrfrist zwischen zwei Erinnerungen an DERSELBEN Aufgabe. Eine Erinnerung
// kostet den Empfänger eine Mail UND eine Nachricht aufs Handy; ohne Frist wäre
// der Knopf ein beliebig oft drückbarer Störsender, und mehrere gleiche Meldungen
// hintereinander lassen jede weitere ignorieren. Zwölf Stunden heißt praktisch:
// höchstens einmal morgens und einmal abends.
const VA_ERINNERUNG_SPERRE_MS = 12 * 60 * 60 * 1000;

// Apps mit serverseitig abgeschottetem Datei-Bereich: Dateien in diesem Unterordner
// (statt "dateien") liefert/löscht das Gateway NUR für den Eigentümer, Admins und
// Mitglieder der viewGroupId — unabhängig davon, wer sonst Zugriff auf das Tool hat.
// Anders als dav-file-get (das jedem mit Tool-Zugriff jede Datei-Id ausliefert) ist das
// die echte serverseitige Abschottung für sensible Dokumente (z. B. Führerschein-Kopien).
// Die Datei liegt unter <app-ordner>/<subdir>/<eigentuemer-username>, der Nutzername ist
// zugleich der Zugriffsschlüssel (genau ein Dokument je Nutzer, Re-Upload überschreibt).
// fahrtenbuch (seit 1.1-extern): externe Eltern haben keinen Login-Nutzernamen als
// natürlichen Schlüssel -- hier wird stattdessen ein serverseitig vergebener 32-Zeichen-
// Hex-Schlüssel verwendet, siehe handleFahrtenbuchExternFuehrerscheinPut. Eigener
// Unterordner-Name "fuehrerscheine-extern", damit er nicht mit Trainerdatens eigenem,
// andersartigem Führerschein-Pfad kollidiert (Trainerdaten enthält IBAN-Daten und ist
// bewusst nicht generisch über dieses Gateway erreichbar, siehe PROVISION_ONLY_PATHS).
const RESTRICTED_FILE_APPS = {
  fahrtenbuch: { subdir: "fuehrerscheine-extern", viewGroupId: "fuehrerschein-einsicht" }
};

// Apps, bei denen dav-load/dav-save NICHT das ganze Dokument an jeden Tool-Nutzer
// durchreichen, sondern für Nutzer ohne Bearbeiten-Recht (resolveEditPermission)
// auf listField ein Eigentümer-Filter greift (ownerField === eigener Username).
// Grund: die bisherige rein clientseitige Filterung (z.B. Fahrtenbuchs
// visibleFahrten()) verhindert nur die Anzeige, nicht aber, dass das komplette
// Array (fremde Fahrten inkl. Mängel-Fotos/Adressen) über dav-load im Klartext
// beim Client ankommt (DevTools-Network-Tab oder Konsolen-fetch reichen). Editoren/
// Admin (resolveEditPermission) bekommen weiterhin das volle Dokument, unveraendert.
// Siehe handleDavLoad/handleOwnerFilteredSave für die Umsetzung.
const OWNER_FILTERED_APPS = {
  fahrtenbuch: { listField: "fahrten", ownerField: "erstelltVon" },
  materialbedarf: { listField: "meldungen", ownerField: "erstelltVon" },
  testspielplaner: { listField: "reservierungen", ownerField: "erstelltVon" }
};

// Wie OWNER_FILTERED_APPS, aber NUR fürs Schreiben: das Sichtbarkeitsmodell dieser
// App ist "voller Lesezugriff für jeden mit Tool-Sichtbarkeit" (jede:r soll alle
// Abwesenheiten sehen, damit eine interne Vertretungsregelung greift), kombiniert mit
// "Nicht-Bearbeiter dürfen nur eigene Einträge anlegen/ändern/löschen". Bewusst NICHT
// in OWNER_FILTERED_APPS aufgenommen: das würde in handleDavLoad auch das Lesen auf
// eigene Einträge einschränken, was hier falsch wäre. handleDavLoad wertet diese Map
// NICHT aus (kein Read-Filter); nur handleDavSave prüft sie zusätzlich und routet bei
// Treffer zur selben handleOwnerFilteredSave() (die kennt ohnehin keine
// Read-Filterung, kümmert sich rein ums Schreiben). Der Client bekommt beim Laden
// IMMER den vollen Array; ein Nicht-Bearbeiter muss vor dav-save selbst auf eigene
// Einträge filtern, sonst 400 "fremde oder ungültige Einträge".
const OWNER_WRITE_APPS = {
  abwesenheitskalender: { listField: "abwesenheiten", ownerField: "erstelltVon" }
};

// Wie OWNER_FILTERED_APPS, aber das Sichtbarkeitskriterium ist "eigene
// mannschaften (nutzer.json) enthält item[teamField]" statt "item[ownerField]
// === eigener Username" -- passend für Apps, bei denen Ersteller (Editor-
// Rolle, hier: Social-Media-Team) und Betroffener (eine Mannschaft/deren
// Trainer) zwei verschiedene Rollen sind. Bei fotoauftraege legt das
// Social-Media-Team den Auftrag an, aber der zuständige Trainer (nicht der
// Ersteller) muss ihn sehen/erfüllen dürfen -- OWNER_FILTERED_APPS würde ihm
// per erstelltVon-Filter nichts anzeigen. Editoren (resolveEditPermission)
// bekommen wie bei OWNER_FILTERED_APPS immer das volle Dokument. Wichtig auch
// aus Sicherheitssicht: fotoauftraege.freigabeLink ist ein echter, funktions-
// fähiger Bearer-Link -- ihn per dav-load an alle auszuliefern würde den
// ganzen Sinn hinter "isolierte Links pro Team" unterlaufen (gleiche Logik
// wie der Kommentar zu OWNER_FILTERED_APPS oben). Siehe handleDavLoad.
const TEAM_FILTERED_APPS = {
  fotoauftraege: { listField: "auftraege", teamField: "mannschaft" }
};

// Selbstaufraeumende Listen: Eintraege, deren Zeitstempel laenger als maxTageAlt
// zurueckliegt, werden bei jedem dav-load entfernt (siehe handleDavLoad).
// Bewusst KEIN Cloudflare-Cron-Trigger: die Bereinigung braucht keine Pünktlichkeit
// (sie soll nur verhindern, dass die Liste zulaeuft), und ein Cron-Trigger waere
// zusaetzliche Konfiguration ausserhalb des Repos, die deploy-worker.ps1 nicht
// mitdeployt. Der Stichtag wird bewusst SERVERSEITIG berechnet -- eine
// clientseitige Bereinigung wuerde der Uhr des Browsers vertrauen, und eine falsch
// gestellte Uhr wuerde dort fremde Datensaetze loeschen.
// Wichtig: das Aufraeumen entfernt nur den Listeneintrag, nie zugehoerige
// Nextcloud-Dateien (bei fotoauftraege sind das die Fotos = das Vereinsarchiv).
const AUTO_PRUNE_APPS = {
  fotoauftraege: { listField: "auftraege", dateField: "erstelltAm", maxTageAlt: 5 }
};

const PBKDF2_ITERATIONS = 100000; // siehe README: bewusst unter OWASP-210k, um im Cloudflare-Free-CPU-Limit zu bleiben
const SALT_BYTES = 16;
const HASH_BITS = 256;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 Tage
// Stichtag: jede Session, die VOR diesem Zeitpunkt ausgestellt wurde, gilt als
// beendet (Prüfung in getVerifiedSession). Nötig, weil die Laufzeit im Token
// steckt: das Senken von SESSION_TTL_SECONDS auf 7 Tage wirkt nur auf NEU
// ausgestellte Token, die alten 30-Tage-Token wären sonst noch bis zu vier
// Wochen weitergelaufen. Bewusst eine Konstante im Code statt eines Feldes in
// nutzer.json -- ein Stichtag ist ein einmaliges Ereignis, kein laufender
// Zustand, und so kostet die Prüfung keinen zusätzlichen Nextcloud-Lesezugriff.
// Für einen erneuten Rauswurf aller Nutzer (z.B. nach einem Vorfall) hier den
// Wert auf "jetzt" setzen und neu deployen. WICHTIG: nie einen Zeitpunkt in der
// ZUKUNFT eintragen -- dann wäre auch jedes frisch ausgestellte Login-Token
// sofort ungültig und niemand käme mehr herein.
const SESSIONS_INVALID_BEFORE = 1784700000; // 2026-07-22T06:00:00Z
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

// Zentrales Trainerprofil (seit 1.10): Lizenzstufe + betreute Mannschaft(en) je
// Nutzer, einmalig hier gepflegt statt in Personalkosten/Trainerdaten/etc.
// dupliziert. Werte übernommen aus Personalkosten config.js DEFAULT_PARAMETER.lizenzen.
const LIZENZ_OPTIONEN = ["", "ohne Lizenz", "Basis", "C", "B", "B Elite", "A"];

// Name der Gruppe, deren Mitglieder für Trainervertrag-/Trainerkodex-Quote im
// Admin-Dashboard zählen. Lookup nach Namen (nicht Id), da die Id nur beim
// Anlegen aus dem Namen slugifiziert wird und bei Umbenennung nicht
// automatisch nachzieht — der Name ist die stabile, für den Admin sichtbare
// Referenz. Muss einmalig manuell über das Gruppen-Panel (Einstellungen)
// angelegt werden.
const TRAINER_GROUP_NAME = "Trainer";

export default {
  // Naechtlicher Lauf der Spieltagscrew (seit 2026-08-10). Der ZWEITE bewusste
  // Bruch mit der Flottenentscheidung gegen Cron-Trigger -- der erste steht im
  // Vereinsverwaltungs-Worker fuer die naechtliche Sicherung. Begruendung ist
  // dieselbe Bauart: eine Erinnerung, die nur laeuft, wenn jemand die App
  // oeffnet, ist keine. Wer sieben Tage vor dem Heimspiel noch keinen Posten
  // hat, macht die App gerade NICHT auf.
  //
  // ⚠️ Der Zeitplan selbst steht NICHT in dieser Datei, sondern in der
  // Cloudflare-Konfiguration (Dashboard → Worker → Triggers → Cron). Ein
  // Script-Upload ueber deploy-worker.ps1 loescht ihn nicht, legt ihn aber auch
  // nicht an: fehlt er, laeuft diese Funktion nie und niemand merkt es. Genau
  // dagegen schreibt scLaufVermerken() eine sichtbare Zeile in den
  // Verwaltungs-Tab der App.
  //
  // Es gibt hier keine Sitzung und keinen Nutzer-Token -- der Auth-Header wird
  // wie im fetch-Zweig aus den Worker-Secrets gebaut.
  async scheduled(event, env, ctx) {
    const noetig = ["NEXTCLOUD_URL", "NEXTCLOUD_USERNAME", "NEXTCLOUD_PASSWORD", "NEXTCLOUD_NUTZER_URL"];
    if (noetig.some((name) => !env[name])) return;
    const authHeader = "Basic " + btoa(env.NEXTCLOUD_USERNAME + ":" + env.NEXTCLOUD_PASSWORD);

    // Seit 2026-08-12 zwei Zeitplaene. ⚠️ Die Weiche prueft NUR auf den
    // Fuenf-Minuten-Takt; alles andere -- auch ein fehlender oder unbekannter
    // Ausdruck -- laeuft wie bisher in den naechtlichen Lauf. So kann eine
    // Aenderung am Zeitplan die Spieltagscrew-Erinnerungen nicht stillegen.
    if (String((event && event.cron) || "") === ABLAUFPLAN_CRON) {
      ctx.waitUntil(ablaufplanErinnerungslauf(env, authHeader, ctx).catch(() => {}));
      return;
    }
    ctx.waitUntil(scNaechtlicherLauf(env, authHeader, ctx));
    // Busplan haengt sich an den BESTEHENDEN naechtlichen Lauf, statt einen
    // dritten Cron-Trigger zu verlangen: ein neuer Trigger muesste von Hand im
    // Cloudflare-Dashboard angelegt werden und waere genau die Art Schritt, die
    // beim naechsten Deploy vergessen wird. Eigener waitUntil, damit ein Fehler
    // hier die Spieltagscrew-Erinnerungen nicht mitreisst.
    ctx.waitUntil(busplanErinnerungslauf(env, authHeader, ctx).catch(() => {}));
  },

  // ctx (seit 2026-08-03): nur fuer ctx.waitUntil beim Push-Versand. Ohne den
  // dritten Parameter wartet der Nutzer auf die Zustellung an bis zu 30
  // Empfaenger, obwohl seine eigentliche Handlung laengst gespeichert ist.
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const requiredSecrets = ["NEXTCLOUD_URL", "NEXTCLOUD_USERNAME", "NEXTCLOUD_PASSWORD", "NEXTCLOUD_NUTZER_URL", "SESSION_SECRET"];
    const missingSecrets = requiredSecrets.filter((name) => !env[name]);
    if (missingSecrets.length > 0) {
      return json({ error: "Worker-Secrets nicht konfiguriert: " + missingSecrets.join(", ") }, 500, corsHeaders);
    }

    const authHeader = "Basic " + btoa(env.NEXTCLOUD_USERNAME + ":" + env.NEXTCLOUD_PASSWORD);

    // Alle Aktionen lesen zuerst aus Nextcloud. Schlägt so ein Read fehl, wirft
    // readJson (statt still einen leeren Fallback zu liefern) und der Client
    // bekommt 502 — sonst würde der nächste read-modify-write-Schreibzugriff
    // den kompletten Bestand (nutzer.json bzw. App-Daten) mit dem Fallback überschreiben.
    try {

    if (request.method === "GET") {
      // Der Kalender-Abo-Feed ist der einzige andere GET dieses Workers und muss
      // VOR der Sichtbarkeits-Antwort stehen. Er liefert text/calendar statt JSON
      // und traegt seinen Ausweis im Pfad -- ein Kalenderprogramm kann keinen
      // Bearer-Token schicken. Siehe den Vereinskalender-Abo-Block weiter unten.
      const icsTreffer = new URL(request.url).pathname.match(/^\/kalender\/([A-Za-z0-9_-]{32,100})\.ics$/);
      if (icsTreffer) return handleVkIcsFeed(request, icsTreffer[1], env, authHeader, corsHeaders);

      // Der GET ist der öffentliche Kanal (Tool-Sichtbarkeit für jeden Besucher),
      // trägt seit 2026-07-25 aber einen OPTIONALEN Bearer-Token: die Neuigkeiten
      // sind Vereinsinterna und gehen nur an Angemeldete. Ohne Token (oder mit einem
      // entwerteten) antwortet er wie bisher, nur mit news: null — nie mit einem Fehler,
      // sonst käme ein nicht angemeldeter Besucher gar nicht mehr auf die Seite.
      const payload = await getSession(request, env);
      const tokenOk = tokenAfterCutoff(payload);
      const [config, usersDoc, reactionsDoc] = await Promise.all([
        readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} }),
        readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc()),
        // Die Reaktions-Zähler nur lesen, wenn überhaupt jemand die Meldungen bekommt:
        // dem anonymen Besucher spart das einen kompletten Nextcloud-Read (~200-450 ms).
        tokenOk ? readJson(NEWS_REACTIONS_URL, authHeader, { version: 1, byNews: {} }) : Promise.resolve(null)
      ]);
      // Voller Nutzer-Abgleich, nicht nur die Token-Signatur: ein gelöschtes oder
      // archiviertes Konto soll die Meldungen nicht bis zum Token-Ablauf weiterlesen.
      // Kostet nichts, usersDoc wird für bootstrapAvailable ohnehin gelesen.
      const angemeldet = tokenOk && !!sessionUserFromDoc(payload, usersDoc);
      // Abgelaufene Meldungen (Datum aelter als NEWS_MAX_ALTER_TAGE) verlassen den
      // Worker nie mehr -- und ihr Fund stoesst HINTER der Antwort die eigentliche
      // Loeschung an (ctx.waitUntil, samt Medien-Dateien und Reaktionen). Der
      // Filter laeuft bewusst auch fuer anonyme Besucher: die Landingpage ist die
      // Startseite der Flotte, ihre GETs sind der verlaesslichste Takt, den dieser
      // Worker ohne Cron-Trigger hat.
      const grenzeAblauf = newsAblaufGrenze();
      const frischeNews = Array.isArray(config.news)
        ? config.news.filter((n) => !newsAbgelaufen(n, grenzeAblauf))
        : null;
      if (frischeNews && frischeNews.length !== config.news.length && ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(newsAbgelaufeneBereinigen(env, authHeader));
      }
      // newsReactions: reine Zähler je Meldung+Emoji. newsReactionNames: dieselbe
      // Aufteilung mit den Anzeigenamen für den Tooltip — beides NUR an Angemeldete,
      // der anonyme Besucher bekommt bei beiden {}. Die eigene Wahl holt sich der
      // Client separat über my-news-reactions. Kostet keinen zusätzlichen Read:
      // reactionsDoc und usersDoc stehen oben schon.
      return json({
        tools: config.tools,
        // ⚠️ Die Linksammlung steht AUSDRUECKLICH hier oben bei tools und NICHT im
        // angemeldet-Zweig wie news/newsReactions: Michel-Entscheidung 2026-08-14,
        // sie ist fuer ALLE Besucher gedacht. Es sind Adressen fremder Webseiten,
        // kein Vereinsinternum -- wer eine interne Adresse hier eintraegt, macht sie
        // damit oeffentlich. Genau das sagt der Hinweis im Admin-Panel. Wer den
        // Kreis je enger zieht, zieht diesen Hinweis mit.
        // Normiert wird auch beim LESEN, nicht nur beim Schreiben: ein von Hand in
        // Nextcloud editierter Eintrag darf keine kaputte Form ausliefern.
        links: linksNormieren(config.links),
        news: (angemeldet && frischeNews) ? frischeNews : null,
        newsReactions: angemeldet ? newsReactionCounts(reactionsDoc) : {},
        newsReactionNames: angemeldet ? newsReactionNames(reactionsDoc, usersDoc) : {},
        bootstrapAvailable: Object.keys(usersDoc.users).length === 0
      }, 200, corsHeaders);
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Ungültiges JSON" }, 400, corsHeaders);
    }

    // Die Aktions-Weiche steckt in einer sofort aufgerufenen Funktion, damit ihre
    // Antwort noch durch die Aktivitaets-Erfassung laufen kann, bevor sie
    // zurueckgeht. Bewusst KEINE ausgelagerte dispatchAction()-Funktion: so bleiben
    // die rund 200 case-Zeilen darunter Byte fuer Byte unveraendert -- ein
    // Verrutschen an dieser Stelle traefe jede einzelne Aktion der ganzen Flotte.
    const antwort = await (async () => {
    switch (body.action) {
      case "bootstrap-admin":
        return handleBootstrapAdmin(body, env, authHeader, corsHeaders);
      // request wird mitgegeben fuer das Fehlversuch-Zaehlwerk (siehe
      // pwBremseOffen/pwBremseFehlschlag) — es braucht die aufrufende IP.
      case "login":
        return handleLogin(request, body, env, authHeader, corsHeaders);
      case "set-password":
        return handleSetPassword(body, env, authHeader, corsHeaders);
      // Spieler-Registrierung: -info/-abschliessen bewusst OHNE Auth (der Spieler
      // hat noch kein Konto), das Registrierungs-Token ist der Ausweis.
      case "km-reg-oeffnen":
        return handleKmRegOeffnen(request, body, env, authHeader, corsHeaders);
      case "km-reg-info":
        return handleKmRegInfo(body, env, authHeader, corsHeaders);
      case "km-reg-abschliessen":
        return handleKmRegAbschliessen(request, body, env, authHeader, corsHeaders);
      // Spieler-Selbstbedienung: schreibt NUR den eigenen Eintrag, deshalb bewusst
      // ohne Bearbeiten-Recht nutzbar (siehe Kommentar bei handleKmSelf).
      case "km-self":
        return handleKmSelf(request, body, env, authHeader, corsHeaders);
      case "me":
        return handleMe(request, body, env, authHeader, corsHeaders);
      case "set-view-as":
        return handleSetViewAs(request, body, env, authHeader, corsHeaders);
      case "create-user":
        return handleCreateUser(request, body, env, authHeader, corsHeaders);
      case "list-users":
        return handleListUsers(request, env, authHeader, corsHeaders);
      case "reset-password":
        return handleResetPassword(request, body, env, authHeader, corsHeaders);
      case "change-password":
        return handleChangePassword(request, body, env, authHeader, corsHeaders);
      case "update-user":
        return handleUpdateUser(request, body, env, authHeader, corsHeaders);
      case "delete-user":
        return handleDeleteUser(request, body, env, authHeader, corsHeaders);
      case "create-group":
        return handleCreateGroup(request, body, env, authHeader, corsHeaders);
      case "rename-group":
        return handleRenameGroup(request, body, env, authHeader, corsHeaders);
      case "list-groups":
        return handleListGroups(request, env, authHeader, corsHeaders);
      case "trainerdaten-list-groups":
        return handleTrainerdatenListGroups(request, env, authHeader, corsHeaders);
      case "check-edit-permission":
        return handleCheckEditPermission(request, body, env, authHeader, corsHeaders);
      case "list-directory":
        return handleListDirectory(request, env, authHeader, corsHeaders);
      case "list-tool-editors":
        return handleListToolEditors(request, body, env, authHeader, corsHeaders);
      case "list-trainer-profiles":
        return handleListTrainerProfiles(request, env, authHeader, corsHeaders);
      case "list-birthdays-today":
        return handleListBirthdaysToday(request, env, authHeader, corsHeaders);
      case "kontakte-liste":
        return handleKontakteListe(request, env, authHeader, corsHeaders);
      case "my-trainerdaten-status":
        return handleMyTrainerdatenStatus(request, env, authHeader, corsHeaders);
      case "raumnutzung-kontakt-lookup":
        return handleRaumnutzungKontaktLookup(request, body, env, authHeader, corsHeaders);
      case "raumnutzung-mail-antrag":
        return handleRaumnutzungMailAntrag(request, body, env, authHeader, corsHeaders);
      case "notify-user":
        return handleNotifyUser(request, body, env, authHeader, corsHeaders, ctx);
      // Push-Nachrichten (seit 2026-08-03). Schmale eigene Aktionen statt Feldern
      // in "me" -- dieselbe Linie wie beim Materialcontainer-Code.
      case "push-status":
        return handlePushStatus(request, env, authHeader, corsHeaders);
      case "push-abo-anlegen":
        return handlePushAboAnlegen(request, body, env, authHeader, corsHeaders);
      case "push-abo-loeschen":
        return handlePushAboLoeschen(request, body, env, authHeader, corsHeaders);
      case "push-anlaesse-setzen":
        return handlePushAnlaesseSetzen(request, body, env, authHeader, corsHeaders);
      case "push-test":
        return handlePushTest(request, env, authHeader, corsHeaders);
      // Von Hand verschickte Mitteilung an alle Geraete (seit 2026-08-06).
      // Admin-only, siehe Kommentar am Handler.
      case "push-rundnachricht":
        return handlePushRundnachricht(request, body, env, authHeader, corsHeaders, ctx);
      case "push-rundnachricht-verlauf":
        return handlePushRundnachrichtVerlauf(request, env, authHeader, corsHeaders);
      case "vereinskalender-termin-push":
        return handleVkTerminPush(request, body, env, authHeader, corsHeaders, ctx);
      case "vorgang-push":
        return handleVorgangPush(request, body, env, authHeader, corsHeaders, ctx);
      case "fotoauftrag-push":
        return handleFotoauftragPush(request, body, env, authHeader, corsHeaders, ctx);
      case "my-trainercheckliste-status":
        return handleMyTrainerchecklisteStatus(request, env, authHeader, corsHeaders);
      case "my-testspielplaner-status":
        return handleMyTestspielplanerStatus(request, env, authHeader, corsHeaders);
      case "update-group-members":
        return handleUpdateGroupMembers(request, body, env, authHeader, corsHeaders);
      case "provision-group":
        return handleProvisionGroup(request, body, env, authHeader, corsHeaders);
      case "delete-group":
        return handleDeleteGroup(request, body, env, authHeader, corsHeaders);
      case "save-visibility":
        return handleSaveVisibility(request, body, env, authHeader, corsHeaders);
      case "save-news":
        return handleSaveNews(request, body, env, authHeader, corsHeaders);
      // Medien-Anhänge der Neuigkeiten (seit 2026-08-03). put ist Admin-only wie
      // save-news, get steht jedem Angemeldeten offen -- prüft aber, dass die Id
      // wirklich an einer Meldung hängt.
      case "news-datei-put":
        return handleNewsDateiPut(request, body, env, authHeader, corsHeaders);
      case "news-datei-get":
        return handleNewsDateiGet(request, body, env, authHeader, corsHeaders);
      // Nutzerfotos (seit 2026-08-04). put/loeschen wirken auf das eigene Konto;
      // ein fremder Nutzername ist nur für Admins erlaubt. get steht jedem
      // Angemeldeten für jedes Konto offen (Michel-Entscheidung, siehe unten).
      case "nutzerfoto-put":
        return handleNutzerfotoPut(request, body, env, authHeader, corsHeaders);
      case "nutzerfoto-get":
        return handleNutzerfotoGet(request, body, env, authHeader, corsHeaders);
      case "nutzerfoto-loeschen":
        return handleNutzerfotoLoeschen(request, body, env, authHeader, corsHeaders);
      case "nutzerfoto-versionen":
        return handleNutzerfotoVersionen(request, body, env, authHeader, corsHeaders);
      case "toggle-news-reaction":
        return handleToggleNewsReaction(request, body, env, authHeader, corsHeaders);
      case "my-news-reactions":
        return handleMyNewsReactions(request, env, authHeader, corsHeaders);
      // Persoenliche Ansicht der Startseite (Kacheln/Liste + eigene Reihenfolge).
      // Beide wirken ausschliesslich auf das eigene Konto.
      case "meine-ansicht":
        return handleMeineAnsicht(request, env, authHeader, corsHeaders);
      case "meine-ansicht-speichern":
        return handleMeineAnsichtSpeichern(request, body, env, authHeader, corsHeaders);
      case "downloads-gesehen":
        return handleDownloadsGesehen(request, env, authHeader, corsHeaders);
      // Unterlagen zum Herunterladen (Block am Dateiende). Abgeholt im Konto-Tab,
      // befuellt aus den Dokumentenvorlagen.
      case "unterlagen-meine":
        return handleUnterlagenMeine(request, env, authHeader, corsHeaders);
      case "unterlagen-datei":
        return handleUnterlagenDatei(request, body, env, authHeader, corsHeaders);
      case "unterlagen-alle":
        return handleUnterlagenAlle(request, env, authHeader, corsHeaders);
      case "unterlage-verteilen":
        return handleUnterlageVerteilen(request, body, env, authHeader, corsHeaders, ctx);
      case "unterlage-entfernen":
        return handleUnterlageEntfernen(request, body, env, authHeader, corsHeaders);
      case "aufgaben-load":
        return handleAufgabenLoad(request, env, authHeader, corsHeaders);
      case "aufgabe-speichern":
        return handleAufgabeSpeichern(request, body, env, authHeader, corsHeaders);
      case "aufgabe-loeschen":
        return handleAufgabeLoeschen(request, body, env, authHeader, corsHeaders);
      case "aufgaben-aufraeumen":
        return handleAufgabenAufraeumen(request, env, authHeader, corsHeaders);
      case "aufgabe-zuweisen":
        return handleAufgabeZuweisen(request, body, env, authHeader, corsHeaders);
      case "aufgabe-zurueckziehen":
        return handleAufgabeZurueckziehen(request, body, env, authHeader, corsHeaders);
      case "zuweisung-entfernen":
        return handleZuweisungEntfernen(request, body, env, authHeader, corsHeaders);
      case "aufgaben-gesehen":
        return handleAufgabenGesehen(request, body, env, authHeader, corsHeaders);
      case "set-aufgaben-gruppen":
        return handleSetAufgabenGruppen(request, body, env, authHeader, corsHeaders);
      case "dokumente-load":
        return handleDokumenteLoad(request, env, authHeader, corsHeaders);
      case "dokument-anlegen":
        return handleDokumentAnlegen(request, body, env, authHeader, corsHeaders, ctx);
      case "dokument-datei-put":
        return handleDokumentDateiPut(request, body, env, authHeader, corsHeaders);
      case "dokument-datei-get":
        return handleDokumentDateiGet(request, body, env, authHeader, corsHeaders);
      case "dokument-unterschreiben":
        return handleDokumentUnterschreiben(request, body, env, authHeader, corsHeaders);
      case "dokument-ablehnen":
        return handleDokumentAblehnen(request, body, env, authHeader, corsHeaders);
      case "dokument-loeschen":
        return handleDokumentLoeschen(request, body, env, authHeader, corsHeaders);
      // Vereinsaufgaben (eigene App, Port 8809) -- bewusst eigene Aktionen statt
      // dav-load/dav-save: die Regeln dieser App (Empfaenger darf nur abhaken,
      // vertrauliche Texte verlassen den Worker nicht, Protokoll ist nicht
      // faelschbar) brauchen einen Server, der die Aenderung selbst ausfuehrt.
      case "vereinsaufgaben-load":
        return handleVaLoad(request, env, authHeader, corsHeaders);
      case "vereinsaufgaben-ressort-speichern":
        return handleVaRessortSpeichern(request, body, env, authHeader, corsHeaders);
      case "vereinsaufgaben-ressort-loeschen":
        return handleVaRessortLoeschen(request, body, env, authHeader, corsHeaders);
      case "vereinsaufgabe-anlegen":
        return handleVaAnlegen(request, body, env, authHeader, corsHeaders, ctx);
      case "vereinsaufgabe-erinnern":
        return handleVaErinnern(request, body, env, authHeader, corsHeaders, ctx);
      case "vereinsaufgabe-aendern":
        return handleVaAendern(request, body, env, authHeader, corsHeaders);
      case "vereinsaufgabe-status":
        return handleVaStatus(request, body, env, authHeader, corsHeaders, ctx);
      case "vereinsaufgabe-zurueckziehen":
        return handleVaZurueckziehen(request, body, env, authHeader, corsHeaders, ctx);
      case "vereinsaufgabe-reaktivieren":
        return handleVaReaktivieren(request, body, env, authHeader, corsHeaders, ctx);
      case "vereinsaufgabe-loeschen":
        return handleVaLoeschen(request, body, env, authHeader, corsHeaders);
      case "vereinsaufgabe-kommentar":
        return handleVaKommentar(request, body, env, authHeader, corsHeaders, ctx);
      case "vereinsaufgabe-datei-put":
        return handleVaDateiPut(request, body, env, authHeader, corsHeaders);
      case "vereinsaufgabe-datei-get":
        return handleVaDateiGet(request, body, env, authHeader, corsHeaders);
      case "vereinsaufgabe-datei-loeschen":
        return handleVaDateiLoeschen(request, body, env, authHeader, corsHeaders);
      case "vereinsaufgaben-uebergabe":
        return handleVaUebergabe(request, body, env, authHeader, corsHeaders);
      // ---- Klubzertifizierung: Tab in derselben App, eigene Datei
      //      (Handler am Dateiende, Katalog liegt im Client) ----
      case "zertifizierung-load":
        return handleZertLoad(request, env, authHeader, corsHeaders);
      case "zertifizierung-status":
        return handleZertStatus(request, body, env, authHeader, corsHeaders);
      case "zertifizierung-notiz":
        return handleZertNotiz(request, body, env, authHeader, corsHeaders);
      case "zertifizierung-aufgabe-anlegen":
        return handleZertAufgabeAnlegen(request, body, env, authHeader, corsHeaders);
      case "zertifizierung-aufgabe-aendern":
        return handleZertAufgabeAendern(request, body, env, authHeader, corsHeaders);
      case "zertifizierung-aufgabe-status":
        return handleZertAufgabeStatus(request, body, env, authHeader, corsHeaders);
      case "zertifizierung-aufgabe-loeschen":
        return handleZertAufgabeLoeschen(request, body, env, authHeader, corsHeaders);
      case "zertifizierung-datei-put":
        return handleZertDateiPut(request, body, env, authHeader, corsHeaders);
      case "zertifizierung-datei-get":
        return handleZertDateiGet(request, body, env, authHeader, corsHeaders);
      case "zertifizierung-datei-loeschen":
        return handleZertDateiLoeschen(request, body, env, authHeader, corsHeaders);
      // ---- Spieltagscrew (Handler am Dateiende) ----
      case "spieltagscrew-load":
        return handleScLoad(request, env, authHeader, corsHeaders);
      case "spieltagscrew-eintragen":
        return handleScEintragen(request, body, env, authHeader, corsHeaders, ctx);
      case "spieltagscrew-austragen":
        return handleScAustragen(request, body, env, authHeader, corsHeaders, ctx);
      case "spieltagscrew-spieltag-speichern":
        return handleScSpieltagSpeichern(request, body, env, authHeader, corsHeaders);
      case "spieltagscrew-spieltag-loeschen":
        return handleScSpieltagLoeschen(request, body, env, authHeader, corsHeaders);
      case "spieltagscrew-katalog-speichern":
        return handleScKatalogSpeichern(request, body, env, authHeader, corsHeaders);
      case "spieltagscrew-einstellungen-speichern":
        return handleScEinstellungenSpeichern(request, body, env, authHeader, corsHeaders);
      case "spieltagscrew-erinnern":
        return handleScErinnern(request, body, env, authHeader, corsHeaders, ctx);
      // Nachlese zum naechtlichen Busplan-Lauf. ⚠️ NUR LESEN -- es gibt bewusst
      // keine Aktion, die den Lauf von Hand ausloest: jede Fahrt kostet eine
      // Mail, und ein zweiter Ausloeser koennte den Merker umgehen.
      case "busplan-erinnerungen":
        return handleBusplanErinnerungen(request, env, authHeader, corsHeaders);
      case "get-materialcontainer-code":
        return handleGetMaterialcontainerCode(request, env, authHeader, corsHeaders);
      case "set-materialcontainer-code":
        return handleSetMaterialcontainerCode(request, body, env, authHeader, corsHeaders);
      case "save-links":
        return handleSaveLinks(request, body, env, authHeader, corsHeaders);
      case "submit-feedback":
        return handleSubmitFeedback(request, body, env, authHeader, corsHeaders);
      case "list-feedback":
        return handleListFeedback(request, env, authHeader, corsHeaders);
      case "save-feedback":
        return handleSaveFeedback(request, body, env, authHeader, corsHeaders);
      case "feedback-antwort":
        return handleFeedbackAntwort(request, body, env, authHeader, corsHeaders, ctx);
      case "meine-feedbacks":
        return handleMeineFeedbacks(request, env, authHeader, corsHeaders);
      case "ideen-load":
        return handleIdeenLoad(request, env, authHeader, corsHeaders);
      case "idee-speichern":
        return handleIdeeSpeichern(request, body, env, authHeader, corsHeaders);
      case "idee-loeschen":
        return handleIdeeLoeschen(request, body, env, authHeader, corsHeaders);
      case "idee-daumen":
        return handleIdeeDaumen(request, body, env, authHeader, corsHeaders);
      case "idee-verwalten":
        return handleIdeeVerwalten(request, body, env, authHeader, corsHeaders);
      case "get-admin-stats":
        return handleGetAdminStats(request, env, authHeader, corsHeaders);
      case "personalakte-overview":
        return handlePersonalakteOverview(request, env, authHeader, corsHeaders);
      case "archive-trainer":
        return handleArchiveTrainer(request, body, env, authHeader, corsHeaders);
      case "reactivate-trainer":
        return handleReactivateTrainer(request, body, env, authHeader, corsHeaders);
      // request fuer das Fehlversuch-Zaehlwerk, wie bei "login". ⚠️ Der
      // Beleg-Upload-Worker ruft diese Aktion per Service Binding auf und hat
      // keine Client-IP -- dort greift die Bremse bewusst nicht.
      case "verify-action-password":
        return handleVerifyActionPassword(request, body, env, corsHeaders);
      case "beleg-eingang-notify":
        return handleBelegEingangNotify(body, env, corsHeaders);
      case "dav-load":
        return handleDavLoad(request, body, env, authHeader, corsHeaders);
      case "dav-save":
        return handleDavSave(request, body, env, authHeader, corsHeaders);
      case "vereinskalender-vote":
        return handleVereinskalenderVote(request, body, env, authHeader, corsHeaders);
      // Abo-Link fuer den eigenen Kalender (seit 2026-08-06). Der Feed selbst
      // laeuft nicht hier durch, sondern ueber den GET-Pfad /kalender/<token>.ics.
      case "vereinskalender-abo-status":
        return handleVkAboStatus(request, env, authHeader, corsHeaders);
      case "vereinskalender-abo-anlegen":
        return handleVkAboAnlegen(request, body, env, authHeader, corsHeaders);
      case "vereinskalender-abo-loeschen":
        return handleVkAboLoeschen(request, env, authHeader, corsHeaders);
      // Schulsport-Planer (seit 2026-08-05). schulsport-meldung ist die schmale
      // Aktion, ueber die Uebungsleiter OHNE Bearbeiten-Recht ihre eigenen
      // Termine zurueckmelden -- gleiche Bauform wie vereinskalender-vote.
      case "schulsport-personen":
        return handleSchulsportPersonen(request, body, env, authHeader, corsHeaders);
      case "schulsport-meldung":
        return handleSchulsportMeldung(request, body, env, authHeader, corsHeaders);
      case "schulsport-nachweis-erstellen":
        return handleSchulsportNachweisErstellen(request, body, env, authHeader, corsHeaders);
      case "schulsport-nachweis-senden":
        return handleSchulsportNachweisSenden(request, body, env, authHeader, corsHeaders);
      case "schulsport-nachweis-status":
        return handleSchulsportNachweisStatus(request, body, env, authHeader, corsHeaders);
      case "schulsport-archiv-load":
        return handleSchulsportArchivLoad(request, body, env, authHeader, corsHeaders);
      case "schulsport-schuljahr-archivieren":
        return handleSchulsportSchuljahrArchivieren(request, body, env, authHeader, corsHeaders);
      case "schulsport-erinnerung-push":
        return handleSchulsportErinnerungPush(request, body, env, authHeader, corsHeaders, ctx);
      case "fotoauftrag-ordner-anlegen":
        return handleFotoauftragOrdnerAnlegen(request, body, env, authHeader, corsHeaders);
      case "fotoauftrag-spielbericht-hochladen":
        return handleFotoauftragSpielberichtHochladen(request, body, env, authHeader, corsHeaders);
      case "fotoauftrag-loeschen":
        return handleFotoauftragLoeschen(request, body, env, authHeader, corsHeaders);
      case "dav-file-put":
        return handleDavFilePut(request, body, env, authHeader, corsHeaders);
      case "dav-file-get":
        return handleDavFileGet(request, body, env, authHeader, corsHeaders);
      case "dav-file-delete":
        return handleDavFileDelete(request, body, env, authHeader, corsHeaders);
      case "dav-restricted-put":
        return handleDavRestrictedPut(request, body, env, authHeader, corsHeaders);
      case "dav-restricted-get":
        return handleDavRestrictedGet(request, body, env, authHeader, corsHeaders);
      case "dav-restricted-delete":
        return handleDavRestrictedDelete(request, body, env, authHeader, corsHeaders);
      case "fahrtenbuch-extern-submit":
        return handleFahrtenbuchExternSubmit(body, env, authHeader, corsHeaders, ctx);
      case "fahrtenbuch-extern-file-put":
        return handleFahrtenbuchExternFilePut(body, env, authHeader, corsHeaders);
      case "fahrtenbuch-extern-fuehrerschein-put":
        return handleFahrtenbuchExternFuehrerscheinPut(body, env, authHeader, corsHeaders);
      // Kleiderbörse: der komplette Eltern-Weg laeuft OHNE Login -- Eltern haben
      // kein Vereinskonto. Ausweis ist der geheime Schluessel aus meta.externToken
      // (kbo-extern-*) bzw. der angebotseigene wegToken (kbo-extern-weg*). Jeder
      // Handler prueft ihn selbst und ist damit fuer sich vollstaendig
      // authentifiziert; zusaetzlich bremst ein Zaehlwerk je IP.
      case "kbo-extern-start":
        return handleKboExternStart(request, body, env, authHeader, corsHeaders);
      case "kbo-extern-foto-put":
        return handleKboExternFotoPut(request, body, env, authHeader, corsHeaders);
      case "kbo-extern-foto-get":
        return handleKboExternFotoGet(request, body, env, authHeader, corsHeaders);
      case "kbo-extern-anbieten":
        return handleKboExternAnbieten(request, body, env, authHeader, corsHeaders);
      case "kbo-extern-anfragen":
        return handleKboExternAnfragen(request, body, env, authHeader, corsHeaders);
      case "kbo-extern-weg-info":
        return handleKboExternWegInfo(request, body, env, authHeader, corsHeaders);
      case "kbo-extern-weg":
        return handleKboExternWeg(request, body, env, authHeader, corsHeaders);
      // Vereinsverwaltung: Nachweise zur Nachwuchs-Anmeldung (Geburtsurkunde,
      // Spielerpass, Abmeldung). Das PUT laeuft OHNE Login -- Eltern haben kein
      // Vereinskonto. ⚠️ Anders als bei fahrtenbuch-extern-* gibt es hier auch
      // KEINEN Zugriffscode und keinen Token; die Schranken sind ein Zaehlwerk
      // je IP und der aus den ersten Bytes bestimmte Dateityp (siehe den Block
      // bei VV_NACHWEIS_IP_ZAEHLER). request wird dafuer mitgegeben.
      // Die drei lesenden/loeschenden Wege verlangen eine Sitzung.
      case "vv-nachweis-put":
        return handleVvNachweisPut(request, body, env, authHeader, corsHeaders);
      case "vv-nachweis-liste":
        return handleVvNachweisListe(request, body, env, authHeader, corsHeaders);
      case "vv-nachweis-get":
        return handleVvNachweisGet(request, body, env, authHeader, corsHeaders);
      case "vv-nachweis-loeschen":
        return handleVvNachweisLoeschen(request, body, env, authHeader, corsHeaders);
      // Das fertige Verbandsformular. IMMER angemeldet -- es entsteht in
      // der Verwaltung, nicht am Familien-Formular.
      case "vv-antrag-pdf-put":
        return handleVvAntragPdfPut(request, body, env, authHeader, corsHeaders);
      case "vv-antrag-pdf-get":
        return handleVvAntragPdfGet(request, body, env, authHeader, corsHeaders);
      case "vv-antrag-pdf-status":
        return handleVvAntragPdfStatus(request, body, env, authHeader, corsHeaders);
      case "fahrtenbuch-belege-list":
        return handleFahrtenbuchBelegeList(request, body, env, authHeader, corsHeaders);
      case "fahrtenbuch-beleg-file-get":
        return handleFahrtenbuchBelegFileGet(request, body, env, authHeader, corsHeaders);
      // Schulsport: Bestaetigung eines Durchfuehrungsnachweises durch die Schule,
      // OHNE Login (Freigabelink). Beide Aktionen rufen getVerifiedSession
      // bewusst NICHT auf -- der Ausweis ist der lange Zufallstoken IM
      // Nachweis-Vorgang, gleiche Bauform wie die fahrtenbuch-extern-*-Aktionen
      // darueber. Sie antworten deshalb nie 401, sondern 400 (Token-Form),
      // 404 (unbekannt), 410 (abgelaufen/widerrufen) oder 429 (Zaehlwerk) --
      // daran erkennt man in der Live-Probe, dass sie wirklich vor jeder
      // Sitzungspruefung liegen. request wird mitgegeben, weil die Handler die
      // aufrufende IP fuer die Missbrauchsbremse brauchen.
      case "schulsport-freigabe-lesen":
        return handleSchulsportFreigabeLesen(request, body, env, authHeader, corsHeaders);
      case "schulsport-freigabe-senden":
        return handleSchulsportFreigabeSenden(request, body, env, authHeader, corsHeaders);
      // Ablaufplan: einen einzelnen Ablauf OHNE Login lesen (plan.html), damit
      // Eltern und Spieler die Zeiten sehen, ohne ein Vereinskonto zu haben.
      // Gleiche Bauform wie die beiden Aktionen darueber -- getVerifiedSession
      // wird bewusst NICHT aufgerufen, der Ausweis ist der Token IM Ablauf.
      // Antwortet deshalb nie 401, sondern 400 (Token-Form), 404 (unbekannt),
      // 410 (zurueckgezogen) oder 429 (Zaehlwerk); daran erkennt man in der
      // Live-Probe, dass sie wirklich VOR jeder Sitzungspruefung liegt.
      // ⚠️ NUR LESEN. Es gibt bewusst keine schreibende Gegenstueck-Aktion.
      case "ablaufplan-oeffentlich":
        return handleAblaufplanOeffentlich(request, body, env, authHeader, corsHeaders);
      // Kleiderbestellung: Spieler ohne Vereinskonto bestellen ueber einen Link
      // mit Zufallstoken. Gleiche Bauform wie die beiden Aktionen darueber --
      // getVerifiedSession wird bewusst NICHT aufgerufen, der Ausweis ist der
      // Token IN der Bestellaktion. Sie antworten deshalb nie 401, sondern 400
      // (Form), 403 (falsches Passwort), 404 (unbekannt), 409 (geschlossen),
      // 410 (widerrufen) oder 429 (Zaehlwerk); daran erkennt man in der
      // Live-Probe, dass sie wirklich vor jeder Sitzungspruefung liegen.
      case "kb-extern-start":
        return handleKbExternStart(request, body, env, authHeader, corsHeaders);
      case "kb-extern-anmelden":
        return handleKbExternAnmelden(request, body, env, authHeader, corsHeaders);
      case "kb-extern-speichern":
        return handleKbExternSpeichern(request, body, env, authHeader, corsHeaders);
      case "livekit-token":
        return handleLivekitToken(request, body, env, authHeader, corsHeaders);
      case "livekit-kick":
        return handleLivekitKick(request, body, env, authHeader, corsHeaders);
      case "livekit-mute":
        return handleLivekitMute(request, body, env, authHeader, corsHeaders);
      // Aktivitaetspunkte (seit 2026-08-04). Alle drei wirken nur auf das eigene
      // Konto; die Auswertung ueber fremde Konten ist admin-only.
      case "meine-punkte":
        return handleMeinePunkte(request, body, env, authHeader, corsHeaders);
      case "punkte-opt-out":
        return handlePunkteOptOut(request, body, env, authHeader, corsHeaders);
      case "aktivitaet-auswertung":
        return handleAktivitaetAuswertung(request, body, env, authHeader, corsHeaders);
      // Mannschaften (seit 2026-08-12). Lesen darf jeder Angemeldete -- es ist
      // die Liste der Vereinsmannschaften, keine Personendatei. Pflegen darf
      // nur ein globaler Admin: eine zentrale Liste, die jeder aendern kann,
      // waere in kurzer Zeit wieder das Chaos, gegen das sie gebaut ist.
      case "mannschaften-load":
        return handleMannschaftenLoad(request, body, env, authHeader, corsHeaders);
      case "mannschaften-speichern":
        return handleMannschaftenSpeichern(request, body, env, authHeader, corsHeaders);
      case "mannschaften-saison":
        return handleMannschaftenSaison(request, body, env, authHeader, corsHeaders);
      case "mannschaften-vorschlag":
        return handleMannschaftenVorschlag(request, env, authHeader, corsHeaders);
      // Der einmalige Umschreib-Lauf ueber die Datendateien der Flotte. Drei
      // Modi: vorschau (schreibt nichts), schreiben (sichert vorher), zurueck
      // (spielt die Sicherung wieder ein).
      case "mannschaften-umschreiben":
        return handleMannschaftenUmschreiben(request, body, env, authHeader, corsHeaders);
      default:
        return json({ error: "Unbekannte Aktion" }, 400, corsHeaders);
    }
    })();

    // Punkte NACH der Antwort mitschreiben (Block "Aktivitaetspunkte" am Dateiende):
    // der Nutzer wartet dadurch keine Millisekunde laenger, und ein Fehler beim
    // Zaehlen kann seine eigentliche Handlung nicht mehr kippen.
    ctx.waitUntil(aktivitaetErfassen(request, body, env, authHeader, antwort));
    return antwort;

    } catch (e) {
      if (e instanceof NextcloudError) {
        return json({ error: e.message }, 502, corsHeaders);
      }
      return json({ error: "Interner Fehler: " + e.message }, 500, corsHeaders);
    }
  }
};

// ---------- Aktionen: Auth ----------

async function handleBootstrapAdmin(body, env, authHeader, corsHeaders) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  // "__proto__" besteht den Regex-Test, würde als Objekt-Key aber das Prototyp-
  // Objekt statt eines eigenen Eintrags setzen — explizit ablehnen.
  if (!USERNAME_RE.test(username) || username === "__proto__") return json({ error: "Ungültiger Nutzername (3-32 Zeichen, a-z 0-9 . _ -)" }, 400, corsHeaders);
  const pwError = validatePasswordStrength(password);
  if (pwError) return json({ error: pwError }, 400, corsHeaders);

  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  if (Object.keys(usersDoc.users).length > 0) {
    return json({ error: "Bootstrap bereits abgeschlossen" }, 403, corsHeaders);
  }

  const { hash, salt, iterations } = await hashNewPassword(password);
  const now = new Date().toISOString();
  usersDoc.users[username] = {
    username, passwordHash: hash, salt, iterations,
    isAdmin: true, mustSetPassword: false,
    createdAt: now, passwordSetAt: now
  };

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  const token = await signToken(makeSessionPayload(username, true), env.SESSION_SECRET);
  return json({ token, username, isAdmin: true, groupIds: [], realIsAdmin: true, viewAsGroupId: null }, 200, corsHeaders);
}

async function handleLogin(request, body, env, authHeader, corsHeaders) {
  const password = String(body.password || "");
  // ⚠️ Zaehlwerk VOR dem Lesen von nutzer.json: sonst kostet jeder Rateversuch
  // einen Nextcloud-Read, und resolveLoginUser liest bei einer E-Mail-Eingabe
  // zusaetzlich die Trainerdaten. Gezaehlt wird nur unten, beim Fehlschlag.
  if (!pwBremseOffen(LOGIN_FEHL_ZAEHLER, LOGIN_FEHL_MAX_PRO_STUNDE, request)) {
    return json({ error: "Zu viele Fehlversuche. Bitte spaeter erneut versuchen." }, 429, corsHeaders);
  }
  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  // Nutzername, jede übliche Schreibvariante davon ODER die E-Mail-Adresse --
  // siehe resolveLoginUser. Der Token wird unverändert auf user.username
  // ausgestellt, die Eingabe ist nur der Suchschlüssel.
  const user = await resolveLoginUser(body.username, usersDoc, authHeader);

  if (!user) return json({ error: "Ungültige Anmeldedaten" }, 401, corsHeaders);
  // Archivierte Konten (Personalakte) werden VOR der Passwortprüfung abgefangen:
  // der zweistufige Login-Flow ruft login(username, "") zuerst mit leerem
  // Passwort auf, um zu entscheiden, welcher Screen als nächstes kommt — läge
  // dieser Check dahinter, würde dieser erste Aufruf in den generischen
  // 401-Zweig fallen und faelschlich das Passwort-Feld zeigen statt sofort
  // "archiviert" zu melden.
  if (user.archiviert) {
    return json({ error: "Dieses Konto wurde archiviert.", archived: true }, 403, corsHeaders);
  }
  if (user.mustSetPassword || !user.passwordHash) {
    // `username` additiv seit 2026-08-03: wer sich mit seiner E-Mail anmeldet, soll
    // im "Konto einrichten"-Panel den echten Nutzernamen sehen -- der Satz dort nennt
    // ihn als künftigen Anmeldeweg. Kein neues Wissen für den Anfragenden: dieses
    // Konto ist über den bewusst ungeschützten set-password-Weg ohnehin erreichbar.
    return json({ needsPasswordSetup: true, username: user.username }, 200, corsHeaders);
  }

  const ok = await verifyPassword(password, user.salt, user.iterations, user.passwordHash);
  if (!ok) {
    // Bremse gegen Durchprobieren (wie bei verify-action-password). Trifft im
    // zweistufigen Login-Flow auch den Nutzername-Schritt (login mit leerem
    // Passwort bei bestehendem Konto) — 0,8s einmal pro Anmeldung ist bewusst
    // in Kauf genommen.
    //
    // ⚠️ Das Zaehlwerk zaehlt diesen Schritt bewusst NICHT mit: er gehoert zum
    // normalen Ablauf jeder einzelnen Anmeldung, und ein leeres Passwort bringt
    // einen Ratenden ohnehin nie durch. Wuerde er mitzaehlen, waere ein
    // Vereinsheim-WLAN nach dreissig regulaeren Anmeldungen gesperrt.
    if (password !== "") pwBremseFehlschlag(LOGIN_FEHL_ZAEHLER, request);
    await new Promise((resolve) => setTimeout(resolve, 800));
    return json({ error: "Ungültige Anmeldedaten" }, 401, corsHeaders);
  }

  // ⚠️ VOR dem Ueberschreiben lesen: nur hier ist noch bekannt, wann die vorige
  // Anmeldung war -- und daran haengt der Rueckkehr-Bonus.
  const vorigeAnmeldung = user.lastLoginAt;

  // Für die "Zuletzt angemeldet"-Liste im Admin-Dashboard, best-effort — ein
  // Speicherfehler hier darf den eigentlichen Login nicht verhindern.
  user.lastLoginAt = new Date().toISOString();
  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) { /* siehe Kommentar oben */ }

  const token = await signToken(makeSessionPayload(user.username, !!user.isAdmin), env.SESSION_SECRET);
  const identity = deriveIdentity(user, usersDoc);
  const antwort = json({ token, username: user.username, ...identity }, 200, corsHeaders);

  // Rueckkehr-Bonus (Regelversion 3): die vorige Sitzung war wirklich abgelaufen.
  // ⚠️ Erstanmeldungen zaehlen nicht -- ohne vorherigen Login gibt es nichts,
  // wovon man zurueckkehren koennte. Und der zweistufige Login-Flow ruft diesen
  // Handler zwar zweimal auf, kommt aber nur beim zweiten Mal (mit richtigem
  // Passwort) ueberhaupt bis hierher.
  if (vorigeAnmeldung) {
    const abstand = Date.now() - Date.parse(vorigeAnmeldung);
    if (Number.isFinite(abstand) && abstand > SESSION_TTL_SECONDS * 1000) {
      antwort.punkteBonus = { art: "rueckkehr", username: user.username };
    }
  }
  return antwort;
}

async function handleSetPassword(body, env, authHeader, corsHeaders) {
  const password = String(body.password || "");
  const pwError = validatePasswordStrength(password);
  if (pwError) return json({ error: pwError }, 400, corsHeaders);

  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  // Dieselbe Auflösung wie in handleLogin -- der Erstlogin-Flow reicht die Eingabe
  // aus Schritt 1 durch, und das kann eine E-Mail-Adresse sein.
  const user = await resolveLoginUser(body.username, usersDoc, authHeader);
  if (!user) return json({ error: "Unbekannter Nutzer" }, 404, corsHeaders);
  // Archivierte Konten wie in handleLogin abfangen. Diese Aktion ist bewusst OHNE
  // Login nutzbar (Erstvergabe des eigenen Passworts) und nur durch
  // mustSetPassword geschuetzt -- ein Konto, das archiviert wurde, BEVOR sich die
  // Person je angemeldet hat, behaelt mustSetPassword:true (archive-trainer fasst
  // das Feld nicht an). Ohne diesen Check koennte ein Fremder ihm bei erratenem
  // Nutzernamen ein Passwort setzen: der Login bliebe zwar gesperrt, aber nach
  // einer spaeteren reactivate-trainer waere das Konto mit FREMDEM Passwort
  // aktiv und die eigentliche Person zugleich ausgesperrt (mustSetPassword ist
  // dann false, der "Konto einrichten"-Weg also verbraucht).
  if (user.archiviert) {
    return json({ error: "Dieses Konto wurde archiviert.", archived: true }, 403, corsHeaders);
  }
  if (!user.mustSetPassword) return json({ error: "Passwort wurde bereits gesetzt" }, 409, corsHeaders);

  const { hash, salt, iterations } = await hashNewPassword(password);
  user.passwordHash = hash;
  user.salt = salt;
  user.iterations = iterations;
  user.mustSetPassword = false;
  user.passwordSetAt = new Date().toISOString();
  user.lastLoginAt = user.passwordSetAt;

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  const token = await signToken(makeSessionPayload(user.username, !!user.isAdmin), env.SESSION_SECRET);
  const identity = deriveIdentity(user, usersDoc);
  return json({ token, username: user.username, ...identity }, 200, corsHeaders);
}

// Eigenes Passwort aendern. Dritter Passwort-Weg neben set-password (Erstvergabe,
// bewusst ohne Login) und reset-password (Admin, ohne Kenntnis des alten) -- dieser
// hier braucht Token UND das bisherige Passwort.
//
// Der zu aendernde Nutzer kommt IMMER aus dem Token, nie aus dem Body: sonst koennte
// jeder Eingeloggte mit einem fremden Nutzernamen im Body ein anderes Konto
// uebernehmen.
//
// Nebenwirkung, die der Client kennen muss: das neue passwordSetAt entwertet in
// getVerifiedSession jedes Token mit aelterem iat -- also alle Sessions auf allen
// Geraeten, auch die gerade benutzte. Deshalb wird hier ein frisches Token
// ausgestellt (nach dem Schreiben, damit sein iat nicht vor passwordSetAt liegt).
async function handleChangePassword(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const oldPassword = String((body && body.oldPassword) || "");
  const newPassword = String((body && body.newPassword) || "");

  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, session.username);
  if (!user) return json({ error: "Unbekannter Nutzer" }, 404, corsHeaders);

  // Altes Passwort VOR jeder Pruefung des neuen: wer nur das Token hat (fremdes
  // Geraet, geklauter localStorage), soll gar kein Feedback bekommen -- und die
  // Bremse gegen Durchprobieren greift so immer.
  const ok = await verifyPassword(oldPassword, user.salt, user.iterations, user.passwordHash);
  if (!ok) {
    await new Promise((resolve) => setTimeout(resolve, 800)); // Bremse wie in handleLogin
    return json({ error: "Das bisherige Passwort stimmt nicht." }, 403, corsHeaders);
  }

  const pwError = validatePasswordStrength(newPassword);
  if (pwError) return json({ error: pwError }, 400, corsHeaders);
  if (oldPassword === newPassword) {
    return json({ error: "Das neue Passwort muss sich vom bisherigen unterscheiden." }, 400, corsHeaders);
  }

  const { hash, salt, iterations } = await hashNewPassword(newPassword);
  const jetztIso = new Date().toISOString();
  user.passwordHash = hash;
  user.salt = salt;
  user.iterations = iterations;
  user.passwordSetAt = jetztIso;

  // Bonus fuer den regelmaessigen Wechsel (Regelversion 3), hoechstens einmal je
  // PUNKTE_PW_BONUS_TAGE. ⚠️ Ohne diese Sperre waere fuenfmal hintereinander
  // wechseln die billigste Punktequelle des ganzen Systems. Der Zeitstempel steht
  // bewusst in nutzer.json und nicht in den Aktivitaetsdaten: er muss den
  // Widerspruch (punkteOptOut loescht den Aktivitaetsordner) und die Verdichtung
  // nach 13 Monaten ueberleben, sonst waere die Sperre danach aufgehoben.
  const letzterBonus = Date.parse(user.punkteBonusPwAt || "");
  const bonusFaellig = !Number.isFinite(letzterBonus)
    || (Date.now() - letzterBonus) >= PUNKTE_PW_BONUS_TAGE * 86400000;
  if (bonusFaellig) user.punkteBonusPwAt = jetztIso;

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  const token = await signToken(makeSessionPayload(user.username, !!user.isAdmin), env.SESSION_SECRET);
  const identity = deriveIdentity(user, usersDoc);
  const antwort = json({ token, username: user.username, ...identity }, 200, corsHeaders);
  if (bonusFaellig) antwort.punkteBonus = { art: "passwortwechsel", username: user.username };
  return antwort;
}

async function handleMe(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const app = (body && body.app) ? String(body.app) : null;
  return json(await buildMeResult(session, env, authHeader, app), 200, corsHeaders);
}

// Baut die Antwort der Aktion "me". Ausgelagert, weil handleDavLoad dieselben
// Angaben mitliefert: dort sind nutzer.json (steckt als usersDoc schon in der
// Session) und sichtbarkeit.json für die Rechteprüfung ohnehin gelesen, die
// Felder kosten also KEINEN zusätzlichen Nextcloud-Read -- der Client spart
// dafür einen kompletten HTTP-Roundtrip beim Öffnen der App.
// app (optional): nur damit ist canEdit im Ergebnis; ohne App-Bezug gibt es
// kein Bearbeiten-Recht zu beantworten.
async function buildMeResult(session, env, authHeader, app, cfgPrefetch) {
  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, session.username);
  const result = {
    username: session.username,
    isAdmin: !!session.isAdmin,
    groupIds: session.groupIds,
    realIsAdmin: !!session.realIsAdmin,
    viewAsGroupId: session.viewAsGroupId || null,
    vorname: (user && user.vorname) || null,
    nachname: (user && user.nachname) || null,
    lizenz: (user && user.lizenz) || "",
    mannschaften: (user && Array.isArray(user.mannschaften)) ? user.mannschaften : [],
    // Namen der EIGENEN Gruppen. Der Client hat in groupIds nur IDs und list-groups
    // ist admin-only -- deshalb konnte die Karte "Mein Konto" die Gruppen-Zeile
    // bisher ausschliesslich Admins zeigen. Bewusst hier aufgeloest statt der Client
    // per list-directory: das liefert die komplette Namensliste des Vereins und ist
    // fuer Spielerkonten per 403 gesperrt. Hier erfaehrt jeder nur seine eigenen
    // Gruppen -- nichts ueber fremde Konten oder die Gruppenstruktur des Vereins.
    // Folgt session.groupIds und damit auch einer aktiven Admin-Testansicht.
    groupNames: (session.groupIds || [])
      .map((id) => (getOwn(usersDoc.groups || {}, id) || {}).name)
      .filter(Boolean),
    // Fuer "Passwort zuletzt geaendert am". Fehlt bei Konten, die seit Einfuehrung
    // des Feldes kein Passwort gesetzt haben -- der Client laesst die Zeile dann weg.
    passwordSetAt: (user && user.passwordSetAt) || null,
    // Zeitstempel des eigenen Nutzerfotos (seit 2026-08-04), null = keins hinterlegt.
    // Additiv und kostenlos: nutzer.json steckt ohnehin in der Session. Der Wert ist
    // zugleich der Cache-Schluessel -- ein neues Bild aendert ihn, und der Client
    // laedt genau dann neu, statt eine alte Objekt-URL weiterzureichen.
    fotoVersion: (user && user.fotoVersion) || null,
    // Braucht diese Person einen Trainervertrag? Der Client kann das NICHT selbst
    // ableiten: er sieht in groupIds nur IDs, nicht den Gruppennamen "Trainer", und
    // list-groups ist Admin-only. Trainerdaten blendet daran Bankverbindung/
    // Nebentätigkeit/Unterschrift/Dokumente aus (Geschäftsführung o.ä. hinterlegt dort
    // nur Kontaktdaten). Ein bool über die EIGENE Person -- keine fremden Daten.
    vertragspflichtig: isVertragspflichtig(usersDoc, session.username),
    // Eigene Konto-Art. Additiv; der Client blendet daran Dinge aus, die für
    // Spielerkonten nicht gelten (z.B. den Materialcontainer-Code im Header).
    // Kommt aus dem echten Datensatz, folgt also NICHT einer Admin-Testansicht.
    art: session.art
  };
  if (app) {
    // Beide Stufen aus DERSELBEN Config-Promise beantworten -- ohne den lokalen
    // Prefetch würde jeder Resolver bei fehlendem cfgPrefetch einzeln lesen.
    const cfg = cfgPrefetch || prefetchJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
    result.canEdit = await resolveEditPermission(app, session, env, authHeader, cfg);
    // Administrieren (dritte Stufe, additiv): App-interne Admin-Funktionen --
    // Apps, die das Feld nicht kennen, ignorieren es einfach.
    result.canAdmin = await resolveAdminPermission(app, session, env, authHeader, cfg);
  }
  return result;
}

// Admin-Testansicht umschalten/zurücksetzen — siehe API-Dokumentation oben.
// Gate bewusst auf session.realIsAdmin (NICHT session.isAdmin), sonst kann
// sich ein Admin waehrend einer aktiven Testansicht nicht mehr zurueckschalten.
async function handleSetViewAs(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.realIsAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, session.username);
  const groupId = (body && body.groupId) ? String(body.groupId) : null;
  if (groupId && !getOwn(usersDoc.groups || {}, groupId)) {
    return json({ error: "Unbekannte Gruppe" }, 400, corsHeaders);
  }

  if (groupId) user.viewAsGroupId = groupId;
  else delete user.viewAsGroupId;

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  const identity = deriveIdentity(user, usersDoc);
  return json({ ok: true, ...identity }, 200, corsHeaders);
}

// ---------- Aktionen: Nutzerverwaltung ----------

async function handleCreateUser(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const vorname = String(body.vorname || "").trim();
  const nachname = String(body.nachname || "").trim();
  if (!vorname || !nachname) return json({ error: "Vorname und Nachname erforderlich" }, 400, corsHeaders);

  const usersDoc = session.usersDoc;
  if (!usersDoc.groups) usersDoc.groups = {};

  // Namenskollision gegen den GESAMTEN Bestand prüfen, nicht nur gegen die
  // eigene Art -- Spieler und Personal teilen sich einen Namensraum (Login).
  const username = generateUsername(vorname, nachname, new Set(Object.keys(usersDoc.users)));
  const art = normalizeArt(body.art);
  usersDoc.users[username] = {
    username, vorname, nachname, passwordHash: null, salt: null, iterations: null,
    art,
    // Ein Spieler ist nie Admin -- ein durchgereichtes isAdmin:true würde die
    // Art-Trennung sofort aushebeln (Admin umgeht jeden Sichtbarkeits-Check).
    isAdmin: art === USER_ART_SPIELER ? false : !!body.isAdmin,
    mustSetPassword: true,
    lizenz: normalizeLizenz(body.lizenz), mannschaften: normalizeMannschaften(body.mannschaften),
    vertragBenoetigt: !!body.vertragBenoetigt,
    createdAt: new Date().toISOString(), passwordSetAt: null
  };

  addUserToGroups(usersDoc, username, body.groupIds);

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  // Auto-Provisioning: je nach Gruppen des Nutzers Einträge in den passenden Tools
  // anlegen (best effort — der Nutzer ist bereits angelegt, ein Fehler hier darf die
  // Antwort nicht kippen).
  let provisioned = {};
  try {
    const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
    const apps = provisionAppsForGroups(config, getUserGroupIds(usersDoc, username))
      .filter((app) => provisionErlaubtFuerArt(app, art));
    if (apps.length) provisioned = await provisionUsers([usersDoc.users[username]], apps, env, authHeader);
  } catch (_) { /* Provisioning ist best effort */ }

  return json({ username, vorname, nachname, art, mustSetPassword: true, provisioned }, 201, corsHeaders);
}

async function handleListUsers(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const usersDoc = session.usersDoc;
  const users = Object.values(usersDoc.users).map((u) => ({
    username: u.username,
    vorname: u.vorname || null,
    nachname: u.nachname || null,
    displayName: (u.vorname && u.nachname) ? `${u.vorname} ${u.nachname}` : u.username,
    art: userArt(u),
    isAdmin: !!u.isAdmin,
    mustSetPassword: !!u.mustSetPassword,
    createdAt: u.createdAt,
    groupIds: getUserGroupIds(usersDoc, u.username),
    lizenz: u.lizenz || "",
    mannschaften: Array.isArray(u.mannschaften) ? u.mannschaften : [],
    vertragBenoetigt: !!u.vertragBenoetigt,
    // Nur der Zeitstempel, nicht das Bild (seit 2026-08-04): daran erkennt das
    // Nutzer-Panel, ob "Foto entfernen" ueberhaupt etwas zu tun haette. Die Bilder
    // selbst laedt es nicht -- 540 Abrufe fuer eine Verwaltungsliste.
    fotoVersion: u.fotoVersion || null
  }));
  // Additiv seit 2026-08-12: sagt dem Nutzer-Panel, ob das Mannschaftsfeld noch
  // von Hand zu pflegen ist oder aus der Mannschaftsliste berechnet wird. Ein
  // Feld, das man tippen kann und das nichts bewirkt, ist schlimmer als ein
  // gesperrtes mit Erklaerung. Kostet EINEN zusaetzlichen Read, und zwar nur
  // hier -- die Nutzerliste holt ohnehin schon die ganze nutzer.json.
  let mannschaftenAbgleichAktiv = false;
  try {
    mannschaftenAbgleichAktiv = await mannschaftenAbgleichLaeuft(authHeader);
  } catch (_) {
    // Anders als in handleUpdateUser hier bewusst still: das ist eine reine
    // Anzeige-Auskunft, und die Nutzerverwaltung darf an einem Wackler beim
    // Lesen einer Nebendatei nicht scheitern. Die echte Schranke sitzt im
    // Schreibweg, nicht hier.
  }
  return json({ users, mannschaftenAbgleichAktiv }, 200, corsHeaders);
}

async function handleResetPassword(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const username = normalizeUsername(body.username);
  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, username);
  if (!user) return json({ error: "Unbekannter Nutzer" }, 404, corsHeaders);

  user.passwordHash = null;
  user.salt = null;
  user.iterations = null;
  user.mustSetPassword = true;
  user.passwordSetAt = null;

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  return json({ username, mustSetPassword: true }, 200, corsHeaders);
}

async function handleUpdateUser(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const username = normalizeUsername(body.username);
  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, username);
  if (!user) return json({ error: "Unbekannter Nutzer" }, 404, corsHeaders);

  const vorname = String(body.vorname || "").trim();
  const nachname = String(body.nachname || "").trim();
  if (!vorname || !nachname) return json({ error: "Vorname und Nachname erforderlich" }, 400, corsHeaders);

  // art ist OPTIONAL: fehlt es im Body (älterer Client), bleibt die bisherige Art
  // stehen. Ein normalizeArt(undefined) würde "personal" liefern und damit jeden
  // Spieler beim ersten Bearbeiten stillschweigend zum Personal befördern -- inkl.
  // Wiederauftauchen in Personalakte und Teilen-Pickern.
  const art = body.art === undefined ? userArt(user) : normalizeArt(body.art);
  // Ein Spieler ist nie Admin (gleiche Invariante wie in handleCreateUser). Beim
  // Umstufen Personal -> Spieler wird ein bestehender Admin-Status entzogen.
  const isAdmin = art === USER_ART_SPIELER ? false : !!body.isAdmin;
  if (user.isAdmin && !isAdmin) {
    const adminCount = Object.values(usersDoc.users).filter((u) => u.isAdmin).length;
    if (adminCount <= 1) return json({ error: "Letztem Admin kann der Admin-Status nicht entzogen werden" }, 400, corsHeaders);
  }

  user.vorname = vorname;
  user.nachname = nachname;
  user.art = art;
  user.isAdmin = isAdmin;
  user.lizenz = normalizeLizenz(body.lizenz);
  // ⚠️ Seit 2026-08-12 ist "mannschaften" ein ABGELEITETES Feld, sobald der
  // Abgleich in mannschaften.json eingeschaltet ist -- gepflegt wird dann
  // ausschliesslich an der Mannschaft. Der Client sperrt das Eingabefeld auch,
  // aber Ausblenden ist nicht Zurueckhalten: ohne diese Schranke schriebe jeder
  // Aufruf von update-user (auch der Personalkosten-Import) den berechneten
  // Wert wieder mit Freitext zu, und die Liste haette bis zum naechsten
  // Abgleich eine zweite Wahrheit neben sich.
  // Solange der Schalter AUS ist, bleibt der alte Weg unveraendert offen --
  // sonst koennte waehrend des Aufbaus der Liste niemand mehr etwas pflegen.
  const mannschaftenGesperrt = await mannschaftenAbgleichLaeuft(authHeader);
  if (!mannschaftenGesperrt) {
    user.mannschaften = normalizeMannschaften(body.mannschaften);
  }
  user.vertragBenoetigt = !!body.vertragBenoetigt;

  // Der Login-Nutzername wird beim Anlegen einmalig aus Vorname/Nachname generiert
  // (generateUsername) und danach nie mehr angefasst. Ohne diesen Abgleich bleibt
  // eine spätere Namenskorrektur (z. B. Tippfehler im Vornamen) rein kosmetisch: die
  // Liste zeigt den neuen Namen, aber das Konto ist weiterhin nur unter dem alten
  // Nutzernamen erreichbar, und der Nutzer kann sich mit seinem (jetzt korrekten)
  // Namen nicht mehr anmelden. Nur bei freier Ziel-Kennung umbenennen; kollidiert sie
  // mit einem ANDEREN Konto, lieber gar nicht anfassen und den Konflikt zurückmelden,
  // statt eine "-2"-Variante zu erzeugen, die der Nutzer beim Anmelden nie eingeben würde.
  const desiredUsername = baseUsernameFor(vorname, nachname);
  let usernameRename = null;
  if (desiredUsername !== username) {
    if (getOwn(usersDoc.users, desiredUsername)) {
      usernameRename = { from: username, to: desiredUsername, applied: false };
    } else {
      delete usersDoc.users[username];
      user.username = desiredUsername;
      usersDoc.users[desiredUsername] = user;
      Object.values(usersDoc.groups || {}).forEach((g) => {
        if (!Array.isArray(g.memberUsernames)) return;
        const idx = g.memberUsernames.indexOf(username);
        if (idx !== -1) g.memberUsernames[idx] = desiredUsername;
      });
      usernameRename = { from: username, to: desiredUsername, applied: true };
    }
  }
  const finalUsername = (usernameRename && usernameRename.applied) ? desiredUsername : username;

  // ⚠️ Das Nutzerfoto liegt unter dem Nutzernamen ALS DATEINAME (siehe
  // NUTZERFOTOS_DIR) -- bei einer Umbenennung muss es mitwandern, sonst ist das
  // Bild nach einer bloßen Tippfehler-Korrektur im Vornamen verschwunden. Das ist
  // kein Randfall: umbenannt wird hier automatisch, sobald jemand einen Namen
  // korrigiert. Scheitert der Umzug, wird fotoVersion geräumt -- lieber gar kein
  // Bild als ein Verweis ins Leere, dem jeder Client mit einem 404 hinterherläuft.
  if (usernameRename && usernameRename.applied && user.fotoVersion &&
      USERNAME_RE.test(username) && USERNAME_RE.test(desiredUsername)) {
    let bewegt = false;
    try {
      const mv = await fetch(nutzerfotoUrl(username), {
        method: "MOVE",
        headers: {
          Authorization: authHeader,
          Destination: nutzerfotoUrl(desiredUsername),
          Overwrite: "T"
        }
      });
      bewegt = mv.ok;
    } catch (_) { /* bewegt bleibt false */ }
    if (!bewegt) delete user.fotoVersion;
  }

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  return json({
    username: finalUsername, vorname, nachname, isAdmin,
    lizenz: user.lizenz, mannschaften: user.mannschaften,
    // Wurde das Mannschaftsfeld ignoriert, MUSS das dastehen. Ein stiller
    // No-Op waere hier der schlechteste Ausgang: der Admin tippt eine
    // Mannschaft ein, bekommt "Gespeichert" und verlaesst sich darauf.
    mannschaftenGesperrt: mannschaftenGesperrt,
    fotoVersion: user.fotoVersion || null, usernameRename
  }, 200, corsHeaders);
}

async function handleDeleteUser(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const username = normalizeUsername(body.username);
  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, username);
  if (!user) return json({ error: "Unbekannter Nutzer" }, 404, corsHeaders);

  if (user.isAdmin) {
    const adminCount = Object.values(usersDoc.users).filter((u) => u.isAdmin).length;
    if (adminCount <= 1) return json({ error: "Letzter Admin kann nicht gelöscht werden" }, 400, corsHeaders);
  }

  delete usersDoc.users[username];
  Object.values(usersDoc.groups || {}).forEach((g) => {
    g.memberUsernames = (g.memberUsernames || []).filter((m) => m !== username);
  });

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  // Ein Foto ist ein Personenbezug und darf ein gelöschtes Konto nicht überleben.
  // Bewusst NACH dem Schreiben und ohne Fehlerbehandlung: das Konto ist die
  // Wahrheit, und wenn der DELETE hier scheitert, ist eine zurückbleibende Datei
  // das kleinere Übel als ein abgebrochenes Löschen mit bereits entferntem Konto.
  if (user.fotoVersion && USERNAME_RE.test(username)) {
    try {
      await fetch(nutzerfotoUrl(username), { method: "DELETE", headers: { Authorization: authHeader } });
    } catch (_) { /* best effort */ }
  }

  return json({ deleted: username }, 200, corsHeaders);
}

// ---------- Aktionen: Gruppen ----------

async function handleCreateGroup(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const name = String(body.name || "").trim();
  if (!name) return json({ error: "Gruppenname erforderlich" }, 400, corsHeaders);

  const usersDoc = session.usersDoc;
  if (!usersDoc.groups) usersDoc.groups = {};

  const baseId = slugifyGroupName(name);
  const id = uniqueGroupId(baseId, new Set(Object.keys(usersDoc.groups)));
  usersDoc.groups[id] = { id, name, memberUsernames: [], createdAt: new Date().toISOString() };

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  return json({ group: usersDoc.groups[id] }, 201, corsHeaders);
}

// Gruppe umbenennen (seit 2026-08-07). Michel-Wunsch: ein Tippfehler im
// Gruppennamen war bis hierher nur ueber Loeschen und Neuanlegen zu beheben --
// und das nimmt der Gruppe alle Mitglieder und jedes Recht, das an ihr haengt.
//
// ⚠️ Geaendert wird AUSSCHLIESSLICH `name`, niemals `id`. Die Id ist der
// Schluessel, unter dem die Gruppe flottenweit referenziert wird: groupIds /
// editGroupIds / adminGroupIds in sichtbarkeit.json, aufgaben.assignGroupIds
// und .dokumentGroupIds, viewGroupId in RESTRICTED_FILE_APPS
// ("fuehrerschein-einsicht" steht sogar als Konstante im Code), dazu die
// pushEmpfaenger-Listen in den App-Dateien. Sie mitzuziehen hiesse, all diese
// Stellen in einem Zug umzuschreiben -- und was dabei uebersehen wird, entzieht
// still ein Recht. Der Slug bleibt deshalb bewusst der alte: nach dem
// Korrigieren von "Fördertraier" zu "Fördertrainer" heisst die Gruppe
// weiterhin `foerdertraier`. Das sieht niemand ausser hier im Code.
async function handleRenameGroup(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const groupId = String((body && body.groupId) || "").trim();
  const name = String((body && body.name) || "").trim();
  if (!groupId) return json({ error: "Gruppe fehlt" }, 400, corsHeaders);
  if (!name) return json({ error: "Gruppenname erforderlich" }, 400, corsHeaders);

  const usersDoc = session.usersDoc;
  // getOwn statt direktem Zugriff: eine Id "__proto__" traefe sonst den
  // Prototyp und der Handler schriebe an einem Objekt herum, das keine Gruppe ist.
  const group = getOwn(usersDoc.groups || {}, groupId);
  if (!group) return json({ error: "Unbekannte Gruppe" }, 404, corsHeaders);

  // Kein Fehler bei gleichem Namen, aber auch kein Schreibvorgang: nutzer.json
  // wird bei jeder Sitzungspruefung der ganzen Flotte gelesen, ein Write ohne
  // Aenderung waere ein vermeidbares Konfliktfenster.
  if (group.name === name) return json({ group, unveraendert: true }, 200, corsHeaders);

  group.name = name;
  group.umbenanntAm = new Date().toISOString();
  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  return json({ group }, 200, corsHeaders);
}

async function handleListGroups(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const usersDoc = session.usersDoc;
  return json({ groups: Object.values(usersDoc.groups || {}) }, 200, corsHeaders);
}

// Schmale Variante von list-groups für die Gruppen-Auswahl und die CSV-Spalte
// "Gruppen" im Trainerdaten-Admin: list-groups bleibt admin-only, hier darf
// zusätzlich die Population "darf Trainerdaten administrieren" lesen
// (resolveAdminPermission — Administrieren-Gruppen aus dem Sichtbarkeits-Panel,
// Admin-Kurzschluss inklusive; seit der dritten Rechte-Stufe hängt der ganze
// Trainerdaten-Admin-Modus an dieser Stufe, nicht mehr am Bearbeiten-Häkchen).
// Diese Personen sehen im Trainerdaten-Admin ohnehin alle Stammdaten inkl.
// IBAN; die Gruppenzugehörigkeit des Personals ist demgegenüber mild.
// Mitgliederlisten werden auf Personal gefiltert: Spielerkonten tauchen in den
// Trainerdaten nie auf und gehen einen Trainerdaten-Admin nichts an.
async function handleTrainerdatenListGroups(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveAdminPermission("trainerdaten", session, env, authHeader))) {
    return json({ error: "Nicht berechtigt" }, 403, corsHeaders);
  }

  const usersDoc = session.usersDoc;
  const istPersonalUsername = (username) => {
    const u = getOwn(usersDoc.users || {}, username);
    return !!u && istPersonal(u);
  };
  const groups = Object.values(usersDoc.groups || {}).map((g) => ({
    id: g.id,
    name: g.name,
    memberUsernames: (Array.isArray(g.memberUsernames) ? g.memberUsernames : []).filter(istPersonalUsername)
  }));
  return json({ groups }, 200, corsHeaders);
}

// Die eigenen Rechte-Stufen für EINE App — dieselben Resolver wie alle
// serverseitigen Gates (Admin-Kurzschluss inklusive). Primärer Konsument ist
// der Trainerdaten-CORS-Proxy (Worker "trainerdaten"): der prüft hierüber per
// Service Binding canAdmin (Administrieren-Stufe = Vollzugriff inkl. IBAN),
// bevor er WebDAV-Zugriffe mit seinen eigenen Nextcloud-Secrets ausführt.
// Bewusst 200 + false statt 403 bei fehlendem Recht, damit Aufrufer
// "Session ungültig" (401) von "eingeloggt, aber kein Recht" trennen können.
async function handleCheckEditPermission(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const app = String(body.app || "");
  if (!app) return json({ error: "app fehlt" }, 400, corsHeaders);
  const cfg = prefetchJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  const canEdit = await resolveEditPermission(app, session, env, authHeader, cfg);
  const canAdmin = await resolveAdminPermission(app, session, env, authHeader, cfg);
  return json({ canEdit: !!canEdit, canAdmin: !!canAdmin }, 200, corsHeaders);
}

// Schlanke, nicht-Admin-Variante von list-users/list-groups für "Teilen mit"-Picker
// in Gateway-Apps: nur Name+Nutzername bzw. Id+Name, keine Passwort-/Admin-/
// Mitgliederdaten. Jeder eingeloggte Nutzer darf das abrufen (kein isAdmin-Gate).
async function handleListDirectory(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  // Spieler bekommen das Verzeichnis gar nicht: es gibt kein Spieler-Tool mit
  // Teilen-Picker, und die vollständige Namensliste des Vereins ist nichts, was
  // ein Spielerkonto abrufen können muss. Braucht ein Spieler-Feature später
  // Namen, bekommt es eine eigene, schmale Aktion (Minimal-Disclosure) statt
  // einer Aufweichung hier.
  if (session.art === USER_ART_SPIELER) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const usersDoc = session.usersDoc;
  // Nur Personal: der Picker (z.B. Vereinskalender "Teilen mit") soll nicht durch
  // 200 Spielernamen unbenutzbar werden -- und Spieler sind dort nie das Ziel.
  const users = Object.values(usersDoc.users).filter(istPersonal).map((u) => ({
    username: u.username,
    displayName: (u.vorname && u.nachname) ? `${u.vorname} ${u.nachname}` : u.username
  }));
  const groups = Object.values(usersDoc.groups || {}).map((g) => ({ id: g.id, name: g.name }));
  return json({ users, groups }, 200, corsHeaders);
}

// Mitglieder der Bearbeiter-Gruppen (editGroupIds) einer bestimmten App -- z.B.
// für einen "Vertreter"-Picker im Abwesenheitskalender-Formular. Wie
// list-directory nur username+displayName, keine sensiblen Felder. Anders als
// list-directory an eine konkrete App gebunden (userMayAccessTool-Check wie
// dav-load), damit die Bearbeiter-Struktur einer App nicht an Nutzer ohne
// jeglichen Zugriff auf diese App durchsickert.
async function handleListToolEditors(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const app = String(body.app || "");
  // Existenz gegen die TOOL-Konfiguration prüfen, nicht gegen DAV_APPS. Diese
  // Aktion fasst kein WebDAV an -- sie liest nur config.tools und die Gruppen,
  // beides eine Zeile weiter unten. Die DAV_APPS-Abfrage war hier die falsche
  // Frage und hat Apps ausgesperrt, die bewusst OHNE DAV_APPS-Eintrag laufen:
  // vereinsaufgaben verzichtet darauf, weil ein dav-load dort vertrauliche
  // Aufgaben im Klartext ausliefern würde. Folge war 400 "Unbekannte App" ->
  // der Client fängt das ab und zeigt eine leere Personenliste, wodurch
  // Verantwortlich, Stellvertretung, Mitglieder UND der Empfängerpicker alle
  // leer blieben. Das Gate bleibt `userMayAccessTool` direkt darunter.
  // Geprüft am 2026-07-28: alle 20 DAV_APPS stehen auch in config.tools, für
  // sie ändert sich dadurch nichts.
  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  const entry = getOwn(config.tools || {}, app);
  if (!entry) return json({ error: "Unbekannte App" }, 400, corsHeaders);
  if (!(await userMayAccessTool(app, session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }
  // Administrieren-Gruppen zählen mit -- deren Mitglieder SIND Bearbeiter
  // (resolveEditPermission wertet adminGroupIds genauso), also gehören sie
  // auch in jeden "Bearbeiter"-Picker.
  const editGroupIds = (entry && Array.isArray(entry.editGroupIds)) ? entry.editGroupIds : [];
  const adminGroupIds = (entry && Array.isArray(entry.adminGroupIds)) ? entry.adminGroupIds : [];
  const usersDoc = session.usersDoc;
  const usernames = new Set();
  editGroupIds.concat(adminGroupIds).forEach((gid) => {
    const group = getOwn(usersDoc.groups || {}, gid);
    if (group && Array.isArray(group.memberUsernames)) group.memberUsernames.forEach((u) => usernames.add(u));
  });
  const users = Array.from(usernames).map((username) => {
    const u = getOwn(usersDoc.users, username);
    return { username, displayName: (u && u.vorname && u.nachname) ? `${u.vorname} ${u.nachname}` : username };
  });
  return json({ users }, 200, corsHeaders);
}

// Zentrales Trainerprofil (Lizenz + Mannschaften) für ALLE Nutzer, nicht nur den
// eigenen Account (me() liefert nur das eigene Profil). Gleiche Vertrauensstufe
// wie list-directory/dav-load: jeder eingeloggte Nutzer darf lesen, keine
// sensiblen Felder (kein isAdmin/mustSetPassword/Passwort-Hash).
async function handleListTrainerProfiles(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const usersDoc = session.usersDoc;
  // Nur Personal. Zwei Gründe: ein Spieler HAT kein Trainerprofil (Lizenz/
  // Mannschaften sind Personal-Felder), und der Kadermanager joint diese Liste
  // per linkedUsername an seine Kadereinträge -- stünden Spieler drin, bekäme
  // jeder Spieler-Kaderplatz ein sinnloses Lizenz-Badge.
  // Bewusst KEIN 403 für Spieler (anders als list-directory): der Kadermanager
  // ruft diese Aktion beim Laden für die Trainer-Badges auf, und db.js wirft bei
  // 403 -- ein Spieler bekäme sonst eine kaputte App statt einer Kaderliste.
  const profiles = Object.values(usersDoc.users)
    .filter(istPersonal)
    .filter((u) => u.vorname && u.nachname)
    .map((u) => ({
      username: u.username,
      vorname: u.vorname,
      nachname: u.nachname,
      lizenz: u.lizenz || "",
      mannschaften: Array.isArray(u.mannschaften) ? u.mannschaften : [],
      vertragBenoetigt: !!u.vertragBenoetigt
    }));
  return json({ profiles }, 200, corsHeaders);
}

// ---------- Aktionen: Spieler-Registrierung (Kadermanager) ----------
//
// Onboarding für ~200 Spielerkonten, ohne dass jemand 200 Zugänge einzeln
// verteilen und nachhalten muss. Der Auth-Faktor ist die physische Anwesenheit
// im Training: der Trainer öffnet ein kurzes Zeitfenster, zeigt den Link (QR
// oder Mannschafts-Chat), die Spieler tragen sich selbst ein.
//
// Bewusst ZUSTANDSLOS: das Fenster ist allein das signierte Token, es wird
// nirgends gespeichert. Damit gibt es keinen Registrierungs-State in
// spielerplus.json, der mit dem normalen Speichern der App um dieselbe Datei
// konkurriert (LWW), und ein Fenster kann nicht "hängenbleiben" -- es läuft
// durch exp von selbst ab. Preis: ein einmal ausgegebenes Fenster lässt sich
// nicht vorzeitig widerrufen (KM_REG_TTL_SECONDS deshalb kurz halten).
//
// Restrisiko, bewusst getragen: wer den Link innerhalb des Fensters hat, kann
// sich als JEDER noch freie Spieler dieser Mannschaft eintragen. Genau dagegen
// ist das Fenster kurz und der Trainer sieht die Neuzugänge live in seiner
// Kaderliste -- trägt sich jemand als "Leon" ein, während Leon danebensteht,
// fliegt das sofort auf. Diese soziale Kontrolle ersetzt hier eine
// E-Mail-Verifikation, die es bei Kindern schlicht nicht gibt.
const KM_REG_TOKEN_TYP = "km-reg";
const KM_REG_TTL_SECONDS = 15 * 60;
const SPIELER_GROUP_NAME = "Spieler";

// Prüft ein Registrierungs-Token. Der typ-Check ist nicht optional: verifyToken
// validiert nur Signatur+exp, und beide Token-Sorten sind mit demselben
// SESSION_SECRET signiert. Ohne ihn wäre jedes gültige Session-Token als
// Registrierungs-Token einsetzbar (und umgekehrt).
async function verifyKmRegToken(token, env) {
  const payload = await verifyToken(String(token || ""), env.SESSION_SECRET);
  if (!payload || payload.typ !== KM_REG_TOKEN_TYP || !payload.teamId) return null;
  return payload;
}

// Kadereintrag -> Vor-/Nachname. Der Kader führt EINEN Namensstring; erster Teil
// ist der Vorname, der Rest der Nachname ("Max von Mustermann" -> "Max" / "von
// Mustermann"). Ein einzelnes Wort ergibt einen leeren Nachnamen -- bewusst
// toleriert statt abgelehnt: ein unvollständig gepflegter Kadername darf die
// Registrierung im Training nicht blockieren (baseUsernameFor kommt damit klar).
function splitKaderName(name) {
  const teile = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (teile.length === 0) return null;
  return { vorname: teile[0], nachname: teile.slice(1).join(" ") };
}

// Öffnet das Registrierungsfenster für eine Mannschaft. Verlangt Bearbeiten-Recht
// am Kadermanager -- wer den Kader nicht pflegen darf, darf auch keine Konten
// dafür entstehen lassen.
async function handleKmRegOeffnen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await userMayAccessTool("kadermanager", session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }
  if (!(await resolveEditPermission("kadermanager", session, env, authHeader))) {
    return json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders);
  }

  const teamId = String(body.teamId || "");
  const doc = await readJson(DAV_APPS["kadermanager"], authHeader, { meta: {}, teams: [] });
  const team = (doc.teams || []).find((t) => t && t.id === teamId);
  if (!team) return json({ error: "Mannschaft nicht gefunden" }, 404, corsHeaders);

  const now = Math.floor(Date.now() / 1000);
  const exp = now + KM_REG_TTL_SECONDS;
  const token = await signToken(
    { typ: KM_REG_TOKEN_TYP, teamId, iat: now, exp, von: session.username },
    env.SESSION_SECRET
  );
  const freie = (team.kader || []).filter((s) => s && !s.linkedUsername).length;
  return json({ token, teamName: team.name || "", expiresAt: exp * 1000, ttlSeconds: KM_REG_TTL_SECONDS, freieSpieler: freie }, 200, corsHeaders);
}

// Was der Spieler nach dem Scannen sieht. OHNE Auth -- er hat ja noch kein Konto;
// das Token IST der Ausweis. Liefert bewusst nur id+name der noch freien
// Kaderplätze: keine Rollen, keine Fotos, keine Termine, und nichts über die
// bereits registrierten Mitspieler.
async function handleKmRegInfo(body, env, authHeader, corsHeaders) {
  const payload = await verifyKmRegToken(body.token, env);
  if (!payload) return json({ error: "Dieser Anmelde-Link ist abgelaufen oder ungültig. Bitte den Trainer um einen neuen." }, 401, corsHeaders);

  const doc = await readJson(DAV_APPS["kadermanager"], authHeader, { meta: {}, teams: [] });
  const team = (doc.teams || []).find((t) => t && t.id === payload.teamId);
  if (!team) return json({ error: "Mannschaft nicht gefunden" }, 404, corsHeaders);

  const spieler = (team.kader || [])
    .filter((s) => s && !s.linkedUsername && String(s.name || "").trim())
    .map((s) => ({ id: s.id, name: s.name }));
  return json({ teamName: team.name || "", spieler, expiresAt: (payload.exp || 0) * 1000 }, 200, corsHeaders);
}

// Legt das Spielerkonto an und verknüpft es mit dem Kaderplatz. OHNE Auth, das
// Token trägt die Berechtigung.
//
// Reihenfolge (nutzer.json ZUERST, dann spielerplus.json) ist bewusst gewählt --
// die beiden Schreibvorgänge sind nicht atomar, und einer der Fehlerfälle ist
// deutlich milder als der andere:
//   Konto ohne Kaderplatz  -> Spieler ist eingeloggt und hakt sich per "Das bin
//                             ich" selbst ein. Heilt sich selbst.
//   Kaderplatz ohne Konto  -> Platz ist dauerhaft blockiert, niemand kann sich
//                             mehr darauf registrieren, und nur der Trainer
//                             könnte es (wenn er es merkt) wieder lösen.
// Deshalb: erst das Konto. Schlägt danach die Verknüpfung fehl, kommt der
// Spieler trotzdem mit gültiger Sitzung raus, nur mit verknuepft:false.
async function handleKmRegAbschliessen(request, body, env, authHeader, corsHeaders) {
  const payload = await verifyKmRegToken(body.token, env);
  if (!payload) return json({ error: "Dieser Anmelde-Link ist abgelaufen oder ungültig. Bitte den Trainer um einen neuen." }, 401, corsHeaders);

  const spielerId = String(body.spielerId || "");

  // Zweiter Weg: der Scanner ist bereits angemeldet (typisch der Torhüter, der schon
  // in seiner Mannschaft steht und sich zusätzlich für die Torwartgruppe einträgt).
  // Dann kein zweites Konto anlegen -- das erzeugte bisher stillschweigend einen
  // Doppelaccount ("leon.mueller2") --, sondern nur den Kaderplatz verknüpfen.
  // getVerifiedSession liefert bei fehlendem/abgelaufenem Token sauber null, ohne zu
  // werfen; die Erstanmeldung echter Neulinge läuft also unverändert weiter unten.
  const session = await getVerifiedSession(request, env, authHeader);
  if (session) {
    // Gleiche Schranke wie handleKmSelf: das Reg-Token berechtigt zum Kader, aber
    // wer das Tool gar nicht sehen darf, soll sich auch nicht hineinverknüpfen.
    if (!(await userMayAccessTool("kadermanager", session, env, authHeader))) {
      return json({ error: "Dein Konto hat keinen Zugriff auf den Kadermanager. Bitte wende dich an deinen Trainer." }, 403, corsHeaders);
    }
    return kmRegVerknuepfeBestehendes(payload, spielerId, session.username, authHeader, corsHeaders);
  }

  const pwError = validatePasswordStrength(body.password);
  if (pwError) return json({ error: pwError }, 400, corsHeaders);

  const { data: kmDoc, rev } = await readJsonWithRev(DAV_APPS["kadermanager"], authHeader, { meta: {}, teams: [] });
  const team = (kmDoc.teams || []).find((t) => t && t.id === payload.teamId);
  if (!team) return json({ error: "Mannschaft nicht gefunden" }, 404, corsHeaders);
  const spieler = (team.kader || []).find((s) => s && s.id === spielerId);
  if (!spieler) return json({ error: "Dieser Eintrag steht nicht mehr im Kader." }, 404, corsHeaders);
  // Doppelregistrierung: Erstprüfung gegen den gelesenen Stand. Die eigentliche
  // Absicherung gegen zwei gleichzeitige Anmeldungen auf denselben Platz ist das
  // If-Match beim Schreiben weiter unten -- diese Prüfung hier erspart nur den
  // sinnlosen Kontoanlage-Versuch im Normalfall.
  if (spieler.linkedUsername) return json({ error: "Für diesen Spieler gibt es schon ein Konto." }, 409, corsHeaders);

  const namen = splitKaderName(spieler.name);
  if (!namen) return json({ error: "Dieser Kadereintrag hat keinen Namen. Bitte den Trainer, ihn zu ergänzen." }, 400, corsHeaders);

  // --- Schritt 1: Konto anlegen ---
  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  if (!usersDoc.groups) usersDoc.groups = {};
  const username = generateUsername(namen.vorname, namen.nachname, new Set(Object.keys(usersDoc.users)));
  const { hash, salt, iterations } = await hashNewPassword(String(body.password || ""));
  const nowIso = new Date().toISOString();
  usersDoc.users[username] = {
    username, vorname: namen.vorname, nachname: namen.nachname,
    passwordHash: hash, salt, iterations,
    art: USER_ART_SPIELER,
    isAdmin: false,
    // Das Passwort wird hier direkt gesetzt (nicht mustSetPassword:true wie bei
    // create-user): der Spieler steht gerade davor und vergibt es selbst -- ein
    // zweiter "jetzt Passwort setzen"-Schritt ohne Auth wäre genau die Lücke,
    // die dieser ganze Ablauf ersetzt.
    mustSetPassword: false,
    lizenz: "", mannschaften: [], vertragBenoetigt: false,
    createdAt: nowIso, passwordSetAt: nowIso, lastLoginAt: nowIso
  };
  // Ohne Gruppe sähe der Spieler nach dem Login kein einziges Tool -- der
  // "keine Gruppe = alle eingeloggten"-Default gilt für Spieler nicht
  // (userMayAccessTool). Die Gruppe wird bei Bedarf angelegt; sie muss in
  // sichtbarkeit.json bei kadermanager.groupIds stehen, sonst bleibt die App leer.
  const spielerGruppe = ensureSpielerGruppe(usersDoc);
  addUserToGroups(usersDoc, username, [spielerGruppe.id]);

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Konto konnte nicht angelegt werden: " + e.message }, 502, corsHeaders);
  }

  const sessionToken = await signToken(makeSessionPayload(username, false), env.SESSION_SECRET);

  // --- Schritt 2: Kaderplatz verknüpfen ---
  // If-Match: hat in der Zwischenzeit jemand anders gespeichert (anderer Spieler,
  // Trainer im selben Moment), schlägt das fehl statt dessen Änderung zu
  // überschreiben. Das Konto steht dann schon -- deshalb verknuepft:false statt
  // eines Fehlers, der den Spieler ratlos zurückließe.
  spieler.linkedUsername = username;
  try {
    await writeJson(DAV_APPS["kadermanager"], authHeader, kmDoc, rev);
  } catch (e) {
    return json({
      token: sessionToken, username, verknuepft: false,
      hinweis: "Dein Konto ist angelegt und du bist angemeldet. Bitte wähle im Kader noch selbst deinen Namen aus („Das bin ich“)."
    }, 200, corsHeaders);
  }

  return json({ token: sessionToken, username, verknuepft: true, teamName: team.name || "", spielerName: spieler.name || "" }, 200, corsHeaders);
}

// Bereits angemeldeter Scanner: nur verknüpfen, kein Konto anlegen. Die Mannschaft
// kommt aus dem verifizierten Reg-Token, NIE aus dem Request-Body -- km-reg-info gibt
// bewusst keine teamId heraus, und ein manipulierter Body darf keinen fremden Kader
// treffen. Antwortform identisch zum Kontoanlage-Pfad, damit der Client beide Fälle
// gleich behandelt (nur ohne `token`: die Sitzung besteht ja schon).
async function kmRegVerknuepfeBestehendes(payload, spielerId, username, authHeader, corsHeaders) {
  const url = DAV_APPS["kadermanager"];
  // Retry wie in handleKmSelf: read-modify-write auf einer Datei, die Trainer und
  // andere Spieler gleichzeitig schreiben. Ein 412 ist hier heilbar, weil die
  // Verknüpfung idempotent auf dem frischen Stand neu versucht werden kann.
  for (let versuch = 0; versuch < 3; versuch++) {
    jsonCache.delete(url);
    const { data: doc, rev } = await readJsonWithRev(url, authHeader, { meta: {}, teams: [] });
    jsonCache.delete(url);

    const team = (doc.teams || []).find((t) => t && t.id === payload.teamId);
    if (!team) return json({ error: "Mannschaft nicht gefunden" }, 404, corsHeaders);

    const res = kmVerknuepfeKaderplatz(team, spielerId, username);
    if (res.error) return json({ error: res.error }, res.status || 400, corsHeaders);

    try {
      await writeJson(url, authHeader, doc, rev);
    } catch (e) {
      // Nur Konflikte sind erneut versuchbar; ein Netz-/Serverfehler wird als solcher
      // gemeldet, statt ihn als "jemand anders war schneller" zu verkleiden.
      if (e instanceof ConflictError && versuch < 2) continue;
      if (e instanceof ConflictError) {
        return json({
          username, verknuepft: false,
          hinweis: "Gerade haben zu viele gleichzeitig gespeichert. Öffne den Kadermanager und wähle dort deinen Namen aus („Das bin ich“)."
        }, 200, corsHeaders);
      }
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
    return json({ username, verknuepft: true, teamName: team.name || "", spielerName: res.spieler.name || "" }, 200, corsHeaders);
  }
}

// Reduzierte Kadermanager-Sicht für Spielerkonten.
//
// Die App selbst kennt bewusst keine abgestufte Sichtbarkeit ("nur das Bearbeiten
// ist granular, nicht das Sehen") -- bei ~20 Trainern war das richtig, bei ~200
// Spielern nicht: sonst sieht jeder Jugendliche die Mannschaftskasse aller
// (wer wie viel Strafe schuldet), wer wann krank war, und die Kader sämtlicher
// anderer Mannschaften.
//
// Serverseitig statt im Client, weil der Client umgehbar ist -- gefiltert wird, was
// gar nicht erst ausgeliefert wird. Das ist hier gefahrlos möglich, weil ein Spieler
// dav-save NIE aufrufen darf (kadermanager steht in WRITE_REQUIRES_EDIT_PERMISSION,
// Spieler haben kein Bearbeiten-Recht): die gekürzte Kopie kann also nicht
// zurückgeschrieben werden und dabei fremde Daten löschen. Der einzige Schreibweg
// für Spieler ist km-self, und das arbeitet serverseitig immer auf dem VOLLEN Doc.
function kmSpielerSicht(doc, username) {
  const teams = Array.isArray(doc.teams) ? doc.teams : [];
  const gehoertMir = (t) => (Array.isArray(t && t.kader) ? t.kader : [])
    .some((s) => s && s.linkedUsername && sameText(s.linkedUsername, username));
  const meine = teams.filter(gehoertMir);

  // Noch keinem Kaderplatz zugeordnet -- seltener Fall, tritt nur auf, wenn die
  // Verknüpfung bei der Registrierung kollidierte (verknuepft:false). Dann genau so
  // viel ausliefern, dass "Das bin ich" möglich ist: Mannschafts- und Kadernamen,
  // sonst nichts. Ohne das säße der Spieler in einer leeren App fest.
  if (meine.length === 0) {
    return {
      meta: {},
      teams: teams.map((t) => ({
        id: t.id, name: t.name, farbe: t.farbe,
        kader: (Array.isArray(t.kader) ? t.kader : [])
          .map((s) => ({ id: s.id, name: s.name, linkedUsername: s.linkedUsername || "" })),
        termine: [], umfragen: [], abwesenheiten: [],
        kasse: { strafenkatalog: [], buchungen: [] }
      }))
    };
  }

  return {
    // meta mitnehmen: meta.rollenRechte steuert hasRecht() im Client.
    meta: (doc.meta && typeof doc.meta === "object") ? doc.meta : {},
    teams: meine.map((t) => {
      const ich = (t.kader || []).find((s) => s && s.linkedUsername && sameText(s.linkedUsername, username));
      const meineId = ich ? ich.id : null;
      const kasse = (t.kasse && typeof t.kasse === "object") ? t.kasse : {};
      return Object.assign({}, t, {
        // Urlaub/Krank ist gesundheitsnah -- nur der eigene Eintrag.
        abwesenheiten: (Array.isArray(t.abwesenheiten) ? t.abwesenheiten : [])
          .filter((a) => a && a.spielerId === meineId),
        kasse: {
          // Der Strafenkatalog ist nur die Preisliste ("Zu spät: 2 €") -- die darf
          // und soll jeder sehen, sie enthält keine Personendaten.
          strafenkatalog: Array.isArray(kasse.strafenkatalog) ? kasse.strafenkatalog : [],
          // Buchungen nur die eigenen: was ein Mitspieler schuldet, geht niemanden an.
          buchungen: (Array.isArray(kasse.buchungen) ? kasse.buchungen : [])
            .filter((b) => b && b.spielerId === meineId)
        }
      });
    })
  };
}

// ---------- Aktion: Spieler-Selbstbedienung im Kadermanager ("Briefschlitz") ----------
//
// Ein Spieler darf genau seine EIGENEN Einträge ändern: zusagen/absagen, abstimmen,
// eine ihm zugewiesene Aufgabe abhaken, Mitfahrt anbieten/suchen, Urlaub/Krank
// melden -- alles OHNE Bearbeiten-Recht am Tool.
//
// Warum eine eigene Aktion statt einfach Bearbeiten-Recht: das generische dav-save
// schreibt IMMER die komplette Datei zurück (alle Mannschaften, alle Kader, die
// Kasse). Bearbeiten-Recht für ~200 Spielerkonten hieße, dass jedes davon den
// gesamten Bestand überschreiben oder löschen kann -- per Browser-Konsole trivial.
// Diese Aktion nimmt stattdessen eine winzige, getypte Nachricht entgegen und
// ändert serverseitig genau ein Feld.
//
// Sicherheitskern: der eigene Kaderplatz wird IMMER aus linkedUsername abgeleitet
// (kmSelfEigenerSpieler), NIE aus dem Request-Body. Ein manipulierter Request kann
// damit keinen fremden Eintrag treffen. Einzige Ausnahme ist "claim" -- das
// übernimmt per Definition einen Platz und prüft deshalb, dass er noch frei ist.
//
// Nebeneffekt gegen Schreibkonflikte: 25 Zusagen am Mittwochabend schicken je ein
// paar Byte statt der ganzen Datei; der Server serialisiert sie per If-Match und
// wiederholt bei Kollision selbst, statt dass Clients sich gegenseitig überschreiben.
const KM_SELF_STATUS = new Set(["zu", "unsicher", "ab"]);

async function handleKmSelf(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  // Bewusst NUR Sichtbarkeit, nicht resolveEditPermission -- genau das ist der Zweck
  // dieser Aktion. Wer das Tool nicht sehen darf, kommt aber auch hier nicht durch.
  if (!(await userMayAccessTool("kadermanager", session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }

  const url = DAV_APPS["kadermanager"];
  const art = String(body.art || "");
  const teamId = String(body.teamId || "");

  for (let versuch = 0; versuch < 3; versuch++) {
    // Frisch lesen erzwingen: der 5s-Cache könnte einen veralteten Stand liefern,
    // und ein read-modify-write braucht zwingend das ETag zum GELESENEN Inhalt.
    jsonCache.delete(url);
    const { data: doc, rev } = await readJsonWithRev(url, authHeader, { meta: {}, teams: [] });
    // Sofort wieder aus dem Cache nehmen -- readJsonWithRev legt das geparste Objekt
    // dort ab und gibt DIESE Referenz zurück. Ohne das Entfernen würde die Mutation
    // unten den Cache für parallele Requests im selben Isolate verfälschen (gleiche
    // Falle wie im Kommentar bei handleDavLoad).
    jsonCache.delete(url);

    const team = (doc.teams || []).find((t) => t && t.id === teamId);
    if (!team) return json({ error: "Mannschaft nicht gefunden" }, 404, corsHeaders);

    const res = kmSelfAnwenden(art, body, team, session.username);
    if (res.error) return json({ error: res.error }, res.status || 400, corsHeaders);

    try {
      await writeJson(url, authHeader, doc, rev);
      return json({ ok: true, ...(res.antwort || {}) }, 200, corsHeaders);
    } catch (e) {
      // Jemand anders hat zwischendurch gespeichert: frisch lesen und die eigene
      // Änderung erneut anwenden, statt fremde Änderungen zu überschreiben.
      if (e instanceof ConflictError && versuch < 2) continue;
      if (e instanceof ConflictError) {
        return json({ error: "Gerade speichern zu viele gleichzeitig. Bitte nochmal tippen." }, 409, corsHeaders);
      }
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
}

// Eigener Kaderplatz -- ausschließlich über die Verknüpfung, nie über den Body.
function kmSelfEigenerSpieler(team, username) {
  return (team.kader || []).find((s) => s && s.linkedUsername && sameText(s.linkedUsername, username)) || null;
}

// Spiegelt terminIstKommend() im Client (datum >= heute). Ein Tag Toleranz, weil der
// Worker in UTC rechnet und der Client in lokaler Zeit -- ohne die Toleranz wäre ein
// Termin "heute" je nach Uhrzeit serverseitig schon Vergangenheit. Für den Zweck der
// Regel (keine nachträgliche Änderung der Statistik-Historie) ist das unerheblich.
function kmTerminIstKommend(termin) {
  const gestern = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return String(termin.datum || "") >= gestern;
}

function kmFahrgemeinschaft(termin) {
  if (!termin.fahrgemeinschaft || typeof termin.fahrgemeinschaft !== "object") termin.fahrgemeinschaft = {};
  if (!Array.isArray(termin.fahrgemeinschaft.angebote)) termin.fahrgemeinschaft.angebote = [];
  if (!Array.isArray(termin.fahrgemeinschaft.gesuche)) termin.fahrgemeinschaft.gesuche = [];
  return termin.fahrgemeinschaft;
}

// Verknüpft einen Kaderplatz mit einem Konto. Einzige Stelle für diese Regel --
// beide Wege dorthin (km-self "claim" aus der App, km-reg-abschliessen mit
// bestehender Sitzung) rufen sie auf, damit die Bedingungen nicht auseinanderlaufen.
// Mutiert `team` in-place; der Aufrufer schreibt danach.
function kmVerknuepfeKaderplatz(team, spielerId, username) {
  const ziel = (team.kader || []).find((s) => s && s.id === String(spielerId || ""));
  if (!ziel) return { error: "Spieler nicht gefunden", status: 404 };
  if (ziel.linkedUsername) return { error: "Dieser Spieler ist bereits mit einem Konto verknüpft.", status: 409 };
  // Pro Team nur ein eigener Platz -- alten lösen (gleiche Regel wie claimSpieler).
  // Bewusst nur innerhalb DIESES Teams: eine Verknüpfung in einer anderen Mannschaft
  // oder Gruppe bleibt bestehen, das ist der Kern der Mehrfachzugehörigkeit.
  (team.kader || []).forEach((s) => { if (s.linkedUsername && sameText(s.linkedUsername, username)) s.linkedUsername = ""; });
  ziel.linkedUsername = username;
  return { spieler: ziel };
}

// Wendet GENAU EINE Selbstbedienungs-Änderung an. Gibt {error,status} oder {antwort}.
// Die Regeln spiegeln bewusst 1:1 die Client-Gates (canSetStatusFor, vote,
// toggleAufgabe, fgEntferne*, removeAbwesenheit) -- der Server darf nicht mehr
// erlauben als die Oberfläche anbietet, sonst ist der Client die einzige Schranke.
function kmSelfAnwenden(art, body, team, username) {
  const jetzt = new Date().toISOString();

  // claim läuft VOR der Eigener-Spieler-Ermittlung: dort gibt es noch keinen.
  if (art === "claim") {
    const res = kmVerknuepfeKaderplatz(team, body.spielerId, username);
    if (res.error) return { error: res.error, status: res.status };
    return { antwort: { spielerId: res.spieler.id } };
  }

  const ich = kmSelfEigenerSpieler(team, username);
  if (!ich) return { error: "Du bist in dieser Mannschaft keinem Kaderplatz zugeordnet.", status: 403 };

  const terminHolen = () => (team.termine || []).find((t) => t && t.id === String(body.terminId || ""));

  switch (art) {
    case "teilnahme": {
      const termin = terminHolen();
      if (!termin) return { error: "Termin nicht gefunden", status: 404 };
      if (!kmTerminIstKommend(termin)) return { error: "Vergangene Termine kann nur der Trainer ändern.", status: 403 };
      if (!termin.teilnahme || typeof termin.teilnahme !== "object") termin.teilnahme = {};
      if (body.status == null || body.status === "") { delete termin.teilnahme[ich.id]; return {}; }
      const status = String(body.status);
      if (!KM_SELF_STATUS.has(status)) return { error: "Unbekannter Status" };
      termin.teilnahme[ich.id] = { status, grund: String(body.grund || "").slice(0, 500), am: jetzt };
      return {};
    }

    case "umfrage": {
      const u = (team.umfragen || []).find((x) => x && x.id === String(body.umfrageId || ""));
      if (!u) return { error: "Umfrage nicht gefunden", status: 404 };
      if (!u.offen) return { error: "Diese Umfrage ist geschlossen.", status: 403 };
      const gueltig = new Set((u.optionen || []).map((o) => o && o.id));
      const gewaehlt = Array.isArray(body.optionIds)
        ? body.optionIds.map(String).filter((id) => gueltig.has(id))
        : [];
      if (!u.mehrfach && gewaehlt.length > 1) return { error: "Hier ist nur eine Antwort erlaubt." };
      if (!u.stimmen || typeof u.stimmen !== "object") u.stimmen = {};
      if (gewaehlt.length) u.stimmen[ich.id] = gewaehlt; else delete u.stimmen[ich.id];
      return {};
    }

    case "aufgabe": {
      const termin = terminHolen();
      if (!termin) return { error: "Termin nicht gefunden", status: 404 };
      const a = (termin.aufgaben || []).find((x) => x && x.id === String(body.aufgabeId || ""));
      if (!a) return { error: "Aufgabe nicht gefunden", status: 404 };
      if (!Array.isArray(a.spielerIds) || !a.spielerIds.includes(ich.id)) {
        return { error: "Diese Aufgabe ist dir nicht zugewiesen.", status: 403 };
      }
      if (!a.erledigt || typeof a.erledigt !== "object") a.erledigt = {};
      if (body.erledigt) a.erledigt[ich.id] = true; else delete a.erledigt[ich.id];
      return {};
    }

    case "fahrt-angebot": {
      const termin = terminHolen();
      if (!termin) return { error: "Termin nicht gefunden", status: 404 };
      const fg = kmFahrgemeinschaft(termin);
      fg.angebote = fg.angebote.filter((a) => a && a.spielerId !== ich.id);
      const plaetze = Number(body.plaetze);
      if (Number.isFinite(plaetze) && plaetze > 0) {
        fg.angebote.push({ spielerId: ich.id, plaetze: Math.min(Math.floor(plaetze), 20) });
      }
      return {};
    }

    case "fahrt-gesuch": {
      const termin = terminHolen();
      if (!termin) return { error: "Termin nicht gefunden", status: 404 };
      const fg = kmFahrgemeinschaft(termin);
      fg.gesuche = fg.gesuche.filter((id) => id !== ich.id);
      if (body.an) fg.gesuche.push(ich.id);
      return {};
    }

    case "unclaim": {
      // Löst ausschließlich die EIGENE Verknüpfung (ich stammt aus linkedUsername) --
      // eine spielerId aus dem Body wird bewusst ignoriert.
      ich.linkedUsername = "";
      return {};
    }

    case "urlaub-add": {
      if (!Array.isArray(team.abwesenheiten)) team.abwesenheiten = [];
      const von = String(body.von || "");
      const bis = String(body.bis || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(von) || !/^\d{4}-\d{2}-\d{2}$/.test(bis)) {
        return { error: "Ungültiger Zeitraum" };
      }
      if (bis < von) return { error: "Das Ende liegt vor dem Beginn." };
      // Id vom Client übernehmen, wenn brauchbar und frei: der Client hat den Eintrag
      // lokal schon mit dieser Id angelegt (sofortige Anzeige). Eine serverseitig neu
      // erzeugte Id würde auseinanderlaufen -- ein direkt folgendes Löschen schickt
      // dann eine Id, die es serverseitig nie gab (404).
      const wunschId = String(body.id || "");
      const idFrei = wunschId.length >= 8 && wunschId.length <= 64 &&
                     !team.abwesenheiten.some((x) => x && x.id === wunschId);
      const eintrag = {
        id: idFrei ? wunschId : crypto.randomUUID(),
        spielerId: ich.id, von, bis,
        grund: String(body.grund || "").slice(0, 300),
        typ: body.typ === "krank" ? "krank" : "urlaub"
      };
      team.abwesenheiten.push(eintrag);
      return { antwort: { id: eintrag.id } };
    }

    case "urlaub-del": {
      if (!Array.isArray(team.abwesenheiten)) team.abwesenheiten = [];
      const a = team.abwesenheiten.find((x) => x && x.id === String(body.abwesenheitId || ""));
      if (!a) return { error: "Eintrag nicht gefunden", status: 404 };
      if (a.spielerId !== ich.id) return { error: "Das ist nicht dein Eintrag.", status: 403 };
      team.abwesenheiten = team.abwesenheiten.filter((x) => x !== a);
      return {};
    }

    default:
      return { error: "Unbekannte Selbstbedienungs-Aktion" };
  }
}

// Legt die Spieler-Gruppe an, falls es sie noch nicht gibt. Gleiche Idee wie
// TRAINER_GROUP_NAME: über den Namen auffindbar, damit der Ablauf nicht an einer
// hartkodierten Id hängt, die in nutzer.json vielleicht nie angelegt wurde.
function ensureSpielerGruppe(usersDoc) {
  if (!usersDoc.groups) usersDoc.groups = {};
  const vorhanden = Object.values(usersDoc.groups).find((g) => g && g.name === SPIELER_GROUP_NAME);
  if (vorhanden) return vorhanden;
  const id = uniqueGroupId(slugifyGroupName(SPIELER_GROUP_NAME), new Set(Object.keys(usersDoc.groups)));
  usersDoc.groups[id] = { id, name: SPIELER_GROUP_NAME, memberUsernames: [] };
  return usersDoc.groups[id];
}

// Stellt ein kurzlebiges LiveKit-Zugangstoken für die Besprechung aus (Sprach-/
// Screenshare-Treffpunkt, siehe E:\besprechung). Die Besprechung speichert
// selbst NICHTS in Nextcloud -- diese Aktion ist ihre einzige Server-Berührung.
// LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET sind bewusst NICHT Teil von
// requiredSecrets oben (das würde bei fehlendem Secret die GESAMTE Gateway für
// alle Apps mit 500 blockieren) -- die Prüfung ist hier lokal auf diese eine
// Aktion beschränkt, ein fehlendes Secret bricht nur "livekit-token".
async function handleLivekitToken(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await userMayAccessTool("besprechung", session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf die Besprechung" }, 403, corsHeaders);
  }
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return json({ error: "LiveKit ist serverseitig noch nicht konfiguriert." }, 500, corsHeaders);
  }
  const room = String(body.room || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(room)) {
    return json({ error: "Ungültiger Raumname" }, 400, corsHeaders);
  }
  const user = getOwn(session.usersDoc.users, session.username);
  const name = (user && user.vorname && user.nachname) ? `${user.vorname} ${user.nachname}` : session.username;
  const token = await buildLivekitToken({
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
    identity: session.username,
    name,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    ttlSeconds: 6 * 60 * 60 // 6h -- deckt eine lange Versammlung ohne Token-Refresh-Logik ab
  });
  return json({ token, url: env.LIVEKIT_URL, identity: session.username, name }, 200, corsHeaders);
}

// Gate für die Moderations-Aktionen der Besprechung (kicken/stummschalten):
// eingeloggt + Bearbeiter-Recht (resolveEditPermission = "bestimmte Gruppen",
// dieselbe editGroupIds-Logik wie bei den anderen Apps) + LiveKit serverseitig
// konfiguriert. Liefert { session } oder { error: <Response> }.
async function requireBesprechungModerator(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return { error: json({ error: "Nicht angemeldet" }, 401, corsHeaders) };
  if (!(await resolveEditPermission("besprechung", session, env, authHeader))) {
    return { error: json({ error: "Keine Moderationsrechte für die Besprechung" }, 403, corsHeaders) };
  }
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return { error: json({ error: "LiveKit ist serverseitig noch nicht konfiguriert." }, 500, corsHeaders) };
  }
  return { session };
}

function validateBesprechungRoom(room) {
  const r = String(room || "").trim();
  return /^[a-zA-Z0-9_-]{1,100}$/.test(r) ? r : null;
}

// Entfernt einen Teilnehmer aus dem Besprechungsraum (LiveKit RemoveParticipant).
async function handleLivekitKick(request, body, env, authHeader, corsHeaders) {
  const gate = await requireBesprechungModerator(request, env, authHeader, corsHeaders);
  if (gate.error) return gate.error;
  const room = validateBesprechungRoom(body.room);
  const identity = String(body.identity || "").trim();
  if (!room) return json({ error: "Ungültiger Raumname" }, 400, corsHeaders);
  if (!identity) return json({ error: "Kein Teilnehmer angegeben" }, 400, corsHeaders);
  try {
    await livekitRoomService(env, "RemoveParticipant", { room, identity });
  } catch (e) {
    return json({ error: e.message }, 502, corsHeaders);
  }
  return json({ ok: true }, 200, corsHeaders);
}

// Schaltet einen einzelnen publizierten Track eines Teilnehmers stumm
// (LiveKit MutePublishedTrack). track_sid kommt vom moderierenden Client.
async function handleLivekitMute(request, body, env, authHeader, corsHeaders) {
  const gate = await requireBesprechungModerator(request, env, authHeader, corsHeaders);
  if (gate.error) return gate.error;
  const room = validateBesprechungRoom(body.room);
  const identity = String(body.identity || "").trim();
  const trackSid = String(body.trackSid || "").trim();
  if (!room) return json({ error: "Ungültiger Raumname" }, 400, corsHeaders);
  if (!identity || !trackSid) return json({ error: "Teilnehmer oder Track fehlt" }, 400, corsHeaders);
  try {
    await livekitRoomService(env, "MutePublishedTrack", { room, identity, track_sid: trackSid, muted: true });
  } catch (e) {
    return json({ error: e.message }, 502, corsHeaders);
  }
  return json({ ok: true }, 200, corsHeaders);
}

// Wer heute (Tag+Monat) laut Trainerdaten Geburtstag hat -- nur Vor-/Nachname,
// nie das Geburtsjahr oder andere Trainerdaten-Felder. Anders als
// personalakte-overview (siehe mayViewPersonalakte) bewusst für JEDEN
// eingeloggten Nutzer offen: dass heute jemandes Geburtstag ist, ist ein
// öffentlicher Anlass fürs Dashboard, das Geburtsjahr bleibt trotzdem exklusiv
// der Personalakte vorbehalten. Trainerdaten selbst bleibt PROVISION_ONLY
// (IBAN etc.) -- hier wird nur serverseitig gelesen und stark gefiltert.
async function handleListBirthdaysToday(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const trainerdatenDoc = await readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] });
  // "Heute" serverseitig ist ohne Zeitzonen-Bezug reines UTC -- Europe/Berlin
  // wird deshalb erzwungen, sonst wäre der Treffer in den ersten Stunden nach
  // Mitternacht MESZ/MEZ (UTC-Tageswechsel liegt davor) um bis zu zwei Stunden
  // verschoben.
  const heuteMD = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }).slice(5, 10);
  const namen = (trainerdatenDoc.trainer || [])
    .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.geburtsdatum || "") && t.geburtsdatum.slice(5, 10) === heuteMD)
    .map((t) => `${t.vorname || ""} ${t.nachname || ""}`.trim())
    .filter(Boolean);
  return json({ namen }, 200, corsHeaders);
}

// Kontaktliste des Vereins (App "kontakte"): wer sich in Trainerdaten dafür
// freigegeben hat, mit genau den Feldern, die er einzeln freigegeben hat.
// Gleiche Quelle und dieselbe Minimal-Disclosure-Linie wie
// handleListBirthdaysToday und handleRaumnutzungKontaktLookup darunter —
// Trainerdaten bleibt PROVISION_ONLY, gelesen wird nur serverseitig.
//
// ⚠️ Gefiltert wird HIER, nicht im Client. Ein nicht freigegebenes Feld darf den
// Worker gar nicht erst verlassen; Ausblenden im Client wäre kein Zurückhalten.
//
// ⚠️ Die Antwort wird aus BENANNTEN Einzelfeldern zusammengebaut, nie durch
// Kopieren des Datensatzes mit anschließendem Löschen. Die Datei enthält IBAN,
// Bankverbindung, Geburtsdatum, Dokument-Status und Vertragspfade — ein
// vergessenes delete wäre ein Leck, ein vergessenes Feld hier nur eine Lücke.
//
// ⚠️ Überall `=== true`. Die Bestandsdatensätze haben `kontaktFreigabe` nicht,
// und ein Wert wie "ja" darf nicht als Freigabe durchgehen: das Fehlen muss in
// die geschlossene Richtung fallen (genau umgekehrt zu `vertragspflichtig`).
// Ohne `name` gibt es überhaupt keinen Eintrag — ein Kontakt ohne Namen ist
// keiner, und die anderen Häkchen sind ohne ihn wirkungslos.
//
// Gate dreistufig: angemeldet, kein Spielerkonto (~200 Stück; gleiche Linie wie
// beim Materialcontainer-Code und list-directory — eine Telefonliste des
// Personals gehört nicht in Spielerhände), und die normale Tool-Sichtbarkeit,
// damit das Sichtbarkeits-Panel den Kreis wirklich steuert statt einer fest
// verdrahteten Regel hier.
async function handleKontakteListe(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (session.art === USER_ART_SPIELER) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);
  if (!(await userMayAccessTool("kontakte", session, env, authHeader))) {
    return json({ error: "Nicht berechtigt" }, 403, corsHeaders);
  }

  const trainerdatenDoc = await readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] });
  const kontakte = [];
  for (const t of trainerdatenDoc.trainer || []) {
    const f = t && t.kontaktFreigabe;
    if (!f || f.name !== true) continue;
    const vorname = String(t.vorname || "").trim();
    const nachname = String(t.nachname || "").trim();
    if (!vorname && !nachname) continue; // Freigabe ohne gepflegten Namen: nichts zu zeigen
    const eintrag = { vorname, nachname };
    if (f.telefon === true && String(t.telefon || "").trim()) eintrag.telefon = String(t.telefon).trim();
    if (f.email === true && String(t.email || "").trim()) eintrag.email = String(t.email).trim();
    if (f.adresse === true) {
      const strasse = String(t.strasse || "").trim();
      const plz = String(t.plz || "").trim();
      const ort = String(t.ort || "").trim();
      if (strasse || plz || ort) eintrag.adresse = { strasse, plz, ort };
    }
    kontakte.push(eintrag);
  }
  // Serverseitig sortiert: die Reihenfolge in der Datei ist die Anlegereihenfolge und
  // für eine Kontaktliste bedeutungslos.
  kontakte.sort((a, b) =>
    (a.nachname || "").localeCompare(b.nachname || "", "de") ||
    (a.vorname || "").localeCompare(b.vorname || "", "de")
  );
  return json({ kontakte }, 200, corsHeaders);
}

// Kontaktdaten-Prefill für den Raumnutzungs-Antrag (Veranstaltungsleitung/
// Vertretung): der Client schickt den frei getippten Namen, hier wird er gegen
// Trainerdaten (PROVISION_ONLY_PATHS) aufgelöst und NUR Straße/PLZ/Ort/Telefon/
// E-Mail zurückgegeben — nie IBAN, Geburtsdatum oder Dokumente (Minimal-
// Disclosure wie list-birthdays-today). Gate ist das Bearbeiten-Recht der
// Raumnutzung-App (resolveEditPermission, dieselbe Schranke wie dav-save dort):
// diese Personen tragen die Kontaktdaten sonst von Hand in den Antrag ein und
// sehen sie in jedem gespeicherten Antrag — die Aktion spart das Abtippen,
// öffnet aber keinem zusätzlichen Personenkreis Daten.
// Namensabgleich reihenfolge-tolerant über sameNamePair (das Formularfeld heißt
// "Name, Vorname", eingegeben wird erfahrungsgemäß beides — siehe
// [[feedback-name-matching-order-tolerance]]). Ein Komma-Paar ("Eschborn,
// Alexander") wird zuerst probiert, danach IMMER zusätzlich die Wort-Splits an
// der ersten und letzten Lücke (Kommas dabei wie Leerzeichen behandelt), damit
// auch Doppelnamen eine Chance haben ("Karl Heinz Müller" = Vorname "Karl
// Heinz" ODER Nachname "Heinz Müller"). Das Komma darf nie exklusiv gewinnen:
// eine Eingabe MIT Komma muss mindestens alles treffen, was dieselbe Eingabe
// ohne Komma träfe (Michel-Bugreport 2026-07-24: Komma-Eingaben liefen leer,
// während beide Leerzeichen-Reihenfolgen funktionierten). Treffer ohne jedes
// Kontaktfeld (reine Import-Stubs) werden übersprungen, sonst blockiert ein
// namensgleicher Stub den echten Datensatz.
async function handleRaumnutzungKontaktLookup(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveEditPermission("raumnutzung", session, env, authHeader))) {
    return json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders);
  }

  const name = String(body.name || "").trim().slice(0, 200);
  const paare = [];
  const kommaIdx = name.indexOf(",");
  if (kommaIdx >= 0) {
    const vorKomma = name.slice(0, kommaIdx).trim();
    const nachKomma = name.slice(kommaIdx + 1).trim();
    if (vorKomma && nachKomma) paare.push([vorKomma, nachKomma]);
  }
  const worte = name.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (worte.length >= 2) {
    paare.push([worte[0], worte.slice(1).join(" ")]);
    if (worte.length > 2) paare.push([worte.slice(0, -1).join(" "), worte[worte.length - 1]]);
  }
  if (!paare.length) return json({ treffer: null }, 200, corsHeaders);

  const trainerdatenDoc = await readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] });
  const liste = trainerdatenDoc.trainer || [];
  let td = null;
  for (const [a, b] of paare) {
    td = liste.find((t) => sameNamePair(t.vorname, t.nachname, a, b) &&
      (t.strasse || t.plz || t.ort || t.telefon || t.email)) || null;
    if (td) break;
  }
  if (!td) return json({ treffer: null }, 200, corsHeaders);

  return json({
    treffer: {
      strasse: td.strasse || "",
      plz: td.plz || "",
      ort: td.ort || "",
      telefon: td.telefon || "",
      email: td.email || ""
    }
  }, 200, corsHeaders);
}

// Brevo deckelt eine Mail samt Anhängen bei 10 MB. Der Antrag ist ein
// vierseitiges Formular (real deutlich unter 1 MB); die Grenze fängt nur ab,
// dass ein kaputter Client den Worker mit Müll flutet. base64 ist ~4/3 der
// Rohgröße, 8 MB entsprechen also gut 6 MB PDF.
const MAX_RAUMNUTZUNG_PDF_BASE64 = 8 * 1024 * 1024;

// Verschickt einen fertig ausgefüllten Raumnutzungs-Antrag als PDF-Anhang ans
// Amt. Gate ist seit 2026-07-27 resolveAdminPermission("raumnutzung"), also die
// dritte Stufe — bewusst STRENGER als das Bearbeiten-Recht, an dem dav-save für
// diese App hängt: Anträge ausfüllen und pflegen dürfen alle Bearbeiter (Trainer),
// sie beim Amt einreichen nur die Geschäftsstelle, die im Mailtext unterschreibt
// (Michel-Vorgabe). Achtung beim Ändern: leeres adminGroupIds heißt "niemand
// außer globalen Admins" — ohne gesetzte Administrieren-Gruppe kann hier also
// niemand mehr senden. Für raumnutzung ist sie auf "geschaeftsstelle" gesetzt.
//
// Empfänger, CC, Betreff und Text kommen AUSSCHLIESSLICH aus den Konstanten
// oben, nie aus dem Body — der Client schickt einzig das PDF und einen
// Dateinamen. Andernfalls wäre die Aktion für jeden Bearbeiter ein Versandweg an
// beliebige Adressen, abgeschickt unter dem Absender des Vereins.
//
// Anders als bei beleg-eingang-notify ist eine ausbleibende Mail hier ein echter
// Fehler und kein stilles sent:false: Dort lag der Beleg beim Aufruf schon in
// Nextcloud und die Mail war bloß die Benachrichtigung — hier IST der Versand
// die ganze Handlung. Ein grünes "erledigt" ohne tatsächlichen Versand hieße,
// der Antrag kommt beim Amt nie an und niemand merkt es.
async function handleRaumnutzungMailAntrag(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveAdminPermission("raumnutzung", session, env, authHeader))) {
    return json({ error: "Kein Administrieren-Recht für dieses Tool" }, 403, corsHeaders);
  }

  // Reines base64 erwartet (der Client trennt den data:-Präfix ab). Bewusst
  // streng geprüft: Brevo quittiert einen kaputten Anhang sonst mit einem
  // nichtssagenden Fehler, und am Bildschirm steht nur "Versand fehlgeschlagen".
  const pdfBase64 = String(body.pdfBase64 || "").trim();
  if (!pdfBase64 || !/^[A-Za-z0-9+\/]+={0,2}$/.test(pdfBase64)) {
    return json({ error: "Kein gültiges PDF übergeben" }, 400, corsHeaders);
  }
  if (pdfBase64.length > MAX_RAUMNUTZUNG_PDF_BASE64) {
    return json({ error: "Das PDF ist zu groß für den Mailversand." }, 413, corsHeaders);
  }

  // Der Dateiname kommt vom Client, wird hier aber gesäubert: er landet im
  // Content-Disposition des Anhangs, Pfadtrenner und Steuerzeichen haben dort
  // nichts zu suchen. Die Endung wird erzwungen, nicht geprüft.
  let dateiname = capStr(body.dateiname, 120).replace(/[\\/\r\n\t"]+/g, "_").replace(/\.pdf$/i, "");
  if (!dateiname) dateiname = "Raumnutzung-Antrag";
  dateiname += ".pdf";

  if (!env.BREVO_API_KEY) {
    return json({ error: "E-Mail-Versand ist serverseitig noch nicht konfiguriert." }, 500, corsHeaders);
  }

  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        sender: { email: NOTIFY_FROM_EMAIL, name: NOTIFY_FROM_NAME },
        to: [{ email: RAUMNUTZUNG_MAIL_TO }],
        cc: [{ email: RAUMNUTZUNG_MAIL_CC }],
        // Rückfragen des Amtes sollen bei der Geschäftsstelle landen, die im
        // Mailtext unterschreibt — nicht im Nachwuchs-Postfach, das hier nur
        // der technische Absender ist (Brevo-Einzelabsender, siehe oben).
        replyTo: { email: RAUMNUTZUNG_MAIL_CC, name: NOTIFY_FROM_NAME },
        subject: RAUMNUTZUNG_MAIL_SUBJECT,
        textContent: RAUMNUTZUNG_MAIL_TEXT,
        attachment: [{ name: dateiname, content: pdfBase64 }]
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("Brevo-Versand fehlgeschlagen", resp.status, errText);
      return json({ error: "Mail-Versand fehlgeschlagen (HTTP " + resp.status + ")" }, 502, corsHeaders);
    }
  } catch (e) {
    return json({ error: "Mail-Versand fehlgeschlagen: " + e.message }, 502, corsHeaders);
  }

  return json({ ok: true, sent: true, to: RAUMNUTZUNG_MAIL_TO, cc: RAUMNUTZUNG_MAIL_CC }, 200, corsHeaders);
}

// Ist dieser Nutzer "vertragspflichtig" (braucht einen Trainervertrag/Trainerdaten)?
// Gruppe "Trainer" ODER individuelles vertragBenoetigt-Flag (z.B. Helfer/Betreuer ohne
// Trainer-Rolle) -- gleiche Definition wie vertragspflichtigeUsernames weiter unten in
// handleGetAdminStats, hier als gemeinsamer Helfer für EINEN einzelnen Nutzer (siehe
// handleMyTrainerdatenStatus). Bewusst OHNE archiviert-Filter (anders als dort): ein
// archiviertes/gesperrtes Konto kommt über getVerifiedSession ohnehin nicht mehr hierher.
function isVertragspflichtig(usersDoc, username) {
  const trainerGroup = Object.values((usersDoc && usersDoc.groups) || {}).find((g) => g.name === TRAINER_GROUP_NAME) || null;
  const inTrainerGroup = !!(trainerGroup && (trainerGroup.memberUsernames || []).includes(username));
  const user = getOwn(usersDoc && usersDoc.users, username);
  return inTrainerGroup || !!(user && user.vertragBenoetigt);
}

// Status-Badge auf der Trainerdaten-Kachel (Dashboard) -- bewusst wie
// list-birthdays-today/list-trainer-profiles für JEDEN eingeloggten Nutzer
// offen (nur der eigene Datensatz, kein Admin-Gate wie mayViewPersonalakte).
// trainerdatenGesamtOk ist die einzige Ampel-Bedingung, serverseitig berechnet,
// damit die Logik nicht im Client dupliziert wird. null (nicht false), wenn WEDER
// ein Trainerdaten-Datensatz existiert NOCH die Person vertragspflichtig ist -- die
// Kachel zeigt dann bewusst KEIN rotes Kreuz ("bin gar kein Trainer"), sondern gar
// kein Badge. Ist die Person vertragspflichtig, aber es existiert (noch) gar kein
// Datensatz, zeigt die Kachel trotzdem ein rotes Kreuz ("Daten unvollständig") statt
// gar nichts -- Michel-Feedback 2026-07-14: "nicht vollständig sollte auch angezeigt
// werden", nicht nur stillschweigend fehlen.
// Seit 2026-07-17 zweistufig: für NICHT-Vertragspflichtige (die in Trainerdaten nur
// noch Kontaktdaten sehen) ist die Ampel allein "E-Mail hinterlegt". Das mitgelieferte
// vertragspflichtig-Flag sagt dem Dashboard, welche der beiden Ampeln es anzeigt.
async function handleMyTrainerdatenStatus(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const user = getOwn(session.usersDoc.users, session.username);
  const trainerdatenDoc = await readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] });
  const td = findTrainerdatenRecord(trainerdatenDoc, user);
  const summary = buildTrainerdatenSummary(td);

  // trainerlizenzGueltigBis ist ein reines "yyyy-mm-dd"-Datum (Kalendertag), kein
  // Zeitpunkt -- ein new Date(...)-Momentvergleich würde es ab Mitternacht UTC als
  // abgelaufen werten, obwohl die App selbst (_dateOnlyIsPast, String-Vergleich)
  // "gültig bis heute" noch den ganzen Tag über als gültig zeigt (Bug live erlebt:
  // Michel setzte testweise "gültig bis heute", App zeigte grün, Badge trotzdem rot).
  // String-Vergleich gegen "heute" in Europe/Berlin, gleiche Technik wie
  // handleListBirthdaysToday, hält Client und Server konsistent.
  const heuteBerlin = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const lizenzOk = summary.trainerlizenzNichtVorhanden === true || !!(
    summary.trainerlizenzHochgeladenAm &&
    (!summary.trainerlizenzGueltigBis || summary.trainerlizenzGueltigBis >= heuteBerlin)
  );
  const vertragspflichtig = isVertragspflichtig(session.usersDoc, session.username);
  const zeigeBadge = summary.vorhanden || vertragspflichtig;

  // Zwei Ampeln, weil es zwei Populationen gibt (seit 2026-07-17): Wer keinen
  // Trainervertrag braucht (Geschäftsführung o.ä.), sieht in Trainerdaten gar keine
  // Bankverbindung/Unterschrift/Dokumente mehr und kann die volle Bedingung deshalb
  // NIE erfüllen -- er bekäme dauerhaft ein rotes Kreuz für etwas, das er weder sieht
  // noch soll. Für ihn zählt allein die E-Mail: der einzige Grund, warum er das
  // Formular überhaupt ausfüllt (Kontaktaufnahme), und clientseitig sein einziges
  // zusätzliches Pflichtfeld -- Anzeige und Ampel bleiben so deckungsgleich, siehe
  // [[feedback-status-fallback-parity]].
  let trainerdatenGesamtOk;
  if (!zeigeBadge) {
    trainerdatenGesamtOk = null;
  } else if (!vertragspflichtig) {
    trainerdatenGesamtOk = !!summary.email;
  } else {
    trainerdatenGesamtOk = !!(
      summary.unterschriftAm &&
      lizenzOk &&
      summary.fuehrerscheinGueltig === true &&
      summary.fuehrungszeugnisEingereichtAm &&
      summary.kodexGueltig === true &&
      summary.jugendschutzGueltig === true
    );
  }

  // Einmal-Bonus fuer vollstaendige Trainer-Pflichten (Regelversion 5).
  //
  // Haengt bewusst HIER und nicht an einer eigenen Aktion: dieser Handler laeuft bei
  // jedem Seitenaufbau der Uebersicht und hat die Bedingung gerade ausgerechnet --
  // er kostet also keinen einzigen zusaetzlichen Lesevorgang, und der Bonus faellt
  // beim ersten Aufruf nach dem Vollstaendigwerden.
  //
  // ⚠️ Nur bei `=== true`. `trainerdatenGesamtOk` ist absichtlich dreiwertig: `null`
  // heisst "betrifft dich gar nicht" (kein Badge), und wer nicht vertragspflichtig
  // ist, erfuellt schon mit einer hinterlegten E-Mail. Beides ist gewollt -- die
  // Ampel und der Bonus muessen dasselbe sagen, sonst erklaert niemand die Differenz.
  //
  // ⚠️ Ein Schreibfehler darf die Statusanzeige nicht kippen: sie ist die eigentliche
  // Aufgabe dieser Aktion, der Bonus ist Beiwerk.
  let pflichtenBonus = false;
  if (trainerdatenGesamtOk === true) {
    pflichtenBonus = punkteEinmalBonusFaellig(user, "punkteBonusPflichtenAt");
    if (pflichtenBonus) {
      try {
        await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, session.usersDoc);
      } catch (e) {
        pflichtenBonus = false;
        console.error("Pflichten-Bonus-Sperre schreiben fehlgeschlagen: " + (e && e.message ? e.message : e));
      }
    }
  }

  const antwort = json({ ...summary, trainerdatenGesamtOk, vertragspflichtig }, 200, corsHeaders);
  if (pflichtenBonus) antwort.punkteBonus = { art: "pflichten", username: session.username };
  return antwort;
}

// E-Mail-Benachrichtigung an einen anderen Nutzer, siehe Doku-Kommentar bei
// "notify-user" oben. Adresse wird HIER serverseitig aufgelöst (nie vom Client
// entgegengenommen) -- PROVISION_ONLY_PATHS.trainerdaten darf laut Kommentar dort
// nie direkt an eingeloggte Nutzer durchgereicht werden, deshalb wird aus dem
// vollen buildTrainerdatenSummary()-Ergebnis ausschließlich das email-Feld
// verwendet und auch in der Antwort nie zurückgegeben.
// execCtx (nicht "ctx"): in den Vereinsaufgaben-Handlern ist "ctx" bereits der
// VA-Sitzungskontext aus vaSession(). Ein gleichnamiger Parameter waere dort ein
// SyntaxError, deshalb flottenweit in dieser Datei execCtx.
async function handleNotifyUser(request, body, env, authHeader, corsHeaders, execCtx) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const username = normalizeUsername(String(body.username || ""));
  const subject = String(body.subject || "").trim().slice(0, 200);
  const message = String(body.message || "").trim().slice(0, 4000);
  if (!username || !subject || !message) {
    return json({ error: "Ungültige Daten" }, 400, corsHeaders);
  }

  const targetUser = getOwn(session.usersDoc.users, username);
  if (!targetUser) return json({ ok: true, sent: false }, 200, corsHeaders);

  // ⚠️ Push VOR der E-Mail-Auflösung: wer keine Adresse in den Trainerdaten
  // stehen hat, steigt unten mit sent:false aus -- bekäme also auch keine
  // Push-Nachricht, obwohl sein Handy angemeldet ist.
  //
  // ⚠️ Der Betreff wird bewusst NICHT weitergereicht: bei einer Änderung
  // enthält er den Termintitel ("Privater Termin geändert: <Titel>"), und der
  // hat auf einem Sperrbildschirm nichts zu suchen. Ein Aufrufer darf über
  // pushText einen eigenen neutralen Satz mitgeben; ohne das greift der
  // Standard, weshalb der Vereinskalender unverändert bleiben kann.
  pushSenden(env, authHeader, execCtx, [username], "kalender",
    String(body.pushText || "Ein geteilter Termin wurde angelegt oder geändert. Öffne den Vereinskalender, dort stehen Tag, Uhrzeit und Ort.").slice(0, 200));

  const trainerdatenDoc = await readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] });
  const td = findTrainerdatenRecord(trainerdatenDoc, targetUser);
  const email = buildTrainerdatenSummary(td).email;
  if (!email) return json({ ok: true, sent: false }, 200, corsHeaders);

  if (!env.BREVO_API_KEY) {
    return json({ error: "E-Mail-Versand ist serverseitig noch nicht konfiguriert." }, 500, corsHeaders);
  }

  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        sender: { email: NOTIFY_FROM_EMAIL, name: NOTIFY_FROM_NAME },
        to: [{ email }],
        subject,
        textContent: message
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("Brevo-Versand fehlgeschlagen", resp.status, errText);
      return json({ error: "Mail-Versand fehlgeschlagen (HTTP " + resp.status + ")" }, 502, corsHeaders);
    }
  } catch (e) {
    return json({ error: "Mail-Versand fehlgeschlagen: " + e.message }, 502, corsHeaders);
  }

  return json({ ok: true, sent: true }, 200, corsHeaders);
}

// Lädt eine ausgelagerte TrainerCheckliste-Unterschrift (dateien/<fileId> der App,
// seit TrainerCheckliste 1.2 eigene PNG-Dateien statt inline-DataURL in der JSON)
// und liefert sie als PNG-DataURL — "" bei fehlender Datei/Fehler.
const CHECKLIST_SIG_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function loadChecklistSignaturDataUrl(fileId, authHeader) {
  if (typeof fileId !== "string" || !CHECKLIST_SIG_FILE_RE.test(fileId)) return "";
  const jsonUrl = DAV_APPS.trainercheckliste;
  const fileUrl = jsonUrl.slice(0, jsonUrl.lastIndexOf("/")) + "/dateien/" + fileId;
  try {
    const resp = await fetch(fileUrl, { method: "GET", headers: { Authorization: authHeader } });
    if (!resp.ok) return "";
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (!buf.length) return "";
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return "data:image/png;base64," + btoa(bin);
  } catch (_) { return ""; }
}

// Hängt die (ausgelagerten) Unterschriften einer Checklisten-Sektion wieder inline an
// die Antwort — nur für den EIGENEN Eintrag (kein Größenproblem), gleiche Idee wie
// handleMySubmission in Trainerdatens submit-worker. Alt-Einträge mit noch inline
// gespeicherter Unterschrift bleiben unberührt (out-Feld ist dann schon belegt).
async function attachChecklistSignaturen(out, rohSection, authHeader) {
  const s = rohSection || {};
  if (!out.unterschriftTrainer && s.unterschriftTrainerFileId) {
    out.unterschriftTrainer = await loadChecklistSignaturDataUrl(s.unterschriftTrainerFileId, authHeader);
  }
  if (!out.unterschriftFunktionaer && s.unterschriftFunktionaerFileId) {
    out.unterschriftFunktionaer = await loadChecklistSignaturDataUrl(s.unterschriftFunktionaerFileId, authHeader);
  }
}

// Trainer-Selbstbedienungs-Pendant zum Admin-only "TrainerCheckliste-Status"-Feld
// in Trainerdaten (dort per Admin-WebDAV gelesen, siehe TRAINERCHECKLISTE_WEBDAV_URL
// in Trainerdatens config.js) — dieselbe Quelle (DAV_APPS.trainercheckliste), aber
// serverseitig auf den EIGENEN Eintrag verengt, da der Trainer keinen WebDAV-Zugriff
// hat und das volle trainerEintraege-Array Namen/Adressen/Unterschriften ALLER
// anderen Trainer enthält (Minimal-Disclosure, wie list-birthdays-today).
async function handleMyTrainerchecklisteStatus(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const user = getOwn(session.usersDoc.users, session.username);
  const checklisteDoc = await readJson(DAV_APPS.trainercheckliste, authHeader, { trainerEintraege: [] });
  // Gleiche Match-Konvention wie handlePersonalakteOverview: linkedUsername (falls
  // je gesetzt) vor Namensfallback; TrainerCheckliste kennt aktuell kein
  // linkedUsername-Feld, der Zweig ist also Zukunftsvorsorge, kein toter Code-Pfad.
  const eintrag = (checklisteDoc.trainerEintraege || []).find((e) =>
    (e.linkedUsername && sameText(e.linkedUsername, session.username)) ||
    sameNamePair(e.vorname, e.name, user.vorname, user.nachname));
  if (!eintrag) return json({ vorhanden: false }, 200, corsHeaders);

  const sectionOut = (s) => {
    s = s || {};
    return {
      abgeschlossen: !!s.abgeschlossen,
      nichtAbgeschlossen: !!s.nichtAbgeschlossen,
      nichtAbgeschlossenGrund: s.nichtAbgeschlossenGrund || "",
      headerChecked: !!s.headerChecked,
      headerDatum: s.headerDatum || null,
      ort: s.ort || "",
      datum: s.datum || null,
      bemerkungen: s.bemerkungen || "",
      items: (s.items && typeof s.items === "object") ? s.items : {},
      itemTexts: (s.itemTexts && typeof s.itemTexts === "object") ? s.itemTexts : {},
      unterschriftTrainer: s.unterschriftTrainer || "",
      unterschriftFunktionaer: s.unterschriftFunktionaer || ""
    };
  };

  const zugang = sectionOut(eintrag.zugang);
  const abgang = sectionOut(eintrag.abgang);
  // Ausgelagerte Unterschriften (FileId statt inline) für die Anzeige in
  // Trainerdatens "Meine Checkliste" wieder inline anhängen.
  await attachChecklistSignaturen(zugang, eintrag.zugang, authHeader);
  await attachChecklistSignaturen(abgang, eintrag.abgang, authHeader);

  return json({ vorhanden: true, zugang, abgang }, 200, corsHeaders);
}

// Badge auf der Testspielplaner-Kachel (Dashboard): Anzahl EIGENER genehmigter
// Reservierungen ohne Gegner in den nächsten 14 Tagen ("Gegner eintragen oder
// Platz freigeben"). Logik muss anstehendeOhneGegner() in
// E:\testspielplaner\app.js spiegeln (ISO-Stringvergleich, Europe/Berlin wie
// handleListBirthdaysToday), sonst widersprechen sich Badge und In-App-Banner.
async function handleMyTestspielplanerStatus(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const doc = await readJson(DAV_APPS.testspielplaner, authHeader, { reservierungen: [] });
  const heute = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const grenze = new Date(Date.now() + 14 * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const anstehendOhneGegner = (Array.isArray(doc.reservierungen) ? doc.reservierungen : []).filter((r) =>
    r.erstelltVon === session.username && r.status === "genehmigt" &&
    !((r.gegner || "").trim()) && (r.datum || "") >= heute && (r.datum || "") <= grenze
  ).length;
  return json({ anstehendOhneGegner }, 200, corsHeaders);
}

async function handleUpdateGroupMembers(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const groupId = String(body.groupId || "");
  const usersDoc = session.usersDoc;
  const group = getOwn(usersDoc.groups || {}, groupId);
  if (!group) return json({ error: "Unbekannte Gruppe" }, 404, corsHeaders);

  const previous = Array.isArray(group.memberUsernames) ? group.memberUsernames.slice() : [];
  const requested = Array.isArray(body.memberUsernames) ? body.memberUsernames.map(normalizeUsername) : [];
  group.memberUsernames = requested.filter((u) => getOwn(usersDoc.users, u));

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  // Auto-Provisioning für NEU hinzugekommene Mitglieder (best effort).
  let provisioned = {};
  try {
    const added = group.memberUsernames.filter((u) => !previous.includes(u));
    if (added.length) {
      const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
      const apps = provisionAppsForGroups(config, [groupId]);
      const members = added.map((u) => getOwn(usersDoc.users, u)).filter(Boolean);
      if (apps.length && members.length) provisioned = await provisionUsers(members, apps, env, authHeader);
    }
  } catch (_) { /* Provisioning ist best effort */ }

  return json({ group, provisioned }, 200, corsHeaders);
}

// Provisioniert nachträglich ALLE aktuellen Mitglieder einer Gruppe in die für diese
// Gruppe konfigurierten Tools (Button "Bestehende Mitglieder jetzt eintragen").
// Batch pro App (1 Read + 1 Write), idempotent — bereits vorhandene Einträge bleiben.
async function handleProvisionGroup(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const groupId = String(body.groupId || "");
  const usersDoc = session.usersDoc;
  const group = getOwn(usersDoc.groups || {}, groupId);
  if (!group) return json({ error: "Unbekannte Gruppe" }, 404, corsHeaders);

  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  const apps = provisionAppsForGroups(config, [groupId]);
  const members = (group.memberUsernames || [])
    .map((u) => getOwn(usersDoc.users, u))
    .filter(Boolean);

  let provisioned = {};
  if (apps.length && members.length) {
    provisioned = await provisionUsers(members, apps, env, authHeader);
  }
  return json({ provisioned, apps, memberCount: members.length }, 200, corsHeaders);
}

async function handleDeleteGroup(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const groupId = String(body.groupId || "");
  const usersDoc = session.usersDoc;
  if (!getOwn(usersDoc.groups || {}, groupId)) return json({ error: "Unbekannte Gruppe" }, 404, corsHeaders);
  delete usersDoc.groups[groupId];

  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  // Verwaiste Gruppenreferenz aus sichtbarkeit.json entfernen (best effort,
  // die Gruppe selbst ist zu diesem Zeitpunkt bereits gelöscht)
  try {
    const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
    let changed = false;
    Object.values(config.tools || {}).forEach((entry) => {
      if (Array.isArray(entry.groupIds) && entry.groupIds.includes(groupId)) {
        entry.groupIds = entry.groupIds.filter((id) => id !== groupId);
        changed = true;
      }
      if (Array.isArray(entry.editGroupIds) && entry.editGroupIds.includes(groupId)) {
        entry.editGroupIds = entry.editGroupIds.filter((id) => id !== groupId);
        changed = true;
      }
      if (Array.isArray(entry.adminGroupIds) && entry.adminGroupIds.includes(groupId)) {
        entry.adminGroupIds = entry.adminGroupIds.filter((id) => id !== groupId);
        changed = true;
      }
      if (Array.isArray(entry.provisionGroupIds) && entry.provisionGroupIds.includes(groupId)) {
        entry.provisionGroupIds = entry.provisionGroupIds.filter((id) => id !== groupId);
        changed = true;
      }
    });
    if (changed) await writeJson(env.NEXTCLOUD_URL, authHeader, config);
  } catch (_) { /* Aufräumen ist best-effort */ }

  return json({ deleted: groupId }, 200, corsHeaders);
}

// ---------- Aktionen: Sichtbarkeit ----------

async function handleSaveVisibility(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  if (!body.tools || typeof body.tools !== "object") {
    return json({ error: "Ungültige Daten" }, 400, corsHeaders);
  }

  // Read-modify-write: bestehende Config lesen und nur tools ersetzen, damit
  // andere Schlüssel (z.B. news) durch ein Sichtbarkeits-Speichern nicht verloren gehen.
  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  config.version = 1;
  config.tools = body.tools;
  try {
    await writeJson(env.NEXTCLOUD_URL, authHeader, config);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  return json({ tools: config.tools }, 200, corsHeaders);
}

const NEWS_VALID_TYPES = ["neu", "update", "fix", "hinweis"];

// Feste Auswahl an Reaktions-Emojis unter jeder Neuigkeit. MUSS mit
// NEWS_REACTION_EMOJIS in config.js übereinstimmen — der Client rendert die Liste,
// der Worker validiert jeden eingehenden Klick strikt dagegen.
const NEWS_REACTION_EMOJIS = ["👍", "❤️", "🎉", "👏", "🔥", "😍", "😮", "😂", "🙏", "💪"];

// Aggregiert das Reaktions-Dokument zu reinen Zählern je Meldung+Emoji — OHNE
// Nutzernamen. Bleibt die Form für den ANONYMEN Kanal: wer reagiert hat, geht nur
// an Angemeldete (newsReactionNames, siehe unten und der GET-Handler).
function newsReactionCounts(doc) {
  const byNews = (doc && doc.byNews && typeof doc.byNews === "object") ? doc.byNews : {};
  const out = {};
  for (const newsId of Object.keys(byNews)) {
    const perUser = byNews[newsId];
    if (!perUser || typeof perUser !== "object") continue;
    const counts = {};
    for (const emoji of Object.values(perUser)) {
      if (NEWS_REACTION_EMOJIS.includes(emoji)) counts[emoji] = (counts[emoji] || 0) + 1;
    }
    if (Object.keys(counts).length) out[newsId] = counts;
  }
  return out;
}

// Dasselbe mit Klarnamen statt Zahlen: { newsId: { emoji: ["Max Muster", ...] } }.
// Seit 2026-08-01 (Michel-Vorgabe): beim Überfahren eines Reaktionsknopfes soll
// sichtbar sein, WER reagiert hat. Geht ausschließlich an Angemeldete — der
// GET-Handler ruft das nur im Zweig `angemeldet` auf, der anonyme Besucher bekommt
// weiterhin nur newsReactionCounts. Der Anzeigename wird aus der ohnehin geladenen
// nutzer.json aufgelöst und NICHT mitgespeichert (aufgabenAnzeigeName, bewusst
// wiederverwendet statt kopiert): sonst zeigte eine alte Reaktion nach einer
// Umbenennung weiter den früheren Namen. Sortiert, damit die Liste im Tooltip nicht
// bei jedem Laden anders herum steht (Objekt-Schlüsselreihenfolge ist Einfügereihenfolge).
function newsReactionNames(doc, usersDoc) {
  const byNews = (doc && doc.byNews && typeof doc.byNews === "object") ? doc.byNews : {};
  const out = {};
  for (const newsId of Object.keys(byNews)) {
    const perUser = byNews[newsId];
    if (!perUser || typeof perUser !== "object") continue;
    const namen = {};
    for (const username of Object.keys(perUser)) {
      const emoji = perUser[username];
      if (!NEWS_REACTION_EMOJIS.includes(emoji)) continue;
      if (!namen[emoji]) namen[emoji] = [];
      namen[emoji].push(aufgabenAnzeigeName(usersDoc, username));
    }
    for (const emoji of Object.keys(namen)) namen[emoji].sort((a, b) => a.localeCompare(b, "de"));
    if (Object.keys(namen).length) out[newsId] = namen;
  }
  return out;
}

// Jeder EINGELOGGTE Nutzer darf pro Meldung genau EINE Reaktion setzen. Erneut das
// gleiche Emoji => entfernt (Toggle), ein anderes => wechselt. Der Nutzername kommt
// aus der verifizierten Session (fälschungssicher, analog handleSubmitFeedback). Über
// If-Match + Retry, damit zwei gleichzeitige Klicks verschiedener Nutzer sich nicht
// gegenseitig überschreiben (kein Lost Update wie bei reinem LWW).
async function handleToggleNewsReaction(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const newsId = String((body && body.newsId) || "").trim();
  if (!/^[a-z0-9-]{1,40}$/i.test(newsId)) return json({ error: "Ungültige Meldung" }, 400, corsHeaders);
  const emoji = String((body && body.emoji) || "");
  if (!NEWS_REACTION_EMOJIS.includes(emoji)) return json({ error: "Ungültiges Emoji" }, 400, corsHeaders);

  const username = session.username;
  let saved = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: doc, rev } = await readJsonWithRev(NEWS_REACTIONS_URL, authHeader, { version: 1, byNews: {} });
    doc.version = doc.version || 1;
    if (!doc.byNews || typeof doc.byNews !== "object") doc.byNews = {};
    const perUser = (doc.byNews[newsId] && typeof doc.byNews[newsId] === "object") ? doc.byNews[newsId] : {};
    if (perUser[username] === emoji) delete perUser[username]; // gleiches Emoji -> Toggle aus
    else perUser[username] = emoji;                            // setzen bzw. auf anderes wechseln
    if (Object.keys(perUser).length) doc.byNews[newsId] = perUser;
    else delete doc.byNews[newsId]; // letzte Reaktion weg -> Meldungs-Eintrag ganz entfernen
    try {
      await writeJson(NEWS_REACTIONS_URL, authHeader, doc, rev || undefined);
      saved = doc;
      break;
    } catch (e) {
      if (e instanceof ConflictError && attempt < 2) continue; // paralleler Klick -> neu lesen und erneut versuchen
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  if (!saved) return json({ error: "Reaktion konnte nicht gespeichert werden" }, 502, corsHeaders);
  const counts = newsReactionCounts(saved)[newsId] || {};
  const mine = (saved.byNews[newsId] && saved.byNews[newsId][username]) || null;
  // namen additiv (seit 2026-08-01): der Client hat die Zähler nach dem Klick sofort
  // maßgeblich, die Namensliste im Tooltip liefe sonst bis zum nächsten Seitenaufruf
  // hinterher. usersDoc steckt bereits in der Session — kein zusätzlicher Read.
  const namen = newsReactionNames(saved, session.usersDoc)[newsId] || {};
  return json({ newsId, counts, mine, namen }, 200, corsHeaders);
}

// Liefert dem eingeloggten Nutzer NUR seine eigenen Reaktionen (newsId -> Emoji),
// damit der Client die eigene Wahl im Karussell hervorheben kann. Nie fremde Einträge.
async function handleMyNewsReactions(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const doc = await readJson(NEWS_REACTIONS_URL, authHeader, { version: 1, byNews: {} });
  const byNews = (doc && doc.byNews && typeof doc.byNews === "object") ? doc.byNews : {};
  const mine = {};
  for (const newsId of Object.keys(byNews)) {
    const emoji = byNews[newsId] && byNews[newsId][session.username];
    if (NEWS_REACTION_EMOJIS.includes(emoji)) mine[newsId] = emoji;
  }
  return json({ mine }, 200, corsHeaders);
}

// ---------- Aktionen: persönliche Ansicht der Startseite ----------

// Prüft und säubert, was der Client als Reihenfolge schickt. Es entsteht IMMER ein
// frisches Objekt aus geprüften Einzelteilen — nichts aus dem Körper wird als Ganzes
// übernommen. Unbekannte Tool-Ids bleiben absichtlich erhalten (ein Werkzeug kann
// vorübergehend unsichtbar sein, ohne dass der Nutzer seine Sortierung verliert);
// applyCustomOrder im Client ignoriert sie folgenlos.
function ansichtReihenfolgeSaeubern(roh) {
  const sauber = {};
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) return sauber;
  let kategorien = 0;
  for (const kategorie of Object.keys(roh)) {
    if (kategorie === "__proto__" || !kategorie || kategorie.length > 60) continue;
    if (++kategorien > ANSICHT_MAX_KATEGORIEN) break;
    const ids = Array.isArray(roh[kategorie]) ? roh[kategorie] : [];
    const gesehen = new Set();
    const liste = [];
    for (const roheId of ids) {
      const id = String(roheId || "");
      if (!/^[a-z0-9_-]{1,40}$/i.test(id) || gesehen.has(id)) continue;
      gesehen.add(id);
      liste.push(id);
      if (liste.length >= ANSICHT_MAX_IDS_PRO_KATEGORIE) break;
    }
    if (liste.length) sauber[kategorie] = liste;
  }
  return sauber;
}

function leeresAnsichtDoc() {
  return { version: 1, byUser: {} };
}

// Liefert NUR den eigenen Eintrag. Fremde Ansichten verlassen den Worker nie — sie
// gehen niemanden etwas an und wären zugleich eine Liste, wer welches Werkzeug oben
// stehen hat.
async function handleMeineAnsicht(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const doc = await readJson(ANSICHT_URL, authHeader, leeresAnsichtDoc());
  const byUser = (doc && doc.byUser && typeof doc.byUser === "object") ? doc.byUser : {};
  const eigen = Object.prototype.hasOwnProperty.call(byUser, session.username) ? byUser[session.username] : null;
  const modus = (eigen && ANSICHT_MODI.includes(eigen.modus)) ? eigen.modus : "kacheln";
  const reihenfolge = ansichtReihenfolgeSaeubern(eigen && eigen.reihenfolge);
  // ⚠️ Der Zaehler fuers rote Abzeichen liegt HIER und nicht bei den Unterlagen
  // selbst. Grund: `ansicht.json` wird beim Seitenaufbau ohnehin gelesen
  // (`ladeAnsicht` im selben Promise.all wie die Sitzungspruefung), waehrend
  // `unterlagen.json` nur beim Oeffnen des Konto-Tabs geholt wird. Ein Abzeichen,
  // das seine Zahl aus den Unterlagen zoege, kostete einen zweiten Nextcloud-Read
  // bei JEDEM Aufruf der Startseite -- genau daran ist das Abzeichen am Ideen-Tab
  // gescheitert. Hochgezaehlt wird beim Verteilen (siehe unterlagenZaehlerErhoehen).
  const unterlagenNeu = Number.isFinite(eigen && eigen.unterlagenNeu) ? Math.max(0, eigen.unterlagenNeu) : 0;
  return json({ ansicht: { modus, reihenfolge, unterlagenNeu } }, 200, corsHeaders);
}

// Merkt sich, dass der Downloadbereich im Konto-Tab gerade offen war -- danach ist
// das rote Abzeichen weg, bis wieder etwas dazukommt.
//
// ⚠️ Eigene schmale Aktion statt eines Feldes in meine-ansicht-speichern: dort
// haengen Anzeige-Vorlieben, die der Nutzer bewusst setzt. Das Oeffnen einer Karte
// ist etwas anderes und darf nicht Modus und Reihenfolge mitschreiben (der Aufruf
// dort schickt beide immer mit und wuerde sie beim blossen Hinschauen ueberschreiben).
async function handleDownloadsGesehen(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const username = session.username;
  if (username === "__proto__") return json({ error: "Ungültiger Nutzer" }, 400, corsHeaders);

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(ANSICHT_URL, authHeader, leeresAnsichtDoc());
    doc.version = doc.version || 1;
    if (!doc.byUser || typeof doc.byUser !== "object") doc.byUser = {};
    const bisher = (Object.prototype.hasOwnProperty.call(doc.byUser, username) && typeof doc.byUser[username] === "object")
      ? doc.byUser[username] : {};
    doc.byUser[username] = { ...bisher, unterlagenNeu: 0 };
    try {
      await writeJson(ANSICHT_URL, authHeader, doc, rev || undefined);
      return json({ ok: true }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Konnte nicht gespeichert werden" }, 502, corsHeaders);
}

// Zaehlt beim Verteilen bei jedem Empfaenger hoch. Eigene Funktion, weil sie aus
// dem Unterlagen-Block am Dateiende gerufen wird und `ansicht.json` sonst nur
// diese beiden Handler anfassen.
//
// ⚠️ Fehler werden GESCHLUCKT: die Unterlage ist zu dem Zeitpunkt schon abgelegt.
// Ein fehlendes Abzeichen ist ein kleineres Uebel als ein Verteilvorgang, der
// wegen einer Anzeige-Notiz scheitert.
async function unterlagenZaehlerErhoehen(authHeader, empfaenger) {
  const namen = (Array.isArray(empfaenger) ? empfaenger : []).map((n) => normalizeUsername(String(n || "")))
    .filter((n) => n && n !== "__proto__");
  if (!namen.length) return;
  for (let versuch = 0; versuch < 3; versuch++) {
    try {
      const { data: doc, rev } = await readJsonWithRev(ANSICHT_URL, authHeader, leeresAnsichtDoc());
      doc.version = doc.version || 1;
      if (!doc.byUser || typeof doc.byUser !== "object") doc.byUser = {};
      for (const n of namen) {
        const bisher = (Object.prototype.hasOwnProperty.call(doc.byUser, n) && typeof doc.byUser[n] === "object")
          ? doc.byUser[n] : {};
        const alt = Number.isFinite(bisher.unterlagenNeu) ? Math.max(0, bisher.unterlagenNeu) : 0;
        doc.byUser[n] = { ...bisher, unterlagenNeu: Math.min(99, alt + 1) };
      }
      await writeJson(ANSICHT_URL, authHeader, doc, rev || undefined);
      return;
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return;
    }
  }
}

// Schreibt ausschließlich den eigenen Eintrag. Der Nutzername kommt aus der Sitzung,
// nie aus dem Körper — sonst schriebe jeder Angemeldete jedem anderen die Startseite um.
// Wiederholversuch bei Konflikt wie bei toggle-news-reaction: zwei Geräte desselben
// Nutzers (oder zwei Nutzer gleichzeitig) schreiben dieselbe Datei.
async function handleMeineAnsichtSpeichern(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const modus = String((body && body.modus) || "");
  if (!ANSICHT_MODI.includes(modus)) return json({ error: "Unbekannte Ansicht" }, 400, corsHeaders);
  const reihenfolge = ansichtReihenfolgeSaeubern(body && body.reihenfolge);

  const username = session.username;
  // "__proto__" als Nutzername ist über USERNAME_RE ohnehin ausgeschlossen; die Prüfung
  // steht hier, weil der Wert direkt als Objekt-Schlüssel dient (Muster wie bei create-user).
  if (username === "__proto__") return json({ error: "Ungültiger Nutzer" }, 400, corsHeaders);

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(ANSICHT_URL, authHeader, leeresAnsichtDoc());
    doc.version = doc.version || 1;
    if (!doc.byUser || typeof doc.byUser !== "object") doc.byUser = {};
    // ⚠️ Bestehende Felder erhalten statt den Eintrag zu ersetzen: seit dem
    // Downloadbereich steht hier auch downloadsGesehenAm, und ein Umschalten von
    // Kacheln auf Liste darf das rote Abzeichen nicht zurueckholen.
    const bisher = (Object.prototype.hasOwnProperty.call(doc.byUser, username) && typeof doc.byUser[username] === "object")
      ? doc.byUser[username] : {};
    doc.byUser[username] = { ...bisher, modus, reihenfolge, gespeichertAm: new Date().toISOString() };
    try {
      await writeJson(ANSICHT_URL, authHeader, doc, rev || undefined);
      return json({ ok: true, ansicht: { modus, reihenfolge } }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Ansicht konnte nicht gespeichert werden" }, 502, corsHeaders);
}

// ---------- Aktionen: Materialcontainer-Code ----------

// Der Zahlencode des Schlosses am Materialcontainer. Bewusst eine EIGENE, schmale
// Aktion statt eines Feldes in "me" oder im öffentlichen Config-GET: der Code
// öffnet ein echtes Schloss vor Ort, er soll nur dort über die Leitung gehen, wo
// ihn jemand ausdrücklich sehen will (siehe auch die Trennung bei
// dav-restricted-*). Aus demselben Grund steht er NICHT im GET, den jeder
// unangemeldete Besucher der Landingpage abruft.
//
// Sichtbar für eingeloggtes Personal, NICHT für Spielerkonten: "keine Gruppe =
// alle eingeloggten" gilt für Spieler nirgends in diesem Worker, und bei ~200
// Spielerkonten wäre ein Containercode für alle das Gegenteil eines Schlosses.
async function handleGetMaterialcontainerCode(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (session.art === USER_ART_SPIELER) {
    return json({ error: "Kein Zugriff auf den Materialcontainer-Code" }, 403, corsHeaders);
  }
  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  const mc = (config.materialcontainer && typeof config.materialcontainer === "object")
    ? config.materialcontainer : {};
  return json({
    code: typeof mc.code === "string" ? mc.code : "",
    hinweis: typeof mc.hinweis === "string" ? mc.hinweis : "",
    geaendertAm: mc.geaendertAm || null,
    geaendertVon: mc.geaendertVon || null
  }, 200, corsHeaders);
}

// Admin setzt den Code (einmal im Monat von Hand). Read-modify-write wie
// handleSaveVisibility, damit tools/news nicht verloren gehen. Ein leerer Code
// ist erlaubt und heißt "noch keiner hinterlegt" -- so lässt sich der Eintrag
// auch wieder leeren, ohne dass ein alter Code stehen bleibt.
async function handleSetMaterialcontainerCode(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const code = String(body.code == null ? "" : body.code).trim().slice(0, 60);
  const hinweis = String(body.hinweis == null ? "" : body.hinweis).trim().slice(0, 200);

  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  config.version = config.version || 1;
  config.materialcontainer = {
    code,
    hinweis,
    geaendertAm: new Date().toISOString(),
    geaendertVon: session.username
  };
  try {
    await writeJson(env.NEXTCLOUD_URL, authHeader, config);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }
  return json({ ok: true, ...config.materialcontainer }, 200, corsHeaders);
}

// ---------- Aktion: Linksammlung (seit 2026-08-14) ----------
//
// Eine gepflegte Liste von Adressen fremder Webseiten, die auf der Startseite
// unter den Kacheln steht. Ablage im links-Key von sichtbarkeit.json -- dieselbe
// Ueberlegung wie beim materialcontainer-Key: die Datei wird beim GET ohnehin
// gelesen, die Liste kostet damit KEINEN zusaetzlichen Nextcloud-Read. Sie ist
// klein und aendert sich selten; fuer etwas Wachsendes waere eine eigene Datei
// richtig (siehe die Begruendung bei den Neuigkeiten-Medien).
const LINKS_MAX = 40;
const LINKS_MAX_TITEL = 80;
const LINKS_MAX_URL = 500;
const LINKS_MAX_BESCHREIBUNG = 200;
const LINKS_MAX_ICON = 8;

// Normiert die gespeicherte Liste in EINE verlaessliche Form. Wird beim Lesen
// (GET) und beim Schreiben (save-links) benutzt, damit beide Seiten dasselbe
// sehen -- ein von Hand in Nextcloud editierter Eintrag kann sonst eine Form
// ausliefern, die der Client nicht erwartet.
//
// ⚠️ Die URL wird strikt gegen http/https geprueft. Ohne das koennte ein
// manipulierter Client `javascript:...` eintragen, und der Link stuende danach
// als anklickbares Element auf der oeffentlichen Startseite -- fuer jeden
// Besucher, auch ohne Konto. Ein Eintrag ohne gueltige URL faellt ganz weg
// statt als toter Link stehenzubleiben.
function linksNormieren(rohe) {
  if (!Array.isArray(rohe)) return [];
  const clean = [];
  for (const l of rohe.slice(0, LINKS_MAX)) {
    if (!l || typeof l !== "object") continue;
    const titel = String(l.titel == null ? "" : l.titel).trim().slice(0, LINKS_MAX_TITEL);
    const url = String(l.url == null ? "" : l.url).trim().slice(0, LINKS_MAX_URL);
    if (!titel) continue;
    if (!/^https?:\/\/[^\s]+$/i.test(url)) continue;
    const eintrag = {
      id: /^[a-z0-9-]{1,40}$/i.test(String(l.id || "")) ? String(l.id) : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
      titel,
      url
    };
    const beschreibung = String(l.beschreibung == null ? "" : l.beschreibung).trim().slice(0, LINKS_MAX_BESCHREIBUNG);
    if (beschreibung) eintrag.beschreibung = beschreibung;
    // Das Symbol ist frei getippt (ein Emoji). Nur gelaengt, nicht gegen eine
    // Liste geprueft: es wird im Client escaped und ist reine Zierde.
    const icon = String(l.icon == null ? "" : l.icon).trim().slice(0, LINKS_MAX_ICON);
    if (icon) eintrag.icon = icon;
    clean.push(eintrag);
  }
  return clean;
}

// Admin speichert die ganze Liste. Read-modify-write wie handleSaveNews und
// handleSetMaterialcontainerCode, damit tools/news/materialcontainer erhalten
// bleiben. Ein leeres Array ist erlaubt und heisst "keine Links" -- so laesst
// sich der Bereich auch wieder ganz abschalten.
async function handleSaveLinks(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  if (!Array.isArray(body.links)) {
    return json({ error: "Ungültige Daten" }, 400, corsHeaders);
  }

  const clean = linksNormieren(body.links);

  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  config.version = config.version || 1;
  config.links = clean;
  try {
    await writeJson(env.NEXTCLOUD_URL, authHeader, config);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  return json({ links: config.links }, 200, corsHeaders);
}

// ---------- Aktionen: Persönliche Aufgaben ----------

// Jede Aufgaben-Aktion verlangt eingeloggtes PERSONAL. Spielerkonten bekommen 403
// wie beim Materialcontainer-Code: der Default „keine Gruppe = alle eingeloggten"
// gilt für sie nirgends in diesem Worker, und ~200 Spielerkonten, die einander und
// dem Trainerteam Einträge in die Liste legen könnten, sind kein Feature.
async function aufgabenSession(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return { fehler: json({ error: "Nicht angemeldet" }, 401, corsHeaders) };
  if (session.art === USER_ART_SPIELER) {
    return { fehler: json({ error: "Kein Zugriff auf die Aufgaben" }, 403, corsHeaders) };
  }
  return { session, fehler: null };
}

// Wer darf anderen etwas in die Liste legen? Anders als bei der Tool-Sichtbarkeit
// heißt eine LEERE Gruppenliste hier bewusst NIEMAND statt „alle eingeloggten".
// Zuweisen ist ein Schreibzugriff in fremde Listen — der Zustand „noch nichts
// konfiguriert" muss in die geschlossene Richtung fallen, nicht in die offene.
function darfAufgabenZuweisen(session, config) {
  if (session.isAdmin) return true;
  const cfg = (config && config.aufgaben && typeof config.aufgaben === "object") ? config.aufgaben : {};
  const erlaubt = Array.isArray(cfg.assignGroupIds) ? cfg.assignGroupIds : [];
  return erlaubt.some((g) => session.groupIds.includes(g));
}

// Zweite, engere Stufe: wer eine Unterschrift einfordern darf. Bewusst NICHT an
// assignGroupIds gekoppelt — „Trikots zählen" zuweisen und „unterschreib diesen
// Vertrag" verlangen sind verschiedene Dinge. Leer heißt auch hier NIEMAND, aus
// demselben Grund wie oben: der unkonfigurierte Zustand fällt zu.
function darfDokumenteZuweisen(session, config) {
  if (session.isAdmin) return true;
  const cfg = (config && config.aufgaben && typeof config.aufgaben === "object") ? config.aufgaben : {};
  const erlaubt = Array.isArray(cfg.dokumentGroupIds) ? cfg.dokumentGroupIds : [];
  return erlaubt.some((g) => session.groupIds.includes(g));
}

// Wer ein Dokument sehen/herunterladen darf: die beiden Beteiligten, plus globale
// Admins als Rückfallebene — ohne die käme an einen Vertrag niemand mehr heran,
// sobald das Absenderkonto gelöscht oder archiviert wird. Bewusst unabhängig von
// jeder Tool-Sichtbarkeit: ein Personalkonto zu haben reicht hier nicht.
function istDokumentBeteiligt(session, dok) {
  if (!dok) return false;
  if (session.isAdmin) return true;
  return dok.von === session.username || dok.empfaenger === session.username;
}

function dokumenteById(doc) {
  return (doc && doc.byId && typeof doc.byId === "object") ? doc.byId : {};
}

function dokumentHolen(doc, id) {
  return getOwn(dokumenteById(doc), String(id || "")) || null;
}

function aufgabenListe(doc, username) {
  const liste = doc && doc.byUser ? getOwn(doc.byUser, username) : undefined;
  return Array.isArray(liste) ? liste : [];
}

// Anzeigename aus der ohnehin geladenen nutzer.json — der Name wird bewusst NICHT
// in der Aufgabe gespeichert, sonst zeigt ein alter Eintrag nach einer Umbenennung
// weiter den früheren Namen.
function aufgabenAnzeigeName(usersDoc, username) {
  const u = getOwn((usersDoc && usersDoc.users) || {}, username);
  if (!u) return username;
  return (u.vorname && u.nachname) ? `${u.vorname} ${u.nachname}` : (u.username || username);
}

function aufgabenDatum(roh) {
  const s = capStr(roh, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

// Zwei Sorten Altlast, beide mit Frist: eine erledigte Zuweisung muss stehen
// bleiben, bis der Zuweiser sie in seiner Rückansicht gesehen haben kann (der
// Aufräumen-Knopf des Empfängers lässt sie deshalb bewusst stehen), ein
// zurückgezogener Eintrag ist nur noch ein Hinweis und darf früher weg.
function aufgabeIstAbgelaufen(a, jetzt) {
  const aelterAls = (iso, tage) => {
    const t = Date.parse(iso || "");
    return Number.isFinite(t) && (jetzt - t) > tage * 86400000;
  };
  if (a.zurueckgezogenAm && aelterAls(a.zurueckgezogenAm, AUFGABEN_ZURUECKGEZOGEN_TAGE)) return true;
  if (a.von && a.erledigt && aelterAls(a.erledigtAm, AUFGABEN_ZUGEWIESEN_ERLEDIGT_TAGE)) return true;
  return false;
}

// Läuft in jedem schreibenden Handler über ALLE Listen, nicht nur die des
// Schreibenden: die Datei wird ohnehin als Ganzes geschrieben, und so bleibt
// nichts bei jemandem liegen, der sich lange nicht anmeldet.
function aufgabenPrune(doc) {
  const jetzt = Date.now();
  for (const username of Object.keys(doc.byUser || {})) {
    const liste = aufgabenListe(doc, username);
    const behalten = liste.filter((a) => !aufgabeIstAbgelaufen(a, jetzt));
    if (behalten.length) doc.byUser[username] = behalten;
    else delete doc.byUser[username];
  }
}

// Eigene Liste + was ich anderen gegeben habe + ob ich überhaupt zuweisen darf.
async function handleAufgabenLoad(request, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  // Beide Reads parallel: die Aufgaben selbst und die Konfiguration (wer zuweisen
  // darf). Nacheinander wären das zwei Nextcloud-Roundtrips à 200–450 ms.
  const [doc, config] = await Promise.all([
    readJson(AUFGABEN_URL, authHeader, { version: 1, byUser: {} }),
    readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} })
  ]);

  const jetzt = Date.now();
  const meine = aufgabenListe(doc, session.username)
    .filter((a) => !aufgabeIstAbgelaufen(a, jetzt))
    .map((a) => ({ ...a, vonName: a.von ? aufgabenAnzeigeName(session.usersDoc, a.von) : "" }));

  // Rückkanal: streng auf die von MIR erzeugten Einträge gefiltert. Die übrige
  // Liste des Empfängers verlässt den Worker nie — das ist der ganze Unterschied
  // zwischen „ich sehe meine Zuweisung" und „ich sehe fremde Aufgaben".
  const zugewiesenVonMir = [];
  for (const empfaenger of Object.keys(doc.byUser || {})) {
    if (empfaenger === session.username) continue;
    for (const a of aufgabenListe(doc, empfaenger)) {
      if (a.von !== session.username || aufgabeIstAbgelaufen(a, jetzt)) continue;
      zugewiesenVonMir.push({
        id: a.id,
        text: a.text,
        faellig: a.faellig || "",
        erledigt: !!a.erledigt,
        erledigtAm: a.erledigtAm || null,
        gesehenAm: a.gesehenAm || null,
        zurueckgezogenAm: a.zurueckgezogenAm || null,
        // Damit die Rückansicht eine Unterschriftsaufgabe als solche zeigt und
        // nicht das Zurückziehen anbietet -- die gehört in den Dokumente-Tab.
        dokId: a.dokId || null,
        empfaenger,
        empfaengerName: aufgabenAnzeigeName(session.usersDoc, empfaenger)
      });
    }
  }

  const antwort = {
    meine,
    zugewiesenVonMir,
    canAssign: darfAufgabenZuweisen(session, config),
    // Kommt hier gratis mit, weil sichtbarkeit.json ohnehin gelesen ist: der
    // Zuweisen-Dialog braucht es, um den Dokument-Abschnitt zu zeigen, und muss
    // dafür nicht erst dokumente-load abwarten.
    canAssignDocs: darfDokumenteZuweisen(session, config)
  };
  // Für das Admin-Panel: die konfigurierten Gruppen kommen additiv mit, weil
  // sichtbarkeit.json hier ohnehin schon gelesen ist (kein zweiter Request nötig).
  if (session.isAdmin) {
    const cfg = (config.aufgaben && typeof config.aufgaben === "object") ? config.aufgaben : {};
    antwort.assignGroupIds = Array.isArray(cfg.assignGroupIds) ? cfg.assignGroupIds : [];
    antwort.dokumentGroupIds = Array.isArray(cfg.dokumentGroupIds) ? cfg.dokumentGroupIds : [];
  }
  return json(antwort, 200, corsHeaders);
}

// Anlegen und Ändern in der EIGENEN Liste. Der Nutzername kommt aus der Session,
// nie aus dem Body. Bei einer ZUGEWIESENEN Aufgabe darf nur der Haken gesetzt
// werden: Text und Fälligkeit gehören dem Zuweiser, sonst könnte der Empfänger
// den Auftrag umschreiben und ihn danach „erledigen".
async function handleAufgabeSpeichern(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const id = capStr(body && body.id, 64);
  const textGesetzt = !!(body && body.text != null);
  const faelligGesetzt = !!(body && body.faellig != null);
  const text = capStr(body && body.text, AUFGABEN_MAX_TEXT);
  const faellig = aufgabenDatum(body && body.faellig);
  const erledigt = (body && body.erledigt != null) ? !!body.erledigt : null;
  if (!id && !text) return json({ error: "Text fehlt" }, 400, corsHeaders);

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(AUFGABEN_URL, authHeader, { version: 1, byUser: {} });
    doc.version = doc.version || 1;
    if (!doc.byUser || typeof doc.byUser !== "object") doc.byUser = {};
    const liste = aufgabenListe(doc, session.username).slice();

    let eintrag;
    if (id) {
      eintrag = liste.find((a) => a && a.id === id);
      if (!eintrag) return json({ error: "Unbekannte Aufgabe" }, 404, corsHeaders);
      if (eintrag.von && (textGesetzt || faelligGesetzt)) {
        return json({ error: "Zugewiesene Aufgaben lassen sich nur abhaken" }, 403, corsHeaders);
      }
      // Eine Aufgabe mit Dokument wird ausschließlich durch die geleistete
      // Unterschrift (oder eine begründete Ablehnung) erledigt. Wäre der Haken
      // frei, könnte der Empfänger „erledigt" melden, ohne je unterschrieben zu
      // haben — und der Absender wartet auf ein Dokument, das nie kommt.
      if (eintrag.dokId && erledigt !== null) {
        return json({ error: "Diese Aufgabe wird durch die Unterschrift erledigt" }, 403, corsHeaders);
      }
      if (textGesetzt) {
        if (!text) return json({ error: "Text fehlt" }, 400, corsHeaders);
        eintrag.text = text;
      }
      if (faelligGesetzt) eintrag.faellig = faellig;
      if (erledigt !== null) {
        eintrag.erledigt = erledigt;
        eintrag.erledigtAm = erledigt ? new Date().toISOString() : null;
      }
    } else {
      if (liste.length >= AUFGABEN_MAX_PRO_NUTZER) {
        return json({ error: `Deine Liste ist voll (${AUFGABEN_MAX_PRO_NUTZER} Aufgaben). Bitte erledigte aufräumen.` }, 400, corsHeaders);
      }
      eintrag = {
        id: crypto.randomUUID(),
        text,
        faellig,
        erledigt: false,
        erledigtAm: null,
        erstelltAm: new Date().toISOString(),
        von: "",
        zugewiesenAm: null,
        gesehenAm: null
      };
      liste.push(eintrag);
    }

    doc.byUser[session.username] = liste;
    aufgabenPrune(doc);
    try {
      await writeJson(AUFGABEN_URL, authHeader, doc, rev || undefined);
      return json({ ok: true, aufgabe: eintrag }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue; // paralleles Gerät -> neu lesen
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Aufgabe konnte nicht gespeichert werden" }, 502, corsHeaders);
}

// Löschen nur für selbst angelegte Einträge. Eine zugewiesene Aufgabe lässt sich
// nicht wegklicken — sonst wäre „zuweisen" wirkungslos. Ausnahme: ein
// zurückgezogener Eintrag ist nur noch ein Hinweis, den darf der Empfänger weg.
async function handleAufgabeLoeschen(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const id = capStr(body && body.id, 64);
  if (!id) return json({ error: "Aufgabe fehlt" }, 400, corsHeaders);

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(AUFGABEN_URL, authHeader, { version: 1, byUser: {} });
    doc.version = doc.version || 1;
    if (!doc.byUser || typeof doc.byUser !== "object") doc.byUser = {};
    const liste = aufgabenListe(doc, session.username);
    const eintrag = liste.find((a) => a && a.id === id);
    if (!eintrag) return json({ error: "Unbekannte Aufgabe" }, 404, corsHeaders);
    if (eintrag.von && !eintrag.zurueckgezogenAm) {
      return json({ error: "Zugewiesene Aufgaben lassen sich nur abhaken" }, 403, corsHeaders);
    }
    doc.byUser[session.username] = liste.filter((a) => a !== eintrag);
    aufgabenPrune(doc);
    try {
      await writeJson(AUFGABEN_URL, authHeader, doc, rev || undefined);
      return json({ ok: true, id }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Aufgabe konnte nicht gelöscht werden" }, 502, corsHeaders);
}

// Erledigte wegräumen. Zugewiesene Erledigte bleiben bewusst stehen (Frist in
// aufgabeIstAbgelaufen), sonst ist die Rückansicht des Zuweisers leer, bevor er
// hingeschaut hat. Zurückgezogene Hinweise verschwinden hier mit.
async function handleAufgabenAufraeumen(request, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(AUFGABEN_URL, authHeader, { version: 1, byUser: {} });
    doc.version = doc.version || 1;
    if (!doc.byUser || typeof doc.byUser !== "object") doc.byUser = {};
    const liste = aufgabenListe(doc, session.username);
    const behalten = liste.filter((a) => {
      if (a.zurueckgezogenAm) return false;
      if (!a.erledigt) return true;
      return !!a.von; // erledigte Zuweisung bleibt für den Rückkanal stehen
    });
    const entfernt = liste.length - behalten.length;
    if (behalten.length) doc.byUser[session.username] = behalten;
    else delete doc.byUser[session.username];
    aufgabenPrune(doc);
    try {
      await writeJson(AUFGABEN_URL, authHeader, doc, rev || undefined);
      return json({ ok: true, entfernt }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Aufräumen fehlgeschlagen" }, 502, corsHeaders);
}

// Aufgabe an mehrere Personen verteilen — jeder bekommt eine eigene Kopie mit
// eigener Id und hakt für sich ab. Bewusst KEIN gemeinsamer Eintrag: sonst wäre
// „erledigt" eine Sammelaussage, und das Abhaken des einen träfe alle anderen.
async function handleAufgabeZuweisen(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  if (!darfAufgabenZuweisen(session, config)) {
    return json({ error: "Keine Berechtigung, Aufgaben zuzuweisen" }, 403, corsHeaders);
  }

  const text = capStr(body && body.text, AUFGABEN_MAX_TEXT);
  if (!text) return json({ error: "Text fehlt" }, 400, corsHeaders);
  const faellig = aufgabenDatum(body && body.faellig);

  const roh = Array.isArray(body && body.empfaenger) ? body.empfaenger : [];
  if (!roh.length) return json({ error: "Kein Empfänger gewählt" }, 400, corsHeaders);
  if (roh.length > AUFGABEN_MAX_EMPFAENGER) {
    return json({ error: `Höchstens ${AUFGABEN_MAX_EMPFAENGER} Empfänger auf einmal` }, 400, corsHeaders);
  }
  // Empfänger müssen existieren UND Personal sein — dieselbe Regel wie im Picker
  // (list-directory), hier aber serverseitig noch einmal geprüft: der Client ist
  // beim Ziel eines Schreibvorgangs in eine fremde Liste keine Instanz.
  const empfaenger = [];
  for (const r of roh) {
    const u = normalizeUsername(r);
    const user = getOwn((session.usersDoc && session.usersDoc.users) || {}, u);
    if (!user || !istPersonal(user)) return json({ error: "Unbekannter Empfänger: " + u }, 400, corsHeaders);
    if (!empfaenger.includes(u)) empfaenger.push(u);
  }

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(AUFGABEN_URL, authHeader, { version: 1, byUser: {} });
    doc.version = doc.version || 1;
    if (!doc.byUser || typeof doc.byUser !== "object") doc.byUser = {};

    const jetztIso = new Date().toISOString();
    const zugewiesen = [];
    const uebersprungen = [];
    for (const u of empfaenger) {
      const liste = aufgabenListe(doc, u).slice();
      if (liste.length >= AUFGABEN_MAX_PRO_NUTZER) { uebersprungen.push(u); continue; }
      liste.push({
        id: crypto.randomUUID(),
        text,
        faellig,
        erledigt: false,
        erledigtAm: null,
        erstelltAm: jetztIso,
        von: session.username,
        zugewiesenAm: jetztIso,
        gesehenAm: null
      });
      doc.byUser[u] = liste;
      zugewiesen.push(u);
    }
    if (!zugewiesen.length) {
      return json({ error: "Die Liste aller gewählten Empfänger ist voll" }, 400, corsHeaders);
    }

    aufgabenPrune(doc);
    try {
      await writeJson(AUFGABEN_URL, authHeader, doc, rev || undefined);
      return json({ ok: true, zugewiesen, uebersprungen }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Zuweisen fehlgeschlagen" }, 502, corsHeaders);
}

// Der Zuweiser nimmt eine Aufgabe zurück. Sie verschwindet nicht spurlos: der
// Eintrag bleibt beim Empfänger als durchgestrichener Hinweis stehen, bis er ihn
// wegklickt (oder die Frist abläuft) — wer schon angefangen hatte, soll sehen,
// warum die Aufgabe weg ist. Nur solange sie offen ist; Erledigtes bleibt.
async function handleAufgabeZurueckziehen(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const id = capStr(body && body.id, 64);
  const empfaenger = normalizeUsername(body && body.empfaenger);
  if (!id || !empfaenger) return json({ error: "Aufgabe oder Empfänger fehlt" }, 400, corsHeaders);

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(AUFGABEN_URL, authHeader, { version: 1, byUser: {} });
    doc.version = doc.version || 1;
    if (!doc.byUser || typeof doc.byUser !== "object") doc.byUser = {};
    const eintrag = aufgabenListe(doc, empfaenger).find((a) => a && a.id === id);
    // Nur die eigene Zuweisung — der Nutzername kommt aus der Session.
    if (!eintrag || eintrag.von !== session.username) {
      return json({ error: "Unbekannte Zuweisung" }, 404, corsHeaders);
    }
    if (eintrag.erledigt) return json({ error: "Erledigte Aufgaben lassen sich nicht zurückziehen" }, 400, corsHeaders);
    if (eintrag.zurueckgezogenAm) return json({ ok: true, id, empfaenger }, 200, corsHeaders);

    eintrag.zurueckgezogenVon = session.username;
    eintrag.zurueckgezogenAm = new Date().toISOString();
    aufgabenPrune(doc);
    try {
      await writeJson(AUFGABEN_URL, authHeader, doc, rev || undefined);
      return json({ ok: true, id, empfaenger }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Zurückziehen fehlgeschlagen" }, 502, corsHeaders);
}

// Der Zuweiser räumt seine Rückansicht auf. Ohne das wächst „Von mir zugewiesen"
// bis zum Ablauf der 14-Tage-Frist zu, und man sieht vor lauter Erledigtem nicht
// mehr, was noch offen ist.
//
// Zwei Formen in einer Aktion: mit id+empfaenger genau ein Eintrag, ohne beides
// alle abgeschlossenen auf einmal. Erfasst wird ausschließlich, was NICHT mehr
// offen ist — eine laufende Zuweisung soll man nicht versehentlich wegräumen,
// dafür gibt es das Zurückziehen.
//
// ⚠️ Ein daran hängendes Dokument wird NICHT angefasst: der Eintrag ist die
// Erinnerung, das unterschriebene PDF ist der Nachweis und lebt in dokumente.json
// weiter — genau die Trennung, wegen der die beiden Dateien getrennt sind.
async function handleZuweisungEntfernen(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const id = capStr(body && body.id, 64);
  const empfaenger = body && body.empfaenger ? normalizeUsername(body.empfaenger) : "";
  const einzeln = !!(id && empfaenger);

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(AUFGABEN_URL, authHeader, { version: 1, byUser: {} });
    doc.version = doc.version || 1;
    if (!doc.byUser || typeof doc.byUser !== "object") doc.byUser = {};

    // Abgeschlossen heißt: erledigt ODER zurückgezogen. Beides ist ein Endzustand,
    // den der Zuweiser gesehen hat, wenn er hier klickt.
    const abgeschlossen = (a) => a && a.von === session.username && (a.erledigt || a.zurueckgezogenAm);
    let entfernt = 0;
    for (const u of Object.keys(doc.byUser)) {
      if (einzeln && u !== empfaenger) continue;
      const liste = aufgabenListe(doc, u);
      const behalten = liste.filter((a) => {
        if (!abgeschlossen(a)) return true;
        if (einzeln && a.id !== id) return true;
        entfernt++;
        return false;
      });
      if (behalten.length === liste.length) continue;
      if (behalten.length) doc.byUser[u] = behalten;
      else delete doc.byUser[u];
    }

    if (!entfernt) return json({ ok: true, entfernt: 0 }, 200, corsHeaders);

    aufgabenPrune(doc);
    try {
      await writeJson(AUFGABEN_URL, authHeader, doc, rev || undefined);
      return json({ ok: true, entfernt }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Aufräumen fehlgeschlagen" }, 502, corsHeaders);
}

// Markiert eigene Zuweisungen als gesehen (geräteübergreifend, Michel-Vorgabe —
// deshalb serverseitig statt im localStorage). Schreibt NUR, wenn sich wirklich
// etwas ändert: sonst löst jedes Aufklappen des Widgets einen Schreibvorgang aus.
async function handleAufgabenGesehen(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const ids = Array.isArray(body && body.ids) ? body.ids.slice(0, AUFGABEN_MAX_PRO_NUTZER).map((i) => capStr(i, 64)) : [];
  if (!ids.length) return json({ ok: true, markiert: 0 }, 200, corsHeaders);

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(AUFGABEN_URL, authHeader, { version: 1, byUser: {} });
    doc.version = doc.version || 1;
    if (!doc.byUser || typeof doc.byUser !== "object") doc.byUser = {};
    const jetztIso = new Date().toISOString();
    let markiert = 0;
    for (const a of aufgabenListe(doc, session.username)) {
      if (a && a.von && !a.gesehenAm && ids.includes(a.id)) { a.gesehenAm = jetztIso; markiert++; }
    }
    if (!markiert) return json({ ok: true, markiert: 0 }, 200, corsHeaders);

    try {
      await writeJson(AUFGABEN_URL, authHeader, doc, rev || undefined);
      return json({ ok: true, markiert }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Konnte nicht als gesehen markiert werden" }, 502, corsHeaders);
}

// ---------- Aktionen: zu unterschreibende Dokumente ----------
//
// Der Unterschied zum digitalen Stempel, und der ganze Zweck dieses Blocks:
// dort legt jeder Tool-Nutzer selbst ein Stempelbild an und setzt es auf ein
// beliebiges Dokument — die Unterschrift ist damit an niemanden gebunden. Hier
// entsteht sie in der eingeloggten Sitzung der unterzeichnenden Person, und der
// Server hält fest, wer wann unterschrieben hat.

// Position des Unterschriftsfelds als Seitenzahl + vier Fraktionen (0..1) der
// Seitengröße — bewusst nicht in Pixeln: der Absender setzt das Feld auf einer
// skalierten Vorschau, der Empfänger sieht eine andere Größe, und gerechnet wird
// am Ende gegen die echte PDF-Seite. Fehlt oder taugt das Feld nicht, wird daraus
// null und das Ergebnis bekommt eine Unterschriftsseite angehängt.
function dokumentFeld(roh) {
  if (!roh || typeof roh !== "object") return null;
  const seite = Number(roh.seite);
  if (!Number.isInteger(seite) || seite < 1 || seite > 2000) return null;
  const f = {};
  for (const k of ["x", "y", "w", "h"]) {
    const v = Number(roh[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1) return null;
    f[k] = v;
  }
  if (f.w <= 0 || f.h <= 0) return null;
  return { seite, x: f.x, y: f.y, w: f.w, h: f.h };
}

function dokumentOeffentlich(dok, usersDoc) {
  return {
    ...dok,
    vonName: aufgabenAnzeigeName(usersDoc, dok.von),
    empfaengerName: aufgabenAnzeigeName(usersDoc, dok.empfaenger)
  };
}

// Alles, woran ich beteiligt bin — in beide Richtungen getrennt. Der Client
// filtert daraus die Status; die Aufteilung nach Rolle muss dagegen hier
// passieren, denn sie entscheidet, was jemand überhaupt zu sehen bekommt.
async function handleDokumenteLoad(request, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const [doc, config] = await Promise.all([
    readJson(DOKUMENTE_URL, authHeader, { version: 1, byId: {} }),
    readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} })
  ]);

  const anMich = [];
  const vonMir = [];
  for (const dok of Object.values(dokumenteById(doc))) {
    if (!dok || typeof dok !== "object") continue;
    if (dok.empfaenger === session.username) anMich.push(dokumentOeffentlich(dok, session.usersDoc));
    if (dok.von === session.username) vonMir.push(dokumentOeffentlich(dok, session.usersDoc));
  }
  const nachDatum = (a, b) => String(b.erstelltAm || "").localeCompare(String(a.erstelltAm || ""));
  anMich.sort(nachDatum);
  vonMir.sort(nachDatum);

  return json({
    anMich,
    vonMir,
    canAssignDocs: darfDokumenteZuweisen(session, config)
  }, 200, corsHeaders);
}

// Legt je Empfänger einen eigenen Dokument-Eintrag an — alle zeigen auf DASSELBE
// hochgeladene Original, unterschrieben wird aber jede Kopie einzeln. Zusätzlich
// entsteht je Empfänger eine Aufgabe als Erinnerung.
//
// Reihenfolge der beiden Schreibvorgänge ist Absicht: erst dokumente.json, dann
// aufgaben.json. Bricht der zweite ab, existiert ein Dokument ohne Erinnerung —
// der Empfänger findet es trotzdem im Tab, weil dokumente-load nicht an den
// Aufgaben hängt. Andersherum stünde eine Aufgabe da, die auf nichts zeigt.
// Mailtext zur Unterschriftsanforderung. **Der Betreff nennt den Titel NICHT** --
// er steht in der Handy-Vorschau und im Versandprotokoll des Mailversenders, also
// an zwei Stellen mehr als die App, und die Dokumente hier sind Verträge und
// Personalunterlagen (gleiche Überlegung wie bei vaMailInhalt/vertraulich).
function dokumentMailInhalt(titel, faellig, empfaengerUser, vonName) {
  const anrede = (empfaengerUser && empfaengerUser.vorname) ? `Hallo ${empfaengerUser.vorname},` : "Hallo,";
  const z = [anrede, "", `${vonName} bittet dich um deine Unterschrift.`, "", `Dokument:   ${titel}`];
  if (faellig) z.push(`Frist:      ${vaDatumLesbar(faellig)}`);
  z.push("", "So geht es:", "",
    "1. Die Tools-Übersicht öffnen und anmelden.",
    "2. Oben auf „Unterschriften“ klicken — dort stehen alle Dokumente, die auf dich",
    "   warten.",
    "3. Das Dokument öffnen. Du kannst es in Ruhe lesen, bevor du unterschreibst.",
    "4. Mit dem Finger auf dem Handy oder mit der Maus am Rechner unterschreiben und",
    "   bestätigen.",
    "",
    "Das dauert keine zwei Minuten und funktioniert auf dem Handy genauso wie am",
    "Rechner — du brauchst nichts auszudrucken und nichts einzuscannen.",
    "",
    "Sobald du unterschrieben hast, ist das Dokument fertig abgelegt und verschwindet",
    "aus deiner Liste. Solange es offen bleibt, wirst du daran erinnert.",
    "",
    "Zur Übersicht: https://sc1911heiligenstadt.github.io/ToolsUebersicht/",
    "",
    "Wenn etwas unklar ist oder das Dokument so nicht stimmt, unterschreibe bitte",
    "nicht, sondern melde dich direkt bei " + vonName + ".",
    "",
    "Diese Nachricht wurde automatisch verschickt.", NOTIFY_FROM_NAME);
  return { subject: "Ein Dokument wartet auf deine Unterschrift", textContent: z.join("\n") };
}

// Benachrichtigung zur Unterschriftsanforderung -- läuft NUR auf ausdrückliches
// Häkchen im Dialog (`mail: true` im Body), Michel-Entscheidung 2026-07-31. Bis
// dahin verschickte dieser Weg bewusst gar nichts, solange DKIM/DMARC offen sind
// (siehe "Akzeptierte Limitierungen" in CLAUDE.md); das Häkchen macht daraus eine
// Einzelfall-Entscheidung des Absenders statt einer Eigenschaft des Wegs. Fehlt das
// Feld, bleibt es beim alten Verhalten -- ein alter Client verschickt also nichts.
//
// Ein Trainerdaten-Read für ALLE Empfänger (nicht einer je Person); aus dem Summary
// wird ausschließlich das email-Feld verwendet und nie zurückgegeben, weil
// PROVISION_ONLY_PATHS.trainerdaten IBAN-Daten enthält (Linie von handleNotifyUser
// und vaBenachrichtige). Nichts hiervon darf den Vorgang kippen -- Dokument und
// Aufgabe sind zu diesem Zeitpunkt bereits gespeichert. Fehler werden deshalb
// geschluckt, aber in der Antwort BENANNT: sonst verlässt sich der Absender auf
// eine Zustellung, die es nie gab (siehe [[feedback-stiller-nooperator-vs-echter-fehler]]).
async function dokumentBenachrichtige(empfaenger, titel, faellig, session, env, authHeader) {
  const ohneAdresse = [];
  if (!empfaenger.length) return { benachrichtigt: 0, ohneAdresse, mailAus: false };
  if (!env.BREVO_API_KEY) {
    console.warn("dokument-anlegen: BREVO_API_KEY fehlt — keine Benachrichtigung verschickt");
    return { benachrichtigt: 0, ohneAdresse, mailAus: true };
  }

  const usersDoc = session.usersDoc;
  const vonName = aufgabenAnzeigeName(usersDoc, session.username);
  let trainerdatenDoc;
  try {
    trainerdatenDoc = await readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] });
  } catch (e) {
    console.error("dokument-anlegen: Trainerdaten nicht lesbar", e && e.message);
    return { benachrichtigt: 0, ohneAdresse, mailAus: true };
  }

  let benachrichtigt = 0;
  for (const username of empfaenger) {
    const user = getOwn((usersDoc && usersDoc.users) || {}, username);
    const email = buildTrainerdatenSummary(findTrainerdatenRecord(trainerdatenDoc, user)).email;
    if (!email) {
      ohneAdresse.push(aufgabenAnzeigeName(usersDoc, username));
      continue;
    }
    const { subject, textContent } = dokumentMailInhalt(titel, faellig, user, vonName);
    try {
      const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": env.BREVO_API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          sender: { email: NOTIFY_FROM_EMAIL, name: NOTIFY_FROM_NAME },
          to: [{ email }],
          subject,
          textContent
        })
      });
      if (resp.ok) benachrichtigt++;
      else console.error("dokument-anlegen: Brevo-Versand fehlgeschlagen", resp.status, await resp.text().catch(() => ""));
    } catch (e) {
      console.error("dokument-anlegen: Brevo-Versand fehlgeschlagen", e && e.message);
    }
  }
  return { benachrichtigt, ohneAdresse, mailAus: false };
}

async function handleDokumentAnlegen(request, body, env, authHeader, corsHeaders, execCtx) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  if (!darfDokumenteZuweisen(session, config)) {
    return json({ error: "Keine Berechtigung, Dokumente zum Unterschreiben zu verschicken" }, 403, corsHeaders);
  }

  const titel = capStr(body && body.titel, DOKUMENT_MAX_TITEL);
  if (!titel) return json({ error: "Titel fehlt" }, 400, corsHeaders);
  const originalFileId = String((body && body.originalFileId) || "");
  if (!FILE_ID_RE.test(originalFileId)) return json({ error: "Ungültige Datei-Id" }, 400, corsHeaders);
  const faellig = aufgabenDatum(body && body.faellig);
  const feld = dokumentFeld(body && body.feld);

  const roh = Array.isArray(body && body.empfaenger) ? body.empfaenger : [];
  if (!roh.length) return json({ error: "Kein Empfänger gewählt" }, 400, corsHeaders);
  if (roh.length > AUFGABEN_MAX_EMPFAENGER) {
    return json({ error: `Höchstens ${AUFGABEN_MAX_EMPFAENGER} Empfänger auf einmal` }, 400, corsHeaders);
  }
  // Gleiche Regel wie beim Zuweisen: Empfänger müssen existieren und Personal
  // sein, serverseitig geprüft — der Client ist beim Ziel eines Schreibvorgangs
  // in eine fremde Liste keine Instanz.
  const empfaenger = [];
  for (const r of roh) {
    const u = normalizeUsername(r);
    const user = getOwn((session.usersDoc && session.usersDoc.users) || {}, u);
    if (!user || !istPersonal(user)) return json({ error: "Unbekannter Empfänger: " + u }, 400, corsHeaders);
    if (!empfaenger.includes(u)) empfaenger.push(u);
  }

  let angelegt = [];
  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(DOKUMENTE_URL, authHeader, { version: 1, byId: {} });
    doc.version = doc.version || 1;
    if (!doc.byId || typeof doc.byId !== "object") doc.byId = {};
    if (Object.keys(doc.byId).length + empfaenger.length > DOKUMENTE_MAX_GESAMT) {
      return json({ error: "Die Dokumentenliste ist voll. Bitte erledigte Dokumente löschen." }, 400, corsHeaders);
    }

    const jetztIso = new Date().toISOString();
    angelegt = [];
    for (const u of empfaenger) {
      const id = crypto.randomUUID();
      doc.byId[id] = {
        id,
        titel,
        von: session.username,
        empfaenger: u,
        erstelltAm: jetztIso,
        faellig,
        originalFileId,
        feld,
        status: "offen",
        unterschriebenAm: null,
        signedFileId: null,
        abgelehntAm: null,
        ablehnGrund: "",
        geoeffnetAm: null
      };
      angelegt.push({ id, empfaenger: u });
    }

    try {
      await writeJson(DOKUMENTE_URL, authHeader, doc, rev || undefined);
      break;
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  if (!angelegt.length) return json({ error: "Anlegen fehlgeschlagen" }, 502, corsHeaders);

  // Zweiter Schritt: die Erinnerungen. Ein Fehlschlag hier kippt das Dokument
  // NICHT — es ist bereits gespeichert und sichtbar; siehe Kommentar oben.
  let aufgabenAngelegt = 0;
  for (let versuch = 0; versuch < 3; versuch++) {
    try {
      const { data: adoc, rev } = await readJsonWithRev(AUFGABEN_URL, authHeader, { version: 1, byUser: {} });
      adoc.version = adoc.version || 1;
      if (!adoc.byUser || typeof adoc.byUser !== "object") adoc.byUser = {};
      const jetztIso = new Date().toISOString();
      aufgabenAngelegt = 0;
      for (const a of angelegt) {
        const liste = aufgabenListe(adoc, a.empfaenger).slice();
        if (liste.length >= AUFGABEN_MAX_PRO_NUTZER) continue;
        liste.push({
          id: crypto.randomUUID(),
          text: titel,
          faellig,
          erledigt: false,
          erledigtAm: null,
          erstelltAm: jetztIso,
          von: session.username,
          zugewiesenAm: jetztIso,
          gesehenAm: null,
          dokId: a.id
        });
        adoc.byUser[a.empfaenger] = liste;
        aufgabenAngelegt++;
      }
      aufgabenPrune(adoc);
      await writeJson(AUFGABEN_URL, authHeader, adoc, rev || undefined);
      break;
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      break;
    }
  }

  // Dritter Schritt: die Benachrichtigung -- nur wenn der Absender sie im Dialog
  // ausdrücklich angehakt hat. Steht bewusst hinter beiden Schreibvorgängen: ein
  // Brevo-Ausfall darf weder Dokument noch Erinnerung kippen.
  let versand = { benachrichtigt: 0, ohneAdresse: [], mailAus: false };
  if (body && body.mail === true) {
    versand = await dokumentBenachrichtige(
      angelegt.map((a) => a.empfaenger), titel, faellig, session, env, authHeader
    );
  }

  // ⚠️ Push geht IMMER, unabhängig vom Mail-Häkchen (Michel-Entscheidung
  // 2026-08-03). Das Häkchen gibt es wegen der Mail-Eigenheiten -- externe
  // Zustellung, Spam-Gefahr, Versandprotokoll bei Brevo. Push hat davon nichts:
  // interner Kanal, Ende-zu-Ende verschlüsselt, vom Empfänger selbst
  // eingeschaltet und selbst abstellbar. Die Entscheidung liegt damit beim
  // Empfänger statt beim Absender -- bei einem Vertrag, der auf ihn wartet, die
  // richtige Seite. Ohne Titel des Dokuments, wie schon beim Mail-Betreff.
  pushSenden(env, authHeader, execCtx, angelegt.map((a) => a.empfaenger), "unterschriften",
    (angelegt.length === 1) ? "Ein Dokument wartet auf deine Unterschrift. In der Toolübersicht kannst du es lesen und direkt unterschreiben."
                            : "Es warten Dokumente auf deine Unterschrift. In der Toolübersicht kannst du sie lesen und direkt unterschreiben.");

  return json({ ok: true, angelegt, aufgabenAngelegt, ...versand }, 200, corsHeaders);
}

// Datei-Upload in den abgeschotteten Ordner. Zwei Zwecke mit unterschiedlicher
// Schranke, weil sie zu verschiedenen Zeitpunkten stattfinden:
//   "original"  — noch bevor das Dokument existiert, also gegen das Zuweis-Recht
//   "signiert"  — gegen das fertige Dokument: nur der Empfänger, nur solange offen
async function handleDokumentDateiPut(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const id = String((body && body.id) || "");
  if (!FILE_ID_RE.test(id)) return json({ error: "Ungültige Datei-Id" }, 400, corsHeaders);
  const zweck = String((body && body.zweck) || "");

  if (zweck === "original") {
    const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
    if (!darfDokumenteZuweisen(session, config)) {
      return json({ error: "Keine Berechtigung" }, 403, corsHeaders);
    }
  } else if (zweck === "signiert") {
    const doc = await readJson(DOKUMENTE_URL, authHeader, { version: 1, byId: {} });
    const dok = dokumentHolen(doc, body && body.dokId);
    if (!dok) return json({ error: "Dokument nicht gefunden" }, 404, corsHeaders);
    if (dok.empfaenger !== session.username) {
      return json({ error: "Nur der Empfänger kann unterschreiben" }, 403, corsHeaders);
    }
    if (dok.status !== "offen") return json({ error: "Dokument ist nicht mehr offen" }, 400, corsHeaders);
  } else {
    return json({ error: "Unbekannter Zweck" }, 400, corsHeaders);
  }

  let bytes;
  try {
    bytes = base64ToBytes(String((body && body.dataBase64) || ""));
  } catch (_) {
    return json({ error: "Datei-Inhalt ist kein gültiges base64" }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > MAX_FILE_BYTES) return json({ error: "Datei zu groß (max. 10 MB)" }, 413, corsHeaders);
  // Nur PDF. Ein unterschriebenes .docx bliebe frei editierbar und wäre als
  // Nachweis wertlos — deshalb wird das Format hier hart geprüft und nicht dem
  // Datei-Dialog des Browsers überlassen.
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    return json({ error: "Nur PDF-Dateien sind erlaubt" }, 400, corsHeaders);
  }

  const fileUrl = UNTERSCHRIFTEN_DIR + "/" + id;
  const headers = { Authorization: authHeader, "Content-Type": "application/pdf" };
  let resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  // Gleicher MKCOL-Autofix wie bei dav-file-put: 409 = eine Ebene fehlt, 404 =
  // zwei oder mehr (der Fall beim allerersten Upload überhaupt).
  if (resp.status === 409 || resp.status === 404) {
    await ensureCollection(UNTERSCHRIFTEN_DIR, authHeader, 0);
    resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);
  return json({ ok: true, id }, 200, corsHeaders);
}

// Herunterladen/Ansehen. Die Datei-Id wird NICHT direkt entgegengenommen, sondern
// immer über das Dokument aufgelöst: sonst könnte jeder, der eine Id errät oder
// aus einem anderen Vorgang kennt, sie an der Beteiligten-Prüfung vorbei abrufen.
async function handleDokumentDateiGet(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const doc = await readJson(DOKUMENTE_URL, authHeader, { version: 1, byId: {} });
  const dok = dokumentHolen(doc, body && body.dokId);
  if (!dok) return json({ error: "Dokument nicht gefunden" }, 404, corsHeaders);
  if (!istDokumentBeteiligt(session, dok)) {
    return json({ error: "Kein Zugriff auf dieses Dokument" }, 403, corsHeaders);
  }

  const welche = String((body && body.welche) || "original");
  const fileId = welche === "signiert" ? dok.signedFileId : dok.originalFileId;
  if (!fileId || !FILE_ID_RE.test(String(fileId))) {
    return json({ error: "Datei nicht vorhanden" }, 404, corsHeaders);
  }

  let resp;
  try {
    resp = await fetch(UNTERSCHRIFTEN_DIR + "/" + fileId, { method: "GET", headers: { Authorization: authHeader } });
  } catch (_) {
    return json({ error: "Nextcloud nicht erreichbar" }, 502, corsHeaders);
  }
  if (resp.status === 404) return json({ error: "Datei nicht gefunden" }, 404, corsHeaders);
  if (!resp.ok) return json({ error: `Nextcloud GET ${resp.status}` }, 502, corsHeaders);
  return new Response(resp.body, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/pdf", "Cache-Control": "private, no-store" }
  });
}

// Die Unterschrift ist geleistet: der Client hat das signierte PDF bereits über
// dokument-datei-put hochgeladen, hier wird es verbucht und die Aufgabe erledigt.
// Der Zeitstempel kommt vom SERVER, nie aus dem Body — er ist der Nachweis.
async function handleDokumentUnterschreiben(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const signedFileId = String((body && body.signedFileId) || "");
  if (!FILE_ID_RE.test(signedFileId)) return json({ error: "Ungültige Datei-Id" }, 400, corsHeaders);
  const dokId = String((body && body.dokId) || "");

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(DOKUMENTE_URL, authHeader, { version: 1, byId: {} });
    const dok = dokumentHolen(doc, dokId);
    if (!dok) return json({ error: "Dokument nicht gefunden" }, 404, corsHeaders);
    if (dok.empfaenger !== session.username) {
      return json({ error: "Nur der Empfänger kann unterschreiben" }, 403, corsHeaders);
    }
    if (dok.status !== "offen") return json({ error: "Dokument ist nicht mehr offen" }, 400, corsHeaders);

    dok.status = "unterschrieben";
    dok.signedFileId = signedFileId;
    dok.unterschriebenAm = new Date().toISOString();

    try {
      await writeJson(DOKUMENTE_URL, authHeader, doc, rev || undefined);
      await dokumentAufgabeAbschliessen(authHeader, session.username, dokId);
      return json({ ok: true, dokument: dokumentOeffentlich(dok, session.usersDoc) }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Unterschreiben fehlgeschlagen" }, 502, corsHeaders);
}

// „Ich unterschreibe das nicht" — mit Pflicht-Begründung. Ohne diesen Weg bliebe
// eine bewusst verweigerte Unterschrift für immer offen stehen, und der Absender
// könnte sie nicht von einer bloß übersehenen unterscheiden.
async function handleDokumentAblehnen(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const grund = capStr(body && body.grund, DOKUMENT_MAX_ABLEHNGRUND);
  if (!grund) return json({ error: "Bitte eine Begründung angeben" }, 400, corsHeaders);
  const dokId = String((body && body.dokId) || "");

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(DOKUMENTE_URL, authHeader, { version: 1, byId: {} });
    const dok = dokumentHolen(doc, dokId);
    if (!dok) return json({ error: "Dokument nicht gefunden" }, 404, corsHeaders);
    if (dok.empfaenger !== session.username) {
      return json({ error: "Nur der Empfänger kann ablehnen" }, 403, corsHeaders);
    }
    if (dok.status !== "offen") return json({ error: "Dokument ist nicht mehr offen" }, 400, corsHeaders);

    dok.status = "abgelehnt";
    dok.ablehnGrund = grund;
    dok.abgelehntAm = new Date().toISOString();

    try {
      await writeJson(DOKUMENTE_URL, authHeader, doc, rev || undefined);
      await dokumentAufgabeAbschliessen(authHeader, session.username, dokId);
      return json({ ok: true, dokument: dokumentOeffentlich(dok, session.usersDoc) }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Ablehnen fehlgeschlagen" }, 502, corsHeaders);
}

// Hakt die zugehörige Erinnerung ab, nachdem das Dokument seinen Endzustand
// erreicht hat. Bewusst ohne Fehlerweitergabe: der Vorgang selbst ist zu diesem
// Zeitpunkt bereits gespeichert, und eine stehengebliebene Aufgabe darf eine
// geleistete Unterschrift nicht zurückrollen.
async function dokumentAufgabeAbschliessen(authHeader, username, dokId) {
  for (let versuch = 0; versuch < 3; versuch++) {
    try {
      const { data: doc, rev } = await readJsonWithRev(AUFGABEN_URL, authHeader, { version: 1, byUser: {} });
      if (!doc.byUser || typeof doc.byUser !== "object") return;
      let geaendert = false;
      for (const a of aufgabenListe(doc, username)) {
        if (a && a.dokId === dokId && !a.erledigt) {
          a.erledigt = true;
          a.erledigtAm = new Date().toISOString();
          geaendert = true;
        }
      }
      if (!geaendert) return;
      await writeJson(AUFGABEN_URL, authHeader, doc, rev || undefined);
      return;
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return;
    }
  }
}

// Absender oder Admin räumt auf. Die Originaldatei wird nur gelöscht, wenn KEIN
// anderes Dokument mehr auf sie zeigt — bei einer Zuweisung an mehrere Personen
// teilen sich alle Kopien dasselbe Original, und das Löschen der ersten würde
// sonst allen übrigen das Dokument unter den Füßen wegziehen.
async function handleDokumentLoeschen(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await aufgabenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const dokId = String((body && body.dokId) || "");

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(DOKUMENTE_URL, authHeader, { version: 1, byId: {} });
    const dok = dokumentHolen(doc, dokId);
    if (!dok) return json({ error: "Dokument nicht gefunden" }, 404, corsHeaders);
    if (dok.von !== session.username && !session.isAdmin) {
      return json({ error: "Nur der Absender kann das Dokument löschen" }, 403, corsHeaders);
    }

    const signedFileId = dok.signedFileId;
    const originalFileId = dok.originalFileId;
    delete doc.byId[dokId];
    const originalNochGenutzt = Object.values(dokumenteById(doc))
      .some((d) => d && d.originalFileId === originalFileId);

    try {
      await writeJson(DOKUMENTE_URL, authHeader, doc, rev || undefined);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }

    // Erst der Eintrag, dann die Bytes: bricht das Löschen der Datei ab, bleibt
    // eine verwaiste Datei ohne Verweis liegen — harmloser als ein Eintrag, der
    // auf eine nicht mehr vorhandene Datei zeigt.
    for (const fid of [signedFileId, originalNochGenutzt ? null : originalFileId]) {
      if (!fid || !FILE_ID_RE.test(String(fid))) continue;
      try {
        await fetch(UNTERSCHRIFTEN_DIR + "/" + fid, { method: "DELETE", headers: { Authorization: authHeader } });
      } catch (_) { /* verwaiste Datei ist hinnehmbar */ }
    }
    return json({ ok: true }, 200, corsHeaders);
  }
  return json({ error: "Löschen fehlgeschlagen" }, 502, corsHeaders);
}

// Admin legt fest, welche Gruppen zuweisen dürfen. Read-modify-write wie
// set-materialcontainer-code, damit tools/news/materialcontainer erhalten bleiben.
async function handleSetAufgabenGruppen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const vorhandene = (session.usersDoc && session.usersDoc.groups) || {};
  // Nur existierende Gruppen: ein toter Verweis wäre im Panel nicht sichtbar
  // und würde stillschweigend niemanden berechtigen.
  const saubereGruppen = (roh) => {
    const raus = [];
    for (const r of Array.isArray(roh) ? roh : []) {
      const id = capStr(r, 64);
      if (id && getOwn(vorhandene, id) && !raus.includes(id)) raus.push(id);
    }
    return raus;
  };

  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  config.version = config.version || 1;
  const bisher = (config.aufgaben && typeof config.aufgaben === "object") ? config.aufgaben : {};
  // Zwei getrennte Stufen in EINEM Objekt: Aufgaben zuweisen und Unterschriften
  // einfordern. Ein fehlendes Feld heißt „unverändert", nicht „leeren" — sonst
  // würde ein Panel, das nur die eine Liste schickt, die andere stillschweigend
  // entwerten und damit ein Recht entziehen, das niemand angefasst hat.
  config.aufgaben = {
    assignGroupIds: Array.isArray(body && body.groupIds)
      ? saubereGruppen(body.groupIds)
      : (Array.isArray(bisher.assignGroupIds) ? bisher.assignGroupIds : []),
    dokumentGroupIds: Array.isArray(body && body.dokumentGroupIds)
      ? saubereGruppen(body.dokumentGroupIds)
      : (Array.isArray(bisher.dokumentGroupIds) ? bisher.dokumentGroupIds : []),
    geaendertAm: new Date().toISOString(),
    geaendertVon: session.username
  };
  try {
    await writeJson(env.NEXTCLOUD_URL, authHeader, config);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }
  return json({ ok: true, ...config.aufgaben }, 200, corsHeaders);
}

// ---------- Aktionen: Vereinsaufgaben ----------

// Regelverstoß mit eigenem HTTP-Status. Gebraucht, weil die eigentliche Prüfung
// tief in der read-modify-write-Schleife steckt und von dort einen sprechenden
// Fehler bis zur Antwort durchreichen muss.
class VaFehler extends Error {
  constructor(message, status) {
    super(message);
    this.name = "VaFehler";
    this.status = status || 400;
  }
}

function vaAntwortFehler(e, corsHeaders) {
  if (e instanceof VaFehler) return json({ error: e.message }, e.status, corsHeaders);
  if (e instanceof ConflictError) return json({ error: "Gleichzeitige Änderung — bitte erneut versuchen" }, 409, corsHeaders);
  return json({ error: "Speicherfehler: " + (e && e.message ? e.message : "unbekannt") }, 502, corsHeaders);
}

// Jede Aktion verlangt eingeloggtes Personal MIT Sichtbarkeit auf das Tool.
// Spielerkonten sind wie überall in diesem Worker ausgeschlossen.
async function vaSession(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return { fehler: json({ error: "Nicht angemeldet" }, 401, corsHeaders) };
  if (session.art === USER_ART_SPIELER) {
    return { fehler: json({ error: "Kein Zugriff auf die Vereinsaufgaben" }, 403, corsHeaders) };
  }
  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  if (!(await userMayAccessTool("vereinsaufgaben", session, env, authHeader, Promise.resolve(config)))) {
    return { fehler: json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders) };
  }
  const canEdit = await resolveEditPermission("vereinsaufgaben", session, env, authHeader, Promise.resolve(config));
  const canAdmin = await resolveAdminPermission("vereinsaufgaben", session, env, authHeader, Promise.resolve(config));
  return { session, config, canEdit, canAdmin, fehler: null };
}

// Schreibende Aktionen zusätzlich hinter dem Bearbeiten-Recht. "Sehen" heißt in
// dieser App wirklich nur sehen — auch das Abhaken der eigenen Aufgabe ist ein
// Schreibvorgang und braucht die Stufe.
function vaVerlangeEdit(ctx) {
  if (!ctx.canEdit) throw new VaFehler("Dafür fehlt dir das Bearbeiten-Recht", 403);
}

function vaVerlangeAdmin(ctx) {
  if (!ctx.canAdmin) throw new VaFehler("Dafür fehlt dir das Administrieren-Recht", 403);
}

function vaLeer() {
  return { version: 1, ressorts: [], aufgaben: [], protokoll: [] };
}

function vaNormalisiere(doc) {
  doc.version = doc.version || 1;
  if (!Array.isArray(doc.ressorts)) doc.ressorts = [];
  if (!Array.isArray(doc.aufgaben)) doc.aufgaben = [];
  if (!Array.isArray(doc.protokoll)) doc.protokoll = [];
  return doc;
}

// Read-modify-write mit If-Match und drei Versuchen — dasselbe Muster wie bei den
// persönlichen Aufgaben. fn bekommt das Dokument, ändert es an Ort und Stelle und
// gibt zurück, was der Client als Antwort sehen soll.
async function vaMutiere(authHeader, fn) {
  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(VEREINSAUFGABEN_URL, authHeader, vaLeer());
    vaNormalisiere(doc);
    const ergebnis = fn(doc) || {};
    try {
      await writeJson(VEREINSAUFGABEN_URL, authHeader, doc, rev || undefined);
      return { ok: true, ...ergebnis };
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      throw e;
    }
  }
  throw new VaFehler("Speichern nach drei Versuchen fehlgeschlagen", 502);
}

function vaAufgabeHolen(doc, id) {
  const a = doc.aufgaben.find((x) => x && x.id === String(id || ""));
  if (!a) throw new VaFehler("Aufgabe nicht gefunden", 404);
  return a;
}

function vaRessortHolen(doc, id) {
  return doc.ressorts.find((r) => r && r.id === String(id || "")) || null;
}

// Verantwortlicher und Stellvertreter zählen immer als Mitglieder — sonst könnte
// ein Verantwortlicher sich selbst nichts eintragen und stünde nicht in der
// eigenen Mannschaft.
function vaRessortMitglieder(r) {
  const raus = [];
  [r.verantwortlich, r.stellvertreter].concat(Array.isArray(r.mitglieder) ? r.mitglieder : []).forEach((u) => {
    if (u && !raus.includes(u)) raus.push(u);
  });
  return raus;
}

// Das Zuweisungsrecht folgt der Vereinsstruktur, nicht einer zweiten Rechteliste:
// wer ein Ressort verantwortet oder vertritt, darf dessen Mitgliedern etwas
// auftragen. Administrieren darf jedem. Alles andere ist ein Schreibzugriff in
// eine fremde Liste und fällt zu.
function vaDarfZuweisenAn(doc, ctx, username) {
  if (ctx.canAdmin) return true;
  return doc.ressorts.some((r) =>
    (r.verantwortlich === ctx.session.username || r.stellvertreter === ctx.session.username) &&
    vaRessortMitglieder(r).includes(username));
}

// Wer den Text einer vertraulichen Aufgabe sehen darf. Bewusst eng: die beiden
// Beteiligten und wer die App administriert. Ein Ressort-Mitglied gehört NICHT
// dazu — sonst wäre "vertraulich" nur ein anderes Wort für "fast alle".
function vaDarfInhaltSehen(a, ctx) {
  if (!a.vertraulich) return true;
  if (ctx.canAdmin) return true;
  return a.von === ctx.session.username || a.empfaenger === ctx.session.username;
}

// Wer bei einer Rückfrage oder einem Statuswechsel eine Push-Nachricht bekommt:
// die jeweils ANDERE Seite des Vorgangs, nie der Handelnde selbst. Greift ein
// Administrierender ein, der weder zugewiesen noch empfangen hat, werden dadurch
// beide Beteiligten benachrichtigt — genau richtig, denn keiner von ihnen hat es
// ausgelöst. Der Empfänger kommt IMMER aus dem Datensatz, nie aus dem Request.
function vaPushBeteiligte(a, ctx) {
  const raus = [];
  for (const u of [a.von, a.empfaenger]) {
    if (u && u !== ctx.session.username && !raus.includes(u)) raus.push(u);
  }
  return raus;
}

// Der entscheidende Punkt an der Vertraulichkeit: der Text wird hier ENTFERNT,
// nicht clientseitig ausgeblendet. Was der Unbeteiligte nie bekommt, kann er auch
// im Netzwerk-Tab nicht nachlesen. Empfänger, Frist und Status bleiben stehen,
// damit die Auslastungsübersicht nicht still lügt.
function vaFuerAnzeige(a, ctx) {
  if (vaDarfInhaltSehen(a, ctx)) return a;
  return {
    id: a.id, empfaenger: a.empfaenger, von: a.von, ressortId: a.ressortId,
    faellig: a.faellig, prioritaet: a.prioritaet, status: a.status,
    erstelltAm: a.erstelltAm, erledigtAm: a.erledigtAm,
    abnahme: !!a.abnahme, vertraulich: true, verdeckt: true,
    anhaenge: [], kommentare: [], verlauf: []
  };
}

function vaVerlauf(a, von, was, alt, neu) {
  if (!Array.isArray(a.verlauf)) a.verlauf = [];
  a.verlauf.push({ am: new Date().toISOString(), von, was, alt: alt == null ? "" : String(alt), neu: neu == null ? "" : String(neu) });
  if (a.verlauf.length > 200) a.verlauf.splice(0, a.verlauf.length - 200);
}

function vaProtokoll(doc, eintrag) {
  doc.protokoll.push({ am: new Date().toISOString(), ...eintrag });
  if (doc.protokoll.length > VA_MAX_PROTOKOLL) doc.protokoll.splice(0, doc.protokoll.length - VA_MAX_PROTOKOLL);
}

function vaDatum(roh) {
  const s = capStr(roh, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function vaPrioritaet(roh) {
  const p = capStr(roh, 20);
  return VA_PRIORITAETEN.includes(p) ? p : "normal";
}

// Person existiert und ist Personal -- mehr nicht. Das ist die Schranke für
// Ressort-MITGLIEDER: ein Ressort ist ein Amt, keine Rechtegruppe. Wer dort steht,
// ist fachlich zuständig; ob ihm jemand darüber eine Aufgabe auftragen kann, ist
// eine zweite, davon getrennte Frage (vaPruefeEmpfaenger). Vorher lief auch die
// Mitgliederliste durch die Empfängerprüfung -- dadurch ließ sich ein Ressort erst
// zusammenstellen, nachdem jedem Beteiligten das Bearbeiten-Recht auf die ganze
// App vergeben war. Genau das sollte die eigene Ressort-Struktur vermeiden.
function vaPruefeMitglied(username, usersDoc) {
  const u = normalizeUsername(username);
  const user = getOwn((usersDoc && usersDoc.users) || {}, u);
  if (!user || !istPersonal(user)) throw new VaFehler("Unbekannte Person: " + u, 400);
  return u;
}

// Reines Prädikat: darf diese Person die Vereinsaufgaben bearbeiten und damit eine
// Aufgabe überhaupt abhaken? Herausgezogen, weil zwei Aufrufer es verschieden
// brauchen -- der Empfängerpfad wirft (unten), das Auffächern eines Ressorts
// überspringt und meldet die Übergangenen namentlich zurück.
function vaKannBearbeiten(user, username, ctx, usersDoc) {
  if (!user) return false;
  if (user.isAdmin) return true;
  const entry = getOwn((ctx.config && ctx.config.tools) || {}, "vereinsaufgaben") || {};
  const erlaubt = (Array.isArray(entry.editGroupIds) ? entry.editGroupIds : [])
    .concat(Array.isArray(entry.adminGroupIds) ? entry.adminGroupIds : []);
  const eigene = getUserGroupIds(usersDoc, username);
  return erlaubt.some((g) => eigene.includes(g));
}

// Empfänger müssen existieren, Personal sein UND die App bearbeiten dürfen. Der
// letzte Punkt ist keine Förmlichkeit: wer nur Sehen hat, könnte die Aufgabe nie
// abhaken — sie wäre eine stille Sackgasse, die erst bei der Frist auffällt.
function vaPruefeEmpfaenger(username, ctx, usersDoc) {
  const u = normalizeUsername(username);
  const user = getOwn((usersDoc && usersDoc.users) || {}, u);
  if (!user || !istPersonal(user)) throw new VaFehler("Unbekannter Empfänger: " + u, 400);
  if (!vaKannBearbeiten(user, u, ctx, usersDoc)) {
    throw new VaFehler(
      `${aufgabenAnzeigeName(usersDoc, u)} darf die Vereinsaufgaben nicht bearbeiten und könnte die Aufgabe nie abhaken. ` +
      `Bitte zuerst in der Tools-Übersicht das Bearbeiten-Recht für dieses Tool vergeben.`, 400);
  }
  return u;
}

// Wie vaKannBearbeiten, aber mit Nutzernamen statt Datensatz -- für die Stellen,
// die nur eine Namensliste haben.
function vaEmpfangsfaehig(username, ctx, usersDoc) {
  const user = getOwn((usersDoc && usersDoc.users) || {}, username);
  if (!user || !istPersonal(user)) return false;
  return vaKannBearbeiten(user, username, ctx, usersDoc);
}

async function handleVaLoad(request, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;

  const doc = vaNormalisiere(await readJson(VEREINSAUFGABEN_URL, authHeader, vaLeer()));
  const usersDoc = ctx.session.usersDoc;

  // Anzeigenamen kommen aus nutzer.json, nicht aus der Aufgabe: ein alter Eintrag
  // soll nach einer Umbenennung nicht den früheren Namen weiterzeigen. Ausgeschiedene
  // bleiben mit ihrem Nutzernamen sichtbar, damit ihre Historie lesbar bleibt.
  const namen = {};
  const merke = (u) => { if (u && !namen[u]) namen[u] = aufgabenAnzeigeName(usersDoc, u); };
  doc.aufgaben.forEach((a) => { merke(a.empfaenger); merke(a.von); (a.kommentare || []).forEach((k) => merke(k.von)); });
  doc.ressorts.forEach((r) => vaRessortMitglieder(r).forEach(merke));
  doc.protokoll.forEach((p) => { merke(p.von); merke(p.vonUser); merke(p.aufUser); });

  return json({
    ressorts: doc.ressorts,
    aufgaben: doc.aufgaben.map((a) => vaFuerAnzeige(a, ctx)),
    // Das Protokoll ist das Gegengewicht dazu, dass der Ersteller löschen darf.
    // Es gehört deshalb ausschließlich der Administrieren-Stufe.
    protokoll: ctx.canAdmin ? doc.protokoll : [],
    namen,
    me: { username: ctx.session.username, isAdmin: !!ctx.session.isAdmin, canEdit: ctx.canEdit, canAdmin: ctx.canAdmin }
  }, 200, corsHeaders);
}

async function handleVaRessortSpeichern(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeAdmin(ctx);
    const roh = (body && body.ressort) || {};
    const name = capStr(roh.name, 120).trim();
    if (!name) throw new VaFehler("Ein Ressort braucht einen Namen", 400);
    // Verantwortlich und Stellvertretung bleiben auf der Empfängerprüfung, die
    // weiteren Mitglieder nicht. Grund: bei "an das Ressort zuweisen" ist der
    // Verantwortliche der Empfänger — ohne Bearbeiten-Recht entstünde dort eine
    // Aufgabe, die niemand abhaken kann. Ein weiteres Mitglied trägt dagegen nur
    // Zuständigkeit; ihm etwas aufzutragen ist ein eigener, geprüfter Schritt.
    const verantwortlich = vaPruefeEmpfaenger(roh.verantwortlich, ctx, ctx.session.usersDoc);
    const stellvertreter = roh.stellvertreter ? vaPruefeEmpfaenger(roh.stellvertreter, ctx, ctx.session.usersDoc) : "";
    const mitglieder = [];
    for (const m of (Array.isArray(roh.mitglieder) ? roh.mitglieder : []).slice(0, VA_MAX_EMPFAENGER)) {
      const u = vaPruefeMitglied(m, ctx.session.usersDoc);
      if (!mitglieder.includes(u)) mitglieder.push(u);
    }

    const ergebnis = await vaMutiere(authHeader, (doc) => {
      const id = capStr(roh.id, 64);
      const jetzt = new Date().toISOString();
      let r = id ? vaRessortHolen(doc, id) : null;
      if (id && !r) throw new VaFehler("Ressort nicht gefunden", 404);
      if (!r) {
        r = { id: crypto.randomUUID(), erstelltAm: jetzt, erstelltVon: ctx.session.username };
        doc.ressorts.push(r);
      }
      r.name = name;
      r.beschreibung = capStr(roh.beschreibung, 2000);
      r.verantwortlich = verantwortlich;
      r.stellvertreter = stellvertreter;
      r.mitglieder = mitglieder;
      r.geaendertAm = jetzt;
      r.geaendertVon = ctx.session.username;
      return { id: r.id };
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

async function handleVaRessortLoeschen(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeAdmin(ctx);
    const ergebnis = await vaMutiere(authHeader, (doc) => {
      const id = capStr(body && body.id, 64);
      const idx = doc.ressorts.findIndex((r) => r && r.id === id);
      if (idx < 0) throw new VaFehler("Ressort nicht gefunden", 404);
      // Aufgaben bleiben stehen und verlieren nur die Zuordnung. Ein gelöschtes
      // Ressort darf keine Aufträge mitreißen — die Person bleibt zuständig.
      doc.aufgaben.forEach((a) => { if (a.ressortId === id) a.ressortId = ""; });
      const [weg] = doc.ressorts.splice(idx, 1);
      vaProtokoll(doc, { art: "ressort-geloescht", von: ctx.session.username, titel: weg.name });
      return {};
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// ---------- Benachrichtigung beim Anlegen (seit 2026-07-29) ----------
//
// Michel-Entscheidung, und damit die Umkehr der ursprünglichen Festlegung "keine
// Benachrichtigung". Das frühere Argument — wer wissen will, was ansteht, öffnet die
// App — trägt bei einer Aufgabe mit Pflicht-Frist nicht: die Frist läuft, ob der
// Empfänger hineinschaut oder nicht, und die Überfällig-Spalte war das einzige
// Frühwarnsystem für etwas, das er nie gesehen hat.
//
// BEWUSST nur beim Anlegen. Statuswechsel, Kommentare und Abnahmen bleiben stumm:
// eine Benachrichtigung, die bei jedem Schritt feuert, wird nach zwei Wochen
// weggefiltert und ist dann auch beim Anlegen wirkungslos.
//
// Empfänger sind genau die, die in der Aufgabe stehen — bei "an das Ressort" also
// der Verantwortliche, bei "einzeln" jeder mit seiner eigenen Aufgabe. Mitlesende
// Ressort-Mitglieder bekommen nichts; sie müssen nichts tun.

function vaDatumLesbar(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || "");
}

// "Vertraulich" heißt hier dasselbe wie in vaFuerAnzeige: Titel UND Beschreibung
// sind der geschützte Inhalt (vaFuerAnzeige gibt den Titel für Unbeteiligte gar
// nicht erst heraus), Frist/Ressort/Abnahme sind es nicht. Die Mail nennt deshalb
// auch im BETREFF keinen Titel — ein Betreff steht in der Handy-Vorschau und im
// Versandprotokoll des Mailversenders, also an zwei Stellen mehr als die App.
function vaMailInhalt(info, empfaengerUser, vonName) {
  const anrede = (empfaengerUser && empfaengerUser.vorname) ? `Hallo ${empfaengerUser.vorname},` : "Hallo,";
  // Die Erinnerung ist derselbe Brief mit anderem Einleitungssatz — bewusst keine
  // zweite Funktion: Vertraulichkeit, Betreff-Regel und Fußzeile müssten sonst an
  // zwei Stellen gleich gehalten werden und liefen auseinander.
  const z = [anrede, "", info.erinnerung
    ? `${vonName} erinnert dich an eine Aufgabe, die noch offen ist.`
    : `${vonName} hat dir eine Aufgabe zugewiesen.`, ""];

  if (!info.vertraulich) z.push(`Titel:      ${info.titel}`);
  if (info.ressortName) z.push(`Ressort:    ${info.ressortName}`);
  z.push(`Frist:      ${vaDatumLesbar(info.faellig)}`);
  if (info.prioritaet === "hoch") z.push("Priorität:  Hoch");

  if (info.vertraulich) {
    z.push("", "Diese Aufgabe ist als vertraulich gekennzeichnet. Titel und Einzelheiten",
      "stehen deshalb nur in der App, nicht in dieser E-Mail.");
  } else if (info.beschreibung) {
    z.push("", info.beschreibung);
  }

  if (info.abnahme) {
    z.push("", `Deine Erledigung muss ${vonName} noch abnehmen. Du meldest die Aufgabe also`,
      "zuerst als erledigt, danach wird sie geprüft und abgeschlossen.");
  }

  z.push("", "So meldest du die Aufgabe als erledigt:", "",
    "Die Vereinsaufgaben öffnen und anmelden. Unter „Meine Aufgaben“ steht die Aufgabe",
    "mit allen Einzelheiten. Dort auf „Erledigt“ klicken — fertig. Du kannst an",
    "derselben Stelle auch eine Rückfrage stellen, wenn etwas unklar ist oder du mehr",
    "Zeit brauchst; " + vonName + " bekommt die Frage dann direkt.",
    "",
    "Solange die Aufgabe offen ist, wirst du vor der Frist noch einmal erinnert.",
    "",
    "Zur Aufgabe: https://sc1911heiligenstadt.github.io/Vereinsaufgaben/", "",
    "Diese Nachricht wurde automatisch verschickt.", NOTIFY_FROM_NAME);

  return {
    subject: info.erinnerung
      ? (info.vertraulich ? "Erinnerung an eine vertrauliche Aufgabe" : `Erinnerung: ${info.titel}`)
      : (info.vertraulich ? "Neue vertrauliche Aufgabe für dich" : `Neue Aufgabe: ${info.titel}`),
    textContent: z.join("\n")
  };
}

// Der Versand steht AUSSERHALB von vaMutiere(): dessen Callback läuft bei einem
// If-Match-Konflikt bis zu dreimal, die Mails gingen sonst mehrfach raus.
//
// Nichts hiervon darf das Anlegen kippen — die Aufgabe ist zu diesem Zeitpunkt
// bereits gespeichert. Ein fehlender API-Key, eine fehlende Adresse oder ein
// Brevo-Ausfall werden deshalb geschluckt, aber in der Antwort BENANNT: der Client
// sagt es hin, sonst verlässt sich der Zuweiser auf eine Zustellung, die es nie gab.
async function vaBenachrichtige(empfaenger, info, ctx, env, authHeader) {
  const ohneAdresse = [];
  // Nur fürs Protokoll: dieselbe Funktion bedient das Anlegen und das Erinnern.
  const wo = info.erinnerung ? "vereinsaufgabe-erinnern" : "vereinsaufgabe-anlegen";
  if (!empfaenger.length) return { benachrichtigt: 0, ohneAdresse, mailAus: false };
  if (!env.BREVO_API_KEY) {
    console.warn(wo + ": BREVO_API_KEY fehlt — keine Benachrichtigung verschickt");
    return { benachrichtigt: 0, ohneAdresse, mailAus: true };
  }

  const usersDoc = ctx.session.usersDoc;
  const vonName = aufgabenAnzeigeName(usersDoc, ctx.session.username);
  // Die Adressen stehen in Trainerdaten (dieselbe Quelle wie handleNotifyUser).
  // Ein Read für alle Empfänger, nicht einer pro Person.
  let trainerdatenDoc;
  try {
    trainerdatenDoc = await readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] });
  } catch (e) {
    console.error(wo + ": Trainerdaten nicht lesbar", e && e.message);
    return { benachrichtigt: 0, ohneAdresse, mailAus: true };
  }

  let benachrichtigt = 0;
  for (const username of empfaenger) {
    const user = getOwn(usersDoc.users, username);
    // Aus dem vollen Summary wird ausschließlich das email-Feld verwendet und nie
    // zurückgegeben — PROVISION_ONLY_PATHS.trainerdaten enthält IBAN-Daten und darf
    // eingeloggten Nutzern nie durchgereicht werden (gleiche Linie wie notify-user).
    const email = buildTrainerdatenSummary(findTrainerdatenRecord(trainerdatenDoc, user)).email;
    if (!email) {
      ohneAdresse.push(aufgabenAnzeigeName(usersDoc, username));
      continue;
    }
    const { subject, textContent } = vaMailInhalt(info, user, vonName);
    try {
      const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": env.BREVO_API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          sender: { email: NOTIFY_FROM_EMAIL, name: NOTIFY_FROM_NAME },
          to: [{ email }],
          subject,
          textContent
        })
      });
      if (resp.ok) benachrichtigt++;
      else console.error(wo + ": Brevo-Versand fehlgeschlagen", resp.status, await resp.text().catch(() => ""));
    } catch (e) {
      console.error(wo + ": Brevo-Versand fehlgeschlagen", e && e.message);
    }
  }
  return { benachrichtigt, ohneAdresse, mailAus: false };
}

async function handleVaAnlegen(request, body, env, authHeader, corsHeaders, execCtx) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const titel = capStr(body && body.titel, VA_MAX_TITEL).trim();
    if (!titel) throw new VaFehler("Ein Titel muss angegeben werden", 400);
    // Die Frist ist Pflicht — ohne sie wäre jede Sortierung, jeder Zähler und die
    // ganze Überfälligkeitsrechnung ein Sonderfall. Dauerhaftes gehört ins Ressort.
    const faellig = vaDatum(body && body.faellig);
    if (!faellig) throw new VaFehler("Eine Frist im Format JJJJ-MM-TT ist Pflicht", 400);

    const modus = capStr(body && body.modus, 20);
    const beschreibung = capStr(body && body.beschreibung, VA_MAX_BESCHREIBUNG);
    const prioritaet = vaPrioritaet(body && body.prioritaet);
    const abnahme = !!(body && body.abnahme);
    const vertraulich = !!(body && body.vertraulich);

    const ergebnis = await vaMutiere(authHeader, (doc) => {
      let empfaenger = [];
      let ressortId = "";
      let ressortName = "";
      // Ressort-Mitglieder ohne Bearbeiten-Recht: beim Auffächern übersprungen,
      // aber namentlich zurückgemeldet. Still weglassen wäre das Schlimmste --
      // der Zuweiser hielte eine Aufgabe für vergeben, die es nie gab.
      const uebersprungen = [];

      if (modus === "person") {
        const roh = Array.isArray(body && body.empfaenger) ? body.empfaenger : [];
        if (!roh.length) throw new VaFehler("Kein Empfänger gewählt", 400);
        if (roh.length > VA_MAX_EMPFAENGER) throw new VaFehler(`Höchstens ${VA_MAX_EMPFAENGER} Empfänger auf einmal`, 400);
        for (const r of roh) {
          const u = vaPruefeEmpfaenger(r, ctx, ctx.session.usersDoc);
          if (!empfaenger.includes(u)) empfaenger.push(u);
        }
      } else if (modus === "ressort" || modus === "ressort-einzeln") {
        const r = vaRessortHolen(doc, body && body.ressortId);
        if (!r) throw new VaFehler("Ressort nicht gefunden", 404);
        ressortId = r.id;
        ressortName = r.name || "";
        // "An das Ressort" heißt: der Verantwortliche hakt ab und haftet, die
        // Mitglieder sehen mit. "Einzeln" fächert beim Anlegen auf, damit jeder
        // selbst abhaken muss — beides kommt im Vereinsalltag vor.
        if (modus === "ressort") {
          if (!r.verantwortlich) throw new VaFehler("Dieses Ressort hat niemanden hinterlegt", 400);
          // Wirft mit Namen, wenn dem Verantwortlichen das Recht nachträglich
          // entzogen wurde. Hier ist Überspringen keine Option: es gibt nur ihn.
          empfaenger = [vaPruefeEmpfaenger(r.verantwortlich, ctx, ctx.session.usersDoc)];
        } else {
          const alle = vaRessortMitglieder(r);
          if (!alle.length) throw new VaFehler("Dieses Ressort hat niemanden hinterlegt", 400);
          alle.forEach((u) => {
            if (vaEmpfangsfaehig(u, ctx, ctx.session.usersDoc)) empfaenger.push(u);
            else uebersprungen.push(aufgabenAnzeigeName(ctx.session.usersDoc, u));
          });
          if (!empfaenger.length) {
            throw new VaFehler(
              `Niemand in diesem Ressort darf die Vereinsaufgaben bearbeiten — eine Aufgabe könnte dort nie abgehakt werden. ` +
              `Betroffen: ${uebersprungen.join(", ")}.`, 400);
          }
        }
      } else {
        throw new VaFehler("Unbekannter Zuweisungs-Modus", 400);
      }

      for (const u of empfaenger) {
        if (!vaDarfZuweisenAn(doc, ctx, u)) {
          throw new VaFehler(
            `Du darfst ${aufgabenAnzeigeName(ctx.session.usersDoc, u)} keine Aufgabe zuweisen. ` +
            `Zuweisen darf, wer ein Ressort verantwortet oder vertritt — an dessen Mitglieder.`, 403);
        }
      }
      if (doc.aufgaben.length + empfaenger.length > VA_MAX_AUFGABEN) {
        throw new VaFehler("Die Aufgabenliste ist voll", 400);
      }

      const jetzt = new Date().toISOString();
      empfaenger.forEach((u) => {
        doc.aufgaben.push({
          id: crypto.randomUUID(),
          titel, beschreibung, faellig, prioritaet, ressortId,
          empfaenger: u, von: ctx.session.username,
          status: "offen", abnahme, vertraulich,
          erstelltAm: jetzt,
          erledigtAm: "", gemeldetAm: "", abgenommenAm: "", abgenommenVon: "",
          abgelehntAm: "", ablehnGrund: "", rueckgabeGrund: "",
          zurueckgezogenAm: "", zurueckgezogenVon: "", zurueckgezogenGrund: "",
          anhaenge: [], kommentare: [], verlauf: []
        });
      });
      return { angelegt: empfaenger.length, empfaenger: empfaenger.slice(), ressortName, uebersprungen: uebersprungen.slice() };
    });

    // Ab hier ist die Aufgabe gespeichert. Was hier noch schiefgeht, darf das
    // Anlegen nicht mehr zu einem Fehler machen — der Zuweiser hätte sonst einen
    // roten Hinweis vor einer Aufgabe, die es in Wahrheit gibt.
    let versand = { benachrichtigt: 0, ohneAdresse: [], mailAus: true };
    try {
      versand = await vaBenachrichtige(ergebnis.empfaenger || [], {
        titel, beschreibung, faellig, prioritaet, abnahme, vertraulich,
        ressortName: ergebnis.ressortName || ""
      }, ctx, env, authHeader);
    } catch (e) {
      console.error("vereinsaufgabe-anlegen: Benachrichtigung fehlgeschlagen", e && e.message);
    }
    // Push zusaetzlich zur Mail, nicht statt ihr -- und ohne Titel der Aufgabe.
    pushSenden(env, authHeader, execCtx, ergebnis.empfaenger || [], "aufgaben",
      (ergebnis.angelegt === 1)
        ? "Dir wurde eine neue Aufgabe zugewiesen. In den Vereinsaufgaben stehen Beschreibung und Frist, dort meldest du sie auch als erledigt."
        : "Dir wurden neue Aufgaben zugewiesen. In den Vereinsaufgaben stehen Beschreibung und Frist, dort meldest du sie auch als erledigt.");
    // ohneRecht rein additiv: ein älterer Client, der das Feld nicht kennt,
    // ignoriert es und verhält sich wie bisher.
    return json({ ok: true, angelegt: ergebnis.angelegt, ohneRecht: ergebnis.uebersprungen || [], ...versand }, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// Erinnern: dieselbe Mail wie beim Anlegen und dieselbe Push-Nachricht, noch einmal
// an den Empfänger. Michel-Wunsch vom 2026-08-19 — es gab bis dahin keinen Weg, eine
// liegengebliebene Aufgabe anzustoßen, außer eine Rückfrage hineinzuschreiben.
//
// ⚠️ Der Empfänger kommt IMMER aus dem Datensatz, nie aus dem Body. Käme er aus dem
// Request, wäre die Aktion für jeden Bearbeiter ein Versandweg an beliebige Konten.
async function handleVaErinnern(request, body, env, authHeader, corsHeaders, execCtx) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const { pushAn, mailInfo, ...antwort } = await vaMutiere(authHeader, (doc) => {
      const a = vaAufgabeHolen(doc, body && body.id);
      // Gleiche Linie wie beim Ändern: der Zuweiser und die Administrieren-Stufe.
      // NICHT der Empfänger — er würde sich sonst selbst Post schicken.
      if (a.von !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Erinnern darf nur, wer die Aufgabe gestellt hat", 403);
      }
      if (a.status !== "offen") {
        throw new VaFehler(
          a.status === "gemeldet"
            ? "Diese Aufgabe ist bereits als erledigt gemeldet und wartet auf deine Abnahme"
            : "Diese Aufgabe ist abgeschlossen — eine Erinnerung ginge ins Leere", 400);
      }
      if (a.empfaenger === ctx.session.username) {
        throw new VaFehler("Diese Aufgabe liegt bei dir selbst", 400);
      }
      // Sperrfrist. Sie steht INNERHALB der Mutation, damit zwei gleichzeitige Klicks
      // nicht beide durchkommen — der zweite Lauf sieht den geschriebenen Zeitstempel.
      const zuletzt = Date.parse(a.erinnertAm || "");
      if (zuletzt && Date.now() - zuletzt < VA_ERINNERUNG_SPERRE_MS) {
        const restMin = Math.ceil((VA_ERINNERUNG_SPERRE_MS - (Date.now() - zuletzt)) / 60000);
        const rest = restMin >= 60
          ? `${Math.ceil(restMin / 60)} Stunden`
          : `${restMin} Minuten`;
        throw new VaFehler(
          `An diese Aufgabe wurde vor Kurzem schon erinnert. Die nächste Erinnerung ist in ${rest} möglich.`, 429);
      }

      const r = a.ressortId ? vaRessortHolen(doc, a.ressortId) : null;
      a.erinnertAm = new Date().toISOString();
      a.erinnertVon = ctx.session.username;
      vaVerlauf(a, ctx.session.username, "erinnerung", "", "");
      return {
        erinnertAm: a.erinnertAm,
        pushAn: [a.empfaenger],
        mailInfo: {
          titel: a.titel || "", beschreibung: a.beschreibung || "", faellig: a.faellig || "",
          prioritaet: a.prioritaet || "normal", abnahme: !!a.abnahme, vertraulich: !!a.vertraulich,
          ressortName: (r && r.name) || "", erinnerung: true
        }
      };
    });

    // Beides steht AUSSERHALB von vaMutiere: dessen Callback läuft bei einem
    // If-Match-Konflikt bis zu dreimal, Mail und Push gingen sonst mehrfach raus.
    // Und wie beim Anlegen darf ein Versandfehler die Aktion nicht kippen — der
    // Zeitstempel ist da schon geschrieben —, wird aber in der Antwort benannt.
    let versand = { benachrichtigt: 0, ohneAdresse: [], mailAus: true };
    try {
      versand = await vaBenachrichtige(pushAn, mailInfo, ctx, env, authHeader);
    } catch (e) {
      console.error("vereinsaufgabe-erinnern: Benachrichtigung fehlgeschlagen", e && e.message);
    }
    // Der Push-Text nennt weder Titel noch Namen — er steht auf einem Sperrbildschirm.
    pushSenden(env, authHeader, execCtx, pushAn, "aufgaben",
      "Erinnerung: Bei dir ist noch eine Aufgabe offen. Öffne die Vereinsaufgaben und melde sie als erledigt, sobald du fertig bist.");
    return json({ ...antwort, ...versand }, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// Ändern darf nur der Zuweiser (und Administrieren) — der Empfänger nie. Sonst
// könnte er sich den Auftrag passend umschreiben und danach "erledigt" melden.
// Jede Änderung landet im Verlauf, mit altem und neuem Wert: eine stillschweigend
// verschobene Frist würde "überfällig" sonst wertlos machen.
async function handleVaAendern(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const ergebnis = await vaMutiere(authHeader, (doc) => {
      const a = vaAufgabeHolen(doc, body && body.id);
      if (a.von !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Nur wer die Aufgabe zugewiesen hat, kann sie ändern", 403);
      }
      if (["erledigt", "abgelehnt", "zurueckgezogen"].includes(a.status)) {
        throw new VaFehler("Ein abgeschlossener Vorgang wird nicht mehr geändert", 400);
      }
      const f = (body && body.felder) || {};
      const neuTitel = capStr(f.titel, VA_MAX_TITEL).trim();
      const neuFaellig = vaDatum(f.faellig);
      if (!neuTitel) throw new VaFehler("Der Titel darf nicht leer werden", 400);
      if (!neuFaellig) throw new VaFehler("Die Frist darf nicht leer werden", 400);
      const neuBeschreibung = capStr(f.beschreibung, VA_MAX_BESCHREIBUNG);
      const neuPrio = vaPrioritaet(f.prioritaet);

      if (neuTitel !== a.titel) { vaVerlauf(a, ctx.session.username, "titel", a.titel, neuTitel); a.titel = neuTitel; }
      if (neuFaellig !== a.faellig) { vaVerlauf(a, ctx.session.username, "faellig", a.faellig, neuFaellig); a.faellig = neuFaellig; }
      if (neuBeschreibung !== a.beschreibung) { vaVerlauf(a, ctx.session.username, "beschreibung", "", ""); a.beschreibung = neuBeschreibung; }
      if (neuPrio !== a.prioritaet) { vaVerlauf(a, ctx.session.username, "prioritaet", a.prioritaet, neuPrio); a.prioritaet = neuPrio; }
      return {};
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// Die Statusübergänge sind einzeln aufgezählt statt über einen generischen Setter
// abgebildet — so ist ein ungültiger Sprung (etwa "abgelehnt" -> "erledigt" durch
// den Empfänger) strukturell ausgeschlossen und nicht nur nicht vorgesehen.
async function handleVaStatus(request, body, env, authHeader, corsHeaders, execCtx) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const aktion = capStr(body && body.aktion, 20);
    const grund = capStr(body && body.grund, VA_MAX_GRUND).trim();

    const { pushAn, pushText, ...antwort } = await vaMutiere(authHeader, (doc) => {
      const a = vaAufgabeHolen(doc, body && body.id);
      const jetzt = new Date().toISOString();
      const binEmpfaenger = a.empfaenger === ctx.session.username;
      // Michel-Entscheidung 2026-08-03: Abnehmen und Zurueckgeben gehoeren
      // ausschliesslich dem, der die Aufgabe GESTELLT hat — Administrieren zaehlt
      // hier NICHT mit. Vorher stand "|| ctx.canAdmin" hier, und weil Sehen,
      // Bearbeiten und Administrieren in dieser App an fast denselben Gruppen
      // haengen, konnte ein Empfaenger mit Administrieren-Recht seine eigene
      // Meldung selbst abnehmen: erst "Erledigt melden", dann "Abnehmen" — die
      // verlangte Pruefung war mit zwei Klicks umgangen. Aendern, Zurueckziehen
      // und Loeschen behalten den Admin-Weg (Handler darunter): dort geht es um
      // Korrektur, nicht um das Urteil ueber eine geleistete Arbeit.
      const binZuweiser = a.von === ctx.session.username;
      const alt = a.status;
      // Neutral formuliert, ohne "dir": greift ein Administrierender ein, gehen
      // beide Beteiligten in denselben Versand.
      let text = "";

      if (aktion === "erledigt" || aktion === "gemeldet") {
        if (!binEmpfaenger) throw new VaFehler("Nur der Empfänger kann die Aufgabe abhaken", 403);
        if (a.status !== "offen") throw new VaFehler("Die Aufgabe ist nicht mehr offen", 400);
        // Verlangt der Zuweiser eine Abnahme, endet der Weg des Empfängers bei
        // "gemeldet" — er kann den Vorgang nicht selbst schließen.
        if (a.abnahme) {
          a.status = "gemeldet"; a.gemeldetAm = jetzt;
          text = "Eine Aufgabe wartet auf Abnahme";
        } else {
          a.status = "erledigt"; a.erledigtAm = jetzt;
          text = "Eine Aufgabe wurde als erledigt gemeldet";
        }
      } else if (aktion === "abgelehnt") {
        if (!binEmpfaenger) throw new VaFehler("Nur der Empfänger kann ablehnen", 403);
        if (a.status !== "offen") throw new VaFehler("Die Aufgabe ist nicht mehr offen", 400);
        if (!grund) throw new VaFehler("Eine Ablehnung braucht eine Begründung", 400);
        a.status = "abgelehnt"; a.abgelehntAm = jetzt; a.ablehnGrund = grund;
        text = "Eine Aufgabe wurde abgelehnt";
      } else if (aktion === "abgenommen") {
        if (!binZuweiser) throw new VaFehler("Nur wer die Aufgabe zugewiesen hat, kann abnehmen", 403);
        if (a.status !== "gemeldet") throw new VaFehler("Diese Aufgabe wartet nicht auf eine Abnahme", 400);
        a.status = "erledigt"; a.erledigtAm = jetzt;
        a.abgenommenAm = jetzt; a.abgenommenVon = ctx.session.username;
        text = "Deine erledigte Aufgabe wurde abgenommen. Damit ist sie abgeschlossen und steht nicht mehr in deiner offenen Liste.";
      } else if (aktion === "zurueckgegeben") {
        if (!binZuweiser) throw new VaFehler("Nur wer die Aufgabe zugewiesen hat, kann zurückgeben", 403);
        if (a.status !== "gemeldet") throw new VaFehler("Diese Aufgabe wartet nicht auf eine Abnahme", 400);
        if (!grund) throw new VaFehler("Eine Rückgabe braucht eine Begründung", 400);
        a.status = "offen"; a.gemeldetAm = ""; a.rueckgabeGrund = grund;
        text = "Eine Aufgabe wurde zur Nacharbeit an dich zurückgegeben. Der Grund steht in den Vereinsaufgaben, danach kannst du sie erneut melden.";
      } else {
        throw new VaFehler("Unbekannte Aktion", 400);
      }

      vaVerlauf(a, ctx.session.username, "status", alt, a.status);
      return { pushAn: vaPushBeteiligte(a, ctx), pushText: text };
    });
    // Außerhalb von vaMutiere, sonst ginge die Nachricht bei einem Konflikt bis zu
    // dreimal raus.
    pushSenden(env, authHeader, execCtx, pushAn, "aufgaben", pushText);
    return json(antwort, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// Zurückziehen kann nur der Zuweiser und nur solange nichts abgeschlossen ist.
// Der Eintrag bleibt als "zurueckgezogen" stehen statt zu verschwinden — sonst
// wäre nicht mehr erkennbar, dass es den Auftrag je gab.
async function handleVaZurueckziehen(request, body, env, authHeader, corsHeaders, execCtx) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const grund = capStr(body && body.grund, VA_MAX_GRUND).trim();
    const { pushAn, ...antwort } = await vaMutiere(authHeader, (doc) => {
      const a = vaAufgabeHolen(doc, body && body.id);
      if (a.von !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Nur wer die Aufgabe zugewiesen hat, kann sie zurückziehen", 403);
      }
      if (a.status !== "offen" && a.status !== "gemeldet") {
        throw new VaFehler("Dieser Vorgang ist bereits abgeschlossen", 400);
      }
      const alt = a.status;
      a.status = "zurueckgezogen";
      a.zurueckgezogenAm = new Date().toISOString();
      a.zurueckgezogenVon = ctx.session.username;
      a.zurueckgezogenGrund = grund;
      vaVerlauf(a, ctx.session.username, "status", alt, a.status);
      return { pushAn: vaPushBeteiligte(a, ctx) };
    });
    // Gerade hier wichtig: wer den Auftrag noch offen hat, soll nicht an etwas
    // weiterarbeiten, das es nicht mehr gibt.
    pushSenden(env, authHeader, execCtx, pushAn, "aufgaben",
      "Eine Aufgabe wurde zurückgezogen. Du musst dafür nichts mehr tun, sie steht nicht mehr in deiner offenen Liste.");
    return json(antwort, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// Holt eine abgeschlossene Aufgabe zurueck auf "offen" (seit 2026-08-03,
// Michel-Wunsch: ein versehentliches Zurueckziehen liess sich nicht heilen).
// Rechte bewusst wie beim Zurueckziehen (Zuweiser ODER Administrieren) und NICHT
// wie bei der Abnahme: das Wiedereroeffnen ist eine Korrektur, kein Urteil ueber
// geleistete Arbeit. Praktisch entscheidend — den Zustand kann ein eingreifender
// Admin erzeugt haben, dann muss er ihn auch zuruecknehmen koennen.
//
// Alle drei Endzustaende sind erlaubt (Michel-Entscheidung, ausdruecklich auch
// "erledigt"). Damit die wieder offene Aufgabe nichts Widerspruechliches mit sich
// traegt, werden die Abschluss-Felder geraeumt — ein stehengebliebenes
// erledigtAm liefe sonst in den CSV-Export und die Grund-Bloecke des Dialogs
// widersprechen dem Status. Was dabei verloren ginge, wird VORHER in den Verlauf
// geschrieben: die App ist ein Nachweis, eine Begruendung darf nicht spurlos
// verschwinden.
async function handleVaReaktivieren(request, body, env, authHeader, corsHeaders, execCtx) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const { pushAn, ...antwort } = await vaMutiere(authHeader, (doc) => {
      const a = vaAufgabeHolen(doc, body && body.id);
      if (a.von !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Nur wer die Aufgabe zugewiesen hat, kann sie wieder öffnen", 403);
      }
      if (a.status !== "erledigt" && a.status !== "abgelehnt" && a.status !== "zurueckgezogen") {
        throw new VaFehler("Diese Aufgabe läuft noch", 400);
      }
      const alt = a.status;
      // Erst sichern, was gleich geraeumt wird — sonst ist die Begruendung des
      // Empfaengers nach einer Reaktivierung nirgends mehr nachlesbar.
      const grundAlt = a.ablehnGrund || a.zurueckgezogenGrund || "";
      a.status = "offen";
      a.erledigtAm = "";
      a.gemeldetAm = "";
      a.abgenommenAm = "";
      a.abgenommenVon = "";
      a.abgelehntAm = "";
      a.ablehnGrund = "";
      a.zurueckgezogenAm = "";
      a.zurueckgezogenVon = "";
      a.zurueckgezogenGrund = "";
      vaVerlauf(a, ctx.session.username, "status", alt, a.status);
      if (grundAlt) vaVerlauf(a, ctx.session.username, "abschlussgrund", grundAlt, "");
      return { pushAn: vaPushBeteiligte(a, ctx) };
    });
    // Wie beim Zurueckziehen: wer den Auftrag abgehakt hatte, muss erfahren, dass
    // er wieder auf seinem Tisch liegt.
    pushSenden(env, authHeader, execCtx, pushAn, "aufgaben",
      "Eine abgeschlossene Aufgabe wurde wieder geöffnet. Sie steht damit erneut in deiner offenen Liste in den Vereinsaufgaben.");
    return json(antwort, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// Löschen darf der Ersteller (und Administrieren) — aber es hinterlässt eine Spur.
// Ohne das Protokoll könnte jeder, der zuweisen darf, seine eigene Bilanz
// bereinigen, und in der Übersicht wäre nicht einmal die Lücke sichtbar.
async function handleVaLoeschen(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    let dateien = [];
    const ergebnis = await vaMutiere(authHeader, (doc) => {
      const a = vaAufgabeHolen(doc, body && body.id);
      if (a.von !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Nur wer die Aufgabe zugewiesen hat, kann sie löschen", 403);
      }
      dateien = (a.anhaenge || []).map((f) => f.fileId).filter(Boolean);
      vaProtokoll(doc, {
        art: "geloescht", von: ctx.session.username,
        titel: a.titel, empfaenger: a.empfaenger, status: a.status, faellig: a.faellig
      });
      doc.aufgaben.splice(doc.aufgaben.findIndex((x) => x.id === a.id), 1);
      return {};
    });
    // Erst der Eintrag, dann die Bytes: bricht das Löschen der Datei ab, bleibt
    // eine verwaiste Datei liegen — harmloser als ein Verweis ins Leere.
    for (const fid of dateien) {
      if (!FILE_ID_RE.test(String(fid))) continue;
      try { await fetch(VA_ANHANG_DIR + "/" + fid, { method: "DELETE", headers: { Authorization: authHeader } }); }
      catch (_) { /* verwaiste Datei ist hinnehmbar */ }
    }
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// Eine Rückfrage bleibt sonst liegen, bis der andere zufällig hineinschaut —
// dasselbe Argument, mit dem beim Anlegen die Mail dazugekommen ist. Push geht an
// die andere Seite des Vorgangs, nicht an mitlesende Ressort-Mitglieder: die
// müssen nichts tun.
async function handleVaKommentar(request, body, env, authHeader, corsHeaders, execCtx) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const text = capStr(body && body.text, VA_MAX_KOMMENTAR).trim();
    if (!text) throw new VaFehler("Der Kommentar ist leer", 400);
    const { pushAn, ...antwort } = await vaMutiere(authHeader, (doc) => {
      const a = vaAufgabeHolen(doc, body && body.id);
      // An einer vertraulichen Aufgabe kommentiert nur, wer sie auch lesen darf —
      // sonst schriebe jemand in einen Strang, den er nicht sieht.
      if (!vaDarfInhaltSehen(a, ctx)) throw new VaFehler("Kein Zugriff auf diesen Vorgang", 403);
      if (!Array.isArray(a.kommentare)) a.kommentare = [];
      if (a.kommentare.length >= VA_MAX_KOMMENTARE) throw new VaFehler("Zu viele Rückfragen an diesem Vorgang", 400);
      a.kommentare.push({ id: crypto.randomUUID(), von: ctx.session.username, text, am: new Date().toISOString() });
      return { pushAn: vaPushBeteiligte(a, ctx) };
    });
    // Der Versand steht AUSSERHALB von vaMutiere: dessen Callback läuft bei einem
    // If-Match-Konflikt bis zu dreimal, die Nachricht ginge sonst mehrfach raus.
    // Der Text nennt weder Namen noch Titel noch den Wortlaut — er steht auf einem
    // Sperrbildschirm, den auch jemand anders sehen kann.
    pushSenden(env, authHeader, execCtx, pushAn, "aufgaben",
      "Zu einer Aufgabe gibt es eine neue Rückfrage oder Antwort. Der ganze Verlauf steht in den Vereinsaufgaben, dort kannst du antworten.");
    return json(antwort, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// ---------- Vereinsaufgaben: Anhänge ----------

// Die Datei-Id wird IMMER aus der Aufgabe aufgelöst, nie aus dem Body — sonst käme
// man mit einer geratenen Id an der Beteiligtenprüfung vorbei. Dieselbe Regel wie
// bei dokument-datei-get.
function vaDarfDateiSehen(a, ctx) {
  return vaDarfInhaltSehen(a, ctx);
}

async function handleVaDateiPut(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const rohDaten = String((body && body.daten) || "");
    const komma = rohDaten.indexOf(",");
    if (!rohDaten.startsWith("data:") || komma < 0) throw new VaFehler("Datei-Inhalt fehlt oder ist unlesbar", 400);
    const mime = capStr(rohDaten.slice(5, rohDaten.indexOf(";")), 120) || "application/octet-stream";
    let bytes;
    try { bytes = base64ToBytes(rohDaten.slice(komma + 1)); }
    catch (_) { throw new VaFehler("Datei-Inhalt ist kein gültiges base64", 400); }
    if (!bytes.length) throw new VaFehler("Leere Datei", 400);
    if (bytes.length > VA_MAX_ANHANG_BYTES) throw new VaFehler("Datei zu groß (höchstens 8 MB)", 413);

    const name = capStr(body && body.name, 200).replace(/[\r\n]/g, "").trim() || "anhang";
    const art = capStr(body && body.art, 20) === "nachweis" ? "nachweis" : "auftrag";
    const fileId = crypto.randomUUID();

    // Erst prüfen und die Bytes ablegen, dann verbuchen: ein Eintrag, der auf eine
    // nicht vorhandene Datei zeigt, wäre schlimmer als eine verwaiste Datei.
    await vaMutiere(authHeader, (doc) => {
      const a = vaAufgabeHolen(doc, body && body.id);
      if (!vaDarfDateiSehen(a, ctx)) throw new VaFehler("Kein Zugriff auf diesen Vorgang", 403);
      if (a.empfaenger !== ctx.session.username && a.von !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Nur die Beteiligten können einen Anhang hinzufügen", 403);
      }
      if ((a.anhaenge || []).length >= VA_MAX_ANHAENGE) throw new VaFehler("Zu viele Anhänge an diesem Vorgang", 400);
      return {};
    });

    const fileUrl = VA_ANHANG_DIR + "/" + fileId;
    const headers = { Authorization: authHeader, "Content-Type": mime };
    let resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
    // Gleicher MKCOL-Autofix wie überall: 409 = eine Ebene fehlt, 404 = mehrere
    // (der Fall beim allerersten Upload dieser App).
    if (resp.status === 409 || resp.status === 404) {
      await ensureCollection(VA_ANHANG_DIR, authHeader, 0);
      resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
    }
    if (!resp.ok) throw new VaFehler(`Upload fehlgeschlagen (Nextcloud ${resp.status})`, 502);

    const ergebnis = await vaMutiere(authHeader, (doc) => {
      const a = vaAufgabeHolen(doc, body && body.id);
      if (!Array.isArray(a.anhaenge)) a.anhaenge = [];
      a.anhaenge.push({ fileId, name, mime, art, von: ctx.session.username, hochgeladenAm: new Date().toISOString(), groesse: bytes.length });
      return { fileId };
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

async function handleVaDateiGet(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    const doc = vaNormalisiere(await readJson(VEREINSAUFGABEN_URL, authHeader, vaLeer()));
    const a = vaAufgabeHolen(doc, body && body.id);
    if (!vaDarfDateiSehen(a, ctx)) throw new VaFehler("Kein Zugriff auf diesen Vorgang", 403);
    const gesucht = String((body && body.fileId) || "");
    const meta = (a.anhaenge || []).find((f) => f && f.fileId === gesucht);
    if (!meta) throw new VaFehler("Anhang nicht gefunden", 404);
    if (!FILE_ID_RE.test(meta.fileId)) throw new VaFehler("Ungültige Datei-Id", 400);

    let resp;
    try { resp = await fetch(VA_ANHANG_DIR + "/" + meta.fileId, { method: "GET", headers: { Authorization: authHeader } }); }
    catch (_) { throw new VaFehler("Nextcloud nicht erreichbar", 502); }
    if (resp.status === 404) throw new VaFehler("Datei nicht gefunden", 404);
    if (!resp.ok) throw new VaFehler(`Nextcloud GET ${resp.status}`, 502);

    // Die Bytes werden durchgereicht, NICHT als base64 in eine JSON gepackt:
    // bytesToBase64 baut den String zeichenweise auf und würde bei mehreren
    // Megabyte das CPU-Limit des Workers reißen. Den Dateinamen hat der Client
    // ohnehin schon aus den Metadaten der Aufgabe — es braucht dafür keinen
    // eigenen Header und damit auch kein Access-Control-Expose-Headers.
    return new Response(resp.body, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": meta.mime || "application/octet-stream", "Cache-Control": "private, no-store" }
    });
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

async function handleVaDateiLoeschen(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    let fileId = "";
    const ergebnis = await vaMutiere(authHeader, (doc) => {
      const a = vaAufgabeHolen(doc, body && body.id);
      const gesucht = String((body && body.fileId) || "");
      const idx = (a.anhaenge || []).findIndex((f) => f && f.fileId === gesucht);
      if (idx < 0) throw new VaFehler("Anhang nicht gefunden", 404);
      const meta = a.anhaenge[idx];
      if (meta.von !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Nur wer den Anhang hochgeladen hat, kann ihn entfernen", 403);
      }
      fileId = meta.fileId;
      a.anhaenge.splice(idx, 1);
      return {};
    });
    if (FILE_ID_RE.test(fileId)) {
      try { await fetch(VA_ANHANG_DIR + "/" + fileId, { method: "DELETE", headers: { Authorization: authHeader } }); }
      catch (_) { /* verwaiste Datei ist hinnehmbar */ }
    }
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// Amtsübergabe: NUR offene Vorgänge wechseln den Empfänger. Erledigtes bleibt beim
// ursprünglichen Bearbeiter stehen — sonst schriebe ein Personalwechsel die
// Vergangenheit um und die Bilanz des Nachfolgers wäre falsch.
async function handleVaUebergabe(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeAdmin(ctx);
    const vonUser = normalizeUsername(body && body.vonUser);
    const aufUser = vaPruefeEmpfaenger(body && body.aufUser, ctx, ctx.session.usersDoc);
    if (!vonUser) throw new VaFehler("Von wem übertragen werden soll, fehlt", 400);
    if (vonUser === aufUser) throw new VaFehler("Das ist dieselbe Person", 400);

    const ergebnis = await vaMutiere(authHeader, (doc) => {
      const betroffen = doc.aufgaben.filter((a) =>
        a.empfaenger === vonUser && (a.status === "offen" || a.status === "gemeldet"));
      if (!betroffen.length) throw new VaFehler("Diese Person hat gerade keine offene Aufgabe", 400);
      betroffen.forEach((a) => {
        vaVerlauf(a, ctx.session.username, "empfaenger", a.empfaenger, aufUser);
        a.empfaenger = aufUser;
      });
      vaProtokoll(doc, { art: "uebergabe", von: ctx.session.username, vonUser, aufUser, anzahl: betroffen.length });
      return { uebertragen: betroffen.length };
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// ---------- Neuigkeiten: automatische Loeschung nach 14 Tagen ----------
//
// Michel-Vorgabe 2026-08-10: Meldungen verschwinden NEWS_MAX_ALTER_TAGE Tage nach
// ihrem Datum von selbst. Der Worker hat keinen Cron-Trigger (und soll keinen
// bekommen: ein per API konfigurierter Schedule stuende in keiner Repo-Datei und
// ginge bei einem spaeteren Deploy lautlos verloren) -- als Takt dienen die GETs
// der Landingpage, des meistaufgerufenen Pfads der Flotte. Der GET filtert
// Abgelaufene IMMER aus seiner Antwort (die Zusage haengt also nicht am Gelingen
// eines Schreiblaufs) und stoesst die Loeschung in ctx.waitUntil an; der Besucher
// wartet auf nichts.
//
// "Abgelaufen" heisst: das Datum DER MELDUNG (das Datumsfeld im Formular) liegt
// mehr als NEWS_MAX_ALTER_TAGE Kalendertage in Europe/Berlin zurueck. Ein Datum
// in der Zukunft laeuft nie ab; ein fehlendes oder kaputtes Datum loescht NICHTS
// (fail-safe Richtung Behalten -- save-news normiert ohnehin jedes Datum).

function newsAblaufGrenze() {
  // ISO-Datum in Berlin, verglichen als String -- gleiche Technik wie beim
  // Testspielplaner-Fenster. "abgelaufen" = Datum VOR (heute - 14 Tage).
  return new Date(Date.now() - NEWS_MAX_ALTER_TAGE * 86400000)
    .toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

function newsAbgelaufen(n, grenze) {
  const date = String((n && n.date) || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date < grenze;
}

// Entfernt abgelaufene Meldungen aus sichtbarkeit.json und raeumt danach deren
// Medien-Dateien und Reaktionen ab. Laeuft im Hintergrund hinter dem GET; jeder
// Fehlschlag ist bewusst still, denn der naechste GET wiederholt den Lauf -- ein
// Fehler fuer den Besucher waere hier der falsche Ort.
async function newsAbgelaufeneBereinigen(env, authHeader) {
  try {
    const grenze = newsAblaufGrenze();
    let entfernte = null;
    let verbliebene = null;
    // Konflikt-Wiederholung wie bei toggle-news-reaction: read-modify-write mit
    // If-Match, damit ein zeitgleicher Admin-Save (save-news/save-visibility)
    // nicht ueberschrieben wird. Alle fremden Schluessel der Datei (tools,
    // materialcontainer, ...) bleiben unangetastet.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: config, rev } = await readJsonWithRev(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
      if (!Array.isArray(config.news)) return;
      const frisch = config.news.filter((n) => !newsAbgelaufen(n, grenze));
      if (frisch.length === config.news.length) return; // ein anderes Isolate war schneller
      const weg = config.news.filter((n) => newsAbgelaufen(n, grenze));
      config.news = frisch;
      try {
        await writeJson(env.NEXTCLOUD_URL, authHeader, config, rev || undefined);
        entfernte = weg;
        verbliebene = frisch;
        break;
      } catch (e) {
        if (e instanceof ConflictError && attempt < 2) continue;
        return;
      }
    }
    if (!entfernte) return;

    // Medien-Bytes ERST NACH dem erfolgreichen Write loeschen -- andersherum
    // zeigte eine noch gespeicherte Meldung auf geloeschte Dateien. Eine Datei-Id
    // kann in einer verbliebenen Meldung erneut referenziert sein (Bearbeiten
    // kopiert die medien-Objekte samt Id): die bleibt dann liegen. Ein
    // fehlgeschlagenes DELETE ebenso -- ohne Referenz ist die Datei ueber
    // news-datei-get ohnehin unerreichbar (gleiche Linie wie beim Upload-Abbruch).
    const nochReferenziert = new Set();
    for (const n of verbliebene) {
      for (const m of (n && Array.isArray(n.medien) ? n.medien : [])) {
        if (m && m.id) nochReferenziert.add(String(m.id));
      }
    }
    for (const n of entfernte) {
      for (const m of (n && Array.isArray(n.medien) ? n.medien : [])) {
        const mid = String((m && m.id) || "");
        if (!FILE_ID_RE.test(mid) || nochReferenziert.has(mid)) continue;
        try { await fetch(NEUIGKEITEN_DIR + "/" + mid, { method: "DELETE", headers: { Authorization: authHeader } }); } catch (_) {}
      }
    }

    // Reaktionen der geloeschten Meldungen mitnehmen, sonst sammeln sich in
    // neuigkeiten-reaktionen.json verwaiste Eintraege mit jeder abgelaufenen
    // Meldung. hasOwnProperty-Filter: nur ECHTE eigene Schluessel loeschen.
    const ids = entfernte.map((n) => String((n && n.id) || "")).filter(Boolean);
    if (!ids.length) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: doc, rev } = await readJsonWithRev(NEWS_REACTIONS_URL, authHeader, { version: 1, byNews: {} });
      if (!doc.byNews || typeof doc.byNews !== "object") return;
      const treffer = ids.filter((id) => Object.prototype.hasOwnProperty.call(doc.byNews, id));
      if (!treffer.length) return;
      for (const id of treffer) delete doc.byNews[id];
      try {
        await writeJson(NEWS_REACTIONS_URL, authHeader, doc, rev || undefined);
        return;
      } catch (e) {
        if (e instanceof ConflictError && attempt < 2) continue;
        return;
      }
    }
  } catch (_) {
    // still: Hintergrundlauf ohne Adressat -- der naechste GET versucht es erneut
  }
}

// Speichert die Neuigkeiten (Array) im news-Key von sichtbarkeit.json. Admin-only,
// read-modify-write (erhält tools). Jede Meldung wird serverseitig validiert/normiert:
// Titel Pflicht, Typ auf erlaubte Werte, Datum auf YYYY-MM-DD (sonst heute), Längen
// gekappt, id vergeben falls fehlend. So kann ein manipulierter Client keine kaputten
// Daten ablegen. Der GET liefert news nur an Angemeldete und filtert Abgelaufene
// (siehe newsAbgelaufeneBereinigen oben). Hier wird bewusst NICHT gefiltert: ein
// Admin, der eine alt datierte Meldung speichert, soll sie nicht kommentarlos
// verschluckt sehen -- ausliefern wird sie der GET ohnehin nie.
async function handleSaveNews(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  if (!Array.isArray(body.news)) {
    return json({ error: "Ungültige Daten" }, 400, corsHeaders);
  }

  const today = new Date().toISOString().slice(0, 10);
  const clean = [];
  for (const n of body.news.slice(0, 100)) {
    if (!n || typeof n !== "object") continue;
    const title = String(n.title || "").trim().slice(0, 200);
    if (!title) continue; // Titel ist Pflicht
    const item = {
      id: /^[a-z0-9-]{1,40}$/i.test(String(n.id || "")) ? String(n.id) : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(n.date || "")) ? String(n.date) : today,
      type: NEWS_VALID_TYPES.includes(String(n.type)) ? String(n.type) : "hinweis",
      title,
      text: String(n.text || "").trim().slice(0, 1000)
    };
    const toolId = String(n.toolId || "").trim().slice(0, 60);
    if (toolId) item.toolId = toolId;

    // Medien-Anhänge: nur Id, Typ und Anzeigename. Die Bytes liegen im Ordner
    // neuigkeiten/ und werden über news-datei-get geholt.
    //
    // ⚠️ Der Client kann hier eine beliebige Datei-Id eintragen -- geprüft wird
    // die Existenz NICHT. Das ist unkritisch: news-datei-get liefert nur, was
    // wirklich unter dieser Id liegt, und eine geratene Id trifft nichts (UUID).
    // Umgekehrt gilt: was hier nicht (mehr) steht, ist über news-datei-get nicht
    // mehr abrufbar -- das Löschen einer Meldung entzieht ihren Bildern also
    // sofort den Zugang, auch wenn die Datei in Nextcloud liegen bleibt.
    const medien = [];
    for (const m of (Array.isArray(n.medien) ? n.medien : []).slice(0, NEWS_MAX_MEDIEN)) {
      if (!m || typeof m !== "object") continue;
      const mid = String(m.id || "");
      if (!FILE_ID_RE.test(mid)) continue;
      const mime = String(m.mime || "");
      if (!NEWS_MIME_ERLAUBT.includes(mime)) continue;
      if (medien.some((x) => x.id === mid)) continue;
      medien.push({
        id: mid,
        mime,
        art: mime.indexOf("video/") === 0 ? "video" : "bild",
        name: String(m.name || "").trim().slice(0, 120)
      });
    }
    if (medien.length) item.medien = medien;

    // Externer Videolink (Michel-Entscheidung 2026-08-03: Upload UND Link).
    // ⚠️ Nur https und nur als Verweis -- der Client bettet ihn NICHT als iframe
    // ein, sondern öffnet ihn auf Klick in einem neuen Tab. Eine Einbettung würde
    // beim bloßen Anzeigen der Startseite Daten an YouTube & Co. schicken, ohne
    // dass jemand darauf geklickt hat; das berührt den offenen Datenschutzpunkt
    // zu externen Diensten.
    const videoUrl = String(n.videoUrl || "").trim().slice(0, NEWS_MAX_VIDEO_URL);
    if (/^https:\/\/[^\s]+$/i.test(videoUrl)) item.videoUrl = videoUrl;

    clean.push(item);
  }

  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  config.version = config.version || 1;
  config.news = clean;
  try {
    await writeJson(env.NEXTCLOUD_URL, authHeader, config);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  return json({ news: config.news }, 200, corsHeaders);
}

// Medien-Anhang einer Neuigkeit hochladen (seit 2026-08-03). Admin-only, wie
// save-news selbst -- wer Meldungen schreiben darf, darf ihnen auch Bilder
// anhängen; eine zweite Rechtestufe dafür wäre Ballast.
//
// Die Datei geht VOR der Meldung raus (der Client lädt hoch, bekommt die Id und
// schickt sie dann mit save-news mit). Bricht er dazwischen ab, bleibt eine
// verwaiste Datei liegen -- dasselbe akzeptierte Muster wie beim
// Unterschriften-Upload. Sie ist dann über news-datei-get nicht erreichbar,
// weil dort gegen die Meldungen geprüft wird.
async function handleNewsDateiPut(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const id = String((body && body.id) || "");
  if (!FILE_ID_RE.test(id)) return json({ error: "Ungültige Datei-Id" }, 400, corsHeaders);

  let bytes;
  try {
    bytes = base64ToBytes(String((body && body.dataBase64) || ""));
  } catch (_) {
    return json({ error: "Datei-Inhalt ist kein gültiges base64" }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > MAX_FILE_BYTES) return json({ error: "Datei zu groß (max. 10 MB)" }, 413, corsHeaders);

  // Typ IMMER aus den Bytes, nie aus der Angabe des Clients: der ermittelte Wert
  // wird gespeichert und beim Abruf als Content-Type zurückgegeben.
  const typ = erkenneMedientyp(bytes);
  if (!typ) {
    return json({ error: "Nur Bilder (JPEG, PNG, GIF, WebP) und Videos (MP4, WebM) sind erlaubt" }, 400, corsHeaders);
  }

  const fileUrl = NEUIGKEITEN_DIR + "/" + id;
  const headers = { Authorization: authHeader, "Content-Type": typ.mime };
  let resp;
  try {
    resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
    // Gleicher MKCOL-Autofix wie bei dav-file-put: 409 = eine Ebene fehlt,
    // 404 = zwei oder mehr (der Fall beim allerersten Upload überhaupt).
    if (resp.status === 409 || resp.status === 404) {
      await ensureCollection(NEUIGKEITEN_DIR, authHeader, 0);
      resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
    }
  } catch (_) {
    return json({ error: "Nextcloud nicht erreichbar" }, 502, corsHeaders);
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);
  return json({ ok: true, id, mime: typ.mime, art: typ.art }, 200, corsHeaders);
}

// Medien-Anhang ausliefern. Jeder Angemeldete darf -- Neuigkeiten sind seit
// 2026-07-25 login-gated, und ihre Bilder gehören zur Meldung.
//
// ⚠️ Die Id wird gegen die MELDUNGEN geprüft, nicht bloß gegen den Ordner. Ohne
// das wäre die Aktion ein generischer Leseweg in neuigkeiten/ für jeden
// Angemeldeten. Mit der Prüfung gilt: was in keiner Meldung (mehr) steht, ist
// nicht abrufbar -- eine gelöschte Meldung entzieht ihren Bildern sofort den
// Zugang, ohne dass in Nextcloud etwas angefasst werden muss.
async function handleNewsDateiGet(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const id = String((body && body.id) || "");
  if (!FILE_ID_RE.test(id)) return json({ error: "Ungültige Datei-Id" }, 400, corsHeaders);

  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  let treffer = null;
  for (const n of (Array.isArray(config.news) ? config.news : [])) {
    for (const m of (n && Array.isArray(n.medien) ? n.medien : [])) {
      if (m && String(m.id) === id) { treffer = m; break; }
    }
    if (treffer) break;
  }
  if (!treffer) return json({ error: "Datei nicht gefunden" }, 404, corsHeaders);

  let resp;
  try {
    resp = await fetch(NEUIGKEITEN_DIR + "/" + id, { method: "GET", headers: { Authorization: authHeader } });
  } catch (_) {
    return json({ error: "Nextcloud nicht erreichbar" }, 502, corsHeaders);
  }
  if (resp.status === 404) return json({ error: "Datei nicht gefunden" }, 404, corsHeaders);
  if (!resp.ok) return json({ error: `Nextcloud GET ${resp.status}` }, 502, corsHeaders);

  const mime = NEWS_MIME_ERLAUBT.includes(String(treffer.mime)) ? String(treffer.mime) : "application/octet-stream";
  // private: der Browser darf es im eigenen Cache halten (das Karussell blättert
  // hin und her), aber kein Zwischenspeicher unterwegs -- die Meldungen sind
  // Vereinsinterna.
  return new Response(resp.body, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": mime, "Cache-Control": "private, max-age=300" }
  });
}

// ---------- Aktionen: Nutzerfotos ----------

// Auf WESSEN Konto wirkt ein schreibender Zugriff. Ohne Angabe im Body immer das
// eigene.
//
// ⚠️ Ein FREMDER Nutzername ist ausschließlich für Admins erlaubt. Ohne diese
// Schranke könnte jedes der ~200 Spielerkonten das Bild eines beliebigen anderen
// überschreiben oder löschen -- der Nutzername ist hier ja der Dateiname und damit
// frei zu erraten. Für alle anderen zählt allein der Name aus dem Token.
function nutzerfotoZielUser(session, body) {
  const eigen = normalizeUsername(session.username);
  const gewuenscht = String((body && body.username) || "").trim();
  if (!gewuenscht) return { username: eigen };
  const ziel = normalizeUsername(gewuenscht);
  if (ziel === eigen) return { username: ziel };
  if (!session.isAdmin) return { fehler: "Nur das eigene Foto darf geändert werden" };
  return { username: ziel };
}

function nutzerfotoUrl(username) {
  return NUTZERFOTOS_DIR + "/" + username;
}

// Bild hinterlegen. Der Client schickt ein fertig zugeschnittenes Quadrat; hier
// wird nur noch geprüft, gespeichert und der Zeitstempel nachgezogen.
async function handleNutzerfotoPut(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const ziel = nutzerfotoZielUser(session, body);
  if (ziel.fehler) return json({ error: ziel.fehler }, 403, corsHeaders);
  // Path-Traversal-Schutz wie bei dav-restricted-put: der Name wird zum Pfad, also
  // muss er dem strengen Muster genügen, bevor er irgendwo angehängt wird.
  if (!USERNAME_RE.test(ziel.username)) return json({ error: "Ungültiger Nutzername" }, 400, corsHeaders);

  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, ziel.username);
  if (!user) return json({ error: "Unbekannter Nutzer" }, 404, corsHeaders);

  let bytes;
  try {
    bytes = base64ToBytes(String((body && body.dataBase64) || ""));
  } catch (_) {
    return json({ error: "Bild-Inhalt ist kein gültiges base64" }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > NUTZERFOTO_MAX_BYTES) {
    return json({ error: "Bild zu groß (max. 512 KB)" }, 413, corsHeaders);
  }

  // Typ IMMER aus den ersten Bytes, nie aus der Angabe des Clients -- gleiche
  // Härtung wie bei den Neuigkeiten-Medien, hier zusätzlich auf Standbilder verengt.
  const typ = erkenneMedientyp(bytes);
  if (!typ || !NUTZERFOTO_MIME_ERLAUBT.includes(typ.mime)) {
    return json({ error: "Nur JPEG, PNG oder WebP sind als Foto erlaubt" }, 400, corsHeaders);
  }

  const headers = { Authorization: authHeader, "Content-Type": typ.mime };
  let resp;
  try {
    resp = await fetch(nutzerfotoUrl(ziel.username), { method: "PUT", headers, body: bytes });
    // 409 = eine Ordnerebene fehlt, 404 = zwei oder mehr (der Fall beim allerersten
    // Foto überhaupt). Gleicher MKCOL-Autofix wie bei dav-file-put.
    if (resp.status === 409 || resp.status === 404) {
      await ensureCollection(NUTZERFOTOS_DIR, authHeader, 0);
      resp = await fetch(nutzerfotoUrl(ziel.username), { method: "PUT", headers, body: bytes });
    }
  } catch (_) {
    return json({ error: "Nextcloud nicht erreichbar" }, 502, corsHeaders);
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);

  // ⚠️ Reihenfolge bindend: erst die Datei, dann der Zeitstempel. Andersherum
  // zeigte nutzer.json nach einem gescheiterten Upload auf ein Bild, das es nie
  // gab -- und jeder Client liefe in einen 404, den niemand erklären kann.
  user.fotoVersion = Date.now();
  // Einmal-Bonus fuers Hinterlegen (Regelversion 5). ⚠️ Nur fuers EIGENE Konto:
  // laedt ein Admin ein Bild fuer jemand anderen hoch, hat der dafuer nichts
  // getan. Die Sperre reist im selben writeJson mit, das ohnehin faellig ist.
  const bonusFaellig = normalizeUsername(session.username) === ziel.username
    && punkteEinmalBonusFaellig(user, "punkteBonusFotoAt");
  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  const antwort = json({ ok: true, username: ziel.username, fotoVersion: user.fotoVersion }, 200, corsHeaders);
  if (bonusFaellig) antwort.punkteBonus = { art: "foto", username: ziel.username };
  return antwort;
}

// Bild ausliefern. Jeder Angemeldete darf jedes Foto abrufen.
//
// ⚠️ Das ist eine bewusste Entscheidung von Michel (2026-08-04) und weicht von der
// Linie ab, die Spielerkonten sonst in diesem Worker aussperrt (Materialcontainer,
// Aufgaben, list-directory). Die Folge ist ausdrücklich gewollt und benannt: auch
// die ~200 Spielerkonten können jedes hinterlegte Foto abrufen, einschließlich der
// Fotos minderjähriger Kadermitglieder. Wer das enger ziehen will, ändert diese
// Funktion -- nicht den Client, der ist dafür keine Schranke.
async function handleNutzerfotoGet(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const gewuenscht = String((body && body.username) || "").trim();
  const username = normalizeUsername(gewuenscht || session.username);
  if (!USERNAME_RE.test(username)) return json({ error: "Ungültiger Nutzername" }, 400, corsHeaders);

  let resp;
  try {
    resp = await fetch(nutzerfotoUrl(username), { method: "GET", headers: { Authorization: authHeader } });
  } catch (_) {
    return json({ error: "Nextcloud nicht erreichbar" }, 502, corsHeaders);
  }
  if (resp.status === 404) return json({ error: "Kein Foto hinterlegt" }, 404, corsHeaders);
  if (!resp.ok) return json({ error: `Nextcloud GET ${resp.status}` }, 502, corsHeaders);

  // In diesen Ordner schreibt nur handleNutzerfotoPut, und der setzt den aus den
  // Bytes erkannten Typ. Die Whitelist ist trotzdem die Schranke, nicht Nextclouds
  // Angabe -- so kann eine von Hand dort abgelegte Datei nichts Fremdes ausliefern.
  const gemeldet = String(resp.headers.get("Content-Type") || "").split(";")[0].trim();
  const mime = NUTZERFOTO_MIME_ERLAUBT.includes(gemeldet) ? gemeldet : "application/octet-stream";

  // Kein max-age: die Aktionen dieses Workers laufen als POST, und POST-Antworten
  // legt kein Browser in seinen Cache. Wiederverwendet wird clientseitig über den
  // Blob-Cache, dessen Schlüssel die fotoVersion ist.
  return new Response(resp.body, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": mime, "Cache-Control": "private, no-store" }
  });
}

// Bild entfernen. Datei UND Zeitstempel -- bliebe fotoVersion stehen, suchte jeder
// Client weiter nach einem Bild, das es nicht mehr gibt.
async function handleNutzerfotoLoeschen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const ziel = nutzerfotoZielUser(session, body);
  if (ziel.fehler) return json({ error: ziel.fehler }, 403, corsHeaders);
  if (!USERNAME_RE.test(ziel.username)) return json({ error: "Ungültiger Nutzername" }, 400, corsHeaders);

  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, ziel.username);
  if (!user) return json({ error: "Unbekannter Nutzer" }, 404, corsHeaders);

  let resp;
  try {
    resp = await fetch(nutzerfotoUrl(ziel.username), { method: "DELETE", headers: { Authorization: authHeader } });
  } catch (_) {
    return json({ error: "Nextcloud nicht erreichbar" }, 502, corsHeaders);
  }
  // 404 = war schon weg. Für das Aufräumen ist das Erfolg, nicht Fehler.
  if (!resp.ok && resp.status !== 404) {
    return json({ error: `Nextcloud DELETE ${resp.status}` }, 502, corsHeaders);
  }

  delete user.fotoVersion;
  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  return json({ ok: true, username: ziel.username }, 200, corsHeaders);
}

// Wer hat überhaupt ein Foto, und in welchem Stand? Das ist der Baustein, mit dem
// eine Liste von 200 Spielern überhaupt tragbar wird.
//
// ⚠️ Diese Aktion liest KEINE einzige Bilddatei und löst deshalb keinen einzigen
// zusätzlichen Nextcloud-Read aus: nutzer.json steckt bereits in der Session. Eine
// Sammel-Aktion, die 200 Bilder in einem Aufruf einsammelt, wäre der naheliegende,
// aber falsche Weg -- ein Worker-Request darf nur begrenzt viele Unteranfragen
// stellen, und 200 Bilder in einer Antwort wären mehrere Megabyte.
async function handleNutzerfotoVersionen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const users = (session.usersDoc && session.usersDoc.users) || {};
  const versionen = {};
  const gefragt = body && Array.isArray(body.usernames) ? body.usernames : null;

  if (gefragt) {
    gefragt.slice(0, 1000).forEach((roh) => {
      const name = normalizeUsername(roh);
      const u = getOwn(users, name);
      if (u && u.fotoVersion) versionen[name] = u.fotoVersion;
    });
  } else {
    // Ohne Liste: alle, die eins haben. Reine Nutzernamen, keine Klarnamen --
    // und wer ein Foto abrufen darf, darf auch wissen, dass es existiert.
    Object.values(users).forEach((u) => {
      if (u && u.username && u.fotoVersion) versionen[u.username] = u.fotoVersion;
    });
  }

  return json({ versionen }, 200, corsHeaders);
}

// ---------- Aktionen: Feedback & Hilfe ----------

const FEEDBACK_VALID_TYPES = ["feedback", "wunsch"];

// Jeder eingeloggte Nutzer darf EINEN Eintrag anlegen (kein Admin-Gate) — anders als
// save-feedback nimmt diese Aktion nie ein ganzes Array vom Client entgegen, sondern
// baut genau einen Eintrag serverseitig zusammen. So kann ein Nutzer weder fremde
// Einträge überschreiben/löschen noch unter fremdem Namen einreichen.
async function handleSubmitFeedback(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const text = String(body.text || "").trim().slice(0, 2000);
  if (!text) return json({ error: "Text darf nicht leer sein" }, 400, corsHeaders);
  const type = FEEDBACK_VALID_TYPES.includes(String(body.type)) ? String(body.type) : "feedback";
  const toolId = String(body.toolId || "").trim().slice(0, 60);

  const user = getOwn(session.usersDoc.users, session.username) || {};
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    type,
    text,
    username: session.username,
    vorname: user.vorname || null,
    nachname: user.nachname || null,
    createdAt: new Date().toISOString(),
    done: false
  };
  if (toolId) entry.toolId = toolId;

  const doc = await readJson(FEEDBACK_URL, authHeader, { version: 1, entries: [] });
  doc.version = doc.version || 1;
  doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
  doc.entries.push(entry);
  if (doc.entries.length > 500) doc.entries = doc.entries.slice(doc.entries.length - 500);

  try {
    await writeJson(FEEDBACK_URL, authHeader, doc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  return json({ ok: true }, 200, corsHeaders);
}

async function handleListFeedback(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const doc = await readJson(FEEDBACK_URL, authHeader, { version: 1, entries: [] });
  return json({ entries: Array.isArray(doc.entries) ? doc.entries : [] }, 200, corsHeaders);
}

// Admin-only, kompletter Array-Ersatz (wie save-news) — Client schickt den lokal
// mutierten Stand (done getoggelt bzw. Eintrag entfernt) komplett zurück. Jeder
// Eintrag wird serverseitig neu zusammengebaut/validiert, kein Feld ungeprüft
// übernommen.
async function handleSaveFeedback(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  if (!Array.isArray(body.entries)) {
    return json({ error: "Ungültige Daten" }, 400, corsHeaders);
  }

  const clean = [];
  for (const f of body.entries.slice(0, 500)) {
    if (!f || typeof f !== "object") continue;
    const text = String(f.text || "").trim().slice(0, 2000);
    if (!text) continue; // Text ist Pflicht
    const item = {
      id: /^[a-z0-9-]{1,40}$/i.test(String(f.id || "")) ? String(f.id) : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
      type: FEEDBACK_VALID_TYPES.includes(String(f.type)) ? String(f.type) : "feedback",
      text,
      username: String(f.username || "").trim().slice(0, 32) || null,
      vorname: f.vorname ? String(f.vorname).trim().slice(0, 100) : null,
      nachname: f.nachname ? String(f.nachname).trim().slice(0, 100) : null,
      createdAt: /^\d{4}-\d{2}-\d{2}T/.test(String(f.createdAt || "")) ? String(f.createdAt) : new Date().toISOString(),
      done: !!f.done
    };
    const toolId = String(f.toolId || "").trim().slice(0, 60);
    if (toolId) item.toolId = toolId;
    // ⚠️ Die Antwortfelder MÜSSEN hier mitwandern, obwohl sie nur über
    // feedback-antwort entstehen: diese Aktion ersetzt das ganze Array, und der
    // Client schickt seinen lokalen Stand zurueck. Ohne diese drei Zeilen loescht
    // ein blosses Setzen des Erledigt-Hakens jede bereits gegebene Antwort --
    // und der Einreicher haette sie danach nirgends mehr.
    const antwort = String(f.antwort || "").trim().slice(0, 2000);
    if (antwort) {
      item.antwort = antwort;
      item.antwortVon = f.antwortVon ? String(f.antwortVon).trim().slice(0, 100) : null;
      item.antwortAm = /^\d{4}-\d{2}-\d{2}T/.test(String(f.antwortAm || "")) ? String(f.antwortAm) : new Date().toISOString();
    }
    clean.push(item);
  }

  const doc = { version: 1, entries: clean };
  try {
    await writeJson(FEEDBACK_URL, authHeader, doc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  return json({ entries: doc.entries }, 200, corsHeaders);
}

// Antwort an GENAU einen Eintrag (Admin) plus Push an den Einreicher.
//
// Bewusst eine eigene schmale Aktion statt eines weiteren Feldes in
// save-feedback: dort schickt der Client das ganze Array zurueck, und der Worker
// koennte "neue Antwort" nicht von "unveraendert mitgeschickt" unterscheiden --
// jedes Setzen eines Erledigt-Hakens loeste dann eine zweite Push-Nachricht zu
// einer laengst gelesenen Antwort aus. Hier ist der Versand an die Handlung
// gebunden, die ihn meint.
//
// Leerer Text loescht die Antwort wieder (Tippfehler zuruecknehmen) und schickt
// dann natuerlich nichts.
async function handleFeedbackAntwort(request, body, env, authHeader, corsHeaders, execCtx) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const id = String(body.id || "").trim();
  if (!/^[a-z0-9-]{1,40}$/i.test(id)) return json({ error: "Ungültige Id" }, 400, corsHeaders);
  const text = String(body.text || "").trim().slice(0, 2000);

  const doc = await readJson(FEEDBACK_URL, authHeader, { version: 1, entries: [] });
  doc.version = doc.version || 1;
  doc.entries = Array.isArray(doc.entries) ? doc.entries : [];

  const eintrag = doc.entries.find((f) => f && String(f.id) === id);
  if (!eintrag) return json({ error: "Eintrag nicht gefunden" }, 404, corsHeaders);

  const antworter = getOwn(session.usersDoc.users, session.username) || {};
  if (text) {
    eintrag.antwort = text;
    eintrag.antwortVon = (antworter.vorname && antworter.nachname)
      ? `${antworter.vorname} ${antworter.nachname}`
      : session.username;
    eintrag.antwortAm = new Date().toISOString();
  } else {
    delete eintrag.antwort;
    delete eintrag.antwortVon;
    delete eintrag.antwortAm;
  }

  try {
    await writeJson(FEEDBACK_URL, authHeader, doc); // unconditional, wie handleSubmitFeedback -- akzeptiertes Race-Risiko
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  // ⚠️ Der Empfaenger kommt aus dem EINTRAG, nie aus dem Request -- sonst
  // koennte ein Admin die Aktion als beliebigen Nachrichtenversand benutzen.
  // Nach dem Schreiben, damit ein Push-Fehler die Antwort nicht mitreisst.
  if (text && eintrag.username) {
    const kurz = text.length > 120 ? text.slice(0, 120) + "…" : text;
    pushSenden(env, authHeader, execCtx, [eintrag.username], "feedback",
      "Deine Rückmeldung wurde beantwortet: " + kurz);
  }

  return json({ entry: eintrag }, 200, corsHeaders);
}

// Die eigenen Einreichungen samt Antwort (jeder Angemeldete). Ohne diesen Weg
// fuehrte die Push-Nachricht ins Leere: der Einreicher sieht sein eigenes
// Feedback sonst nirgends wieder, list-feedback ist admin-only.
//
// ⚠️ Gefiltert wird auf session.username, NICHT auf einen Namen aus dem Body --
// sonst waere das die admin-only Liste fuer jeden.
async function handleMeineFeedbacks(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const doc = await readJson(FEEDBACK_URL, authHeader, { version: 1, entries: [] });
  const alle = Array.isArray(doc.entries) ? doc.entries : [];
  const meine = alle
    .filter((f) => f && normalizeUsername(String(f.username || "")) === normalizeUsername(session.username))
    .map((f) => ({
      id: f.id,
      type: f.type,
      text: f.text,
      toolId: f.toolId || null,
      createdAt: f.createdAt,
      done: !!f.done,
      antwort: f.antwort || null,
      antwortVon: f.antwortVon || null,
      antwortAm: f.antwortAm || null
    }));

  return json({ entries: meine }, 200, corsHeaders);
}

// ---------- Aktionen: Admin-Dashboard-Statistik ----------

// Liefert sechs Kennzahlen für die Admin-Dashboard-Kachel, alle serverseitig
// aus bereits bestehenden Datenquellen berechnet (kein neues Speicherformat).
// Trainervertrag-/Trainerkodex-Quote beziehen sich auf die Mitglieder der
// Gruppe TRAINER_GROUP_NAME — existiert die Gruppe noch nicht, liefert diese
// Aktion trainerGroup.exists:false statt einer irreführenden 0-von-0-Quote.
async function handleGetAdminStats(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const usersDoc = session.usersDoc;
  // Alle Quoten dieser Statistik (Vertrag, Kodex, Jugendschutz, Passwort gesetzt)
  // meinen Personal -- ein Spieler zieht sie sonst dauerhaft nach unten, ohne dass
  // es je etwas zu erfüllen gäbe. Spieler bekommen ihre eigene, schlichte Zahl.
  const alleUsers = Object.values(usersDoc.users);
  const users = alleUsers.filter(istPersonal);
  const usersTotal = users.length;
  const usersPasswordSet = users.filter((u) => u.mustSetPassword === false).length;
  const spielerAlle = alleUsers.filter((u) => !istPersonal(u));
  const spielerTotal = spielerAlle.length;
  const spielerPasswordSet = spielerAlle.filter((u) => u.mustSetPassword === false).length;

  const trainerGroup = Object.values(usersDoc.groups || {}).find((g) => g.name === TRAINER_GROUP_NAME) || null;
  // Archivierte Trainer (Personalakte) werden hier ausgeklammert: sie reichen
  // per Definition nie wieder Trainerdaten ein/bestätigen nie wieder den Kodex
  // und würden die beiden Quoten sonst dauerhaft künstlich nach unten ziehen.
  const trainerUsernames = trainerGroup
    ? (trainerGroup.memberUsernames || []).filter((uname) => {
        const u = getOwn(usersDoc.users, uname);
        return !(u && u.archiviert);
      })
    : [];

  // Trainervertrag ist NICHT auf Mitglieder der Gruppe "Trainer" beschränkt --
  // manche Nutzer (z.B. Helfer/Betreuer) sind keine Trainer im engeren Sinn,
  // brauchen aber trotzdem einen Vertrag (User-Entscheidung 2026-07-12, siehe
  // vertragBenoetigt-Feld/Checkbox in der Nutzerverwaltung). Trainerkodex
  // bleibt bewusst auf trainerUsernames/Gruppe Trainer beschränkt.
  const vertragspflichtigeUsernames = Array.from(new Set([
    ...trainerUsernames,
    ...users.filter((u) => u.vertragBenoetigt && !u.archiviert).map((u) => u.username)
  ]));

  // trainerkodexDoc/DAV_APPS.trainerkodex seit 1.6 nicht mehr nötig -- Trainerkodex
  // ist Teil von Trainerdaten geworden (siehe [[project-trainerkodex]]), die Quote
  // unten liest jetzt aus trainerdatenByUsername statt einem eigenen Lookup.
  const [feedbackDoc, trainerdatenDoc, materialbedarfDoc, busplanDoc, testspielplanerDoc] = await Promise.all([
    readJson(FEEDBACK_URL, authHeader, { version: 1, entries: [] }),
    readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] }),
    readJson(DAV_APPS.materialbedarf, authHeader, { meldungen: [] }),
    readJson(DAV_APPS.busplan, authHeader, { meta: {}, seasons: {} }),
    readJson(DAV_APPS.testspielplaner, authHeader, { reservierungen: [] })
  ]);

  const trainerdatenByUsername = new Map();
  (Array.isArray(trainerdatenDoc.trainer) ? trainerdatenDoc.trainer : []).forEach((t) => {
    if (t.username) trainerdatenByUsername.set(t.username, t);
  });

  // Trainervertrag-Status je Gruppenmitglied: seit dem admin-getriebenen
  // "generate-pdfs.ps1 -Zuweisen"-Stapel-Workflow kann ein Vertrag erstellt sein,
  // OHNE dass der Trainer sich je selbst eingeloggt/eingereicht hat — solche
  // Datensätze haben kein username-Feld und wurden von der reinen
  // trainerdatenByUsername-Map (unten nur noch für Trainerkodex gebraucht) nie
  // gefunden. Deshalb hier dieselbe namens-tolerante Match-Kaskade wie
  // buildTrainerRecord/Personalakte (findTrainerdatenRecord) plus dieselbe
  // Status-Ableitung wie Trainerdatens eigene _trainerStatus()/statusLabel
  // (buildTrainerdatenSummary liefert exakt "unvollstaendig"|"ausstehend"|"generiert").
  const trainervertragStatusCounts = { unvollstaendig: 0, ausstehend: 0, generiert: 0 };
  vertragspflichtigeUsernames.forEach((uname) => {
    const user = getOwn(usersDoc.users, uname);
    const record = findTrainerdatenRecord(trainerdatenDoc, user);
    const status = buildTrainerdatenSummary(record).status;
    trainervertragStatusCounts[status] = (trainervertragStatusCounts[status] || 0) + 1;
  });

  // Trainerkodex + Jugendschutzkonzept: bestätigt sich der Trainer ausschließlich
  // selbst im eigenen Login-Bereich (kein Admin-Batch-Äquivalent wie beim Vertrag
  // oben) — ein Datensatz ohne username kann daher nie kodex-/jugendschutzBestaetigtAm
  // tragen, die einfachere username-Map genügt hier weiterhin. Beide Quoten zählen
  // (wie schon der Kodex) reines "jemals bestätigt", nicht die 6-Monats-Gültigkeit.
  const trainerkodexBestaetigt = trainerUsernames.filter((uname) => {
    const t = trainerdatenByUsername.get(uname);
    return !!(t && t.kodexBestaetigtAm);
  }).length;
  const jugendschutzBestaetigt = trainerUsernames.filter((uname) => {
    const t = trainerdatenByUsername.get(uname);
    return !!(t && t.jugendschutzBestaetigtAm);
  }).length;

  const meldungen = Array.isArray(materialbedarfDoc.meldungen) ? materialbedarfDoc.meldungen : [];
  const materialbedarfOffen = meldungen.filter((m) => m.status === "offen").length;

  // Testspielplaner: Anfragen, die auf eine Admin-Entscheidung warten.
  const tspReservierungen = Array.isArray(testspielplanerDoc.reservierungen) ? testspielplanerDoc.reservierungen : [];
  const testspielplanerAngefragt = tspReservierungen.filter((r) => r.status === "angefragt").length;

  // "Zuletzt angemeldet"-Liste im Admin-Dashboard — dieselbe bereits geladene
  // nutzer.json, nur nach lastLoginAt sortiert statt gezählt.
  //
  // ⚠️ Die drei Schwesterlisten (Trainervertrag/Trainerkodex/Jugendschutzkonzept)
  // sind am 2026-08-10 mit dem Dropdown im Dashboard entfallen (Michel-Vorgabe:
  // statt vier kurzer Listen eine längere Anmeldeliste) und wurden hier ersatzlos
  // entfernt -- sie hatten danach keinen Leser mehr. Wer sie zurückholt, findet
  // sie samt trainervertragEingereichtAm() in E:\_worker-archiv\ (Stände bis
  // landingpage-20260810-*.js). Die Parität zu Trainerdatens _eingereichtAm hängt
  // seitdem allein an buildTrainerdatenSummary() weiter unten in dieser Datei.
  const topRecent = (entries, limit) => entries
    .filter((e) => e.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit)
    .map((e) => {
      const u = getOwn(usersDoc.users, e.username);
      return { username: e.username, vorname: (u && u.vorname) || "", nachname: (u && u.nachname) || "", at: e.at };
    });

  // users ist bereits auf Personal gefiltert (siehe oben) -- die Liste zeigt also
  // wie bisher keine Spielerkonten. Bei ~200 davon bestünde sie sonst schnell nur
  // aus ihnen, und gemeint sind die Kolleginnen und Kollegen.
  const recentLogins = topRecent(users.map((u) => ({ username: u.username, at: u.lastLoginAt })), 10);

  const feedbackEntries = Array.isArray(feedbackDoc.entries) ? feedbackDoc.entries : [];
  const feedbackOffen = feedbackEntries.filter((f) => !f.done).length;

  // Busplan: nur aktuelle Saison zählen (wie E:\Busplan\app.js, Anzeige der
  // Übersicht) — offene/klärungsbedürftige Zusagen über alle Mannschaften,
  // Spiele und deren Bus-Optionen.
  const currentSeasonKey = busplanDoc.meta && busplanDoc.meta.currentSeason;
  const season = currentSeasonKey ? (busplanDoc.seasons || {})[currentSeasonKey] : null;
  let busplanOffen = 0;
  if (season && Array.isArray(season.teams)) {
    season.teams.forEach((t) => {
      const busOptionIds = Array.isArray(t.busOptionIds) ? t.busOptionIds : [];
      (t.spiele || []).forEach((sp) => {
        busOptionIds.forEach((oid) => {
          const wert = (sp.status && sp.status[oid]) ? sp.status[oid].wert : "";
          if (wert === "offen" || wert === "klaerung") busplanOffen++;
        });
      });
    });
  }

  return json({
    // users zählt ab sofort nur noch Personal. Solange keine Spielerkonten
    // existieren (spieler.total === 0), sind das exakt dieselben Zahlen wie vorher --
    // die Kachel im Admin-UI ändert sich also erst, wenn es wirklich Spieler gibt.
    users: { total: usersTotal, passwordSet: usersPasswordSet },
    spieler: { total: spielerTotal, passwordSet: spielerPasswordSet },
    trainerGroup: { exists: !!trainerGroup, memberCount: trainerUsernames.length },
    trainervertrag: {
      total: vertragspflichtigeUsernames.length,
      generiert: trainervertragStatusCounts.generiert,
      ausstehend: trainervertragStatusCounts.ausstehend,
      unvollstaendig: trainervertragStatusCounts.unvollstaendig
    },
    trainerkodex: { confirmed: trainerkodexBestaetigt, total: trainerUsernames.length },
    jugendschutz: { confirmed: jugendschutzBestaetigt, total: trainerUsernames.length },
    feedbackOpen: feedbackOffen,
    materialbedarfOpen: materialbedarfOffen,
    busplanOpen: busplanOffen,
    testspielplanerAngefragt,
    recentLogins
  }, 200, corsHeaders);
}

// ---------- Aktionen: Personalakte ----------

// Baut EINEN zusammengeführten Trainer-Datensatz aus nutzer.json + sechs parallel
// gelesenen App-Dateien. Wird sowohl für die Übersicht (einmal je Mitglied der
// Trainer-Gruppe) als auch für archive-trainer (einmal, frisch, für genau eine
// Person) verwendet -- ein Join, zwei Aufrufer.
// Trainerdaten: gemeinsame Match-Kaskade, auch von handleMyTrainerdatenStatus
// (Status-Badge auf der Trainerdaten-Kachel) genutzt -- ein Ort für den Join.
// Match-Reihenfolge: echter username (reale Einreichung) > linkedUsername
// (Provisioning-Stub vor Erstlogin, siehe provisionTrainerdaten) > Namensfallback
// (sameNamePair reihenfolge-tolerant, gleicher Grund wie TrainerCheckliste).
function findTrainerdatenRecord(trainerdatenDoc, user) {
  if (!user) return null;
  const list = trainerdatenDoc.trainer || [];
  // Username-Treffer haben Vorrang ueber das GANZE Array, erst dann linkedUsername,
  // erst dann Namensabgleich -- exakt dieselbe Rangfolge wie die Schreibpfade
  // (submit-worker.js handleSubmit/resolveOwnTrainerRecord). Die fruehere einzelne
  // .find()-ODER-Kette nahm stattdessen den ERSTEN Record, der irgendein Kriterium
  // erfuellte: stand ein namensgleicher Import-Stub (ohne Dokumente/Unterschrift)
  // vor dem echten Datensatz, las die Ampel den Stub und blieb rot, obwohl der
  // Trainer auf seinem echten Datensatz alles erfuellt hatte.
  return list.find((t) => t.username && t.username === user.username) ||
         list.find((t) => t.linkedUsername && sameText(t.linkedUsername, user.username)) ||
         list.find((t) => sameNamePair(t.vorname, t.nachname, user.vorname, user.nachname)) ||
         null;
}

// Status/Verlaufsfelder plus seit 2026-07-08 zusaetzlich Geburtsdatum/Adresse/
// Telefon/E-Mail (expliziter User-Wunsch, damit die Personalakte diese
// Basisdaten zeigen kann) -- IBAN/Bankverbindung bleiben weiterhin
// ausgeschlossen, dafuer gibt es PROVISION_ONLY_PATHS ueberhaupt.
// trainerlizenzHochgeladenAm: reiner Status wie fuehrungszeugnisEingereichtAm.
// trainerlizenzNichtVorhanden/Art/GueltigBis: seit 2026-07-09, vorher fehlten
// diese drei hier (Lücke, u.a. Personalaktes Lizenzanzeige betreffend).
// Führerschein-Gültigkeit seit 1.1 hier statt in Fahrtenbuch berechnet (Feature
// dorthin migriert, siehe [[project-trainerdaten]]) -- gleiche Formel wie vorher
// (hochgeladenAm + 6 Monate). Führungszeugnis hat bewusst keine Ablauflogik (v1).
// kodexBestaetigtAm/kodexSignatureDataUrl/kodexVersion (seit 1.6): Trainerkodex ist
// in Trainerdaten aufgegangen (siehe [[project-trainerkodex]]), gleiche 6-Monats-
// Ablauflogik wie beim Führerschein, aber unabhängig davon berechnet.
// jugendschutzBestaetigtAm/jugendschutzSignatureDataUrl/jugendschutzVersion (seit
// Trainerdaten 1.7): Kinder- und Jugendschutzkonzept, eigenständiges Dokument neben
// dem Kodex, gleiche 6-Monats-Ablauflogik, unabhängig davon berechnet.
function buildTrainerdatenSummary(td) {
  let fuehrerscheinGueltigBis = null, fuehrerscheinGueltig = null;
  if (td && td.fuehrerscheinHochgeladenAm) {
    const faellig = new Date(td.fuehrerscheinHochgeladenAm);
    faellig.setMonth(faellig.getMonth() + 6);
    fuehrerscheinGueltigBis = faellig.toISOString();
    fuehrerscheinGueltig = faellig.getTime() > Date.now();
  }
  let kodexGueltigBis = null, kodexGueltig = null;
  if (td && td.kodexBestaetigtAm) {
    const faellig = new Date(td.kodexBestaetigtAm);
    faellig.setMonth(faellig.getMonth() + 6);
    kodexGueltigBis = faellig.toISOString();
    kodexGueltig = faellig.getTime() > Date.now();
  }
  let jugendschutzGueltigBis = null, jugendschutzGueltig = null;
  if (td && td.jugendschutzBestaetigtAm) {
    const faellig = new Date(td.jugendschutzBestaetigtAm);
    faellig.setMonth(faellig.getMonth() + 6);
    jugendschutzGueltigBis = faellig.toISOString();
    jugendschutzGueltig = faellig.getTime() > Date.now();
  }
  return td ? {
    vorhanden: true,
    trainerId: td.id || null,
    // Fallback wie _eingereichtAm() in Trainerdatens app.js: Einreichungen von vor
    // submit-worker 1.5 (2026-07-07) haben eine echte Signatur, aber noch kein
    // unterschriftAm-Feld -- ohne den Fallback blieb die Ampel fuer solche Trainer
    // dauerhaft rot, obwohl Admin-Liste/Detail (mit Fallback) "eingereicht" zeigen.
    unterschriftAm: td.unterschriftAm || ((td.signaturVorhanden || td.signatureDataUrl) ? td.erstelltAm : null) || null,
    erstelltAm: td.erstelltAm || null,
    vertragsGeneriert: !!td.vertragsGeneriert,
    // vertragPdfBereitgestelltAm/vertragUnterschriebenAm (seit Trainerdaten 1.10):
    // der digitale Signier-Workflow -- eigene Felder, getrennt vom alten Word-
    // Batch-Flag vertragsGeneriert. Ohne diese beiden hier zeigte Personalakte
    // "Vertrag ausstehend" auch fuer laengst digital unterschriebene Vertraege.
    vertragPdfBereitgestelltAm: td.vertragPdfBereitgestelltAm || null,
    vertragUnterschriebenAm: td.vertragUnterschriebenAm || null,
    // vertragUnterschriebenAm zaehlt hier wie vertragsGeneriert als "generiert" --
    // zwei gleichwertige Wege zum selben Ziel (unterschriebener Vertrag).
    status: td.status || ((td.vertragsGeneriert || td.vertragUnterschriebenAm) ? "generiert" : (td.username ? "ausstehend" : "unvollstaendig")),
    fuehrerscheinHochgeladenAm: td.fuehrerscheinHochgeladenAm || null,
    fuehrerscheinGueltigBis, fuehrerscheinGueltig,
    fuehrungszeugnisEingereichtAm: td.fuehrungszeugnisEingereichtAm || null,
    trainerlizenzHochgeladenAm: td.trainerlizenzHochgeladenAm || null,
    trainerlizenzNichtVorhanden: !!td.trainerlizenzNichtVorhanden,
    trainerlizenzArt: td.trainerlizenzArt || null,
    trainerlizenzGueltigBis: td.trainerlizenzGueltigBis || null,
    kodexBestaetigtAm: td.kodexBestaetigtAm || null,
    kodexSignatureDataUrl: td.kodexSignatureDataUrl || null,
    kodexVersion: td.kodexVersion || null,
    kodexGueltigBis, kodexGueltig,
    jugendschutzBestaetigtAm: td.jugendschutzBestaetigtAm || null,
    jugendschutzSignatureDataUrl: td.jugendschutzSignatureDataUrl || null,
    jugendschutzVersion: td.jugendschutzVersion || null,
    jugendschutzGueltigBis, jugendschutzGueltig,
    geburtsdatum: td.geburtsdatum || null,
    strasse: td.strasse || null,
    plz: td.plz || null,
    ort: td.ort || null,
    telefon: td.telefon || null,
    email: td.email || null
  } : {
    vorhanden: false, trainerId: null, unterschriftAm: null, erstelltAm: null, vertragsGeneriert: false,
    vertragPdfBereitgestelltAm: null, vertragUnterschriebenAm: null, status: "unvollstaendig",
    fuehrerscheinHochgeladenAm: null, fuehrerscheinGueltigBis: null, fuehrerscheinGueltig: null, fuehrungszeugnisEingereichtAm: null,
    trainerlizenzHochgeladenAm: null, trainerlizenzNichtVorhanden: false, trainerlizenzArt: null, trainerlizenzGueltigBis: null,
    kodexBestaetigtAm: null, kodexSignatureDataUrl: null, kodexVersion: null, kodexGueltigBis: null, kodexGueltig: null,
    jugendschutzBestaetigtAm: null, jugendschutzSignatureDataUrl: null, jugendschutzVersion: null, jugendschutzGueltigBis: null, jugendschutzGueltig: null,
    geburtsdatum: null, strasse: null, plz: null, ort: null, telefon: null, email: null
  };
}

function buildTrainerRecord(user, usersDoc, sources) {
  const { trainerdatenDoc, checklisteDoc, personalkostenDoc, kadermanagerDoc } = sources;
  const fullName = `${user.vorname || ""} ${user.nachname || ""}`.trim();
  const fullNameReversed = `${user.nachname || ""} ${user.vorname || ""}`.trim();

  const td = findTrainerdatenRecord(trainerdatenDoc, user);
  const trainerdaten = buildTrainerdatenSummary(td);

  // Trainerkodex: seit 1.6 Teil von Trainerdaten (siehe [[project-trainerkodex]]),
  // kein separates trainerkodexDoc/DAV_APPS.trainerkodex-Lookup mehr -- dieselbe
  // Ausgabeform wie vorher (bestaetigt/datum/kodexVersion), Personalakte braucht
  // dafür keine Client-Änderung.
  const trainerkodex = {
    bestaetigt: !!trainerdaten.kodexBestaetigtAm,
    datum: trainerdaten.kodexBestaetigtAm,
    kodexVersion: trainerdaten.kodexVersion
  };

  // TrainerCheckliste: exakt dieselbe Match-Konvention wie provisionTrainercheckliste
  // ("name" ist in dieser App das Nachname-Feld, nicht der volle Name). Namens-
  // Reihenfolge via sameNamePair toleriert (manuell angelegte Eintraege ohne
  // linkedUsername vertauschen Vorname/Nachname in der Praxis gelegentlich).
  const eintrag = (checklisteDoc.trainerEintraege || []).find((e) =>
    (e.linkedUsername && sameText(e.linkedUsername, user.username)) ||
    sameNamePair(e.vorname, e.name, user.vorname, user.nachname));
  const sectionSummary = (s) => s
    ? { abgeschlossen: !!s.abgeschlossen, datum: s.datum || s.headerDatum || null }
    : { abgeschlossen: false, datum: null };
  const trainercheckliste = {
    zugang: sectionSummary(eintrag && eintrag.zugang),
    abgang: sectionSummary(eintrag && eintrag.abgang)
  };

  // Personalkosten: aktuelle Saison, "name" ist dort der VOLLE Name (siehe
  // provisionPersonalkosten) -- Rohfelder, keine AE-Euro-Formel neu berechnen
  // (drittes Duplikat dieser Formel wäre ein Drift-Risiko, siehe Trainerdaten-
  // CLAUDE.md-Warnung zur selben Formel). fullNameReversed faengt vertauschte
  // Vorname/Nachname-Eingabe ab (gleicher Grund wie sameNamePair oben).
  let personalkosten = null;
  const pkSeasonKey = personalkostenDoc.meta && personalkostenDoc.meta.currentSeason;
  const pkSeason = pkSeasonKey ? (personalkostenDoc.seasons || {})[pkSeasonKey] : null;
  if (pkSeason && Array.isArray(pkSeason.trainer)) {
    const t = pkSeason.trainer.find((x) =>
      (x.linkedUsername && sameText(x.linkedUsername, user.username)) ||
      sameText(x.name, fullName) || sameText(x.name, fullNameReversed));
    if (t) {
      personalkosten = {
        mannschaft: t.mannschaft || "", position: t.position || "",
        stelle: t.stelle ?? null, manuellAE: t.manuellAE ?? null, besonderheit: t.besonderheit || ""
      };
    }
  }

  // Kadermanager: NUR linkedUsername (kein Namensfallback -- kein Praezedenzfall
  // in dieser App). Eine Person kann in mehreren Teams stehen.
  const kadermanager = [];
  (kadermanagerDoc.teams || []).forEach((team) => {
    (team.kader || []).forEach((s) => {
      if (s.linkedUsername && sameText(s.linkedUsername, user.username)) {
        kadermanager.push({
          team: team.name || "", position: s.position || "", nummer: s.nummer || "",
          rollen: Array.isArray(s.rollen) ? s.rollen : [],
          inaktiv: Array.isArray(s.rollen) && s.rollen.includes("inaktiv")
        });
      }
    });
  });

  return {
    username: user.username, vorname: user.vorname || "", nachname: user.nachname || "",
    lizenz: user.lizenz || "", mannschaften: Array.isArray(user.mannschaften) ? user.mannschaften : [],
    groupIds: getUserGroupIds(usersDoc, user.username),
    mustSetPassword: !!user.mustSetPassword, lastLoginAt: user.lastLoginAt || null,
    archiviert: !!user.archiviert, archiviertAm: user.archiviertAm || null,
    archiviertGrund: user.archiviertGrund || null, archiviertVon: user.archiviertVon || null,
    trainerkodex, trainerdaten, trainercheckliste, personalkosten, kadermanager
  };
}

async function loadPersonalakteSources(env, authHeader) {
  // trainerkodexDoc seit 1.6 nicht mehr nötig -- Trainerkodex ist Teil von
  // Trainerdaten geworden (siehe buildTrainerRecord), ein Lookup weniger.
  const [trainerdatenDoc, checklisteDoc, personalkostenDoc, kadermanagerDoc] = await Promise.all([
    readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] }),
    readJson(DAV_APPS.trainercheckliste, authHeader, { trainerEintraege: [] }),
    readJson(DAV_APPS.personalkosten, authHeader, { meta: {}, seasons: {} }),
    readJson(DAV_APPS.kadermanager, authHeader, { meta: {}, teams: [] })
  ]);
  return { trainerdatenDoc, checklisteDoc, personalkostenDoc, kadermanagerDoc };
}

async function handlePersonalakteOverview(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await mayViewPersonalakte(session, env, authHeader))) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const usersDoc = session.usersDoc;
  const sources = await loadPersonalakteSources(env, authHeader);
  // Seit 1.3: alle Nutzerkonten, nicht mehr nur Mitglieder der Gruppe TRAINER_GROUP_NAME
  // (Wunsch: Personalakte soll wirklich jeden zeigen, nicht nur wer in der Trainer-Gruppe steckt).
  // "Jeden" meinte dabei jeden MITARBEITER -- damals war jeder Login Personal. Mit
  // Spielerkonten bekäme die Personalakte sonst 200 Karteileichen, jede dauerhaft rot
  // (kein Vertrag/Führungszeugnis/Kodex -- und bei Kindern auch nie).
  const trainers = Object.values(usersDoc.users || {})
    .filter(istPersonal)
    .map((user) => buildTrainerRecord(user, usersDoc, sources));

  return json({ trainerGroupExists: true, trainers }, 200, corsHeaders);
}

async function handleArchiveTrainer(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await mayViewPersonalakte(session, env, authHeader))) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);
  if (!(await resolveEditPermission("personalakte", session, env, authHeader))) return json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders);

  const username = normalizeUsername(body.username);
  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, username);
  if (!user) return json({ error: "Unbekannter Nutzer" }, 404, corsHeaders);
  if (user.archiviert) return json({ error: "Nutzer ist bereits archiviert" }, 409, corsHeaders);
  if (user.isAdmin) {
    const adminCount = Object.values(usersDoc.users).filter((u) => u.isAdmin).length;
    if (adminCount <= 1) return json({ error: "Letzter Admin kann nicht archiviert werden" }, 400, corsHeaders);
  }

  const sources = await loadPersonalakteSources(env, authHeader);
  const record = buildTrainerRecord(user, usersDoc, sources);
  const now = new Date().toISOString();
  const grund = String(body.grund || "").trim().slice(0, 500) || null;

  // Reihenfolge bewusst: Snapshot ZUERST schreiben. Schlaegt Schritt 2 fehl, ist
  // der Trainer noch nicht gesperrt (sicherer Fehlschlag), nicht gesperrt-ohne-
  // Datensatz.
  const { data: paDocRaw, rev } = await readJsonWithRev(DAV_APPS.personalakte, authHeader, { version: 1, archiv: [] });
  const paDoc = (paDocRaw && typeof paDocRaw === "object") ? paDocRaw : { version: 1, archiv: [] };
  if (!Array.isArray(paDoc.archiv)) paDoc.archiv = [];
  const idx = paDoc.archiv.findIndex((e) => e.username === username);
  const snapshotEntry = { username, archiviertAm: now, archiviertGrund: grund, archiviertVon: session.username, snapshot: record };
  if (idx === -1) paDoc.archiv.push(snapshotEntry); else paDoc.archiv[idx] = snapshotEntry;

  try {
    await writeJson(DAV_APPS.personalakte, authHeader, paDoc, rev || undefined);
  } catch (e) {
    return json({ error: "Snapshot konnte nicht gespeichert werden: " + e.message }, 502, corsHeaders);
  }

  user.archiviert = true;
  user.archiviertAm = now;
  user.archiviertGrund = grund;
  user.archiviertVon = session.username;
  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    // Snapshot ist bereits gespeichert (idempotent per username) -- ein Retry
    // von archive-trainer ist sicher, er ueberschreibt nur denselben Snapshot.
    return json({ error: "Snapshot gespeichert, aber Login-Sperre fehlgeschlagen: " + e.message }, 502, corsHeaders);
  }

  return json({ ok: true, username, archiviertAm: now }, 200, corsHeaders);
}

async function handleReactivateTrainer(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await mayViewPersonalakte(session, env, authHeader))) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);
  if (!(await resolveEditPermission("personalakte", session, env, authHeader))) return json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders);

  const username = normalizeUsername(body.username);
  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, username);
  if (!user) return json({ error: "Unbekannter Nutzer" }, 404, corsHeaders);
  if (!user.archiviert) return json({ error: "Nutzer ist nicht archiviert" }, 409, corsHeaders);

  // Reihenfolge umgekehrt zu archive-trainer: hier zaehlt zuerst die
  // Login-Freigabe, die Snapshot-Annotation ist reine Historie/best effort.
  user.archiviert = false;
  user.archiviertAm = null;
  user.archiviertGrund = null;
  user.archiviertVon = null;
  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  try {
    const { data: paDoc, rev } = await readJsonWithRev(DAV_APPS.personalakte, authHeader, { version: 1, archiv: [] });
    const entry = (paDoc && Array.isArray(paDoc.archiv)) ? paDoc.archiv.find((e) => e.username === username) : null;
    if (entry) {
      entry.reaktiviertAm = new Date().toISOString();
      entry.reaktiviertVon = session.username;
      await writeJson(DAV_APPS.personalakte, authHeader, paDoc, rev || undefined);
    }
  } catch (_e) {
    // best effort -- Login funktioniert bereits wieder, Historie ist nur Komfort
  }

  return json({ ok: true, username }, 200, corsHeaders);
}

// ---------- Bremse gegen das Durchprobieren von Passwörtern ----------
//
// ⚠️ Die 800-ms-Verzögerung nach einem Fehlversuch, die bei handleLogin und
// handleVerifyActionPassword seit jeher steht, bremst NUR sequenziell. Cloudflare
// skaliert waagerecht: wer 100 Anfragen gleichzeitig stellt, wartet trotzdem nur
// einmal 800 ms. Beim Konto-Login kostet ein Versuch immerhin PBKDF2 mit 100k
// Iterationen — verify-action-password vergleicht dagegen zwei SHA-256-Digests
// und ist damit praktisch gratis, während dahinter unter anderem der Zugang zur
// kompletten Vereinsbudget-Seite hängt. Deshalb hier zusätzlich ein Zählwerk.
//
// ⚠️ Gezählt werden AUSSCHLIESSLICH Fehlversuche (deshalb zwei Funktionen statt
// einer): ein Zählwerk über alle Aufrufe spränte einer Geschäftsstelle ins
// Gesicht, die sich zehnmal am Tag richtig anmeldet. Wer das Passwort weiß,
// merkt von der Bremse nie etwas.
//
// ⚠️ Isolate-lokal wie SCHULSPORT_IP_ZAEHLER und KB_EXTERN_IP_ZAEHLER — ein
// kalter Isolate fängt bei null an. Das ist eine Bremse, keine Sperre, und
// gehört genau so in die akzeptierten Limitierungen.
//
// ⚠️ Ohne CF-Connecting-IP wird nicht gezählt (fail-open, wie die drei anderen
// Bremsen). Das trifft absichtlich den Worker-zu-Worker-Aufruf des
// Beleg-Upload-Workers: der baut seinen Request selbst und hat gar keine
// Client-IP — er würde sonst als eine einzige Quelle alle Helfer gemeinsam
// aussperren.
//
// TODO beim nächsten Anfassen: schulsportIpBremse, kbExternIpBremse und
// vvNachweisIpBremse sind bis auf Map und Deckel derselbe Code. Sie hier
// mitzuziehen wäre ein Eingriff in drei live laufende Pfade ohne Anlass —
// wer eine davon ohnehin ändert, führt sie mit diesen beiden zusammen.
const LOGIN_FEHL_ZAEHLER = new Map();
const AKTIONS_PW_FEHL_ZAEHLER = new Map();
// Ein Konto-Login mit falschem Passwort ist ein Vertipper; dreißig davon in einer
// Stunde aus demselben Netz sind es nicht mehr. Der erste Schritt des zweistufigen
// Anmeldeflusses (login mit leerem Passwort, nur um den nächsten Screen zu
// bestimmen) zählt bewusst NICHT mit — sonst verbrauchte jede normale Anmeldung
// einen Versuch und ein Vereinsheim-WLAN wäre nach dreißig Anmeldungen dicht.
const LOGIN_FEHL_MAX_PRO_STUNDE = 30;
// Knapper, weil ein Aktions-Passwort je Seitenaufruf genau einmal geprüft und
// danach in sessionStorage gemerkt wird. Zwanzig Fehlversuche je Stunde deckt
// jeden Vertipper ab und macht systematisches Raten aussichtslos.
const AKTIONS_PW_FEHL_MAX_PRO_STUNDE = 20;

function bremseIp(request) {
  return String((request && request.headers && request.headers.get("CF-Connecting-IP")) || "");
}

// Darf dieser Aufrufer es überhaupt noch versuchen? Zählt selbst NICHT hoch.
function pwBremseOffen(zaehler, max, request) {
  const ip = bremseIp(request);
  if (!ip) return true;
  const eintrag = zaehler.get(ip);
  if (!eintrag || Date.now() - eintrag.start > 3600000) return true;
  return eintrag.n < max;
}

// Nach einem Fehlversuch aufrufen, nie nach einem erfolgreichen.
function pwBremseFehlschlag(zaehler, request) {
  const ip = bremseIp(request);
  if (!ip) return;
  const jetzt = Date.now();
  const eintrag = zaehler.get(ip);
  if (!eintrag || jetzt - eintrag.start > 3600000) {
    zaehler.set(ip, { start: jetzt, n: 1 });
    // Aufraeumen, damit die Map in einem langlebigen Isolate nicht waechst.
    if (zaehler.size > 500) {
      for (const [k, v] of zaehler) {
        if (jetzt - v.start > 3600000) zaehler.delete(k);
      }
    }
    return;
  }
  eintrag.n++;
}

// ---------- Aktionen: Aktions-Passwörter der Tool-Apps ----------

// Serverseitige Prüfung der früher im Client hartkodierten Aktions-Passwörter
// (dort konnte sie jeder im Quellcode nachlesen). Scope -> Worker-Secret mit dem
// Klartext-Passwort. Bewusst ohne Login nutzbar: verwaltung.html (Anmeldung) und
// das Vereinsbudget haben kein Gateway-Login.
// Scopes ab hier werden nicht vom Client, sondern SERVERSEITIG von anderen
// Cloudflare Workern aufgerufen (Worker-zu-Worker-Fetch, kein Origin-Header) -
// ersetzt dort ein bisher lokal im jeweiligen Worker geprüftes Secret 1:1.
const ACTION_PASSWORD_SECRETS = {
  "checkliste-sperre": "PW_CHECKLISTE_SPERRE",       // TrainerCheckliste: Entsperren/Löschen gesperrter Checklisten
  "anmeldung-teilnehmer": "PW_ANMELDUNG_TEILNEHMER", // Trainerversammlung: Zugang zur ganzen Verwaltungsseite (verwaltung.html)
  "geschaeftsstelle-zugang": "PW_GESCHAEFTSSTELLE",  // Geschäftsstelle: Zugang zur ganzen Seite (geschaeftsstelle.html)
  "budget-zugang": "PW_VEREINSBUDGET",               // Vereinsbudget: Zugang zur ganzen Seite (vereinsbudget.html)
  "budget-saison-leeren": "PW_BUDGET_LEEREN",        // Vereinsbudget: "Saison leeren"
  "budget-beleg-eingang": "PW_BUDGET_EINGANG_ZUGANG", // sc-heiligenstadt-beleg-upload-Worker: Zugriffscode für beleg-eingang.html (serverseitig delegiert)
  "fahrtenbuch-extern": "PW_FAHRTENBUCH_EXTERN", // extern.html: Vorab-Check am Code-Gate (die drei fahrtenbuch-extern-*-Aktionen prüfen zusätzlich selbst)
  "agelan-zugang": "PW_AGELAN" // AgeLan: Zugang zur ganzen Seite (Streamplan), Passwort verteilt Michel über Discord
};

async function handleVerifyActionPassword(request, body, env, corsHeaders) {
  // Zaehlwerk VOR dem Vergleich: sonst kostet jeder Rateversuch den Server
  // weiterhin einen vollen Durchlauf.
  if (!pwBremseOffen(AKTIONS_PW_FEHL_ZAEHLER, AKTIONS_PW_FEHL_MAX_PRO_STUNDE, request)) {
    return json({ error: "Zu viele Fehlversuche. Bitte spaeter erneut versuchen." }, 429, corsHeaders);
  }

  const scope = String(body.scope || "");
  const secretName = getOwn(ACTION_PASSWORD_SECRETS, scope);
  if (!secretName) return json({ error: "Unbekannter Passwort-Scope" }, 400, corsHeaders);
  if (!env[secretName]) {
    return json({ error: "Worker-Secret " + secretName + " ist nicht konfiguriert" }, 500, corsHeaders);
  }
  const ok = await staticPasswordEquals(String(body.password || ""), env[secretName]);
  if (!ok) {
    // Bremse gegen Durchprobieren — die Aktion ist ohne Login erreichbar.
    // Die 800 ms wirken nur sequenziell, das Zaehlwerk auch gegen parallele
    // Versuche; beides zusammen, keins ersetzt das andere.
    pwBremseFehlschlag(AKTIONS_PW_FEHL_ZAEHLER, request);
    await new Promise((resolve) => setTimeout(resolve, 800));
    return json({ error: "Falsches Passwort" }, 403, corsHeaders);
  }
  return json({ ok: true }, 200, corsHeaders);
}

// Vergleich über SHA-256-Digests: konstante Länge, damit timingSafeEqual nicht
// über seinen Längen-Check die Passwortlänge verrät.
async function staticPasswordEquals(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected))
  ]);
  return timingSafeEqual(bytesToBase64(new Uint8Array(a)), bytesToBase64(new Uint8Array(b)));
}

// ---------- Aktion: Benachrichtigung bei neuer Beleg-Einreichung ----------

// Ohne Intl gebaut: die Locale-Daten der Workers-Runtime sind nicht garantiert,
// und für "1234.5 -> 1.234,50 €" lohnt die Abhängigkeit ohnehin nicht.
function formatEuroBetrag(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(",", "."));
  if (!isFinite(n)) return "unbekannt";
  return n.toFixed(2).replace(".", ",") + " €";
}

function formatDatumDeutsch(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? m[3] + "." + m[2] + "." + m[1] : (iso || "unbekannt");
}

// Benachrichtigungsmail nach einer Beleg-Einreichung, siehe Doku-Kommentar bei
// "beleg-eingang-notify" oben. Aufruf kommt serverseitig vom Beleg-Upload-Worker,
// nicht aus dem Browser. Der Empfänger stammt IMMER aus NOTIFY_BELEG_EMAIL, nie
// aus dem Body — sonst wäre das ein offenes Mail-Relay für jeden, der den
// Zugriffscode kennt, und den kennen alle Helfer.
async function handleBelegEingangNotify(body, env, corsHeaders) {
  if (!env.PW_BUDGET_EINGANG_ZUGANG) {
    return json({ error: "Zugriffscode ist serverseitig nicht konfiguriert" }, 500, corsHeaders);
  }
  const codeOk = await staticPasswordEquals(String(body.code || ""), env.PW_BUDGET_EINGANG_ZUGANG);
  if (!codeOk) {
    // Bremse gegen Durchprobieren — die Aktion ist ohne Login erreichbar.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return json({ error: "Falscher Zugriffscode" }, 403, corsHeaders);
  }

  // Zeilenumbrüche raus: beide kommen aus einzeiligen Feldern, über den offenen
  // POST-Endpunkt ließen sich aber welche einschleusen und würden die Mail zerreißen.
  // note ist bewusst ausgenommen — das ist ein Textarea, dort sind Umbrüche gewollt.
  const einzeilig = (v, max) => capStr(v, max).replace(/[\r\n]+/g, " ");
  const name = einzeilig(body.name, 120);
  const desc = einzeilig(body.desc, 200);
  if (!name || !desc) return json({ error: "Name oder Beschreibung fehlt" }, 400, corsHeaders);
  const note = capStr(body.note, 1000);
  const betrag = formatEuroBetrag(body.amount);
  const datum = formatDatumDeutsch(capStr(body.date, 40));
  const fileCount = Math.min(99, Math.max(0, parseInt(body.fileCount, 10) || 0));

  // Fehlende Konfiguration hier bewusst als Erfolg mit sent:false melden statt als
  // Fehler: wenn diese Aktion läuft, liegt der Beleg bereits in Nextcloud. Eine
  // ausbleibende Mail darf die Einreichung nicht nachträglich kippen.
  const empfaenger = capStr(env.NOTIFY_BELEG_EMAIL, 200);
  if (!empfaenger) {
    console.warn("beleg-eingang-notify: NOTIFY_BELEG_EMAIL ist nicht gesetzt — keine Mail verschickt");
    return json({ ok: true, sent: false, reason: "NOTIFY_BELEG_EMAIL fehlt" }, 200, corsHeaders);
  }
  if (!env.BREVO_API_KEY) {
    console.warn("beleg-eingang-notify: BREVO_API_KEY ist nicht gesetzt — keine Mail verschickt");
    return json({ ok: true, sent: false, reason: "BREVO_API_KEY fehlt" }, 200, corsHeaders);
  }

  // Zeilenumbrüche aus dem Betreff werfen: desc ist Helfer-Freitext.
  const subject = ("Neuer Beleg: " + betrag + " — " + desc).replace(/[\r\n]+/g, " ").slice(0, 200);
  const zeilen = [
    "Hallo,",
    "",
    "über den Beleg-Scanner wurde ein neuer Beleg eingereicht. Hier die Eckdaten:",
    "",
    "Eingereicht von: " + name,
    "Grund: " + desc,
    "Betrag: " + betrag,
    "Beleg-Datum: " + datum,
    "Dateien: " + fileCount
  ];
  if (note) zeilen.push("Notiz: " + note);
  zeilen.push(
    "",
    "Die Datei liegt bereits im Eingangs-Ordner der Geschäftsstelle in der",
    "Vereins-Cloud — du musst nichts aus dieser Mail herunterladen.",
    "",
    "Nächster Schritt: den Beleg im Vereinsbudget-Tool übernehmen und einer",
    "Kostenstelle zuordnen. Erst dann taucht er in der Auswertung auf.",
    "",
    "Stimmt etwas nicht — falscher Betrag, unleserliches Foto, doppelt eingereicht —,",
    "klär das bitte direkt mit " + name + ", bevor du den Beleg übernimmst.",
    "",
    "Diese Nachricht wurde automatisch verschickt.",
    NOTIFY_FROM_NAME
  );

  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        sender: { email: NOTIFY_FROM_EMAIL, name: NOTIFY_FROM_NAME },
        to: [{ email: empfaenger }],
        subject,
        textContent: zeilen.join("\n")
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("Brevo-Versand fehlgeschlagen", resp.status, errText);
      return json({ error: "Mail-Versand fehlgeschlagen (HTTP " + resp.status + ")" }, 502, corsHeaders);
    }
  } catch (e) {
    return json({ error: "Mail-Versand fehlgeschlagen: " + e.message }, 502, corsHeaders);
  }

  return json({ ok: true, sent: true }, 200, corsHeaders);
}

// ---------- Aktionen: WebDAV-Gateway für die Apps ----------

// Eine App darf ihre Daten lesen/schreiben, wenn der eingeloggte Nutzer das
// zugehörige Tool in der Übersicht sehen darf. Repliziert die Client-Logik
// isVisibleToUser (app.js) serverseitig — der Client ist umgehbar.
// cfgPrefetch (optional): eine bereits laufende Leseanfrage auf sichtbarkeit.json,
// die der Aufrufer parallel zum nutzer.json-Read gestartet hat (siehe
// prefetchJson / getVerifiedSession). Fehlt sie, wird wie bisher hier gelesen —
// dann meist aus dem jsonCache, weil derselbe Request die Datei schon brauchte.
async function userMayAccessTool(app, session, env, authHeader, cfgPrefetch) {
  if (session.isAdmin) return true; // Admin darf immer (spart Nextcloud-Reads)
  const config = await (cfgPrefetch || readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} }));
  const entry = getOwn(config.tools || {}, app);
  if (!entry || entry.visible === false) return false; // versteckt/unkonfiguriert -> nur Admin
  if (!entry.loginRequired) return true;               // öffentliches Tool -> jeder Eingeloggte
  // Bearbeiten/Administrieren impliziert Sehen (seit 2026-07-24, Spec klare-rechte-
  // trennung): wer in editGroupIds/adminGroupIds steht, sieht das Tool auch ohne eigenen
  // groupIds-Eintrag. Reine Erweiterung (Union) -- steht VOR dem groupIds-Zweig und liefert
  // nur zusaetzlich true, verengt also nie ein breiter freigegebenes Tool. Gilt bewusst
  // auch fuer einen explizit in edit/adminGroupIds gesetzten Spieler (gewollter
  // Einzelgrant); der "leer groupIds = alles Personal"-Default schliesst Spieler weiter aus.
  const editGroupIds = Array.isArray(entry.editGroupIds) ? entry.editGroupIds : [];
  const adminGroupIds = Array.isArray(entry.adminGroupIds) ? entry.adminGroupIds : [];
  if (editGroupIds.concat(adminGroupIds).some((g) => session.groupIds.includes(g))) return true;
  const gids = Array.isArray(entry.groupIds) ? entry.groupIds : [];
  if (gids.length === 0) {
    // "Alle eingeloggten Nutzer" -- gemeint war immer "das ganze Personal", denn
    // bisher WAR jeder Login Personal. Für Spieler gilt dieser Komfort-Default
    // deshalb nicht: sie kommen ausschließlich über eine explizit gesetzte Gruppe
    // an ein Tool. Sonst würde jedes Tool, bei dem die Gruppe mal vergessen wird,
    // sofort für alle Spieler offenstehen -- und zwar unbemerkt, weil ein zu weit
    // sichtbares Tool niemandem auffällt. So fällt der Fehler in die sichere
    // Richtung: das Tool bleibt für Spieler leer, statt zu viel zu zeigen.
    return session.art !== USER_ART_SPIELER;
  }
  return gids.some((g) => session.groupIds.includes(g));
}

// Bearbeiten-Recht für ein Tool: unabhängig von der Sichtbarkeits-Gruppierung
// (tools[id].groupIds), damit das Gewähren eines Bearbeiten-Rechts die
// Sichtbarkeit eines breiter freigegebenen Tools (z.B. "Alle eingeloggten
// Nutzer") nicht ungewollt auf bestimmte Gruppen verengt. Ersetzt die früher
// pro App hartkodierten EDITOR_GROUP_ID-Konstanten.
// adminGroupIds zählen mit: "Administrieren" schließt "Bearbeiten" ein --
// serverseitig hier verankert, damit ein Administrieren-Häkchen ohne zweites
// Bearbeiten-Häkchen nie ins Leere läuft (das Panel koppelt die Häkchen nur
// zur Anzeige, maßgeblich ist diese Zeile).
async function resolveEditPermission(app, session, env, authHeader, cfgPrefetch) {
  if (session.isAdmin) return true;
  const config = await (cfgPrefetch || readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} }));
  const entry = getOwn(config.tools || {}, app);
  if (!entry) return false;
  const editGroupIds = Array.isArray(entry.editGroupIds) ? entry.editGroupIds : [];
  const adminGroupIds = Array.isArray(entry.adminGroupIds) ? entry.adminGroupIds : [];
  return editGroupIds.concat(adminGroupIds).some((g) => session.groupIds.includes(g));
}

// Administrieren-Recht für ein Tool -- dritte Stufe über "Bearbeiten": App-interne
// Admin-Funktionen (z.B. Trainerdaten-Vollzugriff inkl. IBAN, Kadermanager-
// Rechte-Matrix) delegierbar machen, ohne globale Admin-Rechte (Nutzerverwaltung,
// Passwort-Resets) zu vergeben. Gleiche Konventionen wie resolveEditPermission:
// leeres adminGroupIds = niemand, globaler Admin immer, unabhängig von der
// Sichtbarkeit. Konsumenten: canAdmin in me/dav-load, check-edit-permission
// (darüber der Trainerdaten-CORS-Proxy) und trainerdaten-list-groups.
async function resolveAdminPermission(app, session, env, authHeader, cfgPrefetch) {
  if (session.isAdmin) return true;
  const config = await (cfgPrefetch || readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} }));
  const entry = getOwn(config.tools || {}, app);
  if (!entry) return false;
  const adminGroupIds = Array.isArray(entry.adminGroupIds) ? entry.adminGroupIds : [];
  if (adminGroupIds.length === 0) return false;
  return adminGroupIds.some((g) => session.groupIds.includes(g));
}

// Sichtrecht fuer die GESAMTE Personalakte-App (Uebersicht + Archiv +
// Archivieren/Reaktivieren) -- bewusst wie resolveEditPermission (leeres
// groupIds = NIEMAND), nicht wie userMayAccessTool (leeres groupIds = jeder
// Eingeloggte). Liest dasselbe Feld, das auch die Kachel-Sichtbarkeit steuert
// (config.tools.personalakte.groupIds in sichtbarkeit.json) -- kein neuer
// Config-Schluessel noetig, der Admin nutzt das bestehende Sichtbarkeits-Panel.
async function mayViewPersonalakte(session, env, authHeader) {
  if (session.isAdmin) return true;
  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  const entry = getOwn(config.tools || {}, "personalakte");
  if (!entry) return false;
  // Bearbeiten/Administrieren impliziert Sehen (seit 2026-07-24, Spec klare-rechte-
  // trennung): ein personalakte-Bearbeiter muss die Uebersicht auch sehen koennen
  // (archive-/reactivate-trainer verlangen mayViewPersonalakte UND resolveEditPermission).
  // Sonst wie resolveEditPermission streng -- leeres groupIds = niemand.
  const editGroupIds = Array.isArray(entry.editGroupIds) ? entry.editGroupIds : [];
  const adminGroupIds = Array.isArray(entry.adminGroupIds) ? entry.adminGroupIds : [];
  if (editGroupIds.concat(adminGroupIds).some((g) => session.groupIds.includes(g))) return true;
  const groupIds = Array.isArray(entry.groupIds) ? entry.groupIds : [];
  if (groupIds.length === 0) return false;
  return groupIds.some((g) => session.groupIds.includes(g));
}

async function handleDavLoad(request, body, env, authHeader, corsHeaders) {
  // sichtbarkeit.json (Tool-Rechte) hängt nicht an nutzer.json (Session) — beide
  // Reads parallel starten, statt den zweiten hinter dem ersten herlaufen zu
  // lassen. Spart bei kaltem jsonCache einen kompletten Nextcloud-Roundtrip.
  //
  // ⚠️ Seit 2026-08-17 laeuft die APP-DATEI in derselben Welle mit. Vorher lag sie
  // hinter der Rechtepruefung, ein dav-load kostete also ZWEI serielle
  // Nextcloud-Runden: [nutzer.json ∥ sichtbarkeit.json] → [app-datei]. Jetzt eine.
  // Bei 200-450 ms je Read ist das der groesste Einzelposten beim Aufruf jeder App
  // der Flotte (im Flotten-Check am 2026-08-17 gemessen: die Seite selbst ist nach
  // 285 ms fertig, die Daten brauchten danach noch fast eine Sekunde).
  //
  // ⚠️ Der Preis, bewusst in Kauf genommen: ein Konto mit gueltigem Token aber OHNE
  // Recht auf dieses Tool loest den Read jetzt ebenfalls aus. Herausgegeben wird
  // nichts — die Antwort bleibt 403, der Prefetch wird verworfen. Es ist reine
  // Last, und sie trifft nur den seltenen Fall "angemeldet, aber nicht berechtigt".
  // Wer das nicht will, muesste die Rechte VOR den Daten kennen, und genau das
  // kostet die Runde, die hier gespart wird.
  const app = String(body.app || "");
  const url = getOwn(DAV_APPS, app);

  let cfgPrefetch = null;
  let datenPrefetch = null;
  const session = await getVerifiedSession(request, env, authHeader, (payload) => {
    // Admins überspringen die Rechteprüfung per Kurzschluss — für sie wäre der
    // Prefetch ein Read, den niemand liest. Bei aktiver Testansicht steht im
    // Token weiterhin isAdmin; dann entfällt hier nur die Beschleunigung und
    // userMayAccessTool liest die Datei wie bisher selbst.
    if (!payload.isAdmin) {
      cfgPrefetch = prefetchJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
    }
    // Nur bei bekannter App: eine unbekannte App-Id darf keinen Read auslösen.
    if (url) datenPrefetch = prefetchJsonWithRev(url, authHeader, null);
  });
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  // ⚠️ Die Reihenfolge der Fehlerantworten bleibt unveraendert 401 → 400 → 403.
  // app/url werden oben nur BERECHNET; wer nicht angemeldet ist, erfaehrt weiterhin
  // nicht, ob eine App-Id existiert.
  if (!url) return json({ error: "Unbekannte App" }, 400, corsHeaders);

  if (!(await userMayAccessTool(app, session, env, authHeader, cfgPrefetch))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }

  // Der Prefetch ist der Normalfall; das direkte Lesen bleibt als Rückfall, falls
  // getVerifiedSession den Callback nicht erreicht hat (kaputtes Token → dann sind
  // wir hier ohnehin nie).
  let { data, rev } = await (datenPrefetch || readJsonWithRev(url, authHeader, null));

  // Abgelaufene Eintraege entfernen, BEVOR gefiltert wird -- die Filterbloecke
  // unten liefern nur eine Teilsicht, geschrieben werden muss aber die komplette
  // Liste. Laeuft absichtlich fuer JEDEN Leser (auch Nicht-Editoren): welche
  // Eintraege fallen, entscheidet allein diese Regel, nicht der Aufrufer -- der
  // Request-Body hat darauf keinerlei Einfluss.
  const pruneCfg = getOwn(AUTO_PRUNE_APPS, app);
  if (pruneCfg && data && Array.isArray(data[pruneCfg.listField])) {
    const grenze = Date.now() - pruneCfg.maxTageAlt * 24 * 60 * 60 * 1000;
    const behalten = data[pruneCfg.listField].filter((item) => {
      if (!item || typeof item !== "object") return true;
      const ts = Date.parse(item[pruneCfg.dateField]);
      // Ohne verwertbaren Zeitstempel wird NIE geloescht: ein fehlendes oder
      // kaputtes Datum darf nicht als "unendlich alt" durchgehen.
      return !Number.isFinite(ts) || ts > grenze;
    });
    if (behalten.length !== data[pruneCfg.listField].length) {
      // Neues Objekt statt In-Place-Mutation -- gleicher jsonCache-Grund wie in
      // den Filterbloecken unten. rev kann aus dem Cache stammen; passt es nicht
      // mehr, scheitert der If-Match-PUT sauber und wir liefern einfach den
      // ungekuerzten Stand aus (der naechste Load raeumt auf).
      const bereinigt = { ...data, [pruneCfg.listField]: behalten };
      try {
        rev = await writeJson(url, authHeader, bereinigt, rev);
        data = bereinigt;
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
  }

  const ownerCfg = getOwn(OWNER_FILTERED_APPS, app);
  if (ownerCfg && data && Array.isArray(data[ownerCfg.listField]) &&
      !(await resolveEditPermission(app, session, env, authHeader, cfgPrefetch))) {
    // Neues Objekt bauen statt data[listField] in-place zu setzen: readJsonWithRev
    // liefert bei Cache-Hit (jsonCache, 5s TTL) eine Referenz auf das gecachte
    // Objekt zurück — eine In-Place-Mutation würde den Cache für alle anderen
    // Requests im selben Fenster (auch Editoren!) auf diese gefilterte Sicht verengen.
    data = { ...data, [ownerCfg.listField]: data[ownerCfg.listField].filter(
      (item) => item && item[ownerCfg.ownerField] === session.username) };
  }
  const teamCfg = getOwn(TEAM_FILTERED_APPS, app);
  if (teamCfg && data && Array.isArray(data[teamCfg.listField]) &&
      !(await resolveEditPermission(app, session, env, authHeader, cfgPrefetch))) {
    const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
    const user = getOwn(usersDoc.users, session.username);
    const meineMannschaften = new Set(normalizeMannschaften(user && user.mannschaften));
    // Neues Objekt bauen statt in-place zu mutieren -- gleicher Cache-Grund wie beim ownerCfg-Block oben.
    data = { ...data, [teamCfg.listField]: data[teamCfg.listField].filter(
      (item) => item && meineMannschaften.has(item[teamCfg.teamField])) };
  }
  // Kadermanager für Spielerkonten: nur die eigene Mannschaft, eigene Kassen-
  // buchungen, eigene Urlaub/Krank-Einträge (siehe kmSpielerSicht). Baut wie die
  // Blöcke oben ein NEUES Objekt -- der jsonCache hält sonst die gekürzte Sicht
  // und liefert sie im selben 5-Sekunden-Fenster auch Trainern aus.
  if (app === "kadermanager" && session.art === USER_ART_SPIELER && data && typeof data === "object") {
    data = kmSpielerSicht(data, session.username);
  }
  // me additiv mitliefern: kostet hier keinen einzigen zusätzlichen
  // Nextcloud-Read (usersDoc steckt in der Session, sichtbarkeit.json wurde für
  // die Rechteprüfung oben schon gelesen), erspart dem Client aber den separaten
  // "me"-Request beim Start. Clients, die das Feld nicht kennen, ignorieren es.
  const me = await buildMeResult(session, env, authHeader, app, cfgPrefetch);
  return json({ data, rev, me }, 200, corsHeaders);
}

async function handleDavSave(request, body, env, authHeader, corsHeaders) {
  // Wie in handleDavLoad: die Rechte-Datei parallel zum Session-Read holen.
  // Beim Speichern zählt das doppelt -- der PUT kann erst starten, wenn beide
  // Prüfungen durch sind, jeder eingesparte serielle Read verkürzt also direkt
  // die Zeit bis "Gespeichert ✓".
  let cfgPrefetch = null;
  const session = await getVerifiedSession(request, env, authHeader, (payload) => {
    if (!payload.isAdmin) {
      cfgPrefetch = prefetchJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
    }
  });
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const app = String(body.app || "");
  const url = getOwn(DAV_APPS, app);
  if (!url) return json({ error: "Unbekannte App" }, 400, corsHeaders);

  if (body.data == null || typeof body.data !== "object") {
    return json({ error: "Ungültige Daten" }, 400, corsHeaders);
  }

  if (!(await userMayAccessTool(app, session, env, authHeader, cfgPrefetch))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }
  if (WRITE_REQUIRES_EDIT_PERMISSION.has(app) && !(await resolveEditPermission(app, session, env, authHeader, cfgPrefetch))) {
    return json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders);
  }

  const ownerCfg = getOwn(OWNER_FILTERED_APPS, app) || getOwn(OWNER_WRITE_APPS, app);
  if (ownerCfg && !(await resolveEditPermission(app, session, env, authHeader, cfgPrefetch))) {
    // Nutzer ohne Bearbeiten-Recht: bei OWNER_FILTERED_APPS hat handleDavLoad bereits
    // nur die eigenen Einträge geliefert (body.data[listField] enthält bestenfalls nur
    // eigene). Bei OWNER_WRITE_APPS (z.B. abwesenheitskalender, siehe Kommentar dort)
    // sieht der Client beim Laden dagegen ALLE Einträge -- body.data[listField] kann
    // hier fremde Einträge enthalten und wird von handleOwnerFilteredSave direkt
    // darunter geprüft (400 bei jedem fremden Eintrag; der Client muss selbst
    // vorfiltern). In beiden Fällen NICHT wie unten das ganze Dokument wholesale
    // schreiben (würde fremde Einträge löschen bzw. überschreiben, die dieser Client
    // nie oder nur veraltet im Speicher hatte).
    return handleOwnerFilteredSave(url, ownerCfg, session, authHeader, body.data[ownerCfg.listField], corsHeaders);
  }

  // Optionaler Konfliktschutz: schickt der Client das rev (ETag) seines letzten
  // dav-load mit, wird nur geschrieben, wenn die Datei serverseitig unverändert
  // ist. Alte Clients ohne rev schreiben unconditional wie bisher. normalizeETag()
  // faengt Clients ab, die noch ein rev mit W/-Praefix im Speicher haben (z.B. aus
  // einer laenger offenen Seite von vor diesem Fix) — sonst waere der Konfliktschutz
  // erst nach einem Reload JEDER offenen Seite wieder benutzbar, nicht sofort nach
  // dem Worker-Deploy.
  const rev = normalizeETag(typeof body.rev === "string" && body.rev ? body.rev : null);
  let newRev;
  try {
    newRev = await writeJson(url, authHeader, body.data, rev);
  } catch (e) {
    if (e instanceof ConflictError) {
      return json({ error: "Konflikt: Die Daten wurden zwischenzeitlich von einem anderen Gerät geändert", conflict: true }, 409, corsHeaders);
    }
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }
  return json({ ok: true, rev: newRev }, 200, corsHeaders);
}

// Speicherpfad für OWNER_FILTERED_APPS-Nutzer ohne Bearbeiten-Recht: statt das vom
// Client geschickte Dokument wholesale zu übernehmen (der Client kennt ja nur die
// eigenen Einträge), wird serverseitig frisch gelesen, NUR listField gemergt (fremde
// Einträge unangetastet aus dem frischen Stand übernommen, eigene komplett durch die
// Client-Version ersetzt — deckt Anlegen/Ändern/Löschen der eigenen Einträge ab) und
// bei einem Schreibkonflikt (zwei Nutzer speichern gleichzeitig) automatisch mit dem
// neuen Stand erneut gemergt. Kein rev/If-Match vom Client nötig: da nie etwas
// wholesale übernommen wird, sondern jedes Mal frisch gegen den aktuellen Stand
// gemergt wird, können sich zwei verschiedene Nutzer nie gegenseitig überschreiben.
async function handleOwnerFilteredSave(url, cfg, session, authHeader, submitted, corsHeaders) {
  if (!Array.isArray(submitted) ||
      submitted.some((it) => !it || typeof it !== "object" || it[cfg.ownerField] !== session.username)) {
    return json({ error: "Ungültige Daten: fremde oder ungültige Einträge" }, 400, corsHeaders);
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data: rawDoc, rev } = await readJsonWithRev(url, authHeader, { meta: {}, [cfg.listField]: [] });
    const doc = rawDoc && typeof rawDoc === "object" ? rawDoc : { meta: {}, [cfg.listField]: [] };
    const others = (Array.isArray(doc[cfg.listField]) ? doc[cfg.listField] : [])
      .filter((it) => !it || it[cfg.ownerField] !== session.username);
    const merged = { ...doc, [cfg.listField]: others.concat(submitted) };
    merged.meta = { ...(doc.meta || {}), stand: new Date().toISOString() };
    try {
      const newRev = await writeJson(url, authHeader, merged, rev);
      return json({ ok: true, rev: newRev }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && attempt < 3) continue; // jemand anders hat zwischenzeitlich geschrieben -> frisch neu lesen+mergen
      if (e instanceof ConflictError) {
        return json({ error: "Konflikt: bitte erneut versuchen", conflict: true }, 409, corsHeaders);
      }
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
}

// ---------- Aktion: Abstimmen bei einer Vereinskalender-Umfrage ----------
// vereinskalender steht in WRITE_REQUIRES_EDIT_PERMISSION -- Termine anlegen und
// aendern darf nur, wer in editGroupIds steht. Das ABSTIMMEN bei einem
// Umfrage-Termin ist aber ausdruecklich fuer alle gedacht, die den Termin sehen
// duerfen (sonst stimmt die Geschaeftsstelle mit sich selbst ab, waehrend die
// eingeladenen Trainer nur zusehen). Statt dafuer die Schreib-Restriktion
// aufzuweichen -- dann duerfte jeder Trainer auch fremde Termine aendern und
// loeschen -- schreibt diese schmale Aktion ausschliesslich
// umfrage.stimmen[<Nutzername aus dem Token>][<candId>] EINES Termins.
//
// Sichtbarkeitsregel: Spiegel von terminVisibleFor() in vereinskalender/app.js.
// Ohne sie koennte jemand mit Tool-Zugriff bei einem fremden Privattermin
// mitstimmen und ueber die zurueckgelieferten Stimmen dessen Teilnehmerkreis
// auslesen. Wer die Regel dort aendert, muss sie hier mitziehen.
function vereinskalenderTerminSichtbar(t, session) {
  if (!t.privat) return true;
  if (session.isAdmin) return true;
  if (t.ersteller && t.ersteller === session.username) return true;
  if (Array.isArray(t.geteiltUsers) && t.geteiltUsers.includes(session.username)) return true;
  const gids = Array.isArray(session.groupIds) ? session.groupIds : [];
  if (Array.isArray(t.geteiltGruppen) && t.geteiltGruppen.some((g) => gids.includes(g))) return true;
  return false;
}

async function handleVereinskalenderVote(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  // Bewusst NUR userMayAccessTool, nicht resolveEditPermission -- genau das ist
  // der Zweck dieser Aktion. Wer das Tool nicht sehen darf, kommt trotzdem nicht durch.
  if (!(await userMayAccessTool("vereinskalender", session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }

  const terminId = String(body.terminId || "");
  const candId = String(body.candId || "");
  const wert = String(body.wert || "");
  if (!terminId || !candId) return json({ error: "Fehlende Termin- oder Vorschlags-Id" }, 400, corsHeaders);
  if (wert !== "ja" && wert !== "nein" && wert !== "") {
    return json({ error: "Ungültige Stimme" }, 400, corsHeaders);
  }

  const url = DAV_APPS["vereinskalender"];
  // Read-modify-write wie handleOwnerFilteredSave: kein rev vom Client, sondern
  // jedes Mal frisch lesen und nur das eigene Feld setzen. Zwei gleichzeitig
  // abstimmende Nutzer koennen sich dadurch nie gegenseitig ueberschreiben.
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Gleiches Muster wie handleKmSelf: VOR dem Lesen aus dem Cache nehmen (der
    // 5s-Cache könnte einen veralteten Stand samt altem ETag liefern — der
    // If-Match-PUT unten scheiterte dann grundlos), und direkt NACH dem Lesen
    // noch einmal, weil readJsonWithRev die gecachte Referenz zurückgibt und die
    // Mutation unten sonst parallele Requests im selben Isolate verfälscht.
    jsonCache.delete(url);
    const { data: raw, rev } = await readJsonWithRev(url, authHeader, null);
    jsonCache.delete(url);
    const doc = (raw && typeof raw === "object") ? raw : null;
    const termine = (doc && Array.isArray(doc.termine)) ? doc.termine : [];
    const t = termine.find((x) => x && x.id === terminId);
    if (!t) return json({ error: "Termin nicht gefunden" }, 404, corsHeaders);
    if (!vereinskalenderTerminSichtbar(t, session)) {
      return json({ error: "Kein Zugriff auf diesen Termin" }, 403, corsHeaders);
    }
    const umfrage = t.umfrage;
    const kandidaten = (umfrage && umfrage.aktiv && Array.isArray(umfrage.termine)) ? umfrage.termine : [];
    if (kandidaten.length === 0) return json({ error: "Zu diesem Termin läuft keine Umfrage" }, 400, corsHeaders);
    // candId landet gleich als Objekt-Schluessel -- nur eine Id, die wirklich in
    // der Vorschlagsliste steht, darf durch.
    if (!kandidaten.some((c) => c && c.id === candId)) {
      return json({ error: "Terminvorschlag nicht gefunden" }, 404, corsHeaders);
    }

    const stimmen = (umfrage.stimmen && typeof umfrage.stimmen === "object") ? umfrage.stimmen : {};
    const alteEigene = stimmen[session.username];
    const meine = (alteEigene && typeof alteEigene === "object") ? { ...alteEigene } : {};
    if (wert) meine[candId] = wert; else delete meine[candId];
    const neueStimmen = { ...stimmen };
    if (Object.keys(meine).length > 0) neueStimmen[session.username] = meine;
    else delete neueStimmen[session.username]; // letzte eigene Stimme zurueckgezogen -> keinen leeren Eintrag zuruecklassen
    umfrage.stimmen = neueStimmen;
    doc.meta = { ...(doc.meta || {}), stand: new Date().toISOString() };

    try {
      const newRev = await writeJson(url, authHeader, doc, rev);
      return json({ ok: true, rev: newRev, stimmen: neueStimmen }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && attempt < 3) continue; // jemand anders hat gleichzeitig gespeichert -> frisch lesen
      if (e instanceof ConflictError) {
        return json({ error: "Konflikt: bitte erneut versuchen", conflict: true }, 409, corsHeaders);
      }
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
}

// ---------- Vereinskalender: Abo-Feed fuer den eigenen Kalender (seit 2026-08-06) ----------
//
// Michel-Wunsch: die Vereinstermine dauerhaft im eigenen Kalender sehen (Google,
// Apple, Outlook). Ein einmaliger .ics-Download taugt dafuer NICHT -- er ist eine
// Kopie und erfaehrt von spaeteren Aenderungen nichts. Gebaut ist deshalb ein
// Abo-Feed: eine URL, die das Kalenderprogramm selbst regelmaessig abruft.
//
// ⚠️ Die URL IST der Ausweis. Ein Kalenderprogramm kann keinen Bearer-Token
// schicken -- es gibt dort kein Login, keinen Header, nur die Adresse. Daraus
// folgt alles Weitere:
//   * je Nutzer ein eigener langer Zufallstoken, nie ein gemeinsamer Vereinslink
//   * jederzeit entwertbar -- deshalb GESPEICHERT und nicht signiert-zustandslos
//   * bei JEDEM Abruf wird gegen nutzer.json und die Tool-Rechte geprueft: wer
//     sein Konto verliert, archiviert wird oder das Sehen-Recht einbuesst, dessen
//     Feed ist im selben Moment tot (ein einmal erzeugter Link darf kein
//     dauerhaftes Nebenrecht sein, das den Rechte-Entzug ueberlebt)
//   * private Termine gehen nur mit, wenn der Nutzer das beim Erzeugen des Links
//     ausdruecklich waehlt (umfang "alle") -- der Feed landet auf fremden Servern
//
// Ablage in einer EIGENEN Datei statt als Feld in nutzer.json: die wird bei jeder
// Sitzungspruefung der ganzen Flotte gelesen. Gleiche Ueberlegung wie bei
// push-abos.json.
const VK_ABOS_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Vereinskalender/kalender-abos.json";

const VK_ABO_UMFANG_ALLE = "alle";                 // auch eigene + mit mir geteilte private Termine
const VK_ABO_UMFANG_OEFFENTLICH = "oeffentlich";   // nur allgemeine Vereinstermine (Standard)
const VK_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
// Muss zum Regex in der GET-Weiche passen (dort wird der Token aus dem Pfad geholt).
const VK_ABO_TOKEN_RE = /^[A-Za-z0-9_-]{32,100}$/;

function leeresVkAboDoc() { return { version: 1, byToken: {} }; }

// 32 Byte Zufall als base64url -- dieselbe Groessenordnung wie die
// Freigabe-Tokens des Schulsport-Nachweises. Raten scheidet damit aus.
function vkNeuerAboToken() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function vkAboUmfangNormalisieren(raw) {
  return String(raw || "") === VK_ABO_UMFANG_ALLE ? VK_ABO_UMFANG_ALLE : VK_ABO_UMFANG_OEFFENTLICH;
}

// Der Feed-Pfad wird aus der Adresse gebaut, unter der der Worker gerade
// angesprochen wurde -- so stimmt der Link auch, falls je eine eigene Domain
// davorkommt. Der Token steht IM PFAD und nicht als ?query: manche Kalender-
// Programme schneiden Query-Parameter beim Speichern des Abos ab.
function vkAboUrls(request, token) {
  const basis = new URL(request.url).origin + "/kalender/" + token + ".ics";
  return { url: basis, webcalUrl: basis.replace(/^https?:/i, "webcal:") };
}

async function vkAbosMutieren(authHeader, aendern) {
  let letzterFehler = null;
  for (let versuch = 0; versuch < 3; versuch++) {
    const gelesen = await readJsonWithRev(VK_ABOS_URL, authHeader, leeresVkAboDoc());
    const doc = (gelesen.data && typeof gelesen.data === "object") ? gelesen.data : leeresVkAboDoc();
    if (!doc.byToken || typeof doc.byToken !== "object") doc.byToken = {};
    const weiter = aendern(doc);
    if (weiter === false) return doc;
    try {
      await writeJson(VK_ABOS_URL, authHeader, doc, gelesen.rev);
      return doc;
    } catch (e) {
      if (e instanceof ConflictError) { letzterFehler = e; continue; }
      throw e;
    }
  }
  throw letzterFehler || new Error("Kalender-Abos konnten nicht geschrieben werden");
}

// Ein Nutzer hat hoechstens EIN Abo. Der Umweg ueber byToken (statt byUser) ist
// Absicht: der heisse Pfad ist der Feed-Abruf, und der kennt nur den Token.
function vkAboVonNutzer(doc, username) {
  const byToken = (doc && doc.byToken && typeof doc.byToken === "object") ? doc.byToken : {};
  for (const token of Object.keys(byToken)) {
    const eintrag = byToken[token];
    if (eintrag && eintrag.username === username) return { token, ...eintrag };
  }
  return null;
}

// ---------- ICS-Erzeugung (RFC 5545) ----------

// Verschiebung von Europe/Berlin gegenueber UTC zu einem Zeitpunkt, in ms.
// sv-SE liefert "YYYY-MM-DD HH:MM:SS"; parst man das wieder als UTC, ist die
// Differenz genau der Offset -- inklusive Sommerzeit und ohne eigene Regeltabelle.
function vkBerlinOffsetMs(ms) {
  const alsBerlin = new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Berlin" });
  return Date.parse(alsBerlin.replace(" ", "T") + "Z") - ms;
}

// Wandzeit in Heiligenstadt -> echter Zeitpunkt (UTC-Millisekunden).
// ⚠️ ZWEI Durchgaenge: den ersten Offset lesen wir an der falschen Stelle der
// Zeitachse ab, weil wir den Zeitpunkt ja noch gar nicht kennen. An den beiden
// Umstellungstagen im Jahr liegt er dadurch eine Stunde daneben -- der zweite
// Durchgang korrigiert das. Wer hier eine Runde einspart, verschiebt jeden
// Termin am letzten Maerz- und Oktoberwochenende.
function vkBerlinWandzeitZuMs(iso, hhmm) {
  const alsWaereEsUtc = Date.parse(iso + "T" + hhmm + ":00Z");
  if (!Number.isFinite(alsWaereEsUtc)) return NaN;
  const ersterVersuch = alsWaereEsUtc - vkBerlinOffsetMs(alsWaereEsUtc);
  return alsWaereEsUtc - vkBerlinOffsetMs(ersterVersuch);
}

function vkIcsZeit(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function vkIcsDatum(iso) { return String(iso || "").replace(/-/g, ""); }

// DTEND ist bei Ganztagsterminen EXKLUSIV: ein eintaegiger Termin am 17.08. endet
// laut Norm am 18.08. Ohne das +1 zeigen Google und Apple einen mehrtaegigen
// Termin um einen Tag zu kurz an -- und einen eintaegigen gar nicht.
function vkIcsDatumExklusiv(iso) {
  const ms = Date.parse(String(iso || "") + "T00:00:00Z");
  if (!Number.isFinite(ms)) return vkIcsDatum(iso);
  return vkIcsDatum(new Date(ms + 86400000).toISOString().slice(0, 10));
}

function vkIcsEscape(text) {
  return String(text == null ? "" : text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// RFC 5545 begrenzt eine Zeile auf 75 Oktette, Fortsetzungen beginnen mit einem
// Leerzeichen. ⚠️ Gezaehlt werden BYTES, nicht Zeichen -- ein Umlaut sind zwei.
// Deshalb wird zeichenweise gefuellt statt per slice(): ein mitten
// durchgeschnittenes Mehrbyte-Zeichen macht die Datei fuer manche Programme
// unlesbar, und Vereinstermine stecken voller Umlaute.
function vkIcsFalten(zeile) {
  const enc = new TextEncoder();
  if (enc.encode(zeile).length <= 75) return zeile;
  const zeilen = [];
  let aktuell = "";
  let bytes = 0;
  for (const zeichen of zeile) {
    const n = enc.encode(zeichen).length;
    const grenze = zeilen.length === 0 ? 75 : 74; // Folgezeile: das fuehrende Leerzeichen zaehlt mit
    if (bytes + n > grenze) { zeilen.push(aktuell); aktuell = ""; bytes = 0; }
    aktuell += zeichen;
    bytes += n;
  }
  if (aktuell) zeilen.push(aktuell);
  return zeilen.map((z, i) => (i === 0 ? z : " " + z)).join("\r\n");
}

// Baut die Zeilen EINES VEVENT. Werte von Textfeldern kommen bereits escaped
// herein; Datums-/Zeitfelder duerfen nicht escaped werden (der Doppelpunkt und
// die Parameter gehoeren zur Syntax).
function vkIcsEvent(e) {
  const zeilen = ["BEGIN:VEVENT"];
  const add = (name, wert) => { if (wert !== "" && wert != null) zeilen.push(vkIcsFalten(name + ":" + wert)); };

  add("UID", e.uid);
  add("DTSTAMP", e.dtstamp);
  if (e.ganztags) {
    add("DTSTART;VALUE=DATE", vkIcsDatum(e.datum));
    add("DTEND;VALUE=DATE", vkIcsDatumExklusiv(e.endDatum || e.datum));
  } else {
    const start = vkBerlinWandzeitZuMs(e.datum, e.startZeit || "00:00");
    // Ohne Endzeit eine Stunde annehmen: ein Termin ohne Dauer verschwindet in
    // manchen Ansichten zu einem Strich.
    const ende = e.endZeit
      ? vkBerlinWandzeitZuMs(e.endDatum || e.datum, e.endZeit)
      : start + 3600000;
    add("DTSTART", vkIcsZeit(start));
    // Ein Ende vor dem Start ist fuer Kalenderprogramme ein kaputter Eintrag --
    // in den Daten kommt das vor (Termin von 22:00 bis 01:00, alles am selben Tag).
    add("DTEND", vkIcsZeit(ende > start ? ende : start + 3600000));
  }
  add("SUMMARY", vkIcsEscape(e.titel));
  add("LOCATION", vkIcsEscape(e.ort));
  add("DESCRIPTION", vkIcsEscape(e.beschreibung));
  add("CATEGORIES", vkIcsEscape(e.kategorie));
  add("STATUS", e.status || "CONFIRMED");
  zeilen.push("END:VEVENT");
  return zeilen;
}

// Ein Termin ergibt EIN Ereignis -- ausser bei einer laufenden Umfrage, dann eins
// je Vorschlag.
//
// ⚠️ Rueckgabe ist eine FLACHE Zeilenliste, kein Array von Ereignissen. vkIcsEvent
// liefert selbst schon Zeilen; wer die ungeflacht weiterreicht, bekommt beim
// join("\r\n") des Aufrufers ein Array-toString() -- alle Zeilen eines Ereignisses
// landen dann kommasepariert in EINER Zeile. Die Datei sieht dabei auf den ersten
// Blick heil aus (BEGIN/END stehen da, Umlaute stimmen) und ist trotzdem fuer
// jeden Kalender unlesbar: "component began but did not end". Am 2026-08-06 genau
// so gebaut und erst von einem fremden Parser gefunden.
function vkTerminEvents(t, katName, dtstamp, uidBasis) {
  if (!t || !VK_ISO_RE.test(String(t.datum || ""))) return [];
  const kat = katName(t.kategorie);
  const beschreibungsteile = [];
  if (t.notiz) beschreibungsteile.push(String(t.notiz));
  if (kat) beschreibungsteile.push("Kategorie: " + kat);
  const beschreibung = beschreibungsteile.join("\n");
  const gemeinsam = { ort: t.ort || "", beschreibung, kategorie: kat, dtstamp };

  const vorschlaege = (t.umfrage && t.umfrage.aktiv && Array.isArray(t.umfrage.termine)) ? t.umfrage.termine : [];
  if (vorschlaege.length) {
    // ⚠️ Ein Umfrage-Termin ist noch KEIN Termin, sondern mehrere Moeglichkeiten.
    // Je Vorschlag ein eigener Eintrag mit STATUS:TENTATIVE -- genau dafuer gibt
    // es das Feld, Kalender stellen solche Eintraege blass dar. Ein einziger
    // Eintrag ueber die ganze Spanne waere sachlich falsch: der Verein ist nicht
    // drei Tage lang beschaeftigt, sondern an einem davon. Dieselbe Darstellung
    // wie im "Naechste Termine"-Fenster der Uebersicht (eine Zeile je Moeglichkeit).
    const zeilen = [];
    vorschlaege.forEach((c, i) => {
      if (!c || !VK_ISO_RE.test(String(c.datum || ""))) return;
      zeilen.push(...vkIcsEvent({
        ...gemeinsam,
        uid: `${uidBasis}-${c.id || i}`,
        titel: "(Vorschlag) " + (t.titel || "Termin"),
        datum: c.datum,
        endDatum: c.datum,
        startZeit: c.startZeit || "",
        endZeit: c.endZeit || "",
        ganztags: !c.startZeit && !c.endZeit,
        status: "TENTATIVE"
      }));
    });
    return zeilen;
  }

  const endDatum = (t.endDatum && VK_ISO_RE.test(t.endDatum) && t.endDatum >= t.datum) ? t.endDatum : t.datum;
  return vkIcsEvent({
    ...gemeinsam,
    uid: uidBasis,
    titel: t.titel || "Termin",
    datum: t.datum,
    endDatum,
    startZeit: t.startZeit || "",
    endZeit: t.endZeit || "",
    ganztags: !!t.ganztags || (!t.startZeit && !t.endZeit)
  });
}

// ⚠️ BEWUSST OHNE ADMIN-BYPASS -- das ist der Unterschied zu
// vereinskalenderTerminSichtbar(). In der App darf ein Admin jeden Privattermin
// sehen (Support und Aufraeumen). Im Feed haette dasselbe zur Folge, dass mit
// einem einzigen Haken saemtliche Privattermine des ganzen Vereins dauerhaft auf
// den Server eines Kalenderanbieters wandern. Der Feed zeigt deshalb nur, was
// einen persoenlich betrifft.
function vkFeedTerminSichtbar(t, nutzer) {
  if (!t.privat) return true;
  if (t.ersteller && t.ersteller === nutzer.username) return true;
  if (Array.isArray(t.geteiltUsers) && t.geteiltUsers.includes(nutzer.username)) return true;
  const gids = Array.isArray(nutzer.groupIds) ? nutzer.groupIds : [];
  if (Array.isArray(t.geteiltGruppen) && t.geteiltGruppen.some((g) => gids.includes(g))) return true;
  return false;
}

function vkTextAntwort(text, status, corsHeaders) {
  return new Response(text, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}

// Der Feed-Abruf. Kein Bearer, keine Sitzung -- der Token aus dem Pfad ist alles,
// was das Kalenderprogramm mitbringt.
async function handleVkIcsFeed(request, token, env, authHeader, corsHeaders) {
  const abosDoc = await readJson(VK_ABOS_URL, authHeader, leeresVkAboDoc());
  const eintrag = getOwn(abosDoc.byToken || {}, token);
  if (!eintrag || !eintrag.username) {
    return vkTextAntwort("Dieser Kalender-Link ist nicht (mehr) gültig.", 404, corsHeaders);
  }

  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  const user = getOwn(usersDoc.users, String(eintrag.username));
  // Dieselben Regeln wie sessionUserFromDoc, nur ohne Token-Zeitstempel: ein
  // geloeschtes, archiviertes oder nie eingerichtetes Konto hat keinen Kalender.
  if (!user || user.archiviert || user.mustSetPassword || !user.passwordHash) {
    return vkTextAntwort("Dieser Kalender-Link ist nicht (mehr) gültig.", 404, corsHeaders);
  }

  // ⚠️ deriveIdentity absichtlich NICHT verwendet: es wuerde die Testansicht
  // (viewAsGroupId) eines Admins in den Feed durchreichen und einem Admin
  // isAdmin: true geben -- beides hat in einem dauerhaft laufenden Abo nichts zu
  // suchen. Gebraucht werden nur die echten Gruppen.
  const nutzer = { username: user.username, groupIds: getUserGroupIds(usersDoc, user.username) };
  const session = { username: user.username, isAdmin: !!user.isAdmin, groupIds: nutzer.groupIds, art: userArt(user) };
  if (!(await userMayAccessTool("vereinskalender", session, env, authHeader))) {
    return vkTextAntwort("Für diesen Zugang ist der Vereinskalender nicht freigegeben.", 403, corsHeaders);
  }

  const doc = await readJson(DAV_APPS["vereinskalender"], authHeader, { meta: {}, kategorien: [], termine: [] });
  const termine = Array.isArray(doc.termine) ? doc.termine : [];
  const kategorien = Array.isArray(doc.kategorien) ? doc.kategorien : [];
  const katName = (id) => {
    const k = kategorien.find((x) => x && x.id === id);
    return k && k.name ? String(k.name) : "";
  };
  const nurOeffentlich = vkAboUmfangNormalisieren(eintrag.umfang) !== VK_ABO_UMFANG_ALLE;

  const dtstamp = vkIcsZeit(Date.now());
  const zeilen = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//1. SC 1911 Heiligenstadt//Vereinskalender//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    vkIcsFalten("X-WR-CALNAME:" + vkIcsEscape("Vereinskalender SC 1911")),
    "X-WR-TIMEZONE:Europe/Berlin",
    // Bitte an das Kalenderprogramm, stuendlich nachzusehen. Apple und Outlook
    // halten sich daran, Google nicht -- dort bleibt es bei dessen eigenem
    // Rhythmus von mehreren Stunden. Das ist keine Einstellung, die sich von
    // hier aus erzwingen laesst.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H"
  ];

  for (const t of termine) {
    if (!t || typeof t !== "object") continue;
    if (t.privat && nurOeffentlich) continue;
    if (!vkFeedTerminSichtbar(t, nutzer)) continue;
    // Die Uid muss ueber Abrufe hinweg stabil bleiben, sonst legt das
    // Kalenderprogramm bei jeder Aktualisierung neue Eintraege an, statt die
    // vorhandenen fortzuschreiben.
    const uidBasis = String(t.id || "") + "@vereinskalender.sc1911-heiligenstadt.de";
    for (const zeile of vkTerminEvents(t, katName, dtstamp, uidBasis)) zeilen.push(zeile);
  }

  zeilen.push("END:VCALENDAR");
  // RFC 5545 schreibt CRLF vor. Mit reinem \n weigern sich einzelne Programme,
  // die Datei zu lesen.
  const ics = zeilen.join("\r\n") + "\r\n";
  return new Response(ics, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="vereinskalender.ics"',
      // Ein zwischengespeicherter Feed waere ein Kalender, der nicht nachzieht --
      // genau das, wogegen das ganze Feature gebaut ist.
      "Cache-Control": "no-store"
    }
  });
}

// ---------- Aktionen: Abo verwalten ----------
//
// Alle drei haengen am SEHEN-Recht, nicht am Bearbeiten -- Michel-Entscheidung
// vom 2026-08-06, bewusste Abweichung von der Flottenregel "Export ab
// Bearbeiten". Begruendung: der Feed zeigt jedem genau die Termine, die er in der
// App ohnehin sieht, und der ganze Zweck ist, dass die TRAINER die Vereinstermine
// im Handy-Kalender haben. Mit dem Bearbeiten-Gate haetten ihn nur
// Geschaeftsstelle, Foerderung und Fuehrung.

async function vkAboSession(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return { fehler: json({ error: "Nicht angemeldet" }, 401, corsHeaders) };
  if (!(await userMayAccessTool("vereinskalender", session, env, authHeader))) {
    return { fehler: json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders) };
  }
  return { session };
}

async function handleVkAboStatus(request, env, authHeader, corsHeaders) {
  const { session, fehler } = await vkAboSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const doc = await readJson(VK_ABOS_URL, authHeader, leeresVkAboDoc());
  const abo = vkAboVonNutzer(doc, session.username);
  if (!abo) return json({ ok: true, aktiv: false }, 200, corsHeaders);
  return json({
    ok: true,
    aktiv: true,
    umfang: vkAboUmfangNormalisieren(abo.umfang),
    erstelltAm: abo.erstelltAm || "",
    ...vkAboUrls(request, abo.token)
  }, 200, corsHeaders);
}

async function handleVkAboAnlegen(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await vkAboSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const umfang = vkAboUmfangNormalisieren(body.umfang);
  const token = vkNeuerAboToken();
  await vkAbosMutieren(authHeader, (doc) => {
    // Ein Nutzer hat hoechstens ein Abo: der alte Token wird beim Neuerzeugen
    // entwertet. Sonst sammelten sich mit jedem Klick weitere gueltige Links an,
    // von denen der Nutzer nichts mehr weiss -- und "Link entwerten" wuerde nur
    // einen davon treffen.
    for (const alt of Object.keys(doc.byToken)) {
      const e = doc.byToken[alt];
      if (e && e.username === session.username) delete doc.byToken[alt];
    }
    doc.byToken[token] = { username: session.username, umfang, erstelltAm: new Date().toISOString() };
  });

  return json({ ok: true, aktiv: true, umfang, ...vkAboUrls(request, token) }, 200, corsHeaders);
}

async function handleVkAboLoeschen(request, env, authHeader, corsHeaders) {
  const { session, fehler } = await vkAboSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  let entwertet = false;
  await vkAbosMutieren(authHeader, (doc) => {
    for (const token of Object.keys(doc.byToken)) {
      const e = doc.byToken[token];
      if (e && e.username === session.username) { delete doc.byToken[token]; entwertet = true; }
    }
    if (!entwertet) return false; // nichts da -> gar nicht erst schreiben
  });
  return json({ ok: true, aktiv: false, entwertet }, 200, corsHeaders);
}

// ---------- Aktionen: Schulsport-Planer (seit 2026-08-05) ----------
//
// Planung und Durchfuehrungsnachweis der Schul-AGs und Ferien-Camps.
//
// ⚠️ Die Rechte sind hier bewusst ANDERS geschnitten als sonst in der Flotte:
// Uebungsleiter stehen NUR in der Sehen-Gruppe. Haetten sie Bearbeiten-Recht,
// gaebe ihnen WRITE_REQUIRES_EDIT_PERMISSION ueber resolveEditPermission das
// ganze Dokument frei -- und damit auch fremde Nachweisdaten. Ihr einziger
// Schreibweg ist schulsport-meldung, dessen Gate die Team-Zugehoerigkeit zur
// Massnahme ist. Muster: handleVereinskalenderVote weiter oben.

const SCHULSPORT_TERMIN_STATUS = new Set(["offen", "durchgefuehrt", "ausgefallen", "verschoben"]);
const SCHULSPORT_STATUS_NAMEN = {
  offen: "Offen", durchgefuehrt: "Durchgeführt", ausgefallen: "Ausgefallen", verschoben: "Verschoben"
};
const SCHULSPORT_WOCHENTAGE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const SCHULSPORT_FREIGABE_BASIS = "https://sc1911heiligenstadt.github.io/schulsport/bestaetigung.html";
const SCHULSPORT_FREIGABE_TAGE = 30;
const SCHULSPORT_MAX_NACHWEISE = 500;

// Missbrauchsbremse fuer die beiden login-losen Aktionen.
// ⚠️ Isolate-lokal, wie aktivitaetGesehen -- dieser Worker hat keinen
// persistenten Speicher fuer so etwas. Das ist eine BREMSE, keine Sperre: ein
// kalter Isolate faengt bei null an. Die eigentliche Sicherheit sind die 256 Bit
// Zufall im Token plus Ablaufdatum plus Widerruf. Gehoert genau so in die
// akzeptierten Limitierungen, nicht in eine spaetere Fehlersuche.
const SCHULSPORT_IP_ZAEHLER = new Map();
const SCHULSPORT_IP_MAX_PRO_STUNDE = 30;

function schulsportIpBremse(request) {
  const ip = String((request && request.headers && request.headers.get("CF-Connecting-IP")) || "");
  if (!ip) return true;
  const jetzt = Date.now();
  const eintrag = SCHULSPORT_IP_ZAEHLER.get(ip);
  if (!eintrag || jetzt - eintrag.start > 3600000) {
    SCHULSPORT_IP_ZAEHLER.set(ip, { start: jetzt, n: 1 });
    // Aufraeumen, damit die Map in einem langlebigen Isolate nicht waechst.
    if (SCHULSPORT_IP_ZAEHLER.size > 500) {
      for (const [k, v] of SCHULSPORT_IP_ZAEHLER) {
        if (jetzt - v.start > 3600000) SCHULSPORT_IP_ZAEHLER.delete(k);
      }
    }
    return true;
  }
  eintrag.n++;
  return eintrag.n <= SCHULSPORT_IP_MAX_PRO_STUNDE;
}

function schulsportMinuten(hhmm) {
  const t = String(hhmm || "").split(":");
  if (t.length !== 2) return 0;
  const h = Number(t[0]), m = Number(t[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function schulsportWochentag(iso) {
  const t = String(iso || "").split("-");
  if (t.length !== 3) return "";
  const d = new Date(Number(t[0]), Number(t[1]) - 1, Number(t[2]));
  return isNaN(d.getTime()) ? "" : SCHULSPORT_WOCHENTAGE[d.getDay()];
}

// Spiegelt summiereTermine() aus E:\schulsport\termine.js.
// ⚠️ Doppelung mit Absicht: der Snapshot MUSS serverseitig entstehen, sonst
// stuende im Nachweis, was der Browser behauptet, statt was gespeichert ist.
// Wer die Client-Funktion aendert, zieht diese hier mit.
function schulsportSummen(termine) {
  let geplant = 0, durchgefuehrt = 0, ausgefallen = 0, verschoben = 0;
  let teilnahmen = 0, mitZahl = 0, minutenAg = 0, minutenVor = 0, minutenNach = 0;
  for (const t of termine) {
    geplant++;
    if (t.status === "durchgefuehrt") {
      durchgefuehrt++;
      const dauer = schulsportMinuten(t.endZeit) - schulsportMinuten(t.startZeit);
      if (dauer > 0) minutenAg += dauer;
      minutenVor += Number(t.vorbereitungMin) || 0;
      minutenNach += Number(t.nachbereitungMin) || 0;
      if (t.teilnehmerzahl !== null && t.teilnehmerzahl !== undefined) {
        teilnahmen += Number(t.teilnehmerzahl) || 0;
        mitZahl++;
      }
    } else if (t.status === "ausgefallen") ausgefallen++;
    else if (t.status === "verschoben") verschoben++;
  }
  return {
    geplant, durchgefuehrt, ausgefallen, verschoben,
    offen: geplant - durchgefuehrt - ausgefallen - verschoben,
    teilnahmen, mitZahl,
    // Nenner ist die Zahl der Termine MIT Angabe -- ein durchgefuehrter, aber
    // noch nicht gezaehlter Termin darf den Schnitt nicht druecken.
    schnitt: mitZahl ? Math.round((teilnahmen / mitZahl) * 10) / 10 : 0,
    minutenAg, minutenVor, minutenNach, minutenGesamt: minutenAg + minutenVor + minutenNach
  };
}

function schulsportName(usersDoc, username) {
  if (!username) return "";
  const u = getOwn((usersDoc && usersDoc.users) || {}, username);
  return (u && u.vorname && u.nachname) ? `${u.vorname} ${u.nachname}` : username;
}

// Baut den eingefrorenen Nachweis aus der Datei. Nichts davon kommt aus dem Body.
function schulsportSnapshot(doc, massnahmeId, vonDatum, bisDatum, usersDoc) {
  const massnahmen = Array.isArray(doc.massnahmen) ? doc.massnahmen : [];
  const m = massnahmen.find((x) => x && x.id === massnahmeId);
  if (!m) return null;
  const schule = (Array.isArray(doc.schulen) ? doc.schulen : []).find((s) => s && s.id === m.schuleId) || null;
  const ort = (Array.isArray(doc.orte) ? doc.orte : []).find((o) => o && o.id === m.ortId) || null;
  const gruende = Array.isArray(doc.ausfallgruende) ? doc.ausfallgruende : [];

  const termine = (Array.isArray(doc.termine) ? doc.termine : [])
    .filter((t) => t && t.massnahmeId === massnahmeId && t.datum >= vonDatum && t.datum <= bisDatum)
    .sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0));

  const summen = schulsportSummen(termine);

  const zaehler = new Map();
  for (const t of termine) {
    if (t.status !== "ausgefallen") continue;
    const k = t.ausfallgrundId || "";
    zaehler.set(k, (zaehler.get(k) || 0) + 1);
  }
  const ausfaelle = [];
  zaehler.forEach((anzahl, k) => {
    const g = gruende.find((x) => x && x.id === k);
    ausfaelle.push({
      id: k, bezeichnung: g ? g.bezeichnung : "Ohne Angabe",
      vereinsverschulden: g ? !!g.vereinsverschulden : false, anzahl
    });
  });
  ausfaelle.sort((a, b) => b.anzahl - a.anzahl);

  const ap = (schule && schule.ansprechpartner) || null;

  return {
    erstelltAm: new Date().toISOString(),
    massnahmeTitel: String(m.titel || ""),
    typ: String(m.typ || "ag"),
    rahmen: String(m.rahmen || ""),
    zielgruppe: String(m.zielgruppe || ""),
    schuleName: schule ? String(schule.name || "") : "",
    schuleAnschrift: schule
      ? [schule.strasse, [schule.plz, schule.ort].filter(Boolean).join(" ")].filter(Boolean).join(", ")
      : "",
    ansprechpartner: ap ? { name: ap.name || "", funktion: ap.funktion || "", telefon: ap.telefon || "", email: ap.email || "" } : null,
    ortName: ort ? String(ort.name || "") : "",
    verantwortlichName: schulsportName(usersDoc, m.verantwortlichUsername),
    teamNamen: (Array.isArray(m.teamUsernames) ? m.teamUsernames : []).map((u) => schulsportName(usersDoc, u)),
    zeilen: termine.map((t) => ({
      datum: t.datum,
      wochentag: schulsportWochentag(t.datum),
      startZeit: t.startZeit || "", endZeit: t.endZeit || "",
      status: t.status || "offen",
      statusName: SCHULSPORT_STATUS_NAMEN[t.status] || "Offen",
      teilnehmerzahl: (t.teilnehmerzahl === null || t.teilnehmerzahl === undefined) ? null : Number(t.teilnehmerzahl),
      durchgefuehrtVonName: schulsportName(usersDoc, t.durchgefuehrtVon),
      ausfallgrund: t.ausfallgrundId
        ? ((gruende.find((g) => g && g.id === t.ausfallgrundId) || {}).bezeichnung || "")
        : "",
      vorbereitungMin: Number(t.vorbereitungMin) || 0,
      nachbereitungMin: Number(t.nachbereitungMin) || 0
    })),
    summen, ausfaelle,
    offeneTermine: summen.offen
  };
}

// Was die Schule ueber den Freigabelink sehen darf -- NUR dieser eine Vorgang,
// und ohne die Protokollfelder ip/agent.
function schulsportOeffentlicherNachweis(n) {
  return {
    id: n.id,
    status: n.status,
    vonDatum: n.vonDatum,
    bisDatum: n.bisDatum,
    gueltigBis: n.gueltigBis,
    snapshot: n.snapshot,
    bestaetigung: n.bestaetigung
      ? { name: n.bestaetigung.name, funktion: n.bestaetigung.funktion, bestaetigtAm: n.bestaetigung.bestaetigtAm }
      : null,
    rueckfrage: n.rueckfrage
      ? { name: n.rueckfrage.name, text: n.rueckfrage.text, gestelltAm: n.rueckfrage.gestelltAm }
      : null
  };
}

function schulsportNeuesToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Darf dieser Nutzer die Massnahme melden? Aus dem DATENSATZ, nie aus dem Body.
function schulsportImTeam(massnahme, username) {
  if (!massnahme || !username) return false;
  if (massnahme.verantwortlichUsername === username) return true;
  return Array.isArray(massnahme.teamUsernames) && massnahme.teamUsernames.indexOf(username) !== -1;
}

// ---------- schulsport-personen ----------
// Auswahlquelle fuer Verantwortliche und Team.
// ⚠️ Warum nicht list-tool-editors: das liefert NUR editGroupIds+adminGroupIds.
// Die Uebungsleiter stehen hier bewusst nur in groupIds -- mit list-tool-editors
// waere der Picker leer, und der naheliegende "Fix" (Uebungsleiter ins
// Bearbeiten-Recht) haette ihnen das ganze Dokument geoeffnet.
async function handleSchulsportPersonen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await userMayAccessTool("schulsport", session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }
  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  const entry = getOwn(config.tools || {}, "schulsport") || {};
  const sehen = Array.isArray(entry.groupIds) ? entry.groupIds : [];
  const edit = Array.isArray(entry.editGroupIds) ? entry.editGroupIds : [];
  const admin = Array.isArray(entry.adminGroupIds) ? entry.adminGroupIds : [];
  const usersDoc = session.usersDoc;

  const schreibend = new Set();
  edit.concat(admin).forEach((gid) => {
    const g = getOwn(usersDoc.groups || {}, gid);
    if (g && Array.isArray(g.memberUsernames)) g.memberUsernames.forEach((u) => schreibend.add(u));
  });

  const alle = new Set(schreibend);
  if (sehen.length) {
    sehen.forEach((gid) => {
      const g = getOwn(usersDoc.groups || {}, gid);
      if (g && Array.isArray(g.memberUsernames)) g.memberUsernames.forEach((u) => alle.add(u));
    });
  } else {
    // Leere Sehen-Gruppe heisst "alles Personal ausser Spielerkonten" -- dieselbe
    // Auslegung wie userMayAccessTool. Ohne diesen Zweig waere der Picker in
    // einem frisch registrierten Tool leer, obwohl alle es sehen duerfen.
    const users = (usersDoc && usersDoc.users) || {};
    for (const k of Object.keys(users)) {
      const u = users[k];
      if (!u || u.archiviert || !istPersonal(u)) continue;
      alle.add(u.username || k);
    }
  }

  const out = Array.from(alle).map((username) => {
    const u = getOwn(usersDoc.users, username);
    if (!u || u.archiviert) return null;
    return {
      username,
      displayName: (u.vorname && u.nachname) ? `${u.vorname} ${u.nachname}` : username,
      darfBearbeiten: schreibend.has(username) || !!u.isAdmin
    };
  }).filter(Boolean);
  out.sort((a, b) => a.displayName.localeCompare(b.displayName, "de"));
  return json({ users: out }, 200, corsHeaders);
}

// ---------- schulsport-meldung ----------
async function handleSchulsportMeldung(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  // Bewusst NUR userMayAccessTool -- genau das ist der Zweck dieser Aktion.
  if (!(await userMayAccessTool("schulsport", session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }

  const terminId = String(body.terminId || "");
  if (!terminId) return json({ error: "Fehlende Termin-Id" }, 400, corsHeaders);
  const status = String(body.status || "");
  if (!SCHULSPORT_TERMIN_STATUS.has(status)) return json({ error: "Ungültiger Status" }, 400, corsHeaders);

  let zahl = null;
  if (body.teilnehmerzahl !== null && body.teilnehmerzahl !== undefined && body.teilnehmerzahl !== "") {
    zahl = Number(body.teilnehmerzahl);
    if (!Number.isInteger(zahl) || zahl < 0 || zahl > 999) {
      return json({ error: "Teilnehmerzahl muss eine ganze Zahl zwischen 0 und 999 sein" }, 400, corsHeaders);
    }
  }
  if (status === "durchgefuehrt" && zahl === null) {
    return json({ error: "Für eine durchgeführte Einheit fehlt die Teilnehmerzahl" }, 400, corsHeaders);
  }
  const ausfallgrundId = capStr(body.ausfallgrundId, 60);
  const ausfallBemerkung = capStr(body.ausfallBemerkung, 500);
  const notiz = capStr(body.notiz, 1000);
  const durchRoh = capStr(body.durchgefuehrtVon, 80);

  const url = DAV_APPS["schulsport"];
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Beide jsonCache.delete sind Pflicht: davor, weil der 5-Sekunden-Cache
    // sonst einen alten ETag liefert und der If-Match-PUT grundlos scheitert --
    // danach, weil readJsonWithRev die gecachte REFERENZ zurueckgibt und die
    // Mutation unten sonst parallele Requests im selben Isolate verfaelscht.
    jsonCache.delete(url);
    const { data: raw, rev } = await readJsonWithRev(url, authHeader, null);
    jsonCache.delete(url);
    const doc = (raw && typeof raw === "object") ? raw : null;
    if (!doc) return json({ error: "Es sind noch keine Daten hinterlegt" }, 404, corsHeaders);

    const termine = Array.isArray(doc.termine) ? doc.termine : [];
    const t = termine.find((x) => x && x.id === terminId);
    if (!t) return json({ error: "Termin nicht gefunden" }, 404, corsHeaders);

    const massnahmen = Array.isArray(doc.massnahmen) ? doc.massnahmen : [];
    const m = massnahmen.find((x) => x && x.id === t.massnahmeId);
    if (!m) return json({ error: "Maßnahme nicht gefunden" }, 404, corsHeaders);

    // DAS Gate dieser Aktion. Bearbeiter duerfen ebenfalls, damit die Leitung
    // eine Luecke nachtragen kann, wenn jemand ausfaellt.
    const darfEditieren = await resolveEditPermission("schulsport", session, env, authHeader);
    if (!schulsportImTeam(m, session.username) && !darfEditieren) {
      return json({ error: "Für diese Maßnahme bist du nicht eingeteilt" }, 403, corsHeaders);
    }

    // durchgefuehrtVon darf nur jemand aus dem Team sein -- sonst koennte ein
    // Uebungsleiter eine Durchfuehrung einem Kollegen unterschieben.
    let durch = session.username;
    if (durchRoh && durchRoh !== session.username) {
      if (!schulsportImTeam(m, durchRoh)) {
        return json({ error: "Die angegebene Person ist für diese Maßnahme nicht eingeteilt" }, 400, corsHeaders);
      }
      durch = durchRoh;
    }

    // Ausfallgrund muss in der gepflegten Liste stehen.
    if (ausfallgrundId) {
      const gruende = Array.isArray(doc.ausfallgruende) ? doc.ausfallgruende : [];
      if (!gruende.some((g) => g && g.id === ausfallgrundId)) {
        return json({ error: "Unbekannter Ausfallgrund" }, 400, corsHeaders);
      }
    }

    // Genau diese Felder, nichts sonst.
    t.status = status;
    t.teilnehmerzahl = status === "durchgefuehrt" ? zahl : null;
    t.durchgefuehrtVon = status === "durchgefuehrt" ? durch : "";
    t.ausfallgrundId = status === "ausgefallen" ? ausfallgrundId : "";
    t.ausfallBemerkung = status === "ausgefallen" ? ausfallBemerkung : "";
    t.notiz = notiz;
    t.gemeldetVon = session.username;
    t.gemeldetAm = new Date().toISOString();
    doc.meta = { ...(doc.meta || {}), stand: t.gemeldetAm };

    try {
      const newRev = await writeJson(url, authHeader, doc, rev);
      return json({ ok: true, rev: newRev, termin: t }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && attempt < 3) continue;
      if (e instanceof ConflictError) {
        return json({ error: "Konflikt: bitte erneut versuchen", conflict: true }, 409, corsHeaders);
      }
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
}

// ---------- schulsport-nachweis-erstellen ----------
async function handleSchulsportNachweisErstellen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveEditPermission("schulsport", session, env, authHeader))) {
    return json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders);
  }

  const massnahmeId = String(body.massnahmeId || "");
  const vonDatum = capStr(body.vonDatum, 10);
  const bisDatum = capStr(body.bisDatum, 10);
  if (!massnahmeId) return json({ error: "Fehlende Maßnahmen-Id" }, 400, corsHeaders);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(vonDatum) || !/^\d{4}-\d{2}-\d{2}$/.test(bisDatum)) {
    return json({ error: "Ungültiger Zeitraum" }, 400, corsHeaders);
  }
  if (bisDatum < vonDatum) return json({ error: "Das Ende liegt vor dem Beginn" }, 400, corsHeaders);

  const url = DAV_APPS["schulsport"];
  for (let attempt = 1; attempt <= 3; attempt++) {
    jsonCache.delete(url);
    const { data: raw, rev } = await readJsonWithRev(url, authHeader, null);
    jsonCache.delete(url);
    const doc = (raw && typeof raw === "object") ? raw : null;
    if (!doc) return json({ error: "Es sind noch keine Daten hinterlegt" }, 404, corsHeaders);

    // ⚠️ Der Snapshot entsteht HIER, aus der Datei -- nie aus dem Body. Sonst
    // stuende im unterschriebenen Nachweis, was der Browser behauptet hat.
    const snapshot = schulsportSnapshot(doc, massnahmeId, vonDatum, bisDatum, session.usersDoc);
    if (!snapshot) return json({ error: "Maßnahme nicht gefunden" }, 404, corsHeaders);
    if (!snapshot.zeilen.length) return json({ error: "In diesem Zeitraum liegt kein Termin" }, 400, corsHeaders);

    if (!Array.isArray(doc.nachweise)) doc.nachweise = [];
    if (doc.nachweise.length >= SCHULSPORT_MAX_NACHWEISE) {
      return json({ error: "Es sind zu viele Nachweise gespeichert. Bitte ein Schuljahr archivieren." }, 400, corsHeaders);
    }

    const m = (doc.massnahmen || []).find((x) => x && x.id === massnahmeId) || {};
    const jetzt = new Date();
    const gueltigBis = new Date(jetzt.getTime() + SCHULSPORT_FREIGABE_TAGE * 86400000).toISOString();
    const token = schulsportNeuesToken();
    const eintrag = {
      id: crypto.randomUUID(),
      art: "massnahme",
      massnahmeId, schuleId: m.schuleId || "", schuljahr: m.schuljahr || "",
      vonDatum, bisDatum,
      erstelltVon: session.username, erstelltAm: jetzt.toISOString(),
      token, tokenAusgestelltAm: jetzt.toISOString(), gueltigBis,
      widerrufen: false, widerrufenAm: "", widerrufenVon: "",
      status: "offen",
      snapshot,
      bestaetigung: null, rueckfrage: null,
      versand: []
    };
    doc.nachweise.push(eintrag);
    doc.meta = { ...(doc.meta || {}), stand: jetzt.toISOString() };

    try {
      const newRev = await writeJson(url, authHeader, doc, rev);
      return json({
        ok: true, rev: newRev, id: eintrag.id, token,
        url: SCHULSPORT_FREIGABE_BASIS + "?t=" + token,
        gueltigBis, offeneTermine: snapshot.offeneTermine
      }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && attempt < 3) continue;
      if (e instanceof ConflictError) return json({ error: "Konflikt: bitte erneut versuchen", conflict: true }, 409, corsHeaders);
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
}

// ---------- schulsport-nachweis-senden ----------
// ⚠️ Empfaenger, Betreff und Text stehen serverseitig. Der Body traegt nur die
// Vorgangs-Id -- sonst waere die offene Worker-URL ein Versandweg an beliebige
// Adressen unter dem Absender des Vereins.
async function handleSchulsportNachweisSenden(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveEditPermission("schulsport", session, env, authHeader))) {
    return json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders);
  }
  const nachweisId = String(body.nachweisId || "");
  if (!nachweisId) return json({ error: "Fehlende Nachweis-Id" }, 400, corsHeaders);

  const url = DAV_APPS["schulsport"];
  jsonCache.delete(url);
  const { data: raw } = await readJsonWithRev(url, authHeader, null);
  jsonCache.delete(url);
  const doc = (raw && typeof raw === "object") ? raw : null;
  if (!doc) return json({ error: "Es sind noch keine Daten hinterlegt" }, 404, corsHeaders);

  const n = (Array.isArray(doc.nachweise) ? doc.nachweise : []).find((x) => x && x.id === nachweisId);
  if (!n) return json({ error: "Nachweis nicht gefunden" }, 404, corsHeaders);
  if (n.widerrufen) return json({ error: "Dieser Nachweis ist widerrufen" }, 400, corsHeaders);

  const schule = (Array.isArray(doc.schulen) ? doc.schulen : []).find((s) => s && s.id === n.schuleId);
  const email = schule ? capStr(schule.bestaetigungEmail, 200) : "";
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    // Kein Fehler: der Vorgang ist da schon gespeichert und der Link laesst sich
    // von Hand weitergeben. Der Client sagt es mit Klarnamen an.
    return json({ ok: true, sent: false, grund: "keine-adresse" }, 200, corsHeaders);
  }
  if (!env.BREVO_API_KEY) return json({ ok: true, sent: false, grund: "kein-versandweg" }, 200, corsHeaders);

  const link = SCHULSPORT_FREIGABE_BASIS + "?t=" + String(n.token || "");
  const s = (n.snapshot && n.snapshot.summen) || {};
  // Der Betreff nennt die Massnahme nicht -- er steht in der Handy-Vorschau und
  // im Versandprotokoll des Dienstleisters, also an zwei Stellen mehr als die App.
  const subject = "Nachweis zur Bestätigung — 1. SC 1911 Heiligenstadt";
  const message =
    "Guten Tag,\n\n" +
    "der 1. SC 1911 Heiligenstadt bittet um Ihre Bestätigung eines Durchführungsnachweises.\n\n" +
    "Maßnahme: " + ((n.snapshot && n.snapshot.massnahmeTitel) || "") + "\n" +
    // vaDatumLesbar trotz va-Praefix: die Funktion ist allgemein (ISO -> TT.MM.JJJJ),
    // und diese Mail geht an eine Schule -- ein ISO-Datum sieht dort nach Fehler aus.
    "Zeitraum: " + vaDatumLesbar(n.vonDatum) + " bis " + vaDatumLesbar(n.bisDatum) + "\n" +
    "Durchgeführte Einheiten: " + (s.durchgefuehrt || 0) + " von " + (s.geplant || 0) + "\n\n" +
    "Unter dem folgenden Link sehen Sie die vollständige Aufstellung aller Einheiten\n" +
    "mit Datum, Uhrzeit und Gruppe und können sie direkt am Bildschirm bestätigen.\n" +
    "Ein Benutzerkonto brauchen Sie dafür nicht, ein Klick auf den Link genügt:\n\n" +
    link + "\n\n" +
    "Die Bestätigung dauert nur einen Moment. Sie ist für uns die Grundlage der\n" +
    "Fördermittel-Abrechnung — ohne sie können wir die durchgeführten Einheiten\n" +
    "nicht geltend machen.\n\n" +
    "Der Link ist 30 Tage gültig. Stimmt etwas nicht oder fehlt Ihnen eine Angabe,\n" +
    "können Sie dort statt einer Bestätigung eine Rückfrage stellen; wir melden uns\n" +
    "dann bei Ihnen. Sie müssen auf diese Mail nicht antworten.\n\n" +
    "Mit freundlichen Grüßen\n" +
    "1. SC 1911 e.V. Heilbad Heiligenstadt\n" +
    "Leineberg 2, 37308 Heilbad Heiligenstadt\n" +
    "Telefon 03606 612206";

  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        sender: { email: NOTIFY_FROM_EMAIL, name: NOTIFY_FROM_NAME },
        to: [{ email }],
        subject, textContent: message
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("Brevo-Versand fehlgeschlagen (schulsport)", resp.status, errText);
      return json({ error: "Mail-Versand fehlgeschlagen (HTTP " + resp.status + ")" }, 502, corsHeaders);
    }
  } catch (e) {
    return json({ error: "Mail-Versand fehlgeschlagen: " + e.message }, 502, corsHeaders);
  }

  // Versand protokollieren -- eigener Lesevorgang, weil zwischen Lesen und
  // Senden Zeit vergangen ist.
  try {
    jsonCache.delete(url);
    const { data: raw2, rev: rev2 } = await readJsonWithRev(url, authHeader, null);
    jsonCache.delete(url);
    const doc2 = (raw2 && typeof raw2 === "object") ? raw2 : null;
    const n2 = doc2 && (doc2.nachweise || []).find((x) => x && x.id === nachweisId);
    if (n2) {
      if (!Array.isArray(n2.versand)) n2.versand = [];
      n2.versand.push({ art: "mail", an: email, am: new Date().toISOString(), ok: true, fehler: "" });
      await writeJson(url, authHeader, doc2, rev2);
    }
  } catch (_) {
    // Die Mail ist raus -- ein misslungener Protokolleintrag darf das nicht
    // zu einem Fehlschlag machen.
  }

  return json({ ok: true, sent: true, an: email }, 200, corsHeaders);
}

// ---------- schulsport-nachweis-status ----------
async function handleSchulsportNachweisStatus(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveEditPermission("schulsport", session, env, authHeader))) {
    return json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders);
  }
  const nachweisId = String(body.nachweisId || "");
  const was = String(body.was || "");
  if (!nachweisId) return json({ error: "Fehlende Nachweis-Id" }, 400, corsHeaders);
  if (["widerrufen", "verlaengern", "neu-ausstellen"].indexOf(was) === -1) {
    return json({ error: "Unbekannte Aktion" }, 400, corsHeaders);
  }

  const url = DAV_APPS["schulsport"];
  for (let attempt = 1; attempt <= 3; attempt++) {
    jsonCache.delete(url);
    const { data: raw, rev } = await readJsonWithRev(url, authHeader, null);
    jsonCache.delete(url);
    const doc = (raw && typeof raw === "object") ? raw : null;
    if (!doc) return json({ error: "Es sind noch keine Daten hinterlegt" }, 404, corsHeaders);
    const n = (Array.isArray(doc.nachweise) ? doc.nachweise : []).find((x) => x && x.id === nachweisId);
    if (!n) return json({ error: "Nachweis nicht gefunden" }, 404, corsHeaders);

    const jetzt = new Date();
    if (was === "widerrufen") {
      // ⚠️ Das Token wird geleert, nicht nur ein Flag gesetzt -- danach gibt es
      // keinen Weg mehr, ueber den der alte Link Daten liefern koennte.
      n.widerrufen = true;
      n.widerrufenAm = jetzt.toISOString();
      n.widerrufenVon = session.username;
      n.token = "";
      n.status = n.status === "offen" ? "widerrufen" : n.status;
    } else if (was === "verlaengern") {
      if (n.widerrufen) return json({ error: "Dieser Nachweis ist widerrufen" }, 400, corsHeaders);
      n.gueltigBis = new Date(jetzt.getTime() + SCHULSPORT_FREIGABE_TAGE * 86400000).toISOString();
    } else {
      if (n.status === "bestaetigt") {
        return json({ error: "Ein bestätigter Nachweis wird nicht neu ausgestellt" }, 400, corsHeaders);
      }
      // Neu ausstellen heisst: frische Zahlen einfrieren und ein neues Token.
      const neu = schulsportSnapshot(doc, n.massnahmeId, n.vonDatum, n.bisDatum, session.usersDoc);
      if (!neu) return json({ error: "Maßnahme nicht gefunden" }, 404, corsHeaders);
      n.snapshot = neu;
      n.token = schulsportNeuesToken();
      n.tokenAusgestelltAm = jetzt.toISOString();
      n.gueltigBis = new Date(jetzt.getTime() + SCHULSPORT_FREIGABE_TAGE * 86400000).toISOString();
      n.widerrufen = false;
      n.status = "offen";
      n.rueckfrage = null;
    }
    doc.meta = { ...(doc.meta || {}), stand: jetzt.toISOString() };

    try {
      const newRev = await writeJson(url, authHeader, doc, rev);
      return json({
        ok: true, rev: newRev, status: n.status, gueltigBis: n.gueltigBis,
        url: n.token ? SCHULSPORT_FREIGABE_BASIS + "?t=" + n.token : ""
      }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && attempt < 3) continue;
      if (e instanceof ConflictError) return json({ error: "Konflikt: bitte erneut versuchen", conflict: true }, 409, corsHeaders);
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
}

// ---------- schulsport-freigabe-lesen (OHNE Login) ----------
async function handleSchulsportFreigabeLesen(request, body, env, authHeader, corsHeaders) {
  // 1. Formpruefung zuerst -- die billigste Bremse, ohne jeden Datei-Zugriff.
  const token = String(body.token || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ error: "Ungültiger Link" }, 400, corsHeaders);
  // 2. Zaehlwerk je IP.
  if (!schulsportIpBremse(request)) return json({ error: "Zu viele Versuche" }, 429, corsHeaders);

  const doc = await readJson(DAV_APPS["schulsport"], authHeader, null);
  const nachweise = (doc && Array.isArray(doc.nachweise)) ? doc.nachweise : [];

  // 3. Vergleich timing-sicher, nicht mit ===.
  let treffer = null;
  for (const n of nachweise) {
    if (!n || !n.token) continue;
    if (await staticPasswordEquals(token, n.token)) { treffer = n; break; }
  }
  if (!treffer) {
    // Bremse wie bei requireFahrtenbuchExternCode.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return json({ error: "Dieser Link ist nicht gültig" }, 404, corsHeaders);
  }
  if (treffer.widerrufen) return json({ error: "Dieser Link wurde zurückgezogen" }, 410, corsHeaders);
  if (treffer.gueltigBis && new Date(treffer.gueltigBis) < new Date()) {
    return json({ error: "Dieser Link ist abgelaufen", abgelaufen: true }, 410, corsHeaders);
  }

  return json({ nachweis: schulsportOeffentlicherNachweis(treffer) }, 200, corsHeaders);
}

// ---------- ablaufplan-oeffentlich (OHNE Login) ----------
//
// Gibt GENAU EINEN Ablauf heraus, und davon nur die Felder, die auf einem Zettel
// am schwarzen Brett auch stehen duerften.
//
// ⚠️ Was hier bewusst NICHT mitgeht und auch nicht nachtraeglich ergaenzt werden
// darf, ohne den Datenschutz-Absatz auf plan.html mitzuziehen:
//   linkToken     -- der Ausweis selbst; wer die Seite offen hat, hat ihn ohnehin,
//                    aber er gehoert nicht in eine Antwort, die weitergeleitet wird
//   erstelltVon   -- ein Kontoname
//   anhaenge      -- Michel-Entscheidung: Anhaenge nur fuer Angemeldete
//   ALLE anderen Ablaeufe der Datei
function ablaufplanOeffentlicherAblauf(a) {
  return {
    titel: String(a.titel || ""),
    startDatum: String(a.startDatum || ""),
    endDatum: String(a.endDatum || a.startDatum || ""),
    ort: String(a.ort || ""),
    info: String(a.info || ""),
    punkte: (Array.isArray(a.punkte) ? a.punkte : []).map((p) => ({
      id: String((p && p.id) || ""),
      datum: String((p && p.datum) || ""),
      startZeit: String((p && p.startZeit) || ""),
      endZeit: String((p && p.endZeit) || ""),
      was: String((p && p.was) || ""),
      mannschaften: Array.isArray(p && p.mannschaften) ? p.mannschaften.map(String) : [],
      werFrei: String((p && p.werFrei) || ""),
      ort: String((p && p.ort) || ""),
      notiz: String((p && p.notiz) || "")
    }))
  };
}

async function handleAblaufplanOeffentlich(request, body, env, authHeader, corsHeaders) {
  // 1. Formpruefung zuerst -- die billigste Bremse, ohne jeden Datei-Zugriff.
  const token = String(body.token || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ error: "Ungültiger Link" }, 400, corsHeaders);
  // 2. Zaehlwerk je IP. Bewusst dasselbe wie beim Schulsport-Freigabelink: eine
  //    zweite Map brächte nichts, die Bremse gilt fuer login-lose Zugriffe.
  if (!schulsportIpBremse(request)) return json({ error: "Zu viele Versuche" }, 429, corsHeaders);

  const doc = await readJson(DAV_APPS["ablaufplan"], authHeader, null);
  const ablaeufe = (doc && Array.isArray(doc.ablaeufe)) ? doc.ablaeufe : [];

  // 3. Vergleich timing-sicher, nicht mit ===.
  let treffer = null;
  for (const a of ablaeufe) {
    if (!a || !a.linkToken) continue;
    if (await staticPasswordEquals(token, String(a.linkToken))) { treffer = a; break; }
  }
  if (!treffer) {
    // Bremse wie bei handleSchulsportFreigabeLesen: ein unbekannter Token darf
    // nicht schneller antworten als ein bekannter.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return json({ error: "Dieser Link ist nicht gültig" }, 404, corsHeaders);
  }
  if (treffer.linkWiderrufen) {
    return json({ error: "Dieser Link wurde zurückgezogen" }, 410, corsHeaders);
  }

  return json({ ablauf: ablaufplanOeffentlicherAblauf(treffer) }, 200, corsHeaders);
}

// ---------- schulsport-freigabe-senden (OHNE Login) ----------
async function handleSchulsportFreigabeSenden(request, body, env, authHeader, corsHeaders) {
  const token = String(body.token || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ error: "Ungültiger Link" }, 400, corsHeaders);
  if (!schulsportIpBremse(request)) return json({ error: "Zu viele Versuche" }, 429, corsHeaders);

  const art = String(body.art || "");
  if (art !== "bestaetigen" && art !== "rueckfrage") return json({ error: "Unbekannte Rückmeldung" }, 400, corsHeaders);

  const name = capStr(body.name, 120);
  if (!name) return json({ error: "Name fehlt" }, 400, corsHeaders);

  let funktion = "", unterschrift = "", text = "";
  if (art === "bestaetigen") {
    funktion = capStr(body.funktion, 120);
    unterschrift = typeof body.unterschriftDataUrl === "string" ? body.unterschriftDataUrl : "";
    if (!/^data:image\//.test(unterschrift)) return json({ error: "Unterschrift fehlt" }, 400, corsHeaders);
    if (unterschrift.length > MAX_SIGNATURE_DATA_URL_LENGTH) return json({ error: "Unterschrift zu groß" }, 400, corsHeaders);
  } else {
    text = capStr(body.text, 2000);
    if (!text) return json({ error: "Bitte beschreiben, was nicht stimmt" }, 400, corsHeaders);
  }

  const ip = capStr((request && request.headers && request.headers.get("CF-Connecting-IP")) || "", 60);
  const agent = capStr((request && request.headers && request.headers.get("User-Agent")) || "", 300);
  const url = DAV_APPS["schulsport"];

  // ⚠️ MIT If-Match und drei Versuchen -- bewusst anders als
  // handleFahrtenbuchExternSubmit, das unconditional schreibt. Eine gerade
  // geleistete Unterschrift darf nicht von einem gleichzeitigen dav-save der
  // Leitung ueberschrieben werden.
  for (let attempt = 1; attempt <= 3; attempt++) {
    jsonCache.delete(url);
    const { data: raw, rev } = await readJsonWithRev(url, authHeader, null);
    jsonCache.delete(url);
    const doc = (raw && typeof raw === "object") ? raw : null;
    const nachweise = (doc && Array.isArray(doc.nachweise)) ? doc.nachweise : [];

    let n = null;
    for (const x of nachweise) {
      if (!x || !x.token) continue;
      if (await staticPasswordEquals(token, x.token)) { n = x; break; }
    }
    if (!n) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return json({ error: "Dieser Link ist nicht gültig" }, 404, corsHeaders);
    }
    if (n.widerrufen) return json({ error: "Dieser Link wurde zurückgezogen" }, 410, corsHeaders);
    if (n.gueltigBis && new Date(n.gueltigBis) < new Date()) {
      return json({ error: "Dieser Link ist abgelaufen", abgelaufen: true }, 410, corsHeaders);
    }
    // Eine einmal geleistete Bestaetigung wird nicht ueberschrieben. Eine
    // Rueckfrage nach einer Rueckfrage ist dagegen erlaubt.
    if (n.status === "bestaetigt") return json({ error: "Dieser Nachweis wurde bereits bestätigt" }, 409, corsHeaders);

    const jetzt = new Date().toISOString();
    if (art === "bestaetigen") {
      n.bestaetigung = { name, funktion, unterschriftDataUrl: unterschrift, bestaetigtAm: jetzt, ip, agent };
      n.status = "bestaetigt";
      // Das Token wird verbraucht: ein zweiter Aufruf desselben Links soll den
      // Nachweis nicht erneut oeffnen koennen.
      n.token = "";
    } else {
      n.rueckfrage = { name, text, gestelltAm: jetzt, ip, agent };
      n.status = "rueckfrage";
    }
    doc.meta = { ...(doc.meta || {}), stand: jetzt };

    try {
      await writeJson(url, authHeader, doc, rev);
      return json({ ok: true, status: n.status }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && attempt < 3) continue;
      if (e instanceof ConflictError) return json({ error: "Bitte erneut versuchen", conflict: true }, 409, corsHeaders);
      return json({ error: "Speicherfehler" }, 502, corsHeaders);
    }
  }
}

// ---------- schulsport-archiv-load ----------
async function handleSchulsportArchivLoad(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await userMayAccessTool("schulsport", session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }
  const data = await readJson(SCHULSPORT_ARCHIV_URL, authHeader, { version: 1, schuljahre: [] });
  return json({ data }, 200, corsHeaders);
}

// ---------- schulsport-schuljahr-archivieren ----------
async function handleSchulsportSchuljahrArchivieren(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveAdminPermission("schulsport", session, env, authHeader))) {
    return json({ error: "Kein Administrieren-Recht für dieses Tool" }, 403, corsHeaders);
  }
  const schuljahr = capStr(body.schuljahr, 12);
  if (!/^\d{4}\/\d{2}$/.test(schuljahr)) return json({ error: "Ungültiges Schuljahr" }, 400, corsHeaders);

  const url = DAV_APPS["schulsport"];
  jsonCache.delete(url);
  const { data: raw, rev } = await readJsonWithRev(url, authHeader, null);
  jsonCache.delete(url);
  const doc = (raw && typeof raw === "object") ? raw : null;
  if (!doc) return json({ error: "Es sind noch keine Daten hinterlegt" }, 404, corsHeaders);

  const massnahmen = (Array.isArray(doc.massnahmen) ? doc.massnahmen : []).filter((m) => m && m.schuljahr === schuljahr);
  if (!massnahmen.length) return json({ ok: true, verschoben: {}, grund: "nichts-gefunden" }, 200, corsHeaders);
  const ids = new Set(massnahmen.map((m) => m.id));
  const termine = (Array.isArray(doc.termine) ? doc.termine : []).filter((t) => t && ids.has(t.massnahmeId));
  const zusatz = (Array.isArray(doc.zusatzeintraege) ? doc.zusatzeintraege : []).filter((z) => z && ids.has(z.massnahmeId));
  const nachweise = (Array.isArray(doc.nachweise) ? doc.nachweise : []).filter((n) => n && ids.has(n.massnahmeId));
  const sperrtage = (Array.isArray(doc.sperrtage) ? doc.sperrtage : []).filter((s) => s && s.schuljahr === schuljahr);

  // ⚠️ Reihenfolge ist bindend: ERST das Archiv schreiben, DANN aus der
  // Hauptdatei entfernen. Zwei Dateien lassen sich nicht atomar schreiben --
  // bricht es dazwischen ab, stehen Eintraege doppelt (harmlos, der naechste
  // Lauf raeumt auf). Andersherum waeren sie weg.
  const archiv = await readJson(SCHULSPORT_ARCHIV_URL, authHeader, { version: 1, schuljahre: [] });
  if (!Array.isArray(archiv.schuljahre)) archiv.schuljahre = [];
  let block = archiv.schuljahre.find((b) => b && b.schuljahr === schuljahr);
  if (!block) {
    block = { schuljahr, archiviertAm: "", archiviertVon: "", massnahmen: [], termine: [], zusatzeintraege: [], nachweise: [], sperrtage: [] };
    archiv.schuljahre.push(block);
  }
  // Merge nach id statt anhaengen -- dadurch ist ein zweiter Aufruf folgenlos.
  const mische = (ziel, quelle) => {
    const da = new Set((ziel || []).map((x) => x && x.id));
    (quelle || []).forEach((x) => { if (x && !da.has(x.id)) ziel.push(x); });
  };
  ["massnahmen", "termine", "zusatzeintraege", "nachweise", "sperrtage"].forEach((k) => {
    if (!Array.isArray(block[k])) block[k] = [];
  });
  mische(block.massnahmen, massnahmen);
  mische(block.termine, termine);
  mische(block.zusatzeintraege, zusatz);
  mische(block.nachweise, nachweise);
  mische(block.sperrtage, sperrtage);
  block.archiviertAm = new Date().toISOString();
  block.archiviertVon = session.username;
  archiv.meta = { version: 1, stand: block.archiviertAm };

  try {
    await writeJson(SCHULSPORT_ARCHIV_URL, authHeader, archiv, null);
  } catch (e) {
    return json({ error: "Das Archiv konnte nicht geschrieben werden: " + e.message }, 502, corsHeaders);
  }

  doc.massnahmen = (doc.massnahmen || []).filter((m) => !(m && m.schuljahr === schuljahr));
  doc.termine = (doc.termine || []).filter((t) => !(t && ids.has(t.massnahmeId)));
  doc.zusatzeintraege = (doc.zusatzeintraege || []).filter((z) => !(z && ids.has(z.massnahmeId)));
  doc.nachweise = (doc.nachweise || []).filter((n) => !(n && ids.has(n.massnahmeId)));
  doc.sperrtage = (doc.sperrtage || []).filter((s) => !(s && s.schuljahr === schuljahr));
  doc.meta = { ...(doc.meta || {}), stand: new Date().toISOString() };

  try {
    const newRev = await writeJson(url, authHeader, doc, rev);
    return json({
      ok: true, rev: newRev,
      verschoben: {
        Maßnahmen: massnahmen.length, Termine: termine.length,
        Nachweise: nachweise.length, Ferieneinträge: sperrtage.length
      }
    }, 200, corsHeaders);
  } catch (e) {
    // Das Archiv steht bereits -- ein Konflikt hier bedeutet nur, dass die
    // Hauptdatei noch aufgeraeumt werden muss. Der naechste Lauf holt das nach.
    if (e instanceof ConflictError) {
      return json({ error: "Das Archiv wurde geschrieben, die Hauptdatei aber zwischenzeitlich geändert. Bitte den Vorgang wiederholen.", conflict: true }, 409, corsHeaders);
    }
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }
}

// ---------- schulsport-erinnerung-push ----------
async function handleSchulsportErinnerungPush(request, body, env, authHeader, corsHeaders, execCtx) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveEditPermission("schulsport", session, env, authHeader))) {
    return json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders);
  }
  const massnahmeId = String(body.massnahmeId || "");

  const doc = await readJson(DAV_APPS["schulsport"], authHeader, null);
  if (!doc) return json({ ok: true, infrage: 0 }, 200, corsHeaders);

  const heute = new Date();
  const heuteIso = heute.getFullYear() + "-" + String(heute.getMonth() + 1).padStart(2, "0") + "-" + String(heute.getDate()).padStart(2, "0");
  const massnahmen = Array.isArray(doc.massnahmen) ? doc.massnahmen : [];
  const termine = Array.isArray(doc.termine) ? doc.termine : [];

  // Wer hat offene Meldungen? Empfaenger kommen aus dem DATENSATZ, nie aus dem
  // Request -- sonst koennte ein Bearbeiter beliebige Konten anschreiben lassen.
  // ⚠️ NICHT pushEmpfaengerMitRecht verwenden: das spiegelt
  // resolveEditPermission, und genau dieses Recht haben die Uebungsleiter hier
  // bewusst nicht.
  const offeneProPerson = new Map();
  for (const t of termine) {
    if (!t || t.datum > heuteIso) continue;
    const gemeldet = (t.status && t.status !== "offen") || (t.teilnehmerzahl !== null && t.teilnehmerzahl !== undefined) || t.gemeldetAm;
    if (gemeldet) continue;
    const m = massnahmen.find((x) => x && x.id === t.massnahmeId);
    if (!m) continue;
    if (massnahmeId && m.id !== massnahmeId) continue;
    const leute = [];
    if (m.verantwortlichUsername) leute.push(m.verantwortlichUsername);
    (Array.isArray(m.teamUsernames) ? m.teamUsernames : []).forEach((u) => { if (leute.indexOf(u) === -1) leute.push(u); });
    leute.forEach((u) => { offeneProPerson.set(u, (offeneProPerson.get(u) || 0) + 1); });
  }
  if (!offeneProPerson.size) return json({ ok: true, infrage: 0 }, 200, corsHeaders);

  const users = (session.usersDoc && session.usersDoc.users) || {};
  const empfaenger = [];
  for (const roh of offeneProPerson.keys()) {
    // ⚠️ Push-Abos liegen unter dem NORMALISIERTEN Namen. Weicht die
    // Schreibweise ab, liegt das Abo da und wird nie gefunden.
    const name = normalizeUsername(String(roh || ""));
    if (!name) continue;
    const u = getOwn(users, name) || getOwn(users, String(roh));
    if (!u || u.archiviert || !istPersonal(u)) continue;
    empfaenger.push(name);
  }
  if (!empfaenger.length) return json({ ok: true, infrage: 0 }, 200, corsHeaders);

  const text = empfaenger.length === 1 && offeneProPerson.size === 1
    ? "Es warten noch " + Array.from(offeneProPerson.values())[0] + " Termine auf deine Rückmeldung. Trag im Schulsport die Teilnehmerzahl nach, dann ist der Termin abgeschlossen."
    : "Es warten noch Termine auf deine Rückmeldung. Trag im Schulsport die Teilnehmerzahl nach, dann sind die Termine abgeschlossen.";
  pushSenden(env, authHeader, execCtx, empfaenger, "schulsport", text);

  return json({ ok: true, infrage: empfaenger.length }, 200, corsHeaders);
}

// ---------- Aktion: Fotoauftrag-Ordner anlegen (dedizierter Ordner + echter
// Nextcloud-Freigabelink pro Auftrag, via OCS-Sharing-API) ----------

function normalizeFotoauftraegeDoc(raw) {
  const doc = raw && typeof raw === "object" ? raw : {};
  return {
    meta: doc.meta && typeof doc.meta === "object" ? doc.meta : {},
    auftraege: Array.isArray(doc.auftraege) ? doc.auftraege : []
  };
}

// mannschaft ist Freitext (kein Enum) -- transliterate() (ä/ö/ü/ß, siehe unten
// bei den Gruppen-Helfern) plus Einkürzen auf [A-Za-z0-9-] neutralisiert dabei
// automatisch jeden Path-Traversal-Versuch im Feld, ohne den String separat
// gegen ein Blacklist-Muster prüfen zu müssen.
function slugifyMannschaftForPath(str) {
  const ascii = transliterate(String(str || "")).trim();
  const cleaned = ascii.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "Team").slice(0, 60);
}

function buildFotoauftragBasisPfad(mannschaft, datumIso, gegner) {
  const mannschaftSlug = slugifyMannschaftForPath(mannschaft);
  const gegnerSlug = gegner ? slugifyMannschaftForPath(gegner) : "";
  const teil = gegnerSlug ? `${mannschaftSlug}_${gegnerSlug}` : mannschaftSlug;
  return `${datumIso}_${teil}`;
}

// Legt den Ziel-Ordner an. Anders als ensureCollection() wird ein bereits
// existierender Name NICHT still wiederverwendet (405 heißt hier "Name schon
// vergeben", nicht "passt schon") -- sonst könnten zwei verschiedene Aufträge
// versehentlich denselben Nextcloud-Ordner (und dieselbe Freigabe) teilen.
// Kollisionsprüfung läuft bewusst gegen das echte Nextcloud-Dateisystem, nicht
// nur gegen JSON-Einträge (die könnten z.B. nach einem gelöschten Auftrag
// fehlen, obwohl der Ordner noch existiert).
async function ensureUniqueFotoauftragOrdner(basisFullUrl, authHeader) {
  const parentUrl = basisFullUrl.slice(0, basisFullUrl.lastIndexOf("/"));
  await ensureCollection(parentUrl, authHeader, 0); // gemeinsamer Basis-Ordner (06_Social Media) -- Wiederverwendung hier korrekt

  let suffix = 1;
  let candidateUrl = basisFullUrl;
  for (;;) {
    let resp = await fetch(candidateUrl, { method: "MKCOL", headers: { Authorization: authHeader } });
    if (resp.status === 201) return candidateUrl;
    if (resp.status === 409) {
      await ensureCollection(candidateUrl.slice(0, candidateUrl.lastIndexOf("/")), authHeader, 0);
      resp = await fetch(candidateUrl, { method: "MKCOL", headers: { Authorization: authHeader } });
      if (resp.status === 201) return candidateUrl;
    }
    if (resp.status === 405) {
      suffix += 1;
      if (suffix > 50) throw new NextcloudError("Konnte keinen freien Ordnernamen finden");
      candidateUrl = `${basisFullUrl}_${suffix}`;
      continue;
    }
    throw new NextcloudError(`Ordner anlegen fehlgeschlagen (MKCOL ${resp.status})`);
  }
}

function nextcloudOrigin(url) {
  return new URL(url).origin;
}

// Pfad relativ zum Nextcloud-Nutzer-Root, wie ihn die OCS-Share-API im
// "path"-Parameter erwartet -- aus einer vollen WebDAV-URL
// (.../remote.php/dav/files/<user>/<pfad>) extrahiert.
function nextcloudRelativePath(url) {
  const marker = "/remote.php/dav/files/";
  const pathname = new URL(url).pathname;
  const idx = pathname.indexOf(marker);
  if (idx === -1) throw new NextcloudError("Unerwartetes Nextcloud-URL-Format");
  const afterUser = pathname.slice(idx + marker.length);
  const slash = afterUser.indexOf("/");
  return decodeURIComponent(slash === -1 ? "" : afterUser.slice(slash));
}

// OCS-Sharing-API: erzeugt einen echten, eigenständigen Nextcloud-Freigabelink
// für GENAU diesen einen Ordner (shareType=3 = öffentlicher Link). Komplett
// NEU in dieser Flotte -- bisher nutzt jede App nur rohes WebDAV. Vor dem
// produktiven Verlassen auf diese Funktion unbedingt per Live-Probe gegen
// einen Wegwerf-Ordner verifizieren (siehe CLAUDE.md dieser App): die genauen
// Feldnamen der Antwort, ob permissions=15 wirklich "Ansehen + Hochladen"
// ergibt (nicht Drop-Box-Modus), und ob öffentliche Links auf diesem
// Tarif/dieser Instanz überhaupt aktiviert sind.
async function createPublicShare(folderWebdavUrl, authHeader) {
  const ocsUrl = nextcloudOrigin(folderWebdavUrl) + "/ocs/v2.php/apps/files_sharing/api/v1/shares";
  const form = new URLSearchParams();
  form.set("path", nextcloudRelativePath(folderWebdavUrl));
  form.set("shareType", "3");
  form.set("permissions", "15"); // read+update+create+delete ("Hochladen und Bearbeiten erlauben"), NICHT 4 (Datei-Ablage)
  let resp;
  try {
    resp = await fetch(ocsUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "OCS-APIRequest": "true",
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });
  } catch (e) {
    throw new NextcloudError("Nextcloud-Freigabe nicht erreichbar: " + e.message);
  }
  if (!resp.ok) throw new NextcloudError(`Nextcloud-Freigabe fehlgeschlagen (OCS ${resp.status})`);
  let parsed;
  try {
    parsed = await resp.json();
  } catch (_) {
    throw new NextcloudError("Unerwartete OCS-Antwort (kein JSON)");
  }
  const data = parsed && parsed.ocs && parsed.ocs.data;
  if (!data || typeof data.url !== "string" || typeof data.token !== "string") {
    throw new NextcloudError("OCS-Antwort enthält keine url/token — Response-Form gegen Live-Probe prüfen");
  }
  return { url: data.url, token: data.token };
}

async function rollbackFotoauftragToOffen(url, authHeader, id) {
  try {
    const { data, rev } = await readJsonWithRev(url, authHeader, { meta: {}, auftraege: [] });
    const doc = normalizeFotoauftraegeDoc(data);
    const a = doc.auftraege.find((x) => x && x.id === id);
    if (!a || a.status !== "wird-angelegt") return; // schon anderweitig verändert -- nicht anfassen
    a.status = "offen";
    a.ordnerWirdAngelegtVon = null;
    a.ordnerWirdAngelegtAm = null;
    await writeJson(url, authHeader, doc, rev);
  } catch (_) {
    // best-effort -- ein fehlgeschlagener Rollback darf den ursprünglichen Fehler nicht verdecken
  }
}

async function handleFotoauftragOrdnerAnlegen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const url = getOwn(DAV_APPS, "fotoauftraege");
  if (!url) return json({ error: "Unbekannte App" }, 400, corsHeaders);
  if (!(await userMayAccessTool("fotoauftraege", session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }

  const id = String(body.id || "");
  if (!id) return json({ error: "Fehlende id" }, 400, corsHeaders);

  // Phase A: reservieren (offen -> wird-angelegt). Der ETag-If-Match-Write
  // wirkt hier als Mutex -- wer den konditionalen Write verliert, bekommt 409,
  // BEVOR irgendein MKCOL/OCS-Aufruf passiert (siehe CLAUDE.md für die
  // Begründung, warum das bei dieser App nötig ist, anders als der sonst in
  // dieser Flotte akzeptierte Doppelbuchungs-Race).
  let { data, rev } = await readJsonWithRev(url, authHeader, { meta: {}, auftraege: [] });
  let doc = normalizeFotoauftraegeDoc(data);
  let auftrag = doc.auftraege.find((a) => a && a.id === id);
  if (!auftrag) return json({ error: "Auftrag nicht gefunden" }, 404, corsHeaders);
  if (auftrag.status !== "offen") {
    return json({ error: "Auftrag ist nicht mehr offen", conflict: true }, 409, corsHeaders);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(auftrag.datum || ""))) {
    return json({ error: "Auftrag hat ein ungültiges Datum" }, 400, corsHeaders);
  }
  if (!String(auftrag.mannschaft || "").trim()) {
    return json({ error: "Auftrag hat keine Mannschaft" }, 400, corsHeaders);
  }

  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  const user = getOwn(usersDoc.users, session.username);
  const isEditor = await resolveEditPermission("fotoauftraege", session, env, authHeader);
  if (!isEditor && !mayActOnFotoauftragTeam(auftrag.mannschaft, user)) {
    return json({ error: "Keine Berechtigung, für dieses Team einen Ordner anzulegen" }, 403, corsHeaders);
  }

  auftrag.status = "wird-angelegt";
  auftrag.ordnerWirdAngelegtVon = session.username;
  auftrag.ordnerWirdAngelegtAm = new Date().toISOString();
  try {
    rev = await writeJson(url, authHeader, doc, rev);
  } catch (e) {
    if (e instanceof ConflictError) {
      return json({ error: "Auftrag wird bereits von jemand anderem bearbeitet", conflict: true }, 409, corsHeaders);
    }
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  // Phase B: eigentliche Arbeit, genau einmal.
  const basisPfad = buildFotoauftragBasisPfad(auftrag.mannschaft, auftrag.datum, auftrag.gegner);
  let fullUrl, share;
  try {
    fullUrl = await ensureUniqueFotoauftragOrdner(FOTOAUFTRAEGE_ORDNER_BASIS + "/" + basisPfad, authHeader);
    share = await createPublicShare(fullUrl, authHeader);
  } catch (e) {
    await rollbackFotoauftragToOffen(url, authHeader, id);
    return json({ error: "Ordner/Freigabe konnte nicht angelegt werden: " + e.message }, 502, corsHeaders);
  }
  const relPath = fullUrl.slice(FOTOAUFTRAEGE_ORDNER_BASIS.length + 1);

  const applyFinal = (a) => {
    a.status = "ordner-angelegt";
    a.ordnerPfad = relPath;
    a.freigabeLink = share.url;
    a.freigabeToken = share.token;
    a.ordnerErstelltVon = session.username;
    a.ordnerErstelltVonVorname = (user && user.vorname) || null;
    a.ordnerErstelltVonNachname = (user && user.nachname) || null;
    a.ordnerErstelltAm = new Date().toISOString();
  };
  applyFinal(auftrag);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const newRev = await writeJson(url, authHeader, doc, rev);
      return json({ ok: true, auftrag, rev: newRev }, 200, corsHeaders);
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt === 3) {
        return json({
          error: "Ordner/Freigabe angelegt, aber Speichern fehlgeschlagen: " + e.message,
          ordnerPfad: relPath, freigabeLink: share.url
        }, 502, corsHeaders);
      }
      const fresh = await readJsonWithRev(url, authHeader, { meta: {}, auftraege: [] });
      doc = normalizeFotoauftraegeDoc(fresh.data);
      rev = fresh.rev;
      const freshAuftrag = doc.auftraege.find((a) => a && a.id === id);
      if (!freshAuftrag || freshAuftrag.status !== "wird-angelegt" || freshAuftrag.ordnerWirdAngelegtVon !== session.username) {
        return json({
          error: "Auftrag wurde zwischenzeitlich verändert", conflict: true,
          ordnerPfad: relPath, freigabeLink: share.url
        }, 409, corsHeaders);
      }
      auftrag = freshAuftrag;
      applyFinal(auftrag);
    }
  }
}

// Gemeinsamer Team-Zugehörigkeits-Check für fotoauftrag-ordner-anlegen UND
// fotoauftrag-spielbericht-hochladen (beide: Editor darf immer, sonst nur bei
// Team-Übereinstimmung mit dem eigenen mannschaften-Profil).
function mayActOnFotoauftragTeam(mannschaft, user) {
  const meineMannschaften = new Set(normalizeMannschaften(user && user.mannschaften));
  return meineMannschaften.has(mannschaft);
}

// Lädt eine vom Client aus Freitext erzeugte .docx-Datei (siehe buildSpielberichtDocxBlob
// in app.js) in denselben Nextcloud-Ordner, der auch die Fotos enthält -- landet damit
// automatisch im selben Freigabelink, ohne eigene neue Freigabe. Fixer Dateiname
// (Re-Upload überschreibt bewusst, ein Spielbericht pro Auftrag).
async function handleFotoauftragSpielberichtHochladen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const url = getOwn(DAV_APPS, "fotoauftraege");
  if (!url) return json({ error: "Unbekannte App" }, 400, corsHeaders);
  if (!(await userMayAccessTool("fotoauftraege", session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }

  const id = String(body.id || "");
  if (!id) return json({ error: "Fehlende id" }, 400, corsHeaders);
  const text = String(body.text || "").slice(0, 20000);
  if (!text.trim()) return json({ error: "Spielbericht ist leer" }, 400, corsHeaders);

  let bytes;
  try {
    bytes = base64ToBytes(String(body.dataBase64 || ""));
  } catch (_) {
    return json({ error: "Ungültige Datei-Daten" }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > MAX_FILE_BYTES) return json({ error: "Datei zu groß (max. 10 MB)" }, 413, corsHeaders);

  const { data, rev } = await readJsonWithRev(url, authHeader, { meta: {}, auftraege: [] });
  const doc = normalizeFotoauftraegeDoc(data);
  const auftrag = doc.auftraege.find((a) => a && a.id === id);
  if (!auftrag) return json({ error: "Auftrag nicht gefunden" }, 404, corsHeaders);
  if (!auftrag.ordnerPfad) {
    return json({ error: "Für diesen Auftrag existiert noch kein Ordner" }, 400, corsHeaders);
  }

  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  const user = getOwn(usersDoc.users, session.username);
  const isEditor = await resolveEditPermission("fotoauftraege", session, env, authHeader);
  if (!isEditor && !mayActOnFotoauftragTeam(auftrag.mannschaft, user)) {
    return json({ error: "Keine Berechtigung, für dieses Team einen Spielbericht hochzuladen" }, 403, corsHeaders);
  }

  const fileUrl = `${FOTOAUFTRAEGE_ORDNER_BASIS}/${auftrag.ordnerPfad}/Spielbericht.docx`;
  const putHeaders = { Authorization: authHeader, "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  let resp;
  try {
    resp = await fetch(fileUrl, { method: "PUT", headers: putHeaders, body: bytes });
    if (resp.status === 409 || resp.status === 404) {
      await ensureCollection(fileUrl.slice(0, fileUrl.lastIndexOf("/")), authHeader, 0);
      resp = await fetch(fileUrl, { method: "PUT", headers: putHeaders, body: bytes });
    }
  } catch (e) {
    return json({ error: "Nextcloud nicht erreichbar: " + e.message }, 502, corsHeaders);
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);

  auftrag.spielbericht = text;
  auftrag.spielberichtHochgeladenVon = session.username;
  auftrag.spielberichtHochgeladenVonVorname = (user && user.vorname) || null;
  auftrag.spielberichtHochgeladenVonNachname = (user && user.nachname) || null;
  auftrag.spielberichtHochgeladenAm = new Date().toISOString();

  try {
    const newRev = await writeJson(url, authHeader, doc, rev);
    return json({ ok: true, auftrag, rev: newRev }, 200, corsHeaders);
  } catch (e) {
    if (e instanceof ConflictError) {
      // Datei liegt bereits erfolgreich in Nextcloud (PUT war schon erfolgreich) --
      // nur das JSON-Update kollidierte. Client soll neu laden + erneut versuchen;
      // ein wiederholter Upload überschreibt lediglich dieselbe Datei nochmal, harmlos.
      return json({ error: "Auftrag wurde zwischenzeitlich verändert — bitte neu laden und erneut versuchen", conflict: true }, 409, corsHeaders);
    }
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }
}

// Löscht einen Auftrag vollständig -- inkl. des zugehörigen Nextcloud-Ordners
// (Fotos + Spielbericht), falls einer existiert. Editor-only (wie der
// Löschen-Button clientseitig es schon war), anders als ordner-anlegen/
// spielbericht-hochladen: das Entfernen echter Cloud-Daten ist bewusst NICHT
// dem zuständigen Trainer selbst überlassen. Schlägt das Nextcloud-DELETE mit
// einem echten Fehler fehl (nicht nur 404 = schon weg), wird NICHT trotzdem
// der JSON-Eintrag entfernt -- sonst verliert man die einzige Spur zu einem
// verwaisten, nicht wirklich gelöschten Ordner. WebDAV DELETE auf einen
// Ordner (Collection) ist per Spec (RFC 4918) implizit rekursiv -- kein
// zusätzlicher Depth-Header nötig, löscht Fotos+Spielbericht mit.
async function handleFotoauftragLoeschen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const url = getOwn(DAV_APPS, "fotoauftraege");
  if (!url) return json({ error: "Unbekannte App" }, 400, corsHeaders);
  if (!(await userMayAccessTool("fotoauftraege", session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }
  if (!(await resolveEditPermission("fotoauftraege", session, env, authHeader))) {
    return json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders);
  }

  const id = String(body.id || "");
  if (!id) return json({ error: "Fehlende id" }, 400, corsHeaders);

  const { data, rev } = await readJsonWithRev(url, authHeader, { meta: {}, auftraege: [] });
  const doc = normalizeFotoauftraegeDoc(data);
  const auftrag = doc.auftraege.find((a) => a && a.id === id);
  if (!auftrag) return json({ error: "Auftrag nicht gefunden" }, 404, corsHeaders);

  // Der zugehoerige Nextcloud-Ordner bleibt bewusst stehen (2026-07-21, Kehrtwende
  // zurueck zum urspruenglichen Verhalten): die Fotos sind das ARCHIV des Vereins
  // und ueberleben den Auftrag. Geloescht wird nur der Listeneintrag -- der Auftrag
  // ist ein Arbeitszettel, das Bildmaterial nicht. Gilt genauso fuer die
  // automatische Bereinigung nach Ablauf der Frist (AUTO_PRUNE_APPS, siehe dort).
  doc.auftraege = doc.auftraege.filter((a) => !(a && a.id === id));
  try {
    const newRev = await writeJson(url, authHeader, doc, rev);
    return json({ ok: true, rev: newRev }, 200, corsHeaders);
  } catch (e) {
    if (e instanceof ConflictError) {
      // Nichts ist passiert -- der Handler fasst ausser dieser JSON-Datei nichts
      // mehr an, ein erneuter Versuch auf frischem Stand ist folgenlos wiederholbar.
      return json({ error: "Auftrag wurde zwischenzeitlich verändert — bitte neu laden und erneut versuchen", conflict: true }, 409, corsHeaders);
    }
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }
}

// ---------- Aktionen: Datei-Anhänge (Binär-Upload für Gateway-Apps) ----------

const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB (muss zum Client-Cap in config.js passen)

// Verzeichnis-URL (ohne Slash am Ende) für die Datei-Anhänge einer App: der
// Unterordner "dateien" neben der JSON-Datendatei. Die einzelne Datei liegt unter
// <dir>/<id> — der Original-Dateiname fließt NIE in den Pfad ein (Path-Traversal-
// Schutz), er steht nur als Metadatum in der JSON der App.
function davFileDir(app) {
  const jsonUrl = getOwn(DAV_APPS, app);
  if (!jsonUrl) return null;
  return jsonUrl.slice(0, jsonUrl.lastIndexOf("/")) + "/dateien";
}

// Gemeinsame Vorprüfung aller Datei-Aktionen: Login, bekannte App, gültige
// Datei-Id (UUID) und Tool-Sichtbarkeit (wie dav-load/dav-save). Mit
// { requireEdit: true } (put/delete) zusätzlich ein Bearbeiten-Recht für Apps
// in WRITE_REQUIRES_EDIT_PERMISSION — get (Ansehen/Herunterladen) verlangt das
// bewusst nicht. Liefert { dir, fileUrl } oder { error: <fertige Response> }.
async function prepareFileAction(request, body, env, authHeader, corsHeaders, opts) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return { error: json({ error: "Nicht angemeldet" }, 401, corsHeaders) };
  const app = String(body.app || "");
  const dir = davFileDir(app);
  if (!dir) return { error: json({ error: "Unbekannte App" }, 400, corsHeaders) };
  const id = String(body.id || "");
  if (!FILE_ID_RE.test(id)) return { error: json({ error: "Ungültige Datei-Id" }, 400, corsHeaders) };
  if (!(await userMayAccessTool(app, session, env, authHeader))) {
    return { error: json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders) };
  }
  if (opts && opts.requireEdit && WRITE_REQUIRES_EDIT_PERMISSION.has(app) &&
      !(await resolveEditPermission(app, session, env, authHeader))) {
    return { error: json({ error: "Kein Bearbeiten-Recht für dieses Tool" }, 403, corsHeaders) };
  }
  return { dir, fileUrl: dir + "/" + id };
}

async function handleDavFilePut(request, body, env, authHeader, corsHeaders) {
  const p = await prepareFileAction(request, body, env, authHeader, corsHeaders, { requireEdit: true });
  if (p.error) return p.error;

  let bytes;
  try {
    bytes = base64ToBytes(String(body.dataBase64 || ""));
  } catch (_) {
    return json({ error: "Datei-Inhalt ist kein gültiges base64" }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > MAX_FILE_BYTES) return json({ error: "Datei zu groß" }, 413, corsHeaders);

  // Content-Type nur als schlichter ASCII-String übernehmen (kein CR/LF -> keine
  // Header-Injektion), sonst Fallback.
  let ctype = String(body.contentType || "").replace(/[^\x20-\x7e]/g, "");
  if (!ctype || ctype.length > 200) ctype = "application/octet-stream";

  const headers = { Authorization: authHeader, "Content-Type": ctype };
  let resp = await fetch(p.fileUrl, { method: "PUT", headers, body: bytes });
  // 409 oder 404 beim PUT = ein Elternordner existiert noch nicht -> anlegen und
  // EINMAL wiederholen (MKCOL-Autofix, wie bei der ersten JSON-Speicherung).
  // Nextcloud liefert 409, wenn nur EIN Ordner-Level fehlt (z.B. nur "dateien"),
  // aber 404, wenn zwei oder mehr Ebenen zugleich fehlen — das passiert, wenn eine
  // App ihre erste Datei hochlädt, bevor sie je ihre JSON-Datei gespeichert hat
  // (dann fehlen der App-Ordner UND dessen "dateien"-Unterordner gleichzeitig).
  if (resp.status === 409 || resp.status === 404) {
    await ensureCollection(p.dir, authHeader, 0);
    resp = await fetch(p.fileUrl, { method: "PUT", headers, body: bytes });
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

async function handleDavFileGet(request, body, env, authHeader, corsHeaders) {
  const p = await prepareFileAction(request, body, env, authHeader, corsHeaders);
  if (p.error) return p.error;

  let resp;
  try {
    resp = await fetch(p.fileUrl, { method: "GET", headers: { Authorization: authHeader } });
  } catch (_) {
    return json({ error: "Nextcloud nicht erreichbar" }, 502, corsHeaders);
  }
  if (resp.status === 404) return json({ error: "Datei nicht gefunden" }, 404, corsHeaders);
  if (!resp.ok) return json({ error: `Nextcloud GET ${resp.status}` }, 502, corsHeaders);
  const ctype = resp.headers.get("Content-Type") || "application/octet-stream";
  // Rohe Bytes als Stream durchreichen, mit CORS-Headern; der Client baut daraus
  // per Blob einen Download-/Vorschau-Link.
  return new Response(resp.body, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": ctype, "Cache-Control": "private, no-store" }
  });
}

async function handleDavFileDelete(request, body, env, authHeader, corsHeaders) {
  const p = await prepareFileAction(request, body, env, authHeader, corsHeaders, { requireEdit: true });
  if (p.error) return p.error;

  const resp = await fetch(p.fileUrl, { method: "DELETE", headers: { Authorization: authHeader } });
  // 204/200 = gelöscht, 404 = war schon weg — beides ist Erfolg fürs Aufräumen.
  if (resp.ok || resp.status === 404) return json({ ok: true }, 200, corsHeaders);
  return json({ error: `Nextcloud DELETE ${resp.status}` }, 502, corsHeaders);
}

// ---------- Aktionen: Abgeschottete Datei-Anhänge (nur Eigentümer/Gruppe/Admin) ----------
//
// Anders als dav-file-* (jede Datei-Id für jeden mit Tool-Zugriff lesbar) ist dieser
// Bereich echt serverseitig abgeschottet: die Datei liegt unter <app>/<subdir>/<owner>,
// wobei owner ein validierter Nutzername ist. dav-file-get kann ihn nicht erreichen
// (fester "dateien/"-Pfad + UUID-Pflicht), und get/delete verlangen mayViewRestricted.

// Verzeichnis-URL (ohne Slash am Ende) + Sicht-Gruppe des abgeschotteten Bereichs
// einer App; null, wenn die App keinen solchen Bereich konfiguriert hat.
function restrictedFileDir(app) {
  const jsonUrl = getOwn(DAV_APPS, app);
  const cfg = getOwn(RESTRICTED_FILE_APPS, app);
  if (!jsonUrl || !cfg) return null;
  return { dir: jsonUrl.slice(0, jsonUrl.lastIndexOf("/")) + "/" + cfg.subdir, viewGroupId: cfg.viewGroupId };
}

// Darf diese Sitzung die abgeschottete Datei des Eigentümers <owner> sehen/löschen?
// Eigentümer selbst, Admins und Mitglieder der viewGroupId — sonst nein.
function mayViewRestricted(session, viewGroupId, owner) {
  if (session.isAdmin) return true;
  if (session.username === owner) return true;
  return session.groupIds.includes(viewGroupId);
}

// Eigene abgeschottete Datei hochladen. Der Dateiname ist IMMER der eigene, aus dem
// signierten Token stammende Nutzername — ein Client kann so ausschließlich seine
// EIGENE Datei schreiben, niemals eine fremde überschreiben (kein id/owner aus dem Body).
async function handleDavRestrictedPut(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const app = String(body.app || "");
  const rf = restrictedFileDir(app);
  if (!rf) return json({ error: "Unbekannte App" }, 400, corsHeaders);
  if (!(await userMayAccessTool(app, session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }
  const owner = session.username; // aus dem Token, nie aus dem Body
  if (!USERNAME_RE.test(owner)) return json({ error: "Ungültiger Eigentümer" }, 400, corsHeaders);

  let bytes;
  try {
    bytes = base64ToBytes(String(body.dataBase64 || ""));
  } catch (_) {
    return json({ error: "Datei-Inhalt ist kein gültiges base64" }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > MAX_FILE_BYTES) return json({ error: "Datei zu groß" }, 413, corsHeaders);

  let ctype = String(body.contentType || "").replace(/[^\x20-\x7e]/g, "");
  if (!ctype || ctype.length > 200) ctype = "application/octet-stream";

  const fileUrl = rf.dir + "/" + owner;
  const headers = { Authorization: authHeader, "Content-Type": ctype };
  let resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  // 409/404 = ein Elternordner (App-Ordner und/oder "fuehrerscheine") fehlt noch -> anlegen und EINMAL wiederholen.
  if (resp.status === 409 || resp.status === 404) {
    await ensureCollection(rf.dir, authHeader, 0);
    resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

// Abgeschottete Datei eines Eigentümers holen — nur mit mayViewRestricted-Recht.
async function handleDavRestrictedGet(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const app = String(body.app || "");
  const rf = restrictedFileDir(app);
  if (!rf) return json({ error: "Unbekannte App" }, 400, corsHeaders);
  if (!(await userMayAccessTool(app, session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }
  const owner = normalizeUsername(body.owner);
  if (!USERNAME_RE.test(owner)) return json({ error: "Ungültiger Eigentümer" }, 400, corsHeaders);
  if (!mayViewRestricted(session, rf.viewGroupId, owner)) {
    return json({ error: "Kein Zugriff auf diese Datei" }, 403, corsHeaders);
  }
  const fileUrl = rf.dir + "/" + owner;
  let resp;
  try {
    resp = await fetch(fileUrl, { method: "GET", headers: { Authorization: authHeader } });
  } catch (_) {
    return json({ error: "Nextcloud nicht erreichbar" }, 502, corsHeaders);
  }
  if (resp.status === 404) return json({ error: "Datei nicht gefunden" }, 404, corsHeaders);
  if (!resp.ok) return json({ error: `Nextcloud GET ${resp.status}` }, 502, corsHeaders);
  const ctype = resp.headers.get("Content-Type") || "application/octet-stream";
  return new Response(resp.body, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": ctype, "Cache-Control": "private, no-store" }
  });
}

// Abgeschottete Datei löschen — gleiches Recht wie das Ansehen (Eigentümer/Gruppe/Admin).
async function handleDavRestrictedDelete(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const app = String(body.app || "");
  const rf = restrictedFileDir(app);
  if (!rf) return json({ error: "Unbekannte App" }, 400, corsHeaders);
  if (!(await userMayAccessTool(app, session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }
  const owner = normalizeUsername(body.owner);
  if (!USERNAME_RE.test(owner)) return json({ error: "Ungültiger Eigentümer" }, 400, corsHeaders);
  if (!mayViewRestricted(session, rf.viewGroupId, owner)) {
    return json({ error: "Kein Zugriff auf diese Datei" }, 403, corsHeaders);
  }
  const fileUrl = rf.dir + "/" + owner;
  const resp = await fetch(fileUrl, { method: "DELETE", headers: { Authorization: authHeader } });
  if (resp.ok || resp.status === 404) return json({ ok: true }, 200, corsHeaders);
  return json({ error: `Nextcloud DELETE ${resp.status}` }, 502, corsHeaders);
}

// ---------- Aktionen: Fahrtenbuch extern (ohne Login, Zugriffscode) ----------
//
// Eltern ohne eigenes Tools-Übersicht-Konto tragen eine Fahrt ein bzw. laden
// Mängelfotos/Führerschein hoch. Kein getVerifiedSession() — jeder der drei
// Handler prüft stattdessen unabhängig über requireFahrtenbuchExternCode()
// denselben Zugriffscode. Bewusst fest an app "fahrtenbuch" gebunden, kein
// generisches app-Feld aus dem Body (kein Login -> kein Bezug zu
// userMayAccessTool, das Konzept "Tool-Sichtbarkeit" existiert hier nicht).

// Schema-Ausschnitt aus fahrtenbuch/config.js (ALLE_CHECK_KEYS). Der Worker hat
// keinen Import-Zugriff auf die App-eigene config.js (separates Deployment) —
// bei Änderung der Checkbox-Keys dort IMMER auch hier nachziehen.
const FAHRTENBUCH_CHECK_KEYS = [
  "chkFuehrerschein", "chkMindestalter", "chkKeinAlkohol",
  "chkSicherheitVor", "chkSichtVor",
  "chkVollgetankt", "chkReinigung", "chkSicherheitNach", "chkSichtNach"
];

const MAX_SIGNATURE_DATA_URL_LENGTH = 2 * 1024 * 1024; // ~1.5 MB dekodiert – reicht für eine Canvas-Unterschrift
const MAX_EXTERN_FOTOS = 20;

function capStr(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

// Gemeinsame Codeprüfung der drei fahrtenbuch-extern-*-Aktionen. Bewusst EIN
// Secret für Fahrt-Eintrag + Mängelfoto + Führerschein (kein separater Vorab-
// Verify-Call nötig — jeder der drei Handler ruft dies selbst auf, ist also für
// sich vollständig authentifiziert, exakt wie handleVerifyActionPassword selbst).
async function requireFahrtenbuchExternCode(body, env, corsHeaders) {
  if (!env.PW_FAHRTENBUCH_EXTERN) {
    return { error: json({ error: "Zugriffscode ist serverseitig nicht konfiguriert" }, 500, corsHeaders) };
  }
  const ok = await staticPasswordEquals(String(body.code || ""), env.PW_FAHRTENBUCH_EXTERN);
  if (!ok) {
    // Bremse gegen Durchprobieren — die Aktion ist ohne Login erreichbar.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { error: json({ error: "Falscher Zugriffscode" }, 403, corsHeaders) };
  }
  return { ok: true };
}

async function handleFahrtenbuchExternSubmit(body, env, authHeader, corsHeaders, execCtx) {
  const codeCheck = await requireFahrtenbuchExternCode(body, env, corsHeaders);
  if (codeCheck.error) return codeCheck.error;

  const f = body.fahrt && typeof body.fahrt === "object" ? body.fahrt : {};

  const fahrerName = capStr(f.fahrerName, 120);
  const reiseziel = capStr(f.reiseziel, 200);
  const unterschrift = typeof f.unterschriftDataUrl === "string" ? f.unterschriftDataUrl : "";
  if (!fahrerName) return json({ error: "Name des Fahrers fehlt" }, 400, corsHeaders);
  if (!reiseziel) return json({ error: "Reiseziel fehlt" }, 400, corsHeaders);
  if (!/^data:image\//.test(unterschrift)) return json({ error: "Unterschrift fehlt" }, 400, corsHeaders);
  if (unterschrift.length > MAX_SIGNATURE_DATA_URL_LENGTH) return json({ error: "Unterschrift zu groß" }, 400, corsHeaders);

  const id = (typeof f.id === "string" && /^[0-9a-f-]{8,64}$/i.test(f.id)) ? f.id : crypto.randomUUID();

  const fotosIn = Array.isArray(f.maengelFotos) ? f.maengelFotos.slice(0, MAX_EXTERN_FOTOS) : [];
  const maengelFotos = fotosIn.map((p) => {
    const fid = p && typeof p.id === "string" ? p.id : "";
    if (!FILE_ID_RE.test(fid)) return null;
    return {
      id: fid,
      name: capStr(p.name, 200) || "Foto",
      contentType: capStr(p.contentType, 100).replace(/[^\x20-\x7e]/g, "") || "image/jpeg"
    };
  }).filter(Boolean);

  let fuehrerscheinKey = null;
  if (typeof f.fuehrerscheinKey === "string" && f.fuehrerscheinKey) {
    if (!USERNAME_RE.test(f.fuehrerscheinKey)) {
      return json({ error: "Ungültiger Führerschein-Schlüssel" }, 400, corsHeaders);
    }
    fuehrerscheinKey = f.fuehrerscheinKey;
  }

  const entry = {
    id,
    erstelltVon: "",
    erstelltAm: new Date().toISOString(),
    quelle: "extern", // server-hart gesetzt, NIE aus dem Client-Body übernommen
    fahrerName, reiseziel,
    kennzeichen: capStr(f.kennzeichen, 20),
    abteilung: capStr(f.abteilung, 120),
    anzahlInsassen: capStr(f.anzahlInsassen, 5),
    kmStart: capStr(f.kmStart, 10),
    kmEnde: capStr(f.kmEnde, 10),
    datumStart: capStr(f.datumStart, 10),
    datumEnde: capStr(f.datumEnde, 10),
    uhrzeitStart: capStr(f.uhrzeitStart, 5),
    uhrzeitEnde: capStr(f.uhrzeitEnde, 5),
    uebernahmeVon: capStr(f.uebernahmeVon, 120),
    abholort: capStr(f.abholort, 120),
    uebergabeAn: capStr(f.uebergabeAn, 120),
    abstellort: capStr(f.abstellort, 120),
    maengelText: capStr(f.maengelText, 2000),
    maengelFotos,
    unterschriftDataUrl: unterschrift,
    status: "abgeschlossen", // extern immer sofort abgeschlossen, kein Zwischenspeichern
    fuehrerscheinKey
  };
  FAHRTENBUCH_CHECK_KEYS.forEach((k) => { entry[k] = !!f[k]; });

  const url = DAV_APPS.fahrtenbuch;
  const doc = await readJson(url, authHeader, { meta: {}, fahrten: [] });
  doc.meta = doc.meta && typeof doc.meta === "object" ? doc.meta : {};
  doc.fahrten = Array.isArray(doc.fahrten) ? doc.fahrten : [];

  // Idempotenz: erneuter Submit mit derselben (vom Client VOR diesem Aufruf
  // erzeugten) id — z.B. weil eine Mobilfunkverbindung mitten in der Antwort
  // abbrach und das Formular erneut sendet — überschreibt denselben Eintrag,
  // statt eine zweite Fahrt anzulegen. Der Abgleich läuft NUR gegen bereits
  // vorhandene EXTERNE Einträge (quelle==="extern") — sonst könnte ein
  // Zugriffscode-Inhaber über eine erratene/bekannte interne Fahrt-Id eine
  // echte, intern erfasste Fahrt überschreiben.
  const existingIdx = doc.fahrten.findIndex((x) => x && x.id === id && x.quelle === "extern");
  if (existingIdx >= 0) doc.fahrten[existingIdx] = entry;
  else doc.fahrten.push(entry);
  doc.meta.stand = new Date().toISOString();

  try {
    await writeJson(url, authHeader, doc); // unconditional, wie handleSubmitFeedback -- akzeptiertes Race-Risiko
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  // Push an die Zustaendigen (seit 2026-08-03). Erst NACH dem Speichern: die
  // Fahrt ist die Handlung, die Meldung nur ein Hinweis darauf.
  //
  // ⚠️ Dieser Weg hat KEINE Sitzung -- eingereicht wird per Zugriffscode ohne
  // Login. Deshalb wird nutzer.json hier eigens gelesen (sonst kommt usersDoc
  // aus der Session) und es gibt niemanden, den man ausschliessen muesste.
  // Ein Fehler darf die schon gespeicherte Fahrt nicht kippen.
  try {
    const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
    const empfaenger = await pushEmpfaengerMitRecht("fahrtenbuch", usersDoc, env, authHeader, "");
    pushSenden(env, authHeader, execCtx, empfaenger, "fahrtenbuch",
      "Eine Fahrt wurde zur Abrechnung eingereicht. Im Fahrtenbuch kannst du sie prüfen und freigeben.");
  } catch (e) {
    console.error("Fahrtenbuch-Push fehlgeschlagen: " + (e && e.message ? e.message : e));
  }

  return json({ ok: true, id }, 200, corsHeaders);
}

async function handleFahrtenbuchExternFilePut(body, env, authHeader, corsHeaders) {
  const codeCheck = await requireFahrtenbuchExternCode(body, env, corsHeaders);
  if (codeCheck.error) return codeCheck.error;

  const dir = davFileDir("fahrtenbuch");
  const id = String(body.id || "");
  if (!FILE_ID_RE.test(id)) return json({ error: "Ungültige Datei-Id" }, 400, corsHeaders);

  let bytes;
  try {
    bytes = base64ToBytes(String(body.dataBase64 || ""));
  } catch (_) {
    return json({ error: "Datei-Inhalt ist kein gültiges base64" }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > MAX_FILE_BYTES) return json({ error: "Datei zu groß" }, 413, corsHeaders);

  let ctype = String(body.contentType || "").replace(/[^\x20-\x7e]/g, "");
  if (!ctype || ctype.length > 200) ctype = "application/octet-stream";

  const fileUrl = dir + "/" + id;
  const headers = { Authorization: authHeader, "Content-Type": ctype };
  let resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  if (resp.status === 409 || resp.status === 404) {
    await ensureCollection(dir, authHeader, 0);
    resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

async function handleFahrtenbuchExternFuehrerscheinPut(body, env, authHeader, corsHeaders) {
  const codeCheck = await requireFahrtenbuchExternCode(body, env, corsHeaders);
  if (codeCheck.error) return codeCheck.error;

  const rf = restrictedFileDir("fahrtenbuch");
  if (!rf) return json({ error: "Abgeschotteter Bereich nicht konfiguriert" }, 500, corsHeaders);

  // Owner-Schlüssel ist ein Zugriffs-Capability für ein sensibles Dokument —
  // wird NIE frei vom Client erfunden. Erst-Upload: Server generiert (leerer/
  // fehlender owner im Body). Re-Upload/Ersetzen in derselben Sitzung: Client
  // schickt den zuvor VOM SERVER erhaltenen Wert zurück, damit dieselbe Datei
  // überschrieben wird statt eine zweite, verwaiste Datei anzulegen.
  let owner = String(body.owner || "");
  if (owner && !USERNAME_RE.test(owner)) {
    return json({ error: "Ungültiger Owner-Schlüssel" }, 400, corsHeaders);
  }
  if (!owner) owner = crypto.randomUUID().replace(/-/g, ""); // 32 Hex-Zeichen, erfüllt USERNAME_RE {3,32}

  let bytes;
  try {
    bytes = base64ToBytes(String(body.dataBase64 || ""));
  } catch (_) {
    return json({ error: "Datei-Inhalt ist kein gültiges base64" }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > MAX_FILE_BYTES) return json({ error: "Datei zu groß" }, 413, corsHeaders);

  let ctype = String(body.contentType || "").replace(/[^\x20-\x7e]/g, "");
  if (!ctype || ctype.length > 200) ctype = "application/octet-stream";

  const fileUrl = rf.dir + "/" + owner;
  const headers = { Authorization: authHeader, "Content-Type": ctype };
  let resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  if (resp.status === 409 || resp.status === 404) {
    await ensureCollection(rf.dir, authHeader, 0);
    resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);
  return json({ ok: true, owner }, 200, corsHeaders);
}

// =====================================================================
// Vereinsverwaltung: Nachweise zur Nachwuchs-Anmeldung
// =====================================================================
//
// Der Verband verlangt zum Spielerlaubnisantrag Anlagen: bei einer
// Erstausstellung die Geburtsurkunde oder einen Ausweis, beim
// Vereinswechsel den alten Spielerpass und den Abmeldenachweis.
//
// ⚠️ Warum das hier steht und nicht im Vereinsverwaltungs-Worker: der hat
// KEIN Nextcloud-Binding (seine Daten liegen in D1) und soll auch keines
// bekommen. Ausweiskopien gehoeren nicht in dieselbe Datenbank wie
// Beitraege und Buchhaltung -- die naechtliche Sicherung zoege sie sonst
// jedesmal mit. Der Browser laedt sie deshalb direkt hierher.
//
// Ablage: <Vereinsverwaltung>/nachweise/<owner>/<slot>. Der Owner ist ein
// serverseitig vergebener 32-Hex-Schluessel, KEIN Nutzername -- Eltern
// haben keinen. Der Unterordner je Antrag ist der Unterschied zum
// RESTRICTED_FILE_APPS-Muster, das genau eine Datei je Schluessel kennt;
// hier koennen zwei bis drei Anlagen zusammengehoeren.
//
// ⚠️ Der Ordner traegt bewusst KEINEN Namen und kein Datum, obwohl beides
// beim Hochladen bekannt waere (siehe die lesbare Ablage im Fahrtenbuch).
// Der Upload passiert VOR dem Absenden und ohne jede Anmeldung -- ein
// Name aus dem Koerper waere eine ungeprueft uebernommene Personendatei
// im Pfad und zugleich der uebliche Weg zum Ausbruch aus dem Verzeichnis.
// Wer die Dateien zuordnen will, geht ueber den Antrag; dort stehen Name
// und Eingangsdatum.
const VV_NACHWEIS_DIR =
  VEREINSAUFGABEN_URL.slice(0, VEREINSAUFGABEN_URL.lastIndexOf("/Tools/")) +
  "/Tools/Vereinsverwaltung/nachweise";

// Feste Weissliste. Der Slot wird Teil des Dateinamens -- ein freier Wert
// waere der zweite Ausbruchsweg neben dem Owner.
//
// "passbild" ist kein Nachweis im Sinne des Bogens, liegt aber aus gutem
// Grund hier: es wird im selben Zug von derselben Familie hochgeladen und
// gehoert zu demselben Vorgang. Der Verband druckt es NICHT auf das
// Formular (das hat gar kein Bildfeld) -- die Geschaeftsstelle laedt es
// beim Eintragen in DFBnet Pass-Online hoch.
const VV_NACHWEIS_SLOTS = new Set([
  "geburtsurkunde", "spielerpass", "abmeldung", "namensaenderung", "passbild"
]);

// Das FERTIGE Verbandsformular, das die Geschaeftsstelle erzeugt hat.
// Eigener Ordner und eigene Aktionen, bewusst getrennt von den Nachweisen:
// anderer Urheber (der Verein statt der Familie), andere Vertrauensstufe
// (angemeldet statt offen) und ein anderer Schluessel -- die Antrags-Id,
// nicht der Nachweis-Owner. Der Verband verlangt Aufbewahrung des
// unterschriebenen Antrags beim Verein fuer mindestens zwei Jahre.
const VV_ANTRAG_DIR =
  VEREINSAUFGABEN_URL.slice(0, VEREINSAUFGABEN_URL.lastIndexOf("/Tools/")) +
  "/Tools/Vereinsverwaltung/spielerlaubnis";

// Antrags-Ids sind UUIDs aus crypto.randomUUID() -- mit Bindestrichen,
// anders als der Nachweis-Owner. Deshalb ein eigenes Muster.
const VV_ANTRAG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const VV_NACHWEIS_OWNER_RE = /^[0-9a-f]{32}$/;

// ⚠️ vv-nachweis-put ist der einzige Schreibweg des Gateways, der WEDER eine
// Sitzung NOCH einen Zugriffscode NOCH einen Token verlangt -- Eltern haben
// nichts davon, und einen Token gaebe es erst nach dem Absenden, waehrend die
// Anlagen davor hochgeladen werden. Der Kommentar an der Aktionsweiche berief
// sich auf "gleiche Bauform wie fahrtenbuch-extern-fuehrerschein-put"; die ruft
// aber requireFahrtenbuchExternCode() als erste Zeile. Was hier stattdessen
// bremst, sind die beiden Schranken darunter: ein Zaehlwerk je IP und der
// Dateityp aus den ersten Bytes. Ohne sie war der Endpunkt fuer jeden, der die
// Worker-Adresse kennt, ein unbegrenzter Ablageplatz fuer beliebige Dateien.
const VV_NACHWEIS_IP_ZAEHLER = new Map();
// Eine Familie laedt zwei bis drei Anlagen plus Passbild hoch, oft mit einem
// zweiten Anlauf, wenn das Foto unscharf war. 40 je Stunde lassen das bequem zu
// und decken auch den Fall ab, dass mehrere Familien im selben Netz sitzen
// (Elternabend). Bewusst niedriger als bei der Kleiderbestellung: dort scannt
// eine ganze Mannschaft gleichzeitig, hier meldet eine Familie ein Kind an.
const VV_NACHWEIS_MAX_PRO_STUNDE = 40;

function vvNachweisIpBremse(request) {
  const ip = String((request && request.headers && request.headers.get("CF-Connecting-IP")) || "");
  if (!ip) return true;
  const jetzt = Date.now();
  const eintrag = VV_NACHWEIS_IP_ZAEHLER.get(ip);
  if (!eintrag || jetzt - eintrag.start > 3600000) {
    VV_NACHWEIS_IP_ZAEHLER.set(ip, { start: jetzt, n: 1 });
    // Aufraeumen, damit die Map in einem langlebigen Isolate nicht waechst.
    if (VV_NACHWEIS_IP_ZAEHLER.size > 500) {
      for (const [k, v] of VV_NACHWEIS_IP_ZAEHLER) {
        if (jetzt - v.start > 3600000) VV_NACHWEIS_IP_ZAEHLER.delete(k);
      }
    }
    return true;
  }
  eintrag.n++;
  return eintrag.n <= VV_NACHWEIS_MAX_PRO_STUNDE;
}

// Erlaubt sind genau die Formate, in denen eine Geburtsurkunde, ein Spielerpass
// oder ein Passbild tatsaechlich ankommt: abfotografiert oder gescannt. Der Typ
// kommt IMMER aus den ersten Bytes, nie aus body.contentType -- sonst landet
// eine umbenannte Datei unter einem erfundenen Typ in der Ablage und wird von
// handleVvNachweisGet spaeter genau so wieder ausgeliefert. Gleiche Linie wie
// erkenneMedientyp() bei den Neuigkeiten und die PDF-Pruefung in
// handleVvAntragPdfPut zwanzig Zeilen weiter unten.
//
// ⚠️ Bewusst NICHT erkenneMedientyp() wiederverwendet: die klassiert alles mit
// "ftyp" an Byte 4 als video/mp4 -- und genau diese Signatur hat auch ein
// iPhone-HEIC. Ein Passbild vom iPhone lieferte dort also "video/mp4" und ein
// echtes Video kaeme als Nachweis durch. Hier wird die Marke an Byte 8 gelesen.
const VV_NACHWEIS_HEIF_MARKEN = new Set([
  "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"
]);

// Genau die Rueckgabewerte von erkenneNachweisTyp -- der Filter beim Ausliefern
// haengt daran. Wer dort ein Format ergaenzt, ergaenzt es hier mit.
const VV_NACHWEIS_TYPEN = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"
]);

function erkenneNachweisTyp(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  // ISO-BMFF: Groessenfeld, dann "ftyp", dann die Marke -- nur die HEIF-Bilder
  // gelten, mp4/m4v fallen durch.
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const marke = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (VV_NACHWEIS_HEIF_MARKEN.has(marke)) return "image/heic";
  }
  return null;
}

// Wer die Nachweise sehen darf. Der Gateway kennt die Rollen der
// Vereinsverwaltung nicht -- die liegen in deren D1 -- und benutzt
// deshalb die naechstliegende Entsprechung: das Bearbeiten-Recht auf der
// Kachel. Administrieren schliesst es serverseitig ein.
async function vvNachweisDarfSehen(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return { fehler: json({ error: "Nicht angemeldet" }, 401, corsHeaders) };
  if (!(await resolveEditPermission("vereinsverwaltung", session, env, authHeader))) {
    return { fehler: json({ error: "Nicht berechtigt" }, 403, corsHeaders) };
  }
  return { session };
}

function vvNachweisPfad(owner, slot) {
  return VV_NACHWEIS_DIR + "/" + owner + "/" + slot;
}

async function handleVvNachweisPut(request, body, env, authHeader, corsHeaders) {
  // Zaehlwerk VOR jeder anderen Pruefung: es ist die einzige Schranke, die
  // ueberhaupt zaehlt, wie oft jemand hier anklopft.
  if (!vvNachweisIpBremse(request)) {
    return json({ error: "Zu viele Uploads. Bitte spaeter erneut versuchen." }, 429, corsHeaders);
  }

  const slot = String(body.slot || "");
  if (!VV_NACHWEIS_SLOTS.has(slot)) {
    return json({ error: "Unbekannte Art des Nachweises" }, 400, corsHeaders);
  }

  // Wie beim Fuehrerschein: Erst-Upload ohne owner, der Server vergibt ihn
  // und gibt ihn zurueck. Jeder weitere Nachweis desselben Antrags schickt
  // den erhaltenen Wert mit, damit alle Anlagen zusammen liegen.
  let owner = String(body.owner || "");
  if (owner && !VV_NACHWEIS_OWNER_RE.test(owner)) {
    return json({ error: "Ungueltiger Nachweis-Schluessel" }, 400, corsHeaders);
  }
  if (!owner) owner = crypto.randomUUID().replace(/-/g, "");

  let bytes;
  try {
    bytes = base64ToBytes(String(body.dataBase64 || ""));
  } catch (_) {
    return json({ error: "Datei-Inhalt ist kein gültiges base64" }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > MAX_FILE_BYTES) return json({ error: "Datei zu groß" }, 413, corsHeaders);

  // ⚠️ body.contentType wird NICHT mehr uebernommen -- der Typ kommt aus den
  // ersten Bytes. Was hier nicht erkannt wird, kommt nicht in die Ablage.
  const ctype = erkenneNachweisTyp(bytes);
  if (!ctype) {
    return json({ error: "Nur Fotos (JPEG, PNG, HEIC, WebP) oder PDF-Dateien" }, 400, corsHeaders);
  }

  const dir = VV_NACHWEIS_DIR + "/" + owner;
  const fileUrl = vvNachweisPfad(owner, slot);
  const headers = { Authorization: authHeader, "Content-Type": ctype };
  let resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  if (resp.status === 409 || resp.status === 404) {
    // Zwei Ebenen: der Sammelordner kann genauso fehlen wie der des
    // einzelnen Antrags. ensureCollection legt beide an.
    await ensureCollection(VV_NACHWEIS_DIR, authHeader, 0);
    await ensureCollection(dir, authHeader, 0);
    resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);
  return json({ ok: true, owner, slot }, 200, corsHeaders);
}

// Welche Anlagen liegen zu einem Antrag vor? Der Client zeigt danach seine
// Knoepfe -- ein Knopf, hinter dem nichts liegt, ist schlimmer als keiner.
// Kein PROPFIND: die Slot-Liste ist kurz und fest, ein HEAD je Slot ist
// billiger als das Auswerten einer Multistatus-Antwort ohne XML-Parser.
async function handleVvNachweisListe(request, body, env, authHeader, corsHeaders) {
  const gate = await vvNachweisDarfSehen(request, env, authHeader, corsHeaders);
  if (gate.fehler) return gate.fehler;

  const owner = String(body.owner || "");
  if (!VV_NACHWEIS_OWNER_RE.test(owner)) {
    return json({ error: "Ungueltiger Nachweis-Schluessel" }, 400, corsHeaders);
  }

  const vorhanden = [];
  for (const slot of VV_NACHWEIS_SLOTS) {
    const r = await fetch(vvNachweisPfad(owner, slot), {
      method: "HEAD", headers: { Authorization: authHeader }
    });
    if (r.ok) vorhanden.push({ slot, groesse: Number(r.headers.get("Content-Length") || 0) });
  }
  return json({ ok: true, owner, nachweise: vorhanden }, 200, corsHeaders);
}

async function handleVvNachweisGet(request, body, env, authHeader, corsHeaders) {
  const gate = await vvNachweisDarfSehen(request, env, authHeader, corsHeaders);
  if (gate.fehler) return gate.fehler;

  const owner = String(body.owner || "");
  const slot = String(body.slot || "");
  if (!VV_NACHWEIS_OWNER_RE.test(owner) || !VV_NACHWEIS_SLOTS.has(slot)) {
    return json({ error: "Unbekannter Nachweis" }, 400, corsHeaders);
  }

  const resp = await fetch(vvNachweisPfad(owner, slot), {
    headers: { Authorization: authHeader }
  });
  if (resp.status === 404) return json({ error: "Nachweis nicht gefunden" }, 404, corsHeaders);
  if (!resp.ok) return json({ error: `Nextcloud GET ${resp.status}` }, 502, corsHeaders);

  // Rohe Bytes, aber nicht blind mit dem Typ von Nextcloud: bis zur
  // Byte-Pruefung im PUT konnte dort ein vom Client behaupteter Typ liegen
  // (auch text/html). Der Altbestand faellt deshalb auf octet-stream, und die
  // beiden Kopfzeilen darunter halten auch den Fall ab, dass jemand die Datei
  // einmal direkt im Browser oeffnet statt ueber den Blob-Weg der Verwaltung.
  const gemeldet = String(resp.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const kopf = new Headers(corsHeaders);
  kopf.set("Content-Type", VV_NACHWEIS_TYPEN.has(gemeldet) ? gemeldet : "application/octet-stream");
  kopf.set("X-Content-Type-Options", "nosniff");
  kopf.set("Content-Disposition", "attachment");
  return new Response(resp.body, { status: 200, headers: kopf });
}

// Der Verband verlangt Aufbewahrung beim Verein fuer mindestens zwei
// Jahre -- geloescht wird hier deshalb nicht im Alltag, sondern auf
// ausdrueckliche Anforderung. Darum GLOBALER Admin und nicht bloss das
// Bearbeiten-Recht, das die ganze Geschaeftsstelle hat.
async function handleVvNachweisLoeschen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const owner = String(body.owner || "");
  if (!VV_NACHWEIS_OWNER_RE.test(owner)) {
    return json({ error: "Ungueltiger Nachweis-Schluessel" }, 400, corsHeaders);
  }
  const slot = String(body.slot || "");
  if (slot && !VV_NACHWEIS_SLOTS.has(slot)) {
    return json({ error: "Unbekannte Art des Nachweises" }, 400, corsHeaders);
  }

  // Ohne slot faellt der ganze Ordner des Antrags weg -- der Regelfall,
  // wenn jemand die Loeschung seiner Unterlagen verlangt.
  const ziel = slot ? vvNachweisPfad(owner, slot) : VV_NACHWEIS_DIR + "/" + owner;
  const resp = await fetch(ziel, { method: "DELETE", headers: { Authorization: authHeader } });
  if (!resp.ok && resp.status !== 404) {
    return json({ error: `Nextcloud DELETE ${resp.status}` }, 502, corsHeaders);
  }
  return json({ ok: true }, 200, corsHeaders);
}

// --- Das erzeugte Verbandsformular ------------------------------------
//
// Anders als beim Nachweis-Upload ist hier IMMER eine Sitzung noetig: das
// Blatt entsteht in der Verwaltung, nicht am Familien-Formular. Gleiches
// Recht wie beim Lesen der Nachweise.

async function handleVvAntragPdfPut(request, body, env, authHeader, corsHeaders) {
  const gate = await vvNachweisDarfSehen(request, env, authHeader, corsHeaders);
  if (gate.fehler) return gate.fehler;

  const id = String(body.antrag_id || "");
  if (!VV_ANTRAG_ID_RE.test(id)) {
    return json({ error: "Ungueltige Antrags-Id" }, 400, corsHeaders);
  }

  let bytes;
  try {
    bytes = base64ToBytes(String(body.dataBase64 || ""));
  } catch (_) {
    return json({ error: "Datei-Inhalt ist kein gültiges base64" }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > MAX_FILE_BYTES) return json({ error: "Datei zu groß" }, 413, corsHeaders);

  // ⚠️ Nur PDF, an den ersten Bytes geprueft -- nicht an der Angabe des
  // Clients. Dasselbe Prinzip wie beim Unterschriften-Upload: was hier
  // liegt, ist der Nachweis gegenueber dem Verband.
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    return json({ error: "Nur PDF-Dateien" }, 400, corsHeaders);
  }

  // Ein Antrag, eine Datei: ein zweiter Klick ueberschreibt sie. Die
  // Alternative -- jedes Erzeugen als eigene Fassung -- legte nach ein
  // paar Korrekturen mehrere Blaetter nebeneinander, von denen niemand
  // mehr weiss, welches eingereicht wurde.
  const fileUrl = VV_ANTRAG_DIR + "/" + id + ".pdf";
  const headers = { Authorization: authHeader, "Content-Type": "application/pdf" };
  let resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  if (resp.status === 409 || resp.status === 404) {
    await ensureCollection(VV_ANTRAG_DIR, authHeader, 0);
    resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);
  return json({ ok: true, groesse: bytes.length }, 200, corsHeaders);
}

async function handleVvAntragPdfGet(request, body, env, authHeader, corsHeaders) {
  const gate = await vvNachweisDarfSehen(request, env, authHeader, corsHeaders);
  if (gate.fehler) return gate.fehler;

  const id = String(body.antrag_id || "");
  if (!VV_ANTRAG_ID_RE.test(id)) {
    return json({ error: "Ungueltige Antrags-Id" }, 400, corsHeaders);
  }

  const resp = await fetch(VV_ANTRAG_DIR + "/" + id + ".pdf",
                           { headers: { Authorization: authHeader } });
  if (resp.status === 404) return json({ error: "Kein abgelegtes Formular" }, 404, corsHeaders);
  if (!resp.ok) return json({ error: `Nextcloud GET ${resp.status}` }, 502, corsHeaders);

  const kopf = new Headers(corsHeaders);
  kopf.set("Content-Type", "application/pdf");
  return new Response(resp.body, { status: 200, headers: kopf });
}

// Liegt zu diesem Antrag schon ein Blatt? Beantwortet die Frage, ohne die
// Datei zu holen -- die Antragsansicht will nur wissen, ob sie den Knopf
// "erneut erzeugen" oder "erzeugen" beschriften soll.
async function handleVvAntragPdfStatus(request, body, env, authHeader, corsHeaders) {
  const gate = await vvNachweisDarfSehen(request, env, authHeader, corsHeaders);
  if (gate.fehler) return gate.fehler;

  const id = String(body.antrag_id || "");
  if (!VV_ANTRAG_ID_RE.test(id)) {
    return json({ error: "Ungueltige Antrags-Id" }, 400, corsHeaders);
  }

  const r = await fetch(VV_ANTRAG_DIR + "/" + id + ".pdf",
                        { method: "HEAD", headers: { Authorization: authHeader } });
  return json({
    ok: true,
    vorhanden: r.ok,
    groesse: r.ok ? Number(r.headers.get("Content-Length") || 0) : 0,
    erzeugt_am: r.ok ? (r.headers.get("Last-Modified") || null) : null
  }, 200, corsHeaders);
}

// Listet per WebDAV PROPFIND (Depth:1) den Belegeingang-Ordner und liest nur die
// *.meta.json, deren Dateiname auf "_fahrt-<fahrtId>.meta.json" endet -- diesen
// Suffix hängt sc-heiligenstadt-budget/worker.js nur bei einer gültigen UUID an
// (siehe dort). Kein XML-Parser in Workers verfügbar und dieses Projekt bewusst
// dependency-frei -> schlanker Href-Extractor statt echtem XML-Parsing, zugeschnitten
// auf Nextclouds bekannte Depth:1-Multistatus-Antwort (nur die href-Werte zählen,
// die eigentlich angefragten Props sind irrelevant).
async function handleFahrtenbuchBelegeList(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const app = String(body.app || "");
  if (app !== "fahrtenbuch") return json({ error: "Unbekannte App" }, 400, corsHeaders);
  if (!(await userMayAccessTool(app, session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }

  // Bewusst KEIN zusätzlicher Ownership-Check der konkreten Fahrt: fahrtId ist eine
  // nicht erratbare UUID, und ein Normalnutzer bekommt eine fremde fahrtId über die
  // App seit dem Sichtbarkeits-Fix (OWNER_FILTERED_APPS) ohnehin nicht mehr zu Gesicht.
  const fahrtId = String(body.fahrtId || "");
  if (!FILE_ID_RE.test(fahrtId)) return json({ error: "Ungültige Fahrt-Id" }, 400, corsHeaders);

  let resp;
  try {
    resp = await fetch(BELEGE_EINGANG_DIR, {
      method: "PROPFIND",
      headers: { Authorization: authHeader, Depth: "1", "Content-Type": "application/xml" },
      body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`
    });
  } catch (e) {
    throw new NextcloudError("Nextcloud nicht erreichbar: " + e.message);
  }
  if (resp.status === 404) return json({ belege: [] }, 200, corsHeaders); // Ordner existiert noch nicht
  if (resp.status !== 207) throw new NextcloudError(`Nextcloud PROPFIND ${resp.status}`);

  const xml = await resp.text();
  const suffix = `_fahrt-${fahrtId}.meta.json`;
  const hrefs = Array.from(xml.matchAll(/<[a-zA-Z0-9]*:?href>([^<]+)<\/[a-zA-Z0-9]*:?href>/gi))
    .map((m) => decodeURIComponent(m[1]));
  const matches = hrefs.filter((href) => href.endsWith(suffix));

  const belege = [];
  for (const href of matches) {
    const fileUrl = new URL(href, BELEGE_EINGANG_DIR).href;
    const fileResp = await fetch(fileUrl, { headers: { Authorization: authHeader } });
    if (!fileResp.ok) continue; // einzelner Lesefehler soll nicht die ganze Liste kippen
    let meta;
    try { meta = await fileResp.json(); } catch (_) { continue; }
    if (!meta || typeof meta !== "object") continue;
    const files = Array.isArray(meta.files)
      ? meta.files
          .map((f) => ({ fileName: capStr(f && f.fileName, 300), fileMime: capStr(f && f.fileMime, 100) }))
          .filter((f) => f.fileName)
      : [];
    belege.push({
      submittedAt: typeof meta.submittedAt === "string" ? meta.submittedAt : null,
      amount: typeof meta.amount === "number" ? meta.amount : null,
      desc: capStr(meta.desc, 200),
      name: capStr(meta.name, 200),
      files
    });
  }
  belege.sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
  return json({ belege }, 200, corsHeaders);
}

// Liest eine einzelne Beleg-Datei aus BELEGE_EINGANG_DIR für den "Beleg anzeigen"-Knopf im
// Fahrtenbuch-Modal -- fileName kommt vom Client (aus der fahrtenbuch-belege-list-Antwort),
// wird hier aber serverseitig gegen den Suffix "_fahrt-<fahrtId>[_<n>].<ext>" geprüft statt
// blind vertraut, sonst könnte ein Nutzer über einen erratenen/kopierten Dateinamen fremde
// Kassierer-Belege im selben geteilten Ordner lesen. Gleiches Streaming-Muster wie
// handleDavFileGet/handleDavRestrictedGet.
async function handleFahrtenbuchBelegFileGet(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const app = String(body.app || "");
  if (app !== "fahrtenbuch") return json({ error: "Unbekannte App" }, 400, corsHeaders);
  if (!(await userMayAccessTool(app, session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }
  const fahrtId = String(body.fahrtId || "");
  if (!FILE_ID_RE.test(fahrtId)) return json({ error: "Ungültige Fahrt-Id" }, 400, corsHeaders);
  const fileName = String(body.fileName || "");
  const validSuffix = new RegExp(`_fahrt-${fahrtId}(?:_\\d+)?\\.[a-zA-Z0-9]+$`, "i");
  if (!validSuffix.test(fileName) || fileName.includes("/") || fileName.includes("..")) {
    return json({ error: "Ungültiger Dateiname" }, 400, corsHeaders);
  }

  const fileUrl = BELEGE_EINGANG_DIR + "/" + encodeURIComponent(fileName);
  let resp;
  try {
    resp = await fetch(fileUrl, { method: "GET", headers: { Authorization: authHeader } });
  } catch (_) {
    return json({ error: "Nextcloud nicht erreichbar" }, 502, corsHeaders);
  }
  if (resp.status === 404) return json({ error: "Datei nicht gefunden" }, 404, corsHeaders);
  if (!resp.ok) return json({ error: `Nextcloud GET ${resp.status}` }, 502, corsHeaders);
  const ctype = resp.headers.get("Content-Type") || "application/octet-stream";
  return new Response(resp.body, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": ctype, "Cache-Control": "private, no-store" }
  });
}

// ---------- Nextcloud-JSON-Helfer ----------

function emptyUsersDoc() {
  return { version: 1, users: {}, groups: {} };
}

// NextcloudError -> 502 an den Client (zentral im fetch-Handler abgefangen),
// ConflictError -> 409 (nur dav-save mit rev/If-Match).
class NextcloudError extends Error {}
class ConflictError extends Error {}

// Liest eine JSON-Datei. NUR "Datei existiert nicht" (404) oder eine leere Datei
// ergeben den Fallback. Jeder andere Fehler (Netz, 5xx, kaputtes JSON) wirft —
// ein transienter Lesefehler darf nicht wie eine leere/neue Datei aussehen.
async function readJson(url, authHeader, fallback) {
  return (await readJsonWithRev(url, authHeader, fallback)).data;
}

// Startet einen Read, ohne auf ihn zu warten — für Reads, die nicht voneinander
// abhängen und deshalb nicht nacheinander laufen müssen (gemessen: ein
// Nextcloud-Read kostet 200-450 ms, ein Request ohne Read 70 ms).
// Das angehängte .catch() ist ein reiner Platzhalter, damit ein Fehlschlag keine
// unhandled rejection wirft, falls der Aufrufer die Promise am Ende gar nicht
// braucht (z.B. Admin-Kurzschluss in userMayAccessTool). Wer sie awaitet,
// bekommt den Fehler ganz normal aus der Original-Promise.
function prefetchJson(url, authHeader, fallback) {
  const p = readJson(url, authHeader, fallback);
  p.catch(() => {});
  return p;
}

// Gleiche Bauform, liefert aber zusaetzlich das ETag — gebraucht von handleDavLoad,
// dessen Antwort das rev fuer den If-Match-PUT enthaelt (readJson wirft es weg).
function prefetchJsonWithRev(url, authHeader, fallback) {
  const p = readJsonWithRev(url, authHeader, fallback);
  p.catch(() => {});
  return p;
}

// Kurzlebiger In-Memory-Cache für readJsonWithRev, ueberlebt auf einem warmen
// Worker-Isolate mehrere Requests. Grund: nutzer.json und sichtbarkeit.json
// werden bei JEDER einzelnen Aktion neu von Nextcloud gelesen (Session-Pruefung
// + Sichtbarkeits-Check), obwohl z.B. das Laden des Dashboards mehrere Aktionen
// (me, dav-load, list-users, list-groups) binnen Millisekunden ausloest — ohne
// Cache also bis zu 6-8 serielle Nextcloud-Roundtrips fuer eine einzige
// Seitenansicht. TTL kurz halten (statt unbegrenzt), damit eine Aenderung durch
// ein ANDERES Isolate nicht zu lang unbemerkt bleibt; writeJson invalidiert den
// eigenen Eintrag sofort, das deckt den Normalfall (Schreiben+Lesen im selben
// Request-Burst) verzoegerungsfrei ab.
const jsonCache = new Map(); // url -> { data, rev, expires }
const CACHE_TTL_MS = 5000;

// Nextcloud liefert ETags als "weak" (Praefix W/). HTTP verlangt fuer If-Match
// zwingend einen "strong comparison" und lehnt JEDEN weak-getaggten Wert schon
// dem Namen nach ab (RFC 7232 3.1) — ohne dieses Strippen bekommt jede
// If-Match-PUT ein 412, IMMER, unabhaengig davon ob die Datei sich wirklich
// geaendert hat (per Live-Test bestaetigt: identischer rev vor/nach Neuladen,
// trotzdem 412). Praefix vor jeder Weiterverwendung als If-Match entfernen.
function normalizeETag(etag) {
  return etag && etag.startsWith("W/") ? etag.slice(2) : etag;
}

async function readJsonWithRev(url, authHeader, fallback) {
  const cached = jsonCache.get(url);
  if (cached && cached.expires > Date.now()) return { data: cached.data, rev: cached.rev };

  let resp;
  try {
    resp = await fetch(url, { method: "GET", headers: { Authorization: authHeader } });
  } catch (e) {
    throw new NextcloudError("Nextcloud nicht erreichbar: " + e.message);
  }
  // 404/leer wird bewusst NICHT gecacht: seltener Pfad (i.d.R. nur vor der
  // allerersten Speicherung einer Datei), Cachen wuerde riskieren, eine
  // zwischenzeitliche Erst-Anlage durch ein anderes Isolate zu verdecken.
  if (resp.status === 404) return { data: fallback, rev: null };
  if (!resp.ok) throw new NextcloudError(`Nextcloud GET ${resp.status}`);
  const rev = normalizeETag(resp.headers.get("ETag"));
  const text = await resp.text();
  if (!text.trim()) return { data: fallback, rev };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new NextcloudError("Nextcloud-Datei enthält kein gültiges JSON — Zugriff abgebrochen, Datei bitte prüfen");
  }
  if (parsed && typeof parsed === "object") {
    jsonCache.set(url, { data: parsed, rev, expires: Date.now() + CACHE_TTL_MS });
    return { data: parsed, rev };
  }
  throw new NextcloudError("Nextcloud-Datei hat ein unerwartetes Format — Zugriff abgebrochen");
}

// Schreibt eine JSON-Datei; mit ifMatch nur, wenn die Datei serverseitig noch dem
// bekannten Stand entspricht (412 -> ConflictError). Gibt das neue ETag zurück.
async function writeJson(url, authHeader, data, ifMatch) {
  // Cache SOFORT verwerfen, nicht erst nach erfolgreichem PUT: fast alle
  // read-modify-write-Handler (submit-feedback, fahrtenbuch-extern-submit und
  // jeder nutzer.json-Handler ueber session.usersDoc) mutieren GENAU das Objekt,
  // das readJsonWithRev im Cache abgelegt hat. Schlug der PUT fehl und blieb der
  // Eintrag stehen, lieferte der Cache bis zu 5 Sekunden lang einen Stand, den
  // der Server nie bekommen hat -- und der naechste erfolgreiche Schreibvorgang
  // eines FREMDEN Handlers schrieb diese nie gespeicherte Aenderung dann
  // dauerhaft mit fest. Ein als fehlgeschlagen gemeldeter Vorgang (z.B.
  // archive-trainer 502) wurde so still doch wirksam. Ab dem Moment, in dem wir
  // einen Schreibversuch starten, ist die Kopie im Speicher ohnehin nicht mehr
  // vertrauenswuerdig -- egal ob der Versuch gelingt oder nicht.
  jsonCache.delete(url);
  const headers = { Authorization: authHeader, "Content-Type": "application/json" };
  if (ifMatch) headers["If-Match"] = ifMatch;
  const body = JSON.stringify(data, null, 2);
  let resp = await fetch(url, { method: "PUT", headers, body });
  // 409 ODER 404 beim PUT heißt in WebDAV: ein Elternordner existiert noch nicht
  // (passiert bei der allerersten Speicherung einer neu angebundenen App). 409 bei
  // nur einer fehlenden Ebene, 404 wenn zwei oder mehr Ebenen zugleich fehlen.
  // Ordner anlegen und EINMAL wiederholen. Mit ifMatch kann das hier nicht aus
  // einem fehlenden Ordner stammen (die Datei — und damit ihr Ordner — existierte
  // ja schon), daher nur im unbedingten Fall automatisch anlegen.
  if ((resp.status === 409 || resp.status === 404) && !ifMatch) {
    await ensureParentCollection(url, authHeader);
    resp = await fetch(url, { method: "PUT", headers, body });
  }
  if (resp.status === 412) throw new ConflictError("Datei wurde zwischenzeitlich geändert");
  if (!resp.ok) throw new Error(`Nextcloud PUT ${resp.status}`);
  return normalizeETag(resp.headers.get("OC-ETag") || resp.headers.get("ETag") || null);
}

// Legt den Elternordner der Datei-URL an — rekursiv, falls mehrere Ebenen fehlen.
// WebDAV MKCOL: 201 = angelegt, 405 = existiert bereits (Basisfall der Rekursion,
// bricht das Hochlaufen ab, sobald ein vorhandener Ordner erreicht ist),
// 409 = der eigene Elternordner fehlt ebenfalls -> erst den anlegen, dann erneut.
async function ensureParentCollection(fileUrl, authHeader) {
  await ensureCollection(fileUrl.slice(0, fileUrl.lastIndexOf("/")), authHeader, 0);
}

async function ensureCollection(collUrl, authHeader, depth) {
  if (depth > 15) throw new NextcloudError("Ordnerpfad zu tief zum automatischen Anlegen");
  let resp = await fetch(collUrl, { method: "MKCOL", headers: { Authorization: authHeader } });
  if (resp.status === 201 || resp.status === 405) return; // neu angelegt bzw. schon vorhanden
  if (resp.status === 409) {
    await ensureCollection(collUrl.slice(0, collUrl.lastIndexOf("/")), authHeader, depth + 1);
    resp = await fetch(collUrl, { method: "MKCOL", headers: { Authorization: authHeader } });
    if (resp.status === 201 || resp.status === 405) return;
  }
  throw new NextcloudError(`Ordner anlegen fehlgeschlagen (MKCOL ${resp.status})`);
}

// ---------- Gruppen-Helfer ----------

function addUserToGroups(usersDoc, username, groupIds) {
  if (!Array.isArray(groupIds)) return;
  groupIds.forEach((gid) => {
    const group = getOwn(usersDoc.groups, String(gid));
    if (group && !group.memberUsernames.includes(username)) group.memberUsernames.push(username);
  });
}

function getUserGroupIds(usersDoc, username) {
  const groups = usersDoc.groups || {};
  return Object.values(groups)
    .filter((g) => Array.isArray(g.memberUsernames) && g.memberUsernames.includes(username))
    .map((g) => g.id);
}

// Leitet aus einem rohen Nutzerdatensatz die EFFEKTIVE Identität ab (siehe
// set-view-as oben): ein Admin mit gültigem viewAsGroupId gilt für jede
// Zugriffsprüfung als normales, nicht-admin Mitglied genau dieser einen
// Gruppe. "Gültig" heißt: die Gruppe existiert noch (sonst z.B. nach einem
// delete-group ein toter Verweis, der den Admin dauerhaft aussperren würde).
// realIsAdmin bleibt immer der echte Wert aus nutzer.json.
function deriveIdentity(user, usersDoc) {
  const realIsAdmin = !!user.isAdmin;
  const viewAsGroupId = (realIsAdmin && user.viewAsGroupId && getOwn(usersDoc.groups || {}, user.viewAsGroupId))
    ? user.viewAsGroupId
    : null;
  const isAdmin = realIsAdmin && !viewAsGroupId;
  const groupIds = viewAsGroupId ? [viewAsGroupId] : (isAdmin ? [] : getUserGroupIds(usersDoc, user.username));
  return { isAdmin, realIsAdmin, viewAsGroupId, groupIds };
}

// ---------- Auto-Provisioning: gruppengesteuertes Anlegen von Tool-Einträgen ----------
//
// Legt beim Anlegen eines Nutzers (bzw. per provision-group nachträglich) einen
// verknüpften Eintrag in den fachlich passenden Tools an — z.B. ein "Trainer" wird
// automatisch zur Zeile in der Personalkosten-Kostenliste. Welche App für welche
// Gruppe, steht als provisionGroupIds je Tool in sichtbarkeit.json (parallel zu
// groupIds/editGroupIds). Rein ADDITIV und IDEMPOTENT: jeder Eintrag trägt
// linkedUsername; ein zweiter Lauf legt kein Duplikat an, es wird nie etwas
// gelöscht/überschrieben.

// Nur diese Apps haben einen Adapter (die restlichen Tools bekommen keine Checkbox).
const PROVISION_ADAPTERS = {
  "personalkosten": provisionPersonalkosten,
  "trainercheckliste": provisionTrainercheckliste,
  "kadermanager": provisionKadermanager,
  "trainerdaten": provisionTrainerdaten
};

function provisionPathFor(app) {
  return getOwn(DAV_APPS, app) || getOwn(PROVISION_ONLY_PATHS, app) || null;
}

// Leerstruktur je App, falls die Datei noch nicht existiert (Fallback beim Lesen).
function provisionDefault(app) {
  switch (app) {
    case "personalkosten":    return { meta: {}, seasons: {}, parameter: {} };
    case "trainercheckliste": return { trainerEintraege: [] };
    case "kadermanager":      return { meta: {}, teams: [] };
    case "trainerdaten":      return { trainer: [] };
    default:                  return {};
  }
}

// Welche Provisioning-Adapter für einen Spieler überhaupt laufen dürfen.
// trainerdaten/personalkosten/trainercheckliste sind Personal-Sachen: ein
// Spieler bekommt dort niemals einen Stub, auch wenn seine Gruppe versehentlich
// in provisionGroupIds dieser Tools steht. Sicherheitsnetz gegen einen
// Konfigurationsfehler, der sonst 200 Trainerdaten-Leichen anlegt -- die dann
// über den Namensfallback (findTrainerdatenRecord) auch noch mit echten
// Trainern gleichen Namens verwechselt werden könnten.
const PROVISION_APPS_SPIELER = new Set(["kadermanager"]);

function provisionErlaubtFuerArt(app, art) {
  return art === USER_ART_SPIELER ? PROVISION_APPS_SPIELER.has(app) : true;
}

function provisionProfile(user) {
  return {
    username: user.username,
    vorname: String(user.vorname || "").trim(),
    nachname: String(user.nachname || "").trim(),
    lizenz: user.lizenz || "",
    mannschaften: Array.isArray(user.mannschaften) ? user.mannschaften : []
  };
}

function sameText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

// Menschliche Dateneingabe vertauscht Vorname/Nachname gelegentlich (Bugreport
// 2026-07-08: TrainerCheckliste-Testeintrag Vorname="user"/Name="test" fuer ein
// Konto mit Vorname="Test"/Nachname="User"). Ohne linkedUsername beide
// Reihenfolgen zulassen, statt den Namensabgleich lautlos scheitern zu lassen.
function sameNamePair(aFirst, aLast, bFirst, bLast) {
  return (sameText(aFirst, bFirst) && sameText(aLast, bLast)) ||
         (sameText(aFirst, bLast) && sameText(aLast, bFirst));
}

// --- Adapter: mutieren die App-Daten in place, geben das Ergebnis je Nutzer zurück
// ("created" | "exists" | "no-team" | "no-season"). "created" => Datei muss geschrieben werden.

function provisionPersonalkosten(data, p) {
  if (!data.meta || typeof data.meta !== "object") data.meta = {};
  if (!data.seasons || typeof data.seasons !== "object") data.seasons = {};
  let seasonKey = data.meta.currentSeason;
  if (!seasonKey || !data.seasons[seasonKey]) seasonKey = Object.keys(data.seasons)[0];
  if (!seasonKey) return "no-season"; // ohne Saison nicht raten
  const season = data.seasons[seasonKey];
  if (!Array.isArray(season.trainer)) season.trainer = [];
  const fullName = `${p.vorname} ${p.nachname}`.trim();
  const fullNameReversed = `${p.nachname} ${p.vorname}`.trim();
  const exists = season.trainer.some((t) =>
    (t.linkedUsername && sameText(t.linkedUsername, p.username)) ||
    sameText(t.name, fullName) || sameText(t.name, fullNameReversed));
  if (exists) return "exists";
  season.trainer.push({
    id: crypto.randomUUID(),
    name: fullName,
    mannschaft: p.mannschaften[0] || "",
    position: "",
    jahrgangsleiter: "",
    lizenz: p.lizenz || "",
    landesebene: "",
    stelle: "",
    manuellAE: "",
    besonderheit: "",
    linkedUsername: p.username
  });
  return "created";
}

function provisionTrainercheckliste(data, p) {
  if (!Array.isArray(data.trainerEintraege)) data.trainerEintraege = [];
  const exists = data.trainerEintraege.some((e) =>
    (e.linkedUsername && sameText(e.linkedUsername, p.username)) ||
    sameNamePair(e.vorname, e.name, p.vorname, p.nachname));
  if (exists) return "exists";
  // Minimal-Stub: die Client-migrateData ergänzt zugang/abgang beim Laden selbst.
  data.trainerEintraege.push({
    id: crypto.randomUUID(),
    name: p.nachname, // in dieser App ist "name" der Nachname
    vorname: p.vorname,
    geburtsdatum: "",
    anschrift: "",
    telefon: "",
    email: "",
    linkedUsername: p.username
  });
  return "created";
}

function provisionKadermanager(data, p) {
  if (!Array.isArray(data.teams)) return "no-team";
  // Erstes Team, dessen Name zu einer betreuten Mannschaft des Nutzers passt.
  const team = data.teams.find((t) => p.mannschaften.some((m) => sameText(t.name, m)));
  if (!team) return "no-team";
  if (!Array.isArray(team.kader)) team.kader = [];
  const exists = team.kader.some((s) => s.linkedUsername && sameText(s.linkedUsername, p.username));
  if (exists) return "exists";
  team.kader.push({
    id: crypto.randomUUID(),
    name: `${p.vorname} ${p.nachname}`.trim(),
    position: "",
    nummer: "",
    linkedUsername: p.username,
    rollen: ["trainer"],
    fotoId: ""
  });
  return "created";
}

function provisionTrainerdaten(data, p) {
  if (!Array.isArray(data.trainer)) data.trainer = [];
  // Stub wie _createStubTrainer der App (ohne username -> Admin-Liste zeigt
  // "Unvollständig"; ein späteres Self-Submit merged per exaktem Namensabgleich).
  const exists = data.trainer.some((t) =>
    (t.linkedUsername && sameText(t.linkedUsername, p.username)) ||
    sameNamePair(t.vorname, t.nachname, p.vorname, p.nachname));
  if (exists) return "exists";
  data.trainer.push({
    id: crypto.randomUUID(),
    vorname: p.vorname,
    nachname: p.nachname,
    lizenz: p.lizenz || "",
    pauschale: "",
    erstelltAm: new Date().toISOString(),
    vertragsGeneriert: false,
    linkedUsername: p.username
  });
  return "created";
}

// Ermittelt die Ziel-Apps für eine Menge Gruppen-Ids aus der Sichtbarkeits-Config
// (tools[].provisionGroupIds), gefiltert auf Apps, die überhaupt einen Adapter haben.
function provisionAppsForGroups(config, groupIds) {
  const tools = (config && config.tools) || {};
  const apps = [];
  for (const [appId, entry] of Object.entries(tools)) {
    if (!getOwn(PROVISION_ADAPTERS, appId)) continue;
    const pg = Array.isArray(entry.provisionGroupIds) ? entry.provisionGroupIds : [];
    if (pg.some((g) => groupIds.includes(g))) apps.push(appId);
  }
  return apps;
}

// Schreibt EINE App-Datei für ALLE Mitglieder auf einmal (1 Read + 1 Write statt pro
// Mitglied — schont die Cloudflare-Subrequest-Grenze). Bei Konflikt einmal frisch
// neu laden und erneut anwenden (Adapter sind idempotent). Gibt je Nutzer das
// Ergebnis zurück.
async function provisionAppBatch(app, adapter, url, members, env, authHeader) {
  let outcomes = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) jsonCache.delete(url); // frischen Stand erzwingen
    const { data, rev } = await readJsonWithRev(url, authHeader, provisionDefault(app));
    const doc = (data && typeof data === "object") ? data : provisionDefault(app);
    outcomes = {};
    let anyCreated = false;
    for (const u of members) {
      const o = adapter(doc, provisionProfile(u));
      outcomes[u.username] = o;
      if (o === "created") anyCreated = true;
    }
    if (!anyCreated) return outcomes; // nichts zu schreiben
    try {
      await writeJson(url, authHeader, doc, rev || undefined);
      return outcomes;
    } catch (e) {
      if (e instanceof ConflictError && attempt === 0) continue;
      Object.keys(outcomes).forEach((k) => { if (outcomes[k] === "created") outcomes[k] = "error"; });
      return outcomes;
    }
  }
  return outcomes;
}

// Provisioniert eine Mitgliederliste in eine Liste von Apps. Report: { [app]: { [username]: ergebnis } }.
async function provisionUsers(members, apps, env, authHeader) {
  const report = {};
  for (const app of apps) {
    const adapter = getOwn(PROVISION_ADAPTERS, app);
    const url = provisionPathFor(app);
    if (!adapter || !url) continue;
    try {
      report[app] = await provisionAppBatch(app, adapter, url, members, env, authHeader);
    } catch (e) {
      const o = {};
      members.forEach((u) => { o[u.username] = "error"; });
      report[app] = o;
    }
  }
  return report;
}

// ---------- Nutzer-Art (Personal vs. Spieler) ----------
// Trennt Vereinspersonal (Trainer, Betreuer, Geschäftsstelle, Vorstand) von
// Spielern/Eltern. Grund: nutzer.json kannte bisher nur "Nutzer", weil jeder
// Login Personal WAR. Sobald Spielerkonten dazukommen, würden sie sonst
// automatisch in der Personalakte (ein Datensatz je Konto), in jedem
// Teilen-Picker (list-directory) und im Namensfallback der Trainerdaten-
// Zuordnung landen — überall dort, wo "Nutzer" implizit "Personal" meinte.
//
// Der Default steht bewusst im LESEPFAD, nicht als Migration in der Datei:
// jedes Konto ohne art-Feld ist "personal". Damit bleiben alle bestehenden
// Konten unverändert gültig und nutzer.json muss nicht angefasst werden --
// ein Konto wird erst dann zum Spieler, wenn es explizit so angelegt wird.
// WICHTIG: Neue Auswertungen, die "alle Nutzer" durchgehen, müssen sich
// entscheiden -- Vorgabe ist istPersonal(), Spieler sind die Ausnahme.
const USER_ART_SPIELER = "spieler";
const USER_ART_PERSONAL = "personal";

function userArt(user) {
  return (user && user.art === USER_ART_SPIELER) ? USER_ART_SPIELER : USER_ART_PERSONAL;
}

function istPersonal(user) {
  return userArt(user) === USER_ART_PERSONAL;
}

// Nimmt nur die beiden bekannten Werte an; alles andere (fehlt/Tippfehler/null)
// fällt auf "personal" zurück -- nie versehentlich zum Spieler degradieren.
function normalizeArt(raw) {
  return String(raw || "").trim() === USER_ART_SPIELER ? USER_ART_SPIELER : USER_ART_PERSONAL;
}

// ---------- Trainerprofil-Helfer (Lizenz + Mannschaften) ----------

function normalizeLizenz(raw) {
  const v = String(raw || "").trim();
  return LIZENZ_OPTIONEN.includes(v) ? v : "";
}

function normalizeMannschaften(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  raw.forEach((m) => {
    const t = String(m || "").trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  });
  return out;
}

function transliterate(str) {
  return String(str)
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue");
}

function slugifyNamePart(str) {
  return transliterate(String(str || ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function baseUsernameFor(vorname, nachname) {
  const vornamePart = slugifyNamePart(vorname);
  const nachnamePart = slugifyNamePart(nachname);
  let base = [vornamePart, nachnamePart].filter(Boolean).join(".");
  if (base.length < 3) base = (base + "nutzer").slice(0, 32);
  return base.slice(0, 32);
}

function generateUsername(vorname, nachname, existingUsernames) {
  const base = baseUsernameFor(vorname, nachname);
  let candidate = base;
  let suffix = 1;
  while (existingUsernames.has(candidate) || !USERNAME_RE.test(candidate)) {
    suffix++;
    const suffixStr = String(suffix);
    candidate = base.slice(0, 32 - suffixStr.length) + suffixStr;
  }
  return candidate;
}

function slugifyGroupName(name) {
  const slug = transliterate(String(name || ""))
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "gruppe";
}

function uniqueGroupId(baseId, existingIds) {
  let candidate = baseId;
  let suffix = 1;
  while (existingIds.has(candidate)) {
    suffix++;
    candidate = `${baseId}-${suffix}`;
  }
  return candidate;
}

// ---------- Passwort-Regeln ----------

// Identisch im Frontend (app.js) dupliziert, da der Worker separat deployed wird.
// min. 12 Zeichen, Groß- und Kleinbuchstabe, dazu eine Zahl ODER ein Sonderzeichen.
function validatePasswordStrength(password) {
  const pw = String(password == null ? "" : password);
  if (pw.length < 12) return "Passwort muss mindestens 12 Zeichen lang sein.";
  if (!/[A-ZÄÖÜ]/.test(pw)) return "Passwort braucht mindestens einen Großbuchstaben.";
  if (!/[a-zäöüß]/.test(pw)) return "Passwort braucht mindestens einen Kleinbuchstaben.";
  if (!/[0-9]/.test(pw) && !/[^A-Za-z0-9ÄÖÜäöüß]/.test(pw)) return "Passwort braucht mindestens eine Zahl oder ein Sonderzeichen.";
  return null;
}

// ---------- Passwort-Hashing (PBKDF2, Web Crypto, keine Abhängigkeiten) ----------

async function deriveHashBits(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    keyMaterial,
    HASH_BITS
  );
  return new Uint8Array(bits);
}

async function hashNewPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hashBytes = await deriveHashBits(password, salt, PBKDF2_ITERATIONS);
  return { hash: bytesToBase64(hashBytes), salt: bytesToBase64(salt), iterations: PBKDF2_ITERATIONS };
}

async function verifyPassword(password, saltB64, iterations, expectedHashB64) {
  const salt = base64ToBytes(saltB64);
  const hashBytes = await deriveHashBits(password, salt, iterations);
  return timingSafeEqual(bytesToBase64(hashBytes), expectedHashB64);
}

function timingSafeEqual(aB64, bB64) {
  const a = base64ToBytes(aB64);
  const b = base64ToBytes(bB64);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- Session-Token (HMAC-signiert, zustandslos) ----------

function makeSessionPayload(username, isAdmin) {
  const iat = Math.floor(Date.now() / 1000);
  return { username, isAdmin: !!isAdmin, iat, exp: iat + SESSION_TTL_SECONDS };
}

async function signToken(payload, secret) {
  const enc = new TextEncoder();
  const payloadB64 = bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return payloadB64 + "." + bytesToBase64Url(new Uint8Array(sig));
}

async function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  let valid;
  try {
    valid = await crypto.subtle.verify("HMAC", key, base64UrlToBytes(sigB64), enc.encode(payloadB64));
  } catch (_) {
    return null;
  }
  if (!valid) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
  } catch (_) {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// Baut ein echtes, standardkonformes LiveKit-JWT (3 Teile: header.payload.sig)
// von Hand über Web-Crypto -- bewusst NICHT das signToken()-Format oben
// (das ist ein bewusst simplifiziertes 2-Teile-Eigenformat nur für die
// eigenen Session-Tokens dieses Workers). LiveKit Cloud selbst verifiziert
// dieses Token und erwartet echtes JWT mit "video"-Grant-Claim, deshalb der
// eigene, vollständige Header+Payload-Aufbau hier.
async function buildLivekitToken({ apiKey, apiSecret, identity, name, video, ttlSeconds }) {
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    video, // Grant-Objekt: Teilnehmer {room, roomJoin, canPublish, ...} ODER Moderation {roomAdmin, room}
    iss: apiKey,
    sub: identity,
    iat: now,
    nbf: now,
    exp: now + ttlSeconds
  };
  if (name) payload.name = name;
  const signingInput = bytesToBase64Url(enc.encode(JSON.stringify(header))) + "." + bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return signingInput + "." + bytesToBase64Url(new Uint8Array(sig));
}

// Ruft die LiveKit-Server-API (Twirp/RoomService) mit einem kurzlebigen
// roomAdmin-Token auf — für die Moderations-Aktionen kicken/stummschalten.
// LIVEKIT_URL ist die wss://-Client-Adresse; die HTTP-API sitzt auf demselben
// Host über https://.
async function livekitRoomService(env, method, payload) {
  const adminToken = await buildLivekitToken({
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
    identity: "besprechung-moderation",
    video: { roomAdmin: true, room: payload.room },
    ttlSeconds: 60
  });
  const httpBase = env.LIVEKIT_URL.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/+$/, "");
  const resp = await fetch(`${httpBase}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`LiveKit ${method} (HTTP ${resp.status})${txt ? ": " + txt.slice(0, 200) : ""}`);
  }
  return resp.json().catch(() => ({}));
}

async function getSession(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return await verifyToken(match[1], env.SESSION_SECRET);
}

// Verifiziert das Token UND gleicht es mit dem aktuellen Nutzerbestand ab —
// zustandslose Tokens allein überleben sonst Nutzer-Löschung, Passwort-Reset
// und Admin-Entzug bis zu 7 Tage. Regeln: Token muss nach dem globalen Stichtag
// SESSIONS_INVALID_BEFORE ausgestellt sein; Nutzer muss noch existieren und ein
// gesetztes Passwort haben; Tokens von VOR dem letzten Passwort-Setzen sind
// ungültig (Reset durch Admin wirft damit alle alten Sitzungen raus); isAdmin
// kommt aus dem aktuellen Datensatz, nicht aus dem Token. Gibt zusätzlich das
// bereits gelesene usersDoc zurück, damit Handler es weiterverwenden können
// (kein zweiter Nextcloud-Read pro Request).
// onTokenValid (optional) wird genau dann aufgerufen, wenn der Token echt und
// nicht durch den Stichtag entwertet ist — aber noch BEVOR nutzer.json gelesen
// wird. Genau dieser Moment ist der richtige, um einen zweiten, unabhängigen
// Nextcloud-Read (sichtbarkeit.json für die Tool-Rechte) parallel zu starten:
// früher würde jeder Request OHNE gültigen Token Nextcloud-Last auslösen,
// später liefe der Read wieder hinter dem nutzer.json-Read her.
async function getVerifiedSession(request, env, authHeader, onTokenValid) {
  const payload = await getSession(request, env);
  if (!payload) return null;
  // Vor dem Nutzer-Abgleich, damit ein Token von vor dem Stichtag gar keinen
  // Nextcloud-Lesezugriff mehr auslöst.
  if (!tokenAfterCutoff(payload)) return null;
  if (onTokenValid) onTokenValid(payload);
  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  const user = sessionUserFromDoc(payload, usersDoc);
  if (!user) return null;
  const identity = deriveIdentity(user, usersDoc);
  // art bewusst NACH ...identity und aus dem echten Datensatz: anders als isAdmin/
  // groupIds ist die Art nicht Teil der Testansicht (set-view-as). Ein Admin, der
  // sich testweise als Gruppe ausgibt, bleibt Personal -- sonst würde die
  // Testansicht die Personal/Spieler-Trennung aushebeln statt sie zu zeigen.
  return { username: user.username, usersDoc, ...identity, art: userArt(user) };
}

// Globaler Stichtag. Bewusst eine eigene Funktion und NICHT Teil von
// sessionUserFromDoc: sie wird geprüft, BEVOR nutzer.json gelesen wird, damit ein
// Token von vor dem Stichtag gar keine Nextcloud-Last mehr auslöst.
function tokenAfterCutoff(payload) {
  return !!payload && (Number(payload.iat) || 0) >= SESSIONS_INVALID_BEFORE;
}

// Gleicht ein bereits per HMAC verifiziertes Token gegen den Nutzerbestand ab und
// liefert den Nutzer-Datensatz (oder null). Aus getVerifiedSession herausgezogen,
// damit auch der GET-Handler dieselben Regeln anwenden kann, ohne nutzer.json ein
// zweites Mal zu lesen — zwei Kopien dieser Liste würden auseinanderlaufen.
// Regeln: Nutzer muss noch existieren und ein gesetztes Passwort haben; archivierte
// Konten (Personalakte) verlieren jede Session sofort, nicht erst beim nächsten
// Login; Tokens von VOR dem letzten Passwort-Setzen sind ungültig (ein Admin-Reset
// wirft damit alle alten Sitzungen raus).
function sessionUserFromDoc(payload, usersDoc) {
  const user = getOwn(usersDoc.users, String((payload && payload.username) || ""));
  if (!user || user.mustSetPassword || !user.passwordHash) return null;
  if (user.archiviert) return null;
  if (user.passwordSetAt) {
    const setAt = Math.floor(Date.parse(user.passwordSetAt) / 1000);
    if (Number.isFinite(setAt) && (Number((payload && payload.iat)) || 0) < setAt) return null;
  }
  return user;
}

// ---------- sonstige Helfer ----------

function normalizeUsername(raw) {
  // Umlaute EXAKT wie beim Anlegen transliterieren (generateUsername -> slugifyNamePart
  // -> transliterate: ö->oe usw.), sonst wird "Jörg Müller" (erfundenes Beispiel) beim
  // Login zu "jörg.müller", der Account liegt aber unter "joerg.mueller" -> Konto nie gefunden, 401 statt
  // needsPasswordSetup (Login zeigt fälschlich das Passwort-Feld statt "Konto einrichten").
  return transliterate(String(raw || "")).trim().toLowerCase().replace(/\s+/g, ".");
}

// Anmeldung mit E-Mail-Adresse und Schreibvarianten (seit 2026-08-03, Michel-Vorgabe;
// Beispiel erfunden, dieses Repo ist oeffentlich: "Max Mustermann", "max.mustermann",
// "max_mustermann", "MaxMustermann" und "Max_Mustermann@example.invalid" sollen alle
// dasselbe Konto treffen).
//
// ⚠️ Die REIHENFOLGE ist bindend: der exakte Treffer (normalizeUsername wie bisher)
// steht immer vorn. Nutzernamen dürfen laut USERNAME_RE selbst "_" und "-" enthalten
// -- griffe eine Variante zuerst, wäre ein Konto namens "max_mueller" über seinen
// EIGENEN Namen nicht mehr erreichbar, weil die Variante "max.mueller" auf ein
// anderes Konto zeigt. Aus demselben Grund liefert jede Stufe nur bei einem
// EINDEUTIGEN Treffer ein Konto: bei zwei Kandidaten wird nicht geraten, sondern
// abgelehnt -- sonst könnte eine mehrdeutige Adresse jemanden ins fremde Konto führen.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/;

// Stufe 1+2: Kandidaten-Nutzernamen allein aus der Eingabe, OHNE Datei-Zugriff.
function loginNameKandidaten(raw) {
  const eingabe = String(raw || "").trim();
  const kandidaten = [];
  const add = (v) => {
    const kandidat = String(v || "").replace(/\.+/g, ".").replace(/^\.|\.$/g, "");
    if (!kandidat || kandidat === "__proto__") return;
    if (!USERNAME_RE.test(kandidat)) return;
    if (!kandidaten.includes(kandidat)) kandidaten.push(kandidat);
  };

  add(normalizeUsername(eingabe)); // heutiges Verhalten, immer zuerst

  // Bei einer E-Mail zählt nur der Teil vor dem @; "+zusatz" (Gmail-Stil) fällt weg.
  const at = eingabe.indexOf("@");
  const lokalteil = at > 0 ? eingabe.slice(0, at) : eingabe;
  for (const basis of [lokalteil, lokalteil.split("+")[0]]) {
    const norm = normalizeUsername(basis);
    add(norm);
    add(norm.replace(/[_\-]+/g, ".")); // alle üblichen Trennzeichen auf den Punkt
  }
  return kandidaten;
}

// Löst die Login-Eingabe auf einen Nutzer-Datensatz auf. Ersetzt das frühere
// getOwn(usersDoc.users, normalizeUsername(body.username)) in handleLogin und
// handleSetPassword -- beide Wege müssen dieselbe Eingabe akzeptieren, sonst
// bekäme jemand mit seiner E-Mail zwar "Konto einrichten" angeboten, scheiterte
// dann aber beim Setzen des Passworts an "Unbekannter Nutzer".
async function resolveLoginUser(raw, usersDoc, authHeader) {
  const users = (usersDoc && usersDoc.users) || {};
  const eingabe = String(raw || "").trim().slice(0, 200);

  // 1. Direkte Kandidaten -- kein zusätzlicher Nextcloud-Read.
  for (const kandidat of loginNameKandidaten(eingabe)) {
    const user = getOwn(users, kandidat);
    if (user) return user;
  }

  const at = eingabe.indexOf("@");
  const lokalteil = at > 0 ? eingabe.slice(0, at) : eingabe;

  // 2. Name ohne jedes Trennzeichen ("MichelBrunner@..."), gegen die vorhandenen
  //    Konten geprüft. Ebenfalls ohne Datei-Zugriff, deshalb VOR dem Rückfall unten.
  //    slugifyNamePart wirft alles außer a-z0-9 weg, "michel.brunner" wird also
  //    genauso zu "michelbrunner" wie der Adress-Lokalteil.
  const kompakt = slugifyNamePart(lokalteil.split("+")[0]);
  if (kompakt.length >= 3) {
    const treffer = Object.values(users).filter((u) =>
      slugifyNamePart(u.username) === kompakt ||
      slugifyNamePart(u.vorname) + slugifyNamePart(u.nachname) === kompakt ||
      slugifyNamePart(u.nachname) + slugifyNamePart(u.vorname) === kompakt
    );
    if (treffer.length === 1) return treffer[0];
  }

  // 3. Rückfall für Adressen, die nichts mit dem Namen zu tun haben ("fussballfan99@example.invalid"):
  //    die echte E-Mail-Adresse steht in den Trainerdaten -- nutzer.json führt keine.
  //    ⚠️ Das ist der EINZIGE unangemeldete Weg, der PROVISION_ONLY_PATHS.trainerdaten
  //    liest (die Datei enthält IBAN-Daten). Michel-Entscheidung 2026-08-03. Bedingungen,
  //    die das eng halten und nicht aufgeweicht werden sollten: nur bei einer Eingabe,
  //    die wirklich wie eine Adresse aussieht, nur wenn Stufe 1+2 nichts gefunden haben,
  //    und aus der Datei verlässt NICHTS den Worker -- ermittelt wird ausschließlich der
  //    Nutzername. Wiederholte Versuche laufen in den jsonCache (5s).
  if (!EMAIL_RE.test(eingabe)) return null;
  let trainerdatenDoc;
  try {
    trainerdatenDoc = await readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] });
  } catch (_) {
    return null; // ein Leseausfall darf den Login nicht kippen, nur diese Stufe
  }

  const gefunden = [];
  for (const t of (trainerdatenDoc.trainer || [])) {
    if (!sameText(t.email, eingabe)) continue;
    // Gleiche Rangfolge wie findTrainerdatenRecord, nur andersherum gelesen:
    // vom Trainerdaten-Satz auf das Konto statt umgekehrt.
    const perUsername = getOwn(users, String(t.username || "").toLowerCase()) ||
                        getOwn(users, normalizeUsername(t.linkedUsername));
    if (perUsername) { gefunden.push(perUsername); continue; }
    const perName = Object.values(users).filter((u) => sameNamePair(t.vorname, t.nachname, u.vorname, u.nachname));
    if (perName.length === 1) gefunden.push(perName[0]);
  }
  const eindeutig = [...new Set(gefunden)];
  return eindeutig.length === 1 ? eindeutig[0] : null;
}

// Dynamische Objekt-Lookups mit von außen bestimmten Keys: nur echte eigene
// Properties zählen. Ohne diesen Check liefern geerbte Keys wie "__proto__"
// oder "constructor" ein truthy Ergebnis (Object.prototype bzw. die
// Konstruktor-Funktion) und fließen dann als vermeintlicher Treffer in die
// weitere Logik ein.
function getOwn(obj, key) {
  return obj && typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key)
    ? obj[key]
    : undefined;
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return base64ToBytes(b64);
}

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

// =============================================================================
// Push-Nachrichten (seit 2026-08-03)
//
// Bewusst als geschlossener Block am Dateiende: die Verschluesselung selbst
// liegt im eigenen Worker "push", hier steht nur die Verwaltung der Abos und
// das Erteilen des Versandauftrags. Sollte diese Datei je zu schwer werden,
// laesst sich dieser Block am Stueck herausloesen.
//
// Entwurf: docs/superpowers/specs/2026-08-03-push-nachrichten-design.md
// =============================================================================

// Eigene Datei aus demselben Grund wie die Neuigkeiten-Reaktionen und die
// Aufgaben -- vor allem aber: nutzer.json wird bei JEDEM authentifizierten
// Request gelesen (getVerifiedSession). Abos dort wuerden jeden einzelnen
// Aufruf der ganzen Flotte um Daten verteuern, die nur beim Versand zaehlen.
const PUSH_ABOS_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/push-abos.json";

// ⚠️ EINE Liste als Quelle fuer alles: Schalter im Konto-Tab, Titel und Ziel der
// Nachricht, erlaubte Werte beim Speichern. Vorher standen die drei Anlaesse
// fest verdrahtet an vier Stellen (HTML, app.js, zwei Stellen hier) -- bei drei
// Stueck geht das, bei sieben laeuft es auseinander. Ein neuer Anlass ist jetzt
// ein Listeneintrag plus die Stelle, die ihn ausloest.
//
// titel = fette Zeile der Nachricht, ziel = wohin das Antippen fuehrt,
// label = Beschriftung des Schalters im Konto-Tab.
const PUSH_ANLAESSE = [
  { id: "kalender", titel: "Vereinskalender", ziel: "/vereinskalender/",
    label: "Vereinskalender — neue und geänderte Termine" },
  { id: "aufgaben", titel: "Vereinsaufgaben", ziel: "/vereinsaufgaben/",
    label: "Vereinsaufgaben — neue Aufgaben, Rückfragen und Statusmeldungen" },
  { id: "unterschriften", titel: "Unterschriften", ziel: "/ToolsUebersicht/",
    label: "Unterschriften — Dokumente, die auf mich warten" },
  { id: "testspiele", titel: "Testspielplaner", ziel: "/testspielplaner/",
    label: "Testspielplaner — Anfragen und Entscheidungen" },
  { id: "material", titel: "Materialbedarf", ziel: "/materialbedarf/",
    label: "Materialbedarf — Meldungen und Entscheidungen" },
  { id: "fahrtenbuch", titel: "Fahrtenbuch", ziel: "/fahrtenbuch/",
    label: "Fahrtenbuch — neu eingereichte Fahrten" },
  { id: "fotos", titel: "Fotoaufträge", ziel: "/fotoauftraege/",
    label: "Fotoaufträge — neue Aufträge für meine Mannschaft" },
  { id: "raumnutzung", titel: "Raumnutzung", ziel: "/raumnutzung/",
    label: "Raumnutzung — fertige Anträge und ihr weiterer Weg" },
  { id: "schulsport", titel: "Schulsport", ziel: "/schulsport/",
    label: "Schulsport — Termine, die auf meine Rückmeldung warten" },
  { id: "spieltagscrew", titel: "Spieltagscrew", ziel: "/spieltagscrew/",
    label: "Spieltagscrew — offene Posten und Erinnerung an meinen Dienst" },
  // Erinnerung kurz vor dem eigenen Punkt eines Ablaufplans. Ausgeloest vom
  // Fuenf-Minuten-Lauf in scheduled(), NICHT von einer Nutzerhandlung.
  { id: "ablaufplan", titel: "Ablaufplan", ziel: "/ablaufplan/",
    label: "Ablaufplan — Erinnerung kurz vor meinem eigenen Punkt" },
  // Erinnerung an eine zugesagte Busfahrt, drei Tage vorher. Ausgeloest vom
  // NAECHTLICHEN Lauf in scheduled(), NICHT von einer Nutzerhandlung -- am
  // richtigen Morgen hat niemand die App offen. Die Regeln des Busses stehen
  // in der Mail, nicht hier: auf einem Sperrbildschirm ist dafuer kein Platz.
  { id: "busplan", titel: "Busplan", ziel: "/busplan/",
    label: "Busplan — Erinnerung an die zugesagte Fahrt meiner Mannschaft" },
  // Ziel ist die Uebersicht selbst (wie "unterschriften") -- die Antwort steht
  // im Tab "Feedback & Hilfe", nicht in einer der verlinkten Apps. Deshalb traegt
  // hierfuer auch keine Kachel in config.js das 🔔-Kennzeichen.
  { id: "feedback", titel: "Feedback & Wünsche", ziel: "/ToolsUebersicht/",
    label: "Feedback & Wünsche — Antworten auf meine Einreichungen" },
  // Ausgeloest vom Bereitstellen in den Dokumentenvorlagen. Ziel ist die
  // Uebersicht selbst (wie "unterschriften" und "feedback"): die Unterlagen
  // liegen im Tab "Mein Konto", nicht in einer verlinkten App -- deshalb traegt
  // hierfuer auch keine Kachel in config.js das 🔔-Kennzeichen.
  { id: "unterlagen", titel: "Unterlagen", ziel: "/ToolsUebersicht/",
    label: "Unterlagen — Dokumente, die für mich bereitliegen" },
  // Von Hand ausgeloest im Einstellungen-Tab (push-rundnachricht, seit
  // 2026-08-06). Der einzige Anlass, dessen TITEL nicht von hier kommt: bei
  // einer freien Mitteilung ist die Ueberschrift Teil der Nachricht. Der
  // Eintrag steht trotzdem hier, weil er den Schalter im Konto-Tab traegt und
  // das Ziel festlegt -- der Aufrufer bestimmt nur den Titel, sonst nichts.
  { id: "mitteilung", titel: "SC 1911 Heiligenstadt", ziel: "/ToolsUebersicht/",
    label: "Mitteilungen des Vereins — von Hand verschickt, nur bei besonderen Anlässen" }
];

function pushAnlassInfo(id) {
  for (const a of PUSH_ANLAESSE) if (a.id === id) return a;
  return null;
}

const PUSH_MAX_GERAETE_PRO_NUTZER = 10;
// Haeppchengroesse fuer den Fan-out. Jeder Aufruf ueber das Service Binding
// bekommt sein EIGENES CPU-Budget -- genau deswegen liegt die Verschluesselung
// in einem zweiten Worker. 30 Empfaenger mit je zwei Geraeten waeren sonst 60
// Verschluesselungen in einem Budget. Nach einer echten Messung anpassbar.
const PUSH_HAEPPCHEN = 10;

// Titel und Ziel stehen in PUSH_ANLAESSE oben, nicht beim Aufrufer. Der Aufrufer
// liefert nur den kurzen Satz -- und der enthaelt keine Namen, keine Titel und
// keine Anzahl: eine Push-Nachricht steht auf dem Sperrbildschirm, den auch
// jemand anders sehen kann. Dieselbe Linie wie beim Mail-Betreff der
// Unterschriften-Anforderung.

function leerePushDoc() { return { version: 1, abos: {}, anlaesse: {} }; }

// Fehlender Eintrag = alle Anlaesse an. Wer sich anmeldet, bevor es die
// Schalter gibt, bekommt alles; die Aenderung ist in beide Richtungen
// vertraeglich.
function pushAnlaesseFuer(doc, username) {
  const roh = (doc && doc.anlaesse && getOwn(doc.anlaesse, username)) || {};
  const out = {};
  for (const a of PUSH_ANLAESSE) out[a.id] = roh[a.id] !== false;
  return out;
}

function pushAbosFuer(doc, username) {
  const liste = (doc && doc.abos && getOwn(doc.abos, username)) || [];
  return Array.isArray(liste) ? liste : [];
}

// Read-modify-write mit Konflikt-Wiederholung. ⚠️ Kein blindes Ueberschreiben:
// in dieselbe Datei schreibt auch das Aufraeumen toter Abos nach einem Versand.
// Ohne ifMatch koennte ein Aufraeumen die Anmeldung von vor zwei Sekunden
// kosten.
async function pushAbosMutieren(authHeader, aendern) {
  let letzterFehler = null;
  for (let versuch = 0; versuch < 3; versuch++) {
    const gelesen = await readJsonWithRev(PUSH_ABOS_URL, authHeader, leerePushDoc());
    const doc = (gelesen.data && typeof gelesen.data === "object") ? gelesen.data : leerePushDoc();
    if (!doc.abos || typeof doc.abos !== "object") doc.abos = {};
    if (!doc.anlaesse || typeof doc.anlaesse !== "object") doc.anlaesse = {};

    const weiter = aendern(doc);
    if (weiter === false) return doc; // nichts zu aendern, kein Schreibzugriff

    try {
      await writeJson(PUSH_ABOS_URL, authHeader, doc, gelesen.rev);
      return doc;
    } catch (e) {
      if (e instanceof ConflictError) { letzterFehler = e; continue; }
      throw e;
    }
  }
  throw letzterFehler || new Error("Push-Abos konnten nicht geschrieben werden");
}

// ---------- Aktionen fuer den Konto-Tab ----------

async function handlePushStatus(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const doc = await readJson(PUSH_ABOS_URL, authHeader, leerePushDoc());
  const username = normalizeUsername(session.username);
  return json({
    ok: true,
    // Der oeffentliche VAPID-Schluessel kommt vom Server, nicht aus app.js:
    // so braucht ein Schluesselwechsel keinen Pages-Deploy.
    publicKey: String(env.VAPID_PUBLIC_KEY || ""),
    geraete: pushAbosFuer(doc, username).map((a) => ({
      id: a.id, geraet: a.geraet || "Unbekanntes Geraet", angelegtAm: a.angelegtAm || ""
    })),
    anlaesse: pushAnlaesseFuer(doc, username),
    // Die Schalter im Konto-Tab werden hieraus gebaut, nicht fest im HTML: ein
    // neuer Anlass soll nur einen Listeneintrag kosten, keinen Pages-Deploy.
    // ⚠️ Ein aelterer Client ohne diese Auswertung zeigt einfach seine drei
    // festen Schalter weiter -- rein additiv, verengt nichts.
    liste: PUSH_ANLAESSE.map((a) => ({ id: a.id, label: a.label }))
  }, 200, corsHeaders);
}

async function handlePushAboAnlegen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const endpoint = String((body && body.endpoint) || "").trim();
  const p256dh = String((body && body.p256dh) || "").trim();
  const auth = String((body && body.auth) || "").trim();
  const geraet = String((body && body.geraet) || "").trim().slice(0, 80);

  if (!/^https:\/\//i.test(endpoint) || !p256dh || !auth) {
    return json({ error: "Unvollstaendiges Abo" }, 400, corsHeaders);
  }
  if (endpoint.length > 800) return json({ error: "Endpunkt zu lang" }, 400, corsHeaders);

  // Der Nutzer kommt IMMER aus dem Token, nie aus dem Body -- sonst meldet ein
  // Eingeloggter fremde Geraete an. Gleiche Regel wie bei change-password.
  //
  // ⚠️ normalizeUsername auch HIER, nicht nur beim Versand: gespeichert wird
  // unter diesem Schluessel, gesucht wird in pushSenden ueber
  // normalizeUsername(empfaenger). Weichen die beiden Schreibweisen ab, liegt
  // das Abo da und wird trotzdem nie gefunden -- ein Fehler, den man dem
  // Konto-Tab nicht ansieht, weil dort alles richtig aussieht.
  const username = normalizeUsername(session.username);

  let neueId = "";
  await pushAbosMutieren(authHeader, (doc) => {
    const liste = pushAbosFuer(doc, username).slice();
    // Deduplizierung ueber den Endpunkt: zweimal Einschalten auf demselben
    // Geraet darf keinen Doppeleintrag erzeugen.
    const schonDa = liste.findIndex((a) => a.endpoint === endpoint);
    const eintrag = {
      id: schonDa >= 0 ? liste[schonDa].id : crypto.randomUUID(),
      endpoint, p256dh, auth,
      geraet: geraet || "Unbekanntes Geraet",
      angelegtAm: schonDa >= 0 ? (liste[schonDa].angelegtAm || new Date().toISOString()) : new Date().toISOString()
    };
    if (schonDa >= 0) liste[schonDa] = eintrag; else liste.push(eintrag);
    // Deckel: ohne ihn waechst eine gemeinsame Datei unbegrenzt. Aeltestes raus.
    while (liste.length > PUSH_MAX_GERAETE_PRO_NUTZER) liste.shift();
    doc.abos[username] = liste;
    neueId = eintrag.id;
  });

  // Einmal-Bonus fuers Einschalten (Regelversion 5). ⚠️ Anders als beim Foto ist
  // hier ein EIGENER Schreibvorgang auf nutzer.json noetig -- dieser Handler fasst
  // sonst nur push-abos.json an. Er faellt genau einmal im Leben eines Kontos an;
  // danach steht die Sperre und der Zweig wird nie wieder betreten. Ein Fehlschlag
  // beim Setzen der Sperre darf das Abo nicht kippen: das Einschalten hat
  // funktioniert, nur der Bonus faellt dann aus.
  const bonusNutzer = getOwn(session.usersDoc.users, session.username);
  let bonusFaellig = punkteEinmalBonusFaellig(bonusNutzer, "punkteBonusPushAt");
  if (bonusFaellig) {
    try {
      await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, session.usersDoc);
    } catch (e) {
      bonusFaellig = false;
      console.error("Push-Bonus-Sperre schreiben fehlgeschlagen: " + (e && e.message ? e.message : e));
    }
  }

  // Die Id zurueck: der Client merkt sie sich lokal und kann seinen eigenen
  // Eintrag in der Geraeteliste als "dieses Geraet" kennzeichnen. Ohne das
  // waere die Liste eine Reihe ununterscheidbarer Namen.
  const antwort = json({ ok: true, id: neueId }, 200, corsHeaders);
  if (bonusFaellig) antwort.punkteBonus = { art: "push", username: session.username };
  return antwort;
}

async function handlePushAboLoeschen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const id = String((body && body.id) || "").trim();
  if (!id) return json({ error: "Keine Geraete-Id" }, 400, corsHeaders);
  const username = normalizeUsername(session.username);

  await pushAbosMutieren(authHeader, (doc) => {
    const liste = pushAbosFuer(doc, username);
    const rest = liste.filter((a) => a.id !== id);
    if (rest.length === liste.length) return false; // war schon weg
    doc.abos[username] = rest;
  });

  return json({ ok: true }, 200, corsHeaders);
}

async function handlePushAnlaesseSetzen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const gewuenscht = (body && body.anlaesse) || {};
  const username = normalizeUsername(session.username);

  await pushAbosMutieren(authHeader, (doc) => {
    const neu = {};
    for (const a of PUSH_ANLAESSE) neu[a.id] = gewuenscht[a.id] !== false;
    doc.anlaesse[username] = neu;
  });

  const doc2 = await readJson(PUSH_ABOS_URL, authHeader, leerePushDoc());
  return json({ ok: true, anlaesse: pushAnlaesseFuer(doc2, username) }, 200, corsHeaders);
}

// Testnachricht an die eigenen Geraete. Anders als pushSenden schluckt diese
// Aktion NICHTS, sondern meldet jeden Schritt zurueck -- der normale Versand
// laeuft in ctx.waitUntil und ist damit von aussen unsichtbar, was die Suche
// nach "es kommt nichts an" sonst zum Blindflug macht.
async function handlePushTest(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const schritte = [];
  const merke = (was, wert) => schritte.push(was + ": " + wert);

  merke("Service Binding PUSH", env.PUSH ? "vorhanden" : "FEHLT");
  merke("PUSH_SHARED_SECRET", env.PUSH_SHARED_SECRET ? "gesetzt" : "FEHLT");
  merke("VAPID_PUBLIC_KEY", env.VAPID_PUBLIC_KEY ? "gesetzt" : "FEHLT");
  merke("Nutzername der Sitzung", session.username);

  if (!env.PUSH || !env.PUSH_SHARED_SECRET) {
    return json({ ok: false, grund: "Serverseitig nicht vollstaendig eingerichtet.", schritte }, 200, corsHeaders);
  }

  const doc = await readJson(PUSH_ABOS_URL, authHeader, leerePushDoc());
  // Zeigt einen Namens-Versatz zwischen Anmeldung und Versand sofort: die Abos
  // liegen unter session.username, gesucht wird beim Versand ueber
  // normalizeUsername(empfaenger).
  merke("Schluessel in push-abos.json", Object.keys(doc.abos || {}).join(", ") || "(keine)");
  merke("Nach normalizeUsername", normalizeUsername(session.username));

  const meine = pushAbosFuer(doc, normalizeUsername(session.username));
  merke("Eigene Geraete gefunden", meine.length);
  if (!meine.length) {
    return json({ ok: false, grund: "Fuer diesen Nutzer ist kein Geraet gespeichert.", schritte }, 200, corsHeaders);
  }

  try {
    const res = await env.PUSH.fetch("https://push.intern/senden", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.PUSH_SHARED_SECRET,
        nachricht: { titel: "SC 1911", text: "Das ist eine Testnachricht. Wenn du sie lesen kannst, kommen Push-Nachrichten auf diesem Gerät an — du musst nichts weiter tun.", ziel: "/ToolsUebersicht/" },
        abos: meine.map((a) => ({ id: a.id, endpoint: a.endpoint, p256dh: a.p256dh, auth: a.auth }))
      })
    });
    merke("Antwort des push-Workers", "HTTP " + res.status);
    const roh = await res.text();
    let daten = null;
    try { daten = JSON.parse(roh); } catch (_) { merke("Antworttext", roh.slice(0, 300)); }
    if (daten) {
      merke("zugestellt", daten.zugestellt);
      merke("tote Abos", (daten.tot || []).length);
      if (daten.fehler && daten.fehler.length) merke("Fehler", JSON.stringify(daten.fehler).slice(0, 400));
      if (daten.error) merke("Fehlermeldung", daten.error);
    }
    return json({ ok: true, schritte, antwort: daten }, 200, corsHeaders);
  } catch (e) {
    merke("Aufruf des push-Workers warf", (e && e.message) ? e.message : String(e));
    return json({ ok: false, grund: "Der push-Worker war nicht erreichbar.", schritte }, 200, corsHeaders);
  }
}

// Push an ALLE beim Anlegen/Aendern eines nicht-privaten Kalendertermins
// (seit 2026-08-03, Michel-Vorgabe "nicht nur private, sondern wirklich jeder
// Termin").
//
// ⚠️ Private Termine laufen NICHT hierueber, sondern weiter ueber notify-user:
// dort gibt es Mail UND Push, und zwar nur an die tatsaechlich Geteilten. Ohne
// diese Trennung bekaeme ein privat geteilter Termin beides doppelt -- und
// zusaetzlich die halbe Belegschaft, die ihn gar nicht sehen darf.
//
// ⚠️ Spielerkonten bleiben aussen vor (Michel-Entscheidung): bei ~200 davon
// waere jeder Termin ein Fan-out an die halbe Vereinsdatenbank. Gleiche Linie
// wie beim Materialcontainer-Code.
async function handleVkTerminPush(request, body, env, authHeader, corsHeaders, execCtx) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  // ⚠️ Gate am Bearbeiten-Recht. Ohne das koennte JEDES eingeloggte Konto die
  // gesamte Belegschaft mit Nachrichten zuschuetten -- und zwar ohne dass dabei
  // ein einziger Termin entstehen muesste. Termine anlegen darf ohnehin nur,
  // wer canEdit hat (vereinskalender steht in WRITE_REQUIRES_EDIT_PERMISSION).
  const darf = await resolveEditPermission("vereinskalender", session, env, authHeader);
  if (!darf) return json({ error: "Keine Berechtigung" }, 403, corsHeaders);

  const art = (body && body.art === "geaendert") ? "geaendert" : "neu";

  const users = (session.usersDoc && session.usersDoc.users) || {};
  const selbst = normalizeUsername(session.username);
  const empfaenger = [];
  for (const schluessel of Object.keys(users)) {
    const u = users[schluessel];
    if (!u || u.archiviert || !istPersonal(u)) continue;
    // Wer den Termin anlegt, braucht keine Meldung darueber. Beide Schreibweisen
    // pruefen: der Schluessel und das Feld username koennen abweichen.
    const name = normalizeUsername(u.username || schluessel);
    if (name === selbst) continue;
    empfaenger.push(name);
  }

  // Der Text nennt bewusst weder Titel noch Ort -- Sperrbildschirm, gleiche
  // Linie wie ueberall sonst.
  pushSenden(env, authHeader, execCtx, empfaenger, "kalender",
    art === "neu" ? "Ein neuer Termin steht im Vereinskalender. Öffne ihn, dort stehen Tag, Uhrzeit und Ort."
                  : "Ein Termin im Vereinskalender hat sich geändert. Bitte prüfe Tag, Uhrzeit und Ort noch einmal nach.");

  // Die Zahl ist die der IN FRAGE KOMMENDEN, nicht der tatsaechlich erreichten:
  // wer kein Geraet angemeldet oder den Kalender-Schalter aus hat, faellt erst
  // in pushSenden heraus.
  return json({ ok: true, infrage: empfaenger.length }, 200, corsHeaders);
}

// Alle Personalkonten, die eine App BEARBEITEN duerfen -- die Zustaendigen also.
// Gebraucht dort, wo eine Meldung nicht an eine bestimmte Person geht, sondern
// an "wer sich darum kuemmert": Materialbedarf, Fahrtenbuch, Fotoauftraege.
//
// Spiegelt bewusst die Logik von resolveEditPermission (editGroupIds +
// adminGroupIds, globale Admins immer) -- wer das eine aendert, muss das andere
// mitziehen, sonst benachrichtigt die App jemanden, der gar nichts entscheiden
// kann, oder uebergeht den, der es muss.
//
// ⚠️ usersDoc wird uebergeben statt gelesen: der Fahrtenbuch-Weg hat KEINE
// Sitzung (Einreichung per Code ohne Login) und muss es selbst beschaffen.
async function pushEmpfaengerMitRecht(app, usersDoc, env, authHeader, ausser) {
  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  const entry = getOwn(config.tools || {}, app) || {};
  const editIds = Array.isArray(entry.editGroupIds) ? entry.editGroupIds : [];
  const adminIds = Array.isArray(entry.adminGroupIds) ? entry.adminGroupIds : [];
  const gruppen = editIds.concat(adminIds);

  const users = (usersDoc && usersDoc.users) || {};
  const weg = normalizeUsername(String(ausser || ""));
  const out = [];
  for (const schluessel of Object.keys(users)) {
    const u = users[schluessel];
    if (!u || u.archiviert || !istPersonal(u)) continue;
    const name = normalizeUsername(u.username || schluessel);
    if (weg && name === weg) continue;          // wer es ausloest, weiss Bescheid
    if (u.isAdmin) { out.push(name); continue; } // globaler Admin darf ueberall
    const meine = getUserGroupIds(usersDoc, schluessel);
    if (gruppen.some((g) => meine.indexOf(g) !== -1)) out.push(name);
  }
  return out;
}

// Apps nach dem Muster "jemand reicht ein, jemand entscheidet". Beide fuehren
// eine Liste von Vorgaengen mit id/status/erstelltVon -- deshalb EINE Aktion
// statt zwei fast gleicher. Ein weiterer Kandidat ist ein Listeneintrag.
const PUSH_VORGANG_APPS = {
  testspielplaner: {
    liste: "reservierungen", anlass: "testspiele",
    neu: "Eine neue Anfrage wartet auf deine Entscheidung. Im Testspielplaner kannst du sie zusagen oder absagen.",
    entschieden: "Deine Anfrage wurde bearbeitet. Im Testspielplaner steht, wie entschieden wurde.",
    // Optionale Verteilerliste unter einstellungen.<feld> in der App-Datei,
    // gepflegt im Einstellungen-Tab der App. Nur gesetzte Apps zahlen den
    // zusaetzlichen Nextcloud-Read; materialbedarf hat dafuer keine Oberflaeche
    // und soll ihn deshalb nicht zahlen. Wer es dort nachruestet, ergaenzt hier
    // eine Zeile -- die Auswertung unten ist schon generisch.
    empfaengerFeld: "pushEmpfaenger"
  },
  materialbedarf: {
    liste: "meldungen", anlass: "material",
    neu: "Eine neue Bedarfsmeldung wartet auf deine Entscheidung. Im Materialbedarf kannst du sie freigeben oder ablehnen.",
    entschieden: "Deine Bedarfsmeldung wurde bearbeitet. Im Materialbedarf steht, wie entschieden wurde."
  },
  // Raumnutzung folgt demselben Muster, nur heisst der Uebergabepunkt hier
  // "fertig": Trainer fuellen den Antrag aus (Bearbeiten), eingereicht wird er
  // von der Geschaeftsstelle (Administrieren). "entschieden" deckt beides ab --
  // beim Amt eingereicht UND die Antwort des Landkreises. Der Text nennt deshalb
  // kein Ergebnis; was passiert ist, steht in der App.
  raumnutzung: {
    liste: "antraege", anlass: "raumnutzung",
    neu: "Ein Antrag ist fertig ausgefüllt und wartet aufs Einreichen. In der Raumnutzung kannst du ihn prüfen und abschicken.",
    entschieden: "Bei deinem Antrag hat sich etwas getan. In der Raumnutzung siehst du den aktuellen Stand.",
    empfaengerFeld: "pushEmpfaenger"
  }
};

// ⚠️ Der Empfaenger kommt aus dem DATENSATZ, nicht aus dem Request. Wuerde der
// Client den Nutzernamen mitschicken, koennte jeder Bearbeiter beliebige Leute
// benachrichtigen lassen -- und ein Tippfehler liefe ins Leere, ohne dass es
// jemand merkt. Der Worker liest den Vorgang selbst und nimmt erstelltVon.
//
// Ob der Vorgang wirklich gerade entschieden wurde, prueft diese Aktion NICHT:
// sie wird unmittelbar nach dem Speichern gerufen, und ein zweiter Lesevorgang
// zur Bestaetigung waere eine Scheinsicherheit (der Zustand kann sich zwischen
// beiden Aufrufen ohnehin aendern). Die Schranke ist das Bearbeiten-Recht.
async function handleVorgangPush(request, body, env, authHeader, corsHeaders, execCtx) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const app = String((body && body.app) || "");
  const cfg = getOwn(PUSH_VORGANG_APPS, app);
  if (!cfg) return json({ error: "Unbekannte App" }, 400, corsHeaders);

  const davUrl = getOwn(DAV_APPS, app);
  if (!davUrl) return json({ error: "Unbekannte App" }, 400, corsHeaders);
  if (!(await userMayAccessTool(app, session, env, authHeader))) {
    return json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders);
  }

  const art = (body && body.art === "entschieden") ? "entschieden" : "neu";

  // Entscheiden darf nur, wer bearbeiten darf. Melden darf jeder, der die App
  // sieht -- das ist der Zweck dieser Apps.
  if (art === "entschieden") {
    if (!(await resolveEditPermission(app, session, env, authHeader))) {
      return json({ error: "Keine Berechtigung" }, 403, corsHeaders);
    }
  }

  let empfaenger = [];
  if (art === "neu") {
    // An die Zustaendigen: wer den Vorgang entscheiden kann.
    empfaenger = await pushEmpfaengerMitRecht(app, session.usersDoc, env, authHeader, session.username);
    // Die App darf den Kreis VERKLEINERN, nie erweitern -- deshalb ein Filter
    // ueber das Rechte-Ergebnis und keine eigene Empfaengerquelle. Sonst koennte
    // ein Bearbeiter beliebige Konten (auch Spieler) mit Nachrichten belegen,
    // und wer sein Bearbeiten-Recht verliert, bekaeme durch eine vergessene
    // Liste weiter Meldungen.
    //
    // ⚠️ Leere oder fehlende Liste = ALLE Berechtigten, nicht niemand. Ein
    // ausbleibendes Push faellt keinem auf (anders als ein fehlendes Schreib-
    // recht), der stille Ausfall muss also die unwahrscheinlichere Richtung
    // sein. Wer wirklich niemanden benachrichtigen will, nimmt den Anlass raus.
    if (cfg.empfaengerFeld) {
      const doc = await readJson(davUrl, authHeader, {});
      const eins = (doc && typeof doc.einstellungen === "object" && doc.einstellungen) || {};
      const roh = getOwn(eins, cfg.empfaengerFeld);
      const gewaehlt = Array.isArray(roh)
        ? roh.map((n) => normalizeUsername(String(n || ""))).filter(Boolean)
        : [];
      if (gewaehlt.length) {
        const enger = empfaenger.filter((n) => gewaehlt.indexOf(n) !== -1);
        // ⚠️ Nur uebernehmen, wenn davon jemand uebrig bleibt. Verliert der
        // einzige Angehakte sein Bearbeiten-Recht, waere die Schnittmenge leer
        // und die Anfrage ginge lautlos unter -- genau das soll Push verhindern.
        // Lieber einer zu viel als eine Anfrage, die niemand sieht (gleiches
        // Muster wie der Mannschafts-Fallback in handleFotoauftragPush).
        if (enger.length) empfaenger = enger;
      }
    }
  } else {
    const id = String((body && body.id) || "");
    if (!id) return json({ error: "Fehlende id" }, 400, corsHeaders);
    const doc = await readJson(davUrl, authHeader, {});
    const liste = Array.isArray(doc[cfg.liste]) ? doc[cfg.liste] : [];
    const vorgang = liste.find((v) => v && v.id === id);
    if (!vorgang) return json({ error: "Vorgang nicht gefunden" }, 404, corsHeaders);
    const wer = normalizeUsername(String(vorgang.erstelltVon || ""));
    // Wer seinen eigenen Vorgang entscheidet, braucht keine Meldung darueber.
    if (!wer || wer === normalizeUsername(session.username)) {
      return json({ ok: true, infrage: 0 }, 200, corsHeaders);
    }
    empfaenger = [wer];
  }

  pushSenden(env, authHeader, execCtx, empfaenger, cfg.anlass, cfg[art]);
  return json({ ok: true, infrage: empfaenger.length }, 200, corsHeaders);
}

// Fotoauftrag angelegt -> an die Trainer DER BETROFFENEN MANNSCHAFT, nicht an
// alle. Das Social-Media-Team fragt Fotos einer bestimmten Mannschaft an; wen
// das nichts angeht, soll auch nichts hoeren. Die Zuordnung steht in
// nutzer.json (u.mannschaften), es braucht also keinen zweiten Datenbestand.
//
// ⚠️ Fallback auf die Bearbeitenden, wenn zu der Mannschaft niemand hinterlegt
// ist: sonst ginge die Anfrage lautlos unter, und genau das soll Push ja
// verhindern. Lieber einer zu viel als eine Anfrage, die niemand sieht.
async function handleFotoauftragPush(request, body, env, authHeader, corsHeaders, execCtx) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveEditPermission("fotoauftraege", session, env, authHeader))) {
    return json({ error: "Keine Berechtigung" }, 403, corsHeaders);
  }

  const id = String((body && body.id) || "");
  if (!id) return json({ error: "Fehlende id" }, 400, corsHeaders);

  const url = getOwn(DAV_APPS, "fotoauftraege");
  const doc = await readJson(url, authHeader, { meta: {}, auftraege: [] });
  const liste = Array.isArray(doc.auftraege) ? doc.auftraege : [];
  const auftrag = liste.find((a) => a && a.id === id);
  if (!auftrag) return json({ error: "Auftrag nicht gefunden" }, 404, corsHeaders);

  const mannschaft = String(auftrag.mannschaft || "").trim();
  const selbst = normalizeUsername(session.username);
  const users = (session.usersDoc && session.usersDoc.users) || {};

  let empfaenger = [];
  if (mannschaft) {
    for (const schluessel of Object.keys(users)) {
      const u = users[schluessel];
      if (!u || u.archiviert || !istPersonal(u)) continue;
      const meine = Array.isArray(u.mannschaften) ? u.mannschaften : [];
      if (meine.indexOf(mannschaft) === -1) continue;
      const name = normalizeUsername(u.username || schluessel);
      if (name === selbst) continue;
      empfaenger.push(name);
    }
  }
  if (!empfaenger.length) {
    empfaenger = await pushEmpfaengerMitRecht("fotoauftraege", session.usersDoc, env, authHeader, session.username);
  }

  pushSenden(env, authHeader, execCtx, empfaenger, "fotos",
    "Für eine deiner Mannschaften werden Fotos gebraucht. In den Fotoaufträgen stehen Anlass, Termin und was gewünscht ist.");
  return json({ ok: true, infrage: empfaenger.length }, 200, corsHeaders);
}

// ---------- Rundnachricht von Hand (seit 2026-08-06) ----------
//
// Michel-Wunsch: eine Nachricht selbst formulieren und sofort an alle Geraete
// schicken -- fuer die Faelle, die keine App und keinen Anlass haben (Training
// faellt aus, Halle gesperrt, kurzfristige Absage).
//
// ⚠️ Der einzige Push-Weg der Flotte, dessen Empfaenger NICHT aus einem
// Datensatz kommen, sondern aus einer Auswahl. Deshalb haengt er am globalen
// Admin-Recht und an keiner Tool-Berechtigung: es gibt kein Tool, dessen
// Bearbeiten-Recht "darf die ganze Belegschaft anschreiben" bedeuten soll.
//
// Der Text ist frei -- und damit der einzige Push-Text der Flotte, der auf einem
// fremden Sperrbildschirm stehen kann. Das ist bewusst so (der Absender
// entscheidet, was hineingehoert) und der Grund fuer den Hinweis im Panel.
const PUSH_RUNDNACHRICHTEN_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/push-rundnachrichten.json";

// Eigene Datei statt eines Feldes in push-abos.json, aus demselben Grund, aus
// dem die Abos nicht in nutzer.json stehen: push-abos.json wird bei JEDEM
// Versand der Flotte gelesen. Ein mitwachsendes Protokoll wuerde jede
// Terminmeldung mitbezahlen lassen, obwohl es nur zwei Leser hat (das Panel und
// die Doppelklick-Sperre).
const PUSH_RUND_VERLAUF_MAX = 30;
const PUSH_RUND_TITEL_MAX = 100;   // wie im push-worker, dort wird hart gekuerzt
const PUSH_RUND_TEXT_MAX = 200;    // ebenso -- laenger kommt gar nicht erst an
const PUSH_RUND_SPERRE_MS = 15000;

// Deckel fuer die Eingrenzung (seit 2026-08-07). Keine fachliche Grenze, sondern
// eine gegen absurd grosse Koerper -- der Verein hat rund 20 Gruppen und 540
// Konten. Ueberzaehliges wird abgeschnitten, nicht abgelehnt: die Nachricht
// ginge dadurch nur an weniger Leute, nie an mehr.
const RUND_AUSWAHL_GRUPPEN_MAX = 50;
const RUND_AUSWAHL_PERSONEN_MAX = 600;

function leereRundDoc() { return { version: 1, eintraege: [] }; }

// Wer ueberhaupt in Frage kommt. Archivierte Konten sind draussen; Spieler nur
// im Kreis "alle".
//
// ⚠️ Der Absender ist bewusst NICHT ausgenommen -- anders als bei allen anderen
// Anlaessen. Dort weiss der Ausloeser ohnehin, was er getan hat; hier ist die
// eigene Nachricht auf dem eigenen Handy der einzige Zustellnachweis, den es
// gibt (der Versand laeuft in waitUntil und meldet nichts zurueck).
function rundEmpfaenger(usersDoc, kreis, auswahl) {
  const users = (usersDoc && usersDoc.users) || {};
  const filter = rundAuswahlFilter(usersDoc, auswahl);
  const out = [];
  for (const schluessel of Object.keys(users)) {
    const u = users[schluessel];
    if (!u || u.archiviert) continue;
    if (kreis !== "alle" && !istPersonal(u)) continue;
    const name = normalizeUsername(u.username || schluessel);
    if (!name) continue;
    // ⚠️ Die Eingrenzung wirkt NACH dem Kreis und kann nur verkleinern. Wer eine
    // Person auswaehlt, die der Kreis ausschliesst (Spielerkonto bei "ohne
    // Spielerkonten"), erreicht sie nicht -- dafuer ist der Kreis umzustellen.
    // Andersherum waere die Personenliste ein Weg, die Kreis-Grenze zu umgehen.
    if (filter && !filter[name]) continue;
    out.push(name);
  }
  return out;
}

// Erlaubte Namen als Menge -- oder `null`, wenn gar nicht eingegrenzt wurde.
//
// ⚠️ Der Unterschied zwischen `null` und einer LEEREN Menge ist der ganze Punkt
// dieser Funktion: nichts gewaehlt heisst "der ganze Kreis" (unveraendertes
// Verhalten, ein alter Client schickt keine Auswahl mit), eine Auswahl, die
// niemanden trifft, heisst NIEMAND. Faellt das zusammen, geht eine Nachricht,
// die an drei Leute gedacht war, an die ganze Belegschaft -- und zurueckholen
// laesst sie sich nicht. Deshalb hier fail-closed, anders als beim optionalen
// Verteiler in PUSH_VORGANG_APPS (dort ist ein ausbleibendes Push der Schaden,
// hier ein zu weit gegangenes).
function rundAuswahlFilter(usersDoc, auswahl) {
  const gruppen = (auswahl && Array.isArray(auswahl.gruppen)) ? auswahl.gruppen : [];
  const personen = (auswahl && Array.isArray(auswahl.personen)) ? auswahl.personen : [];
  if (!gruppen.length && !personen.length) return null;

  const erlaubt = Object.create(null);
  const alleGruppen = (usersDoc && usersDoc.groups) || {};
  gruppen.slice(0, RUND_AUSWAHL_GRUPPEN_MAX).forEach((gid) => {
    // getOwn statt direktem Zugriff: eine Gruppen-Id "__proto__" traefe sonst
    // den Prototyp und lieferte ein Objekt ohne memberUsernames.
    const g = getOwn(alleGruppen, String(gid || ""));
    if (!g || !Array.isArray(g.memberUsernames)) return;
    g.memberUsernames.forEach((m) => {
      const n = normalizeUsername(String(m || ""));
      if (n) erlaubt[n] = true;
    });
  });
  personen.slice(0, RUND_AUSWAHL_PERSONEN_MAX).forEach((p) => {
    const n = normalizeUsername(String(p || ""));
    if (n) erlaubt[n] = true;
  });
  return erlaubt;
}

// Gruppen und Konten fuer die Auswahl im Panel. ⚠️ Kostet KEINEN zusaetzlichen
// Nextcloud-Read: `usersDoc` steckt ohnehin in der Sitzung, und `abosDoc` liest
// der Verlauf-Handler bereits fuer die Reichweite.
//
// `erreichbar` je Konto ist der Grund, warum der Client die Reichweite einer
// Auswahl selbst ausrechnen kann, ohne fuer jeden Haken den Worker zu fragen --
// "erreicht 4 von 7 Ausgewaehlten" steht damit sofort da.
function rundAuswahlDaten(abosDoc, usersDoc) {
  const users = (usersDoc && usersDoc.users) || {};
  const personen = [];
  for (const schluessel of Object.keys(users)) {
    const u = users[schluessel];
    if (!u || u.archiviert) continue;
    const name = normalizeUsername(u.username || schluessel);
    if (!name) continue;
    // Die GERAETEZAHL, nicht bloss ein Ja/Nein: nur damit kann der Client die
    // Reichweite einer Auswahl exakt ausrechnen ("erreicht 4 Personen auf 6
    // Geraeten") statt sie zu schaetzen -- und ohne fuer jeden gesetzten Haken
    // den Worker zu fragen. Schalter aus zaehlt wie kein Geraet, genau wie in
    // rundErreichbar.
    personen.push({
      username: name,
      name: aufgabenAnzeigeName(usersDoc, name),
      art: userArt(u),
      geraete: pushAnlaesseFuer(abosDoc, name).mitteilung ? pushAbosFuer(abosDoc, name).length : 0
    });
  }
  personen.sort((a, b) => a.name.localeCompare(b.name, "de"));

  const gruppen = Object.values((usersDoc && usersDoc.groups) || {}).map((g) => ({
    id: g.id,
    name: g.name,
    mitglieder: (Array.isArray(g.memberUsernames) ? g.memberUsernames : [])
      .map((m) => normalizeUsername(String(m || "")))
      .filter((m) => !!m)
  }));
  gruppen.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "de"));

  return { gruppen, personen };
}

// Zaehlt, wen es WIRKLICH erreicht: Gerät angemeldet und Schalter an. Die
// uebrigen Push-Aktionen melden nur die in Frage Kommenden zurueck -- hier
// waere das irrefuehrend, weil vor dem Absenden gerade die echte Reichweite die
// Frage ist ("gehen jetzt 60 Handys an oder 3?").
function rundErreichbar(doc, empfaenger) {
  let personen = 0;
  let geraete = 0;
  const wer = [];
  const ohne = [];
  // ⚠️ Object.create(null), nicht {}: ein Konto namens "__proto__" traefe sonst
  // den Prototyp, gaelte als "schon gesehen" und fiele aus BEIDEN Listen --
  // spurlos, was bei einer angezeigten Namensliste schlimmer ist als bei einer
  // blossen Zahl. Gleiche Stelle in pushSenden mitgezogen.
  const gesehen = Object.create(null);
  for (const roh of empfaenger) {
    const u = normalizeUsername(String(roh || ""));
    if (!u || gesehen[u]) continue;
    gesehen[u] = true;
    // Schalter aus und kein Geraet angemeldet fallen bewusst in DIESELBE Liste:
    // fuer den Absender ist beides derselbe Fall -- diese Person erreicht er
    // nicht. Die Unterscheidung waere zudem eine Aussage darueber, wer die
    // Benachrichtigungen absichtlich abgestellt hat, und das geht niemanden an.
    const abos = pushAnlaesseFuer(doc, u).mitteilung ? pushAbosFuer(doc, u) : [];
    if (!abos.length) { ohne.push(u); continue; }
    personen++;
    geraete += abos.length;
    wer.push(u);
  }
  return { personen, geraete, wer, ohne };
}

// Dieselben Zahlen plus Klarnamen und Nenner -- fuer das Panel, nicht fuer den
// Versand. ⚠️ Kostet KEINEN zusaetzlichen Nextcloud-Read: `usersDoc` steckt
// ohnehin in der Sitzung, aufgeloest wird ueber denselben Helfer wie bei den
// Neuigkeiten-Reaktionen (und nicht ueber mitgespeicherte Namen, die nach einer
// Umbenennung veraltet waeren).
//
// Die Liste `ohne` ist der eigentliche Nutzen: eine blosse Zahl sagt nur, DASS
// jemand fehlt, nicht wer angestupst werden muss.
function rundReichweiteMitNamen(abosDoc, usersDoc, kreis) {
  const empfaenger = rundEmpfaenger(usersDoc, kreis);
  const z = rundErreichbar(abosDoc, empfaenger);
  const namen = (liste) => liste
    .map((u) => aufgabenAnzeigeName(usersDoc, u))
    .sort((a, b) => a.localeCompare(b, "de"));
  return {
    personen: z.personen,
    geraete: z.geraete,
    infrage: empfaenger.length,
    wer: namen(z.wer),
    ohne: namen(z.ohne)
  };
}

async function handlePushRundnachricht(request, body, env, authHeader, corsHeaders, execCtx) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const titel = String((body && body.titel) || "").trim().slice(0, PUSH_RUND_TITEL_MAX);
  const text = String((body && body.text) || "").trim().slice(0, PUSH_RUND_TEXT_MAX);
  if (!titel) return json({ error: "Titel fehlt" }, 400, corsHeaders);
  if (!text) return json({ error: "Text fehlt" }, 400, corsHeaders);

  const kreis = (body && body.kreis === "alle") ? "alle" : "personal";
  const auswahl = {
    gruppen: (body && Array.isArray(body.gruppen)) ? body.gruppen.map((g) => String(g || "")) : [],
    personen: (body && Array.isArray(body.personen)) ? body.personen.map((p) => String(p || "")) : []
  };
  const eingegrenzt = !!(auswahl.gruppen.length || auswahl.personen.length);

  const abosDoc = await readJson(PUSH_ABOS_URL, authHeader, leerePushDoc());
  const empfaenger = rundEmpfaenger(session.usersDoc, kreis, auswahl);

  // ⚠️ Eine Eingrenzung, die niemanden trifft, ist ein Fehler und kein Versand
  // an null Leute: sonst meldet das Panel "verschickt" und der Absender wartet
  // auf eine Reaktion, die nie kommt (Gruppe leer, Person inzwischen
  // archiviert, Spielerkonto im Kreis "ohne Spielerkonten"). Ohne Eingrenzung
  // bleibt der Weg unveraendert -- dort ist eine leere Liste ein Zustand des
  // Vereins, kein Bedienfehler.
  if (eingegrenzt && !empfaenger.length) {
    return json({ error: "Diese Auswahl trifft niemanden — Gruppe leer, oder die Gewählten passen nicht zum Empfängerkreis." }, 400, corsHeaders);
  }

  const reichweite = rundErreichbar(abosDoc, empfaenger);

  // ⚠️ Doppelklick-Sperre, nicht Missbrauchsschutz. Der Versand laeuft in
  // waitUntil und antwortet sofort -- ein zweiter Klick auf einen langsam
  // reagierenden Knopf schickt sonst dieselbe Nachricht ein zweites Mal an
  // dieselben Geraete, und zurueckholen laesst sich eine Push-Nachricht nicht.
  // Nur bei GLEICHEM Text: eine zweite, andere Meldung darf sofort raus.
  const rundDoc = await readJson(PUSH_RUNDNACHRICHTEN_URL, authHeader, leereRundDoc());
  const bisher = Array.isArray(rundDoc.eintraege) ? rundDoc.eintraege : [];
  const letzte = bisher[0];
  if (letzte && letzte.titel === titel && letzte.text === text) {
    const her = Date.now() - Date.parse(String(letzte.am || "")) ;
    if (her >= 0 && her < PUSH_RUND_SPERRE_MS) {
      return json({ error: "Diese Nachricht ist gerade eben schon rausgegangen." }, 409, corsHeaders);
    }
  }

  pushSenden(env, authHeader, execCtx, empfaenger, "mitteilung", text, { titel });

  // Protokoll. Ein Versand an alle Handys des Vereins soll nachlesbar sein --
  // wer, wann, was. Fehler beim Schreiben duerfen den Versand nicht kippen: er
  // ist zu diesem Zeitpunkt bereits beauftragt (gleiche Linie wie pushSenden).
  // ⚠️ Im Protokoll stehen Ids und Nutzernamen, KEINE Klarnamen -- sonst zeigt
  // ein alter Eintrag nach einer Umbenennung weiter den frueheren Namen (gleiche
  // Linie wie aufgabenAnzeigeName). Aufgeloest wird beim Anzeigen.
  const eintrag = {
    id: crypto.randomUUID().replace(/-/g, ""),
    titel, text, kreis,
    von: normalizeUsername(session.username),
    am: new Date().toISOString(),
    personen: reichweite.personen,
    geraete: reichweite.geraete
  };
  // ⚠️ `anGruppen`/`anPersonen`, NICHT `gruppen`/`personen`: `eintrag.personen`
  // ist seit dem ersten Tag die ZAHL der erreichten Personen und wird im
  // Verlauf als solche angezeigt. Gleicher Name, zwei Bedeutungen -- die Zeile
  // "15 Personen, 15 Geraete" haette dann ein Array gerechnet.
  if (eingegrenzt) {
    eintrag.anGruppen = auswahl.gruppen.slice(0, RUND_AUSWAHL_GRUPPEN_MAX);
    eintrag.anPersonen = auswahl.personen
      .slice(0, RUND_AUSWAHL_PERSONEN_MAX)
      .map((p) => normalizeUsername(p))
      .filter((p) => !!p);
  }
  try {
    rundDoc.eintraege = [eintrag].concat(bisher).slice(0, PUSH_RUND_VERLAUF_MAX);
    rundDoc.version = 1;
    await writeJson(PUSH_RUNDNACHRICHTEN_URL, authHeader, rundDoc);
  } catch (e) {
    console.error("Rundnachricht-Protokoll fehlgeschlagen: " + (e && e.message ? e.message : e));
  }

  return json({
    ok: true,
    infrage: empfaenger.length,
    personen: reichweite.personen,
    geraete: reichweite.geraete,
    eintrag
  }, 200, corsHeaders);
}

// Verlauf UND Reichweite in einer Aktion. Beides braucht dieselben zwei Reads,
// und beides will das Panel im selben Moment -- zwei Aktionen waeren vier Reads
// fuer eine Ansicht.
async function handlePushRundnachrichtVerlauf(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const abosDoc = await readJson(PUSH_ABOS_URL, authHeader, leerePushDoc());
  const rundDoc = await readJson(PUSH_RUNDNACHRICHTEN_URL, authHeader, leereRundDoc());
  const eintraege = Array.isArray(rundDoc.eintraege) ? rundDoc.eintraege : [];

  // `auswahl` ist additiv: ein aelterer Client ignoriert das Feld, ein neuer
  // Client zeigt den Eingrenzen-Block nur, wenn es da ist -- sonst boete die
  // Oberflaeche eine Auswahl an, die ein alter Worker stillschweigend verwirft
  // und die Nachricht ginge an alle.
  return json({
    ok: true,
    verlauf: eintraege.slice(0, PUSH_RUND_VERLAUF_MAX),
    erreichbar: {
      personal: rundReichweiteMitNamen(abosDoc, session.usersDoc, "personal"),
      alle: rundReichweiteMitNamen(abosDoc, session.usersDoc, "alle")
    },
    auswahl: rundAuswahlDaten(abosDoc, session.usersDoc),
    grenzen: { titel: PUSH_RUND_TITEL_MAX, text: PUSH_RUND_TEXT_MAX }
  }, 200, corsHeaders);
}

// ---------- Versand ----------

// Erteilt den Versandauftrag an den Worker "push". Fehler werden geschluckt,
// aber protokolliert: die eigentliche Handlung (Aufgabe anlegen, Termin
// speichern, Dokument zuweisen) ist zu diesem Zeitpunkt bereits passiert --
// wie bei beleg-eingang-notify, anders als bei raumnutzung-mail-antrag, wo der
// Versand DIE Handlung ist.
//
// ⚠️ Diese Funktion wirft nie. Wer sie ruft, muss nichts abfangen.
//
// `optionen.titel` ueberschreibt die fette Zeile aus PUSH_ANLAESSE. Gebraucht
// wird das an genau EINER Stelle -- der von Hand verschickten Rundnachricht, wo
// die Ueberschrift Teil der Nachricht ist. ⚠️ Kein weiterer Aufrufer sollte das
// benutzen: der feste Titel je Anlass ist der Grund, warum eine Nachricht auf
// dem Sperrbildschirm erkennbar bleibt, ohne Namen zu verraten.
function pushSenden(env, authHeader, ctx, empfaenger, anlass, text, optionen) {
  // Nicht konfiguriert = still aus. So laesst sich landingpage deployen, bevor
  // der push-Worker existiert; die Reihenfolge im Entwurf sieht es andersherum
  // vor, aber ein Fehlschlag darf keine Zuweisung mitreissen.
  if (!env.PUSH || !env.PUSH_SHARED_SECRET) return;
  if (!Array.isArray(empfaenger) || !empfaenger.length) return;
  const info = pushAnlassInfo(anlass);
  if (!info) return;

  const arbeit = (async () => {
    try {
      const doc = await readJson(PUSH_ABOS_URL, authHeader, leerePushDoc());

      const ziele = [];
      // Object.create(null) aus demselben Grund wie in rundErreichbar: ein
      // Konto "__proto__" bekaeme sonst nie eine Nachricht.
      const gesehen = Object.create(null);
      for (const roh of empfaenger) {
        const u = normalizeUsername(String(roh || ""));
        if (!u || gesehen[u]) continue;
        gesehen[u] = true;
        if (!pushAnlaesseFuer(doc, u)[anlass]) continue; // Schalter aus
        for (const abo of pushAbosFuer(doc, u)) {
          if (abo && abo.endpoint) ziele.push(abo);
        }
      }
      if (!ziele.length) return;

      const nachricht = {
        // Ein leerer Titel-Wunsch faellt auf den Anlass zurueck, statt eine
        // Nachricht ohne Ueberschrift zu erzeugen.
        titel: String((optionen && optionen.titel) || "").trim() || info.titel,
        text: String(text || ""),
        ziel: info.ziel
      };

      const tot = [];
      for (let i = 0; i < ziele.length; i += PUSH_HAEPPCHEN) {
        const haeppchen = ziele.slice(i, i + PUSH_HAEPPCHEN);
        // Die Adresse ist bei einem Service Binding bedeutungslos, muss aber
        // eine gueltige URL sein.
        const res = await env.PUSH.fetch("https://push.intern/senden", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: env.PUSH_SHARED_SECRET,
            nachricht,
            abos: haeppchen.map((a) => ({ id: a.id, endpoint: a.endpoint, p256dh: a.p256dh, auth: a.auth }))
          })
        });
        if (!res.ok) {
          console.error("Push-Worker antwortete " + res.status);
          continue;
        }
        const daten = await res.json().catch(() => null);
        if (daten && Array.isArray(daten.tot)) {
          for (const id of daten.tot) tot.push(String(id));
        }
      }

      if (tot.length) await pushToteAbosEntfernen(authHeader, tot);
    } catch (e) {
      console.error("Push-Versand fehlgeschlagen: " + (e && e.message ? e.message : e));
    }
  })();

  // ctx fehlt nur, wenn diese Funktion aus einem Pfad ohne Request-Kontext
  // gerufen wird -- dann lieber warten als den Versand verlieren.
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(arbeit);
  else return arbeit;
}

// Entfernt Abos, die der Push-Dienst mit 404/410 abgelehnt hat (App geloescht,
// Geraet zurueckgesetzt). Ueber alle Nutzer, weil die Ids nutzeruebergreifend
// eindeutig sind und ein Versand mehrere Empfaenger betrifft.
async function pushToteAbosEntfernen(authHeader, ids) {
  const weg = {};
  for (const id of ids) weg[id] = true;
  try {
    await pushAbosMutieren(authHeader, (doc) => {
      let geaendert = false;
      for (const username of Object.keys(doc.abos)) {
        const liste = pushAbosFuer(doc, username);
        const rest = liste.filter((a) => !weg[a.id]);
        if (rest.length !== liste.length) { doc.abos[username] = rest; geaendert = true; }
      }
      return geaendert ? undefined : false;
    });
  } catch (e) {
    console.error("Aufraeumen toter Push-Abos fehlgeschlagen: " + (e && e.message ? e.message : e));
  }
}

// =============================================================================
// Aktivitaetspunkte (seit 2026-08-04)
//
// Bewusst als geschlossener Block am Dateiende, wie die Push-Nachrichten darueber:
// die Erfassung haengt an genau EINER Stelle in fetch() und laesst sich am Stueck
// wieder herausloesen.
//
// Tragender Gedanke: gespeichert werden EREIGNISSE, nicht Punkte. Die Punktzahl
// ist eine Auswertung obendrauf (punkteAusEreignissen), deren Regeln jederzeit
// geaendert und ueber den vorhandenen Rohbestand neu gerechnet werden koennen.
// Ein blosser Zaehler waere nach der ersten Regelaenderung nicht mehr nachrechenbar
// -- und genau das ist der Zweck: erst sammeln, spaeter entscheiden.
//
// Entscheidungen mit Michel am 2026-08-04:
//   - nur art === "personal". Spielerkonten werden gar nicht erst erfasst
//     (Minderjaehrige, und sie erreichen ohnehin nur den Kadermanager)
//   - jeder sieht nur den EIGENEN Stand, keine Rangliste, kein Vergleich
//   - Erfassung serverseitig, damit keines der 30 App-Repos angefasst werden muss
//   - eine Datei je Nutzer und Monat -> Schreibkonflikte zwischen verschiedenen
//     Nutzern sind strukturell unmoeglich, jeder schreibt nur in seine eigene
//   - Lebenszeit-Konto ohne Verfall
//   - Rohereignisse 13 Monate, danach zu Monatssummen verdichtet
//   - Opt-out im eigenen Konto, loescht den eigenen Bestand mit
//
// Blinde Flecken, bewusst hingenommen: was nicht ueber diesen Worker laeuft, wird
// nicht gezaehlt -- Vereinsverwaltung (eigenes D1), Spiele/Agelan (eigene Firebase).
// =============================================================================

const AKTIVITAET_DIR = DOKUMENTE_URL.slice(0, DOKUMENTE_URL.lastIndexOf("/")) + "/Aktivitaet";

// Regelwerk. Die Version wandert in saldo.json mit, damit ein Saldo, der noch nach
// alten Regeln gerechnet wurde, beim naechsten Zugriff erkennbar ist.
const PUNKTE_REGELN_VERSION = 6;
const PUNKTE_FENSTER_MS = 5 * 60 * 1000;
const PUNKTE_PRO_FENSTER = 1;
const PUNKTE_PRO_APP_START = 2;
const PUNKTE_PRO_TAT = 3;
// Von 60 auf 100 angehoben (Michel-Vorgabe vom 2026-08-05, Regelversion 6). Der
// Deckel bremst nur das Wiederholbare -- Fenster, Werkzeug-Start, Katalog-Taten
// und Tagewerk; Zugaben und Einmal-Boni stehen ohnehin ausserhalb. Bei 60 lief
// ein Hauptamtlicher an einem vollen Tag hinein, ein Ehrenamtlicher nie: der
// Deckel wirkte damit nur auf eine Gruppe und nahm ihr genau die Arbeit, die er
// wuerdigen soll.
const PUNKTE_TAGESDECKEL = 100;
const PUNKTE_ROHDATEN_MONATE = 13;
const PUNKTE_PROTOKOLL_TAGE = 30;

// Boni (seit Regelversion 3, Michel-Vorgabe vom 2026-08-04).
//
// ⚠️ Alle drei stehen AUSSERHALB des Tagesdeckels. Sie sind durch ihre eigene
// Haeufigkeit begrenzt (einmal je Tag bzw. einmal je 90 Tage) und damit nicht
// hochklickbar -- der Deckel bremst nur, was sich wiederholen laesst. Stuenden
// sie innerhalb, schluckte er an einem fleissigen Tag ausgerechnet die 20 Punkte
// fuers Passwort, und der Nutzer saehe fuer seinen Wechsel gar nichts.
const PUNKTE_BONUS_TAG = 10;
const PUNKTE_BONUS_PASSWORT = 20;
const PUNKTE_BONUS_RUECKKEHR = 10;
// Sperrfrist fuer den Passwort-Bonus. ⚠️ Ohne sie waere fuenfmal hintereinander
// wechseln die billigste Punktequelle des ganzen Systems.
const PUNKTE_PW_BONUS_TAGE = 90;

// Auf einen Termin antworten (Regelversion 4, Michel-Vorgabe). Hoeher als eine
// gewoehnliche Tat, weil eine Rueckmeldung anderen Planungsarbeit abnimmt: der
// Trainer muss nicht hinterhertelefonieren.
const PUNKTE_TAT_TERMIN_ANTWORT = 5;

// Wochen-Boni (Regelversion 5, Michel-Vorgabe vom 2026-08-04).
//
// ⚠️ Bewusst WOCHEN, nicht Tage. Eine Tagesserie ist im Ehrenamt unrealistisch und
// bestrafte jeden Urlaub -- sie wuerde genau die Leute treffen, die man halten will.
const PUNKTE_BONUS_SERIE = 10;       // je Woche, die an eine aktive Vorwoche anschliesst
const PUNKTE_BONUS_VIELSEITIG = 10;  // je Woche mit mindestens ... verschiedenen Werkzeugen
const PUNKTE_VIELSEITIG_APPS = 3;
// Wie viele Wochen der Saldo mitfuehrt. Begrenzt, damit die Datei nicht unbegrenzt
// waechst; laenger als das Aufbewahrungsfenster der Rohdaten waere ohnehin sinnlos.
const PUNKTE_WOCHEN_HISTORIE = 60;

// Einmalige Einrichtungs-Boni (Regelversion 5). Anders als der Passwort-Bonus
// EINMAL ueberhaupt, nicht alle 90 Tage -- ein Foto hinterlegt man einmal.
const PUNKTE_BONUS_FOTO = 15;
const PUNKTE_BONUS_PUSH = 15;
// Vertrag, Kodex, Jugendschutz und der Rest der Pflichten vollstaendig. Der hoechste
// Einzelwert des Systems, und der einzige, der auf eine echte Vereinspflicht einzahlt
// statt auf Nutzung.
const PUNKTE_BONUS_PFLICHTEN = 40;

// Bonus-Ereignisse. Eigene Aktionsnamen, weil sie NICHT aus einer Gateway-Aktion
// entstehen, sondern aus einer Bedingung, die nur der jeweilige Handler kennt
// (der VORIGE lastLoginAt, der vorige Bonus-Zeitpunkt).
const PUNKTE_BONI = new Map([
  ["bonus-passwortwechsel", PUNKTE_BONUS_PASSWORT],
  ["bonus-rueckkehr", PUNKTE_BONUS_RUECKKEHR],
  ["bonus-foto", PUNKTE_BONUS_FOTO],
  ["bonus-push", PUNKTE_BONUS_PUSH],
  ["bonus-pflichten", PUNKTE_BONUS_PFLICHTEN]
]);
// Obergrenze fuer die Admin-Auswertung. Ein Worker darf nur begrenzt viele
// Unteranfragen stellen -- eine Auswertung ueber alle Konten in EINEM Request
// waere genau der Rundlauf, an dem der Worker stirbt. Der Client fragt in Bloecken.
const PUNKTE_AUSWERTUNG_MAX_NUTZER = 20;

// Aktionen, die NIE zaehlen.
//
// ⚠️ Diese Liste ist der Kern der Zusage "keine Punkte fuers blosse Eingeloggtsein".
// `me` laeuft bei jedem Seitenaufruf UND bei jedem visibilitychange -- wer nur
// zwischen zwei offenen Tabs hin und her wechselt, loeste sonst in jedem neuen
// 5-Minuten-Fenster einen Punkt aus, ohne irgendetwas zu tun. Dasselbe gilt fuer
// die Status-Abfragen, die beim Seitenaufbau automatisch mitlaufen, und fuer die
// Datei-GETs, die eine Liste beim Rendern von sich aus nachlaedt (Nutzerfotos!).
// Wer hier etwas HERAUSNIMMT, baut genau die Anwesenheitspunkte wieder ein, die
// ausdruecklich nicht gewollt sind.
const PUNKTE_IGNORIERT = new Set([
  // Anmeldung und Sitzung
  "bootstrap-admin", "login", "set-password", "change-password", "me", "set-view-as",
  "check-edit-permission", "verify-action-password",
  // Spieler-Registrierung (laeuft ohne Sitzung; Spieler zaehlen ohnehin nicht mit)
  "km-reg-oeffnen", "km-reg-info", "km-reg-abschliessen",
  // Status-Abfragen, die beim Seitenaufbau von selbst kommen
  "push-status", "my-trainerdaten-status", "my-trainercheckliste-status",
  "my-testspielplaner-status", "my-news-reactions", "list-birthdays-today",
  "list-trainer-profiles", "list-tool-editors", "trainerdaten-list-groups",
  // Laeuft beim Oeffnen des Feedback-Tabs von selbst, ist also eine Anzeige und
  // keine Handlung -- das Einreichen (submit-feedback) zaehlt ohnehin fuer sich.
  "meine-feedbacks",
  // Gleiche Lage beim Ideen-Tab: das Laden ist eine Anzeige. ⚠️ Der Daumen bleibt
  // ebenfalls draussen, obwohl er eine Handlung ist -- er schaltet um, ein Klick
  // hin und her waere sonst eine beliebig oft nachfuellbare Punktequelle (genau
  // die Begruendung, aus der toggle-news-reaction nicht im Katalog steht).
  "ideen-load", "idee-daumen",
  // Die eigene Ansicht der Startseite. Das Lesen laeuft bei jedem Seitenaufbau von
  // selbst. ⚠️ Auch das SPEICHERN bleibt draussen, obwohl es eine Handlung ist: es ist
  // eine reine Anzeige-Vorliebe ohne Vereinsarbeit dahinter, und Hin- und Herschalten
  // zwischen Kacheln und Liste waere sonst der billigste Weg zu Punkten.
  "meine-ansicht", "meine-ansicht-speichern",
  // Merkt nur, dass der Downloadbereich offen war -- ein Nebeneffekt des
  // Hinschauens, keine Handlung. Ein Punkt dafuer waere durch blosses Auf- und
  // Zuklappen des Konto-Tabs beliebig nachfuellbar. Dasselbe gilt fuer die
  // beiden Leseaktionen der Unterlagen; das Verteilen zaehlt dagegen mit.
  "downloads-gesehen", "unterlagen-meine", "unterlagen-datei", "unterlagen-alle",
  // Laeuft beim Oeffnen des Info-Tabs im Vereinskalender von selbst. Das Erzeugen
  // und Entwerten des Abo-Links sind Handlungen und zaehlen weiter mit.
  "vereinskalender-abo-status",
  // Die Mannschaftsliste holt sich JEDE App der Flotte beim Seitenstart -- sie
  // fuellt nur Auswahlfelder. Zaehlte sie mit, gaebe das blosse Oeffnen
  // irgendeiner App zusaetzlich Punkte fuer die Uebersicht, und die
  // Nutzungsstatistik wiese ein Werkzeug als benutzt aus, das niemand anfasste
  // (dieselbe Falle wie bei den Startseiten-Widgets). Der Vorschlag ist eine
  // reine Leseauswertung; das SPEICHERN der Liste zaehlt weiter mit.
  "mannschaften-load", "mannschaften-vorschlag",
  // Dateien, die eine Liste beim Rendern selbsttaetig nachlaedt
  "nutzerfoto-get", "nutzerfoto-versionen", "dav-file-get", "dav-restricted-get",
  "dokument-datei-get", "news-datei-get", "vereinsaufgabe-datei-get",
  "zertifizierung-datei-get",
  "fahrtenbuch-beleg-file-get",
  // Die Sammel-Lader der Startseiten-Fenster "Meine ToDos" und "Unterschriften".
  // ⚠️ Beide laufen beim Seitenaufbau von selbst und werden nach jeder Aenderung
  // erneut aufgerufen -- sie sind eine Auffrischung, keine Handlung. Die echten
  // Vorgaenge dahinter (aufgabe-speichern, dokument-unterschreiben, ...) zaehlen
  // ohnehin je fuer sich. Beide Aktionen ruft NUR dieses Repo auf (per Grep ueber
  // E:\ geprueft), es haengt also keine andere App daran.
  "aufgaben-load", "dokumente-load",
  // Die Punkte-Aktionen selbst -- sonst zaehlt das Nachsehen des eigenen Standes
  // als Aktivitaet, und wer oft genug nachschaut, verdient daran.
  "meine-punkte", "punkte-opt-out", "aktivitaet-auswertung",
  // Laeuft beim Aufklappen des Rundnachricht-Panels von selbst und liefert nur
  // Verlauf und Reichweite. Das Absenden (push-rundnachricht) ist die Handlung
  // und zaehlt weiter mit.
  "push-rundnachricht-verlauf",
  // Der login-lose Blick auf einen Ablaufplan. Laeuft ohne Sitzung und laedt sich
  // auf der offenen Seite jede Minute selbst nach -- es gibt niemanden, dem man
  // das gutschreiben koennte, und es ist keine Handlung.
  "ablaufplan-oeffentlich"
]);

// Katalog echter Abschluesse -> volle Punkte je Vorkommen. Alles, was hier NICHT
// steht, faellt auf die grobe Regel zurueck (ein Fensterpunkt je App und
// 5-Minuten-Fenster). Der Katalog hebt also nur an, er ist keine Schranke: eine
// neue App, die hier vergessen wird, geht nicht leer aus.
//
// ⚠️ `dav-save` steht bewusst NICHT drin. 15 Apps der Flotte speichern beim Tippen
// automatisch (raumnutzung an 15 Stellen, Trainerdaten an 13) -- ein einziger
// ausgefuellter Antrag loest ein Dutzend dav-save aus. Als Tat gezaehlt gewaenne,
// wer am laengsten in einem Formular herumtippt.
//
// ⚠️ `toggle-news-reaction` fehlt aus demselben Grund: die Aktion schaltet um, ein
// Klick hin und her waere eine beliebig oft nachfuellbare Punktequelle.
//
// ⚠️ Loeschende Aktionen stehen bewusst nicht drin. Sie sind Arbeit und bekommen
// ihren Fensterpunkt, aber es soll sich nicht lohnen, etwas wegzuraeumen.
const PUNKTE_TATEN = new Map([
  ["aufgabe-speichern", PUNKTE_PRO_TAT],
  ["aufgabe-zuweisen", PUNKTE_PRO_TAT],
  ["aufgabe-zurueckziehen", PUNKTE_PRO_TAT],
  ["dokument-anlegen", PUNKTE_PRO_TAT],
  ["dokument-unterschreiben", PUNKTE_PRO_TAT],
  ["dokument-ablehnen", PUNKTE_PRO_TAT],
  ["vereinsaufgabe-anlegen", PUNKTE_PRO_TAT],
  ["vereinsaufgabe-status", PUNKTE_PRO_TAT],
  ["vereinsaufgabe-zurueckziehen", PUNKTE_PRO_TAT],
  ["vereinsaufgabe-reaktivieren", PUNKTE_PRO_TAT],
  ["vereinsaufgabe-kommentar", PUNKTE_PRO_TAT],
  // Antwort auf eine Rueckmeldung -- dasselbe Muster wie ein Kommentar an einer
  // Vereinsaufgabe: eine echte Rueckmeldung an eine Person, nicht wiederholbar.
  ["feedback-antwort", PUNKTE_PRO_TAT],
  // Eine Idee aufschreiben ist eine echte Handlung, das Abarbeiten (Status
  // setzen, antworten) ebenso -- gleiche Linie wie feedback-antwort.
  ["idee-speichern", PUNKTE_PRO_TAT],
  ["idee-verwalten", PUNKTE_PRO_TAT],
  ["vereinsaufgaben-uebergabe", PUNKTE_PRO_TAT],
  ["vereinsaufgaben-ressort-speichern", PUNKTE_PRO_TAT],
  // Klubzertifizierung: ein Kriterium auf "erfuellt" zu setzen und eine Aufgabe
  // daraus abzuleiten sind echte Vereinsarbeit. ⚠️ Das ABHAKEN einer
  // Zertifizierungs-Aufgabe steht bewusst NICHT hier -- es ist ein Umschalter und
  // waere damit beliebig nachfuellbar, gleiche Ueberlegung wie bei
  // toggle-news-reaction. Notiz und Loeschen ebenso nicht.
  ["zertifizierung-status", PUNKTE_PRO_TAT],
  ["zertifizierung-aufgabe-anlegen", PUNKTE_PRO_TAT],
  // Zu-/Absage zu einem Terminvorschlag im Vereinskalender (die Oberflaeche dort
  // nennt es woertlich "Zusagen"/"Absagen"). Seit Regelversion 4 hoeher bewertet.
  ["vereinskalender-vote", PUNKTE_TAT_TERMIN_ANTWORT],
  // Zu-/Absage zu Training oder Spiel im Kadermanager. ⚠️ Der Aktionsname traegt
  // die Unterart, weil `km-self` mehrere Selbstbedienungen bedient (claim,
  // umfrage, aufgabe, abwesenheit) -- ein pauschaler Wert auf `km-self` wuerde
  // die alle mitbezahlen. Siehe punkteAktionMitUnterart.
  // ⚠️ Zahlt in der Praxis fast nie aus: diesen Weg gehen ganz ueberwiegend
  // SPIELER, und Spielerkonten werden gar nicht erfasst (Michel-Entscheidung vom
  // 2026-08-04). Es greift nur bei Personal-Konten mit eigenem Kaderplatz.
  ["km-self:teilnahme", PUNKTE_TAT_TERMIN_ANTWORT],
  ["vereinskalender-termin-push", PUNKTE_PRO_TAT],
  ["raumnutzung-mail-antrag", PUNKTE_PRO_TAT],
  ["fahrtenbuch-extern-submit", PUNKTE_PRO_TAT],
  ["fotoauftrag-ordner-anlegen", PUNKTE_PRO_TAT],
  ["fotoauftrag-spielbericht-hochladen", PUNKTE_PRO_TAT],
  ["beleg-eingang-notify", PUNKTE_PRO_TAT],
  ["submit-feedback", PUNKTE_PRO_TAT],
  ["save-news", PUNKTE_PRO_TAT],
  ["archive-trainer", PUNKTE_PRO_TAT],
  ["reactivate-trainer", PUNKTE_PRO_TAT]
]);

// Welcher App ein Ereignis zugeschlagen wird. dav-load/dav-save tragen die App im
// Body; alles andere wird ueber das Praefix der Aktion zugeordnet. Reihenfolge
// egal, die Praefixe ueberschneiden sich nicht ueber App-Grenzen hinweg.
const PUNKTE_APP_PRAEFIXE = [
  ["vereinsaufgabe", "vereinsaufgaben"],
  ["raumnutzung", "raumnutzung"],
  ["fahrtenbuch", "fahrtenbuch"],
  ["fotoauftrag", "fotoauftraege"],
  ["vereinskalender", "vereinskalender"],
  ["livekit", "besprechung"],
  ["km-", "kadermanager"],
  ["dokument", "personalakte"],
  ["personalakte", "personalakte"],
  ["archive-trainer", "personalakte"],
  ["reactivate-trainer", "personalakte"],
  ["materialcontainer", "materialliste"],
  ["get-materialcontainer", "materialliste"],
  ["set-materialcontainer", "materialliste"],
  ["beleg-eingang", "budget"],
  ["schulsport", "schulsport"],
  ["spieltagscrew", "spieltagscrew"],
  // Der Ablaufplan spricht sonst nur dav-load/dav-save und traegt die App im Body.
  // Der Eintrag deckt kuenftige eigene Aktionen ab; die einzige heutige
  // (ablaufplan-oeffentlich) steht in PUNKTE_IGNORIERT und laeuft ohne Sitzung.
  ["ablaufplan", "ablaufplan"],
  // Die Kontakte-App hat genau EINE Aktion und speichert nichts Eigenes (kein
  // DAV_APPS-Eintrag). Ohne diesen Eintrag liefe ihre Nutzung unter keiner App und
  // taeuchte in der Admin-Auswertung als "von niemandem benutzt" auf.
  ["kontakte", "kontakte"],
  // Die Klubzertifizierung ist ein Tab in "Vereinsaufgaben" und laeuft unter
  // deren Kachel. Ohne diesen Eintrag griffe das Praefix "vereinsaufgabe" nicht
  // (die Aktionen heissen "zertifizierung-*"), die Nutzung liefe unter keiner App
  // und die Admin-Auswertung wiese sie nirgends aus.
  ["zertifizierung", "vereinsaufgaben"],
  // Die Kleiderboerse spricht angemeldet nur dav-load/dav-save und traegt die App
  // im Body. Der Eintrag deckt kuenftige eigene Aktionen ab; die heutigen
  // kbo-extern-* laufen ohne Sitzung und erzeugen ohnehin keine Punkte.
  ["kbo-", "kleiderboerse"]
];

// Manche Endpunkte bedienen mehrere Vorgaenge auf einmal. Fuer die zaehlt nicht
// der Endpunkt, sondern die Unterart aus dem Body -- ein pauschaler Wert auf
// `km-self` bezahlte sonst auch das Beanspruchen eines Kaderplatzes, das Melden
// von Urlaub und das Uebernehmen einer Aufgabe mit.
//
// ⚠️ Enge Liste UND enger Zeichenvorrat: der Name landet als Schluessel in der
// Aktivitaetsdatei, dort soll ein Client nichts Beliebiges hineinschreiben koennen.
const PUNKTE_AKTIONEN_MIT_UNTERART = new Set(["km-self"]);

function punkteAktionMitUnterart(aktion, body) {
  if (!PUNKTE_AKTIONEN_MIT_UNTERART.has(aktion)) return aktion;
  const art = String((body && body.art) || "");
  if (!/^[a-z]{1,20}$/.test(art)) return aktion;
  return aktion + ":" + art;
}

function punkteFenster(ms) {
  return Math.floor(ms / PUNKTE_FENSTER_MS);
}

// Tag eines Fensters in Europe/Berlin. sv-SE liefert genau das ISO-Format
// YYYY-MM-DD -- gleiche Technik wie bei den Geburtstagen weiter oben. Ohne
// Zeitzonen-Bezug liefe der Tageswechsel (und damit der Tagesdeckel) um 02:00
// Ortszeit, nicht um Mitternacht.
function punkteTagKey(fenster) {
  return new Date(fenster * PUNKTE_FENSTER_MS).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

function punkteMonatKey(fenster) {
  return punkteTagKey(fenster).slice(0, 7);
}

// ISO-Kalenderwoche eines Tages ("2026-08-04" -> "2026-W32").
//
// ⚠️ Nach ISO 8601 gerechnet, nicht naiv: das Jahr der Woche bestimmt ihr
// DONNERSTAG, nicht ihr erster Tag. Der 1. Januar 2027 liegt dadurch in Woche
// 2026-W53, und der 31. Dezember 2029 in 2030-W01. Wer das nicht so rechnet,
// zerreisst die Serie ausgerechnet ueber Silvester -- also genau dann, wenn im
// Verein am wenigsten passiert und eine Serie am ehesten reisst.
function punkteWocheKey(tagIso) {
  const teile = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(tagIso || ""));
  if (!teile) return "";
  const d = new Date(Date.UTC(Number(teile[1]), Number(teile[2]) - 1, Number(teile[3])));
  // Auf den Donnerstag derselben Woche schieben (Montag = 0).
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const jahr = d.getUTCFullYear();
  // Der 4. Januar liegt per Definition immer in Woche 1.
  const jan4 = new Date(Date.UTC(jahr, 0, 4));
  jan4.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3);
  const nummer = 1 + Math.round((d.getTime() - jan4.getTime()) / (7 * 86400000));
  return jahr + "-W" + String(nummer).padStart(2, "0");
}

// Die Woche davor. Ueber das Montagsdatum gerechnet statt ueber die Nummer --
// "W01 minus eins" ist je nach Jahr W52 oder W53, das laesst sich nicht rechnen.
function punkteWocheDavor(wocheKey) {
  const teile = /^(\d{4})-W(\d{2})$/.exec(String(wocheKey || ""));
  if (!teile) return "";
  const jan4 = new Date(Date.UTC(Number(teile[1]), 0, 4));
  const montagKw1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000);
  const montag = new Date(montagKw1.getTime() + (Number(teile[2]) - 1) * 7 * 86400000);
  return punkteWocheKey(new Date(montag.getTime() - 7 * 86400000).toISOString().slice(0, 10));
}

// Welche Werkzeuge in welcher Woche benutzt wurden. Grundlage beider Wochen-Boni.
// Bonus-Ereignisse und ignorierte Aktionen bleiben draussen -- ein Passwortwechsel
// macht keine Woche aktiv und schon gar nicht vielseitig.
function punkteWochenAusEreignissen(ereignisse) {
  const wochen = {};
  (Array.isArray(ereignisse) ? ereignisse : []).forEach((e) => {
    if (!e || typeof e.w !== "number" || !Number.isFinite(e.w)) return;
    const aktion = String(e.a || "");
    if (PUNKTE_IGNORIERT.has(aktion) || PUNKTE_BONI.has(aktion)) return;
    const woche = punkteWocheKey(punkteTagKey(e.w));
    if (!woche) return;
    const app = String(e.app || "uebersicht");
    if (!wochen[woche]) wochen[woche] = [];
    if (!wochen[woche].includes(app)) wochen[woche].push(app);
  });
  return wochen;
}

// Serie und Vielseitigkeit ueber alle bekannten Wochen.
//
// Die Serie zaehlt NICHT die Laenge der laengsten Strecke, sondern jede Woche, die
// an eine aktive Vorwoche anschliesst. Das ist leichter zu erklaeren ("jede Woche,
// in der du drangeblieben bist"), es waechst gleichmaessig statt sprunghaft, und es
// sinkt nie rueckwirkend, wenn jemand eine Woche aussetzt.
function punkteWochenBoni(wochen) {
  const keys = Object.keys(wochen || {}).sort();
  let serie = 0, vielseitig = 0;
  keys.forEach((k) => {
    const apps = wochen[k] || [];
    if (apps.length >= PUNKTE_VIELSEITIG_APPS) vielseitig += PUNKTE_BONUS_VIELSEITIG;
    const davor = punkteWocheDavor(k);
    if (davor && Object.prototype.hasOwnProperty.call(wochen, davor)) serie += PUNKTE_BONUS_SERIE;
  });
  return { serie, vielseitig, gesamt: serie + vielseitig };
}

// Zwei Wochen-Bestaende vereinen (Saldo + laufender Monat) und auf die juengsten
// PUNKTE_WOCHEN_HISTORIE Wochen kuerzen.
function punkteWochenVereinen(a, b) {
  const zusammen = {};
  [a || {}, b || {}].forEach((quelle) => {
    Object.keys(quelle).forEach((w) => {
      if (!zusammen[w]) zusammen[w] = [];
      (quelle[w] || []).forEach((app) => { if (!zusammen[w].includes(app)) zusammen[w].push(app); });
    });
  });
  const keys = Object.keys(zusammen).sort();
  if (keys.length <= PUNKTE_WOCHEN_HISTORIE) return zusammen;
  const gekuerzt = {};
  keys.slice(keys.length - PUNKTE_WOCHEN_HISTORIE).forEach((w) => { gekuerzt[w] = zusammen[w]; });
  return gekuerzt;
}

// Monat als YYYY-MM um n Monate zurueckversetzen. Rein auf dem String gerechnet,
// damit keine Zeitzonen-Kante mitspielt.
function punkteMonatMinus(monat, n) {
  const jahr = Number(monat.slice(0, 4));
  const m = Number(monat.slice(5, 7));
  const gesamt = jahr * 12 + (m - 1) - n;
  const nj = Math.floor(gesamt / 12);
  const nm = gesamt - nj * 12 + 1;
  return String(nj).padStart(4, "0") + "-" + String(nm).padStart(2, "0");
}

function aktivitaetNutzerDir(username) {
  return AKTIVITAET_DIR + "/" + username;
}

function aktivitaetMonatUrl(username, monat) {
  return aktivitaetNutzerDir(username) + "/" + monat + ".json";
}

function aktivitaetSaldoUrl(username) {
  return aktivitaetNutzerDir(username) + "/saldo.json";
}

function leeresAktivitaetsDoc(username, monat) {
  return { version: 1, username, monat, ereignisse: [] };
}

function leeresSaldoDoc(username) {
  return { version: 1, regeln: PUNKTE_REGELN_VERSION, username, monate: {}, eingeloest: 0 };
}

function punkteApp(body, aktion) {
  const ausBody = String((body && body.app) || "").trim();
  if (ausBody && Object.prototype.hasOwnProperty.call(DAV_APPS, ausBody)) return ausBody;
  for (const [praefix, ziel] of PUNKTE_APP_PRAEFIXE) {
    if (aktion.startsWith(praefix)) return ziel;
  }
  // Alles, was zur Uebersicht selbst gehoert (Neuigkeiten, Konto, Verwaltung).
  return "uebersicht";
}

// Isolate-lokaler Kurzschluss gegen Klick-Burst: dieselbe nicht-Tat in derselben
// App im selben 5-Minuten-Fenster braucht kein zweites Mal geschrieben zu werden,
// sie aendert an der Punktzahl nichts. Gleiches Muster wie jsonCache weiter oben --
// ueberlebt nur auf einem warmen Isolate, und mehr ist auch nicht noetig: schlaegt
// der Kurzschluss fehl, wird lediglich einmal mehr geschrieben, nie falsch gezaehlt.
const aktivitaetGesehen = new Map();
const AKTIVITAET_GESEHEN_TTL_MS = 15 * 60 * 1000;

function aktivitaetSchonGesehen(key, jetzt) {
  const bis = aktivitaetGesehen.get(key);
  if (bis && bis > jetzt) return true;
  // Harte Obergrenze, damit ein langlebiges Isolate nicht unbegrenzt waechst.
  if (aktivitaetGesehen.size > 5000) aktivitaetGesehen.clear();
  aktivitaetGesehen.set(key, jetzt + AKTIVITAET_GESEHEN_TTL_MS);
  return false;
}

// Der Einhaengepunkt aus fetch(). Laeuft in ctx.waitUntil, also NACH der Antwort.
//
// ⚠️ Wirft nie. Punkte sind Beiwerk -- die eigentliche Handlung des Nutzers ist an
// dieser Stelle laengst beantwortet und darf durch einen Zaehlfehler nicht mehr
// beruehrt werden.
async function aktivitaetErfassen(request, body, env, authHeader, antwort) {
  try {
    // Nur erfolgreiche Handlungen. Ein 403 ist keine Vereinsarbeit.
    const status = Number(antwort && antwort.status);
    if (!(status >= 200 && status < 400)) return;

    // Bonus-Marke ZUERST, vor der Ignorier-Liste. Beide Boni haengen an Aktionen,
    // die dort stehen (login, change-password) -- und der Login traegt nicht
    // einmal einen Token, aus dem sich der Nutzer ergaebe. Deshalb entscheidet
    // der Handler (nur er kennt den VORIGEN lastLoginAt bzw. den vorigen
    // Bonus-Zeitpunkt) und haengt das Ergebnis an die Response; geschrieben wird
    // trotzdem erst hier, also nach der Antwort. Die Marke verlaesst den Worker
    // nie -- sie ist eine Objekt-Eigenschaft, kein Teil des Bodys.
    const marke = antwort && antwort.punkteBonus;
    if (marke && PUNKTE_BONI.has("bonus-" + marke.art)) {
      await aktivitaetBonusSchreiben(marke.username, marke.art, env, authHeader);
    }

    const aktion = String((body && body.action) || "");
    if (!aktion || PUNKTE_IGNORIERT.has(aktion)) return;

    // ⚠️ Vom Client als Hintergrund-Abruf markiert. Noetig, weil `dav-load` je nach
    // Absender zwei verschiedene Dinge bedeutet: aus dem Repo einer App heisst es
    // "der Nutzer hat mich geoeffnet", aus den Startseiten-Fenstern der Uebersicht
    // dagegen nur "ich fuelle eine Kachel". Ohne die Marke buchte allein das Oeffnen
    // der Uebersicht dem Nutzer eine Nutzung von Vereinskalender UND
    // Abwesenheitskalender -- Punkte fuers blosse Angemeldetsein, und dazu eine
    // Nutzungsstatistik, die zwei Tools ausweist, die niemand aufgerufen hat.
    // Die Marke ist absichtlich nur abschwaechend: wer sie faelschlich mitschickt,
    // nimmt sich selbst Punkte weg. Wer sie weglaesst, kaeme ohnehin nicht ueber
    // den Tagesdeckel hinaus.
    if (body && body.hintergrund === true) return;

    // Reine HMAC-Pruefung des Tokens, kein Nextcloud-Read. Der volle
    // getVerifiedSession-Abgleich waere hier Verschwendung: der Handler hat ihn
    // gerade selbst gemacht, sonst waere die Antwort kein 2xx geworden.
    const payload = await getSession(request, env);
    if (!tokenAfterCutoff(payload)) return;
    const username = String((payload && payload.username) || "");
    if (!USERNAME_RE.test(username) || username === "__proto__") return;

    // nutzer.json steckt nach der Handlung praktisch immer im jsonCache (5 s),
    // dieser Read kostet daher im Normalfall keinen Nextcloud-Roundtrip.
    if (!(await punkteNutzerZulaessig(username, env, authHeader))) return;

    const jetzt = Date.now();
    const fenster = punkteFenster(jetzt);
    const app = punkteApp(body, aktion);
    // Ab hier zaehlt der verfeinerte Name (z.B. "km-self:teilnahme"), nicht der
    // Endpunkt -- er wird auch so in die Datei geschrieben.
    const gebucht = punkteAktionMitUnterart(aktion, body);
    const istTat = PUNKTE_TATEN.has(gebucht);

    // Taten gehen am Kurzschluss vorbei: zwei erledigte Aufgaben sind zwei Taten,
    // auch wenn sie in dieselbe Viertelstunde fallen.
    if (!istTat && aktivitaetSchonGesehen(username + "|" + fenster + "|" + app + "|" + gebucht, jetzt)) return;

    await aktivitaetSchreiben(username, fenster, app, gebucht, env, authHeader);
  } catch (e) {
    console.error("Aktivitaet erfassen fehlgeschlagen: " + (e && e.message ? e.message : e));
  }
}

// Einmal-Bonus vorbereiten: true, wenn er faellig ist. Setzt die Sperre direkt am
// Nutzer-Datensatz -- der AUFRUFER muss usersDoc anschliessend schreiben, sonst ist
// die Sperre weg und der Bonus beim naechsten Mal erneut faellig.
//
// ⚠️ Anders als der Passwort-Bonus gilt die Sperre EINMAL ueberhaupt, nicht alle
// 90 Tage: ein Foto hinterlegt man einmal, Benachrichtigungen schaltet man einmal
// ein. Ohne sie waeren zehn Uploads zehn Boni.
//
// Spielerkonten und Konten mit Widerspruch bekommen nichts -- und ihre Sperre wird
// auch nicht gesetzt, damit ein spaeterer Widerruf des Widerspruchs den Bonus nicht
// stillschweigend verbraucht hat.
function punkteEinmalBonusFaellig(user, feld) {
  if (!user || !istPersonal(user) || user.punkteOptOut) return false;
  if (user[feld]) return false;
  user[feld] = new Date().toISOString();
  return true;
}

// Darf fuer dieses Konto ueberhaupt erfasst werden? Spielerkonten nie, Konten mit
// Widerspruch nie. nutzer.json steckt nach der Handlung praktisch immer im
// jsonCache (5 s), der Read kostet daher im Normalfall keinen Roundtrip.
async function punkteNutzerZulaessig(username, env, authHeader) {
  if (!USERNAME_RE.test(username) || username === "__proto__") return false;
  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  const user = getOwn(usersDoc.users, username);
  return !!(user && istPersonal(user) && !user.punkteOptOut);
}

// Ein Bonus-Ereignis ablegen. App bewusst "uebersicht": Passwort und Anmeldung
// gehoeren zur Uebersicht, nicht zu einem Werkzeug -- und da Bonus-Ereignisse in
// punkteAusEreignissen ohnehin aus fenster/apps herausfallen, taucht die
// Uebersicht dadurch in keiner Nutzungsstatistik faelschlich auf.
async function aktivitaetBonusSchreiben(username, art, env, authHeader) {
  const name = normalizeUsername(String(username || ""));
  if (!name) return;
  if (!(await punkteNutzerZulaessig(name, env, authHeader))) return;
  await aktivitaetSchreiben(name, punkteFenster(Date.now()), "uebersicht", "bonus-" + art, env, authHeader);
}

// Ein Ereignis in die Monatsdatei des Nutzers legen.
//
// If-Match mit Wiederholung, obwohl in diese Datei nur ein einziger Mensch
// schreibt: derselbe Mensch kann in zwei Tabs sitzen, und zwei Isolates schreiben
// dann gleichzeitig. Zwischen VERSCHIEDENEN Nutzern kann es hier keinen Konflikt
// geben -- das ist der eigentliche Grund fuer den Schnitt "eine Datei je Nutzer".
async function aktivitaetSchreiben(username, fenster, app, aktion, env, authHeader) {
  const monat = punkteMonatKey(fenster);
  const url = aktivitaetMonatUrl(username, monat);

  for (let versuch = 0; versuch < 3; versuch++) {
    const gelesen = await readJsonWithRev(url, authHeader, leeresAktivitaetsDoc(username, monat));
    const doc = (gelesen.data && Array.isArray(gelesen.data.ereignisse))
      ? gelesen.data
      : leeresAktivitaetsDoc(username, monat);

    const treffer = doc.ereignisse.find((e) => e && e.w === fenster && e.app === app && e.a === aktion);
    if (treffer) treffer.n = (Number(treffer.n) || 1) + 1;
    else doc.ereignisse.push({ w: fenster, app, a: aktion, n: 1 });

    try {
      // Ohne rev (Datei gibt es noch nicht) legt writeJson die fehlenden
      // Ordnerebenen selbst an -- der Nutzerordner entsteht so beim ersten Ereignis.
      await writeJson(url, authHeader, doc, gelesen.rev || undefined);
      return;
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      throw e;
    }
  }
}

// EINZIGE Stelle mit dem Regelwerk. meine-punkte, die Monatsverdichtung und die
// Admin-Auswertung rufen alle hier herein, damit die Zahlen nicht auseinanderlaufen.
//
// Regeln (Stand PUNKTE_REGELN_VERSION 2):
//   - je Tag, App und 5-Minuten-Fenster mit mindestens einer gezaehlten Handlung:
//     PUNKTE_PRO_FENSTER. Das ist zugleich der Deckel fuer alles, was nicht im
//     Katalog steht -- zwoelf Autosaves in derselben Viertelstunde ergeben einen Punkt.
//   - je Tag und App zusaetzlich einmalig PUNKTE_PRO_APP_START (belohnt Breite
//     statt Sitzdauer)
//   - je Katalog-Tat PUNKTE_PRO_TAT, jedes Vorkommen einzeln
//   - je Tag und App einmalig PUNKTE_PRO_TAT, wenn darin ueberhaupt gespeichert
//     wurde ("Tagewerk", seit Version 2 -- Begruendung unten)
//   - Summe je Tag hoechstens PUNKTE_TAGESDECKEL
//
// ⚠️ Das Tagewerk gleicht eine Schieflage aus, die beim Nachrechnen am 2026-08-04
// auffiel: die Apps der TRAINER (Kadermanager, Testspielplaner, Ausbildungsplan,
// Platzbelegung, Abwesenheitskalender) sprechen fast nur dav-load/dav-save. Von den
// 24 Katalog-Taten liegt keine einzige in ihrem Arbeitsbereich -- sie stecken in
// Vereinsaufgaben, Personalakte, News und Fotoauftraegen, also in Funktionaers- und
// Geschaeftsstellenarbeit. Gemessen: ein Funktionaer kam mit zehn Aufgaben-Aktionen
// in zwanzig Minuten auf 36 Punkte, ein Trainer nach einer Stunde Kaderpflege auf 14.
// Bei einem System, das die Arbeit mit den Tools wuerdigen soll, traf das ausgerechnet
// die groesste Gruppe.
//
// ⚠️ Warum EINMAL je Tag und App und nicht je dav-save: der Grund, aus dem dav-save
// nicht im Katalog steht, gilt unveraendert weiter -- 15 Apps speichern beim Tippen,
// ein einziger ausgefuellter Antrag loest ein Dutzend dav-save aus. Gezaehlt wird
// deshalb nicht, wie oft gespeichert wurde, sondern nur DASS an diesem Tag in dieser
// App etwas entstanden ist. Wer laenger tippt, gewinnt dadurch nichts.
function punkteAusEreignissen(ereignisse) {
  const tage = new Map();

  (Array.isArray(ereignisse) ? ereignisse : []).forEach((e) => {
    if (!e || typeof e.w !== "number" || !Number.isFinite(e.w)) return;
    // Ignorier-Liste auch beim RECHNEN anwenden, nicht nur beim Schreiben. Sonst
    // zaehlt eine Aktion, die erst spaeter ausgenommen wurde, aus den alten Rohdaten
    // weiter mit -- und die Zusage "Regeln lassen sich rueckwirkend neu rechnen"
    // gaelte ausgerechnet fuer die Liste nicht, die am ehesten nachgezogen wird.
    if (PUNKTE_IGNORIERT.has(String(e.a || ""))) return;
    const tag = punkteTagKey(e.w);
    if (!tage.has(tag)) tage.set(tag, { fenster: new Set(), apps: new Set(), tagewerke: new Set(), taten: 0, boni: 0 });
    const t = tage.get(tag);
    const app = String(e.app || "uebersicht");
    const aktion = String(e.a || "");

    // ⚠️ Bonus-Ereignisse gehen NICHT in fenster/apps/tagewerke ein. Sonst gaebe
    // ein Passwortwechsel nebenbei noch einen Fenster- und einen App-Punkt --
    // und ein Tag, an dem jemand nur sein Passwort gewechselt hat, zaehlte als
    // aktiver Tag, obwohl mit den Werkzeugen nichts geschehen ist.
    // n wird hier bewusst NICHT multipliziert: beide Boni sind durch Sperrfrist
    // bzw. Sitzungsdauer begrenzt, ein n>1 waere eine Anomalie und duerfte sich
    // nicht auszahlen.
    const bonus = PUNKTE_BONI.get(aktion);
    if (bonus) { t.boni += bonus; return; }

    t.fenster.add(e.w + "|" + app);
    t.apps.add(app);
    if (aktion === "dav-save") t.tagewerke.add(app);
    const wert = PUNKTE_TATEN.get(aktion);
    if (wert) t.taten += wert * Math.max(1, Number(e.n) || 1);
  });

  const proTag = {};
  let gesamt = 0;
  Array.from(tage.keys()).sort().forEach((tag) => {
    const t = tage.get(tag);
    const roh = t.fenster.size * PUNKTE_PRO_FENSTER
      + t.apps.size * PUNKTE_PRO_APP_START
      + t.tagewerke.size * PUNKTE_PRO_TAT
      + t.taten;
    // Nur das Wiederholbare wird gedeckelt. Der Tagesbonus faellt genau einmal an
    // und nur, wenn ueberhaupt etwas geschehen ist -- ein Tag, an dem jemand bloss
    // angemeldet war, hat kein einziges Fenster und bekommt ihn deshalb nicht.
    const tagesbonus = t.fenster.size > 0 ? PUNKTE_BONUS_TAG : 0;
    const wert = Math.min(roh, PUNKTE_TAGESDECKEL) + tagesbonus + t.boni;
    proTag[tag] = wert;
    gesamt += wert;
  });

  return { gesamt, proTag };
}

// Punktestand eines Nutzers. Kostet im Normalfall zwei Reads (saldo + laufender
// Monat) -- NICHT einen Read je Monat seit Beginn, deshalb ueberhaupt das saldo.json.
//
// Beim ersten Aufruf in einem neuen Monat werden die inzwischen abgeschlossenen
// Monate nachgetragen und dabei die Rohdateien geloescht, die aelter als
// PUNKTE_ROHDATEN_MONATE sind. Kein Cron noetig, keine neue Infrastruktur.
async function punkteStand(username, env, authHeader, mitProtokoll) {
  const jetztFenster = punkteFenster(Date.now());
  const aktuellerMonat = punkteMonatKey(jetztFenster);

  const saldoGelesen = await readJsonWithRev(aktivitaetSaldoUrl(username), authHeader, leeresSaldoDoc(username));
  const saldo = (saldoGelesen.data && typeof saldoGelesen.data === "object" && saldoGelesen.data.monate)
    ? saldoGelesen.data
    : leeresSaldoDoc(username);
  // Regelwechsel: der gespeicherte Saldo wurde nach anderen Regeln gerechnet und
  // wird verworfen. Die Rohdaten der letzten PUNKTE_ROHDATEN_MONATE tragen sich
  // unten von selbst wieder ein -- aeltere Monate behalten ihren historischen Wert
  // nicht, das ist der bewusst in Kauf genommene Preis der Verdichtung.
  if (Number(saldo.regeln) !== PUNKTE_REGELN_VERSION) {
    saldo.regeln = PUNKTE_REGELN_VERSION;
    saldo.monate = {};
    saldo.wochen = {};
  }
  if (!saldo.wochen || typeof saldo.wochen !== "object") saldo.wochen = {};

  // Abgeschlossene Monate rueckwaerts nachtragen, bis einer schon dasteht.
  let saldoGeaendert = false;
  for (let i = 1; i <= PUNKTE_ROHDATEN_MONATE; i++) {
    const monat = punkteMonatMinus(aktuellerMonat, i);
    if (Object.prototype.hasOwnProperty.call(saldo.monate, monat)) break;
    const doc = await readJson(aktivitaetMonatUrl(username, monat), authHeader, null);
    saldo.monate[monat] = doc ? punkteAusEreignissen(doc.ereignisse).gesamt : 0;
    // ⚠️ Die Wochen dieses Monats mitnehmen, BEVOR die Rohdatei verdichtet wird.
    // Serie und Vielseitigkeit laufen ueber Monatsgrenzen hinweg; ohne diesen
    // Mitschnitt risse jede Serie beim Monatswechsel, und eine Woche, die auf zwei
    // Monate faellt, saehe nie ihre volle Zahl an Werkzeugen.
    if (doc) saldo.wochen = punkteWochenVereinen(saldo.wochen, punkteWochenAusEreignissen(doc.ereignisse));
    saldoGeaendert = true;
    // Verdichtung: die Rohdatei dieses Monats faellt aus dem Aufbewahrungsfenster,
    // sobald ihr Wert im Saldo steht und sie alt genug ist.
    if (doc && i >= PUNKTE_ROHDATEN_MONATE) {
      await aktivitaetRohdateiLoeschen(username, monat, authHeader);
    }
  }

  const aktuellDoc = await readJson(aktivitaetMonatUrl(username, aktuellerMonat), authHeader, null);
  const aktuell = punkteAusEreignissen(aktuellDoc ? aktuellDoc.ereignisse : []);

  let abgeschlossen = 0;
  Object.keys(saldo.monate).forEach((m) => {
    if (m !== aktuellerMonat) abgeschlossen += Number(saldo.monate[m]) || 0;
  });

  if (saldoGeaendert) {
    try {
      await writeJson(aktivitaetSaldoUrl(username), authHeader, saldo, saldoGelesen.rev || undefined);
    } catch (e) {
      // Nur ein Zwischenspeicher. Schlaegt er fehl, wird beim naechsten Mal neu
      // gerechnet -- die Zahl unten stimmt trotzdem.
      console.error("Punkte-Saldo schreiben fehlgeschlagen: " + (e && e.message ? e.message : e));
    }
  }

  // Wochen-Boni stehen bewusst NICHT in punkteAusEreignissen: die Funktion sieht
  // immer nur einen Monat, Serie und Vielseitigkeit laufen aber darueber hinweg.
  // Gerechnet wird deshalb hier, auf dem vereinten Bestand aus Saldo und laufendem
  // Monat -- dessen Wochen werden absichtlich nicht mitgespeichert, der Monat ist
  // ja noch nicht fertig.
  const wochen = punkteWochenVereinen(saldo.wochen, punkteWochenAusEreignissen(aktuellDoc ? aktuellDoc.ereignisse : []));
  const wochenBoni = punkteWochenBoni(wochen);

  const erarbeitet = abgeschlossen + aktuell.gesamt + wochenBoni.gesamt;
  const eingeloest = Number(saldo.eingeloest) || 0;

  const ergebnis = {
    erarbeitet, eingeloest, verfuegbar: Math.max(0, erarbeitet - eingeloest),
    serie: wochenBoni.serie, vielseitigkeit: wochenBoni.vielseitig
  };
  if (mitProtokoll) {
    ergebnis.protokoll = punkteProtokoll(aktuellDoc ? aktuellDoc.ereignisse : [], aktuell.proTag);
  }
  return ergebnis;
}

// Das eigene Protokoll der letzten Tage: was habe ich wann in welcher App getan.
// Auskunftsrecht in Klickform -- und zugleich die Erklaerung, wie die Zahl zustande
// kommt. Nur der laufende Monat, das reicht fuer PUNKTE_PROTOKOLL_TAGE.
function punkteProtokoll(ereignisse, proTag) {
  const grenze = new Date(Date.now() - PUNKTE_PROTOKOLL_TAGE * 86400000)
    .toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const proTagApp = new Map();

  (Array.isArray(ereignisse) ? ereignisse : []).forEach((e) => {
    if (!e || typeof e.w !== "number") return;
    const tag = punkteTagKey(e.w);
    if (tag < grenze) return;
    const app = String(e.app || "uebersicht");
    const key = tag + "|" + app;
    if (!proTagApp.has(key)) proTagApp.set(key, { tag, app, handlungen: 0, taten: 0 });
    const z = proTagApp.get(key);
    const anzahl = Math.max(1, Number(e.n) || 1);
    z.handlungen += anzahl;
    if (PUNKTE_TATEN.has(String(e.a || ""))) z.taten += anzahl;
  });

  return Array.from(proTagApp.values())
    .sort((a, b) => (a.tag === b.tag ? a.app.localeCompare(b.app) : b.tag.localeCompare(a.tag)))
    .map((z) => ({ ...z, tagespunkte: Number(proTag[z.tag]) || 0 }));
}

async function aktivitaetRohdateiLoeschen(username, monat, authHeader) {
  try {
    await fetch(aktivitaetMonatUrl(username, monat), {
      method: "DELETE",
      headers: { Authorization: authHeader }
    });
  } catch (e) {
    console.error("Alte Aktivitaets-Rohdatei loeschen fehlgeschlagen: " + (e && e.message ? e.message : e));
  }
}

// ---------- Aktionen: Aktivitaetspunkte ----------

async function handleMeinePunkte(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  // Spielerkonten werden nicht erfasst und bekommen deshalb auch keine Anzeige --
  // eine dauerhafte Null waere nur verwirrend.
  if (session.art === USER_ART_SPIELER) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const user = getOwn(session.usersDoc.users, session.username) || {};
  if (user.punkteOptOut) {
    return json({
      optOut: true, erarbeitet: 0, verfuegbar: 0, eingeloest: 0, protokoll: [],
      regeln: punkteRegelnFuerAnzeige()
    }, 200, corsHeaders);
  }

  const stand = await punkteStand(session.username, env, authHeader, true);
  return json({ optOut: false, ...stand, regeln: punkteRegelnFuerAnzeige() }, 200, corsHeaders);
}

// Die Regeln wandern mit in die Antwort, damit die Karte im Konto-Tab sie anzeigen
// kann, ohne sie ein zweites Mal im Client zu fuehren. Zwei Kopien liefen mit der
// ersten Regelaenderung auseinander.
function punkteRegelnFuerAnzeige() {
  return {
    version: PUNKTE_REGELN_VERSION,
    fensterMinuten: PUNKTE_FENSTER_MS / 60000,
    proFenster: PUNKTE_PRO_FENSTER,
    proAppStart: PUNKTE_PRO_APP_START,
    proTat: PUNKTE_PRO_TAT,
    // Additiv (Regeln 2). Ein Client, der noch den alten Stand hat, laesst die
    // Zeile einfach weg -- die Punkte bekommt er trotzdem, gerechnet wird hier.
    proTagewerk: PUNKTE_PRO_TAT,
    // Additiv (Regeln 3). Ein Client mit altem Stand laesst die Zeilen weg --
    // gerechnet wird hier, die Punkte bekommt er trotzdem.
    proAktivemTag: PUNKTE_BONUS_TAG,
    proPasswortwechsel: PUNKTE_BONUS_PASSWORT,
    passwortSperreTage: PUNKTE_PW_BONUS_TAGE,
    proRueckkehr: PUNKTE_BONUS_RUECKKEHR,
    rueckkehrNachTagen: Math.round(SESSION_TTL_SECONDS / 86400),
    // Additiv (Regeln 4).
    proTerminAntwort: PUNKTE_TAT_TERMIN_ANTWORT,
    // Additiv (Regeln 5).
    proSerienwoche: PUNKTE_BONUS_SERIE,
    proVielseitigeWoche: PUNKTE_BONUS_VIELSEITIG,
    vielseitigAbWerkzeugen: PUNKTE_VIELSEITIG_APPS,
    einmalFoto: PUNKTE_BONUS_FOTO,
    einmalPush: PUNKTE_BONUS_PUSH,
    einmalPflichten: PUNKTE_BONUS_PFLICHTEN,
    tagesdeckel: PUNKTE_TAGESDECKEL,
    aufbewahrungMonate: PUNKTE_ROHDATEN_MONATE
  };
}

// Widerspruch gegen die Erfassung.
//
// ⚠️ Das Einschalten loescht den gesamten eigenen Bestand mit (ein DELETE auf den
// Nutzerordner nimmt Monatsdateien und Saldo in einem Zug). Das ist die ehrliche
// Lesart von "nicht mitzaehlen" -- Widerspruch, bei dem die alten Daten liegen
// bleiben, ist keiner. Der Client fragt vorher nach, weil es nicht umkehrbar ist.
async function handlePunkteOptOut(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const usersDoc = session.usersDoc;
  const user = getOwn(usersDoc.users, session.username);
  if (!user) return json({ error: "Unbekannter Nutzer" }, 404, corsHeaders);

  const aus = !!(body && body.optOut);

  // ⚠️ Reihenfolge bindend: erst das Flag setzen, dann loeschen. Andersherum
  // koennte eine Handlung zwischen Loeschung und Flag noch eine neue Datei
  // anlegen -- der Nutzer haette widersprochen und trotzdem wieder Daten.
  if (aus) user.punkteOptOut = true;
  else delete user.punkteOptOut;
  try {
    await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }

  if (aus) {
    try {
      await fetch(aktivitaetNutzerDir(session.username), {
        method: "DELETE",
        headers: { Authorization: authHeader }
      });
    } catch (e) {
      console.error("Aktivitaetsdaten loeschen fehlgeschlagen: " + (e && e.message ? e.message : e));
    }
  }

  return json({ ok: true, optOut: aus }, 200, corsHeaders);
}

// Auswertung fuer das Admin-Dashboard: wer nutzt welche App, und wie oft.
//
// ⚠️ Bewusst blockweise statt "alle auf einmal": bei ueber hundert Personal-Konten
// waere eine Auswertung in EINEM Request ein Rundlauf mit hundert Nextcloud-Reads --
// genau die Bauform, an der ein Worker stirbt. Der Client fragt in Bloecken von
// hoechstens PUNKTE_AUSWERTUNG_MAX_NUTZER und zaehlt selbst zusammen.
async function handleAktivitaetAuswertung(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!session.isAdmin) return json({ error: "Nur fuer Administratoren" }, 403, corsHeaders);

  const monat = String((body && body.monat) || "").trim() || punkteMonatKey(punkteFenster(Date.now()));
  if (!/^\d{4}-\d{2}$/.test(monat)) return json({ error: "Ungueltiger Monat" }, 400, corsHeaders);

  const users = (session.usersDoc && session.usersDoc.users) || {};
  let namen = Array.isArray(body && body.usernames) ? body.usernames : null;
  if (!namen) {
    namen = Object.values(users).filter((u) => u && u.username && istPersonal(u)).map((u) => u.username);
  }
  const block = namen
    .map((n) => normalizeUsername(n))
    .filter((n) => USERNAME_RE.test(n) && n !== "__proto__")
    .slice(0, PUNKTE_AUSWERTUNG_MAX_NUTZER);

  const nutzer = [];
  for (const name of block) {
    const u = getOwn(users, name);
    if (!u || !istPersonal(u)) continue;
    if (u.punkteOptOut) {
      nutzer.push({ username: name, optOut: true, punkte: 0, proApp: {} });
      continue;
    }
    const doc = await readJson(aktivitaetMonatUrl(name, monat), authHeader, null);
    const ereignisse = doc && Array.isArray(doc.ereignisse) ? doc.ereignisse : [];
    const proApp = {};
    ereignisse.forEach((e) => {
      if (!e) return;
      const app = String(e.app || "uebersicht");
      proApp[app] = (proApp[app] || 0) + Math.max(1, Number(e.n) || 1);
    });
    nutzer.push({
      username: name,
      optOut: false,
      punkte: punkteAusEreignissen(ereignisse).gesamt,
      proApp
    });
  }

  // rest: was der Client im naechsten Block nachfragen muss. Ohne diese Angabe
  // sieht eine abgeschnittene Auswertung aus wie eine vollstaendige.
  const rest = namen.length > block.length ? namen.length - block.length : 0;
  return json({ monat, nutzer, rest, blockgroesse: PUNKTE_AUSWERTUNG_MAX_NUTZER }, 200, corsHeaders);
}

// ================================================================
// Kleiderbestellung: Bestellungen von aussen, ohne Vereinskonto
// (seit 2026-08-09)
// ================================================================
//
// Spieler haben kein Konto in der Tools-Uebersicht, sollen ihre Kleidergroesse
// aber selbst bestellen. Ein Administrierender erzeugt dafuer in der App je
// Bestellaktion einen Link mit 64-stelligem Zufallstoken (als QR-Code zum
// Zeigen oder zum Verschicken). Wer ihn oeffnet, weist sich mit Vorname,
// Nachname und Geburtsjahr aus und schuetzt seine Bestellung beim ersten
// Absenden mit einem selbst gewaehlten Passwort; zum spaeteren Aendern wird es
// wieder verlangt.
//
// ⚠️ Der Schreibweg laeuft BEWUSST nicht ueber dav-save. Das vertraut dem
// Aufrufer die GANZE Datei an -- ein Link ist aber eine schwaechere
// Vertrauensstufe als ein Login, und jeder Link-Inhaber koennte damit die
// Bestellungen aller anderen ueberschreiben oder loeschen.
// handleKbExternSpeichern baut stattdessen GENAU EINEN Eintrag serverseitig aus
// einzelnen, gecappten und gegen den echten Katalog geprueften Feldern zusammen
// und fasst nichts anderes im Dokument an. Gleiche Bauform wie
// handleFahrtenbuchExternSubmit und handleSchulsportFreigabeSenden, siehe auch
// den Abschnitt "Login-lose Schreib-Endpunkte" in E:\kleiderbestellung\CLAUDE.md.

const KB_EXTERN_APP = "kleiderbestellung";
const KB_EXTERN_IP_ZAEHLER = new Map();
// ⚠️ Bewusst hoch und mit einer EIGENEN Map (nicht der von schulsport): eine
// ganze Mannschaft steht beim Scannen des QR-Codes im selben WLAN und teilt
// sich damit eine IP. Bei 60 Aufrufen je Stunde waeren nach 20 Spielern à
// start+anmelden+speichern alle weiteren ausgesperrt -- und zwar mitten in der
// Trainingseinheit, in der es gerade laeuft. Die eigentliche Bremse gegen
// Ausprobieren ist die 800-ms-Verzoegerung je Fehlschlag plus PBKDF2.
const KB_EXTERN_MAX_PRO_STUNDE = 400;
const KB_EXTERN_PW_MIN = 4;
const KB_EXTERN_PW_MAX = 100;
const KB_EXTERN_MAX_POSITIONEN = 60;
const KB_EXTERN_KOMMENTAR_MAX = 500;
// Deckel fuer selbst gewaehlte Mengen (nur bei Artikeln mit Standardmenge 0
// relevant) -- ohne ihn stuende eine Phantasiezahl in der Lieferantenliste.
const KB_EXTERN_MENGE_MAX = 99;

function kbExternIpBremse(request) {
  const ip = String((request && request.headers && request.headers.get("CF-Connecting-IP")) || "");
  if (!ip) return true;
  const jetzt = Date.now();
  const eintrag = KB_EXTERN_IP_ZAEHLER.get(ip);
  if (!eintrag || jetzt - eintrag.start > 3600000) {
    KB_EXTERN_IP_ZAEHLER.set(ip, { start: jetzt, n: 1 });
    // Aufraeumen, damit die Map in einem langlebigen Isolate nicht waechst.
    if (KB_EXTERN_IP_ZAEHLER.size > 500) {
      for (const [k, v] of KB_EXTERN_IP_ZAEHLER) {
        if (jetzt - v.start > 3600000) KB_EXTERN_IP_ZAEHLER.delete(k);
      }
    }
    return true;
  }
  eintrag.n++;
  return eintrag.n <= KB_EXTERN_MAX_PRO_STUNDE;
}

// Verzoegerung nach jedem Fehlschlag, gleiche Linie wie handleLogin und
// requireFahrtenbuchExternCode: sie macht das Durchprobieren von Namen,
// Jahrgaengen und Passwoertern teuer, ohne den normalen Weg zu bremsen.
function kbExternBremse() {
  return new Promise((resolve) => setTimeout(resolve, 800));
}

function kbExternNamensteil(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

// Der Schluessel, unter dem eine externe Bestellung in aktion.bestellungen liegt.
//
// ⚠️ Das fuehrende "extern:" ist keine Kosmetik: USERNAME_RE erlaubt keinen
// Doppelpunkt, ein von aussen gebildeter Schluessel kann deshalb NIE auf die
// Bestellung eines echten Kontos zeigen. Die Pruefung auf quelle === "extern"
// in kbExternEintrag kommt als zweite, davon unabhaengige Schranke dazu --
// dieselbe Ueberlegung wie beim quelle-Filter der Fahrtenbuch-Idempotenz.
//
// ⚠️ Der Name wird normalisiert, das Geburtsjahr NICHT. "Müller", "Mueller" und
// "MÜLLER " sind derselbe Mensch und muessen auf dieselbe Bestellung fuehren --
// sonst legt sich jemand mit einer anderen Schreibweise unbemerkt eine zweite
// an und die erste ist fuer ihn dann passwortgeschuetzt verschlossen.
function kbExternSchluessel(vorname, nachname, jahrgang) {
  return "extern:" + kbExternNamensteil(vorname) + "." + kbExternNamensteil(nachname) + "." + String(jahrgang);
}

// Vorname, Nachname und Geburtsjahr aus dem Koerper, oder null.
function kbExternIdent(body) {
  const vorname = capStr(body && body.vorname, 60);
  const nachname = capStr(body && body.nachname, 60);
  const jahrgang = capStr(body && body.jahrgang, 4);
  if (!vorname || !nachname) return null;
  if (!/^(19|20)\d{2}$/.test(jahrgang)) return null;
  if (Number(jahrgang) > new Date().getUTCFullYear()) return null;
  // ⚠️ Ein Name, von dem nach dem Normalisieren nichts uebrig bleibt (nur
  // Satzzeichen oder Emoji), ergaebe den Schluessel "extern:..<jahr>" -- unter
  // dem landeten dann ALLE solchen Eingaben desselben Jahrgangs zusammen, und
  // der Erste haette das Passwort fuer die Bestellung des Naechsten.
  if (!kbExternNamensteil(vorname) || !kbExternNamensteil(nachname)) return null;
  return { vorname, nachname, jahrgang, schluessel: kbExternSchluessel(vorname, nachname, jahrgang) };
}

// Die Bestellaktion, deren externer Link auf diesen Token lautet.
// Vergleich timing-sicher, nicht mit === (wie handleSchulsportFreigabeLesen).
async function kbExternAktionZuToken(doc, token) {
  const aktionen = (doc && Array.isArray(doc.aktionen)) ? doc.aktionen : [];
  for (const a of aktionen) {
    const t = a && a.extern && a.extern.token;
    if (typeof t !== "string" || !t) continue;
    if (await staticPasswordEquals(token, t)) return a;
  }
  return null;
}

// Liefert einen Bestelleintrag NUR, wenn er wirklich von aussen stammt.
// hasOwnProperty statt direktem Zugriff, damit ein Schluessel wie "__proto__"
// nicht den Prototyp trifft -- hier zwar durch das "extern:"-Praefix ohnehin
// unmoeglich, aber die Regel gilt an jeder Stelle gleich.
function kbExternEintrag(aktion, schluessel) {
  const alle = (aktion && aktion.bestellungen && typeof aktion.bestellungen === "object") ? aktion.bestellungen : {};
  if (!Object.prototype.hasOwnProperty.call(alle, schluessel)) return null;
  const b = alle[schluessel];
  if (!b || typeof b !== "object") return null;
  if (b.quelle !== "extern") return null;
  return b;
}

// Was der externe Client von seiner eigenen Bestellung zurueckbekommt --
// bewusst eine Positivliste. Der gespeicherte Passwort-Hash verlaesst den
// Worker damit auch dann nie, wenn dem Eintrag spaeter Felder hinzukommen.
function kbExternOeffentlicheBestellung(b) {
  return {
    positionen: (Array.isArray(b.positionen) ? b.positionen : []).map((p) => ({
      artikelId: String((p && p.artikelId) || ""),
      groesse: String((p && p.groesse) || ""),
      menge: Number(p && p.menge) > 0 ? Number(p.menge) : 1
    })),
    kommentar: String(b.kommentar || ""),
    letzteAenderung: String(b.letzteAenderung || "")
  };
}

// Token pruefen und die zugehoerige Bestellaktion holen. Liefert entweder
// { aktion, doc, token } oder { fehler: Response }.
async function kbExternAktionLaden(request, body, authHeader, corsHeaders) {
  // 1. Formpruefung zuerst -- die billigste Bremse, ohne jeden Datei-Zugriff.
  const token = String((body && body.token) || "");
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return { fehler: json({ error: "Ungültiger Link" }, 400, corsHeaders) };
  }
  // 2. Zaehlwerk je IP.
  if (!kbExternIpBremse(request)) {
    return { fehler: json({ error: "Zu viele Versuche — bitte später noch einmal probieren." }, 429, corsHeaders) };
  }

  const doc = await readJson(DAV_APPS[KB_EXTERN_APP], authHeader, null);
  const aktion = await kbExternAktionZuToken(doc, token);
  if (!aktion) {
    await kbExternBremse();
    return { fehler: json({ error: "Dieser Link ist nicht gültig." }, 404, corsHeaders) };
  }
  if (aktion.extern && aktion.extern.widerrufen) {
    return { fehler: json({ error: "Dieser Link wurde zurückgezogen." }, 410, corsHeaders) };
  }
  return { aktion, doc, token };
}

// ---------- kb-extern-start (OHNE Login) ----------
// Was hinter dem Link steht: Name der Bestellaktion und ihr Katalog.
//
// ⚠️ Hier verlaesst KEINE Bestellung und KEIN Name den Worker. Wer den Link
// hat, sieht die Artikel -- nicht, wer schon bestellt hat.
async function handleKbExternStart(request, body, env, authHeader, corsHeaders) {
  const geladen = await kbExternAktionLaden(request, body, authHeader, corsHeaders);
  if (geladen.fehler) return geladen.fehler;
  const aktion = geladen.aktion;

  return json({
    aktion: {
      name: String(aktion.name || ""),
      offen: aktion.offen !== false,
      // Freitext der Verwaltung fuer die Bestellenden (z.B. Kostenregelung) --
      // gehoert zu dem, was der Link sehen darf. Gekuerzt, damit ein
      // Riesentext nicht jede Antwort aufblaeht.
      hinweis: capStr(aktion.hinweis, 1000),
      artikel: (Array.isArray(aktion.artikel) ? aktion.artikel : [])
        .filter((a) => a && a.aktiv !== false)
        .map((a) => ({
          id: String(a.id || ""),
          name: String(a.name || ""),
          groessen: (Array.isArray(a.groessen) ? a.groessen : []).slice(0, 60).map((g) => String(g)),
          // 0 = Menge frei waehlbar (der Client macht das Feld dann editierbar),
          // siehe kbExternKatalogMenge/kbExternPositionen.
          menge: kbExternKatalogMenge(a)
        }))
    }
  }, 200, corsHeaders);
}

// ---------- kb-extern-anmelden (OHNE Login) ----------
// Vier moegliche Antworten:
//   { status: "neu" }            noch keine Bestellung -- leeres Formular
//   { status: "passwort" }       es gibt eine, das Passwort fehlt noch
//   { status: "ok", bestellung } Passwort stimmt, Bestellung zum Aendern
//   { status: "offen", bestellung }
//       es gibt eine, aber ohne Passwort -- weil ein Bearbeiter es
//       zurueckgesetzt hat ("vergessen"). Sie wird geladen und beim naechsten
//       Speichern muss ein neues vergeben werden.
//
// ⚠️ Dass "neu" und "passwort" unterscheidbar sind, verraet einem Fremden mit
// geratenem Namen und Jahrgang, DASS jemand bestellt hat -- nicht was. Das ist
// der Preis dafuer, dass der Weg ohne Konto ueberhaupt funktioniert: ohne diese
// Auskunft wuesste der Besteller selbst nicht, ob er neu anlegt oder aendert.
// Der Inhalt bleibt hinter dem Passwort.
async function handleKbExternAnmelden(request, body, env, authHeader, corsHeaders) {
  const geladen = await kbExternAktionLaden(request, body, authHeader, corsHeaders);
  if (geladen.fehler) return geladen.fehler;

  const ident = kbExternIdent(body);
  if (!ident) return json({ error: "Bitte Vorname, Nachname und Geburtsjahr angeben." }, 400, corsHeaders);

  const vorhanden = kbExternEintrag(geladen.aktion, ident.schluessel);
  if (!vorhanden) return json({ status: "neu" }, 200, corsHeaders);

  const pw = vorhanden.pw;
  const hatPasswort = !!(pw && pw.hash && pw.salt);
  if (!hatPasswort) {
    return json({ status: "offen", bestellung: kbExternOeffentlicheBestellung(vorhanden) }, 200, corsHeaders);
  }

  const passwort = typeof (body && body.passwort) === "string" ? body.passwort : "";
  if (!passwort) return json({ status: "passwort" }, 200, corsHeaders);

  const ok = await verifyPassword(passwort, pw.salt, pw.iterations || PBKDF2_ITERATIONS, pw.hash);
  if (!ok) {
    await kbExternBremse();
    return json({ error: "Falsches Passwort." }, 403, corsHeaders);
  }
  return json({ status: "ok", bestellung: kbExternOeffentlicheBestellung(vorhanden) }, 200, corsHeaders);
}

// Die im Katalog vorgegebene Menge eines Artikels. 0 ist seit 08/2026 ein
// eigener, gewollter Wert: die Menge ist NICHT vorgegeben, der Besteller
// waehlt sie selbst. Fehlend/leer/kaputt faellt wie bisher auf 1 zurueck --
// nur eine AUSDRUECKLICHE 0 gibt die Menge frei (Number(null) und Number("")
// sind beide 0, das darf nicht als Freigabe durchgehen).
function kbExternKatalogMenge(a) {
  const roh = a ? a.standardMenge : undefined;
  if (roh === null || roh === undefined || String(roh).trim() === "") return 1;
  const m = Math.floor(Number(roh));
  if (m === 0) return 0;
  return Number.isFinite(m) && m > 0 ? m : 1;
}

// Baut die Positionen serverseitig aus dem Katalog DIESER Aktion.
//
// ⚠️ Die Menge kommt aus dem Katalog, nie aus dem Koerper -- mit GENAU EINER
// Ausnahme: steht die Standardmenge im Katalog auf 0, hat der Verein die Menge
// fuer diesen Artikel ausdruecklich freigegeben (Michel-Vorgabe 2026-08-10),
// dann zaehlt die Angabe des Bestellers (ganze Zahl >= 1, gedeckelt). Fuer alle
// anderen Artikel bleibt die Vorgabe des Vereins unverhandelbar -- ueber einen
// login-losen Endpunkt erst recht.
//
// ⚠️ Artikel und Groesse werden gegen den echten Katalog geprueft. Ein
// erfundener Artikel, einer aus einer ANDEREN Bestellaktion oder eine Groesse,
// die es nicht gibt, faellt heraus -- sonst stuende eine Geisterposition in der
// Liste, die an den Lieferanten geht.
function kbExternPositionen(aktion, roh) {
  const liste = Array.isArray(roh) ? roh.slice(0, KB_EXTERN_MAX_POSITIONEN) : [];
  const artikel = Array.isArray(aktion.artikel) ? aktion.artikel : [];
  const positionen = [];
  const gesehen = new Set();
  for (const p of liste) {
    if (!p || typeof p !== "object") continue;
    const artikelId = String(p.artikelId || "");
    const a = artikel.find((x) => x && x.id === artikelId);
    if (!a || a.aktiv === false) continue;
    // Je Artikel hoechstens eine Zeile -- zwei Groessen desselben Hoodies waeren
    // in der Lieferantenliste zwei Stueck, obwohl eines vorgesehen ist.
    if (gesehen.has(artikelId)) continue;
    const groesse = String(p.groesse || "");
    if (!Array.isArray(a.groessen) || !a.groessen.includes(groesse)) continue;
    const katalogMenge = kbExternKatalogMenge(a);
    let menge = katalogMenge;
    if (katalogMenge === 0) {
      menge = Math.floor(Number(p.menge));
      // Ohne brauchbare Menge faellt die Zeile heraus statt mit 0 oder NaN in
      // der Lieferantenliste zu stehen -- dieselbe Semantik wie im Client
      // ("keine Menge = nicht bestellt").
      if (!Number.isFinite(menge) || menge < 1) continue;
      if (menge > KB_EXTERN_MENGE_MAX) menge = KB_EXTERN_MENGE_MAX;
    }
    gesehen.add(artikelId);
    positionen.push({ artikelId, groesse, menge });
  }
  return positionen;
}

// ---------- kb-extern-speichern (OHNE Login) ----------
async function handleKbExternSpeichern(request, body, env, authHeader, corsHeaders) {
  const geladen = await kbExternAktionLaden(request, body, authHeader, corsHeaders);
  if (geladen.fehler) return geladen.fehler;
  if (geladen.aktion.offen === false) {
    return json({ error: "Diese Bestellaktion ist geschlossen — Änderungen sind nicht mehr möglich." }, 409, corsHeaders);
  }

  const ident = kbExternIdent(body);
  if (!ident) return json({ error: "Bitte Vorname, Nachname und Geburtsjahr angeben." }, 400, corsHeaders);

  const vorhanden = kbExternEintrag(geladen.aktion, ident.schluessel);
  const altesPw = (vorhanden && vorhanden.pw && vorhanden.pw.hash && vorhanden.pw.salt) ? vorhanden.pw : null;

  // Wer eine bestehende Bestellung aendert, muss ihr Passwort kennen. Wer neu
  // ist -- oder dessen Passwort ein Bearbeiter zurueckgesetzt hat -- vergibt eines.
  let pwFeld;
  if (altesPw) {
    const ok = await verifyPassword(
      String((body && body.passwort) || ""),
      altesPw.salt, altesPw.iterations || PBKDF2_ITERATIONS, altesPw.hash
    );
    if (!ok) {
      await kbExternBremse();
      return json({ error: "Falsches Passwort." }, 403, corsHeaders);
    }
    pwFeld = altesPw;
  } else {
    const neu = typeof (body && body.neuesPasswort) === "string" ? body.neuesPasswort : "";
    if (neu.length < KB_EXTERN_PW_MIN) {
      return json({ error: `Bitte ein Passwort mit mindestens ${KB_EXTERN_PW_MIN} Zeichen vergeben.` }, 400, corsHeaders);
    }
    if (neu.length > KB_EXTERN_PW_MAX) {
      return json({ error: "Das Passwort ist zu lang." }, 400, corsHeaders);
    }
    pwFeld = await hashNewPassword(neu);
  }

  const positionen = kbExternPositionen(geladen.aktion, body && body.positionen);
  const kommentar = capStr(body && body.kommentar, KB_EXTERN_KOMMENTAR_MAX);
  if (!positionen.length && !kommentar) {
    return json({ error: "Bitte mindestens eine Größe auswählen." }, 400, corsHeaders);
  }

  const url = DAV_APPS[KB_EXTERN_APP];
  // ⚠️ MIT If-Match und drei Versuchen: an derselben Datei arbeiten gleichzeitig
  // die eingeloggten Bearbeiter ueber dav-save. Eine gerade abgegebene
  // Bestellung darf davon nicht ueberschrieben werden -- und umgekehrt darf
  // dieser Handler den Katalog eines Bearbeiters nicht zurueckrollen.
  for (let versuch = 1; versuch <= 3; versuch++) {
    jsonCache.delete(url);
    const { data: raw, rev } = await readJsonWithRev(url, authHeader, null);
    jsonCache.delete(url);
    const doc = (raw && typeof raw === "object") ? raw : null;

    // Alles am frisch gelesenen Stand erneut pruefen: zwischen dem ersten Lesen
    // und hier kann der Link widerrufen oder die Aktion geschlossen worden sein.
    const aktion = await kbExternAktionZuToken(doc, geladen.token);
    if (!aktion) return json({ error: "Dieser Link ist nicht gültig." }, 404, corsHeaders);
    if (aktion.extern && aktion.extern.widerrufen) {
      return json({ error: "Dieser Link wurde zurückgezogen." }, 410, corsHeaders);
    }
    if (aktion.offen === false) {
      return json({ error: "Diese Bestellaktion ist geschlossen — Änderungen sind nicht mehr möglich." }, 409, corsHeaders);
    }
    if (!aktion.bestellungen || typeof aktion.bestellungen !== "object") aktion.bestellungen = {};

    // ⚠️ Das Passwort wurde oben gegen den ERSTEN Lesestand geprueft. Steht dort
    // jetzt ein anderes (ein Bearbeiter hat zurueckgesetzt, jemand hat die
    // Bestellung geloescht und neu angelegt), gilt diese Pruefung nicht mehr --
    // dann lieber abbrechen als mit einer Berechtigung schreiben, die einem
    // ueberholten Stand galt.
    const jetzt = kbExternEintrag(aktion, ident.schluessel);
    const jetztHash = (jetzt && jetzt.pw && jetzt.pw.hash) ? jetzt.pw.hash : null;
    if (jetztHash !== (altesPw ? altesPw.hash : null)) {
      return json({ error: "Die Bestellung wurde zwischenzeitlich geändert. Bitte die Seite neu laden." }, 409, corsHeaders);
    }

    // Aus dem frischen Katalog neu bauen -- ein Bearbeiter kann einen Artikel
    // inzwischen deaktiviert oder eine Groesse gestrichen haben.
    const frischePositionen = kbExternPositionen(aktion, body && body.positionen);
    const zeitpunkt = new Date().toISOString();
    aktion.bestellungen[ident.schluessel] = {
      vorname: ident.vorname,
      nachname: ident.nachname,
      jahrgang: ident.jahrgang,
      quelle: "extern",
      pw: pwFeld,
      positionen: frischePositionen,
      kommentar,
      letzteAenderung: zeitpunkt
    };

    try {
      await writeJson(url, authHeader, doc, rev);
      return json({ ok: true, letzteAenderung: zeitpunkt, positionen: frischePositionen }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 3) continue;
      if (e instanceof ConflictError) {
        return json({ error: "Gerade hat jemand anderes gespeichert. Bitte noch einmal absenden.", conflict: true }, 409, corsHeaders);
      }
      return json({ error: "Die Bestellung konnte nicht gespeichert werden." }, 502, corsHeaders);
    }
  }
}

// ============================================================================
// Kleiderbörse — Familien geben Vereinskleidung weiter
// ============================================================================
//
// Geschlossener Block am Dateiende, wie die Kleiderbestellung darüber: am Stück
// wieder herauslösbar.
//
// Der KOMPLETTE Eltern-Weg läuft ohne Login — Eltern haben kein Vereinskonto.
// Ausweis ist der geheime Schlüssel aus meta.externToken (64 Hex, erzeugt in der
// Verwaltung der App). Er steckt in dem Link, den der Verein an die Mannschaften
// verteilt. Zurückgezogen wird er, indem meta.externToken geleert wird; ein Flag
// gibt es bewusst nicht, damit es nur eine Wahrheit darüber gibt, ob ein Link gilt.
//
// ⚠️ Was diese Handler ausliefern, ist bewusst weniger, als in der Datei steht:
// angebote[].anbieter (Name + E-Mail einer Vereinsfamilie) und die Anfragen mit
// den Kontaktdaten der Interessenten verlassen den Worker NIE in Richtung der
// Eltern-Seite. Das Ausblenden passiert hier, nicht im Browser — sonst stünde es
// im Netzwerk-Mitschnitt jeder Seitenansicht.
//
// Datenschema (kleiderboerse.json):
//   { meta:   { externToken, hinweis },
//     listen: { arten[], groessen[], zustaende[] },
//     angebote: [ { id, status: "wartet"|"frei"|"vergeben",
//                   art, groesse, zustand, bemerkung,
//                   fotos: [ { id, contentType } ],
//                   anbieter: { vorname, nachname, email },
//                   wegToken,                       // 32 Hex, "ist weg"-Link
//                   erstelltAm, freigegebenAm, freigegebenVon,
//                   vergebenAm, vergebenVon,
//                   anfragen: [ { id, vorname, nachname, email, telefon,
//                                 nachricht, am } ] } ] }

const KBO_APP = "kleiderboerse";

// Adresse der Eltern-Seite. Steht HIER und nicht im Request-Body: der Link geht
// in eine E-Mail hinaus, und ein vom Client mitgeschickter Ziel-Link wäre eine
// offene Tür, jedem beliebige Adressen im Namen des Vereins zuzustellen.
const KBO_SPIELER_URL = "https://sc1911heiligenstadt.github.io/kleiderboerse/spieler.html";

const KBO_MAX_FOTOS = 3;
const KBO_MAX_FOTO_BYTES = 5 * 1024 * 1024; // 5 MB — der Client verkleinert vorher auf ~1200 px
const KBO_MAX_ANGEBOTE = 400;               // Deckel gegen Vollmüllen der Datei
const KBO_MAX_ANFRAGEN_JE_ANGEBOT = 30;

// Zählwerk je IP. Deckel großzügig, weil eine einzige Seitenansicht schon
// mehrere Aufrufe macht (start + ein foto-get je Bild) und eine ganze Familie
// hinter derselben Mobilfunk-Adresse sitzen kann.
const KBO_IP_ZAEHLER = new Map();
const KBO_IP_MAX_PRO_STUNDE = 300;
// Getrennter, viel knapperer Deckel für die Wege, die etwas ANLEGEN oder eine
// E-Mail auslösen. Sonst deckte das große Kontingent oben auch das Verschicken
// von 300 Mails je Stunde ab.
const KBO_SCHREIB_ZAEHLER = new Map();
const KBO_SCHREIB_MAX_PRO_STUNDE = 20;

function kboBremse(map, max, request) {
  const ip = String((request && request.headers && request.headers.get("CF-Connecting-IP")) || "");
  if (!ip) return true;
  const jetzt = Date.now();
  const eintrag = map.get(ip);
  if (!eintrag || jetzt - eintrag.start > 3600000) {
    map.set(ip, { start: jetzt, n: 1 });
    // Aufraeumen, damit die Map in einem langlebigen Isolate nicht waechst.
    if (map.size > 500) {
      for (const [k, v] of map) {
        if (jetzt - v.start > 3600000) map.delete(k);
      }
    }
    return true;
  }
  eintrag.n++;
  return eintrag.n <= max;
}

function kboHexToken(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function kboNormalize(doc) {
  const d = doc && typeof doc === "object" ? doc : {};
  d.meta = d.meta && typeof d.meta === "object" ? d.meta : {};
  d.listen = d.listen && typeof d.listen === "object" ? d.listen : {};
  ["arten", "groessen", "zustaende"].forEach((k) => {
    if (!Array.isArray(d.listen[k])) d.listen[k] = [];
  });
  if (!Array.isArray(d.angebote)) d.angebote = [];
  return d;
}

// Gemeinsame Vorprüfung aller kbo-extern-*-Aktionen mit Link-Schlüssel.
// Reihenfolge ist Absicht: Formprüfung (kostenlos) vor Zählwerk vor Dateizugriff.
async function kboLaden(request, body, authHeader, corsHeaders) {
  const token = String((body && body.token) || "");
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return { fehler: json({ error: "Dieser Link ist nicht vollständig." }, 400, corsHeaders) };
  }
  if (!kboBremse(KBO_IP_ZAEHLER, KBO_IP_MAX_PRO_STUNDE, request)) {
    return { fehler: json({ error: "Zu viele Zugriffe — bitte später noch einmal versuchen." }, 429, corsHeaders) };
  }

  const url = DAV_APPS[KBO_APP];
  const { data, rev } = await readJsonWithRev(url, authHeader, null);
  const doc = kboNormalize(data);
  const gueltig = String(doc.meta.externToken || "");
  // Kein gesetzter Token heisst: es gibt gerade keinen gueltigen Link. Ein
  // leerer Vergleichswert darf NIEMALS zu einem Treffer fuehren.
  if (!gueltig || gueltig !== token) {
    return { fehler: json({ error: "Dieser Link ist nicht (mehr) gültig. Bitte beim Verein nach dem aktuellen Link fragen." }, 403, corsHeaders) };
  }
  return { doc, rev, url, token };
}

// Ein Angebot so, wie es die Eltern-Seite sehen darf. Kein Name, keine E-Mail,
// keine Anfragen — von den Fotos nur die Ids, mit denen kbo-extern-foto-get
// dann das einzelne Bild liefert.
function kboOeffentlich(a) {
  return {
    id: String(a.id || ""),
    art: String(a.art || ""),
    groesse: String(a.groesse || ""),
    zustand: String(a.zustand || ""),
    bemerkung: capStr(a.bemerkung, 500),
    fotos: (Array.isArray(a.fotos) ? a.fotos : []).slice(0, KBO_MAX_FOTOS).map((f) => String(f && f.id || "")).filter(Boolean)
  };
}

// ---------- kbo-extern-start (OHNE Login) ----------
// Was hinter dem Link steht: die Auswahllisten, der Hinweistext der Verwaltung
// und die freigegebenen Angebote.
//
// ⚠️ "wartet" und "vergeben" werden hier NICHT ausgeliefert. Was noch nicht
// freigegeben ist, hat niemand ausser der Verwaltung je zu sehen; was vergeben
// ist, wuerde nur Anfragen auf etwas ausloesen, das es nicht mehr gibt.
async function handleKboExternStart(request, body, env, authHeader, corsHeaders) {
  const geladen = await kboLaden(request, body, authHeader, corsHeaders);
  if (geladen.fehler) return geladen.fehler;
  const doc = geladen.doc;

  const angebote = doc.angebote
    .filter((a) => a && a.status === "frei")
    .sort((x, y) => String(y.freigegebenAm || "").localeCompare(String(x.freigegebenAm || "")))
    .map(kboOeffentlich);

  return json({
    hinweis: capStr(doc.meta.hinweis, 1000),
    listen: {
      arten: doc.listen.arten.slice(0, 100).map(String),
      groessen: doc.listen.groessen.slice(0, 100).map(String),
      zustaende: doc.listen.zustaende.slice(0, 50).map(String)
    },
    angebote
  }, 200, corsHeaders);
}

// ---------- kbo-extern-foto-put (OHNE Login) ----------
// Ein verkleinertes Foto ablegen, BEVOR das zugehoerige Angebot existiert (der
// Client erzeugt die Id selbst und reicht sie danach mit kbo-extern-anbieten
// nach). Bricht es dazwischen ab, bleibt hoechstens eine Bilddatei ohne Angebot
// liegen -- besser als ein Angebot ohne Bilder, das ein Bearbeiter freigeben
// koennte, ohne zu sehen, worum es geht.
async function handleKboExternFotoPut(request, body, env, authHeader, corsHeaders) {
  const geladen = await kboLaden(request, body, authHeader, corsHeaders);
  if (geladen.fehler) return geladen.fehler;
  if (!kboBremse(KBO_SCHREIB_ZAEHLER, KBO_SCHREIB_MAX_PRO_STUNDE, request)) {
    return json({ error: "Zu viele Uploads in kurzer Zeit — bitte später noch einmal versuchen." }, 429, corsHeaders);
  }

  const id = String(body.id || "");
  if (!FILE_ID_RE.test(id)) return json({ error: "Ungültige Foto-Kennung." }, 400, corsHeaders);

  let bytes;
  try {
    bytes = base64ToBytes(String(body.dataBase64 || ""));
  } catch (_) {
    return json({ error: "Das Bild konnte nicht gelesen werden." }, 400, corsHeaders);
  }
  if (bytes.length === 0) return json({ error: "Das Bild ist leer." }, 400, corsHeaders);
  if (bytes.length > KBO_MAX_FOTO_BYTES) return json({ error: "Das Bild ist zu groß." }, 413, corsHeaders);

  // Nur echte Bilder. Der Client schickt immer image/jpeg (er rechnet ueber ein
  // Canvas um), aber der Content-Type kommt aus dem Netz und ist damit eine
  // Behauptung -- deshalb zusaetzlich die ersten Bytes pruefen.
  const ctype = String(body.contentType || "").replace(/[^\x20-\x7e]/g, "");
  if (!/^image\/(jpeg|png|webp)$/.test(ctype)) {
    return json({ error: "Es werden nur Bilder angenommen." }, 400, corsHeaders);
  }
  const istJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const istPng  = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const istWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  if (!istJpeg && !istPng && !istWebp) {
    return json({ error: "Diese Datei ist kein Bild." }, 400, corsHeaders);
  }

  const dir = davFileDir(KBO_APP);
  const fileUrl = dir + "/" + id;
  const headers = { Authorization: authHeader, "Content-Type": ctype };
  let resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  if (resp.status === 409 || resp.status === 404) {
    await ensureCollection(dir, authHeader, 0);
    resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
  }
  if (!resp.ok) return json({ error: `Nextcloud PUT ${resp.status}` }, 502, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

// ---------- kbo-extern-foto-get (OHNE Login) ----------
// Ein einzelnes Bild ausliefern.
//
// ⚠️ Die Foto-Id allein reicht NICHT: es muss das Foto eines FREIGEGEBENEN
// Angebots sein. Sonst liesse sich mit dem Link jede Datei aus dem dateien/-
// Ordner ziehen -- auch die eines noch nicht geprueften oder abgelehnten
// Angebots. Deshalb wird angebotId mitverlangt und die Zugehoerigkeit geprueft.
async function handleKboExternFotoGet(request, body, env, authHeader, corsHeaders) {
  const geladen = await kboLaden(request, body, authHeader, corsHeaders);
  if (geladen.fehler) return geladen.fehler;

  const angebotId = String(body.angebotId || "");
  const fotoId = String(body.fotoId || "");
  if (!FILE_ID_RE.test(fotoId)) return json({ error: "Ungültige Foto-Kennung." }, 400, corsHeaders);

  const angebot = geladen.doc.angebote.find((a) => a && String(a.id) === angebotId);
  if (!angebot || angebot.status !== "frei") {
    return json({ error: "Dieses Bild gibt es nicht." }, 404, corsHeaders);
  }
  const gehoertDazu = (Array.isArray(angebot.fotos) ? angebot.fotos : []).some((f) => f && String(f.id) === fotoId);
  if (!gehoertDazu) return json({ error: "Dieses Bild gibt es nicht." }, 404, corsHeaders);

  const resp = await fetch(davFileDir(KBO_APP) + "/" + fotoId, { headers: { Authorization: authHeader } });
  if (!resp.ok) return json({ error: "Dieses Bild gibt es nicht." }, 404, corsHeaders);
  return new Response(resp.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": resp.headers.get("Content-Type") || "image/jpeg",
      // Kein oeffentlicher Cache: die Antwort haengt am Link-Schluessel.
      "Cache-Control": "private, max-age=300"
    }
  });
}

// ---------- kbo-extern-anbieten (OHNE Login) ----------
// Ein Kleidungsstueck einstellen. Landet IMMER auf status "wartet" -- der
// Status wird server-hart gesetzt und nie aus dem Body uebernommen, sonst
// stellte sich jeder mit dem Link an der Freigabe vorbei direkt in die Boerse.
async function handleKboExternAnbieten(request, body, env, authHeader, corsHeaders) {
  if (!kboBremse(KBO_SCHREIB_ZAEHLER, KBO_SCHREIB_MAX_PRO_STUNDE, request)) {
    return json({ error: "Zu viele Angebote in kurzer Zeit — bitte später noch einmal versuchen." }, 429, corsHeaders);
  }

  for (let versuch = 1; versuch <= 3; versuch++) {
    const geladen = await kboLaden(request, body, authHeader, corsHeaders);
    if (geladen.fehler) return geladen.fehler;
    const { doc, rev, url } = geladen;

    if (doc.angebote.length >= KBO_MAX_ANGEBOTE) {
      return json({ error: "Die Börse ist gerade voll. Bitte später noch einmal versuchen." }, 429, corsHeaders);
    }

    // Art, Groesse und Zustand MUESSEN aus den gepflegten Listen stammen. Frei
    // getippte Werte kaemen sonst durch den Filter der App nie wieder zum
    // Vorschein -- und ein Freitextfeld waere zugleich der bequemste Weg,
    // beliebigen Text auf einer Vereinsseite unterzubringen.
    const art = capStr(body.art, 100);
    const groesse = capStr(body.groesse, 40);
    const zustand = capStr(body.zustand, 60);
    if (!doc.listen.arten.includes(art)) return json({ error: "Bitte auswählen, was es ist." }, 400, corsHeaders);
    if (!doc.listen.groessen.includes(groesse)) return json({ error: "Bitte eine Größe aus der Liste wählen." }, 400, corsHeaders);
    if (!doc.listen.zustaende.includes(zustand)) return json({ error: "Bitte einen Zustand aus der Liste wählen." }, 400, corsHeaders);

    const vorname = capStr(body.vorname, 80);
    const nachname = capStr(body.nachname, 80);
    const email = capStr(body.email, 160);
    if (!vorname || !nachname) return json({ error: "Bitte Vorname und Nachname angeben." }, 400, corsHeaders);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Bitte eine gültige E-Mail-Adresse angeben." }, 400, corsHeaders);

    const fotos = (Array.isArray(body.fotos) ? body.fotos : [])
      .slice(0, KBO_MAX_FOTOS)
      .map((f) => {
        const fid = f && typeof f.id === "string" ? f.id : "";
        if (!FILE_ID_RE.test(fid)) return null;
        return { id: fid, contentType: capStr(f.contentType, 60).replace(/[^\x20-\x7e]/g, "") || "image/jpeg" };
      })
      .filter(Boolean);
    if (!fotos.length) return json({ error: "Bitte mindestens ein Foto hochladen." }, 400, corsHeaders);

    const id = crypto.randomUUID();
    doc.angebote.push({
      id,
      status: "wartet",           // server-hart, NIE aus dem Body
      quelle: "extern",           // ebenso
      art, groesse, zustand,
      bemerkung: capStr(body.bemerkung, 500),
      fotos,
      anbieter: { vorname, nachname, email },
      // Der Schluessel des "ist weg"-Links. Entsteht HIER, nicht im Browser:
      // er ist die Berechtigung, dieses eine Angebot zurueckzuziehen.
      wegToken: kboHexToken(16),
      erstelltAm: new Date().toISOString(),
      anfragen: []
    });

    try {
      await writeJson(url, authHeader, doc, rev);
      return json({ ok: true, id }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 3) continue;
      if (e instanceof ConflictError) {
        return json({ error: "Gerade hat jemand anderes gespeichert. Bitte noch einmal absenden.", conflict: true }, 409, corsHeaders);
      }
      return json({ error: "Das Angebot konnte nicht gespeichert werden." }, 502, corsHeaders);
    }
  }
}

// ---------- kbo-extern-anfragen (OHNE Login) ----------
// "Das moechte ich" -- die Anfrage wird am Angebot vermerkt UND der anbietenden
// Familie zugestellt. Die Mail ist der eigentliche Zweck; die Liste in der App
// ist der Nachlese-Ort, falls nichts passiert.
async function handleKboExternAnfragen(request, body, env, authHeader, corsHeaders) {
  if (!kboBremse(KBO_SCHREIB_ZAEHLER, KBO_SCHREIB_MAX_PRO_STUNDE, request)) {
    return json({ error: "Zu viele Anfragen in kurzer Zeit — bitte später noch einmal versuchen." }, 429, corsHeaders);
  }

  const vorname = capStr(body.vorname, 80);
  const nachname = capStr(body.nachname, 80);
  const email = capStr(body.email, 160);
  const telefon = capStr(body.telefon, 40);
  const nachricht = capStr(body.nachricht, 500);
  if (!vorname || !nachname) return json({ error: "Bitte Vorname und Nachname angeben." }, 400, corsHeaders);
  if (!email && !telefon) return json({ error: "Bitte eine E-Mail-Adresse oder eine Telefonnummer angeben." }, 400, corsHeaders);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "Diese E-Mail-Adresse sieht nicht richtig aus." }, 400, corsHeaders);
  }

  let angebotKopie = null;
  for (let versuch = 1; versuch <= 3; versuch++) {
    const geladen = await kboLaden(request, body, authHeader, corsHeaders);
    if (geladen.fehler) return geladen.fehler;
    const { doc, rev, url } = geladen;

    const angebot = doc.angebote.find((a) => a && String(a.id) === String(body.angebotId || ""));
    if (!angebot) return json({ error: "Dieses Angebot gibt es nicht mehr." }, 404, corsHeaders);
    if (angebot.status !== "frei") {
      return json({ error: "Dieses Kleidungsstück steht nicht mehr in der Börse." }, 410, corsHeaders);
    }
    if (!Array.isArray(angebot.anfragen)) angebot.anfragen = [];
    if (angebot.anfragen.length >= KBO_MAX_ANFRAGEN_JE_ANGEBOT) {
      return json({ error: "Zu diesem Kleidungsstück gibt es schon sehr viele Anfragen." }, 429, corsHeaders);
    }

    angebot.anfragen.push({
      id: crypto.randomUUID(),
      vorname, nachname, email, telefon, nachricht,
      am: new Date().toISOString()
    });
    angebotKopie = angebot;

    try {
      await writeJson(url, authHeader, doc, rev);
      break;
    } catch (e) {
      if (e instanceof ConflictError && versuch < 3) { angebotKopie = null; continue; }
      if (e instanceof ConflictError) {
        return json({ error: "Gerade hat jemand anderes gespeichert. Bitte noch einmal absenden.", conflict: true }, 409, corsHeaders);
      }
      return json({ error: "Die Anfrage konnte nicht gespeichert werden." }, 502, corsHeaders);
    }
  }
  if (!angebotKopie) return json({ error: "Die Anfrage konnte nicht gespeichert werden." }, 502, corsHeaders);

  // Ist die Anfrage einmal vermerkt, gilt sie als angekommen. Ein Mailfehler
  // danach ist ein stiller No-Op mit sent:false -- die Verwaltung sieht die
  // Anfrage trotzdem in ihrer Liste und kann von Hand nachfassen.
  const sent = await kboAnfrageMailSenden(env, angebotKopie, { vorname, nachname, email, telefon, nachricht });
  return json({ ok: true, sent }, 200, corsHeaders);
}

async function kboAnfrageMailSenden(env, angebot, anfrage) {
  if (!env.BREVO_API_KEY) return false;
  const empfaenger = String((angebot.anbieter && angebot.anbieter.email) || "");
  if (!empfaenger) return false;

  const wegLink = KBO_SPIELER_URL + "?weg=" + String(angebot.wegToken || "");
  const kontakt = [
    anfrage.email ? "E-Mail: " + anfrage.email : "",
    anfrage.telefon ? "Telefon: " + anfrage.telefon : ""
  ].filter(Boolean).join("\n");

  const text =
`Hallo ${angebot.anbieter.vorname || ""},

über die Kleiderbörse des 1. SC 1911 Heiligenstadt hat jemand Interesse an dem
Kleidungsstück, das du eingestellt hast:

  ${angebot.art || "Kleidungsstück"}, Größe ${angebot.groesse || "?"} (${angebot.zustand || ""})

Angefragt hat:

  ${anfrage.vorname} ${anfrage.nachname}
${kontakt.split("\n").map((z) => "  " + z).join("\n")}
${anfrage.nachricht ? "\nDazu die Nachricht:\n\n  " + anfrage.nachricht.split("\n").join("\n  ") + "\n" : ""}
Bitte melde dich direkt bei dieser Person und verabredet die Übergabe
untereinander. Der Verein ist dabei nicht weiter beteiligt.

Ist das Kleidungsstück vergeben? Dann nimm es bitte mit einem Klick aus der
Börse, damit sich niemand mehr darauf meldet:

  ${wegLink}

Vielen Dank, dass du die Sachen weitergibst.

Mit sportlichen Grüßen
1. SC 1911 e.V. Heilbad Heiligenstadt
Nachwuchsbereich

--
Diese E-Mail wurde automatisch verschickt, weil du ein Kleidungsstück in die
Kleiderbörse eingestellt hast. Deine Adresse wird ausschließlich dafür
verwendet und nicht weitergegeben.`;

  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        sender: { email: NOTIFY_FROM_EMAIL, name: NOTIFY_FROM_NAME },
        to: [{ email: empfaenger }],
        subject: "Kleiderbörse: Anfrage zu deinem Angebot",
        textContent: text
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("Kleiderbörse-Anfragemail fehlgeschlagen", resp.status, errText);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Kleiderbörse-Anfragemail fehlgeschlagen", e && e.message);
    return false;
  }
}

// ---------- kbo-extern-weg-info / kbo-extern-weg (OHNE Login) ----------
// Der Klick aus der E-Mail an die anbietende Familie. Ausweis ist hier NICHT der
// Link-Schluessel der Boerse, sondern der angebotseigene wegToken -- er gilt
// genau fuer dieses eine Angebot und ueberlebt auch das Zuruecksetzen des
// Boersen-Links.
async function kboAngebotZuWegToken(request, body, authHeader, corsHeaders) {
  const wegToken = String((body && body.wegToken) || "");
  if (!/^[0-9a-f]{32}$/.test(wegToken)) {
    return { fehler: json({ error: "Dieser Link ist nicht vollständig." }, 400, corsHeaders) };
  }
  if (!kboBremse(KBO_IP_ZAEHLER, KBO_IP_MAX_PRO_STUNDE, request)) {
    return { fehler: json({ error: "Zu viele Versuche — bitte später noch einmal versuchen." }, 429, corsHeaders) };
  }
  const url = DAV_APPS[KBO_APP];
  const { data, rev } = await readJsonWithRev(url, authHeader, null);
  const doc = kboNormalize(data);
  const angebot = doc.angebote.find((a) => a && String(a.wegToken || "") === wegToken);
  if (!angebot) {
    return { fehler: json({ error: "Dieser Link gehört zu keinem Angebot mehr. Vermutlich wurde es schon gelöscht." }, 404, corsHeaders) };
  }
  return { doc, rev, url, angebot };
}

async function handleKboExternWegInfo(request, body, env, authHeader, corsHeaders) {
  const g = await kboAngebotZuWegToken(request, body, authHeader, corsHeaders);
  if (g.fehler) return g.fehler;
  const a = g.angebot;
  return json({
    // Bewusst nur die Beschreibung des Stuecks -- der Link kann in fremde Haende
    // geraten sein, Name und Adresse der Familie haben darin nichts zu suchen.
    beschreibung: `${a.art || "Kleidungsstück"}, Größe ${a.groesse || "?"}`,
    schonWeg: a.status !== "frei"
  }, 200, corsHeaders);
}

async function handleKboExternWeg(request, body, env, authHeader, corsHeaders) {
  for (let versuch = 1; versuch <= 3; versuch++) {
    const g = await kboAngebotZuWegToken(request, body, authHeader, corsHeaders);
    if (g.fehler) return g.fehler;
    const { doc, rev, url, angebot } = g;

    // Schon vergeben oder noch gar nicht freigegeben: still als erledigt melden.
    // Ein zweiter Klick auf denselben Link in der E-Mail ist kein Fehlerfall.
    if (angebot.status !== "frei") return json({ ok: true, schonWeg: true }, 200, corsHeaders);

    angebot.status = "vergeben";
    angebot.vergebenAm = new Date().toISOString();
    angebot.vergebenVon = "extern"; // per Link der anbietenden Familie, nicht durch die Verwaltung

    try {
      await writeJson(url, authHeader, doc, rev);
      return json({ ok: true }, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 3) continue;
      if (e instanceof ConflictError) {
        return json({ error: "Gerade hat jemand anderes gespeichert. Bitte noch einmal versuchen.", conflict: true }, 409, corsHeaders);
      }
      return json({ error: "Es konnte nicht gespeichert werden." }, 502, corsHeaders);
    }
  }
}

// ============================================================================
// Spieltagscrew — wer übernimmt bei den Heimspielen welchen Posten
// ============================================================================
//
// Geschlossener Block am Dateiende, wie die Kleiderbestellung darüber: am
// Stück wieder herauslösbar.
//
// "spieltagscrew" steht mit Absicht NICHT in DAV_APPS. Es gibt damit keinen
// generischen dav-load/dav-save-Weg auf diese Datei — jeder Zugriff läuft
// über die Aktionen hier. Vier Zusagen dieser App lassen sich clientseitig
// nicht halten, und ein dav-save, das die ganze Datei entgegennimmt, wäre die
// offene Hintertür an allen vieren vorbei:
//
//   1. Ein voller Posten nimmt niemanden mehr an.
//   2. Eine Person steht je Spieltag auf höchstens einem Posten.
//   3. Wer sich einträgt, trägt sich selbst ein — fremde Namen darf nur
//      setzen, wer administriert.
//   4. Der Verlauf hält fest, wer wen ein- und ausgetragen hat.
//
// Ohne DAV_APPS-Eintrag braucht es auch keinen in
// WRITE_REQUIRES_EDIT_PERMISSION: dav-save läuft für diese App ohnehin in
// "Unbekannte App".
const SPIELTAGSCREW_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/Spieltagscrew/spieltagscrew.json";

const SC_MAX_SPIELTAGE = 500;
const SC_MAX_JOBS = 40;            // je Spieltag und im Katalog
const SC_MAX_ANZAHL = 50;          // Personen je Posten
const SC_MAX_VERLAUF = 400;        // je Spieltag
const SC_MAX_NAME = 80;
const SC_MAX_BESCHREIBUNG = 200;
const SC_MAX_GEGNER = 120;
const SC_MAX_NOTIZ = 500;
const SC_MIN_MINUTEN = -600;
const SC_MAX_MINUTEN = 600;
const SC_WETTBEWERBE = ["punktspiel", "pokal", "testspiel"];
const SC_MANNSCHAFTEN = ["erste"];
const SC_ERINNERUNG_TAGE_MAX = 60;

class ScFehler extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ScFehler";
    this.status = status || 400;
  }
}

function scAntwortFehler(e, corsHeaders) {
  if (e instanceof ScFehler) return json({ error: e.message }, e.status, corsHeaders);
  if (e instanceof ConflictError) return json({ error: "Gleichzeitige Änderung — bitte erneut versuchen" }, 409, corsHeaders);
  return json({ error: "Speicherfehler: " + (e && e.message ? e.message : "unbekannt") }, 502, corsHeaders);
}

// Jede Aktion verlangt eingeloggtes Personal MIT Sichtbarkeit auf das Tool.
// Spielerkonten sind wie überall in diesem Worker ausgeschlossen.
async function scSession(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return { fehler: json({ error: "Nicht angemeldet" }, 401, corsHeaders) };
  if (session.art === USER_ART_SPIELER) {
    return { fehler: json({ error: "Kein Zugriff auf die Spieltagscrew" }, 403, corsHeaders) };
  }
  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  if (!(await userMayAccessTool("spieltagscrew", session, env, authHeader, Promise.resolve(config)))) {
    return { fehler: json({ error: "Kein Zugriff auf dieses Tool" }, 403, corsHeaders) };
  }
  const canEdit = await resolveEditPermission("spieltagscrew", session, env, authHeader, Promise.resolve(config));
  const canAdmin = await resolveAdminPermission("spieltagscrew", session, env, authHeader, Promise.resolve(config));
  return { session, config, canEdit, canAdmin, fehler: null };
}

// Schreibende Aktionen zusätzlich hinter dem Bearbeiten-Recht. "Sehen" heißt
// in dieser App wirklich nur sehen — auch der Selbsteintrag ist ein
// Schreibvorgang und braucht die Stufe (Flottenregel vom 2026-07-24).
function scVerlangeEdit(ctx) {
  if (!ctx.canEdit) throw new ScFehler("Dafür fehlt dir das Bearbeiten-Recht", 403);
}

function scVerlangeAdmin(ctx) {
  if (!ctx.canAdmin) throw new ScFehler("Dafür fehlt dir das Administrieren-Recht", 403);
}

function scEinstellungenLeer() {
  return { erinnerungTage: 7, terminerinnerung: true, lagemeldung: true };
}

function scLeer() {
  return { version: 1, jobKatalog: [], spieltage: [], einstellungen: scEinstellungenLeer(), lauf: null };
}

function scNormalisiere(doc) {
  doc.version = doc.version || 1;
  if (!Array.isArray(doc.jobKatalog)) doc.jobKatalog = [];
  if (!Array.isArray(doc.spieltage)) doc.spieltage = [];
  if (!doc.einstellungen || typeof doc.einstellungen !== "object") doc.einstellungen = scEinstellungenLeer();
  doc.spieltage.forEach((s) => {
    if (!Array.isArray(s.jobs)) s.jobs = [];
    if (!Array.isArray(s.verlauf)) s.verlauf = [];
    s.jobs.forEach((j) => { if (!Array.isArray(j.besetzung)) j.besetzung = []; });
  });
  return doc;
}

// Read-modify-write mit If-Match und drei Versuchen — gleiches Muster wie
// vaMutiere. fn bekommt das Dokument, ändert es an Ort und Stelle und gibt
// zurück, was der Client als Antwort sehen soll.
async function scMutiere(authHeader, fn) {
  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(SPIELTAGSCREW_URL, authHeader, scLeer());
    scNormalisiere(doc);
    const ergebnis = fn(doc) || {};
    try {
      await writeJson(SPIELTAGSCREW_URL, authHeader, doc, rev || undefined);
      return { ok: true, ...ergebnis };
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      throw e;
    }
  }
  throw new ScFehler("Speichern nach drei Versuchen fehlgeschlagen", 502);
}

// ---------- Datum und Zeit ----------

// "Heute" in Europe/Berlin als ISO-Tag. sv-SE liefert genau YYYY-MM-DD.
// Serverseitig wäre ein bloßes new Date() reines UTC — ein Spieltag am Sonntag
// wäre dann ab 01:00 Ortszeit am Montag noch "heute".
function scHeuteBerlin() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

function scTagPlus(tage) {
  return new Date(Date.now() + tage * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

// Ein Spieltag zählt bis zum Ende seines Kalendertages als kommend — am
// Spieltag selbst soll sich noch jemand eintragen können. Dieselbe Grenze
// prüft der Client in istVergangen().
function scIstVergangen(s) {
  return String(s.datum || "") < scHeuteBerlin();
}

function scDatum(roh) {
  const s = capStr(roh, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function scUhrzeit(roh) {
  const s = capStr(roh, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : "";
}

function scMinuten(roh, vorgabe) {
  const n = Math.round(Number(roh));
  if (!Number.isFinite(n)) return vorgabe;
  return Math.max(SC_MIN_MINUTEN, Math.min(SC_MAX_MINUTEN, n));
}

// Uhrzeit aus Anstoß plus Minutenversatz. Spiegelt zeitVersetzt() im Client;
// negativ heißt "vor dem Anpfiff". Läuft der Wert über Mitternacht, wird sauber
// umgeschlagen statt 25:30 auszugeben.
function scZeitVersetzt(anstoss, min) {
  const teile = String(anstoss || "15:00").split(":");
  const basis = (Number(teile[0]) || 0) * 60 + (Number(teile[1]) || 0);
  const roh = basis + (Number(min) || 0);
  const imTag = ((roh % 1440) + 1440) % 1440;
  return String(Math.floor(imTag / 60)).padStart(2, "0") + ":" + String(imTag % 60).padStart(2, "0");
}

// ---------- Säuberung ----------

// Jobs werden IMMER serverseitig neu zusammengesetzt. Der Client schickt nur
// die Felder unten; besetzung, id und katalogId bestimmt der Worker — sonst
// könnte ein Aufrufer sich über ein mitgeschicktes besetzung-Feld selbst (oder
// Fremde) auf jeden Posten setzen.
function scJobAusEingabe(roh, bestand) {
  const name = capStr(roh && roh.name, SC_MAX_NAME).trim();
  if (!name) throw new ScFehler("Jeder Posten braucht einen Namen", 400);
  return {
    id: (bestand && bestand.id) || crypto.randomUUID(),
    katalogId: (bestand && bestand.katalogId) || capStr(roh && roh.katalogId, 60) || "",
    name,
    beschreibung: capStr(roh && roh.beschreibung, SC_MAX_BESCHREIBUNG).trim(),
    anzahl: Math.max(1, Math.min(SC_MAX_ANZAHL, Math.round(Number(roh && roh.anzahl)) || 1)),
    vonMin: scMinuten(roh && roh.vonMin, -90),
    bisMin: scMinuten(roh && roh.bisMin, 0),
    besetzung: (bestand && Array.isArray(bestand.besetzung)) ? bestand.besetzung : []
  };
}

// Eine Kopie des Katalogs in den Spieltag. Bewusst eine Kopie und keine
// Referenz: eine spätere Änderung am Katalog darf bestehende und bereits
// besetzte Spieltage nicht umschreiben.
function scJobsAusKatalog(katalog) {
  return katalog.map((k) => ({
    id: crypto.randomUUID(),
    katalogId: k.id || "",
    name: k.name,
    beschreibung: k.beschreibung || "",
    anzahl: k.anzahl,
    vonMin: k.vonMin,
    bisMin: k.bisMin,
    besetzung: []
  }));
}

function scSpieltagHolen(doc, id) {
  const s = doc.spieltage.find((x) => x && x.id === String(id || ""));
  if (!s) throw new ScFehler("Spieltag nicht gefunden", 404);
  return s;
}

function scJobHolen(s, jobId) {
  const j = (s.jobs || []).find((x) => x && x.id === String(jobId || ""));
  if (!j) throw new ScFehler("Posten nicht gefunden", 404);
  return j;
}

function scVerlaufSchreiben(s, eintrag) {
  s.verlauf.push(eintrag);
  if (s.verlauf.length > SC_MAX_VERLAUF) s.verlauf = s.verlauf.slice(-SC_MAX_VERLAUF);
}

// Wer an diesem Spieltag schon irgendwo steht — und wo. Das ist die Zusage
// "ein Posten pro Person und Spieltag", und sie fällt hier, nicht im Client.
function scPostenVon(s, username) {
  return (s.jobs || []).find((j) => (j.besetzung || []).some((b) => b && b.username === username)) || null;
}

// Wessen Name eingetragen wird. Der eigene kommt IMMER aus dem Token; ein
// fremder Name im Körper ist ausschließlich mit Administrieren erlaubt. Ohne
// diese Schranke könnte jeder Bearbeiter beliebige Leute auf Posten setzen und
// wieder herunterwerfen.
function scZielUser(ctx, roh) {
  const gewuenscht = normalizeUsername(String(roh || ""));
  const selbst = ctx.session.username;
  if (!gewuenscht || gewuenscht === normalizeUsername(selbst)) return selbst;
  if (!ctx.canAdmin) throw new ScFehler("Andere eintragen darf nur, wer die Spieltagscrew administriert", 403);
  return gewuenscht;
}

// ---------- Laden ----------

async function handleScLoad(request, env, authHeader, corsHeaders) {
  const ctx = await scSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;

  const doc = scNormalisiere(await readJson(SPIELTAGSCREW_URL, authHeader, scLeer()));

  // Anzeigenamen aus nutzer.json (steckt in der Sitzung, kostet keinen
  // zusätzlichen Read). Bewusst nicht im Eintrag gespeichert: nach einer
  // Umbenennung soll ein alter Eintrag nicht den früheren Namen zeigen.
  const namen = Object.create(null);
  const merke = (u) => {
    if (u && !namen[u]) namen[u] = aufgabenAnzeigeName(ctx.session.usersDoc, u);
  };
  doc.spieltage.forEach((s) => (s.jobs || []).forEach((j) => (j.besetzung || []).forEach((b) => {
    if (!b) return;
    merke(b.username);
    merke(b.von);
  })));
  // Der eigene Name IMMER — sonst steht in der Kopfzeile der Anmeldename,
  // solange man selbst noch auf keinem Posten steht.
  merke(ctx.session.username);

  return json({
    jobKatalog: doc.jobKatalog,
    spieltage: doc.spieltage,
    einstellungen: doc.einstellungen,
    // Der Lauf-Status ist eine Betriebsangabe und geht nur an die Verwaltung.
    lauf: ctx.canAdmin ? (doc.lauf || null) : null,
    namen,
    me: {
      username: ctx.session.username, isAdmin: !!ctx.session.isAdmin,
      canEdit: ctx.canEdit, canAdmin: ctx.canAdmin
    }
  }, 200, corsHeaders);
}

// ---------- Ein- und Austragen ----------

async function handleScEintragen(request, body, env, authHeader, corsHeaders, execCtx) {
  const ctx = await scSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    scVerlangeEdit(ctx);
    const ziel = scZielUser(ctx, body.username);
    const fremd = ziel !== ctx.session.username;

    const ergebnis = await scMutiere(authHeader, (doc) => {
      const s = scSpieltagHolen(doc, body.spieltagId);
      if (scIstVergangen(s)) throw new ScFehler("Dieser Spieltag liegt zurück — die Besetzung lässt sich nicht mehr ändern", 400);
      const job = scJobHolen(s, body.jobId);

      const schon = scPostenVon(s, ziel);
      if (schon) {
        throw new ScFehler(schon.id === job.id
          ? "Auf diesem Posten steht die Person bereits"
          : `An diesem Spieltag ist schon der Posten "${schon.name}" übernommen — mehr als einer geht nicht`, 409);
      }
      if (job.besetzung.length >= (Number(job.anzahl) || 0)) {
        throw new ScFehler("Dieser Posten ist bereits vollständig besetzt", 409);
      }

      job.besetzung.push({ username: ziel, am: new Date().toISOString(), von: ctx.session.username });
      scVerlaufSchreiben(s, {
        am: new Date().toISOString(), von: ctx.session.username,
        was: fremd ? "gesetzt" : "eingetragen", wen: ziel, jobId: job.id, jobName: job.name
      });
      return { spieltagId: s.id, jobId: job.id };
    });

    return json(ergebnis, 200, corsHeaders);
  } catch (e) {
    return scAntwortFehler(e, corsHeaders);
  }
}

async function handleScAustragen(request, body, env, authHeader, corsHeaders, execCtx) {
  const ctx = await scSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    scVerlangeEdit(ctx);
    const ziel = scZielUser(ctx, body.username);
    const fremd = ziel !== ctx.session.username;

    // Der Versand steht AUSSERHALB von scMutiere(): dessen Callback läuft bei
    // einem If-Match-Konflikt bis zu dreimal, die Nachricht ginge sonst
    // mehrfach raus. Deshalb reicht das Closure die Meldung zurück.
    const { pushText, ...ergebnis } = await scMutiere(authHeader, (doc) => {
      const s = scSpieltagHolen(doc, body.spieltagId);
      if (scIstVergangen(s)) throw new ScFehler("Dieser Spieltag liegt zurück — die Besetzung lässt sich nicht mehr ändern", 400);
      const job = scJobHolen(s, body.jobId);

      const vorher = job.besetzung.length;
      job.besetzung = job.besetzung.filter((b) => !(b && b.username === ziel));
      if (job.besetzung.length === vorher) throw new ScFehler("Auf diesem Posten steht die Person nicht", 404);

      scVerlaufSchreiben(s, {
        am: new Date().toISOString(), von: ctx.session.username,
        was: fremd ? "entfernt" : "ausgetragen", wen: ziel, jobId: job.id, jobName: job.name
      });
      // Nur ein Selbst-Austrag ist eine Nachricht wert: setzt die Verwaltung
      // selbst jemanden ab, weiß sie es ohnehin.
      return { spieltagId: s.id, jobId: job.id, pushText: fremd ? "" : "Ein Posten an einem Heimspieltag ist wieder frei geworden. In der Spieltagscrew kannst du ihn neu besetzen." };
    });

    if (pushText) {
      // Empfänger sind die Administrierenden — ein kurzfristig frei gewordener
      // Posten fällt sonst niemandem auf. Der Text nennt weder Namen noch
      // Spieltag: er steht auf dem Sperrbildschirm.
      const admins = await scAdminEmpfaenger(env, authHeader, ctx.session.usersDoc, ctx.session.username);
      if (admins.length) pushSenden(env, authHeader, execCtx, admins, "spieltagscrew", pushText);
    }
    return json(ergebnis, 200, corsHeaders);
  } catch (e) {
    return scAntwortFehler(e, corsHeaders);
  }
}

// ---------- Spieltage (Administrieren) ----------

async function handleScSpieltagSpeichern(request, body, env, authHeader, corsHeaders) {
  const ctx = await scSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    scVerlangeAdmin(ctx);
    const roh = body.spieltag || {};
    const datum = scDatum(roh.datum);
    const anstoss = scUhrzeit(roh.anstoss);
    const gegner = capStr(roh.gegner, SC_MAX_GEGNER).trim();
    if (!datum) throw new ScFehler("Bitte ein gültiges Datum angeben", 400);
    if (!anstoss) throw new ScFehler("Bitte eine gültige Anstoßzeit angeben", 400);
    if (!gegner) throw new ScFehler("Bitte den Gegner angeben", 400);

    const kopf = {
      datum, anstoss, gegner,
      wettbewerb: SC_WETTBEWERBE.includes(String(roh.wettbewerb)) ? String(roh.wettbewerb) : "punktspiel",
      mannschaft: SC_MANNSCHAFTEN.includes(String(roh.mannschaft)) ? String(roh.mannschaft) : "erste",
      notiz: capStr(roh.notiz, SC_MAX_NOTIZ).trim()
    };

    const ergebnis = await scMutiere(authHeader, (doc) => {
      const id = capStr(roh.id, 60);
      let s;
      if (id) {
        s = scSpieltagHolen(doc, id);
        Object.assign(s, kopf);
      } else {
        if (doc.spieltage.length >= SC_MAX_SPIELTAGE) throw new ScFehler("Es sind zu viele Spieltage angelegt", 400);
        s = Object.assign({
          id: crypto.randomUUID(), erstelltAm: new Date().toISOString(), erstelltVon: ctx.session.username,
          jobs: scJobsAusKatalog(doc.jobKatalog), verlauf: []
        }, kopf);
        doc.spieltage.push(s);
      }

      // Die Postenliste ist OPTIONAL. Fehlt sie, bleibt sie unberührt — sonst
      // löschte ein Kopf-Speichern ohne jobs-Feld alle Posten samt Besetzung.
      // Ist sie da, wird über die Job-Id zusammengeführt.
      if (Array.isArray(roh.jobs)) {
        if (roh.jobs.length > SC_MAX_JOBS) throw new ScFehler("Zu viele Posten an einem Spieltag", 400);
        const alt = s.jobs || [];
        const neu = roh.jobs.map((j) => scJobAusEingabe(j, alt.find((a) => a.id === capStr(j && j.id, 60)) || null));
        // Ein Posten, auf dem noch jemand steht, darf nicht mitsamt Besetzung
        // verschwinden — sonst fällt eine Zusage still unter den Tisch.
        const behalten = new Set(neu.map((j) => j.id));
        const verlorene = alt.filter((a) => !behalten.has(a.id) && (a.besetzung || []).length);
        if (verlorene.length) {
          throw new ScFehler(`Auf "${verlorene[0].name}" steht noch jemand — bitte zuerst austragen`, 409);
        }
        // Eine gesenkte Personenzahl wirkt NICHT rückwirkend: wer schon
        // zugesagt hat, bleibt stehen. Die Zahl steigt dann eben mit.
        neu.forEach((j) => { if (j.besetzung.length > j.anzahl) j.anzahl = j.besetzung.length; });
        s.jobs = neu;
      }
      return { id: s.id };
    });

    return json(ergebnis, 200, corsHeaders);
  } catch (e) {
    return scAntwortFehler(e, corsHeaders);
  }
}

async function handleScSpieltagLoeschen(request, body, env, authHeader, corsHeaders) {
  const ctx = await scSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    scVerlangeAdmin(ctx);
    const ergebnis = await scMutiere(authHeader, (doc) => {
      const s = scSpieltagHolen(doc, body.id);
      doc.spieltage = doc.spieltage.filter((x) => x.id !== s.id);
      return { geloescht: s.id };
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) {
    return scAntwortFehler(e, corsHeaders);
  }
}

// ---------- Job-Katalog (Administrieren) ----------

async function handleScKatalogSpeichern(request, body, env, authHeader, corsHeaders) {
  const ctx = await scSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    scVerlangeAdmin(ctx);
    const roh = Array.isArray(body.jobKatalog) ? body.jobKatalog : [];
    if (roh.length > SC_MAX_JOBS) throw new ScFehler("Zu viele Posten im Katalog", 400);

    const ergebnis = await scMutiere(authHeader, (doc) => {
      const alt = doc.jobKatalog || [];
      doc.jobKatalog = roh.map((j, i) => {
        const bestand = alt.find((a) => a.id === capStr(j && j.id, 60)) || null;
        const gebaut = scJobAusEingabe(j, bestand);
        // Der Katalog ist eine Vorlage und trägt selbst keine Besetzung.
        delete gebaut.besetzung;
        delete gebaut.katalogId;
        gebaut.sortierung = i;
        gebaut.aktiv = true;
        return gebaut;
      });
      // Bestehende Spieltage bleiben ausdrücklich unberührt — sie tragen ihre
      // eigene Kopie. Genau dafür ist der Katalog eine Vorlage.
      return { anzahl: doc.jobKatalog.length };
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) {
    return scAntwortFehler(e, corsHeaders);
  }
}

// ---------- Einstellungen (Administrieren) ----------

async function handleScEinstellungenSpeichern(request, body, env, authHeader, corsHeaders) {
  const ctx = await scSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    scVerlangeAdmin(ctx);
    const roh = body.einstellungen || {};
    const tage = Math.round(Number(roh.erinnerungTage));
    if (!(tage >= 1 && tage <= SC_ERINNERUNG_TAGE_MAX)) {
      throw new ScFehler("Die Frist muss zwischen 1 und " + SC_ERINNERUNG_TAGE_MAX + " Tagen liegen", 400);
    }
    const ergebnis = await scMutiere(authHeader, (doc) => {
      doc.einstellungen = {
        erinnerungTage: tage,
        terminerinnerung: roh.terminerinnerung !== false,
        lagemeldung: roh.lagemeldung !== false
      };
      return { einstellungen: doc.einstellungen };
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) {
    return scAntwortFehler(e, corsHeaders);
  }
}

// ---------- Erinnerung von Hand (Administrieren) ----------

// Dieselbe Auswahl-Logik wie der nächtliche Lauf, nur sofort und mit sichtbarem
// Ergebnis. Damit lässt sich der Automatiklauf gegenprüfen, ohne bis zum
// nächsten Morgen zu warten — und ein stiller Fehlschlag um 4 Uhr nachts fällt
// sonst niemandem auf.
async function handleScErinnern(request, body, env, authHeader, corsHeaders, execCtx) {
  const ctx = await scSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    scVerlangeAdmin(ctx);
    const bericht = await scAufrufVerschicken(env, authHeader, execCtx, {
      nurSpieltagId: capStr(body.spieltagId, 60),
      ausloeser: ctx.session.username
    });
    return json({ ok: true, ...bericht }, 200, corsHeaders);
  } catch (e) {
    return scAntwortFehler(e, corsHeaders);
  }
}

// ---------- Empfängerkreise ----------

// Nur die Administrierenden. pushEmpfaengerMitRecht liefert Bearbeiter UND
// Administrierende zusammen; für die Lagemeldung ist das zu weit.
async function scAdminEmpfaenger(env, authHeader, usersDoc, ausser) {
  const config = await readJson(env.NEXTCLOUD_URL, authHeader, { version: 1, tools: {} });
  const entry = getOwn(config.tools || {}, "spieltagscrew") || {};
  const gruppen = Array.isArray(entry.adminGroupIds) ? entry.adminGroupIds : [];
  const users = (usersDoc && usersDoc.users) || {};
  const weg = normalizeUsername(String(ausser || ""));
  const out = [];
  for (const schluessel of Object.keys(users)) {
    const u = users[schluessel];
    if (!u || u.archiviert || !istPersonal(u)) continue;
    const name = normalizeUsername(u.username || schluessel);
    if (weg && name === weg) continue;
    if (u.isAdmin) { out.push(name); continue; }
    const meine = getUserGroupIds(usersDoc, schluessel);
    if (gruppen.some((g) => meine.indexOf(g) !== -1)) out.push(name);
  }
  return out;
}

// ---------- Der eigentliche Erinnerungslauf ----------

// Wird von zwei Stellen gerufen: von Hand über spieltagscrew-erinnern und
// nächtlich aus scheduled(). Beide teilen sich diese Funktion, damit die
// Auswahl nicht auseinanderläuft — eine zweite Kopie wäre genau die Art Code,
// die man nie wieder anfasst und die dann etwas anderes tut.
//
// optionen.nurSpieltagId — nur diesen einen Spieltag (Hand-Auslösung)
// optionen.nurFrist      — nur die Spieltage genau an der eingestellten Frist
// optionen.mitTermin     — zusätzlich die Terminerinnerung für morgen
// optionen.ausloeser     — bekommt selbst keine Nachricht
async function scAufrufVerschicken(env, authHeader, execCtx, optionen) {
  const opt = optionen || {};
  const doc = scNormalisiere(await readJson(SPIELTAGSCREW_URL, authHeader, scLeer()));
  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  const tage = Math.max(1, Math.min(SC_ERINNERUNG_TAGE_MAX, Number(doc.einstellungen.erinnerungTage) || 7));

  const zielTag = scTagPlus(tage);
  const morgen = scTagPlus(1);
  const heute = scHeuteBerlin();

  // Von Hand zählt der gewählte Spieltag (oder alle kommenden), nächtlich genau
  // die Spieltage an der Frist. Sonst meldete sich die App jede Nacht erneut
  // für dasselbe Spiel.
  const kandidaten = doc.spieltage.filter((s) => {
    if (String(s.datum || "") < heute) return false;
    if (opt.nurSpieltagId) return s.id === opt.nurSpieltagId;
    if (opt.nurFrist) return String(s.datum) === zielTag;
    return true;
  });

  const bearbeiter = await pushEmpfaengerMitRecht("spieltagscrew", usersDoc, env, authHeader, opt.ausloeser || "");
  const admins = doc.einstellungen.lagemeldung !== false
    ? await scAdminEmpfaenger(env, authHeader, usersDoc, opt.ausloeser || "")
    : [];

  let gesendet = 0;
  let mitLuecke = 0;

  for (const s of kandidaten) {
    const frei = (s.jobs || []).reduce((n, j) => n + Math.max(0, (Number(j.anzahl) || 0) - (j.besetzung || []).length), 0);
    if (frei <= 0) continue;
    mitLuecke++;

    // Wer an diesem Spieltag schon einen Posten hat, bekommt den Aufruf NICHT.
    // Sonst ist die Nachricht nach drei Spieltagen weggewischt und trifft
    // ausgerechnet den nicht mehr, der noch fehlt.
    const drin = new Set();
    (s.jobs || []).forEach((j) => (j.besetzung || []).forEach((b) => {
      if (b && b.username) drin.add(normalizeUsername(b.username));
    }));
    const offen = bearbeiter.filter((u) => !drin.has(u));
    if (offen.length) {
      pushSenden(env, authHeader, execCtx, offen, "spieltagscrew",
        "Beim nächsten Heimspiel sind noch " + frei + " Posten unbesetzt. In der Spieltagscrew kannst du dich für einen davon eintragen.");
      gesendet += offen.length;
    }
  }

  // Lagemeldung an die Verwaltung — auch als Entwarnung, wenn alles besetzt
  // ist. Nur beim nächtlichen Lauf: von Hand ausgelöst steht das Ergebnis
  // ohnehin sofort auf dem Bildschirm.
  if (opt.nurFrist && admins.length) {
    const anDerFrist = doc.spieltage.filter((s) => String(s.datum) === zielTag);
    if (anDerFrist.length) {
      const freiGesamt = anDerFrist.reduce((n, s) =>
        n + (s.jobs || []).reduce((m, j) => m + Math.max(0, (Number(j.anzahl) || 0) - (j.besetzung || []).length), 0), 0);
      pushSenden(env, authHeader, execCtx, admins, "spieltagscrew",
        freiGesamt > 0
          ? "In " + tage + " Tagen ist Heimspiel und " + freiGesamt + " Posten sind noch frei. In der Spieltagscrew siehst du, welche das sind."
          : "In " + tage + " Tagen ist Heimspiel und alle Posten sind besetzt. Es ist nichts weiter zu tun.");
      gesendet += admins.length;
    }
  }

  // Terminerinnerung an die Eingetragenen: anderer Zweck als der Aufruf — nicht
  // werben, sondern erinnern. Deshalb geht sie NUR an die, die einen Posten
  // haben, und nennt Posten und ausgerechnete Uhrzeit.
  let erinnert = 0;
  if (opt.mitTermin && doc.einstellungen.terminerinnerung !== false) {
    for (const s of doc.spieltage.filter((x) => String(x.datum) === morgen)) {
      for (const j of (s.jobs || [])) {
        for (const b of (j.besetzung || [])) {
          if (!b || !b.username) continue;
          pushSenden(env, authHeader, execCtx, [b.username], "spieltagscrew",
            "Morgen bist du beim Heimspiel eingeteilt: " + j.name + ", ab " + scZeitVersetzt(s.anstoss, j.vonMin) + " Uhr. Die Zeiten stehen in der Spieltagscrew.");
          erinnert++;
        }
      }
    }
  }

  return { spieltage: mitLuecke, gesendet, erinnert, geprueft: kandidaten.length };
}

// Schreibt fest, dass und mit welchem Ergebnis der Lauf gearbeitet hat. Ohne
// diese Spur fällt ein stiller Fehlschlag um 4 Uhr nachts niemandem auf — der
// Verwaltungs-Tab zeigt die Zeile an.
async function scLaufVermerken(authHeader, bericht, fehler) {
  try {
    await scMutiere(authHeader, (doc) => {
      doc.lauf = {
        zuletztAm: new Date().toISOString(),
        ergebnis: fehler
          ? "Fehlgeschlagen: " + capStr(fehler, 200)
          : bericht.spieltage + " Spieltag(e) mit freien Posten, " + bericht.erinnert + " Terminerinnerung(en)",
        gesendet: (bericht.gesendet || 0) + (bericht.erinnert || 0)
      };
      return {};
    });
  } catch (_) {
    // Der Vermerk ist Diagnose, kein Selbstzweck: scheitert er, sind die
    // Nachrichten trotzdem raus.
  }
}

// Einstieg für den nächtlichen Lauf. Wirft nie — ein Fehler landete sonst nur
// in einem Cloudflare-Protokoll, das niemand liest.
async function scNaechtlicherLauf(env, authHeader, execCtx) {
  try {
    const bericht = await scAufrufVerschicken(env, authHeader, execCtx, { nurFrist: true, mitTermin: true });
    await scLaufVermerken(authHeader, bericht, null);
  } catch (e) {
    await scLaufVermerken(authHeader, { spieltage: 0, gesendet: 0, erinnert: 0 },
      (e && e.message) ? e.message : "unbekannt");
  }
}

// ============================================================================
// Ablaufplan: Erinnerung kurz vor dem eigenen Punkt (seit 2026-08-12)
// ============================================================================
//
// Michel-Vorgabe: wer an einem Punkt beteiligt ist, soll eine Viertelstunde
// vorher eine Nachricht aufs Handy bekommen. Ausgeloest vom Fuenf-Minuten-Lauf
// in scheduled(), NICHT von einer Nutzerhandlung -- es gibt niemanden, der zum
// richtigen Zeitpunkt die App offen hat.
//
// ⚠️ DER ZEITPLAN STEHT IN DER CLOUDFLARE-KONFIGURATION, NICHT IM REPO.
// Noetig sind ZWEI Trigger: "0 4 * * *" (Spieltagscrew, aelter) und
// "*/5 * * * *" (dieser Lauf). Ein Script-Upload ueber deploy-worker.ps1
// loescht sie nicht, legt sie aber auch nicht an -- fehlt der zweite, laeuft
// diese Funktion nie und niemand merkt es. Pruefen mit:
//   GET /accounts/<id>/workers/scripts/landingpage/schedules
//
// Als geschlossener Block am Dateiende, wie die Aktivitaetspunkte und die
// Kleiderbestellung davor: am Stueck wieder herausloesbar.

// Der Ausdruck, auf den die Weiche in scheduled() prueft. ⚠️ Muss ZEICHENGENAU
// dem Trigger in der Cloudflare-Konfiguration entsprechen -- weicht er ab,
// landet der Fuenf-Minuten-Lauf im naechtlichen Zweig und verschickt jede
// Viertelstunde Spieltagscrew-Erinnerungen.
const ABLAUFPLAN_CRON = "*/5 * * * *";

const ABLAUFPLAN_ERINNERT_URL = DAV_APPS["ablaufplan"].replace(/[^/]+$/, "ablaufplan-erinnert.json");

// Vorlauf der Nachricht. ⚠️ Muss zum Label in PUSH_ANLAESSE und zum Info-Text
// in E:\ablaufplan\config.js passen -- beide sprechen von einer Viertelstunde.
const ABLAUFPLAN_VORLAUF_MIN = 15;
// Wie spaet eine Nachricht noch rausgeht, wenn der Lauf sich verzoegert hat.
// ⚠️ Bewusst klein: eine Erinnerung, die NACH dem Termin kommt, ist schlimmer
// als keine. Faellt der Worker laenger aus, wird der Punkt still uebersprungen.
const ABLAUFPLAN_NACHLAUF_MIN = 5;
// Wie lange ein Merker aufgehoben wird, bevor er weggeraeumt wird.
const ABLAUFPLAN_MERKER_TAGE = 3;
// Deckel je Lauf, gegen den Fall, dass jemand aus Versehen hundert Punkte auf
// denselben Zeitpunkt legt.
const ABLAUFPLAN_MAX_JE_LAUF = 40;

// ⚠️ ZWEITE KOPIE von normMannschaft aus E:\ablaufplan\zeitlogik.js.
// Der Worker kann die Datei des App-Repos nicht laden. Wer die eine aendert,
// muss die andere mitziehen -- sonst bekommt ein Trainer mit "D1-Jugend" im
// Profil keine Erinnerung fuer einen Punkt, der "D1" sagt, waehrend ihn die App
// weiterhin als seinen markiert. Gleiche Lage wie NEWS_REACTION_EMOJIS.
function ablaufplanNormTeam(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[\s._-]+/g, "")
    .replace(/(jugend|junioren|juniorinnen|mannschaft)$/, "");
}

// Absoluter Zeitpunkt eines Punktes. ⚠️ Ueber vkBerlinWandzeitZuMs, damit
// Sommer- und Winterzeit stimmen -- der Lauf tickt in UTC, die Uhrzeit im
// Ablauf ist Berliner Wandzeit.
function ablaufplanPunktMs(punkt) {
  const datum = String((punkt && punkt.datum) || "");
  const zeit = String((punkt && punkt.startZeit) || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || !/^\d{2}:\d{2}$/.test(zeit)) return NaN;
  return vkBerlinWandzeitZuMs(datum, zeit);
}

// Wer wird erinnert: die Trainer, in deren Profil eine der Mannschaften des
// Punktes steht. ⚠️ Der Empfaengerkreis kommt aus dem DATENSATZ plus den
// Profilen, nie aus einem Request -- diesen Lauf loest ohnehin niemand aus.
// Archivierte Konten und Spielerkonten bleiben aussen vor.
function ablaufplanEmpfaenger(punkt, usersDoc) {
  const teams = (Array.isArray(punkt && punkt.mannschaften) ? punkt.mannschaften : [])
    .map(ablaufplanNormTeam).filter(Boolean);
  if (!teams.length) return [];

  const treffer = [];
  const gesehen = Object.create(null);
  for (const u of Object.values((usersDoc && usersDoc.users) || {})) {
    if (!u || u.archiviert || !istPersonal(u)) continue;
    const meine = (Array.isArray(u.mannschaften) ? u.mannschaften : []).map(ablaufplanNormTeam);
    if (!meine.some((m) => m && teams.indexOf(m) >= 0)) continue;
    const name = normalizeUsername(String(u.username || ""));
    if (!name || gesehen[name]) continue;
    gesehen[name] = true;
    treffer.push(name);
  }
  return treffer;
}

// ⚠️ Der Text steht auf dem Sperrbildschirm. Er nennt Uhrzeit, Mannschaft, was
// ansteht und den Ort -- aber NIE einen Personennamen. Die Trainernamen in der
// Oberflaeche kommen aus den Profilen, nicht aus dem Datensatz; hier haetten
// sie nichts zu suchen.
function ablaufplanText(ablauf, punkt) {
  const teams = (Array.isArray(punkt.mannschaften) ? punkt.mannschaften : []).join("/");
  const was = String(punkt.was || "").trim();
  const kern = [teams, was].filter(Boolean).join(" ") || String(ablauf.titel || "Ablauf");
  const ort = String(punkt.ort || ablauf.ort || "").trim();
  return "In " + ABLAUFPLAN_VORLAUF_MIN + " Minuten: " + punkt.startZeit + " " + kern +
    (ort ? " (" + ort + ")" : "") + ". Der komplette Tagesablauf steht im Ablaufplan.";
}

// Die Uhrzeit steht mit im Schluessel: wird ein Punkt verschoben, ist die alte
// Erinnerung verbraucht und die neue Zeit bekommt ihre eigene. Genau das will
// man -- sonst bliebe eine Verschiebung um zwei Stunden stumm.
function ablaufplanMerkerSchluessel(ablauf, punkt) {
  return ablauf.id + ":" + punkt.id + ":" + punkt.datum + "T" + punkt.startZeit;
}

function ablaufplanMerkerAufraeumen(ids, jetzt) {
  const grenze = jetzt - ABLAUFPLAN_MERKER_TAGE * 86400000;
  const sauber = Object.create(null);
  for (const [k, v] of Object.entries(ids || {})) {
    const ms = Date.parse(String(v || ""));
    if (Number.isFinite(ms) && ms >= grenze) sauber[k] = v;
  }
  return sauber;
}

// Sucht die Punkte, die in den naechsten ABLAUFPLAN_VORLAUF_MIN Minuten
// beginnen und noch keine Erinnerung bekommen haben. Reine Rechnung, damit sie
// sich ohne Nextcloud pruefen laesst.
function ablaufplanFaellige(doc, ids, jetzt) {
  const fenster = ABLAUFPLAN_VORLAUF_MIN * 60000;
  const nachlauf = ABLAUFPLAN_NACHLAUF_MIN * 60000;
  const treffer = [];
  for (const ablauf of (doc && Array.isArray(doc.ablaeufe) ? doc.ablaeufe : [])) {
    if (!ablauf || !ablauf.id) continue;
    for (const punkt of (Array.isArray(ablauf.punkte) ? ablauf.punkte : [])) {
      if (!punkt || !punkt.id) continue;
      const ms = ablaufplanPunktMs(punkt);
      if (!Number.isFinite(ms)) continue;
      const rest = ms - jetzt;
      if (rest > fenster || rest < -nachlauf) continue;
      const schluessel = ablaufplanMerkerSchluessel(ablauf, punkt);
      if (Object.prototype.hasOwnProperty.call(ids || {}, schluessel)) continue;
      treffer.push({ ablauf: ablauf, punkt: punkt, schluessel: schluessel });
    }
  }
  // Der frueheste zuerst, damit der Deckel im Zweifel das Dringendste nimmt.
  treffer.sort(function (a, b) { return ablaufplanPunktMs(a.punkt) - ablaufplanPunktMs(b.punkt); });
  return treffer.slice(0, ABLAUFPLAN_MAX_JE_LAUF);
}

async function ablaufplanErinnerungslauf(env, authHeader, execCtx) {
  const doc = await readJson(DAV_APPS["ablaufplan"], authHeader, null);
  if (!doc || !Array.isArray(doc.ablaeufe) || !doc.ablaeufe.length) return { gesendet: 0 };

  const jetzt = Date.now();
  let merker = await readJson(ABLAUFPLAN_ERINNERT_URL, authHeader, { version: 1, ids: {} });
  if (!merker || typeof merker !== "object") merker = { version: 1, ids: {} };
  const ids = (merker.ids && typeof merker.ids === "object") ? merker.ids : {};

  const faellig = ablaufplanFaellige(doc, ids, jetzt);
  if (!faellig.length) return { gesendet: 0 };

  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());

  // ⚠️ Reihenfolge bindend: erst den Merker schreiben, dann verschicken.
  // Andersherum meldete ein Fehlschlag beim Schreiben denselben Punkt in jedem
  // Fuenf-Minuten-Lauf erneut -- drei gleiche Nachrichten in einer Viertelstunde.
  // Eine ausgefallene Erinnerung ist der kleinere Schaden.
  const jetztIso = new Date(jetzt).toISOString();
  faellig.forEach(function (f) { ids[f.schluessel] = jetztIso; });
  merker.version = 1;
  merker.ids = ablaufplanMerkerAufraeumen(ids, jetzt);
  try {
    await writeJson(ABLAUFPLAN_ERINNERT_URL, authHeader, merker);
  } catch (_) {
    return { gesendet: 0, fehler: "merker" };
  }

  let gesendet = 0;
  for (const f of faellig) {
    const empfaenger = ablaufplanEmpfaenger(f.punkt, usersDoc);
    if (!empfaenger.length) continue;
    pushSenden(env, authHeader, execCtx, empfaenger, "ablaufplan", ablaufplanText(f.ablauf, f.punkt));
    gesendet++;
  }
  return { gesendet: gesendet };
}

// =============================================================================
// Mannschaften -- die eine Quelle (seit 2026-08-12)
//
// Bis hierher gab es KEINE Mannschaftsliste, nur Trainer, die ihre Mannschaft
// als freien Text ins Profil schrieben (nutzer.json, Feld "mannschaften").
// Der Ablaufplan sammelte daraus seine Kaestchen ein -- deshalb standen dort
// "B1", "B-Junioren", "B-Junioren 2 (K)" und "Zeugwart" nebeneinander.
// Daneben fuehrte der Kadermanager eigene Teams, Busplan und Ausbildungsplan
// feste Listen im Code.
//
// Michel-Entscheidungen vom 2026-08-12 (Interview, jede einzeln bestaetigt):
//
//   Ort          eine Liste im Gateway, NICHT im Kadermanager -- jede App
//                spricht ohnehin mit dem Gateway, auch die ohne Kaderbezug
//   Name         drei Felder: Kurz (B1), Lang (B-Junioren 1), Liga
//   Inhalt       nur echte Mannschaften. Kein "Zeugwart", kein "U6-U11" --
//                ein Koordinator bekommt die einzelnen Mannschaften angehakt
//   Pflegeort    AN DER MANNSCHAFT haengen die Trainer, nicht umgekehrt.
//                nutzer.json wird daraus BERECHNET (siehe Abgleich unten)
//   Rolle        feste Auswahl je Person (Trainer/Co/Torwart/Betreuer)
//   Saison       je Saison ein eigener Satz, "Saison kopieren" beim Wechsel
//   Schluessel   der KURZNAME wandert in die App-Daten, keine technische Id --
//                die Nextcloud-Dateien sollen mit blossem Auge lesbar bleiben
//   Altbestand   einmaliger Umschreib-Lauf statt dauerhafter Alias-Uebersetzung
//   Umfang       Jugend A-G, Maedchen/Frauen UND Herren (Busplan und
//                Platzbelegung brauchen die Erste, sonst bricht dort etwas weg)
//   Personen     nur Konten der Tools-Uebersicht -- sonst greifen "meine
//                Mannschaften", die Push-Erinnerung und die gefilterte Ansicht
//                nicht
//
// ⚠️ BEWUSST eine eigene Datei und KEIN Feld in nutzer.json -- dieselbe
// Ueberlegung wie bei push-abos.json, ansicht.json und kalender-abos.json:
// nutzer.json wird bei JEDER Sitzungspruefung der ganzen Flotte gelesen. Eine
// mitgefuehrte Mannschaftsliste mit Trainern und Altschreibweisen schleppte
// jeder einzelne Request mit. Umgekehrt bleibt das ABGELEITETE Feld
// u.mannschaften dort stehen -- es ist kurz, und die halbe Flotte liest es
// bereits aus der Sitzung, ohne einen zusaetzlichen Read zu bezahlen.
//
// Aufbau mannschaften.json:
//   { version: 1,
//     aktuelleSaison: "2026/27",
//     abgleichAktiv: false,
//     saisons: { "2026/27": { teams: [ {
//        kurz, lang, liga, stufe, nummer, archiviert,
//        trainer: [ { username, rolle } ],
//        aliase: [ "B-Junioren 2 (K)", ... ]
//     } ] } } }
// =============================================================================

const MANNSCHAFTEN_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/mannschaften.json";

// Rollen als feste Liste statt Freitext -- der Wert steht spaeter in Aushaengen
// und Serienbriefen, und "Co" / "Co-Trainer" / "co trainer" waeren genau die
// Uneinheitlichkeit, gegen die diese ganze Datei gebaut ist.
const MANNSCHAFT_ROLLEN = ["trainer", "co", "torwart", "betreuer"];
const MANNSCHAFT_ROLLE_LABELS = {
  trainer: "Trainer",
  co: "Co-Trainer",
  torwart: "Torwarttrainer",
  betreuer: "Betreuer"
};

// Sortierung: Herren oben, dann A bis G, dann Maedchen. NICHT alphabetisch --
// sonst stuende E1 vor D1 und die Kaestchenliste im Ablaufplan waere wieder
// unlesbar. Die Stufe wird gespeichert, die Reihenfolge daraus gerechnet.
const MANNSCHAFT_STUFEN = ["herren", "a", "b", "c", "d", "e", "f", "g", "maedchen", "sonstige"];

const MANNSCHAFT_MAX_TEAMS = 80;
const MANNSCHAFT_MAX_TRAINER = 12;
const MANNSCHAFT_MAX_ALIASE = 25;
const MANNSCHAFT_MAX_KURZ = 20;
const MANNSCHAFT_MAX_LANG = 80;
const MANNSCHAFT_MAX_LIGA = 60;
const MANNSCHAFT_MAX_SAISONS = 20;
// Form der Saison: "2026/27". Sie wird Objekt-Schluessel und darf deshalb
// weder Pfadzeichen noch __proto__ sein.
const MANNSCHAFT_SAISON_RE = /^\d{4}\/\d{2}$/;

function leeresMannschaftenDoc() {
  return { version: 1, aktuelleSaison: "", abgleichAktiv: false, saisons: {} };
}

// Laeuft der Abgleich? Dann ist u.mannschaften in nutzer.json ein abgeleitetes
// Feld und darf nicht mehr von Hand beschrieben werden (siehe handleUpdateUser).
//
// ⚠️ Ein LESEFEHLER wird bewusst nicht gefangen: readJson liefert den Fallback
// nur bei 404 oder leerer Datei und wirft sonst -> 502 an den Client. Ein
// stilles "false" bei einem Nextcloud-Wackler hiesse, dass ein Admin-Save die
// berechneten Zuordnungen mit Freitext ueberschreibt, ohne dass es jemand
// merkt. Lieber ein sichtbarer Fehler als eine unbemerkt kaputte Zuordnung.
async function mannschaftenAbgleichLaeuft(authHeader) {
  const doc = await readJson(MANNSCHAFTEN_URL, authHeader, leeresMannschaftenDoc());
  return !!(doc && doc.abgleichAktiv);
}

// Vergleichsform fuer Altschreibweisen. Bewusst dieselbe Bauart wie
// ablaufplanNormTeam/normMannschaft: Kleinschreibung, Trennzeichen weg,
// angehaengtes "jugend"/"junioren"/"mannschaft" weg. Zusaetzlich fallen
// Klammerzusaetze wie "(K)" oder "(VL)" heraus -- genau die machen aus
// "B-Junioren 2" und "B-Junioren 2 (K)" zwei Eintraege.
function mannschaftNorm(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[\s._\-\/]+/g, "")
    .replace(/(jugend|junioren|juniorinnen|mannschaft)/g, "");
}

function mannschaftStufe(roh) {
  const s = capStr(roh, 20).toLowerCase();
  return MANNSCHAFT_STUFEN.includes(s) ? s : "sonstige";
}

// Altersstufe und Nummer AUS DEM KURZNAMEN ableiten.
//
// ⚠️ Michel-Meldung vom 2026-08-12: "D2" stand hinter "Zeugwart" statt hinter
// "D1". Ursache war nicht die Sortierung, sondern die Stufe: der Vorschlag
// hatte "D-Junioren KOL" (ohne Zahl) keinem Buchstaben zuordnen koennen und es
// als "sonstige" eingestuft. Beim Korrigieren des Kurznamens auf "D2" zog die
// Stufe nicht mit -- und "sonstige" sortiert ganz hinten.
//
// Der Kurzname IST der Schluessel und traegt die Antwort schon in sich. Er wird
// deshalb ausgewertet und schlaegt die gespeicherte Angabe: eine von Hand
// gepflegte Stufe, die dem eigenen Kurznamen widerspricht, ist immer der
// Fehler. Passt der Name auf kein Muster (z. B. "Alte Herren"), bleibt die
// gespeicherte Angabe stehen.
function mannschaftAbleitung(kurz) {
  const s = capStr(kurz, MANNSCHAFT_MAX_KURZ).trim();
  if (!s) return null;

  // Herren, Erste, Zweite, Alte Herren
  const herren = s.match(/^(?:herren|erste|zweite|1\.?\s*mannschaft|2\.?\s*mannschaft)\s*(\d{1,2})?$/i);
  if (herren) return { stufe: "herren", nummer: parseInt(herren[1], 10) || 1 };

  // Maedchen/Frauen, mit oder ohne U-Zahl: "U11 Mädchen", "Frauen", "Damen 1"
  const maed = s.match(/^(?:u\s*(\d{1,2})\s*)?(?:m[aä]dchen|frauen|damen)\s*(\d{1,2})?$/i);
  if (maed) return { stufe: "maedchen", nummer: parseInt(maed[1] || maed[2], 10) || 0 };

  // Der Normalfall: ein Buchstabe A-G, optional eine Nummer. "B1", "D2", "G",
  // auch "B 1" oder "b-1". OHNE Nummer gilt die Erste.
  const jugend = s.match(/^([a-g])\s*[-.]?\s*(\d{1,2})?$/i);
  if (jugend) return { stufe: jugend[1].toLowerCase(), nummer: parseInt(jugend[2], 10) || 1 };

  return null;
}

// Sortierschluessel als ganze Zahl statt als Fliesskommawert -- ein Rest
// entschiede sonst ueber die Reihenfolge (siehe feedback-sortierschluessel-runden).
function mannschaftSortKey(team) {
  // ⚠️ Die Ableitung aus dem Kurznamen hat VORRANG vor der gespeicherten Stufe.
  // Sonst haengt die Reihenfolge an einem Feld, das beim Umbenennen leicht
  // stehenbleibt -- genau so landete "D2" hinter "Zeugwart". Das wirkt auch auf
  // bereits gespeicherte Eintraege, ohne dass jemand sie neu speichern muss.
  const ab = mannschaftAbleitung(team && team.kurz);
  const stufeIdx = MANNSCHAFT_STUFEN.indexOf(
    ab ? ab.stufe : mannschaftStufe(team && team.stufe));
  const nummer = Math.max(0, Math.min(99, Math.round(
    Number(ab ? ab.nummer : (team && team.nummer)) || 0)));
  return (stufeIdx < 0 ? MANNSCHAFT_STUFEN.length : stufeIdx) * 100 + nummer;
}

function mannschaftenSortieren(teams) {
  return teams.slice().sort(function (a, b) {
    const d = mannschaftSortKey(a) - mannschaftSortKey(b);
    if (d !== 0) return d;
    return String(a.kurz || "").localeCompare(String(b.kurz || ""), "de");
  });
}

// Baut EINEN Mannschafts-Datensatz serverseitig aus Einzelfeldern zusammen.
// Kein Durchreichen des Client-Objekts: es wandert in eine Datei, die die ganze
// Flotte liest, und der Kurzname wird zum Schluessel in fremden App-Daten.
function mannschaftSaeubern(roh, bekannteNutzer) {
  const kurz = capStr(roh && roh.kurz, MANNSCHAFT_MAX_KURZ);
  if (!kurz || kurz === "__proto__") return null;

  const gesehen = Object.create(null);
  const trainer = [];
  (Array.isArray(roh && roh.trainer) ? roh.trainer : []).forEach(function (t) {
    if (trainer.length >= MANNSCHAFT_MAX_TRAINER) return;
    const username = normalizeUsername(capStr(t && t.username, 80));
    if (!username || username === "__proto__") return;
    // Nur echte Konten. Ein freier Name waere wieder Freitext -- und die Person
    // bekaeme weder Push noch die gefilterte Ansicht, obwohl sie dastuende.
    if (bekannteNutzer && !bekannteNutzer.has(username)) return;
    if (gesehen[username]) return;
    gesehen[username] = true;
    const rolleRoh = capStr(t && t.rolle, 20).toLowerCase();
    trainer.push({
      username: username,
      rolle: MANNSCHAFT_ROLLEN.includes(rolleRoh) ? rolleRoh : "trainer"
    });
  });

  const aliasGesehen = Object.create(null);
  const aliase = [];
  (Array.isArray(roh && roh.aliase) ? roh.aliase : []).forEach(function (a) {
    if (aliase.length >= MANNSCHAFT_MAX_ALIASE) return;
    const wert = capStr(a, MANNSCHAFT_MAX_LANG);
    if (!wert) return;
    const norm = mannschaftNorm(wert);
    if (!norm || aliasGesehen[norm]) return;
    aliasGesehen[norm] = true;
    aliase.push(wert);
  });

  // Stufe und Nummer aus dem Kurznamen, wenn er ein Muster trifft -- so muss
  // niemand daran denken, sie beim Umbenennen mitzuziehen. Nur wenn der Name
  // auf kein Muster passt ("Alte Herren"), zaehlt die Handeingabe.
  const ab = mannschaftAbleitung(kurz);
  return {
    kurz: kurz,
    lang: capStr(roh && roh.lang, MANNSCHAFT_MAX_LANG) || kurz,
    liga: capStr(roh && roh.liga, MANNSCHAFT_MAX_LIGA),
    stufe: ab ? ab.stufe : mannschaftStufe(roh && roh.stufe),
    nummer: ab ? ab.nummer
      : Math.max(0, Math.min(99, Math.round(Number(roh && roh.nummer) || 0))),
    archiviert: !!(roh && roh.archiviert),
    trainer: trainer,
    aliase: aliase
  };
}

function mannschaftenSaisonTeams(doc, saison) {
  const s = getOwn(doc && doc.saisons, saison);
  return (s && Array.isArray(s.teams)) ? s.teams : [];
}

// ---------- Abgleich der Trainerprofile ----------
//
// nutzer.json fuehrt u.mannschaften weiter -- aber ab jetzt BERECHNET aus
// dieser Liste statt von Hand getippt. Das ist der Grund, aus dem die halbe
// Flotte ohne jede Aenderung sauberer wird: Ablaufplan, Trainerdaten,
// Spielstatistik und die Push-Erinnerung lesen dasselbe Feld wie vorher, es
// steht nur nicht mehr "B-Junioren 2 (K)" darin, sondern "B2".
//
// ⚠️ Der Abgleich laeuft NUR bei doc.abgleichAktiv === true. Solange die Liste
// aufgebaut wird, ist sie unvollstaendig -- ein Abgleich wuerde dann jedem
// Trainer, der noch an keiner Mannschaft haengt, sein Profil LEEREN und damit
// flottenweit Rechte und Filter entziehen. Der Schalter ist der Sicherheitsgurt
// und steht bewusst per Vorgabe auf aus.
async function mannschaftenProfileAbgleichen(env, authHeader, doc) {
  if (!doc || !doc.abgleichAktiv) return { abgeglichen: 0, aus: true };
  const saison = capStr(doc.aktuelleSaison, 10);
  if (!saison) return { abgeglichen: 0, aus: true };

  // username -> Set der Kurznamen. Archivierte Mannschaften zaehlen nicht mit:
  // sie sind Historie, keine laufende Zustaendigkeit.
  const zuordnung = Object.create(null);
  mannschaftenSaisonTeams(doc, saison).forEach(function (t) {
    if (!t || t.archiviert) return;
    const kurz = capStr(t.kurz, MANNSCHAFT_MAX_KURZ);
    if (!kurz) return;
    (Array.isArray(t.trainer) ? t.trainer : []).forEach(function (p) {
      const u = normalizeUsername(capStr(p && p.username, 80));
      if (!u || u === "__proto__") return;
      if (!zuordnung[u]) zuordnung[u] = [];
      if (zuordnung[u].indexOf(kurz) < 0) zuordnung[u].push(kurz);
    });
  });

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: usersDoc, rev } = await readJsonWithRev(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
    const users = (usersDoc && usersDoc.users) || {};
    let geaendert = 0;
    Object.keys(users).forEach(function (key) {
      const u = users[key];
      if (!u) return;
      const uname = normalizeUsername(u.username || key);
      const neu = (zuordnung[uname] || []).slice().sort(function (a, b) {
        return a.localeCompare(b, "de");
      });
      const alt = Array.isArray(u.mannschaften) ? u.mannschaften.map(String) : [];
      if (alt.length === neu.length && alt.every(function (v, i) { return v === neu[i]; })) return;
      u.mannschaften = neu;
      geaendert++;
    });
    // Kein Schreibvorgang ohne Aenderung: nutzer.json wird bei jeder
    // Sitzungspruefung der Flotte gelesen, ein Write ohne Anlass waere ein
    // vermeidbares Konfliktfenster (gleiche Ueberlegung wie bei rename-group).
    if (!geaendert) return { abgeglichen: 0, aus: false };
    try {
      await writeJson(env.NEXTCLOUD_NUTZER_URL, authHeader, usersDoc, rev || undefined);
      return { abgeglichen: geaendert, aus: false };
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      throw e;
    }
  }
  return { abgeglichen: 0, aus: false, konflikt: true };
}

// ---------- Aktion: Liste lesen ----------
//
// Offen fuer JEDEN Angemeldeten, auch Spielerkonten: es ist die Liste der
// Vereinsmannschaften, keine Personendatei. Die Trainernamen stehen ohnehin an
// jedem Aushang. Ein Rechte-Gate haette nur zur Folge, dass die login-losen
// Ansichten (Ablaufplan-Link, Fotoauftrag-Freigabe) leere Auswahlfelder zeigen.
async function handleMannschaftenLoad(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);

  const doc = await readJson(MANNSCHAFTEN_URL, authHeader, leeresMannschaftenDoc());
  // Ohne Angabe die laufende Saison. Eine ANDERE ist nur zum Nachschlagen da
  // (wer hatte 2025/26 die D2) -- geschrieben wird immer ausdruecklich.
  const gewuenscht = capStr(body && body.saison, 10);
  return json(mannschaftenAntwort(doc, session.usersDoc, gewuenscht), 200, corsHeaders);
}

// Gemeinsame Antwortform fuer Lesen und Speichern -- eine zweite Zusammenbau-
// Stelle liefe auseinander, sobald ein Feld dazukommt.
function mannschaftenAntwort(doc, usersDoc, saisonWunsch) {
  const saisons = Object.keys((doc && doc.saisons) || {}).sort().reverse();
  const saison = (saisonWunsch && saisons.indexOf(saisonWunsch) >= 0)
    ? saisonWunsch
    : (capStr(doc && doc.aktuelleSaison, 10) || saisons[0] || "");

  const teams = mannschaftenSortieren(mannschaftenSaisonTeams(doc, saison)).map(function (t) {
    // Dieselbe Ableitung wie beim Sortieren: das Panel soll nicht "sonstige"
    // anzeigen, waehrend die Zeile bei den D-Junioren einsortiert ist.
    const ab = mannschaftAbleitung(t.kurz);
    return {
      kurz: t.kurz,
      lang: t.lang || t.kurz,
      liga: t.liga || "",
      stufe: ab ? ab.stufe : mannschaftStufe(t.stufe),
      nummer: ab ? ab.nummer : (t.nummer || 0),
      archiviert: !!t.archiviert,
      aliase: Array.isArray(t.aliase) ? t.aliase : [],
      trainer: (Array.isArray(t.trainer) ? t.trainer : []).map(function (p) {
        return {
          username: p.username,
          rolle: p.rolle || "trainer",
          // Der Klarname wird AUFGELOEST, nicht mitgespeichert -- sonst zeigte
          // eine Mannschaft nach einer Umbenennung weiter den alten Namen.
          // Kostet keinen zusaetzlichen Read: usersDoc steckt in der Sitzung.
          name: aufgabenAnzeigeName(usersDoc, p.username)
        };
      })
    };
  });

  return {
    saison: saison,
    saisons: saisons,
    aktuelleSaison: capStr(doc && doc.aktuelleSaison, 10),
    abgleichAktiv: !!(doc && doc.abgleichAktiv),
    rollen: MANNSCHAFT_ROLLEN.map(function (r) {
      return { id: r, label: MANNSCHAFT_ROLLE_LABELS[r] };
    }),
    stufen: MANNSCHAFT_STUFEN,
    teams: teams
  };
}

// ---------- Aktion: Liste speichern ----------
async function handleMannschaftenSpeichern(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!session.isAdmin) return json({ error: "Kein Zugriff" }, 403, corsHeaders);

  const saison = capStr(body && body.saison, 10);
  if (!MANNSCHAFT_SAISON_RE.test(saison)) {
    return json({ error: "Saison muss die Form 2026/27 haben" }, 400, corsHeaders);
  }
  if (!Array.isArray(body && body.teams)) {
    return json({ error: "Keine Mannschaften uebergeben" }, 400, corsHeaders);
  }
  if (body.teams.length > MANNSCHAFT_MAX_TEAMS) {
    return json({ error: "Zu viele Mannschaften" }, 400, corsHeaders);
  }

  const bekannteNutzer = new Set(
    Object.keys((session.usersDoc && session.usersDoc.users) || {}).map(function (k) {
      const u = session.usersDoc.users[k];
      return normalizeUsername((u && u.username) || k);
    })
  );

  // Der Kurzname ist der Schluessel -- zwei gleiche waeren zwei Wahrheiten
  // unter einem Namen, und der Umschreib-Lauf koennte nicht entscheiden.
  const kurzGesehen = Object.create(null);
  const teams = [];
  for (const roh of body.teams) {
    const t = mannschaftSaeubern(roh, bekannteNutzer);
    if (!t) continue;
    const key = t.kurz.toLowerCase();
    if (kurzGesehen[key]) {
      return json({ error: "Kurzname doppelt vergeben: " + t.kurz }, 400, corsHeaders);
    }
    kurzGesehen[key] = true;
    teams.push(t);
  }

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(MANNSCHAFTEN_URL, authHeader, leeresMannschaftenDoc());
    doc.version = doc.version || 1;
    if (!doc.saisons || typeof doc.saisons !== "object") doc.saisons = {};
    if (Object.keys(doc.saisons).length >= MANNSCHAFT_MAX_SAISONS && !getOwn(doc.saisons, saison)) {
      return json({ error: "Zu viele Saisons" }, 400, corsHeaders);
    }
    doc.saisons[saison] = { teams: teams };
    if (!capStr(doc.aktuelleSaison, 10)) doc.aktuelleSaison = saison;
    if (typeof body.abgleichAktiv === "boolean") doc.abgleichAktiv = body.abgleichAktiv;

    try {
      await writeJson(MANNSCHAFTEN_URL, authHeader, doc, rev || undefined);
      // Der Abgleich steht NACH dem Schreiben: die Liste ist die Wahrheit, das
      // Profil die Ableitung. Ein Fehlschlag beim Ableiten darf die gerade
      // gespeicherte Liste nicht zurueckrollen -- er wird gemeldet, nicht geworfen.
      let abgleich = { abgeglichen: 0, aus: true };
      try {
        abgleich = await mannschaftenProfileAbgleichen(env, authHeader, doc);
      } catch (e) {
        abgleich = { abgeglichen: 0, fehler: String(e && e.message || e) };
      }
      const antwort = mannschaftenAntwort(doc, session.usersDoc, saison);
      antwort.ok = true;
      antwort.abgleich = abgleich;
      return json(antwort, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Mannschaften konnten nicht gespeichert werden" }, 502, corsHeaders);
}

// ---------- Aktion: Saison anlegen, kopieren, umschalten ----------
async function handleMannschaftenSaison(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!session.isAdmin) return json({ error: "Kein Zugriff" }, 403, corsHeaders);

  const was = capStr(body && body.was, 20);
  const saison = capStr(body && body.saison, 10);
  if (!MANNSCHAFT_SAISON_RE.test(saison)) {
    return json({ error: "Saison muss die Form 2026/27 haben" }, 400, corsHeaders);
  }

  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(MANNSCHAFTEN_URL, authHeader, leeresMannschaftenDoc());
    doc.version = doc.version || 1;
    if (!doc.saisons || typeof doc.saisons !== "object") doc.saisons = {};

    if (was === "anlegen" || was === "kopieren") {
      if (getOwn(doc.saisons, saison)) {
        return json({ error: "Diese Saison gibt es schon" }, 409, corsHeaders);
      }
      if (Object.keys(doc.saisons).length >= MANNSCHAFT_MAX_SAISONS) {
        return json({ error: "Zu viele Saisons" }, 400, corsHeaders);
      }
      let teams = [];
      if (was === "kopieren") {
        const quelle = capStr(body && body.quelle, 10);
        // Kopiert wird die STRUKTUR samt Trainern -- beim Saisonwechsel bleibt
        // das meiste gleich, geaendert wird von Hand. Archivierte bleiben
        // draussen: sie waren schon in der alten Saison Historie.
        teams = mannschaftenSaisonTeams(doc, quelle)
          .filter(function (t) { return t && !t.archiviert; })
          .map(function (t) { return JSON.parse(JSON.stringify(t)); });
      }
      doc.saisons[saison] = { teams: teams };
      if (!capStr(doc.aktuelleSaison, 10)) doc.aktuelleSaison = saison;
    } else if (was === "aktiv") {
      if (!getOwn(doc.saisons, saison)) {
        return json({ error: "Unbekannte Saison" }, 404, corsHeaders);
      }
      doc.aktuelleSaison = saison;
    } else if (was === "loeschen") {
      if (!getOwn(doc.saisons, saison)) {
        return json({ error: "Unbekannte Saison" }, 404, corsHeaders);
      }
      if (capStr(doc.aktuelleSaison, 10) === saison) {
        return json({ error: "Die laufende Saison laesst sich nicht loeschen" }, 409, corsHeaders);
      }
      delete doc.saisons[saison];
    } else {
      return json({ error: "Unbekannter Vorgang" }, 400, corsHeaders);
    }

    try {
      await writeJson(MANNSCHAFTEN_URL, authHeader, doc, rev || undefined);
      // Nur der Wechsel der laufenden Saison aendert, welche Mannschaften
      // "jetzt" gelten -- Anlegen und Loeschen einer anderen Saison nicht.
      let abgleich = { abgeglichen: 0, aus: true };
      if (was === "aktiv") {
        try {
          abgleich = await mannschaftenProfileAbgleichen(env, authHeader, doc);
        } catch (e) {
          abgleich = { abgeglichen: 0, fehler: String(e && e.message || e) };
        }
      }
      const antwort = mannschaftenAntwort(doc, session.usersDoc, saison);
      antwort.ok = true;
      antwort.abgleich = abgleich;
      return json(antwort, 200, corsHeaders);
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  return json({ error: "Saison konnte nicht gespeichert werden" }, 502, corsHeaders);
}

// ---------- Aktion: Vorschlag aus dem Altbestand ----------
//
// Die echten Schreibweisen stehen in nutzer.json und lassen sich von aussen
// nicht einsehen. Statt sie abzutippen, baut diese Aktion aus dem vorhandenen
// Freitext einen VORSCHLAG: gleiche Mannschaften zusammengefasst, Kurzname
// erraten, alle gefundenen Schreibweisen als Aliase drangehaengt -- genau die
// Zuordnung, die der spaetere Umschreib-Lauf braucht.
//
// ⚠️ Sie SPEICHERT nichts. Der Vorschlag geht an die Oberflaeche, wird dort
// korrigiert und erst dann gespeichert. Ein automatisch uebernommener Vorschlag
// waere geraten -- und was beim Raten falsch liegt, stuende danach in 20 Apps.
async function handleMannschaftenVorschlag(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!session.isAdmin) return json({ error: "Kein Zugriff" }, 403, corsHeaders);

  const users = (session.usersDoc && session.usersDoc.users) || {};
  // norm -> { schreibweisen:Set, personen:Set }
  const gefunden = Object.create(null);
  Object.keys(users).forEach(function (key) {
    const u = users[key];
    if (!u || u.archiviert) return;
    const uname = normalizeUsername(u.username || key);
    (Array.isArray(u.mannschaften) ? u.mannschaften : []).forEach(function (m) {
      const text = capStr(m, MANNSCHAFT_MAX_LANG);
      if (!text) return;
      const key2 = mannschaftVorschlagKey(text);
      if (!key2) return;
      if (!gefunden[key2]) gefunden[key2] = { schreibweisen: new Set(), personen: new Set() };
      gefunden[key2].schreibweisen.add(text);
      gefunden[key2].personen.add(uname);
    });
  });

  const teams = Object.keys(gefunden).map(function (key) {
    const eintrag = gefunden[key];
    const schreibweisen = Array.from(eintrag.schreibweisen);
    const geraten = mannschaftVorschlagFelder(key, schreibweisen);
    return {
      kurz: geraten.kurz,
      lang: geraten.lang,
      liga: geraten.liga,
      stufe: geraten.stufe,
      nummer: geraten.nummer,
      archiviert: false,
      // ⚠️ Als Vorschlag mitgeliefert, NICHT als Zusage: wer "U6-U11" im Profil
      // stehen hat, betreut in Wahrheit mehrere Mannschaften. Die Oberflaeche
      // markiert solche Zeilen und Michel entscheidet.
      trainer: Array.from(eintrag.personen).map(function (p) {
        return { username: p, rolle: "trainer", name: aufgabenAnzeigeName(session.usersDoc, p) };
      }),
      aliase: schreibweisen,
      // Sammelbegriffe und Rollen sind KEINE Mannschaft -- vorgeschlagen wird
      // trotzdem, aber sichtbar zum Wegwerfen markiert.
      verdaechtig: geraten.verdaechtig,
      grund: geraten.grund
    };
  });

  return json({
    vorschlag: mannschaftenSortieren(teams),
    rollen: MANNSCHAFT_ROLLEN.map(function (r) {
      return { id: r, label: MANNSCHAFT_ROLLE_LABELS[r] };
    }),
    stufen: MANNSCHAFT_STUFEN
  }, 200, corsHeaders);
}

// Gruppierungsschluessel des Vorschlags. Anders als mannschaftNorm bleibt die
// NUMMER erhalten -- "B-Junioren 1" und "B-Junioren 2" sind zwei Mannschaften,
// waehrend "B-Junioren 2 (K)" und "B2" dieselbe sind.
function mannschaftVorschlagKey(text) {
  const roh = String(text || "").toLowerCase().replace(/\([^)]*\)/g, " ").trim();
  if (!roh) return "";
  // Sammelbegriffe wie "U6-U11" oder "U12-U15" bleiben als eigener Schluessel
  // stehen, damit sie im Vorschlag sichtbar sind statt still zu verschwinden.
  const spanne = roh.match(/^u\s*\d{1,2}\s*[-\/bis]+\s*u?\s*\d{1,2}$/);
  if (spanne) return "spanne:" + roh.replace(/\s+/g, "");
  const stufe = roh.match(/^([a-g])\s*[-\s]?\s*(?:junioren|juniorinnen|jugend)?\s*(\d{1,2})?\s*$/);
  if (stufe) return "stufe:" + stufe[1] + ":" + (stufe[2] || "1");
  const stufeNum = roh.match(/^([a-g])\s*(\d{1,2})\s*(?:junioren|juniorinnen|jugend)?\s*$/);
  if (stufeNum) return "stufe:" + stufeNum[1] + ":" + stufeNum[2];
  return "frei:" + roh.replace(/\s+/g, " ");
}

function mannschaftVorschlagFelder(key, schreibweisen) {
  // Liga aus dem Klammerzusatz der Altschreibweisen -- (VL), (K), (TL), KOL.
  let liga = "";
  schreibweisen.forEach(function (s) {
    const t = String(s);
    if (/\(\s*VL\s*\)|verbandsliga/i.test(t)) liga = liga || "Verbandsliga";
    else if (/\(\s*TL\s*\)|thueringenliga|thüringenliga/i.test(t)) liga = liga || "Thueringenliga";
    else if (/KOL|kreisoberliga/i.test(t)) liga = liga || "Kreisoberliga";
    else if (/\(\s*K\s*\)|kreisliga/i.test(t)) liga = liga || "Kreisliga";
  });

  if (key.indexOf("stufe:") === 0) {
    const teile = key.split(":");
    const buchstabe = teile[1];
    const nummer = parseInt(teile[2], 10) || 1;
    const langNamen = {
      a: "A-Junioren", b: "B-Junioren", c: "C-Junioren", d: "D-Junioren",
      e: "E-Junioren", f: "F-Junioren", g: "Bambini / G-Junioren"
    };
    return {
      kurz: buchstabe.toUpperCase() + nummer,
      lang: (langNamen[buchstabe] || buchstabe.toUpperCase()) + " " + nummer,
      liga: liga,
      stufe: buchstabe,
      nummer: nummer,
      verdaechtig: false,
      grund: ""
    };
  }

  if (key.indexOf("spanne:") === 0) {
    const roh = key.slice(7);
    return {
      kurz: roh.toUpperCase(),
      lang: roh.toUpperCase(),
      liga: "",
      stufe: "sonstige",
      nummer: 0,
      verdaechtig: true,
      grund: "Sieht nach einem Altersbereich aus, nicht nach einer Mannschaft. Wer das im Profil hat, betreut mehrere Mannschaften -- besser dort einzeln anhaken."
    };
  }

  const roh = key.slice(5);
  const istMannschaft = /mannschaft|herren|frauen|damen|maedchen|mädchen|alte/i.test(roh);
  return {
    kurz: roh.slice(0, MANNSCHAFT_MAX_KURZ),
    lang: schreibweisen[0] || roh,
    liga: liga,
    stufe: /maedchen|mädchen|frauen|damen/i.test(roh) ? "maedchen"
      : (/mannschaft|herren|alte/i.test(roh) ? "herren" : "sonstige"),
    nummer: (roh.match(/(\d{1,2})/) ? parseInt(roh.match(/(\d{1,2})/)[1], 10) : 0),
    verdaechtig: !istMannschaft,
    grund: istMannschaft ? "" : "Passt in kein Mannschaftsmuster -- moeglicherweise eine Aufgabe oder Rolle statt einer Mannschaft."
  };
}

// ---------- Der einmalige Umschreib-Lauf (seit 2026-08-12) ----------
//
// Michel-Entscheidung: die alten Schreibweisen werden EINMAL in allen
// Datendateien ersetzt, statt sie dauerhaft beim Anzeigen zu uebersetzen.
// Danach steht ueberall der Kurzname, und die Alias-Listen sind nur noch
// Dokumentation.
//
// Der Lauf ist bewusst GENERISCH: er geht rekursiv durch das JSON jeder App und
// ersetzt jeden String, der als GANZES einer bekannten alten Schreibweise
// entspricht. Kein Teilstring-Ersatz -- ein Freitext "Treffpunkt hinter der
// B-Junioren-Kabine" darf nicht zu "Treffpunkt hinter der B2-Kabine" werden.
// Der Vergleich laeuft ueber mannschaftNorm, trifft also auch Schreibvarianten
// mit anderer Zeichensetzung.
//
// ⚠️ Zwei Schranken, die nicht wegfallen duerfen:
//
//   1. VORSCHAU ZUERST. Der Modus "vorschau" schreibt nichts und liefert je App
//      und je Fundstelle, was sich aendern wuerde. Michel-Vorgabe vom
//      2026-08-12: die Zuordnung wird vorgelegt, bevor irgendetwas geschrieben
//      wird -- was beim Raten falsch liegt, stuende danach in 20 Apps.
//
//   2. SICHERUNG MIT RUECKWEG. Vor dem ersten Schreiben in eine App wird die
//      unveraenderte Datei nebenan abgelegt, und "zurueck" spielt sie wieder
//      ein. Eine Sicherung ohne geprueften Rueckweg ist keine Sicherung.
//
// ⚠️ Blockweise, hoechstens MANNSCHAFT_UMSCHREIB_MAX_APPS je Aufruf. Ein Lauf
// ueber alle 24 Apps in einem Request waere ein Rundlauf mit bis zu 72
// Nextcloud-Zugriffen -- die Bauform, an der ein Worker stirbt.

const MANNSCHAFT_UMSCHREIB_MAX_APPS = 4;
// Reissleine gegen einen Denkfehler in der Alias-Pflege: traegt jemand aus
// Versehen ein sehr kurzes oder sehr haeufiges Wort als Alias ein ("D", "Team"),
// faende der Lauf es in hunderten Feldern. Ueber dieser Zahl bricht er die App
// ab und meldet es, statt zu schreiben.
const MANNSCHAFT_UMSCHREIB_MAX_TREFFER = 2000;

function mannschaftSicherungsUrl(url) {
  return url.replace(/\.json$/, "") + ".vor-mannschaften-umbau.json";
}

// alte Schreibweise (normalisiert) -> Kurzname. Gebaut aus den Aliasen UND aus
// den Kurznamen selbst: so wird ein bereits richtiger Wert nie angefasst, und
// der Langname trifft ebenfalls.
//
// ⚠️ Ein Alias, der auf ZWEI Mannschaften zeigt, wird ausgelassen und gemeldet.
// Raten waere hier der teuerste Fehler des ganzen Vorhabens.
// ⚠️ ZWEI Durchgaenge, und die Reihenfolge ist bindend.
//
// Erst die Kurznamen, dann Langnamen und Aliase. Grund: mannschaftNorm schneidet
// „junioren"/„jugend", Klammerzusaetze und Trennzeichen weg -- „B-Junioren 2 (K)"
// und „B2" haben damit DIESELBE Normalform. Wuerde man den eigenen Kurznamen als
// Quelle ueberspringen (der naheliegende Guard), verschwaende genau der Alias,
// wegen dem der Lauf gebaut ist. Und liesse man beide gleichrangig laufen, waere
// der Kurzname mit einem fremden Alias „mehrdeutig" und floege ganz heraus.
//
// Der Kurzname gewinnt deshalb immer und ist gegen Ueberschreiben gesperrt; eine
// Kollision zwischen ZWEI Aliasen bleibt mehrdeutig und wird gemeldet statt
// geraten -- Raten waere hier der teuerste Fehler des ganzen Vorhabens.
function mannschaftUmschreibTabelle(doc, saison) {
  const tabelle = Object.create(null);
  const fest = Object.create(null);      // von einem Kurznamen belegt
  const mehrdeutig = Object.create(null);
  const teams = mannschaftenSaisonTeams(doc, saison);

  teams.forEach(function (t) {
    if (!t || !t.kurz) return;
    const k = mannschaftNorm(t.kurz);
    if (!k) return;
    tabelle[k] = String(t.kurz);
    fest[k] = true;
  });

  teams.forEach(function (t) {
    if (!t || !t.kurz) return;
    const ziel = String(t.kurz);
    [t.lang].concat(Array.isArray(t.aliase) ? t.aliase : []).forEach(function (q) {
      const k = mannschaftNorm(q);
      if (!k) return;
      if (fest[k]) return;               // ein Kurzname steht schon darauf
      if (tabelle[k] && tabelle[k] !== ziel) {
        mehrdeutig[k] = (mehrdeutig[k] || [tabelle[k]]).concat([ziel]);
        return;
      }
      tabelle[k] = ziel;
    });
  });

  // Mehrdeutige fliegen ganz raus -- lieber unveraendert lassen als falsch.
  Object.keys(mehrdeutig).forEach(function (k) { delete tabelle[k]; });
  return { tabelle: tabelle, mehrdeutig: mehrdeutig };
}

// Rekursiv durch das JSON. Gibt die Zahl der Ersetzungen zurueck und traegt in
// `funde` ein, was womit ersetzt wurde.
function mannschaftUmschreibKnoten(knoten, tabelle, funde, zaehler) {
  if (zaehler.n > MANNSCHAFT_UMSCHREIB_MAX_TREFFER) return knoten;
  if (typeof knoten === "string") {
    const k = mannschaftNorm(knoten);
    if (!k) return knoten;
    const ziel = Object.prototype.hasOwnProperty.call(tabelle, k) ? tabelle[k] : null;
    if (!ziel || ziel === knoten) return knoten;
    const schluessel = knoten + " → " + ziel;
    funde[schluessel] = (funde[schluessel] || 0) + 1;
    zaehler.n++;
    return ziel;
  }
  if (Array.isArray(knoten)) {
    for (let i = 0; i < knoten.length; i++) {
      knoten[i] = mannschaftUmschreibKnoten(knoten[i], tabelle, funde, zaehler);
    }
    return knoten;
  }
  if (knoten && typeof knoten === "object") {
    Object.keys(knoten).forEach(function (key) {
      // ⚠️ Nur WERTE, nie Schluessel. Ein umbenannter Schluessel wuerde die
      // Struktur der App aendern, und kein Client rechnet damit.
      knoten[key] = mannschaftUmschreibKnoten(knoten[key], tabelle, funde, zaehler);
    });
    return knoten;
  }
  return knoten;
}

async function handleMannschaftenUmschreiben(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!session.isAdmin) return json({ error: "Kein Zugriff" }, 403, corsHeaders);

  const modus = capStr(body && body.modus, 20);
  if (["vorschau", "schreiben", "zurueck"].indexOf(modus) < 0) {
    return json({ error: "Unbekannter Vorgang" }, 400, corsHeaders);
  }

  const doc = await readJson(MANNSCHAFTEN_URL, authHeader, leeresMannschaftenDoc());
  const saison = capStr(doc.aktuelleSaison, 10);
  if (!saison) return json({ error: "Es gibt noch keine laufende Saison" }, 400, corsHeaders);

  const { tabelle, mehrdeutig } = mannschaftUmschreibTabelle(doc, saison);
  if (modus !== "zurueck" && !Object.keys(tabelle).length) {
    return json({
      error: "Keine alten Schreibweisen hinterlegt. Trage sie an den Mannschaften unter " +
             "Frühere Schreibweisen ein, sonst weiß der Lauf nicht, was wohin gehört."
    }, 400, corsHeaders);
  }

  // Der Client kennt die App-Liste nicht vorab und holt sie mit einem eigenen,
  // schmalen Aufruf. ⚠️ Bewusst OHNE eine App mitzuverarbeiten: der naheliegende
  // Weg (erste App mitschicken und ihr Ergebnis wegwerfen) haette im Schreibmodus
  // genau eine Datei zweimal angefasst -- und der zweite Durchgang haette ihre
  // Sicherung mit dem bereits geaenderten Stand ueberschrieben. Damit waere der
  // Rueckweg genau fuer die Datei weg, die als erste drankommt.
  if (body && body.nurListe) {
    return json({
      modus: modus, saison: saison, nurListe: true,
      alleApps: Object.keys(DAV_APPS),
      mehrdeutig: Object.keys(mehrdeutig).map(function (k) {
        return { normalisiert: k, ziele: mehrdeutig[k] };
      }),
      ergebnisse: []
    }, 200, corsHeaders);
  }

  // Nur bekannte App-Ids, und nur so viele je Aufruf, wie ein Worker vertraegt.
  const gewuenscht = Array.isArray(body && body.apps) ? body.apps : [];
  const apps = gewuenscht
    .map(function (a) { return capStr(a, 40); })
    .filter(function (a) { return Object.prototype.hasOwnProperty.call(DAV_APPS, a); })
    .slice(0, MANNSCHAFT_UMSCHREIB_MAX_APPS);
  if (!apps.length) return json({ error: "Keine gültige App angegeben" }, 400, corsHeaders);

  const ergebnisse = [];
  for (const app of apps) {
    const url = DAV_APPS[app];
    const sicherung = mannschaftSicherungsUrl(url);

    if (modus === "zurueck") {
      // Rueckweg: die Sicherung wieder einspielen. Fehlt sie, wird NICHTS
      // angefasst -- ein leeres Dokument ueber die echten Daten zu schreiben
      // waere der Schaden, vor dem die Sicherung schuetzen soll.
      let gesichert = null;
      try {
        gesichert = await readJson(sicherung, authHeader, null);
      } catch (e) {
        ergebnisse.push({ app: app, fehler: "Sicherung nicht lesbar: " + e.message });
        continue;
      }
      if (gesichert === null) {
        ergebnisse.push({ app: app, fehler: "Für diese App gibt es keine Sicherung" });
        continue;
      }
      try {
        const { rev } = await readJsonWithRev(url, authHeader, {});
        await writeJson(url, authHeader, gesichert, rev || undefined);
        ergebnisse.push({ app: app, zurueckgespielt: true });
      } catch (e) {
        ergebnisse.push({ app: app, fehler: "Zurückspielen fehlgeschlagen: " + e.message });
      }
      continue;
    }

    let daten, rev;
    try {
      const gelesen = await readJsonWithRev(url, authHeader, null);
      daten = gelesen.data;
      rev = gelesen.rev;
    } catch (e) {
      ergebnisse.push({ app: app, fehler: "Nicht lesbar: " + e.message });
      continue;
    }
    if (daten === null) {
      ergebnisse.push({ app: app, treffer: {}, gesamt: 0, hinweis: "Datei gibt es noch nicht" });
      continue;
    }

    const funde = Object.create(null);
    const zaehler = { n: 0 };
    // Auf einer Kopie arbeiten: im Vorschau-Modus darf das Original nicht
    // angefasst werden, und im Schreib-Modus wird die Kopie geschrieben.
    const kopie = mannschaftUmschreibKnoten(
      JSON.parse(JSON.stringify(daten)), tabelle, funde, zaehler);

    if (zaehler.n > MANNSCHAFT_UMSCHREIB_MAX_TREFFER) {
      ergebnisse.push({
        app: app, gesamt: zaehler.n, treffer: funde,
        fehler: "Über " + MANNSCHAFT_UMSCHREIB_MAX_TREFFER + " Treffer — das sieht nach einem " +
                "zu allgemeinen Eintrag unter Frühere Schreibweisen aus. Nichts geändert."
      });
      continue;
    }

    if (modus === "vorschau" || zaehler.n === 0) {
      ergebnisse.push({ app: app, treffer: funde, gesamt: zaehler.n });
      continue;
    }

    // ⚠️ Reihenfolge bindend: erst sichern, dann schreiben. Andersherum stuende
    // im Fehlerfall die geaenderte Datei ohne Rueckweg da.
    try {
      await writeJson(sicherung, authHeader, daten);
    } catch (e) {
      ergebnisse.push({ app: app, treffer: funde, gesamt: zaehler.n,
        fehler: "Sicherung fehlgeschlagen, deshalb NICHT geschrieben: " + e.message });
      continue;
    }
    try {
      await writeJson(url, authHeader, kopie, rev || undefined);
      ergebnisse.push({ app: app, treffer: funde, gesamt: zaehler.n, geschrieben: true });
    } catch (e) {
      ergebnisse.push({ app: app, treffer: funde, gesamt: zaehler.n,
        fehler: "Schreiben fehlgeschlagen: " + e.message });
    }
  }

  return json({
    modus: modus,
    saison: saison,
    // Der Client blättert selbst weiter; der Worker sagt nur, was er nicht
    // genommen hat -- ein stilles Abschneiden liesse den Lauf halb erledigt
    // aussehen wie einen ganzen.
    rest: gewuenscht.length > apps.length ? gewuenscht.length - apps.length : 0,
    mehrdeutig: Object.keys(mehrdeutig).map(function (k) {
      return { normalisiert: k, ziele: mehrdeutig[k] };
    }),
    alleApps: Object.keys(DAV_APPS),
    ergebnisse: ergebnisse
  }, 200, corsHeaders);
}

// ============================================================================
// Ideen (seit 2026-08-16)
//
// Michel-Wunsch: ein Ort, an dem jeder aufschreiben kann, was der VEREIN
// anpacken sollte -- ein Fest, eine Aktion, etwas fuer die Jugend, fuer die
// Mitglieder oder ums Gelaende. Sichtbar fuer ALLE, nicht nur fuer den Admin.
//
// ⚠️ Es geht NICHT um die Vereins-Tools (Michel-Klarstellung vom 2026-08-16,
// nach der ersten Fassung). Das ist die Trennlinie zum Feedback-Tab und der
// Grund, warum dessen Typ "wunsch" bestehen bleibt: dort meldet man, was an den
// WERKZEUGEN hakt oder fehlt, hier geht es um die Vereinsarbeit. Wer die Texte
// je anfasst, haelt diese Trennung durch -- sonst laufen beide Kanaele wieder
// ineinander und niemand weiss, wo etwas hingehoert.
//
// Der Block steht geschlossen am Dateiende und ist am Stueck wieder
// herausloesbar -- wie die Aktivitaetspunkte und die Kleiderbestellung darueber,
// aus demselben Grund.
//
// Neun Michel-Entscheidungen aus einem Grill-me-Interview:
//   Sichtbarkeit  alle Angemeldeten sehen alle Ideen (nicht nur der Admin)
//   Ort           Tab in der Tools-Uebersicht, KEINE eigene App
//   Teilnehmer    nur Personal, Spielerkonten bekommen 403
//   Name          Haekchen "anonym" je Idee -- der Admin sieht ihn trotzdem
//   Formular      Titel Pflicht, Text freiwillig, kein Tool-Feld
//   Status        neu / arbeit / umgesetzt / abgelehnt, gesetzt nur vom Admin
//   Zustimmung    Daumen hoch, einer je Person, NUR die Zahl ist sichtbar
//   Antwort       schreibt der Admin, liest nur der Einreicher
//   Aendern       der Verfasser darf, solange die Idee auf "neu" steht
// Bewusst NICHT gebaut: Push (Michel-Entscheidung), Abzeichen am Tab
// (kostete einen Nextcloud-Read bei JEDEM Aufruf der Startseite), Kommentare.
// ============================================================================

// Eigene Datei, bewusst NICHT der links/materialcontainer-Weg in
// sichtbarkeit.json: dort ersetzt save-visibility den ganzen Inhalt, waehrend
// hier jeder Angemeldete laufend schreibt (jeder Daumen ist ein Schreibvorgang).
// Gleiche Ueberlegung wie bei aufgaben.json und neuigkeiten-reaktionen.json.
const IDEEN_URL = "https://nx88695.your-storageshare.de/remote.php/dav/files/admin/05_Nachwuchsbereich/02_Förderung/Tools/ToolsUebersicht/ideen.json";

const IDEEN_MAX = 300;
const IDEEN_MAX_TITEL = 120;
const IDEEN_MAX_TEXT = 2000;
const IDEEN_MAX_ANTWORT = 2000;

// "neu" ist der einzige Zustand, in dem der Verfasser seine Idee noch aendern
// darf -- ab "arbeit" ist sie ein Auftrag, und ein Auftrag, der sich unter der
// laufenden Arbeit aendert, ist keiner mehr.
const IDEEN_STATUS = ["neu", "arbeit", "umgesetzt", "abgelehnt"];

// Wie aufgabenSession: angemeldetes PERSONAL. Spielerkonten bekommen 403 --
// gleiche Linie wie Materialcontainer-Code, ToDos und Kontaktliste. Bei ~200
// Spielerkonten waere eine fuer alle lesbare und beschreibbare Ideenliste etwas
// anderes als das, was hier bestellt wurde.
async function ideenSession(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return { fehler: json({ error: "Nicht angemeldet" }, 401, corsHeaders) };
  if (session.art === USER_ART_SPIELER) {
    return { fehler: json({ error: "Kein Zugriff auf die Ideen" }, 403, corsHeaders) };
  }
  return { session, fehler: null };
}

function ideenListe(doc) {
  return (doc && Array.isArray(doc.eintraege)) ? doc.eintraege : [];
}

// Ein Eintrag entsteht IMMER aus benannten Einzelfeldern, nie durch Uebernehmen
// eines Objekts aus dem Koerper. Gleiche Linie wie linksNormieren: eine von Hand
// in Nextcloud editierte Datei darf keine Form ausliefern, die der Client nicht
// erwartet.
function ideeNormieren(roh) {
  if (!roh || typeof roh !== "object") return null;
  const titel = capStr(roh.titel, IDEEN_MAX_TITEL).trim();
  if (!titel) return null;
  const id = /^[a-z0-9-]{1,40}$/i.test(String(roh.id || "")) ? String(roh.id) : null;
  if (!id) return null;
  const eintrag = {
    id: id,
    titel: titel,
    text: capStr(roh.text, IDEEN_MAX_TEXT).trim(),
    username: capStr(roh.username, 64).trim(),
    anonym: roh.anonym === true,
    erstelltAm: /^\d{4}-\d{2}-\d{2}T/.test(String(roh.erstelltAm || "")) ? String(roh.erstelltAm) : new Date().toISOString(),
    status: IDEEN_STATUS.includes(String(roh.status)) ? String(roh.status) : "neu",
    stimmen: {}
  };
  // Object.create(null) statt {}: ein Konto namens __proto__ traefe sonst den
  // Prototyp und faelle spurlos aus der Zaehlung (dieselbe Falle wie in
  // rundErreichbar).
  const stimmen = Object.create(null);
  const rohStimmen = (roh.stimmen && typeof roh.stimmen === "object") ? roh.stimmen : {};
  for (const name of Object.keys(rohStimmen)) {
    if (name === "__proto__" || !name || name.length > 64) continue;
    if (rohStimmen[name]) stimmen[name] = true;
  }
  eintrag.stimmen = stimmen;
  const antwort = capStr(roh.antwort, IDEEN_MAX_ANTWORT).trim();
  if (antwort) {
    eintrag.antwort = antwort;
    eintrag.antwortVon = capStr(roh.antwortVon, 100).trim() || null;
    eintrag.antwortAm = /^\d{4}-\d{2}-\d{2}T/.test(String(roh.antwortAm || "")) ? String(roh.antwortAm) : new Date().toISOString();
  }
  return eintrag;
}

function ideenDokNormieren(doc) {
  const sauber = [];
  for (const roh of ideenListe(doc).slice(0, IDEEN_MAX)) {
    const e = ideeNormieren(roh);
    if (e) sauber.push(e);
  }
  return { version: 1, eintraege: sauber };
}

// ⚠️ Die Sicht wird HIER gebaut, nicht im Client. Ein Name, den der Betrachter
// nicht sehen soll, verlaesst den Worker gar nicht erst -- Ausblenden waere kein
// Zurueckhalten. Betrifft drei Dinge:
//   1. den Verfassernamen bei anonymen Ideen
//   2. die Antwort des Admins (liest nur der Einreicher, Michel-Entscheidung)
//   3. WER zugestimmt hat -- nach aussen geht ausschliesslich die ZAHL
function ideeFuerNutzer(e, session, usersDoc) {
  const ich = normalizeUsername(session.username);
  const meins = normalizeUsername(e.username || "") === ich;
  const istAdmin = !!session.isAdmin;
  const stimmen = e.stimmen || {};
  const sicht = {
    id: e.id,
    titel: e.titel,
    text: e.text || "",
    erstelltAm: e.erstelltAm,
    status: e.status,
    daumen: Object.keys(stimmen).length,
    meinDaumen: !!getOwn(stimmen, ich),
    meins: meins,
    anonym: !!e.anonym,
    // Aendern und Loeschen sind an denselben Zustand gebunden wie im Handler --
    // der Client blendet danach nur die Knoepfe, die Schranke ist der Handler.
    darfAendern: (meins && e.status === "neu") || istAdmin,
    autor: null
  };
  // Der eigene Name steht auch bei einer anonymen Idee dran (man soll die eigene
  // wiederfinden), der Admin sieht ihn ebenfalls -- genau das sagt der Text am
  // Haekchen zu. Fuer alle anderen bleibt er weg.
  if (!e.anonym || meins || istAdmin) {
    sicht.autor = aufgabenAnzeigeName(usersDoc, e.username || "");
  }
  if (e.antwort && (meins || istAdmin)) {
    sicht.antwort = e.antwort;
    sicht.antwortVon = e.antwortVon || null;
    sicht.antwortAm = e.antwortAm || null;
  }
  return sicht;
}

// Alle Ideen in der Sicht des Aufrufers. Neueste zuerst (Michel-Entscheidung);
// der Client trennt offen/abgeschlossen selbst, dafuer reicht das Statusfeld.
async function handleIdeenLoad(request, env, authHeader, corsHeaders) {
  const { session, fehler } = await ideenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const doc = await readJson(IDEEN_URL, authHeader, { version: 1, eintraege: [] });
  const sauber = ideenDokNormieren(doc).eintraege;
  const sicht = sauber
    .map((e) => ideeFuerNutzer(e, session, session.usersDoc))
    .sort((a, b) => String(b.erstelltAm || "").localeCompare(String(a.erstelltAm || "")));

  return json({ ideen: sicht, istAdmin: !!session.isAdmin }, 200, corsHeaders);
}

// Neu anlegen (ohne id) oder die EIGENE Idee aendern (mit id). Der Verfasser
// kommt immer aus der Sitzung, nie aus dem Koerper.
async function handleIdeeSpeichern(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await ideenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const titel = capStr(body && body.titel, IDEEN_MAX_TITEL).trim();
  if (!titel) return json({ error: "Bitte gib deiner Idee eine Überschrift" }, 400, corsHeaders);
  const text = capStr(body && body.text, IDEEN_MAX_TEXT).trim();
  const anonym = !!(body && body.anonym);
  const id = String((body && body.id) || "").trim();
  if (id && !/^[a-z0-9-]{1,40}$/i.test(id)) return json({ error: "Ungültige Id" }, 400, corsHeaders);

  let ergebnis = null;
  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: roh, rev } = await readJsonWithRev(IDEEN_URL, authHeader, { version: 1, eintraege: [] });
    const doc = ideenDokNormieren(roh);

    if (id) {
      const vorhanden = doc.eintraege.find((e) => e.id === id);
      if (!vorhanden) return json({ error: "Idee nicht gefunden" }, 404, corsHeaders);
      const meins = normalizeUsername(vorhanden.username || "") === normalizeUsername(session.username);
      if (!meins && !session.isAdmin) return json({ error: "Das ist nicht deine Idee" }, 403, corsHeaders);
      // ⚠️ Ab "in Arbeit" ist die Idee festgeschrieben (Michel-Entscheidung).
      // Sonst aendert sich der Auftrag, waehrend daran gearbeitet wird -- und
      // bereits gegebene Daumen gaelten ploetzlich fuer etwas anderes.
      if (!meins || vorhanden.status === "neu") {
        vorhanden.titel = titel;
        vorhanden.text = text;
        vorhanden.anonym = anonym;
      } else {
        return json({ error: "Diese Idee ist schon in Arbeit und lässt sich nicht mehr ändern" }, 409, corsHeaders);
      }
      ergebnis = vorhanden;
    } else {
      if (doc.eintraege.length >= IDEEN_MAX) {
        return json({ error: `Es sind schon ${IDEEN_MAX} Ideen gespeichert. Bitte erst welche aufräumen.` }, 400, corsHeaders);
      }
      const neu = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        titel: titel,
        text: text,
        username: session.username,
        anonym: anonym,
        erstelltAm: new Date().toISOString(),
        status: "neu",
        stimmen: Object.create(null)
      };
      doc.eintraege.push(neu);
      ergebnis = neu;
    }

    try {
      await writeJson(IDEEN_URL, authHeader, doc, rev || undefined);
      break;
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) { ergebnis = null; continue; }
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  if (!ergebnis) return json({ error: "Idee konnte nicht gespeichert werden" }, 502, corsHeaders);

  return json({ idee: ideeFuerNutzer(ergebnis, session, session.usersDoc) }, 200, corsHeaders);
}

// Die eigene Idee zuruecknehmen (nur solange "neu"), oder als Admin jede.
async function handleIdeeLoeschen(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await ideenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const id = String((body && body.id) || "").trim();
  if (!/^[a-z0-9-]{1,40}$/i.test(id)) return json({ error: "Ungültige Id" }, 400, corsHeaders);

  let entfernt = false;
  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: roh, rev } = await readJsonWithRev(IDEEN_URL, authHeader, { version: 1, eintraege: [] });
    const doc = ideenDokNormieren(roh);
    const vorhanden = doc.eintraege.find((e) => e.id === id);
    if (!vorhanden) return json({ error: "Idee nicht gefunden" }, 404, corsHeaders);
    const meins = normalizeUsername(vorhanden.username || "") === normalizeUsername(session.username);
    if (!session.isAdmin) {
      if (!meins) return json({ error: "Das ist nicht deine Idee" }, 403, corsHeaders);
      if (vorhanden.status !== "neu") {
        return json({ error: "Diese Idee ist schon in Arbeit und lässt sich nicht mehr löschen" }, 409, corsHeaders);
      }
    }
    doc.eintraege = doc.eintraege.filter((e) => e.id !== id);
    try {
      await writeJson(IDEEN_URL, authHeader, doc, rev || undefined);
      entfernt = true;
      break;
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  if (!entfernt) return json({ error: "Idee konnte nicht gelöscht werden" }, 502, corsHeaders);

  return json({ ok: true }, 200, corsHeaders);
}

// Daumen hoch, einer je Person. Eigene schmale Aktion und NICHT ueber
// idee-speichern: das ist der einzige Schreibweg, der einen FREMDEN Eintrag
// anfasst -- er darf deshalb ausschliesslich das eigene Stimmfeld beruehren.
// Gleiche Ueberlegung wie toggle-news-reaction gegenueber save-news.
//
// If-Match mit drei Versuchen, weil hier wirklich mehrere Leute gleichzeitig
// klicken koennen (anders als bei den uebrigen Ideen-Wegen).
async function handleIdeeDaumen(request, body, env, authHeader, corsHeaders) {
  const { session, fehler } = await ideenSession(request, env, authHeader, corsHeaders);
  if (fehler) return fehler;

  const id = String((body && body.id) || "").trim();
  if (!/^[a-z0-9-]{1,40}$/i.test(id)) return json({ error: "Ungültige Id" }, 400, corsHeaders);

  const ich = normalizeUsername(session.username);
  let ergebnis = null;
  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: roh, rev } = await readJsonWithRev(IDEEN_URL, authHeader, { version: 1, eintraege: [] });
    const doc = ideenDokNormieren(roh);
    const eintrag = doc.eintraege.find((e) => e.id === id);
    if (!eintrag) return json({ error: "Idee nicht gefunden" }, 404, corsHeaders);
    if (getOwn(eintrag.stimmen, ich)) delete eintrag.stimmen[ich];
    else eintrag.stimmen[ich] = true;
    try {
      await writeJson(IDEEN_URL, authHeader, doc, rev || undefined);
      ergebnis = eintrag;
      break;
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  if (!ergebnis) return json({ error: "Zustimmung konnte nicht gespeichert werden" }, 502, corsHeaders);

  // Nach aussen geht die ZAHL, nie die Namensliste (Michel-Entscheidung: nur die
  // Zahl ist sichtbar, auch fuer Admins gibt es hier keine Namen).
  return json({
    id: ergebnis.id,
    daumen: Object.keys(ergebnis.stimmen).length,
    meinDaumen: !!getOwn(ergebnis.stimmen, ich)
  }, 200, corsHeaders);
}

// Status setzen und antworten -- nur globale Admins (Michel-Entscheidung; die
// Alternative "waehlbare Gruppe" lag vor und wurde verworfen).
//
// Leerer Antworttext nimmt die Antwort zurueck, wie bei feedback-antwort.
async function handleIdeeVerwalten(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session || !session.isAdmin) return json({ error: "Nicht berechtigt" }, 403, corsHeaders);

  const id = String((body && body.id) || "").trim();
  if (!/^[a-z0-9-]{1,40}$/i.test(id)) return json({ error: "Ungültige Id" }, 400, corsHeaders);
  const status = (body && body.status != null) ? String(body.status) : null;
  if (status !== null && !IDEEN_STATUS.includes(status)) {
    return json({ error: "Unbekannter Status" }, 400, corsHeaders);
  }
  // Ein FEHLENDES Feld heisst "unveraendert", ein mitgeschicktes leeres heisst
  // "loeschen" -- gleiche Unterscheidung wie bei set-aufgaben-gruppen.
  const antwortGesetzt = !!(body && body.antwort != null);
  const antwort = antwortGesetzt ? capStr(body.antwort, IDEEN_MAX_ANTWORT).trim() : null;

  const antworter = getOwn(session.usersDoc.users, session.username) || {};
  let ergebnis = null;
  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: roh, rev } = await readJsonWithRev(IDEEN_URL, authHeader, { version: 1, eintraege: [] });
    const doc = ideenDokNormieren(roh);
    const eintrag = doc.eintraege.find((e) => e.id === id);
    if (!eintrag) return json({ error: "Idee nicht gefunden" }, 404, corsHeaders);

    if (status !== null) eintrag.status = status;
    if (antwortGesetzt) {
      if (antwort) {
        eintrag.antwort = antwort;
        eintrag.antwortVon = (antworter.vorname && antworter.nachname)
          ? `${antworter.vorname} ${antworter.nachname}`
          : session.username;
        eintrag.antwortAm = new Date().toISOString();
      } else {
        delete eintrag.antwort;
        delete eintrag.antwortVon;
        delete eintrag.antwortAm;
      }
    }

    try {
      await writeJson(IDEEN_URL, authHeader, doc, rev || undefined);
      ergebnis = eintrag;
      break;
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
    }
  }
  if (!ergebnis) return json({ error: "Änderung konnte nicht gespeichert werden" }, 502, corsHeaders);

  return json({ idee: ideeFuerNutzer(ergebnis, session, session.usersDoc) }, 200, corsHeaders);
}

// ---------- Unterlagen zum Herunterladen (seit 2026-08-17) ----------
//
// Was der Verein einzelnen Personen oder allen bereitstellt. Abgeholt wird es im
// Tab "Mein Konto", befuellt aus den Dokumentenvorlagen: dort waehlt man ohnehin
// schon Vorlage und Empfaenger, und dort liegt der gepflegte Brieftext.
//
// ⚠️ Die Dateien kommen FERTIG herein, sie entstehen nicht hier. Der Weg von der
// Word-Vorlage zum PDF laeuft ueber `dokumentenvorlagen/docx-zu-pdf.ps1` auf
// Michels Rechner (Word-COM) -- im Browser gibt es keine verlaessliche
// Umwandlung, und ein nachgebautes Layout waere fuer ein Behoerdenschreiben mit
// Vereinsstempel zu wenig. Michel-Entscheidung vom 2026-08-17 nach vorgelegter
// Alternative.
//
// Block steht geschlossen am Dateiende und ist am Stueck wieder herausloesbar --
// wie die Aktivitaetspunkte, die Kleiderbestellung und die Ideen davor.

const UNTERLAGEN_URL = DAV_APPS.dokumentenvorlagen.replace(/[^/]+$/, "unterlagen.json");
const UNTERLAGEN_DIR = DAV_APPS.dokumentenvorlagen.replace(/\/[^/]+$/, "") + "/verteilt";
const UNTERLAGEN_MAX = 400;                    // Deckel ueber alle Eintraege
const UNTERLAGEN_MAX_BYTES = 10 * 1024 * 1024; // je Datei
const UNTERLAGEN_MAX_JE_LAUF = 60;             // Empfaenger je Verteilvorgang

function leeresUnterlagenDoc() {
  return { version: 1, eintraege: [] };
}

// ⚠️ Nur PDF. Erkannt an den ersten Bytes, NIE an einer Angabe des Clients --
// gleiche Linie wie `erkenneNachweisTyp` bei den Anmelde-Nachweisen. Michel-
// Vorgabe: was hier verteilt wird, soll jeder oeffnen und ausdrucken koennen,
// und eine Word-Datei mit Vereinsstempel waere nachtraeglich aenderbar.
function istPdfBytes(bytes) {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function unterlagenText(wert, maxLaenge) {
  const s = typeof wert === "string" ? wert : "";
  return s.slice(0, maxLaenge);
}

// Sicht des Nutzers auf einen Eintrag. Ein persoenlicher Eintrag verlaesst den
// Worker nur fuer seinen Empfaenger -- Ausblenden im Client waere kein
// Zurueckhalten. Der Verteiler-Name bleibt drin (er steht ohnehin im Brief).
function unterlageFuerNutzer(e, username, istAdmin) {
  const fuer = unterlagenText(e && e.fuer, 100);
  if (fuer && fuer !== username && !istAdmin) return null;
  return {
    id:            unterlagenText(e && e.id, 60),
    name:          unterlagenText(e && e.name, 200) || "Unterlage",
    dateiName:     unterlagenText(e && e.dateiName, 200) || "unterlage.pdf",
    groesse:       Number.isFinite(e && e.groesse) ? e.groesse : 0,
    hochgeladenAm: unterlagenText(e && e.hochgeladenAm, 40),
    persoenlich:   !!fuer,
    // Nur fuer Admins von Belang: an wen der Eintrag geht. Fuer den Empfaenger
    // selbst waere es die eigene Kennung, also ohne Wert.
    fuer:          istAdmin ? fuer : ""
  };
}

// ⚠️ Spielerkonten bleiben aussen vor -- gleiche Linie wie beim
// Materialcontainer-Code und bei `list-directory`. Hier gehen Vertraege und
// Behoerdenschreiben des Personals um.
function unterlagenZugang(session) {
  return session && session.art !== USER_ART_SPIELER;
}

async function handleUnterlagenMeine(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!unterlagenZugang(session)) return json({ error: "Kein Zugriff" }, 403, corsHeaders);

  const doc = await readJson(UNTERLAGEN_URL, authHeader, leeresUnterlagenDoc());
  const alle = Array.isArray(doc.eintraege) ? doc.eintraege : [];
  const name = normalizeUsername(session.username);
  const darfVerteilen = await resolveEditPermission("dokumentenvorlagen", session, env, authHeader);

  const meine = alle.map((e) => unterlageFuerNutzer(e, name, false)).filter(Boolean);
  // Neueste zuerst -- wer hereinschaut, sucht das gerade Dazugekommene.
  meine.sort((a, b) => String(b.hochgeladenAm).localeCompare(String(a.hochgeladenAm)));
  return json({
    persoenlich: meine.filter((e) => e.persoenlich),
    allgemein:   meine.filter((e) => !e.persoenlich),
    darfVerteilen
  }, 200, corsHeaders);
}

// ⚠️ Die Zugriffspruefung laeuft ueber DENSELBEN Filter wie die Liste
// (`unterlageFuerNutzer`). Zwei getrennte Regeln liefen unweigerlich auseinander,
// und ein Eintrag, der in der Liste fehlt, muss auch einzeln unerreichbar sein.
async function handleUnterlagenDatei(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!unterlagenZugang(session)) return json({ error: "Kein Zugriff" }, 403, corsHeaders);

  const id = String((body && body.id) || "");
  if (!FILE_ID_RE.test(id)) return json({ error: "Nicht gefunden" }, 404, corsHeaders);

  const doc = await readJson(UNTERLAGEN_URL, authHeader, leeresUnterlagenDoc());
  const alle = Array.isArray(doc.eintraege) ? doc.eintraege : [];
  const roh = alle.find((e) => e && e.id === id);
  const istAdmin = await resolveEditPermission("dokumentenvorlagen", session, env, authHeader);
  if (!roh || !unterlageFuerNutzer(roh, normalizeUsername(session.username), istAdmin)) {
    return json({ error: "Nicht gefunden" }, 404, corsHeaders);
  }

  let resp;
  try {
    resp = await fetch(UNTERLAGEN_DIR + "/" + encodeURIComponent(id), {
      method: "GET", headers: { Authorization: authHeader }
    });
  } catch (_) {
    return json({ error: "Nicht erreichbar" }, 502, corsHeaders);
  }
  if (resp.status === 404) return json({ error: "Nicht gefunden" }, 404, corsHeaders);
  if (!resp.ok) return json({ error: "Lesefehler " + resp.status }, 502, corsHeaders);

  return new Response(resp.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/pdf",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store"
    }
  });
}

// Eine Datei bereitstellen. Gerufen aus den Dokumentenvorlagen, je Datei einmal.
//
// ⚠️ Reihenfolge bindend: erst die Datei nach Nextcloud, dann der Eintrag. Bricht
// Schritt 2 ab, liegt eine Datei ohne Verweis herum (unerreichbar, weil die Liste
// die Schranke ist); andersherum stuende ein Eintrag da, dessen Download 404 gibt.
async function handleUnterlageVerteilen(request, body, env, authHeader, corsHeaders, execCtx) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveEditPermission("dokumentenvorlagen", session, env, authHeader))) {
    return json({ error: "Keine Berechtigung" }, 403, corsHeaders);
  }

  let bytes;
  try {
    bytes = base64ToBytes(String((body && body.dataBase64) || ""));
  } catch (_) {
    return json({ error: "Datei-Inhalt ist kein gültiges base64" }, 400, corsHeaders);
  }
  if (!bytes.length) return json({ error: "Leere Datei" }, 400, corsHeaders);
  if (bytes.length > UNTERLAGEN_MAX_BYTES) return json({ error: "Datei zu groß" }, 413, corsHeaders);
  if (!istPdfBytes(bytes)) return json({ error: "Nur PDF-Dateien" }, 415, corsHeaders);

  // ⚠️ Der Empfaenger muss ein existierendes Personal-Konto sein. Ohne diese
  // Pruefung landete eine Unterlage unter einem Tippfehler und waere fuer
  // niemanden abrufbar -- ohne dass es jemand merkt.
  const fuerRoh = normalizeUsername(String((body && body.fuer) || ""));
  let fuer = "";
  if (fuerRoh) {
    const u = getOwn(session.usersDoc.users || {}, fuerRoh);
    if (!u) return json({ error: "Unbekannter Empfänger: " + fuerRoh }, 404, corsHeaders);
    if (!istPersonal(u)) return json({ error: "Kein Personal-Konto: " + fuerRoh }, 400, corsHeaders);
    fuer = fuerRoh;
  }

  const doc = await readJson(UNTERLAGEN_URL, authHeader, leeresUnterlagenDoc());
  if (!Array.isArray(doc.eintraege)) doc.eintraege = [];
  if (doc.eintraege.length >= UNTERLAGEN_MAX) {
    return json({ error: "Es liegen bereits " + UNTERLAGEN_MAX + " Unterlagen bereit. Bitte zuerst aufräumen." }, 409, corsHeaders);
  }

  const id = crypto.randomUUID();
  try {
    let resp = await fetch(UNTERLAGEN_DIR + "/" + id, {
      method: "PUT",
      headers: { Authorization: authHeader, "Content-Type": "application/pdf" },
      body: bytes
    });
    // 404/409 = Unterordner fehlt noch -> anlegen und EINMAL wiederholen
    // (gleiches Muster wie handleUploadDocument in Trainerdaten).
    if (resp.status === 404 || resp.status === 409) {
      await fetch(UNTERLAGEN_DIR, { method: "MKCOL", headers: { Authorization: authHeader } });
      resp = await fetch(UNTERLAGEN_DIR + "/" + id, {
        method: "PUT",
        headers: { Authorization: authHeader, "Content-Type": "application/pdf" },
        body: bytes
      });
    }
    if (!resp.ok) throw new Error("PUT " + resp.status);
  } catch (e) {
    return json({ error: "Datei konnte nicht abgelegt werden: " + e.message }, 502, corsHeaders);
  }

  doc.eintraege.push({
    id,
    name:          unterlagenText(body && body.name, 200) || unterlagenText(body && body.dateiName, 200) || "Unterlage",
    dateiName:     unterlagenText(body && body.dateiName, 200) || "unterlage.pdf",
    groesse:       bytes.length,
    hochgeladenAm: new Date().toISOString(),
    von:           normalizeUsername(session.username),
    fuer
  });

  try {
    await writeJson(UNTERLAGEN_URL, authHeader, doc);
  } catch (e) {
    return json({ error: "Datei abgelegt, aber Liste nicht gespeichert: " + e.message }, 502, corsHeaders);
  }

  // Abzeichen und Meldung nur bei persoenlichen Unterlagen an genau diese Person.
  // Bei "fuer alle" waere ein Push je Datei eine Rundnachricht an die ganze
  // Belegschaft -- dafuer gibt es das Panel im Einstellungen-Tab.
  //
  // ⚠️ Der Verteilende ist hier bewusst NICHT ausgenommen -- anders als bei den
  // uebrigen Anlaessen, gleiche Linie wie bei der Rundnachricht. Der Versand
  // laeuft in waitUntil und meldet nichts zurueck; die eigene Nachricht auf dem
  // eigenen Handy ist der einzige Zustellnachweis, den es gibt. Der Ausschluss
  // stand hier zuerst drin und war genau deshalb falsch: Michel stellte sich
  // die erste Unterlage selbst bereit und bekam nie eine Meldung (2026-08-17).
  if (fuer) {
    execCtx.waitUntil(unterlagenZaehlerErhoehen(authHeader, [fuer]));
    if (body && body.push === true) {
      pushSenden(env, authHeader, execCtx, [fuer], "unterlagen",
        "Ein Dokument liegt für dich zum Herunterladen bereit. Du findest es in der Toolübersicht bei deinen Unterlagen.");
    }
  }
  return json({ ok: true, id }, 200, corsHeaders);
}

async function handleUnterlageEntfernen(request, body, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveEditPermission("dokumentenvorlagen", session, env, authHeader))) {
    return json({ error: "Keine Berechtigung" }, 403, corsHeaders);
  }
  const id = String((body && body.id) || "");
  if (!FILE_ID_RE.test(id)) return json({ error: "Nicht gefunden" }, 404, corsHeaders);

  const doc = await readJson(UNTERLAGEN_URL, authHeader, leeresUnterlagenDoc());
  const alle = Array.isArray(doc.eintraege) ? doc.eintraege : [];
  if (!alle.some((e) => e && e.id === id)) return json({ error: "Nicht gefunden" }, 404, corsHeaders);

  // Erst den Eintrag, dann die Datei: der Eintrag ist die Schranke, ohne ihn ist
  // die Datei bereits unerreichbar. Scheitert das DELETE danach, bleibt nur eine
  // Leiche liegen (gleiche Linie wie beim Aufraeumen der Neuigkeiten-Medien).
  doc.eintraege = alle.filter((e) => !(e && e.id === id));
  try {
    await writeJson(UNTERLAGEN_URL, authHeader, doc);
  } catch (e) {
    return json({ error: "Speicherfehler: " + e.message }, 502, corsHeaders);
  }
  try {
    await fetch(UNTERLAGEN_DIR + "/" + encodeURIComponent(id), {
      method: "DELETE", headers: { Authorization: authHeader }
    });
  } catch (_) { /* siehe Kommentar */ }
  return json({ ok: true }, 200, corsHeaders);
}

// Liste fuer die Verteil-Seite in den Dokumentenvorlagen: alles, auch fremde
// persoenliche Eintraege. Eigene Aktion statt eines Schalters an
// `unterlagen-meine`, damit der Lese-Weg des Konto-Tabs keinen Admin-Zweig traegt.
async function handleUnterlagenAlle(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  if (!(await resolveEditPermission("dokumentenvorlagen", session, env, authHeader))) {
    return json({ error: "Keine Berechtigung" }, 403, corsHeaders);
  }
  const doc = await readJson(UNTERLAGEN_URL, authHeader, leeresUnterlagenDoc());
  const alle = (Array.isArray(doc.eintraege) ? doc.eintraege : [])
    .map((e) => unterlageFuerNutzer(e, normalizeUsername(session.username), true))
    .filter(Boolean);
  alle.sort((a, b) => String(b.hochgeladenAm).localeCompare(String(a.hochgeladenAm)));
  return json({ eintraege: alle, deckel: UNTERLAGEN_MAX, maxJeLauf: UNTERLAGEN_MAX_JE_LAUF }, 200, corsHeaders);
}

// =============================================================================
// Busplan: Erinnerung an die zugesagte Fahrt (seit 2026-08-17)
//
// Michel-Vorgabe: drei Tage bevor eine Mannschaft ihren Bus hat, bekommen ihre
// Trainer eine Nachricht aufs Handy UND eine E-Mail. In der Mail stehen
// zusaetzlich die Regeln genau des Busses, der zugesagt ist -- die Push-Meldung
// nennt sie nicht, auf einem Sperrbildschirm ist dafuer kein Platz.
//
// ✅ KEIN DRITTER CRON-TRIGGER. Dieser Lauf haengt am bestehenden naechtlichen
// Trigger "0 4 * * *" (Spieltagscrew). Ein eigener Trigger muesste von Hand im
// Cloudflare-Dashboard angelegt werden -- genau der Schritt, der beim naechsten
// Deploy vergessen wird und den dann niemand vermisst, weil ein ausbleibendes
// Push nicht auffaellt.
//
// ⚠️ busplan.json wird NUR GELESEN. Merker und Laufbericht liegen in einer
// eigenen Datei daneben. Wuerde der Lauf in die Nutzdatei schreiben, kollidierte
// er mit dem Autosave der App (Last-Write-Wins) und koennte eine Aenderung
// ueberbuegeln, die jemand am Abend vorher gemacht hat.
//
// Als geschlossener Block am Dateiende, wie der Ablaufplan davor: am Stueck
// wieder herausloesbar.

const BUSPLAN_ERINNERT_URL = DAV_APPS["busplan"].replace(/[^/]+$/, "busplan-erinnert.json");

// Vorlauf in Tagen. ⚠️ Muss zum Info-Text in E:\busplan\config.js passen --
// beide sprechen von drei Tagen.
const BUSPLAN_VORLAUF_TAGE = 3;
// Wie lange ein Merker aufgehoben wird. Grosszuegiger als beim Ablaufplan: hier
// zaehlen Tage, nicht Minuten, und ein zu frueh weggeraeumter Merker schickt
// dieselbe Fahrt ein zweites Mal.
const BUSPLAN_MERKER_TAGE = 21;
// Deckel je Lauf, gegen den Fall, dass jemand einen ganzen Spielplan auf
// dieselbe Woche legt. Jede Fahrt kostet eine Mail.
const BUSPLAN_MAX_JE_LAUF = 40;

// Nur diese Status gelten als "der Bus steht". Michel-Vorgabe: die Erinnerung
// haengt an der ZUSAGE, nicht an "offen" oder "in Klaerung" -- eine Fahrt, die
// noch nicht sicher ist, soll niemanden losfahren lassen.
const BUSPLAN_STATUS_ZUSAGE = "zusage";

// ⚠️ Bewusst dieselbe Funktion wie der Ablaufplan, keine dritte Kopie:
// ablaufplanNormTeam ist die (schon zweite) Kopie von normMannschaft aus
// E:\ablaufplan\zeitlogik.js. Beide Laeufe muessen "D1-Jugend" im Profil und
// "D1" im Datensatz gleich behandeln; zwei Schreibweisen desselben Vergleichs
// waeren genau der Fehler, den man erst bemerkt, wenn eine Erinnerung ausbleibt.
const busplanNormTeam = ablaufplanNormTeam;

// Wer wird erinnert: die Trainer, in deren Profil (nutzer.json, Feld
// "mannschaften") die Mannschaft des Spiels steht.
//
// ⚠️ NICHT das Freitextfeld "trainer" am Team im Busplan. Dort steht ein
// getippter Name ohne Verbindung zu einem Konto -- eine abweichende Schreibweise
// haette lautlos niemanden erreicht, und eine Mailadresse gibt es dort ohnehin
// nicht. Archivierte Konten und Spielerkonten bleiben aussen vor.
function busplanEmpfaenger(teamName, usersDoc) {
  const ziel = busplanNormTeam(teamName);
  if (!ziel) return [];

  const treffer = [];
  const gesehen = Object.create(null);
  for (const schluessel of Object.keys((usersDoc && usersDoc.users) || {})) {
    const u = usersDoc.users[schluessel];
    if (!u || u.archiviert || !istPersonal(u)) continue;
    const meine = (Array.isArray(u.mannschaften) ? u.mannschaften : []).map(busplanNormTeam);
    if (meine.indexOf(ziel) < 0) continue;
    const name = normalizeUsername(String(u.username || schluessel));
    if (!name || gesehen[name]) continue;
    gesehen[name] = true;
    treffer.push(name);
  }
  return treffer;
}

// Der Merker haengt am SET der zugesagten Busse, nicht nur am Spiel: kommt
// nachtraeglich ein zweiter Bus dazu, ist das eine neue Lage und verdient eine
// neue Nachricht. Datum steht mit drin -- wird das Spiel verschoben, bekommt der
// neue Termin seine eigene Erinnerung.
function busplanMerkerSchluessel(team, spiel, optionIds) {
  return team.id + ":" + spiel.id + ":" + spiel.datum + ":" + optionIds.slice().sort().join("+");
}

function busplanMerkerAufraeumen(ids, jetzt) {
  const grenze = jetzt - BUSPLAN_MERKER_TAGE * 86400000;
  const sauber = Object.create(null);
  for (const [k, v] of Object.entries(ids || {})) {
    const ms = Date.parse(String(v || ""));
    if (Number.isFinite(ms) && ms >= grenze) sauber[k] = v;
  }
  return sauber;
}

// Sucht die Fahrten, die in den naechsten BUSPLAN_VORLAUF_TAGE Tagen anstehen,
// einen zugesagten Bus haben und noch keine Erinnerung bekommen haben.
//
// ⚠️ Das Fenster ist ein ZEITRAUM (heute bis heute+3), kein einzelner Stichtag.
// Bei "genau heute+3" bliebe jede Zusage stumm, die erst zwei Tage vor der Fahrt
// gesetzt wird -- und das ist der haeufige Fall, nicht der seltene. Der Merker
// verhindert, dass daraus vier Nachrichten werden.
//
// Reine Rechnung ohne Nextcloud, damit sie sich einzeln pruefen laesst.
function busplanFaellige(doc, ids, heute, letzterTag) {
  const seasons = (doc && doc.seasons && typeof doc.seasons === "object") ? doc.seasons : {};
  const key = (doc && doc.meta && doc.meta.currentSeason) || Object.keys(seasons)[0] || "";
  const season = getOwn(seasons, key);
  if (!season) return [];

  const optionen = Array.isArray(season.busOptions) ? season.busOptions : [];
  const treffer = [];

  for (const team of (Array.isArray(season.teams) ? season.teams : [])) {
    if (!team || !team.id || !team.name) continue;
    for (const spiel of (Array.isArray(team.spiele) ? team.spiele : [])) {
      if (!spiel || !spiel.id) continue;
      const datum = String(spiel.datum || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) continue;
      if (datum < heute || datum > letzterTag) continue;

      // Welche Busse stehen fuer dieses Spiel? Es koennen mehrere sein -- dann
      // nennt eine einzige Nachricht sie alle, statt zwei Mails fuer dieselbe
      // Fahrt zu verschicken.
      const zugesagt = [];
      const statusMap = (spiel.status && typeof spiel.status === "object") ? spiel.status : {};
      for (const o of optionen) {
        if (!o || !o.id) continue;
        const eintrag = getOwn(statusMap, o.id);
        if (eintrag && eintrag.wert === BUSPLAN_STATUS_ZUSAGE) zugesagt.push(o);
      }
      if (!zugesagt.length) continue;

      const schluessel = busplanMerkerSchluessel(team, spiel, zugesagt.map((o) => o.id));
      if (Object.prototype.hasOwnProperty.call(ids || {}, schluessel)) continue;
      treffer.push({ team, spiel, busse: zugesagt, schluessel });
    }
  }

  // Die naechste Fahrt zuerst, damit der Deckel im Zweifel das Dringendste nimmt.
  treffer.sort((a, b) => String(a.spiel.datum).localeCompare(String(b.spiel.datum)));
  return treffer.slice(0, BUSPLAN_MAX_JE_LAUF);
}

// "Freitag, 20.08.2026". Mittags-UTC als Anker, damit die Zeitzone den Tag nicht
// ueber die Mitternachtsgrenze schiebt.
function busplanDatumLang(datum) {
  const ms = Date.parse(datum + "T12:00:00Z");
  if (!Number.isFinite(ms)) return datum;
  return new Date(ms).toLocaleDateString("de-DE", {
    weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin"
  });
}

function busplanTageBis(datum, heute) {
  const a = Date.parse(heute + "T12:00:00Z");
  const b = Date.parse(datum + "T12:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// ⚠️ Der Text steht auf dem Sperrbildschirm: Mannschaft, Tag, Bus, Ort -- aber
// NIE ein Personenname. Die Trainernamen im Busplan sind getippter Freitext und
// haetten hier nichts zu suchen.
function busplanPushText(f, heute) {
  const tage = busplanTageBis(f.spiel.datum, heute);
  const wann = tage === 0 ? "Heute" : tage === 1 ? "Morgen" : tage === 2 ? "Übermorgen"
    : "In " + tage + " Tagen";
  const busse = f.busse.map((o) => o.name).join(" + ");
  const ort = String(f.spiel.ort || "").trim();
  return wann + ": " + f.team.name + " fährt mit " + busse + (ort ? " nach " + ort : "") +
    ". Abfahrtszeit und die Regeln für die Fahrt stehen im Busplan.";
}

// Die Mail ist der Ort fuer die Regeln -- deshalb gibt es sie ueberhaupt
// zusaetzlich zum Push. Fehlen bei einem Bus die Regeln, steht das auch da:
// eine Leerstelle ist eine Auskunft, ein weggelassener Absatz ist keine.
function busplanMailText(f) {
  const zeilen = [];
  zeilen.push("Hallo,");
  zeilen.push("");
  zeilen.push("für die " + f.team.name + " steht der Bus für das nächste Auswärtsspiel fest.");
  zeilen.push("Hier alles Wichtige auf einen Blick:");
  zeilen.push("");
  zeilen.push("Tag:  " + busplanDatumLang(f.spiel.datum));
  const ort = String(f.spiel.ort || "").trim();
  if (ort) zeilen.push("Ort:  " + ort);
  zeilen.push("Bus:  " + f.busse.map((o) => o.name).join(" + "));
  const notiz = String(f.spiel.notiz || "").trim();
  if (notiz) {
    zeilen.push("");
    zeilen.push("Hinweis zum Spiel:");
    zeilen.push(notiz);
  }

  for (const o of f.busse) {
    zeilen.push("");
    zeilen.push("--- Regeln für " + o.name + " ---");
    const regeln = String(o.regeln || "").trim();
    zeilen.push(regeln || "(Für diesen Bus sind noch keine Regeln hinterlegt.)");
  }

  zeilen.push("");
  zeilen.push("Bitte gib Tag, Ort und den Bus an deine Mannschaft und die Eltern weiter —");
  zeilen.push("diese Mail geht nur an die Verantwortlichen, nicht an die Spieler.");
  zeilen.push("");
  zeilen.push("Passt etwas nicht oder fällt die Fahrt aus, melde dich bitte so früh wie");
  zeilen.push("möglich in der Geschäftsstelle. Ein Bus, der leer fährt, kostet den Verein");
  zeilen.push("genauso viel wie ein voller.");
  zeilen.push("");
  zeilen.push("Der vollständige Busplan mit allen Mannschaften und Fahrten:");
  zeilen.push("https://sc1911heiligenstadt.github.io/busplan/");
  zeilen.push("");
  zeilen.push("Diese Nachricht wurde automatisch verschickt.");
  zeilen.push(NOTIFY_FROM_NAME);
  return zeilen.join("\n");
}

// Adresse serverseitig aus den Trainerdaten, nie aus dem Busplan-Datensatz --
// gleiche Auflösung wie handleNotifyUser. Liefert "" wenn nichts hinterlegt ist.
function busplanAdresse(username, usersDoc, trainerdatenDoc) {
  const u = getOwn((usersDoc && usersDoc.users) || {}, username);
  if (!u) return "";
  const td = findTrainerdatenRecord(trainerdatenDoc, u);
  return String(buildTrainerdatenSummary(td).email || "").trim();
}

async function busplanMailSenden(env, empfaengerMail, betreff, text) {
  if (!env.BREVO_API_KEY || !empfaengerMail) return false;
  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        sender: { email: NOTIFY_FROM_EMAIL, name: NOTIFY_FROM_NAME },
        to: [{ email: empfaengerMail }],
        subject: betreff,
        textContent: text
      })
    });
    if (!resp.ok) {
      console.error("Busplan-Mail fehlgeschlagen", resp.status, await resp.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("Busplan-Mail fehlgeschlagen", e && e.message);
    return false;
  }
}

async function busplanErinnerungslauf(env, authHeader, execCtx) {
  const doc = await readJson(DAV_APPS["busplan"], authHeader, null);
  if (!doc || !doc.seasons) return { gesendet: 0 };

  const heute = scHeuteBerlin();
  const letzterTag = scTagPlus(BUSPLAN_VORLAUF_TAGE);
  const jetzt = Date.now();

  let merker = await readJson(BUSPLAN_ERINNERT_URL, authHeader, { version: 1, ids: {} });
  if (!merker || typeof merker !== "object") merker = { version: 1, ids: {} };
  const ids = (merker.ids && typeof merker.ids === "object") ? merker.ids : {};

  const faellig = busplanFaellige(doc, ids, heute, letzterTag);
  if (!faellig.length) {
    await busplanLaufVermerken(authHeader, merker, ids, jetzt,
      { fahrten: 0, push: 0, mails: 0, ohneTrainer: [], ohneAdresse: [] }, null);
    return { gesendet: 0 };
  }

  const usersDoc = await readJson(env.NEXTCLOUD_NUTZER_URL, authHeader, emptyUsersDoc());
  const trainerdatenDoc = await readJson(PROVISION_ONLY_PATHS.trainerdaten, authHeader, { version: 1, trainer: [] });

  // ⚠️ Reihenfolge bindend: erst merken, dann verschicken -- dieselbe Lehre wie
  // beim Ablaufplan. Andersherum meldete ein Fehlschlag beim Schreiben dieselbe
  // Fahrt in jeder Nacht erneut, und hier haengt an jeder Wiederholung eine Mail.
  const jetztIso = new Date(jetzt).toISOString();
  faellig.forEach((f) => { ids[f.schluessel] = jetztIso; });
  try {
    await busplanLaufVermerken(authHeader, merker, ids, jetzt, null, null);
  } catch (_) {
    return { gesendet: 0, fehler: "merker" };
  }

  const bericht = { fahrten: 0, push: 0, mails: 0, ohneTrainer: [], ohneAdresse: [] };

  for (const f of faellig) {
    const empfaenger = busplanEmpfaenger(f.team.name, usersDoc);
    if (!empfaenger.length) {
      // Der Nachlese-Ort. Ein ausbleibendes Push faellt niemandem auf -- eine
      // Mannschaft ohne zugeordnetes Trainerkonto muss deshalb sichtbar werden,
      // sonst wartet jemand auf eine Nachricht, die es nie geben wird.
      if (bericht.ohneTrainer.indexOf(f.team.name) < 0) bericht.ohneTrainer.push(f.team.name);
      continue;
    }
    bericht.fahrten++;

    pushSenden(env, authHeader, execCtx, empfaenger, "busplan", busplanPushText(f, heute));
    bericht.push += empfaenger.length;

    const betreff = "Bus für die " + f.team.name + " am " + busplanDatumLang(f.spiel.datum);
    const text = busplanMailText(f);
    for (const u of empfaenger) {
      const adresse = busplanAdresse(u, usersDoc, trainerdatenDoc);
      if (!adresse) {
        // Zweiter Nachlese-Fall: Konto da, aber keine Adresse in den
        // Trainerdaten. Push kam an, die Mail mit den Regeln nicht.
        if (bericht.ohneAdresse.indexOf(f.team.name) < 0) bericht.ohneAdresse.push(f.team.name);
        continue;
      }
      if (await busplanMailSenden(env, adresse, betreff, text)) bericht.mails++;
    }
  }

  await busplanLaufVermerken(authHeader, merker, ids, jetzt, bericht, null);
  return { gesendet: bericht.push, mails: bericht.mails };
}

// Merker und Laufbericht in einem Rutsch. Ohne die sichtbare Zeile faellt ein
// stiller Fehlschlag um 4 Uhr nachts niemandem auf -- der Busplan zeigt sie im
// Tab Übersicht an.
async function busplanLaufVermerken(authHeader, merker, ids, jetzt, bericht, fehler) {
  merker.version = 1;
  merker.ids = busplanMerkerAufraeumen(ids, jetzt);
  if (bericht) {
    merker.lauf = {
      zuletztAm: new Date(jetzt).toISOString(),
      fahrten: bericht.fahrten,
      push: bericht.push,
      mails: bericht.mails,
      ohneTrainer: bericht.ohneTrainer.slice(0, 20),
      ohneAdresse: bericht.ohneAdresse.slice(0, 20),
      fehler: fehler ? capStr(fehler, 200) : ""
    };
  }
  await writeJson(BUSPLAN_ERINNERT_URL, authHeader, merker);
}

// Der Nachlese-Ort fuer die App. Nur lesend, kein Gegenstueck zum Schreiben:
// den Lauf loest ausschliesslich der Zeitplan aus. Sichtbar fuer jedes
// angemeldete Konto -- der Busplan selbst ist es auch, und der Bericht nennt
// keine Personen, nur Mannschaftsnamen und Zahlen.
async function handleBusplanErinnerungen(request, env, authHeader, corsHeaders) {
  const session = await getVerifiedSession(request, env, authHeader);
  if (!session) return json({ error: "Nicht angemeldet" }, 401, corsHeaders);
  const merker = await readJson(BUSPLAN_ERINNERT_URL, authHeader, { version: 1, ids: {} });
  const lauf = (merker && merker.lauf && typeof merker.lauf === "object") ? merker.lauf : null;
  return json({ lauf, vorlaufTage: BUSPLAN_VORLAUF_TAGE }, 200, corsHeaders);
}

// ==========================================================================
// Klubzertifizierung — Tab in der App "Vereinsaufgaben"
// ==========================================================================
//
// Michel-Auftrag vom 2026-08-17: ein Werkzeug fuer die Klubzertifizierung des
// Verbandes, mit der Moeglichkeit, daraus Aufgaben zu verteilen. Grundlage sind die
// zwei PDF-Anhaenge der Clubberatung vom 28.04.2026: 29 Basis- und 49
// Zusatzkriterien in je drei Bereichen.
//
// Michel-Entscheidungen aus dem Grill-me-Interview (jede einzeln vorgelegt und
// bestaetigt, in dieser Reihenfolge):
//
//   Ort         Tab in "Vereinsaufgaben", KEINE eigene App (Alternative lag vor)
//   Aufgaben    eigene leichte Mini-Aufgaben im Tab, NICHT echte Vereinsaufgaben
//   Status      offen / erfuellt / passt nicht zu uns -- kein gespeichertes "in Arbeit"
//   Nachweise   Notizfeld plus Dateien, beides freiwillig
//   Rechte      Status setzen nur Administrieren; alles andere ab Bearbeiten
//   Katalog     fest im Code (kriterien.js), nicht in der App pflegbar
//   Empfaenger  nur Personen mit Zugang zu dieser App
//   Nachricht   KEINE -- kein Mail, kein Push (bewusst, siehe unten)
//   Frist       freiwillig
//   Ziel        nur den Stand zeigen, keine Schwelle "geschafft"
//   Protokoll   Verlauf je Kriterium
//   Ausgabe     Druckansicht (kein CSV)
//   Aufbau      ein Tab, innen Umschalter Basis/Zusatz
//   Ressort     optionales Zuordnungsfeld je Kriterium
//
// ⚠️ Bewusst KEINE Benachrichtigung. Michel hat das ausdruecklich so entschieden,
// obwohl er dieselbe Festlegung bei den Vereinsaufgaben einen Tag spaeter gekippt
// hat. Daraus folgt eine benannte Luecke, die kein Fehler ist: eine
// Zertifizierungs-Aufgabe kann monatelang unbemerkt liegen. Wer sie schliessen
// will, haengt sich an `pushSenden` mit dem bestehenden Anlass `aufgaben` -- der
// Empfaenger steht im Datensatz.
//
// ⚠️ Der Katalog steht NICHT hier, sondern in `E:\Vereinsaufgaben\kriterien.js`.
// Der Worker kennt die 78 Kriterien absichtlich nicht: eine zweite Kopie liefe
// unweigerlich auseinander (gleiche Lage wie NEWS_REACTION_EMOJIS, nur andersherum
// geloest). Was er stattdessen prueft, ist die FORM der Kriterium-Id -- und leitet
// aus deren Praefix ab, ob es ein Basis- oder ein Zusatzkriterium ist. Die Id-Form
// ist damit Teil des Vertrags zwischen kriterien.js und diesem Block; wer sie dort
// aendert, muss ZERT_KRIT_RE mitziehen.

// Eigene Datei neben vereinsaufgaben.json. ⚠️ Bewusst NICHT in dieselbe Datei:
// die Aufgaben werden im Alltag laufend geschrieben, der Zertifizierungsstand
// selten -- ein If-Match-Konflikt beim Abhaken einer Aufgabe soll nicht den
// Kriterienstand zurueckwerfen und umgekehrt.
const ZERT_URL = VEREINSAUFGABEN_URL.slice(0, VEREINSAUFGABEN_URL.lastIndexOf("/")) + "/zertifizierung.json";

// Nachweis-Dateien in eigenem Unterordner, denselben zwei Schranken unterworfen wie
// die Aufgaben-Anhaenge: davFileDir() zeigt fest auf "dateien", und ohne
// DAV_APPS-Eintrag gibt es keine App-Id, ueber die man den Ordner adressieren
// koennte.
const ZERT_NACHWEIS_DIR = VEREINSAUFGABEN_URL.slice(0, VEREINSAUFGABEN_URL.lastIndexOf("/")) + "/zertifizierung-nachweise";

// ⚠️ Diese Regex ist die einzige Schranke gegen erfundene Kriterium-Ids -- und
// zugleich der Weg, die Art zu bestimmen. Sie laesst weder Punkte noch Schraegstriche
// noch `__proto__` durch; die Id wird Schluessel in der Datei, nie Teil eines Pfades.
const ZERT_KRIT_RE = /^(basis|zusatz)-(spielbetrieb|organisation|kultur)-\d{2}$/;

const ZERT_MAX_NOTIZ = 4000;
const ZERT_MAX_TITEL = 200;
const ZERT_MAX_AUFGABEN = 1000;          // ueber alle Kriterien
const ZERT_MAX_AUFGABEN_JE_KRIT = 20;
const ZERT_MAX_NACHWEISE = 10;           // je Kriterium
const ZERT_MAX_NACHWEIS_BYTES = 8 * 1024 * 1024;
const ZERT_MAX_VERLAUF = 200;            // je Kriterium
const ZERT_STATUS_WERTE = ["offen", "erfuellt", "nichtrelevant"];

// ⚠️ "Passt nicht zu uns" gibt es nur bei Zusatzkriterien. Die 29 Basiskriterien
// sind das Pflichtprogramm des Verbandes -- ein Basiskriterium wegzudruecken hiesse,
// sich die eigene Bilanz schoenzurechnen. Der Client bietet es dort auch nicht an;
// diese Zeile ist die Schranke, nicht die Anzeige.
function zertStatusErlaubt(status, art) {
  if (!ZERT_STATUS_WERTE.includes(status)) return false;
  if (status === "nichtrelevant" && art !== "zusatz") return false;
  return true;
}

// Form pruefen und Art zurueckgeben. Wirft, statt einen Vorgabewert zu liefern:
// eine unbekannte Id ist immer ein Fehler des Aufrufers, nie ein Sonderfall.
function zertKritId(roh) {
  const id = capStr(roh, 64);
  if (!ZERT_KRIT_RE.test(id)) throw new VaFehler("Unbekanntes Kriterium", 400);
  return id;
}

function zertKritArt(id) {
  return id.slice(0, id.indexOf("-"));
}

function zertLeer() {
  return { version: 1, kriterien: Object.create(null), aufgaben: [] };
}

// ⚠️ `kriterien` wird als Object.create(null) aufgebaut, auch beim Einlesen einer
// vorhandenen Datei: JSON.parse liefert ein normales Objekt, dessen Prototyp bei
// einem Schluessel `__proto__` getroffen wuerde. Die Regex laesst den zwar nicht
// durch, aber die Schranke soll nicht die einzige sein.
function zertNormalisiere(doc) {
  doc.version = doc.version || 1;
  const roh = (doc.kriterien && typeof doc.kriterien === "object") ? doc.kriterien : {};
  const sauber = Object.create(null);
  Object.keys(roh).forEach((id) => {
    if (!ZERT_KRIT_RE.test(id)) return;               // Altlast oder Handeintrag
    const k = roh[id];
    if (!k || typeof k !== "object") return;
    sauber[id] = {
      status: ZERT_STATUS_WERTE.includes(k.status) ? k.status : "offen",
      notiz: typeof k.notiz === "string" ? k.notiz : "",
      ressortId: typeof k.ressortId === "string" ? k.ressortId : "",
      geaendertAm: k.geaendertAm || "",
      geaendertVon: k.geaendertVon || "",
      nachweise: Array.isArray(k.nachweise) ? k.nachweise : [],
      verlauf: Array.isArray(k.verlauf) ? k.verlauf : []
    };
  });
  doc.kriterien = sauber;
  if (!Array.isArray(doc.aufgaben)) doc.aufgaben = [];
  return doc;
}

// Read-modify-write mit If-Match und drei Versuchen -- dasselbe Muster wie
// vaMutiere, nur auf der eigenen Datei.
async function zertMutiere(authHeader, fn) {
  for (let versuch = 0; versuch < 3; versuch++) {
    const { data: doc, rev } = await readJsonWithRev(ZERT_URL, authHeader, zertLeer());
    zertNormalisiere(doc);
    const ergebnis = fn(doc) || {};
    try {
      await writeJson(ZERT_URL, authHeader, doc, rev || undefined);
      return { ok: true, ...ergebnis };
    } catch (e) {
      if (e instanceof ConflictError && versuch < 2) continue;
      throw e;
    }
  }
  throw new VaFehler("Speichern nach drei Versuchen fehlgeschlagen", 502);
}

// Legt den Eintrag beim ERSTEN Schreiben an. Die Datei fuehrt damit nur die
// Kriterien, an denen wirklich gearbeitet wurde -- 78 leere Objekte waeren
// Ballast, den jeder Lesevorgang mitschleppt.
function zertKritEintrag(doc, id) {
  if (!doc.kriterien[id]) {
    doc.kriterien[id] = {
      status: "offen", notiz: "", ressortId: "",
      geaendertAm: "", geaendertVon: "", nachweise: [], verlauf: []
    };
  }
  return doc.kriterien[id];
}

// ⚠️ Der Verlauf fuehrt Status- und Ressortwechsel, NICHT jede Notizaenderung.
// Michel wollte nachvollziehen koennen, seit wann ein Kriterium erfuellt ist; eine
// Zeile je Tippkorrektur an der Notiz haette genau das unlesbar gemacht. Dass die
// Notiz angefasst wurde, steht in geaendertAm/Von.
function zertVerlauf(k, von, was, alt, neu) {
  if (!Array.isArray(k.verlauf)) k.verlauf = [];
  k.verlauf.push({
    am: new Date().toISOString(), von, was,
    alt: alt == null ? "" : String(alt),
    neu: neu == null ? "" : String(neu)
  });
  if (k.verlauf.length > ZERT_MAX_VERLAUF) k.verlauf.splice(0, k.verlauf.length - ZERT_MAX_VERLAUF);
}

function zertAufgabeHolen(doc, id) {
  const a = doc.aufgaben.find((x) => x && x.id === String(id || ""));
  if (!a) throw new VaFehler("Aufgabe nicht gefunden", 404);
  return a;
}

// Anders als bei den Vereinsaufgaben ist die Frist hier FREIWILLIG (leer erlaubt).
// Michel-Entscheidung: bei einem Kriterium wie "Materialbestand pflegen" gibt es
// keinen echten Termin, und ein Zwang zum Datum erzeugt nur Fantasiewerte.
function zertDatum(roh) {
  const s = capStr(roh, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

// ---------- Laden ----------

// ⚠️ Eigene Aktion statt Mitliefern in `vereinsaufgaben-load`. Das waere ein
// zusaetzlicher Nextcloud-Read (200-450 ms) bei JEDEM Oeffnen der Aufgaben-App,
// auch fuer die Mehrheit, die den Zertifizierungs-Tab nie anfasst. Der Client holt
// die Daten beim ersten Wechsel in den Tab -- gleiche Ueberlegung wie bei
// loadMeineFeedbacks in der Tools-Uebersicht.
//
// Ressorts und die Personenliste kommen NICHT hier mit: der Tab lebt in derselben
// App, der Client hat beides ohnehin aus `vereinsaufgaben-load` und
// `list-tool-editors`.
async function handleZertLoad(request, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    const doc = zertNormalisiere(await readJson(ZERT_URL, authHeader, zertLeer()));
    const usersDoc = ctx.session.usersDoc;

    // Anzeigenamen aus nutzer.json, nicht aus dem Datensatz -- eine Umbenennung
    // soll nicht den alten Namen weiterzeigen. Ausgeschiedene bleiben mit ihrem
    // Nutzernamen sichtbar, damit die Historie lesbar bleibt.
    const namen = {};
    const merke = (u) => { if (u && !namen[u]) namen[u] = aufgabenAnzeigeName(usersDoc, u); };
    doc.aufgaben.forEach((a) => { merke(a.empfaenger); merke(a.erstelltVon); merke(a.erledigtVon); });
    Object.keys(doc.kriterien).forEach((id) => {
      const k = doc.kriterien[id];
      merke(k.geaendertVon);
      (k.nachweise || []).forEach((f) => merke(f.von));
      (k.verlauf || []).forEach((v) => merke(v.von));
    });

    return json({
      kriterien: doc.kriterien,
      aufgaben: doc.aufgaben,
      namen,
      me: { username: ctx.session.username, isAdmin: !!ctx.session.isAdmin, canEdit: ctx.canEdit, canAdmin: ctx.canAdmin }
    }, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// ---------- Status eines Kriteriums ----------

// ⚠️ Administrieren, nicht Bearbeiten. Michel-Entscheidung: "erfuellt" ist die
// Aussage, die der Verein dem Verband gegenueber macht -- Zeugwart und
// Foerdertrainer sollen mithelfen, aber nicht darueber entscheiden. Bei dieser App
// sind Sehen und Bearbeiten deckungsgleich (fuenf Gruppen), Administrieren ist
// enger (drei) -- die Trennung hat hier also wirklich eine Wirkung.
async function handleZertStatus(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeAdmin(ctx);
    const id = zertKritId(body && body.kritId);
    const status = capStr(body && body.status, 20);
    if (!zertStatusErlaubt(status, zertKritArt(id))) {
      throw new VaFehler(status === "nichtrelevant"
        ? "Ein Basiskriterium kann nicht als „passt nicht zu uns“ gesetzt werden — die Basiskriterien sind das Pflichtprogramm."
        : "Unbekannter Status", 400);
    }

    const ergebnis = await zertMutiere(authHeader, (doc) => {
      const k = zertKritEintrag(doc, id);
      if (k.status === status) return { unveraendert: true };
      zertVerlauf(k, ctx.session.username, "status", k.status, status);
      k.status = status;
      k.geaendertAm = new Date().toISOString();
      k.geaendertVon = ctx.session.username;
      return { status };
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// ---------- Notiz und Ressort ----------

// Beides in einer Aktion: es ist dieselbe Maske und derselbe Speichern-Knopf. Ein
// FEHLENDES Feld heisst "unveraendert", nur ein mitgeschicktes leeres leert --
// gleiche Semantik wie set-aufgaben-gruppen.
async function handleZertNotiz(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const id = zertKritId(body && body.kritId);
    const hatNotiz = body && typeof body.notiz === "string";
    const hatRessort = body && typeof body.ressortId === "string";
    if (!hatNotiz && !hatRessort) throw new VaFehler("Es wurde nichts uebergeben", 400);

    const notiz = hatNotiz ? capStr(body.notiz, ZERT_MAX_NOTIZ) : null;
    let ressortId = hatRessort ? capStr(body.ressortId, 64) : null;

    // ⚠️ Eine gesetzte Ressort-Id wird gegen die echten Ressorts geprueft. Ohne das
    // stuende eine erfundene Id in der Datei und der Filter "alle Kriterien des
    // Ressorts X" liefe lautlos ins Leere. Der Read passiert NUR, wenn wirklich ein
    // Ressort gesetzt wird -- Leeren kostet nichts.
    if (ressortId) {
      const vaDoc = vaNormalisiere(await readJson(VEREINSAUFGABEN_URL, authHeader, vaLeer()));
      if (!vaRessortHolen(vaDoc, ressortId)) throw new VaFehler("Ressort nicht gefunden", 404);
    }

    const ergebnis = await zertMutiere(authHeader, (doc) => {
      const k = zertKritEintrag(doc, id);
      let etwas = false;
      if (notiz !== null && notiz !== k.notiz) { k.notiz = notiz; etwas = true; }
      if (ressortId !== null && ressortId !== k.ressortId) {
        zertVerlauf(k, ctx.session.username, "ressort", k.ressortId, ressortId);
        k.ressortId = ressortId;
        etwas = true;
      }
      if (!etwas) return { unveraendert: true };
      k.geaendertAm = new Date().toISOString();
      k.geaendertVon = ctx.session.username;
      return {};
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// ---------- Mini-Aufgaben ----------
//
// ⚠️ Das sind NICHT die Vereinsaufgaben aus derselben App, obwohl sie im selben
// Repo wohnen. Michel-Entscheidung: hier bewusst ein leichteres Modell -- keine
// Pflicht-Frist, keine Abnahme, kein Ablehnen, keine Benachrichtigung. Grund war
// die Form der Sache: ein Kriterium hat keine Frist, es ist erfuellt oder nicht,
// und die Schritte dorthin sind Notizzettel, keine Auftraege mit Fristenlauf.
// Wer beides je zusammenlegen will, holt sich damit die Pflicht-Frist zurueck.

async function handleZertAufgabeAnlegen(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const id = zertKritId(body && body.kritId);
    const titel = capStr(body && body.titel, ZERT_MAX_TITEL).trim();
    if (!titel) throw new VaFehler("Ein Titel muss angegeben werden", 400);
    const faellig = zertDatum(body && body.faellig);

    // ⚠️ Derselbe Empfaengertest wie bei den Vereinsaufgaben: existiert, ist
    // Personal UND darf diese App bearbeiten. Der letzte Teil ist keine
    // Foermlichkeit -- wer die App nicht sieht, erfaehrt nie von seiner Aufgabe
    // und koennte sie auch nicht abhaken. Michel hat den Empfaengerkreis genau
    // deshalb auf die Berechtigten begrenzt.
    const empfaenger = vaPruefeEmpfaenger(body && body.empfaenger, ctx, ctx.session.usersDoc);

    const ergebnis = await zertMutiere(authHeader, (doc) => {
      if (doc.aufgaben.length >= ZERT_MAX_AUFGABEN) throw new VaFehler("Die Aufgabenliste ist voll", 400);
      if (doc.aufgaben.filter((a) => a.kritId === id).length >= ZERT_MAX_AUFGABEN_JE_KRIT) {
        throw new VaFehler(`An einem Kriterium sind hoechstens ${ZERT_MAX_AUFGABEN_JE_KRIT} Aufgaben moeglich`, 400);
      }
      const neu = {
        id: crypto.randomUUID(),
        kritId: id, titel, empfaenger, faellig,
        erledigt: false, erledigtAm: "", erledigtVon: "",
        erstelltAm: new Date().toISOString(), erstelltVon: ctx.session.username
      };
      doc.aufgaben.push(neu);
      return { id: neu.id };
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// Titel, Frist und Empfaenger nachtraeglich korrigieren. Nur der Ersteller oder
// Administrieren -- der Empfaenger darf abhaken, aber nicht den Auftrag
// umschreiben (gleiche Linie wie bei handleVaAendern).
async function handleZertAufgabeAendern(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const titel = capStr(body && body.titel, ZERT_MAX_TITEL).trim();
    if (!titel) throw new VaFehler("Der Titel darf nicht leer werden", 400);
    const faellig = zertDatum(body && body.faellig);
    const hatEmpfaenger = !!(body && body.empfaenger);
    const empfaenger = hatEmpfaenger ? vaPruefeEmpfaenger(body.empfaenger, ctx, ctx.session.usersDoc) : "";

    const ergebnis = await zertMutiere(authHeader, (doc) => {
      const a = zertAufgabeHolen(doc, body && body.id);
      if (a.erstelltVon !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Nur wer die Aufgabe angelegt hat, kann sie aendern", 403);
      }
      a.titel = titel;
      a.faellig = faellig;
      if (hatEmpfaenger) a.empfaenger = empfaenger;
      return {};
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// Abhaken und wieder aufmachen. Erlaubt sind der Empfaenger, der Ersteller und
// Administrieren: es gibt hier bewusst keine Abnahme, ein Haken ist ein Haken.
async function handleZertAufgabeStatus(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const erledigt = !!(body && body.erledigt);
    const ergebnis = await zertMutiere(authHeader, (doc) => {
      const a = zertAufgabeHolen(doc, body && body.id);
      if (a.empfaenger !== ctx.session.username && a.erstelltVon !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Diese Aufgabe gehoert jemand anderem", 403);
      }
      if (!!a.erledigt === erledigt) return { unveraendert: true };
      a.erledigt = erledigt;
      a.erledigtAm = erledigt ? new Date().toISOString() : "";
      a.erledigtVon = erledigt ? ctx.session.username : "";
      return { erledigt };
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

async function handleZertAufgabeLoeschen(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const ergebnis = await zertMutiere(authHeader, (doc) => {
      const a = zertAufgabeHolen(doc, body && body.id);
      if (a.erstelltVon !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Nur wer die Aufgabe angelegt hat, kann sie loeschen", 403);
      }
      doc.aufgaben.splice(doc.aufgaben.indexOf(a), 1);
      return {};
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// ---------- Nachweis-Dateien ----------

async function handleZertDateiPut(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const id = zertKritId(body && body.kritId);
    const rohDaten = String((body && body.daten) || "");
    const komma = rohDaten.indexOf(",");
    if (!rohDaten.startsWith("data:") || komma < 0) throw new VaFehler("Datei-Inhalt fehlt oder ist unlesbar", 400);
    const mime = capStr(rohDaten.slice(5, rohDaten.indexOf(";")), 120) || "application/octet-stream";
    let bytes;
    try { bytes = base64ToBytes(rohDaten.slice(komma + 1)); }
    catch (_) { throw new VaFehler("Datei-Inhalt ist kein gueltiges base64", 400); }
    if (!bytes.length) throw new VaFehler("Leere Datei", 400);
    if (bytes.length > ZERT_MAX_NACHWEIS_BYTES) throw new VaFehler("Datei zu gross (hoechstens 8 MB)", 413);

    const name = capStr(body && body.name, 200).replace(/[\r\n]/g, "").trim() || "nachweis";
    const fileId = crypto.randomUUID();

    // Erst den Deckel pruefen, dann die Bytes ablegen, dann verbuchen: ein Eintrag,
    // der auf eine nicht vorhandene Datei zeigt, waere schlimmer als eine verwaiste
    // Datei (gleiche Reihenfolge wie handleVaDateiPut).
    await zertMutiere(authHeader, (doc) => {
      const k = zertKritEintrag(doc, id);
      if ((k.nachweise || []).length >= ZERT_MAX_NACHWEISE) throw new VaFehler("Zu viele Nachweise an diesem Kriterium", 400);
      return {};
    });

    const fileUrl = ZERT_NACHWEIS_DIR + "/" + fileId;
    const headers = { Authorization: authHeader, "Content-Type": mime };
    let resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
    // Gleicher MKCOL-Autofix wie ueberall: 409 = eine Ebene fehlt, 404 = mehrere
    // (der Fall beim allerersten Upload).
    if (resp.status === 409 || resp.status === 404) {
      await ensureCollection(ZERT_NACHWEIS_DIR, authHeader, 0);
      resp = await fetch(fileUrl, { method: "PUT", headers, body: bytes });
    }
    if (!resp.ok) throw new VaFehler(`Upload fehlgeschlagen (Nextcloud ${resp.status})`, 502);

    const ergebnis = await zertMutiere(authHeader, (doc) => {
      const k = zertKritEintrag(doc, id);
      if (!Array.isArray(k.nachweise)) k.nachweise = [];
      k.nachweise.push({
        fileId, name, mime, von: ctx.session.username,
        hochgeladenAm: new Date().toISOString(), groesse: bytes.length
      });
      k.geaendertAm = new Date().toISOString();
      k.geaendertVon = ctx.session.username;
      return { fileId };
    });
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

// ⚠️ Lesen verlangt Bearbeiten, nicht bloss Sehen. Der Katalog selbst ist fuer
// jeden Seher offen, ein hinterlegter Nachweis kann aber sehr wohl Personendaten
// enthalten -- beim Kriterium "Fuehrungszeugnis" liegt das auf der Hand. Gleiche
// Linie wie "Export erst ab Bearbeiten".
//
// ⚠️ Die Datei-Id wird IMMER aus dem Kriterium aufgeloest, nie aus dem Body
// uebernommen -- sonst kaeme man mit einer geratenen Id an jeder Pruefung vorbei.
async function handleZertDateiGet(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const id = zertKritId(body && body.kritId);
    const doc = zertNormalisiere(await readJson(ZERT_URL, authHeader, zertLeer()));
    const k = doc.kriterien[id];
    const gesucht = String((body && body.fileId) || "");
    const meta = k && (k.nachweise || []).find((f) => f && f.fileId === gesucht);
    if (!meta) throw new VaFehler("Nachweis nicht gefunden", 404);
    if (!FILE_ID_RE.test(meta.fileId)) throw new VaFehler("Ungueltige Datei-Id", 400);

    let resp;
    try { resp = await fetch(ZERT_NACHWEIS_DIR + "/" + meta.fileId, { method: "GET", headers: { Authorization: authHeader } }); }
    catch (_) { throw new VaFehler("Nextcloud nicht erreichbar", 502); }
    if (resp.status === 404) throw new VaFehler("Datei nicht gefunden", 404);
    if (!resp.ok) throw new VaFehler(`Nextcloud GET ${resp.status}`, 502);

    // Bytes durchreichen statt als base64 zu verpacken: bytesToBase64 baut den
    // String zeichenweise auf und reisst bei mehreren Megabyte das CPU-Limit.
    return new Response(resp.body, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": meta.mime || "application/octet-stream", "Cache-Control": "private, no-store" }
    });
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}

async function handleZertDateiLoeschen(request, body, env, authHeader, corsHeaders) {
  const ctx = await vaSession(request, env, authHeader, corsHeaders);
  if (ctx.fehler) return ctx.fehler;
  try {
    vaVerlangeEdit(ctx);
    const id = zertKritId(body && body.kritId);
    let fileId = "";
    const ergebnis = await zertMutiere(authHeader, (doc) => {
      const k = doc.kriterien[id];
      const gesucht = String((body && body.fileId) || "");
      const idx = (k && k.nachweise ? k.nachweise : []).findIndex((f) => f && f.fileId === gesucht);
      if (idx < 0) throw new VaFehler("Nachweis nicht gefunden", 404);
      const meta = k.nachweise[idx];
      if (meta.von !== ctx.session.username && !ctx.canAdmin) {
        throw new VaFehler("Nur wer den Nachweis hochgeladen hat, kann ihn entfernen", 403);
      }
      fileId = meta.fileId;
      k.nachweise.splice(idx, 1);
      k.geaendertAm = new Date().toISOString();
      k.geaendertVon = ctx.session.username;
      return {};
    });
    if (FILE_ID_RE.test(fileId)) {
      try { await fetch(ZERT_NACHWEIS_DIR + "/" + fileId, { method: "DELETE", headers: { Authorization: authHeader } }); }
      catch (_) { /* verwaiste Datei ist hinnehmbar */ }
    }
    return json(ergebnis, 200, corsHeaders);
  } catch (e) { return vaAntwortFehler(e, corsHeaders); }
}
