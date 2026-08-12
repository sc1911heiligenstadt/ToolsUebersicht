// Worker-URL des admin-worker.js (siehe README für Deploy-Anleitung).
const WORKER_URL = "https://landingpage.michel-brunner.workers.dev";
const WIKI_WORKER_URL = "https://vereinswiki.michel-brunner.workers.dev";
const TOKEN_STORAGE_KEY = "tu_session_token";
const TOOL_ORDER_STORAGE_KEY = "tu_tool_order";
// Zwischenspeicher der persoenlichen Ansicht, damit die Startseite beim naechsten
// Aufruf auf DIESEM Geraet sofort richtig aufbaut. ⚠️ Nur ein Cache -- massgeblich ist
// die Antwort des Workers, die ihn bei jedem Seitenaufbau ueberschreibt. Nach Nutzer
// getrennt abgelegt, sonst erbte der naechste Angemeldete am selben Geraet die
// Reihenfolge des vorigen.
const ANSICHT_STORAGE_KEY = "tu_ansicht";

let visibilityState = {};
let newsState = (typeof NEWS !== "undefined" ? NEWS.slice() : []); // Server-News, initial das statische Seed/Fallback aus config.js
let newsReactionCounts = {}; // { newsId: { emoji: anzahl } } — öffentliche Zähler, kommen aus fetchVisibility() (GET)
let newsReactionNames = {};  // { newsId: { emoji: [anzeigename] } } — WER reagiert hat, für den Tooltip; nur angemeldet befüllt
let newsReactionMine = {};   // { newsId: emoji } — eigene Reaktion, nur eingeloggt (my-news-reactions)
let newsReactionHint = "";   // kurzer transienter Hinweis unter der Reaktionsleiste (z.B. "Bitte anmelden")
let _newsReactionHintTimer = null;
let bootstrapAvailable = false;
let currentToken = null;
let currentUser = null; // { username, isAdmin, groupIds, realIsAdmin, viewAsGroupId } oder null
let trainerdatenStatus = null; // Antwort von my-trainerdaten-status für die Badge-Anzeige auf der Trainerdaten-Kachel, null = kein Badge
let _trainerdatenStatusLastFetch = 0; // Date.now() der letzten loadTrainerdatenStatus()-Abfrage, siehe visibilitychange-Listener unten
let testspielplanerStatus = null; // Antwort von my-testspielplaner-status (Badge "Gegner eintragen" auf der Testspielplaner-Kachel), null = kein Badge
let _testspielplanerStatusLastFetch = 0; // analog _trainerdatenStatusLastFetch
let directoryGroupsState = []; // { id, name }[], für den Testansicht-Umschalter im Header (auch während aktiver Testansicht ladbar)

// isAdmin/groupIds sind die effektive Identität (siehe set-view-as im Worker);
// realIsAdmin bleibt der echte Admin-Status, damit der Testansicht-Umschalter
// selbst auch waehrend einer aktiven Testansicht sichtbar/bedienbar bleibt.
// Die Profilfelder (vorname..mannschaften) liefert NUR die Aktion "me" — login/
// set-password/bootstrap-admin geben lediglich die Identitaet zurueck (deriveIdentity
// im Worker). Sie sind hier undefined-tolerant, weil buildCurrentUser aus beiden
// Quellen gefuettert wird; loadOwnProfile() holt sie nach der Anmeldung nach.
function buildCurrentUser(data) {
  return {
    username: data.username,
    isAdmin: !!data.isAdmin,
    groupIds: data.groupIds || [],
    realIsAdmin: !!data.realIsAdmin,
    viewAsGroupId: data.viewAsGroupId || null,
    vorname: data.vorname || "",
    nachname: data.nachname || "",
    lizenz: data.lizenz || "",
    mannschaften: Array.isArray(data.mannschaften) ? data.mannschaften : [],
    // Beide Felder liefert "me" erst seit dem Worker-Stand vom 2026-07-21. Bis zu
    // dessen Deploy kommen sie schlicht nicht mit -- die Karte "Mein Konto" laesst
    // die betroffenen Zeilen dann weg, statt "undefined" anzuzeigen.
    groupNames: Array.isArray(data.groupNames) ? data.groupNames : [],
    passwordSetAt: data.passwordSetAt || null,
    // Konto-Art ("personal"/"spieler"), nur aus "me". login/set-password liefern sie
    // nicht mit -- direkt nach dem Anmelde-Klick steht hier also kurz null, bis
    // loadOwnProfile() nachzieht. Fuer die Anzeige reicht das: der einzige Ort, an
    // dem die Art zaehlt (Materialcontainer-Knopf), ist serverseitig ohnehin
    // gegated, und ein Spielerkonto sieht ihn nach dem Nachladen nicht mehr.
    art: data.art || null,
    // Zeitstempel des eigenen Nutzerfotos (seit 2026-08-04), null = keins. Kommt
    // nur aus "me" -- login/set-password liefern es nicht, dort steht direkt nach
    // dem Klick also kurz null, bis loadOwnProfile() nachzieht. Das ist harmlos:
    // die Karte zeigt dann den Buchstaben, das Bild erscheint Sekundenbruchteile
    // spaeter. Zugleich der Cache-Schluessel, siehe nutzerfotoUrl().
    fotoVersion: data.fotoVersion || null
  };
}

// Profilfelder nach einer frischen Anmeldung nachladen, damit die Karte "Mein Konto"
// sofort gefuellt ist und nicht erst beim naechsten Seitenaufruf (der laeuft ueber
// "me" und bringt sie ohnehin mit). Best-effort: schlaegt der Nachruf fehl, bleibt
// die Anmeldung gueltig und die Karte zeigt nur den Nutzernamen.
async function loadOwnProfile() {
  try {
    currentUser = buildCurrentUser({ ...currentUser, ...(await callWorker("me", {})) });
  } catch (e) { /* siehe Kommentar oben */ }
}
let pendingFirstLoginUsername = null;
let pendingLoginUsername = null;
let groupsState = [];
let usersState = [];
// Filter der Nutzerliste. groupId: "" = alle, "__ohne__" = Nutzer ohne jede Gruppe,
// sonst eine Gruppen-Id. Rein clientseitig -- list-users liefert immer alle Nutzer.
let usersFilter = { text: "", groupId: "" };
// Auf/Zu-Zustand der beiden Art-Abschnitte, damit ein Neu-Rendern (nach Speichern,
// Filterwechsel) den gerade geöffneten Abschnitt nicht wieder zuklappt.
let userArtOpen = { personal: false, spieler: false };
let dragState = null; // aktiver Drag-Vorgang beim Verschieben einer Tool-Karte, sonst null
// Persoenliche Ansicht der Startseite (seit 2026-08-07): Kacheln oder Liste + eigene
// Reihenfolge je Kategorie. Liegt am Konto (Aktion "meine-ansicht"), gilt also auf
// jedem Geraet gleich.
let ansichtState = { modus: "kacheln", reihenfolge: {} };
let ansichtBearbeiten = false;   // Anordnen-Modus an? Nur dann laesst sich etwas verschieben.
let _ansichtSaveTimer = null;    // gebuendeltes Speichern nach dem Verschieben
let _ansichtSaveLaeuft = false;  // In-Flight-Guard: waehrend ein Speichern laeuft, wird nicht parallel gestartet
let _ansichtSaveNachholen = false; // waehrend des laufenden Speicherns kam eine weitere Aenderung
let ansichtVomServer = false;    // hat meine-ansicht geantwortet? sonst greift der Zwischenspeicher
let feedbackState = []; // Feedback-/Wunsch-Einträge, nur für eingeloggte Admins geladen (siehe loadAndRenderFeedback)

function defaultVisibility() {
  const map = {};
  TOOLS.forEach((t) => { map[t.id] = { visible: true, loginRequired: false, groupIds: [] }; });
  return map;
}

async function fetchVisibility() {
  try {
    // Token mitschicken, falls vorhanden: der GET liefert die Neuigkeiten nur an
    // Angemeldete, die Tool-Sichtbarkeit dagegen an jeden. Bewusst loadStoredToken()
    // statt currentToken -- init() startet fetchVisibility() parallel zu
    // checkSession(), currentToken ist zu dem Zeitpunkt noch null.
    const headers = {};
    const token = loadStoredToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    const resp = await fetch(WORKER_URL, { method: "GET", headers });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return await resp.json();
  } catch (e) {
    console.warn("Sichtbarkeits-Konfiguration nicht erreichbar, zeige alle Tools als sichtbar:", e);
    return null;
  }
}

async function callWorker(action, payload) {
  let resp;
  try {
    const headers = { "Content-Type": "application/json" };
    if (currentToken) headers["Authorization"] = "Bearer " + currentToken;
    resp = await fetch(WORKER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...payload })
    });
  } catch (e) {
    throw new Error("Worker nicht erreichbar (noch nicht deployed?). Siehe README.");
  }
  let data = null;
  try { data = await resp.json(); } catch (_) { /* kein JSON-Body */ }
  if (!resp.ok) {
    const err = new Error((data && data.error) || ("Worker-Fehler (HTTP " + resp.status + ")"));
    if (data && data.archived) err.archived = true;
    throw err;
  }
  return data;
}

function loadStoredToken() {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY); } catch (_) { return null; }
}

function storeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch (_) { /* localStorage nicht verfügbar */ }
}

async function checkSession() {
  const token = loadStoredToken();
  if (!token) return;
  currentToken = token;
  try {
    const data = await callWorker("me", {});
    currentUser = buildCurrentUser(data);
  } catch (e) {
    currentToken = null;
    currentUser = null;
    storeToken(null);
  }
}

async function login(username, password) {
  const data = await callWorker("login", { username, password });
  if (data.needsPasswordSetup) {
    // Der Worker loest die Eingabe auf (Nutzername, Schreibvariante oder E-Mail-Adresse)
    // und liefert seit 2026-08-03 den echten Nutzernamen mit -- im "Konto einrichten"-
    // Panel steht sonst die eingetippte Adresse, obwohl der Satz dort den kuenftigen
    // Anmeldenamen nennt. Faellt das Feld weg (alter Worker), bleibt es bei der Eingabe;
    // set-password loest ohnehin serverseitig noch einmal auf.
    pendingFirstLoginUsername = data.username || username;
    return { needsPasswordSetup: true };
  }
  currentToken = data.token;
  currentUser = buildCurrentUser(data);
  storeToken(currentToken);
  await loadOwnProfile();
  return { success: true };
}

async function setFirstPassword(username, password) {
  const data = await callWorker("set-password", { username, password });
  currentToken = data.token;
  currentUser = buildCurrentUser(data);
  storeToken(currentToken);
  await loadOwnProfile();
  pendingFirstLoginUsername = null;
}

async function bootstrapAdmin(username, password) {
  const data = await callWorker("bootstrap-admin", { username, password });
  currentToken = data.token;
  currentUser = buildCurrentUser(data);
  storeToken(currentToken);
  await loadOwnProfile();
  bootstrapAvailable = false;
}

// Eigenes Passwort aendern. Das zurueckgegebene Token MUSS uebernommen werden: der
// Wechsel entwertet serverseitig jede aeltere Session (auch die gerade laufende, siehe
// handleChangePassword im Worker) -- mit dem alten Token im localStorage waere man
// beim naechsten Klick abgemeldet.
async function changePassword(oldPassword, newPassword) {
  const data = await callWorker("change-password", { oldPassword, newPassword });
  currentToken = data.token;
  currentUser = buildCurrentUser({ ...currentUser, ...data });
  storeToken(currentToken);
}

function logout() {
  currentToken = null;
  currentUser = null;
  trainerdatenStatus = null;
  pendingFirstLoginUsername = null;
  pendingLoginUsername = null;
  storeToken(null);
  // Ansicht und Reihenfolge gehoeren zum Konto -- der naechste, der sich an diesem
  // Geraet anmeldet, soll nicht die Sortierung des vorigen vorfinden. Der
  // Zwischenspeicher bleibt (er ist nach Nutzername getrennt und wird beim naechsten
  // Anmelden ohnehin von der Server-Antwort ueberschrieben).
  ansichtState = ansichtStandard();
  ansichtBearbeiten = false;
  // Geladene Fotos freigeben: eine Objekt-URL bleibt sonst gueltig, solange die
  // Seite offen ist -- auch fuer den naechsten, der sich hier anmeldet.
  nutzerfotoBlobsLeeren();
  resetPasswortForm(); // sonst stuende das Passwort noch im Feld, wenn sich am selben Geraet jemand anders anmeldet
  renderAdminPanels();
  renderToolGrid();
  renderFeedbackTab();
  refreshMyNewsReactions(); // eigene Reaktions-Markierungen entfernen (currentUser ist jetzt null)
  refreshNews(); // Neuigkeiten aus dem Speicher werfen -- sie gehoeren nur Angemeldeten
  loadSidebarWidget();
  loadAufgaben(); // leert die Aufgabenkarte -- sie gehoert dem abgemeldeten Konto
}

async function loadAndRenderUsers() {
  const errorEl = document.getElementById("users-error");
  errorEl.style.display = "none";
  try {
    const data = await callWorker("list-users", {});
    usersState = data.users.slice().sort((a, b) =>
      (a.displayName || a.username).localeCompare(b.displayName || b.username, "de")
    );
    renderUsersList(usersState);
    renderMannschaftSuggestions();
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }
}

// Füllt das <datalist> für die Mannschaft(en)-Felder (Anlegen + Bearbeiten) mit allen
// bereits vergebenen Mannschaftsnamen — Autovervollständigung, die zugleich hilft,
// konsistente Namen zu treffen (wichtig fürs Kadermanager-Team-Matching beim Auto-Provisioning).
function renderMannschaftSuggestions() {
  const dl = document.getElementById("mannschaft-suggestions");
  if (!dl) return;
  const set = new Set();
  usersState.forEach((u) => (u.mannschaften || []).forEach((m) => {
    const t = String(m || "").trim();
    if (t) set.add(t);
  }));
  const names = Array.from(set).sort((a, b) => a.localeCompare(b, "de"));
  dl.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");
}

// Baut eine einzelne Nutzer-Zeile (Bearbeiten/Passwort/Löschen) — für beide
// Art-Abschnitte der Nutzerliste identisch.
function buildUserRow(u) {
  const row = document.createElement("div");
  row.className = "user-row";
  row.innerHTML = `
    <div class="ur-main">
      <span class="ur-name">${escapeHtml(u.displayName || u.username)}</span>
      <span class="muted">(${escapeHtml(u.username)})</span>
      ${u.art === "spieler" ? '<span class="badge-spieler">Spieler</span>' : ""}
      ${u.isAdmin ? '<span class="badge-admin">Admin</span>' : ""}
      ${u.mustSetPassword ? '<span class="badge-warning">Passwort nicht gesetzt</span>' : ""}
      <button type="button" class="btn secondary small" data-toggle-edit-user="${escapeHtml(u.username)}">Bearbeiten</button>
      <button type="button" class="btn secondary small" data-reset-user="${escapeHtml(u.username)}">Passwort zurücksetzen</button>
      <button type="button" class="btn danger small" data-delete-user="${escapeHtml(u.username)}">Löschen</button>
    </div>
    <div class="ur-groups" data-edit-user-for="${escapeHtml(u.username)}" style="display:none;"></div>
  `;
  return row;
}

// Aufklappbarer Abschnitt für eine Nutzer-Art (Personal/Spieler). `key` steuert
// nur das Merken des Auf/Zu-Zustands über Neu-Renderings hinweg.
function buildUserArtSection(name, key, members, filterAktiv) {
  const details = document.createElement("details");
  details.className = "collapsible user-group-section";
  // Bei aktivem Filter aufklappen: sonst sieht man vom Filterergebnis nur zwei
  // zugeklappte Zeilen und müsste jedes Mal nachklicken.
  details.open = (filterAktiv && members.length > 0) || userArtOpen[key];
  const summary = document.createElement("summary");
  summary.textContent = `${name} (${members.length})`;
  // Nur der echte Klick aufs Summary schreibt den gemerkten Zustand fort (Enter/
  // Leertaste lösen ebenfalls click aus). Über das toggle-Event ginge es nicht:
  // das feuert auch beim automatischen Aufklappen durch den Filter, und zwar
  // asynchron nach dem Render — danach blieben beide Abschnitte für den Rest der
  // Sitzung offen, auch nach dem Zurücksetzen des Filters.
  summary.addEventListener("click", () => { userArtOpen[key] = !details.open; });
  details.appendChild(summary);
  if (members.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = filterAktiv ? "Kein Treffer für diesen Filter." : "Keine Nutzer.";
    details.appendChild(empty);
  } else {
    members.forEach((u) => details.appendChild(buildUserRow(u)));
  }
  return details;
}

// Trifft der Nutzer den aktuellen Filter? Textsuche über Anzeigename und
// Nutzernamen, Gruppenfilter zusätzlich (UND-Verknüpfung).
function matchesUsersFilter(u) {
  const text = usersFilter.text.trim().toLowerCase();
  if (text) {
    const heuhaufen = `${u.displayName || ""} ${u.vorname || ""} ${u.nachname || ""} ${u.username || ""}`.toLowerCase();
    if (!heuhaufen.includes(text)) return false;
  }
  const gid = usersFilter.groupId;
  if (gid === "__ohne__") return (u.groupIds || []).length === 0;
  if (gid) return (u.groupIds || []).includes(gid);
  return true;
}

// Befüllt das Gruppen-Dropdown aus groupsState und hält eine bereits getroffene
// Auswahl; eine zwischenzeitlich gelöschte Gruppe fällt auf "Alle Gruppen" zurück.
function renderUsersFilterOptions() {
  const sel = document.getElementById("users-filter-group");
  if (!sel) return;
  const gruppen = groupsState.slice().sort((a, b) => a.name.localeCompare(b.name, "de"));
  sel.innerHTML = [
    '<option value="">Alle Gruppen</option>',
    ...gruppen.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`),
    '<option value="__ohne__">Ohne Gruppe</option>'
  ].join("");
  if (usersFilter.groupId && usersFilter.groupId !== "__ohne__" &&
      !groupsState.some((g) => g.id === usersFilter.groupId)) {
    usersFilter.groupId = "";
  }
  sel.value = usersFilter.groupId;
}

// Zwei Abschnitte statt einem je Gruppe: Personal und Spieler sind die harte
// Trennlinie im Datenmodell (ein Spieler ist nie Admin, sieht andere Tools, wird
// von personalakte-overview & Co. anders behandelt). Nach Gruppen wurde vorher
// gruppiert — dabei erschien jeder Nutzer in so vielen Abschnitten wie er
// Gruppen hat, und wer keine hatte, landete in "Keine Gruppe". Gruppen sind
// jetzt der Filter darüber.
function renderUsersList(users) {
  const container = document.getElementById("users-list");
  container.innerHTML = "";

  renderUsersFilterOptions();
  const filterAktiv = !!(usersFilter.text.trim() || usersFilter.groupId);
  const sichtbar = users.filter(matchesUsersFilter);
  const spieler = sichtbar.filter((u) => u.art === "spieler");
  // Kein art-Feld = personal: derselbe Lesepfad-Default wie im Worker (userArt()),
  // die Altkonten von vor der Einführung des Feldes sind Personal.
  const personal = sichtbar.filter((u) => u.art !== "spieler");
  container.appendChild(buildUserArtSection("Personal", "personal", personal, filterAktiv));
  container.appendChild(buildUserArtSection("Spieler", "spieler", spieler, filterAktiv));

  const countEl = document.getElementById("users-count");
  if (countEl) countEl.textContent = filterAktiv ? `${sichtbar.length} von ${users.length}` : String(users.length);

  container.querySelectorAll("[data-toggle-edit-user]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const username = btn.dataset.toggleEditUser;
      const panel = btn.closest(".user-row").querySelector("[data-edit-user-for]");
      const isOpen = panel.style.display !== "none";
      if (isOpen) {
        panel.style.display = "none";
        return;
      }
      const user = usersState.find((u) => u.username === username);
      const lizenzOptionen = ["", "ohne Lizenz", "Basis", "C", "B", "B Elite", "A"];
      panel.innerHTML = `
        <div class="gp-label">Gruppen</div>
        <div class="group-picker"></div>
        <div class="form-grid" style="align-items:flex-end; margin-top:12px;">
          <div class="form-field">
            <label>Art</label>
            <select data-edit-user-art>
              <option value="personal" ${(user.art !== "spieler") ? "selected" : ""}>Personal</option>
              <option value="spieler" ${(user.art === "spieler") ? "selected" : ""}>Spieler / Eltern</option>
            </select>
          </div>
          <div class="form-field">
            <label>Vorname</label>
            <input type="text" data-edit-user-vorname value="${escapeHtml(user.vorname || "")}" />
          </div>
          <div class="form-field">
            <label>Nachname</label>
            <input type="text" data-edit-user-nachname value="${escapeHtml(user.nachname || "")}" />
          </div>
          <div class="form-field">
            <label>Trainerlizenz</label>
            <select data-edit-user-lizenz>
              ${lizenzOptionen.map((l) => `<option value="${escapeHtml(l)}" ${((user.lizenz || "") === l) ? "selected" : ""}>${l ? escapeHtml(l) : "— keine —"}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label>Mannschaft(en)</label>
            <input type="text" data-edit-user-mannschaften list="mannschaft-suggestions" value="${escapeHtml((user.mannschaften || []).join(", "))}" placeholder="z. B. B-Jugend, C-Jugend" />
          </div>
          <div class="form-field">
            <label class="checkbox-label" style="margin-top:22px;"><input type="checkbox" data-edit-user-is-admin ${user.isAdmin ? "checked" : ""} /> Admin-Rechte</label>
          </div>
          <div class="form-field">
            <label class="checkbox-label" style="margin-top:22px;"><input type="checkbox" data-edit-user-vertrag-benoetigt ${user.vertragBenoetigt ? "checked" : ""} /> Vertrag benötigt</label>
          </div>
          <div class="form-field">
            <button type="button" class="btn small" data-save-edit-user="${escapeHtml(username)}">Speichern</button>
          </div>
        </div>
        <div class="user-foto-zeile">
          <span class="muted">Foto:</span>
          <span class="muted">${user.fotoVersion ? "hinterlegt" : "keins"}</span>
          <button type="button" class="btn secondary small" data-user-foto-setzen>Foto setzen</button>
          <button type="button" class="btn secondary small" data-user-foto-entfernen ${user.fotoVersion ? "" : 'style="display:none;"'}>Foto entfernen</button>
        </div>
      `;
      renderGroupCheckboxes(panel.querySelector(".group-picker"), user ? user.groupIds : []);
      panel.style.display = "block";

      // Foto eines fremden Kontos. Setzen deckt den Fall "Spieler ohne eigenes
      // Geraet" ab, Entfernen ist der Notfallknopf fuer ein unpassendes Bild.
      // Der Zielname wird gemerkt, weil die Dateiauswahl global ist.
      panel.querySelector("[data-user-foto-setzen]").addEventListener("click", () => {
        adminFotoZiel = username;
        document.getElementById("admin-foto-datei").click();
      });
      panel.querySelector("[data-user-foto-entfernen]").addEventListener("click", async () => {
        if (!confirm(`Foto von ${user.displayName || username} wirklich entfernen?`)) return;
        const fehler = document.getElementById("users-error");
        try {
          await callWorker("nutzerfoto-loeschen", { username });
          await loadAndRenderUsers();
        } catch (e) {
          fehler.textContent = e.message || "Entfernen fehlgeschlagen.";
          fehler.style.display = "";
        }
      });

      panel.querySelector("[data-save-edit-user]").addEventListener("click", async () => {
        const art = panel.querySelector("[data-edit-user-art]").value;
        const vorname = panel.querySelector("[data-edit-user-vorname]").value.trim();
        const nachname = panel.querySelector("[data-edit-user-nachname]").value.trim();
        const isAdmin = panel.querySelector("[data-edit-user-is-admin]").checked;
        const lizenz = panel.querySelector("[data-edit-user-lizenz]").value;
        const mannschaften = panel.querySelector("[data-edit-user-mannschaften]").value
          .split(",").map((s) => s.trim()).filter(Boolean);
        const vertragBenoetigt = panel.querySelector("[data-edit-user-vertrag-benoetigt]").checked;
        const desiredGroupIds = getCheckedValues(panel.querySelector(".group-picker"));
        const errorEl = document.getElementById("users-error");
        errorEl.style.display = "none";
        try {
          const result = await callWorker("update-user", { username, art, vorname, nachname, isAdmin, lizenz, mannschaften, vertragBenoetigt });
          // Bei Namensänderung zieht der Worker den Login-Nutzernamen automatisch mit
          // (usernameRename.applied) — die Gruppenmitgliedschaft muss dann unter dem
          // NEUEN Nutzernamen gepflegt werden, sonst fällt der Nutzer beim folgenden
          // update-group-members-Aufruf aus jeder Gruppe raus (unbekannter alter Key,
          // siehe handleUpdateGroupMembers-Filter im Worker).
          const rename = result.usernameRename;
          const effectiveUsername = (rename && rename.applied) ? rename.to : username;
          await applyUserGroupMembership(username, effectiveUsername, desiredGroupIds);
          await loadAndRenderGroups();
          await loadAndRenderUsers();
          if (rename) {
            errorEl.style.color = rename.applied ? "#2c5e2e" : "#c0392b";
            errorEl.textContent = rename.applied
              ? `Hinweis: Login-Nutzername wurde von „${rename.from}“ zu „${rename.to}“ angepasst (Namensänderung).`
              : `Name gespeichert, aber der Login-Nutzername „${rename.to}“ ist bereits durch ein anderes Konto belegt und konnte nicht automatisch angepasst werden — bitte das andere Konto prüfen.`;
            errorEl.style.display = "block";
          }
        } catch (e) {
          errorEl.style.color = "#c0392b";
          errorEl.textContent = e.message;
          errorEl.style.display = "block";
        }
      });
    });
  });

  container.querySelectorAll("[data-reset-user]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const errorEl = document.getElementById("users-error");
      errorEl.style.display = "none";
      try {
        await callWorker("reset-password", { username: btn.dataset.resetUser });
        await loadAndRenderUsers();
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    });
  });

  container.querySelectorAll("[data-delete-user]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const username = btn.dataset.deleteUser;
      if (!confirm(`Nutzer "${username}" wirklich löschen?\n\nDas entfernt das Konto vollständig (inkl. aller Gruppen) und kann NICHT rückgängig gemacht werden. "Passwort zurücksetzen" funktioniert danach nicht mehr — für einen Neustart muss der Nutzer über "Nutzer anlegen" komplett neu angelegt werden.`)) return;
      const errorEl = document.getElementById("users-error");
      errorEl.style.display = "none";
      try {
        await callWorker("delete-user", { username });
        await loadAndRenderGroups();
        await loadAndRenderUsers();
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    });
  });
}

// ---- Backfill: Lizenz & Mannschaft aus Personalkosten nachpflegen ----
// Admins dürfen jede Gateway-App per dav-load lesen (Admin-Bypass im Worker), also
// kann das Nutzer-Panel die Personalkosten-Daten laden und daraus das zentrale
// Trainerprofil (lizenz/mannschaften) der passenden Konten vorschlagen. Bewusst
// rein additiv: eine bereits gesetzte Lizenz wird NIE überschrieben, Mannschaften
// werden nur ergänzt (Vereinigung) — es geht kein manuell gepflegter Wert verloren.

function nameKey(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Baut aus den Personalkosten-Daten eine Map nameKey -> {displayName, lizenz, mannschaften[]}.
// Aggregiert über ALLE Saisons und alle drei Bereiche (Trainer/Schwerpunkt/Förderung);
// die aktuelle Saison wird zuletzt verarbeitet, damit ihre Lizenz gewinnt.
function buildPersonalkostenProfileMap(data) {
  const LIZENZEN = ["ohne Lizenz", "Basis", "C", "B", "B Elite", "A"];
  const map = new Map();
  if (!data || !data.seasons || typeof data.seasons !== "object") return map;
  const current = data.meta && data.meta.currentSeason;
  const seasonKeys = Object.keys(data.seasons)
    .sort((a, b) => (a === current ? 1 : 0) - (b === current ? 1 : 0));
  seasonKeys.forEach((sk) => {
    const season = data.seasons[sk] || {};
    ["trainer", "schwerpunkt", "foerderung"].forEach((bereich) => {
      const list = Array.isArray(season[bereich]) ? season[bereich] : [];
      list.forEach((e) => {
        const name = String((e && e.name) || "").trim();
        if (!name || name === "0") return;
        const key = nameKey(name);
        if (!map.has(key)) map.set(key, { displayName: name, lizenz: "", mannschaften: [] });
        const rec = map.get(key);
        const mannschaft = String((e && e.mannschaft) || "").trim();
        if (mannschaft && !rec.mannschaften.includes(mannschaft)) rec.mannschaften.push(mannschaft);
        const lizenz = String((e && e.lizenz) || "").trim();
        if (lizenz && LIZENZEN.includes(lizenz)) rec.lizenz = lizenz;
      });
    });
  });
  return map;
}

async function openBackfillFromPersonalkosten() {
  const panel = document.getElementById("backfill-panel");
  const errorEl = document.getElementById("users-error");
  errorEl.style.display = "none";
  panel.style.display = "block";
  panel.innerHTML = '<p class="muted">Lade Personalkosten…</p>';

  let res;
  try {
    res = await callWorker("dav-load", { app: "personalkosten" });
  } catch (e) {
    panel.innerHTML = `<p class="muted" style="color:#c0392b;">Konnte Personalkosten nicht laden: ${escapeHtml(e.message)}</p>`;
    return;
  }

  const profileMap = buildPersonalkostenProfileMap(res && res.data);
  if (profileMap.size === 0) {
    panel.innerHTML = '<p class="muted">In den Personalkosten wurden keine Personen mit Namen gefunden (schon deployed &amp; befüllt?).</p>';
    return;
  }

  const matchedKeys = new Set();
  const rows = [];
  usersState.forEach((u) => {
    const full = `${u.vorname || ""} ${u.nachname || ""}`.trim();
    const key = nameKey(full);
    if (!key || !profileMap.has(key)) return;
    matchedKeys.add(key);
    const prof = profileMap.get(key);
    const curLizenz = u.lizenz || "";
    const curTeams = Array.isArray(u.mannschaften) ? u.mannschaften : [];
    const addTeams = prof.mannschaften.filter((m) => !curTeams.includes(m));
    const lizenzChange = !curLizenz && !!prof.lizenz;
    const teamChange = addTeams.length > 0;
    if (!lizenzChange && !teamChange) return; // matched, aber nichts nachzupflegen
    rows.push({
      username: u.username, displayName: full,
      vorname: u.vorname || "", nachname: u.nachname || "", isAdmin: !!u.isAdmin,
      curLizenz, newLizenz: curLizenz || prof.lizenz, lizenzChange,
      curTeams, addTeams, newTeams: curTeams.concat(addTeams), teamChange
    });
  });

  const unmatched = [];
  profileMap.forEach((prof, key) => { if (!matchedKeys.has(key)) unmatched.push(prof.displayName); });
  unmatched.sort((a, b) => a.localeCompare(b, "de"));

  renderBackfillPanel(panel, rows, unmatched, matchedKeys.size - rows.length);
}

function renderBackfillPanel(panel, rows, unmatched, upToDateCount) {
  const unmatchedHtml = unmatched.length
    ? `<p class="muted" style="margin-top:10px;">Ohne passendes Nutzerkonto (${unmatched.length}) — bitte ggf. erst als Nutzer anlegen: ${escapeHtml(unmatched.join(", "))}</p>`
    : "";

  if (rows.length === 0) {
    panel.innerHTML =
      `<p class="muted">Nichts nachzupflegen — alle zugeordneten Nutzer sind bereits aktuell${upToDateCount > 0 ? ` (${upToDateCount})` : ""}.</p>` +
      unmatchedHtml;
    return;
  }

  const rowsHtml = rows.map((r, i) => {
    const lizenzHtml = r.lizenzChange
      ? `Lizenz: <span class="muted">—</span> → <strong>${escapeHtml(r.newLizenz)}</strong>`
      : (r.curLizenz ? `Lizenz: ${escapeHtml(r.curLizenz)} <span class="muted">(bleibt)</span>` : `Lizenz: <span class="muted">—</span>`);
    const teamHtml = r.teamChange
      ? `Mannschaft: ${r.curTeams.length ? escapeHtml(r.curTeams.join(", ")) + " " : ""}<strong>+ ${escapeHtml(r.addTeams.join(", "))}</strong>`
      : `Mannschaft: ${r.curTeams.length ? escapeHtml(r.curTeams.join(", ")) : "—"} <span class="muted">(bleibt)</span>`;
    return `
      <label class="checkbox-label" style="display:flex; gap:10px; align-items:flex-start; padding:6px 0; border-bottom:1px solid rgba(0,0,0,0.08);">
        <input type="checkbox" data-backfill-row="${i}" checked />
        <span><strong>${escapeHtml(r.displayName)}</strong><br>
        <span class="muted" style="font-size:0.9em;">${lizenzHtml} · ${teamHtml}</span></span>
      </label>`;
  }).join("");

  panel.innerHTML = `
    <p class="muted">${rows.length} Nutzer aus den Personalkosten nachpflegbar${upToDateCount > 0 ? `, ${upToDateCount} bereits aktuell` : ""}. Bestehende Lizenzen werden nicht überschrieben, Mannschaften nur ergänzt.</p>
    <div id="backfill-rows">${rowsHtml}</div>
    <div class="btn-row" style="margin-top:12px; gap:8px; justify-content:flex-start;">
      <button type="button" class="btn small" id="btn-backfill-apply">Ausgewählte übernehmen</button>
      <button type="button" class="btn secondary small" id="btn-backfill-cancel">Abbrechen</button>
    </div>
    <p class="muted" id="backfill-status" style="margin-top:10px;"></p>
    ${unmatchedHtml}`;

  document.getElementById("btn-backfill-cancel").addEventListener("click", () => {
    panel.style.display = "none";
    panel.innerHTML = "";
  });
  document.getElementById("btn-backfill-apply").addEventListener("click", () => applyBackfill(rows));
}

async function applyBackfill(rows) {
  const statusEl = document.getElementById("backfill-status");
  const applyBtn = document.getElementById("btn-backfill-apply");
  const selected = rows.filter((r, i) => {
    const cb = document.querySelector(`[data-backfill-row="${i}"]`);
    return cb && cb.checked;
  });
  if (selected.length === 0) { statusEl.textContent = "Nichts ausgewählt."; return; }

  applyBtn.disabled = true;
  let done = 0, failed = 0;
  for (const r of selected) {
    statusEl.textContent = `Übernehme… (${done + failed + 1}/${selected.length})`;
    try {
      await callWorker("update-user", {
        username: r.username, vorname: r.vorname, nachname: r.nachname, isAdmin: r.isAdmin,
        lizenz: r.newLizenz, mannschaften: r.newTeams
      });
      done++;
    } catch (_) {
      failed++;
    }
  }
  statusEl.textContent = `Fertig: ${done} übernommen${failed ? `, ${failed} fehlgeschlagen (Worker schon deployed?)` : ""}. „Aus Personalkosten übernehmen“ erneut klicken, um das Ergebnis zu prüfen.`;
  applyBtn.disabled = false;
  await loadAndRenderUsers();
}

// Gleicht die Gruppenmitgliedschaft eines Nutzers auf den gewünschten Stand
// ab, indem nur die tatsächlich geänderten Gruppen einzeln aktualisiert werden.
// groupsState ist der Stand VOR dieser Bearbeitung und kennt bei einer
// Umbenennung nur den alten Nutzernamen; Mitgliedschaft deshalb unter dem
// alten Namen prüfen (passend zum Cache) und in memberUsernames immer beide
// Varianten herausfiltern, bevor ggf. der neue Name wieder ergänzt wird —
// sonst überlebt eine im selben Speichervorgang entfernte Gruppe die
// Umbenennung unbemerkt (der Server hat den alten Namen zu diesem Zeitpunkt
// serverseitig schon in jede bisherige Gruppe umgetragen).
async function applyUserGroupMembership(oldUsername, newUsername, desiredGroupIds) {
  for (const group of groupsState) {
    const isMember = group.memberUsernames.includes(oldUsername);
    const shouldBeMember = desiredGroupIds.includes(group.id);
    if (isMember === shouldBeMember) continue;
    const memberUsernames = group.memberUsernames.filter((m) => m !== oldUsername && m !== newUsername);
    if (shouldBeMember) memberUsernames.push(newUsername);
    await callWorker("update-group-members", { groupId: group.id, memberUsernames });
  }
}

async function loadAndRenderGroups() {
  const errorEl = document.getElementById("groups-error");
  errorEl.style.display = "none";
  try {
    const data = await callWorker("list-groups", {});
    groupsState = data.groups;
    renderGroupsList();
    renderGroupCheckboxes(document.getElementById("new-user-groups"), []);
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }
}

function renderGroupCheckboxes(container, selectedIds) {
  if (!container) return;
  container.innerHTML = "";
  if (groupsState.length === 0) {
    container.innerHTML = '<span class="muted">Keine Gruppen vorhanden.</span>';
    return;
  }
  groupsState.forEach((g) => {
    const label = document.createElement("label");
    label.className = "checkbox-label";
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(g.id)}" ${selectedIds && selectedIds.includes(g.id) ? "checked" : ""} /> ${escapeHtml(g.name)}`;
    container.appendChild(label);
  });
}

function getCheckedValues(container, kind) {
  if (!container) return [];
  const selector = kind ? `input[type="checkbox"][data-kind="${kind}"]:checked` : 'input[type="checkbox"]:checked';
  return Array.from(container.querySelectorAll(selector)).map((cb) => cb.value);
}

// Apps, die einen serverseitigen Provisioning-Adapter haben (siehe admin-worker.js
// PROVISION_ADAPTERS) — nur für diese wird die "Auto-Eintrag"-Checkbox angeboten.
const PROVISIONABLE_APPS = ["personalkosten", "trainercheckliste", "kadermanager", "trainerdaten", "trainerkodex"];

// Fasst den Provisioning-Report ({ [app]: { [username]: ergebnis } }) knapp zusammen.
function summarizeProvisionReport(report) {
  const parts = [];
  Object.entries(report || {}).forEach(([app, byUser]) => {
    const vals = Object.values(byUser || {});
    const count = (x) => vals.filter((v) => v === x).length;
    const bits = [];
    if (count("created")) bits.push(`${count("created")} neu`);
    if (count("exists")) bits.push(`${count("exists")} vorhanden`);
    if (count("no-team")) bits.push(`${count("no-team")}× kein Team`);
    if (count("no-season")) bits.push(`${count("no-season")}× keine Saison`);
    if (count("error")) bits.push(`${count("error")} Fehler`);
    parts.push(`${app}: ${bits.join(", ") || "—"}`);
  });
  return parts.join(" · ");
}

// Berechnet den neuen Sichtbarkeits-Zustand aller Tools, nachdem im "Apps"-Bereich
// einer Gruppe die Tool-Auswahl geändert wurde. Zentrale Regel: Verliert ein Tool
// durch diese Änderung seine letzte Gruppe, wird es wieder versteckt (visible:false),
// statt für alle eingeloggten Nutzer sichtbar zu werden. Tools, die dieser Gruppe nie
// zugeordnet waren (öffentlich oder bewusst "alle Eingeloggten"), bleiben unverändert.
//
// editGroupIds (Bearbeiten-Recht) ist bewusst unabhängig von visible/loginRequired:
// eine Gruppe kann Bearbeiten-Rechte für ein Tool bekommen, ohne dessen Sichtbarkeits-
// Modus zu verändern (z.B. bei einem Tool, das ohnehin für "Alle eingeloggten Nutzer"
// sichtbar ist) — sonst würde das Vergeben eines Bearbeiten-Rechts die Sichtbarkeit
// ungewollt auf "Nur bestimmte Gruppen" verengen.
function computeGroupToolVisibility(groupId, selectedToolIds, selectedEditToolIds, selectedAdminToolIds, selectedProvisionToolIds) {
  const updated = {};
  TOOLS.forEach((t) => {
    const entry = visibilityState[t.id] || { visible: true, loginRequired: false, groupIds: [], editGroupIds: [], adminGroupIds: [], provisionGroupIds: [] };
    const wasInGroup = (entry.groupIds || []).includes(groupId);
    const groupIds = new Set(entry.groupIds || []);
    const shouldHaveAccess = selectedToolIds.includes(t.id);
    if (shouldHaveAccess) groupIds.add(groupId); else groupIds.delete(groupId);
    const remaining = Array.from(groupIds);

    let visible = entry.visible !== false;
    let loginRequired = !!entry.loginRequired;
    if (shouldHaveAccess) {
      // Zugriff für diese Gruppe: Tool ist sichtbar und nur für Eingeloggte.
      visible = true;
      loginRequired = true;
    } else if (wasInGroup && remaining.length === 0) {
      // Diese Gruppe war die letzte mit Zugriff — Tool wieder verstecken.
      visible = false;
    }

    const editGroupIds = new Set(entry.editGroupIds || []);
    if (selectedEditToolIds.includes(t.id)) editGroupIds.add(groupId); else editGroupIds.delete(groupId);

    // Administrieren (dritte Stufe): schließt Bearbeiten serverseitig ein
    // (resolveEditPermission wertet adminGroupIds mit) — hier nur speichern,
    // die Häkchen-Kopplung übernimmt der change-Listener am Picker.
    const adminGroupIds = new Set(entry.adminGroupIds || []);
    if ((selectedAdminToolIds || []).includes(t.id)) adminGroupIds.add(groupId); else adminGroupIds.delete(groupId);

    // provisionGroupIds nur für provisionierbare Apps anfassen, sonst unverändert lassen.
    const provisionGroupIds = new Set(entry.provisionGroupIds || []);
    if (PROVISIONABLE_APPS.includes(t.id)) {
      if ((selectedProvisionToolIds || []).includes(t.id)) provisionGroupIds.add(groupId); else provisionGroupIds.delete(groupId);
    }

    updated[t.id] = {
      visible, loginRequired,
      groupIds: remaining,
      editGroupIds: Array.from(editGroupIds),
      adminGroupIds: Array.from(adminGroupIds),
      provisionGroupIds: Array.from(provisionGroupIds)
    };
  });
  return updated;
}

function renderGroupsList() {
  const container = document.getElementById("groups-list");
  container.innerHTML = "";
  if (groupsState.length === 0) {
    container.innerHTML = '<p class="muted">Noch keine Gruppen angelegt.</p>';
    return;
  }
  groupsState.forEach((g) => {
    const row = document.createElement("div");
    row.className = "group-row";
    row.dataset.groupId = g.id;
    row.innerHTML = `
      <div class="gr-header">
        <span class="gr-name">${escapeHtml(g.name)}</span>
        <span class="muted">${g.memberUsernames.length} Mitglied(er)</span>
        <button type="button" class="btn secondary small" data-rename-group="${escapeHtml(g.id)}">Umbenennen</button>
        <button type="button" class="btn secondary small" data-toggle-members="${escapeHtml(g.id)}">Mitglieder</button>
        <button type="button" class="btn secondary small" data-toggle-tools="${escapeHtml(g.id)}">Apps</button>
        <button type="button" class="btn secondary small" data-delete-group="${escapeHtml(g.id)}">Löschen</button>
      </div>
      <div class="gr-rename" data-rename-for="${escapeHtml(g.id)}" style="display:none;"></div>
      <div class="gr-members" data-members-for="${escapeHtml(g.id)}" style="display:none;"></div>
      <div class="gr-members" data-tools-for="${escapeHtml(g.id)}" style="display:none;"></div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll("[data-toggle-tools]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupId = btn.dataset.toggleTools;
      const panel = btn.closest(".group-row").querySelector("[data-tools-for]");
      const isOpen = panel.style.display !== "none";
      if (isOpen) {
        panel.style.display = "none";
        return;
      }
      panel.innerHTML = `
        <div class="group-picker"></div>
        <p class="muted" style="margin:8px 0 4px;">„Auto-Eintrag“: Mitglieder dieser Gruppe werden beim Anlegen automatisch als Eintrag in der App angelegt (z. B. Trainer-Zeile in Personalkosten).</p>
        <div class="btn-row" style="justify-content:flex-start; gap:8px;">
          <button type="button" class="btn small" data-save-group-tools="${escapeHtml(groupId)}">Speichern</button>
          <button type="button" class="btn secondary small" data-provision-group="${escapeHtml(groupId)}">Bestehende Mitglieder jetzt eintragen</button>
        </div>
        <p class="muted" data-provision-status style="margin-top:8px;"></p>
      `;
      const picker = panel.querySelector(".group-picker");
      TOOLS.forEach((t) => {
        const entry = visibilityState[t.id] || {};
        const canSee = (entry.groupIds || []).includes(groupId);
        const canEditTool = (entry.editGroupIds || []).includes(groupId);
        const canAdminTool = (entry.adminGroupIds || []).includes(groupId);
        const canProvision = (entry.provisionGroupIds || []).includes(groupId);
        const provisionCell = PROVISIONABLE_APPS.includes(t.id)
          ? `<label class="checkbox-label"><input type="checkbox" data-kind="provision" value="${escapeHtml(t.id)}" ${canProvision ? "checked" : ""} /> Auto-Eintrag</label>`
          : "";
        const row = document.createElement("div");
        row.className = "group-picker-row";
        row.innerHTML = `
          <span class="gp-tool-name">${t.icon || "🔗"} ${escapeHtml(t.name)}</span>
          <label class="checkbox-label"><input type="checkbox" data-kind="see" value="${escapeHtml(t.id)}" ${canSee ? "checked" : ""} /> Sehen</label>
          <label class="checkbox-label"><input type="checkbox" data-kind="edit" value="${escapeHtml(t.id)}" ${canEditTool ? "checked" : ""} /> Bearbeiten</label>
          <label class="checkbox-label"><input type="checkbox" data-kind="admin" value="${escapeHtml(t.id)}" ${canAdminTool ? "checked" : ""} /> Administrieren</label>
          ${provisionCell}
        `;
        picker.appendChild(row);
      });
      // Administrieren schließt Bearbeiten ein (serverseitig via resolveEditPermission,
      // maßgeblich ist der Worker) — die Kopplung hier verhindert nur widersprüchlich
      // aussehende Häkchen-Kombinationen in der Anzeige.
      picker.addEventListener("change", (e) => {
        const cb = e.target;
        if (!cb.matches || !cb.matches('input[type="checkbox"][data-kind]')) return;
        const other = (kind) => picker.querySelector(`input[data-kind="${kind}"][value="${CSS.escape(cb.value)}"]`);
        // Kette Administrieren => Bearbeiten => Sehen (serverseitig maßgeblich, siehe
        // userMayAccessTool/resolveEditPermission; hier nur Anzeige-Kopplung gegen
        // widersprüchliche Häkchen). Anhaken zieht nach oben mit, Abwählen nach unten.
        if (cb.checked) {
          if (cb.dataset.kind === "admin") { const ed = other("edit"); if (ed) ed.checked = true; const se = other("see"); if (se) se.checked = true; }
          if (cb.dataset.kind === "edit") { const se = other("see"); if (se) se.checked = true; }
        } else {
          if (cb.dataset.kind === "see") { const ed = other("edit"); if (ed) ed.checked = false; const ad = other("admin"); if (ad) ad.checked = false; }
          if (cb.dataset.kind === "edit") { const ad = other("admin"); if (ad) ad.checked = false; }
        }
      });
      panel.style.display = "block";
      panel.querySelector("[data-save-group-tools]").addEventListener("click", async () => {
        const selectedToolIds = getCheckedValues(picker, "see");
        const selectedEditToolIds = getCheckedValues(picker, "edit");
        const selectedAdminToolIds = getCheckedValues(picker, "admin");
        const selectedProvisionToolIds = getCheckedValues(picker, "provision");
        const errorEl = document.getElementById("groups-error");
        errorEl.style.display = "none";
        try {
          const updatedTools = computeGroupToolVisibility(groupId, selectedToolIds, selectedEditToolIds, selectedAdminToolIds, selectedProvisionToolIds);
          await callWorker("save-visibility", { tools: updatedTools });
          visibilityState = updatedTools;
          renderToolGrid();
          renderVisibilityList();
          panel.style.display = "none";
        } catch (e) {
          errorEl.textContent = e.message;
          errorEl.style.display = "block";
        }
      });
      panel.querySelector("[data-provision-group]").addEventListener("click", async (ev) => {
        const statusEl = panel.querySelector("[data-provision-status]");
        const pbtn = ev.currentTarget;
        pbtn.disabled = true;
        statusEl.textContent = "Lege Einträge an…";
        try {
          const res = await callWorker("provision-group", { groupId });
          const summary = summarizeProvisionReport(res.provisioned);
          statusEl.textContent = summary
            ? `Fertig (${res.memberCount} Mitglied(er)): ${summary}`
            : "Für diese Gruppe ist keine App als „Auto-Eintrag“ markiert (oder keine Mitglieder). Erst oben anhaken + speichern.";
        } catch (e) {
          statusEl.textContent = "Fehler: " + e.message + " (Worker schon deployed?)";
        } finally {
          pbtn.disabled = false;
        }
      });
    });
  });

  container.querySelectorAll("[data-toggle-members]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupId = btn.dataset.toggleMembers;
      const membersEl = row_findMembersEl(container, groupId);
      const isOpen = membersEl.style.display !== "none";
      if (isOpen) {
        membersEl.style.display = "none";
        return;
      }
      const group = groupsState.find((g) => g.id === groupId);
      membersEl.innerHTML = `
        <div class="group-picker">
          ${usersState.map((u) => `
            <label class="checkbox-label">
              <input type="checkbox" value="${escapeHtml(u.username)}" ${group.memberUsernames.includes(u.username) ? "checked" : ""} />
              ${escapeHtml(u.displayName || u.username)}
            </label>
          `).join("")}
        </div>
        <button type="button" class="btn small" data-save-members="${escapeHtml(groupId)}">Speichern</button>
      `;
      membersEl.style.display = "block";
      membersEl.querySelector("[data-save-members]").addEventListener("click", async () => {
        const memberUsernames = getCheckedValues(membersEl.querySelector(".group-picker"));
        const errorEl = document.getElementById("groups-error");
        errorEl.style.display = "none";
        try {
          await callWorker("update-group-members", { groupId, memberUsernames });
          await loadAndRenderGroups();
          await loadAndRenderUsers();
        } catch (e) {
          errorEl.textContent = e.message;
          errorEl.style.display = "block";
        }
      });
    });
  });

  // Umbenennen als aufklappbare Zeile statt window.prompt: ein prompt zeigt den
  // bisherigen Namen zwar an, lässt ihn aber auf manchen Geräten nicht
  // bearbeiten -- und genau darum geht es hier meistens (ein Buchstabe im
  // Tippfehler). Zudem ist prompt am Handy ein Systemdialog ohne Kontext.
  container.querySelectorAll("[data-rename-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupId = btn.dataset.renameGroup;
      const gruppe = groupsState.filter((x) => x.id === groupId)[0];
      const panel = btn.closest(".group-row").querySelector("[data-rename-for]");
      if (panel.style.display !== "none") { panel.style.display = "none"; panel.innerHTML = ""; return; }
      panel.style.display = "block";
      panel.innerHTML = "";

      const eingabe = document.createElement("input");
      eingabe.type = "text";
      eingabe.className = "gr-rename-input";
      eingabe.value = gruppe ? gruppe.name : "";
      eingabe.maxLength = 80;
      const speichern = document.createElement("button");
      speichern.type = "button";
      speichern.className = "btn small";
      speichern.textContent = "Speichern";
      const abbrechen = document.createElement("button");
      abbrechen.type = "button";
      abbrechen.className = "btn secondary small";
      abbrechen.textContent = "Abbrechen";
      const hinweis = document.createElement("p");
      hinweis.className = "muted gr-rename-hinweis";
      // ⚠️ Der Satz gehört dorthin, wo umbenannt wird: die Rechte hängen an der
      // Id, nicht am Namen. Ohne den Hinweis liegt die Sorge nahe, eine
      // Umbenennung könnte Mitglieder oder Freigaben kosten -- und dann traut
      // sich niemand, einen Tippfehler zu korrigieren.
      hinweis.textContent = "Ändert nur die Beschriftung. Mitglieder, Rechte und Freigaben bleiben unverändert.";

      const tun = async () => {
        const name = eingabe.value.trim();
        const errorEl = document.getElementById("groups-error");
        errorEl.style.display = "none";
        if (!name) { errorEl.textContent = "Der Gruppenname darf nicht leer sein."; errorEl.style.display = "block"; return; }
        speichern.disabled = true;
        try {
          await callWorker("rename-group", { groupId, name });
          await loadAndRenderGroups();
          // Die Gruppennamen stehen auch im Sichtbarkeits-Panel und in den
          // Nutzerzeilen -- ohne das Nachziehen zeigt die halbe Seite noch den
          // alten Namen, bis jemand neu lädt.
          await loadAndRenderUsers();
          renderVisibilityList();
        } catch (e) {
          errorEl.textContent = e.message;
          errorEl.style.display = "block";
          speichern.disabled = false;
        }
      };
      speichern.addEventListener("click", tun);
      eingabe.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); tun(); }
        if (e.key === "Escape") { panel.style.display = "none"; panel.innerHTML = ""; }
      });
      abbrechen.addEventListener("click", () => { panel.style.display = "none"; panel.innerHTML = ""; });

      const zeile = document.createElement("div");
      zeile.className = "gr-rename-zeile";
      zeile.appendChild(eingabe);
      zeile.appendChild(speichern);
      zeile.appendChild(abbrechen);
      panel.appendChild(zeile);
      panel.appendChild(hinweis);
      eingabe.focus();
      eingabe.select();
    });
  });

  container.querySelectorAll("[data-delete-group]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".group-row");
      const name = row.querySelector(".gr-name").textContent;
      if (!confirm(`Gruppe "${name}" wirklich löschen?`)) return;
      const errorEl = document.getElementById("groups-error");
      errorEl.style.display = "none";
      try {
        await callWorker("delete-group", { groupId: btn.dataset.deleteGroup });
        await loadAndRenderGroups();
        await loadAndRenderUsers();
        renderVisibilityList();
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    });
  });
}

function row_findMembersEl(container, groupId) {
  return Array.from(container.querySelectorAll("[data-members-for]")).find((el) => el.dataset.membersFor === groupId);
}

function isVisibleToUser(toolId, user) {
  // Kein gespeicherter Eintrag (z.B. Tool per Code-Push neu hinzugefügt, aber
  // noch nie im Sichtbarkeits-Panel gespeichert) gilt als versteckt, nicht als
  // öffentlich — passend zu userMayAccessTool() im Worker, das den WebDAV-
  // Gatewayzugriff für genau diesen Fall schon immer verweigert hat.
  const entry = visibilityState[toolId];
  if (!entry || entry.visible === false) return false;
  if (!entry.loginRequired) return true;
  if (!user) return false;
  if (user.isAdmin) return true;
  const groupIds = entry.groupIds || [];
  if (groupIds.length === 0) return true;
  return groupIds.some((gid) => (user.groupIds || []).includes(gid));
}

// ---- Persoenliche Ansicht: Kacheln/Liste + eigene Reihenfolge (seit 2026-08-07) ----
//
// Bis dahin war die Reihenfolge eine rein lokale Vorliebe (localStorage, pro Browser)
// -- auf dem Laptop stand also etwas anderes als am Handy. Sie liegt jetzt am Konto
// (Worker-Aktionen meine-ansicht / meine-ansicht-speichern) und gilt ueberall gleich.
// localStorage bleibt ausschliesslich als Zwischenspeicher fuer den Seitenaufbau.

function ansichtStandard() {
  return { modus: "kacheln", reihenfolge: {} };
}

// Nimmt an, was vom Server oder aus dem Zwischenspeicher kommt, und baut daraus einen
// geprueften Zustand -- nie das fremde Objekt selbst.
function ansichtUebernehmen(roh) {
  const modus = (roh && (roh.modus === "liste" || roh.modus === "kacheln")) ? roh.modus : "kacheln";
  const rohReihenfolge = (roh && roh.reihenfolge && typeof roh.reihenfolge === "object" && !Array.isArray(roh.reihenfolge)) ? roh.reihenfolge : {};
  const reihenfolge = {};
  Object.keys(rohReihenfolge).forEach((kategorie) => {
    if (kategorie === "__proto__") return;
    const ids = rohReihenfolge[kategorie];
    if (Array.isArray(ids)) reihenfolge[kategorie] = ids.map((id) => String(id || "")).filter(Boolean);
  });
  ansichtState = { modus, reihenfolge };
}

function ansichtCacheLesen(username) {
  if (!username) return null;
  try {
    const alle = JSON.parse(localStorage.getItem(ANSICHT_STORAGE_KEY)) || {};
    return Object.prototype.hasOwnProperty.call(alle, username) ? alle[username] : null;
  } catch (_) {
    return null;
  }
}

function ansichtCacheSchreiben(username, ansicht) {
  if (!username) return;
  try {
    let alle = {};
    try { alle = JSON.parse(localStorage.getItem(ANSICHT_STORAGE_KEY)) || {}; } catch (_) { alle = {}; }
    alle[username] = ansicht;
    localStorage.setItem(ANSICHT_STORAGE_KEY, JSON.stringify(alle));
  } catch (_) { /* localStorage nicht verfügbar */ }
}

// Holt die Ansicht des angemeldeten Nutzers.
//
// ⚠️ Baut den Aufruf selbst statt ueber callWorker(): die Funktion laeuft in init()
// PARALLEL zu checkSession(), und currentToken ist zu dem Zeitpunkt noch null. Gleiche
// Lage und gleicher Weg wie bei fetchVisibility().
//
// Der Zwischenspeicher wird zuerst angewandt, damit die Kacheln beim Rendern schon
// richtig stehen, falls der Aufruf laenger braucht als der Rest des Seitenaufbaus.
// Massgeblich bleibt die Server-Antwort, die ihn ueberschreibt.
async function ladeAnsicht() {
  const token = currentToken || loadStoredToken();
  if (!token) { ansichtState = ansichtStandard(); return; }

  let data = null;
  try {
    const resp = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ action: "meine-ansicht" })
    });
    if (!resp.ok) return; // 401 (Token abgelaufen) oder alter Worker ohne die Aktion -> Standardansicht
    data = await resp.json();
  } catch (_) {
    return; // offline: bei der Standardansicht bzw. beim Zwischenspeicher bleiben
  }
  ansichtUebernehmen(data && data.ansicht);
  ansichtVomServer = true;

  // Einmalige Uebernahme der alten, rein lokalen Reihenfolge: wer vor dieser Aenderung
  // schon einmal Kacheln verschoben hat, soll seine Anordnung nicht verlieren. Nur wenn
  // am Konto noch gar nichts steht -- eine am anderen Geraet gespeicherte Reihenfolge
  // darf die alte lokale nie ueberschreiben.
  if (!Object.keys(ansichtState.reihenfolge).length) {
    let alt = null;
    try { alt = JSON.parse(localStorage.getItem(TOOL_ORDER_STORAGE_KEY)); } catch (_) { alt = null; }
    if (alt && typeof alt === "object" && Object.keys(alt).length) {
      ansichtUebernehmen({ modus: ansichtState.modus, reihenfolge: alt });
      ansichtSpeichernGeplant();
    }
  }

  const username = currentUser && currentUser.username;
  if (username) ansichtCacheSchreiben(username, ansichtState);
}

// Wendet den Zwischenspeicher an, bevor der Server geantwortet hat. Wird beim
// Seitenaufbau aufgerufen, sobald der Nutzername bekannt ist.
function ansichtAusCacheVorbelegen() {
  const username = currentUser && currentUser.username;
  const zwischen = ansichtCacheLesen(username);
  if (zwischen) ansichtUebernehmen(zwischen);
}

// Speichern wird gebuendelt: beim Verschieben mehrerer Karten hintereinander sonst ein
// Worker-Aufruf (und ein Nextcloud-Schreibvorgang) je Ablegen.
function ansichtSpeichernGeplant() {
  if (_ansichtSaveTimer) clearTimeout(_ansichtSaveTimer);
  _ansichtSaveTimer = setTimeout(() => { _ansichtSaveTimer = null; ansichtJetztSpeichern(); }, 800);
}

// ⚠️ In-Flight-Guard: waehrend ein Speichern laeuft, wird kein zweites gestartet --
// zwei parallele Schreibvorgaenge auf dieselbe Datei sind ein Konflikt mit sich selbst.
// Eine Aenderung, die waehrenddessen eintrifft, wird gemerkt und danach nachgezogen.
async function ansichtJetztSpeichern() {
  if (!currentUser) return;
  if (_ansichtSaveLaeuft) { _ansichtSaveNachholen = true; return; }
  _ansichtSaveLaeuft = true;
  const statusEl = document.getElementById("ansicht-status");
  try {
    await callWorker("meine-ansicht-speichern", { modus: ansichtState.modus, reihenfolge: ansichtState.reihenfolge });
    ansichtCacheSchreiben(currentUser.username, ansichtState);
    if (statusEl) { statusEl.classList.remove("fehler"); statusEl.textContent = "Gespeichert"; setTimeout(() => { if (statusEl.textContent === "Gespeichert") statusEl.textContent = ""; }, 2000); }
  } catch (e) {
    // ⚠️ Nicht still schlucken: die Zusage ist, dass die Ansicht auf jedem Geraet
    // gleich ist. Scheitert das Speichern, stimmt sie nur hier -- das muss dastehen.
    console.warn("Ansicht nicht speicherbar:", e);
    if (statusEl) { statusEl.classList.add("fehler"); statusEl.textContent = "Nicht gespeichert — nur auf diesem Gerät."; }
  } finally {
    _ansichtSaveLaeuft = false;
    if (_ansichtSaveNachholen) { _ansichtSaveNachholen = false; ansichtSpeichernGeplant(); }
  }
}

// ⚠️ Beim Verlassen der Seite das gebuendelte Speichern nachholen. Ohne keepalive
// bricht der Browser den Aufruf beim Schliessen des Tabs ab, und die letzte
// Verschiebung waere weg -- siehe dieselbe Falle bei den Autosave-Apps der Flotte.
function ansichtFlushBeiVerlassen() {
  if (!_ansichtSaveTimer || !currentToken) return;
  clearTimeout(_ansichtSaveTimer);
  _ansichtSaveTimer = null;
  try {
    fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + currentToken },
      body: JSON.stringify({ action: "meine-ansicht-speichern", modus: ansichtState.modus, reihenfolge: ansichtState.reihenfolge }),
      keepalive: true
    });
  } catch (_) { /* mehr geht beim Schliessen nicht */ }
}

function saveToolOrder(category, orderedIds) {
  ansichtState.reihenfolge[category] = orderedIds;
  ansichtSpeichernGeplant();
}

// Wendet eine gespeicherte Reihenfolge an; neue/unbekannte Tools (kein Eintrag in der
// gespeicherten Reihenfolge, z.B. weil gerade erst hinzugefügt) hängen unverändert hinten an.
function applyCustomOrder(category, tools) {
  const order = ansichtState.reihenfolge[category];
  if (!order || !order.length) return tools;
  const remaining = new Map(tools.map((t) => [t.id, t]));
  const ordered = [];
  order.forEach((id) => {
    if (remaining.has(id)) { ordered.push(remaining.get(id)); remaining.delete(id); }
  });
  tools.forEach((t) => { if (remaining.has(t.id)) ordered.push(t); });
  return ordered;
}

// Startet einen Verschiebe-Vorgang per Pointer Events (vereint Maus/Touch/Stift).
// Reordering-Technik: beim Überqueren einer anderen Karte im selben Grid wird die
// gezogene Karte per insertBefore direkt an deren Stelle im DOM verschoben — kein
// Ghost-Element/Geometrie-Berechnung nötig, bewährtes einfaches Muster.
function startCardDrag(e, card, grid, category) {
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  dragState = { pointerId: e.pointerId, handle, card, grid, category, startX: e.clientX, startY: e.clientY, moved: false };

  const onMove = (ev) => {
    if (!dragState || ev.pointerId !== dragState.pointerId) return;
    if (!dragState.moved) {
      if (Math.hypot(ev.clientX - dragState.startX, ev.clientY - dragState.startY) < 6) return;
      dragState.moved = true;
      dragState.card.classList.add("dragging");
    }
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el) return;
    const overCard = el.closest(".tool-card");
    if (overCard && overCard !== dragState.card && overCard.parentElement === dragState.grid) {
      dragState.grid.insertBefore(dragState.card, overCard);
    } else if (!overCard && el.closest(".tool-grid") === dragState.grid) {
      dragState.grid.appendChild(dragState.card);
    }
  };

  const onUp = (ev) => {
    if (!dragState || ev.pointerId !== dragState.pointerId) return;
    const { card: draggedCard, grid: draggedGrid, category: draggedCategory, moved, handle: draggedHandle } = dragState;
    draggedCard.classList.remove("dragging");
    try { draggedHandle.releasePointerCapture(ev.pointerId); } catch (_) { /* schon freigegeben */ }
    if (moved) {
      draggedCard.dataset.justDragged = "1";
      setTimeout(() => { delete draggedCard.dataset.justDragged; }, 0);
      saveToolOrder(draggedCategory, Array.from(draggedGrid.children).map((c) => c.dataset.toolId));
    }
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    dragState = null;
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

// ---- Bedienleiste ueber den Kacheln ----

// Wird am Ende von renderToolGrid() aufgerufen, damit Leiste und Kacheln nie
// auseinanderlaufen. Setzt ausschliesslich Anzeige-Zustaende und rendert bewusst NICHT
// nach -- sonst riefen sich die beiden gegenseitig auf.
function renderAnsichtLeiste(hatKacheln) {
  const leiste = document.getElementById("ansicht-leiste");
  if (!leiste) return;
  // Nur fuer Angemeldete: die Einstellung haengt am Konto, ein unangemeldeter Besucher
  // haette nichts, woran sie sich merken liesse. Gleiche Linie wie Info-Tab und
  // Neuigkeiten.
  const sichtbar = !!currentUser && !!hatKacheln;
  leiste.style.display = sichtbar ? "flex" : "none";
  if (!sichtbar && ansichtBearbeiten) {
    ansichtBearbeiten = false;
    const container = document.getElementById("tool-groups");
    if (container) container.classList.remove("anordnen");
  }

  const kachelBtn = document.getElementById("btn-ansicht-kacheln");
  const listeBtn = document.getElementById("btn-ansicht-liste");
  if (kachelBtn) kachelBtn.setAttribute("aria-pressed", ansichtState.modus === "kacheln" ? "true" : "false");
  if (listeBtn) listeBtn.setAttribute("aria-pressed", ansichtState.modus === "liste" ? "true" : "false");

  const anordnenBtn = document.getElementById("btn-ansicht-anordnen");
  if (anordnenBtn) {
    anordnenBtn.textContent = ansichtBearbeiten ? "✓ Fertig" : "✏️ Anordnen";
    anordnenBtn.classList.toggle("aktiv", ansichtBearbeiten);
    anordnenBtn.title = ansichtBearbeiten ? "Anordnen beenden" : "Reihenfolge der Werkzeuge ändern";
  }
  const hinweis = document.getElementById("ansicht-hinweis");
  if (hinweis) hinweis.style.display = ansichtBearbeiten ? "inline" : "none";
}

function ansichtModusSetzen(modus) {
  if (ansichtState.modus === modus) return;
  ansichtState.modus = modus;
  renderToolGrid();
  ansichtSpeichernGeplant();
}

function ansichtBearbeitenUmschalten() {
  ansichtBearbeiten = !ansichtBearbeiten;
  renderToolGrid();
  // Beim Beenden nicht auf den Buendel-Timer warten: wer auf Fertig drueckt, erwartet,
  // dass es jetzt steht.
  if (!ansichtBearbeiten && _ansichtSaveTimer) {
    clearTimeout(_ansichtSaveTimer);
    _ansichtSaveTimer = null;
    ansichtJetztSpeichern();
  }
}

function setupAnsichtLeiste() {
  const kachelBtn = document.getElementById("btn-ansicht-kacheln");
  const listeBtn = document.getElementById("btn-ansicht-liste");
  const anordnenBtn = document.getElementById("btn-ansicht-anordnen");
  if (kachelBtn) kachelBtn.addEventListener("click", () => ansichtModusSetzen("kacheln"));
  if (listeBtn) listeBtn.addEventListener("click", () => ansichtModusSetzen("liste"));
  if (anordnenBtn) anordnenBtn.addEventListener("click", ansichtBearbeitenUmschalten);
  // Ein noch nicht abgeschickter Buendel-Speichervorgang darf beim Wegwischen der Seite
  // nicht verloren gehen. pagehide feuert auf iOS zuverlaessiger als unload; der
  // versteckte Tab ist der zweite Fall (Tab-Wechsel, App in den Hintergrund).
  window.addEventListener("pagehide", ansichtFlushBeiVerlassen);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") ansichtFlushBeiVerlassen();
  });
}

function renderToolGrid() {
  const container = document.getElementById("tool-groups");
  // ⚠️ Waehrend eine Karte am Finger haengt, nicht neu bauen: die Statusabfragen
  // (Trainerdaten/Testspielplaner) rendern von selbst nach und rissen der laufenden
  // Verschiebung sonst die Karte unter dem Zeiger weg. Der naechste Aufruf holt es nach.
  if (dragState) return;
  container.innerHTML = "";
  container.classList.toggle("anordnen", ansichtBearbeiten);

  const categories = [...new Set(TOOLS.map((t) => t.category))];
  let anyVisible = false;

  categories.forEach((category) => {
    const toolsUnordered = TOOLS.filter((t) => t.category === category && isVisibleToUser(t.id, currentUser));
    if (toolsUnordered.length === 0) return;
    anyVisible = true;
    const toolsInCategory = applyCustomOrder(category, toolsUnordered);

    const group = document.createElement("div");
    group.className = "category-group";
    group.innerHTML = `<h2>${escapeHtml(category)}</h2>`;

    const grid = document.createElement("div");
    // Dieselben Karten in beiden Ansichten -- nur der Container wechselt die Klasse,
    // das Aussehen macht das CSS (siehe .tool-grid.als-liste in style.css).
    grid.className = "tool-grid" + (ansichtState.modus === "liste" ? " als-liste" : "");
    toolsInCategory.forEach((t) => {
      const card = document.createElement("a");
      card.className = "tool-card" + (t.wip ? " wip" : "");
      card.href = t.url;
      // Optionales newTab-Flag (config.js): Tool in neuem Tab öffnen, Dashboard
      // bleibt offen — z.B. für die Besprechung (Sprach-/Videoraum).
      if (t.newTab) { card.target = "_blank"; card.rel = "noopener"; }
      card.dataset.toolId = t.id;
      card.innerHTML = `
        <span class="tool-drag-handle" title="Verschieben" aria-hidden="true">⠿</span>
        <div class="tool-icon">${t.icon || "🔗"}</div>
        ${t.wip ? '<div class="badge-wip">🚧 In Bearbeitung</div>' : ""}
        ${t.id === "trainerdaten" && trainerdatenStatus ? (
          trainerdatenStatus.trainerdatenGesamtOk
            ? '<div class="badge-status-ok">✓ Daten vollständig<button type="button" class="badge-refresh" title="Status aktualisieren" aria-label="Status aktualisieren">⟳</button></div>'
            : '<div class="badge-status-fail">✗ Daten unvollständig<button type="button" class="badge-refresh" title="Status aktualisieren" aria-label="Status aktualisieren">⟳</button></div>'
        ) : ""}
        ${t.id === "testspielplaner" && testspielplanerStatus
          ? `<div class="badge-status-fail">✗ ${testspielplanerStatus.anstehendOhneGegner}× Gegner eintragen</div>`
          : ""}
        <h3>${escapeHtml(t.name)}</h3>
        <p>${escapeHtml(t.description || "")}</p>
        ${t.mail || t.push ? '<div class="tool-hinweis-badges">'
          + (t.mail ? '<span class="tool-hinweis-badge" role="img" title="Dieses Werkzeug verschickt E-Mails nach außen" aria-label="Verschickt E-Mails">✉️</span>' : "")
          + (t.push ? '<span class="tool-hinweis-badge" role="img" title="Eine Handlung hier meldet sich als Nachricht auf dem Handy" aria-label="Schickt Nachrichten aufs Handy">🔔</span>' : "")
          + '</div>' : ""}
      `;
      card.querySelector(".tool-drag-handle").addEventListener("pointerdown", (ev) => startCardDrag(ev, card, grid, category));
      // Im Anordnen-Modus fuehrt kein Klick mehr ins Werkzeug: wer gerade sortiert,
      // trifft sonst beim Danebengreifen eine Kachel und ist aus der Uebersicht raus.
      card.addEventListener("click", (ev) => {
        if (ansichtBearbeiten || card.dataset.justDragged === "1") ev.preventDefault();
      });
      const badgeRefreshBtn = card.querySelector(".badge-refresh");
      if (badgeRefreshBtn) {
        // Eigener Klick-Handler statt Karten-Navigation -- erlaubt ein sofortiges
        // Neuladen des Ampel-Status (my-trainerdaten-status), ohne die Seite neu
        // zu laden. loadTrainerdatenStatus() ruft am Ende selbst renderToolGrid()
        // auf, baut diesen Button also gleich wieder frisch auf -- kein manuelles
        // Zurücksetzen von disabled/Text nötig.
        badgeRefreshBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          badgeRefreshBtn.disabled = true;
          badgeRefreshBtn.textContent = "…";
          loadTrainerdatenStatus();
        });
      }
      grid.appendChild(card);
    });

    group.appendChild(grid);
    container.appendChild(group);
  });

  const emptyEl = document.getElementById("uebersicht-empty");
  emptyEl.style.display = anyVisible ? "none" : "block";
  if (!anyVisible) {
    document.getElementById("uebersicht-empty-text").textContent = currentUser
      ? "Aktuell sind keine Tools für dich sichtbar."
      : "Melde dich an, um deine Tools zu sehen.";
    document.getElementById("btn-empty-login").style.display = currentUser ? "none" : "inline-block";
  }
  renderAnsichtLeiste(anyVisible);
}

// Leitet aus visible/loginRequired/groupIds den anzuzeigenden Sichtbarkeits-Modus ab.
function visibilityMode(entry) {
  if (entry.visible === false) return "hidden";
  if (!entry.loginRequired) return "public";
  if ((entry.groupIds || []).length === 0) return "loggedin";
  return "groups";
}

// Vereinswiki hat seit 1.3 keine eigene Kachel mehr, braucht aber weiterhin eine
// Sichtbarkeits-Konfiguration fuer die Frage-Box in "Feedback & Hilfe" (siehe
// renderFeedbackTab) -- sonst kann ein Admin sie nie (wieder) einstellen.
const VIRTUAL_VISIBILITY_ENTRIES = [
  { id: "vereinswiki", name: "Toolbox Wiki (Frage-Funktion in „Feedback & Hilfe“)", icon: "📚", category: "Verein" }
];

function isKritischesTool(id) {
  // Admin-gesetztes Flag aus der zentralen Sichtbarkeits-Config hat Vorrang; solange es
  // für ein Tool nicht explizit gesetzt ist, gilt die ursprüngliche Vorgabe aus config.js
  // (KRITISCHE_TOOLS) als Default. So ändert sich nichts, bis der Admin es im Panel umstellt.
  const entry = typeof visibilityState !== "undefined" && visibilityState ? visibilityState[id] : null;
  if (entry && typeof entry.kritisch === "boolean") return entry.kritisch;
  return typeof KRITISCHE_TOOLS !== "undefined" && KRITISCHE_TOOLS.includes(id);
}

// Baut eine Sichtbarkeits-Zeile (Modus-Dropdown + Sehen/Bearbeiten/Administrieren-
// Picker samt Kopplung). Aus renderVisibilityList ausgelagert, damit kritische und
// normale Tools in getrennte Container gerendert werden koennen (Baustein 4).
function buildVisibilityRow(t) {
  const entry = visibilityState[t.id] || {};
  const mode = visibilityMode(entry);
  const groupIds = entry.groupIds || [];
  const editGroupIds = entry.editGroupIds || [];
  const adminGroupIds = entry.adminGroupIds || [];
  const kritisch = isKritischesTool(t.id);
  const row = document.createElement("div");
  row.className = "visibility-row" + (kritisch ? " visibility-row-kritisch" : "");
  row.dataset.toolId = t.id;
  const badge = kritisch
    ? '<span class="vr-kritisch" title="Sensibles Tool — Rechte besonders sorgfältig vergeben">⚠️</span> '
    : "";
  row.innerHTML = `
    <span class="tool-icon">${t.icon || "🔗"}</span>
    <span class="vr-name">${badge}${escapeHtml(t.name)}</span>
    <span class="vr-category">${escapeHtml(t.category)}</span>
    <label class="vr-sensibel" title="Als sensibel markieren — das Tool erscheint dann oben unter „Sensible Tools“"><input type="checkbox" data-field="kritisch" ${kritisch ? "checked" : ""} /> Sensibel</label>
    <select data-field="mode" class="form-select">
      <option value="hidden" ${mode === "hidden" ? "selected" : ""}>Versteckt</option>
      <option value="public" ${mode === "public" ? "selected" : ""}>Öffentlich</option>
      <option value="loggedin" ${mode === "loggedin" ? "selected" : ""}>Alle eingeloggten Nutzer</option>
      <option value="groups" ${mode === "groups" ? "selected" : ""}>Nur bestimmte Gruppen</option>
    </select>
    <details class="collapsible visibility-groups">
      <summary>Gruppen (${groupIds.length} sehen, ${editGroupIds.length} bearbeiten, ${adminGroupIds.length} administrieren)</summary>
      <div class="group-picker-wrap" data-field="groupIds" style="display:${mode === "groups" ? "block" : "none"};">
        <div class="gp-label">Sehen</div>
        <div class="group-picker" data-role="see-boxes"></div>
      </div>
      <div class="group-picker-wrap" data-field="editGroupIds">
        <div class="gp-label">Bearbeiten</div>
        <div class="group-picker" data-role="edit-boxes"></div>
      </div>
      <div class="group-picker-wrap" data-field="adminGroupIds">
        <div class="gp-label">Administrieren</div>
        <div class="group-picker" data-role="admin-boxes"></div>
      </div>
    </details>
  `;

  renderGroupCheckboxes(row.querySelector('[data-field="groupIds"] [data-role="see-boxes"]'), groupIds);
  renderGroupCheckboxes(row.querySelector('[data-field="editGroupIds"] [data-role="edit-boxes"]'), editGroupIds);
  renderGroupCheckboxes(row.querySelector('[data-field="adminGroupIds"] [data-role="admin-boxes"]'), adminGroupIds);

  // Volle Kette Administrieren => Bearbeiten => Sehen (serverseitig maßgeblich via
  // userMayAccessTool/resolveEditPermission; hier nur Anzeige-Kopplung). Anhaken zieht
  // nach oben mit, Abwählen nach unten. Die Sehen-Häkchen (groupIds) werden beim
  // Speichern nur im Modus "Nur bestimmte Gruppen" ausgewertet — die Kopplung fügt
  // dort die Gruppe zu Sehen hinzu.
  const seeBoxes = row.querySelector('[data-field="groupIds"]');
  const editBoxes = row.querySelector('[data-field="editGroupIds"]');
  const adminBoxes = row.querySelector('[data-field="adminGroupIds"]');
  row.querySelector(".visibility-groups").addEventListener("change", (e) => {
    const cb = e.target;
    if (!cb.matches || !cb.matches('input[type="checkbox"]')) return;
    const boxIn = (wrap) => wrap.querySelector(`input[type="checkbox"][value="${CSS.escape(cb.value)}"]`);
    if (cb.checked) {
      if (adminBoxes.contains(cb)) { const ed = boxIn(editBoxes); if (ed) ed.checked = true; const se = boxIn(seeBoxes); if (se) se.checked = true; }
      if (editBoxes.contains(cb)) { const se = boxIn(seeBoxes); if (se) se.checked = true; }
    } else {
      if (seeBoxes.contains(cb)) { const ed = boxIn(editBoxes); if (ed) ed.checked = false; const ad = boxIn(adminBoxes); if (ad) ad.checked = false; }
      if (editBoxes.contains(cb)) { const ad = boxIn(adminBoxes); if (ad) ad.checked = false; }
    }
  });

  row.querySelector('[data-field="mode"]').addEventListener("change", (e) => {
    const isGroups = e.target.value === "groups";
    row.querySelector('[data-field="groupIds"]').style.display = isGroups ? "block" : "none";
    if (isGroups) row.querySelector(".visibility-groups").open = true;
  });

  // „Sensibel"-Häkchen: beim Umschalten den aktuellen Panel-Stand einsammeln (damit andere
  // offene Änderungen erhalten bleiben) und die Sektionen neu aufbauen, sodass das Tool
  // sofort in die richtige Liste (Sensible / Weitere) wandert. Persistiert wird erst beim
  // Speichern (save-visibility).
  row.querySelector('[data-field="kritisch"]').addEventListener("change", () => {
    visibilityState = collectVisibilityTools();
    renderVisibilityList();
  });
  return row;
}

// Liest den aktuellen Stand aller Sichtbarkeits-Zeilen aus dem DOM in ein tools-Objekt
// (gleiches Format wie visibilityState / save-visibility). Von Sensibel-Toggle UND
// Speichern-Button genutzt, damit beide identisch einsammeln.
function collectVisibilityTools() {
  const tools = {};
  document.querySelectorAll("#visibility-list .visibility-row").forEach((row) => {
    const id = row.dataset.toolId;
    const mode = row.querySelector('[data-field="mode"]').value;
    const groupIds = mode === "groups" ? getCheckedValues(row.querySelector('[data-field="groupIds"]')) : [];
    const editGroupIds = getCheckedValues(row.querySelector('[data-field="editGroupIds"]'));
    const adminGroupIds = getCheckedValues(row.querySelector('[data-field="adminGroupIds"]'));
    const visible = mode !== "hidden";
    const loginRequired = mode === "loggedin" || mode === "groups";
    // provisionGroupIds nur im Gruppen-Tab gepflegt — hier unverändert aus dem State übernehmen.
    const provisionGroupIds = (visibilityState[id] && visibilityState[id].provisionGroupIds) || [];
    const kritischBox = row.querySelector('[data-field="kritisch"]');
    const kritisch = !!(kritischBox && kritischBox.checked);
    tools[id] = { visible, loginRequired, groupIds, editGroupIds, adminGroupIds, provisionGroupIds, kritisch };
  });
  return tools;
}

function renderVisibilityList() {
  const container = document.getElementById("visibility-list");
  container.innerHTML = "";
  const alle = TOOLS.concat(VIRTUAL_VISIBILITY_ENTRIES);
  const kritische = alle.filter((t) => isKritischesTool(t.id));
  const normale = alle.filter((t) => !isKritischesTool(t.id));

  // Kritische Tools zuerst, in einer benannten, aufklappbaren Sektion (offen per
  // Default, damit die Warn-Badges sofort sichtbar sind). Baustein 4. Der Save nutzt
  // "#visibility-list .visibility-row" als Nachfahren-Selektor und erfasst die Zeilen
  // in dieser Sektion damit unverändert mit.
  if (kritische.length) {
    const section = document.createElement("details");
    section.className = "kritisch-section";
    section.open = false; // Standard: zugeklappt (Michel-Vorgabe 2026-07-24)
    const summary = document.createElement("summary");
    summary.innerHTML = `⚠️ Sensible Tools — Rechte besonders sorgfältig vergeben <span class="ks-count">${kritische.length}</span>`;
    section.appendChild(summary);
    kritische.forEach((t) => section.appendChild(buildVisibilityRow(t)));
    container.appendChild(section);
  }
  // Übrige (nicht-kritische) Tools ebenfalls in einer benannten, aufklappbaren
  // Sektion — neutrales Gegenstück ohne Warn-Style. Offen per Default, damit initial
  // nichts versteckt wirkt; der Admin kann sie zuklappen, um die Sensible-Sektion in
  // den Vordergrund zu rücken. Die Zeilen bleiben Nachfahren von #visibility-list,
  // der Save-Selektor "#visibility-list .visibility-row" greift sie unverändert mit.
  if (normale.length) {
    const section = document.createElement("details");
    section.className = "weitere-section";
    section.open = false; // Standard: zugeklappt (Michel-Vorgabe 2026-07-24)
    const summary = document.createElement("summary");
    summary.innerHTML = `Weitere Tools <span class="ws-count">${normale.length}</span>`;
    section.appendChild(summary);
    normale.forEach((t) => section.appendChild(buildVisibilityRow(t)));
    container.appendChild(section);
  }
}

function renderChangelog() {
  const container = document.getElementById("changelog-list");
  container.innerHTML = APP_CHANGELOG.map((entry) => `
    <div class="changelog-entry">
      <span class="cv">v${entry.version}</span>
      ${entry.groups.map((g) => `
        <div class="changelog-group">
          <div class="cg-title">${escapeHtml(g.title)}</div>
          <ul class="cg-items">${g.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
        </div>
      `).join("")}
    </div>
  `).join("");
}

const NEWS_TYPE_LABELS = { neu: "Neu", update: "Update", fix: "Fix", hinweis: "Hinweis" };
const NEWS_MAX_TOTAL = 5; // insgesamt max. per Pfeil erreichbare Meldungen

// Index der aktuell im Karussell sichtbaren Meldung (0 = neueste). Rechter Pfeil
// erhöht ihn (→ ältere Meldung), linker Pfeil verringert ihn (→ neuere Meldung).
let newsCarouselIndex = 0;

function toolById(id) {
  return TOOLS.find((t) => t.id === id) || null;
}

// Neuigkeiten nach einer An- oder Abmeldung nachziehen. Sie kommen nur noch mit
// gueltigem Token vom Server, ein frisch Angemeldeter saehe sonst bis zum naechsten
// Seitenaufruf ein leeres Karussell -- und nach dem Abmelden bliebe der zuletzt
// geladene Stand im Speicher stehen. Uebernommen werden NUR die News-Felder: die
// Tool-Sichtbarkeit ist oeffentlich, steht seit init() und haengt nicht am Login.
async function refreshNews() {
  if (!currentUser) {
    newsState = [];
    newsReactionCounts = {};
    newsReactionNames = {};
    renderNews();
    return;
  }
  const data = await fetchVisibility();
  newsState = (data && Array.isArray(data.news)) ? data.news : [];
  newsReactionCounts = (data && data.newsReactions && typeof data.newsReactions === "object") ? data.newsReactions : {};
  newsReactionNames = (data && data.newsReactionNames && typeof data.newsReactionNames === "object") ? data.newsReactionNames : {};
  renderNews();
}

function formatNewsDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || "");
}

function renderNews() {
  const banner = document.getElementById("news-banner");
  if (!banner) return;
  // Neuigkeiten sind Vereinsinterna und gehen nicht an nicht angemeldete Besucher.
  // Der Worker liefert sie ihnen seit 2026-07-25 gar nicht mehr aus (news: null) --
  // dieser Guard haelt das Karussell zusaetzlich zu, solange noch ein Seed aus
  // config.js oder ein Stand von vor dem Abmelden im newsState steht.
  if (!currentUser) {
    // innerHTML mitleeren, nicht nur display:none: der zuletzt geladene Meldungstext
    // bliebe sonst nach dem Abmelden im DOM stehen und waere dort weiter lesbar.
    banner.innerHTML = "";
    banner.style.display = "none";
    // Aus demselben Grund die geladenen Bilder freigeben: eine Objekt-URL bleibt
    // sonst gueltig, solange die Seite offen ist -- auch nach dem Abmelden.
    newsMedienBlobsLeeren();
    return;
  }
  const items = newsState.slice()
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, NEWS_MAX_TOTAL);
  if (items.length === 0) {
    banner.innerHTML = ""; // wie oben: nichts Altes im DOM stehen lassen
    banner.style.display = "none";
    return;
  }
  banner.style.display = "block";
  if (newsCarouselIndex < 0 || newsCarouselIndex >= items.length) newsCarouselIndex = 0;

  const n = items[newsCarouselIndex];
  const tool = n.toolId ? toolById(n.toolId) : null;
  const type = String(n.type || "");
  const badge = type
    ? `<span class="news-badge news-badge-${escapeHtml(type)}">${escapeHtml(NEWS_TYPE_LABELS[type] || type)}</span>`
    : "";
  const date = n.date ? `<span class="news-date">${escapeHtml(formatNewsDate(n.date))}</span>` : "";
  const link = tool ? `<span class="news-item-link">${escapeHtml(tool.name)} öffnen →</span>` : "";
  const inner = `
    <div class="news-item-head">${badge}${date}</div>
    <div class="news-item-title">${escapeHtml(n.title || "")}</div>
    ${n.text ? `<div class="news-item-text">${escapeHtml(n.text)}</div>` : ""}
    ${link}
  `;
  const itemHtml = tool
    ? `<a class="news-item" href="${escapeHtml(tool.url)}">${inner}</a>`
    : `<div class="news-item">${inner}</div>`;

  const atNewest = newsCarouselIndex === 0;
  const atOldest = newsCarouselIndex === items.length - 1;

  banner.innerHTML = `
    <div class="news-head"><h2>📣 Neuigkeiten</h2></div>
    <div class="news-carousel">
      <button type="button" class="news-nav-btn news-nav-prev" ${atNewest ? "disabled" : ""} title="Neuere Meldung" aria-label="Neuere Meldung">‹</button>
      <div class="news-carousel-item">${itemHtml}</div>
      <button type="button" class="news-nav-btn news-nav-next" ${atOldest ? "disabled" : ""} title="Ältere Meldung" aria-label="Ältere Meldung">›</button>
    </div>
    ${items.length > 1 ? `<div class="news-dots">${newsCarouselIndex + 1} / ${items.length}</div>` : ""}
    ${newsMedienStreifen(n)}
    ${renderNewsReactionsBar(n.id)}
    ${newsReactionHint ? `<div class="news-react-hint">${escapeHtml(newsReactionHint)}</div>` : ""}
  `;

  newsMedienThumbsBeleben(banner, n);

  const prevBtn = banner.querySelector(".news-nav-prev");
  const nextBtn = banner.querySelector(".news-nav-next");
  if (prevBtn) prevBtn.addEventListener("click", () => { newsCarouselIndex = Math.max(0, newsCarouselIndex - 1); renderNews(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { newsCarouselIndex = Math.min(items.length - 1, newsCarouselIndex + 1); renderNews(); });
  banner.querySelectorAll(".news-react-btn").forEach((b) => {
    b.addEventListener("click", () => toggleNewsReaction(n.id, b.dataset.emoji));
    // focus/blur zusätzlich zu mouseenter/mouseleave: sonst erreicht die Namensliste
    // nur, wer eine Maus hat. Am Touchgerät gibt es kein Hover — dort bleibt es beim
    // Zähler (gleiche Lage wie beim ✉-Kennzeichen auf den Kacheln).
    b.addEventListener("mouseenter", () => newsReaktionNamenZeigen(b, n.id, b.dataset.emoji));
    b.addEventListener("focus", () => newsReaktionNamenZeigen(b, n.id, b.dataset.emoji));
    b.addEventListener("mouseleave", newsReaktionNamenVerbergen);
    b.addEventListener("blur", newsReaktionNamenVerbergen);
  });
}

// Reaktionsleiste unter der aktuell sichtbaren Karussell-Meldung: die feste Emoji-Liste
// aus config.js als Buttons, jeweils mit Zähler (0 wird ausgeblendet). Die eigene Wahl
// ist hervorgehoben (.active). Auch ohne Login sichtbar — der Klick-Handler entscheidet
// dann, ob reagiert wird oder der Anmelde-Hinweis erscheint.
//
// Das title-Attribut trägt nur noch die Klick-Erklärung von Knöpfen OHNE Reaktion.
// Sobald jemand reagiert hat, übernimmt das eigene Tooltip (#news-react-namen) — sonst
// poppte der native Tooltip nach ~1 s zusätzlich auf und legte sich über die Namen.
// Für Screenreader steht beides im aria-label, das nie doppelt angezeigt wird.
function renderNewsReactionsBar(newsId) {
  if (!newsId || typeof NEWS_REACTION_EMOJIS === "undefined") return "";
  const counts = newsReactionCounts[newsId] || {};
  const namen = newsReactionNames[newsId] || {};
  const mine = newsReactionMine[newsId] || null;
  const btns = NEWS_REACTION_EMOJIS.map((emoji) => {
    const c = counts[emoji] || 0;
    const active = mine === emoji;
    const liste = Array.isArray(namen[emoji]) ? namen[emoji] : [];
    const klickHinweis = active ? "Deine Reaktion — nochmal klicken zum Entfernen" : "Mit diesem Emoji reagieren";
    const ariaLabel = liste.length ? `${emoji} — ${liste.join(", ")}. ${klickHinweis}` : `${emoji} — ${klickHinweis}`;
    return `<button type="button" class="news-react-btn${active ? " active" : ""}" data-emoji="${escapeHtml(emoji)}"`
      + ` aria-pressed="${active ? "true" : "false"}" aria-label="${escapeHtml(ariaLabel)}"`
      + (liste.length ? "" : ` title="${escapeHtml(klickHinweis)}"`) + `>`
      + `<span class="news-react-emoji">${emoji}</span>`
      + (c > 0 ? `<span class="news-react-count">${c}</span>` : "")
      + `</button>`;
  }).join("");
  // Ein einziges Tooltip-Element für die ganze Leiste, absolut positioniert und beim
  // Überfahren befüllt: an jedem Knopf ein eigenes hätte zehn Boxen im DOM und die
  // äußeren wären am Handy seitlich aus der Karte gelaufen.
  return `<div class="news-reactions">${btns}<div class="news-react-namen" id="news-react-namen" hidden></div></div>`;
}

// Namen der Reagierenden über dem überfahrenen Knopf einblenden. Bewusst nicht als
// CSS-::after mit attr(): die Box wird an der Position des Knopfes ausgerichtet und
// dabei am Rand der Leiste geklemmt — ohne das Klemmen liefe sie beim letzten Emoji
// aus der Karte heraus und die ganze Seite bekäme einen seitlichen Überlauf.
const NEWS_REACT_NAMEN_MAX = 12; // darüber wird gekürzt, sonst überdeckt der Tooltip die halbe Meldung

function newsReaktionNamenZeigen(btn, newsId, emoji) {
  const box = document.getElementById("news-react-namen");
  const leiste = box && box.parentElement;
  if (!box || !leiste) return;
  const liste = (newsReactionNames[newsId] && newsReactionNames[newsId][emoji]) || [];
  if (!liste.length) { newsReaktionNamenVerbergen(); return; }
  const sichtbar = liste.slice(0, NEWS_REACT_NAMEN_MAX);
  const rest = liste.length - sichtbar.length;
  const eigene = newsReactionMine[newsId] === emoji;
  box.innerHTML = `<div class="news-react-namen-liste">${sichtbar.map((nm) => escapeHtml(nm)).join("<br>")}`
    + (rest > 0 ? `<br>… und ${rest} weitere` : "")
    + `</div>`
    + (eigene ? `<div class="news-react-namen-hinweis">Nochmal klicken, um deine Reaktion zu entfernen</div>` : "");
  box.hidden = false;
  // Erst nach dem Einblenden messen — versteckt ist offsetWidth 0.
  const maxLinks = Math.max(0, leiste.clientWidth - box.offsetWidth);
  box.style.left = Math.max(0, Math.min(btn.offsetLeft, maxLinks)) + "px";
}

function newsReaktionNamenVerbergen() {
  const box = document.getElementById("news-react-namen");
  if (!box) return;
  box.hidden = true;
  box.innerHTML = ""; // nicht nur ausblenden: sonst stehen die Namen weiter im DOM
}

// Aktualisiert Zähler + eigene Wahl im Speicher rein lokal (optimistisch), genau nach
// der Server-Semantik: gleiches Emoji -> weg, anderes -> wechselt. Der Server liefert
// gleich darauf die maßgeblichen Zähler zurück (siehe toggleNewsReaction).
function applyLocalReaction(newsId, prevEmoji, clickedEmoji) {
  const counts = { ...(newsReactionCounts[newsId] || {}) };
  // Die Namensliste muss mitwandern, sonst zeigt der Tooltip direkt nach dem eigenen
  // Klick noch den alten Stand. Sortiert wie der Server (localeCompare "de"), damit
  // der eigene Name beim Eintreffen der Antwort nicht an eine andere Stelle springt.
  const namen = { ...(newsReactionNames[newsId] || {}) };
  const ich = currentUser
    ? ([currentUser.vorname, currentUser.nachname].filter(Boolean).join(" ") || currentUser.username)
    : "";
  const dec = (e) => { counts[e] = Math.max(0, (counts[e] || 0) - 1); if (!counts[e]) delete counts[e]; };
  const nameRaus = (e) => {
    const rest = (namen[e] || []).filter((x) => x !== ich);
    if (rest.length) namen[e] = rest; else delete namen[e];
  };
  const nameRein = (e) => {
    namen[e] = [...(namen[e] || []).filter((x) => x !== ich), ich].sort((a, b) => a.localeCompare(b, "de"));
  };
  if (prevEmoji === clickedEmoji) {
    dec(clickedEmoji);
    if (ich) nameRaus(clickedEmoji);
    delete newsReactionMine[newsId];
  } else {
    if (prevEmoji) dec(prevEmoji);
    if (prevEmoji && ich) nameRaus(prevEmoji);
    counts[clickedEmoji] = (counts[clickedEmoji] || 0) + 1;
    if (ich) nameRein(clickedEmoji);
    newsReactionMine[newsId] = clickedEmoji;
  }
  newsReactionCounts[newsId] = counts;
  newsReactionNames[newsId] = namen;
}

async function toggleNewsReaction(newsId, emoji) {
  if (!newsId || !emoji) return;
  if (!currentUser) { flashNewsReactionHint("Zum Reagieren bitte anmelden."); return; }
  const prevMine = newsReactionMine[newsId] || null;
  const prevCounts = { ...(newsReactionCounts[newsId] || {}) };
  const prevNamen = { ...(newsReactionNames[newsId] || {}) };
  applyLocalReaction(newsId, prevMine, emoji); // sofortiges Feedback
  renderNews();
  try {
    const res = await callWorker("toggle-news-reaction", { newsId, emoji });
    newsReactionCounts[newsId] = (res && res.counts) || {};
    // namen ist seit 2026-08-01 additiv dabei; fehlt es (alter Worker), bleibt die
    // optimistisch gepflegte Liste stehen statt sie leer zu räumen.
    if (res && res.namen && typeof res.namen === "object") newsReactionNames[newsId] = res.namen;
    if (res && res.mine) newsReactionMine[newsId] = res.mine;
    else delete newsReactionMine[newsId];
    renderNews();
  } catch (err) {
    newsReactionCounts[newsId] = prevCounts; // Rollback
    newsReactionNames[newsId] = prevNamen;
    if (prevMine) newsReactionMine[newsId] = prevMine; else delete newsReactionMine[newsId];
    renderNews();
    flashNewsReactionHint(err.message || "Reaktion konnte nicht gespeichert werden.");
  }
}

// Holt die eigenen Reaktionen (nur eingeloggt) und rendert das Karussell neu, damit die
// eigene Wahl hervorgehoben ist. Ohne Login werden die eigenen Markierungen geleert.
async function refreshMyNewsReactions() {
  if (!currentUser) { newsReactionMine = {}; renderNews(); return; }
  try {
    const res = await callWorker("my-news-reactions", {});
    newsReactionMine = (res && res.mine && typeof res.mine === "object") ? res.mine : {};
  } catch (_) {
    newsReactionMine = {}; // Fehler nicht hart melden — die Zähler stehen ja trotzdem
  }
  renderNews();
}

function flashNewsReactionHint(msg) {
  newsReactionHint = msg;
  renderNews();
  if (_newsReactionHintTimer) clearTimeout(_newsReactionHintTimer);
  _newsReactionHintTimer = setTimeout(() => { newsReactionHint = ""; renderNews(); }, 3000);
}

// ---- Sidebar-Widget: nächste Termine + Abwesenheiten links neben den Kacheln ----
// Nutzt dieselbe Sichtbarkeitsregel wie die Tool-Karte (isVisibleToUser) und
// dieselbe Gateway-Aktion (dav-load) wie die jeweilige App selbst. Einziger
// Schreibweg ist das Abstimmen bei Umfrage-Terminen -- dafür wird die BESTEHENDE
// Aktion `vereinskalender-vote` mitbenutzt (siehe calendarWidgetVote), kein
// eigener Worker-Code. Kalender- und Abwesenheiten-Teil sind
// UNABHÄNGIG voneinander sichtbar (unterschiedliche Apps, unterschiedliche
// Sichtbarkeits-Gruppen) — ein Nutzer mit nur einer der beiden Berechtigungen
// sieht trotzdem den für ihn zutreffenden Teil, siehe loadSidebarWidget.
const CALENDAR_WIDGET_APP_ID = "vereinskalender";
const CALENDAR_WIDGET_COUNT = 8;
const ABSENCE_WIDGET_APP_ID = "abwesenheitskalender";
const ABSENCE_WIDGET_COUNT = 4;
// Ablaufplan: bewusst NUR der naechste Ablauf und bewusst NUR EINE Zeile
// (Michel-Entscheidung 2026-08-12). Jeder Punkt einzeln haette die acht Zeilen
// des Kalenders allein vom Medientag gefuellt und die echten Termine verdraengt.
const ABLAUF_WIDGET_APP_ID = "ablaufplan";
// Zuletzt gerenderter Widget-Zustand -- Grundlage fürs Neu-Rendern nach einer
// abgegebenen Stimme (siehe onCalendarWidgetClick).
let calendarWidgetOpts = null;

function absenceSortKey(a) { return `${a.von}_${a.bis}`; }

// Kompakte Zeitraum-Anzeige ohne Jahr (analog formatCalendarDate) -- "17.–20.08."
// bzw. "28.02.–02.03." bzw. nur "17.08." bei eintägiger Abwesenheit (von===bis).
function formatAbsenceRange(von, bis) {
  const mv = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(von || ""));
  const mb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(bis || ""));
  if (!mv) return "";
  if (!mb || bis === von) return `${mv[3]}.${mv[2]}.`;
  if (mv[2] === mb[2]) return `${mv[3]}.–${mb[3]}.${mv[2]}.`;
  return `${mv[3]}.${mv[2]}.–${mb[3]}.${mb[2]}.`;
}

function absencePersonName(a) {
  return (a.vorname || a.nachname) ? `${a.vorname || ""} ${a.nachname || ""}`.trim() : (a.erstelltVon || "Unbekannt");
}

function calendarTerminEndIso(t) {
  return t.endDatum && /^\d{4}-\d{2}-\d{2}$/.test(t.endDatum) && t.endDatum >= t.datum ? t.endDatum : t.datum;
}

// Spiegelt terminVisibleFor() aus der Vereinskalender-App selbst: private Termine
// (seit 1.6) sieht nur der Ersteller, explizit geteilte Nutzer/Gruppen sowie
// Admins. Ohne diesen Filter würde das Widget private Termine ALLER Nutzer an
// jeden eingeloggten Nutzer mit Vereinskalender-Zugriff ausliefern.
function calendarTerminVisibleFor(t, user) {
  if (!t.privat) return true;
  if (!user) return false;
  if (user.isAdmin) return true;
  if (t.ersteller && t.ersteller === user.username) return true;
  if (Array.isArray(t.geteiltUsers) && t.geteiltUsers.includes(user.username)) return true;
  if (Array.isArray(t.geteiltGruppen) && Array.isArray(user.groupIds) &&
      t.geteiltGruppen.some((g) => user.groupIds.includes(g))) return true;
  return false;
}

// Ein Termin ergibt normalerweise genau eine Widget-Zeile. Bei einer aktiven
// Umfrage (Vereinskalender 1.6: t.umfrage.termine = mehrere Terminvorschläge)
// bekommt JEDER noch nicht vergangene Vorschlag eine eigene Zeile -- vorher
// stand hier nur t.datum, das beim Speichern automatisch auf den FRÜHESTEN
// Vorschlag gesetzt wird, sodass alle weiteren Möglichkeiten im Dashboard
// komplett fehlten. Bleibt kein gültiger künftiger Vorschlag übrig (leere oder
// fehlerhafte Liste), fällt die Funktion auf die eine t.datum-Zeile zurück --
// damit ist sie nie schlechter als der Stand vor der Erweiterung.
function calendarWidgetRows(t, today) {
  const rows = [];
  const u = t.umfrage;
  if (u && u.aktiv && Array.isArray(u.termine)) {
    const gesehen = [];
    for (let i = 0; i < u.termine.length; i++) {
      const d = u.termine[i] && u.termine[i].datum;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "") || d < today) continue;
      const zeit = u.termine[i].startZeit || "";
      const key = d + "|" + zeit;
      if (gesehen.indexOf(key) !== -1) continue;
      gesehen.push(key);
      rows.push({ termin: t, datum: d, zeit: zeit, candId: u.termine[i].id || "" });
    }
  }
  return rows.length ? rows : [{ termin: t, datum: t.datum, zeit: "", candId: "" }];
}

// Zählt Zu-/Absagen für einen Terminvorschlag und findet die eigene Stimme --
// spiegelt umfrageHtml() aus der Vereinskalender-App. Wer das hier ändert,
// sollte dort nachsehen, damit Widget und App dieselben Zahlen zeigen.
function calendarVoteCounts(t, candId, username) {
  const stimmen = (t.umfrage && t.umfrage.stimmen && typeof t.umfrage.stimmen === "object") ? t.umfrage.stimmen : {};
  let ja = 0, nein = 0, meins = null;
  Object.keys(stimmen).forEach((user) => {
    const votes = stimmen[user];
    const v = (votes && typeof votes === "object") ? votes[candId] : null;
    if (v === "ja") ja++; else if (v === "nein") nein++;
    if (user === username) meins = (v === "ja" || v === "nein") ? v : null;
  });
  return { ja: ja, nein: nein, meins: meins };
}

// Sortiert nach dem Datum DER ZEILE. Die Uhrzeit kommt bei Umfrage-Vorschlägen
// aus dem Vorschlag selbst (Vereinskalender 1.2: startZeit je Terminvorschlag) --
// der Termin darüber ist bei Umfragen immer ganztags, seine startZeit wäre also
// nutzlos. Zwei Vorschläge am selben Tag zu verschiedenen Zeiten stehen dadurch
// in der richtigen Reihenfolge.
function calendarSortKey(row) {
  const t = row.termin;
  return `${row.datum}T${row.zeit || (t.ganztags ? "" : t.startZeit) || "00:00"}`;
}

function formatCalendarDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? `${m[3]}.${m[2]}.` : "";
}

// Das Widget hängt jetzt außerhalb von #tab-uebersicht (siehe index.html:
// .page-body bricht bewusst aus main heraus, damit es ganz links am
// Fensterrand steht statt nur am linken Rand des zentrierten Inhalts) und
// wird deshalb nicht mehr automatisch über die tab-section mitversteckt.
// dataset.hasContent hält fest, ob überhaupt Inhalt da ist; die tatsächliche
// Sichtbarkeit ergibt sich erst in Kombination mit dem aktiven Tab (siehe
// activateTab) — sonst würde es auch im Einstellungen-Tab durchscheinen.
function isUebersichtTabActive() {
  const section = document.getElementById("tab-uebersicht");
  return !!(section && section.classList.contains("active"));
}

// Die linke Spalte trägt nur noch die Termine — die Aufgabenkarte ist am
// 2026-07-28 auf Michels Wunsch in ein Kopf-Fenster gezogen (seit 2026-07-29
// "Meine ToDos"). Sichtbar ist die Spalte also genau dann, wenn Termine da sind.
function updateSidebarSichtbarkeit() {
  const widget = document.getElementById("calendar-widget");
  if (!widget) return;
  const el = document.getElementById("termine-widget-inhalt");
  const hatInhalt = !!(el && el.innerHTML.trim());
  widget.dataset.hasContent = hatInhalt ? "1" : "0";
  widget.style.display = (hatInhalt && isUebersichtTabActive()) ? "block" : "none";
}

// Am Handy stapelt sich .page-body zu einer Spalte — das Widget stünde dort als
// erstes Kind ÜBER den Neuigkeiten. Gewollt ist Neuigkeiten → Termine → Kacheln.
// Per CSS allein geht das nicht: das Neuigkeiten-Banner steckt in <main>, das
// Widget daneben, und `order` greift nur unter Geschwistern. Deshalb wandert das
// Widget unterhalb der Umbruchbreite in den Übersicht-Tab zwischen Banner und
// Kacheln und oberhalb zurück an seinen Platz links neben <main>. Der Umzug ist
// gefahrlos: alle Zugriffe laufen über getElementById, und der Klick-Handler für
// die Umfrage-Knöpfe hängt am Element selbst, überlebt also das Verschieben.
const SIDEBAR_MOBILE_BREAKPOINT = "(max-width: 860px)";

function placeSidebarWidget() {
  const widget = document.getElementById("calendar-widget");
  const pageBody = document.querySelector(".page-body");
  const mainEl = pageBody ? pageBody.querySelector("main") : null;
  const toolGroups = document.getElementById("tool-groups");
  if (!widget || !pageBody || !mainEl || !toolGroups) return;
  const mobil = window.matchMedia(SIDEBAR_MOBILE_BREAKPOINT).matches;
  const ziel = mobil ? toolGroups.parentNode : pageBody;
  // Am Handy VOR die Ansicht-Leiste, nicht erst vor die Kacheln: die Leiste gehoert zu
  // den Kacheln, das Widget schoebe sich sonst zwischen Umschalter und Raster.
  const ansichtLeiste = document.getElementById("ansicht-leiste");
  const davor = mobil ? ((ansichtLeiste && ansichtLeiste.parentNode === ziel) ? ansichtLeiste : toolGroups) : mainEl;
  // Nur umhängen, wenn es nicht ohnehin schon richtig steht — ein insertBefore auf
  // die eigene Position nimmt das Element aus dem DOM und fügt es neu ein.
  if (widget.parentNode === ziel && widget.nextElementSibling === davor) return;
  ziel.insertBefore(widget, davor);
}

function setupSidebarWidgetPlacement() {
  placeSidebarWidget();
  // Bewusst am resize-Event statt am change-Event der MediaQueryList: letzteres
  // gibt es als addEventListener erst ab iOS 14, und im Test ist es beim
  // Umschalten der Fenstergröße nicht zuverlässig gefeuert. placeSidebarWidget()
  // steigt früh aus, wenn das Widget schon richtig steht — häufige resize-Events
  // (Ausklappen der Adressleiste am Handy, Drehen) kosten deshalb nichts.
  window.addEventListener("resize", placeSidebarWidget);
}

// Liefert die Namen aller Trainer, die laut Trainerdaten HEUTE Geburtstag haben
// (list-birthdays-today, siehe admin-worker.js) -- kein Geburtsjahr, keine
// anderen Felder. Scheitert die Abfrage, wird das Widget dadurch NICHT
// ausgeblendet (anders als ein Fehler bei dav-load) -- Geburtstage sind reine
// Zusatzinfo, kein Grund die Termine selbst zu verstecken.
async function loadBirthdaysToday() {
  try {
    const res = await callWorker("list-birthdays-today", {});
    return Array.isArray(res && res.namen) ? res.namen : [];
  } catch (e) {
    console.warn("Geburtstage nicht ladbar:", e);
    return [];
  }
}

// Lädt den Ampel-Status für die Trainerdaten-Kachel (my-trainerdaten-status,
// siehe admin-worker.js) — analog loadBirthdaysToday: Fehler werden geschluckt
// (Badge verschwindet dann einfach statt die Kachel zu blockieren). Der Server
// entscheidet per trainerdatenGesamtOk===null, ob überhaupt ein Badge kommt (kein
// Trainerdaten-Datensatz UND nicht vertragspflichtig, z.B. ein Nutzer ohne
// Trainerrolle) -- NICHT mehr res.vorhanden allein: eine vertragspflichtige Person
// ohne jeden Datensatz soll trotzdem ein rotes "Daten unvollständig" sehen statt
// gar nichts (seit 2026-07-14, siehe admin-worker.js).
async function loadTrainerdatenStatus() {
  _trainerdatenStatusLastFetch = Date.now();
  if (!currentUser || !isVisibleToUser("trainerdaten", currentUser)) {
    trainerdatenStatus = null;
    return;
  }
  try {
    const res = await callWorker("my-trainerdaten-status", {});
    trainerdatenStatus = (res && res.trainerdatenGesamtOk !== null) ? res : null;
  } catch (e) {
    console.warn("Trainerdaten-Status nicht ladbar:", e);
    trainerdatenStatus = null;
  }
  renderToolGrid();
}

// Badge "Gegner eintragen" auf der Testspielplaner-Kachel (my-testspielplaner-status,
// siehe admin-worker.js) — gleiches Muster wie loadTrainerdatenStatus: Fehler werden
// geschluckt (z.B. "Unbekannte Aktion" vor dem Worker-Redeploy -> einfach kein Badge).
async function loadTestspielplanerStatus() {
  _testspielplanerStatusLastFetch = Date.now();
  if (!currentUser || !isVisibleToUser("testspielplaner", currentUser)) {
    testspielplanerStatus = null;
    return;
  }
  try {
    const res = await callWorker("my-testspielplaner-status", {});
    testspielplanerStatus = (res && res.anstehendOhneGegner > 0) ? res : null;
  } catch (e) {
    console.warn("Testspielplaner-Status nicht ladbar:", e);
    testspielplanerStatus = null;
  }
  renderToolGrid();
}

async function loadSidebarWidget() {
  const widget = document.getElementById("calendar-widget");
  if (!widget) return;

  const termineEl = document.getElementById("termine-widget-inhalt");
  if (!termineEl) return;

  const showCalendar = !!currentUser && isVisibleToUser(CALENDAR_WIDGET_APP_ID, currentUser);
  const showAbsences = !!currentUser && isVisibleToUser(ABSENCE_WIDGET_APP_ID, currentUser);
  const showAblauf = !!currentUser && isVisibleToUser(ABLAUF_WIDGET_APP_ID, currentUser);
  if (!showCalendar && !showAbsences && !showAblauf) {
    termineEl.innerHTML = "";
    updateSidebarSichtbarkeit();
    return;
  }

  let oeffentlich = [], privat = [], kategorien = [], geburtstage = [];
  let absences = [], absenceKategorien = [];
  let naechsterAblauf = null;
  let calendarFailed = false, absenceFailed = false, ablaufFailed = false;

  const calendarPromise = showCalendar
    // hintergrund: dieses dav-load laeuft beim Seitenaufbau von selbst, der Nutzer
    // hat den Vereinskalender NICHT geoeffnet -- ohne die Marke buchte ihm die
    // Punktezaehlung eine Tool-Nutzung, die nie stattgefunden hat. Wer die App
    // wirklich oeffnet, schickt sein dav-load aus dem eigenen Repo, ohne Marke.
    ? Promise.all([callWorker("dav-load", { app: CALENDAR_WIDGET_APP_ID, hintergrund: true }), loadBirthdaysToday()])
        .then(([res, namen]) => {
          const data = res && res.data && typeof res.data === "object" ? res.data : {};
          const termine = Array.isArray(data.termine) ? data.termine : [];
          kategorien = Array.isArray(data.kategorien) ? data.kategorien : [];
          const today = new Date().toISOString().slice(0, 10);
          // Ab hier wird in ZEILEN gerechnet, nicht mehr in Terminen: ein Termin
          // mit aktiver Umfrage liefert eine Zeile je künftigem Terminvorschlag
          // (siehe calendarWidgetRows). CALENDAR_WIDGET_COUNT begrenzt daher die
          // Zeilen, nicht die Termine.
          const upcoming = [];
          termine
            .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.datum || "") && calendarTerminEndIso(t) >= today)
            .filter((t) => calendarTerminVisibleFor(t, currentUser))
            .forEach((t) => { calendarWidgetRows(t, today).forEach((row) => upcoming.push(row)); });
          upcoming.sort((a, b) => calendarSortKey(a).localeCompare(calendarSortKey(b)));
          oeffentlich = upcoming.filter((row) => !row.termin.privat).slice(0, CALENDAR_WIDGET_COUNT);
          privat = upcoming.filter((row) => row.termin.privat).slice(0, CALENDAR_WIDGET_COUNT);
          geburtstage = namen;
        })
        .catch((e) => { console.warn("Vereinskalender-Widget nicht ladbar:", e); calendarFailed = true; })
    : Promise.resolve();

  const absencePromise = showAbsences
    // hintergrund: siehe Kalender-Widget darueber, gleicher Grund.
    ? callWorker("dav-load", { app: ABSENCE_WIDGET_APP_ID, hintergrund: true })
        .then((res) => {
          const data = res && res.data && typeof res.data === "object" ? res.data : {};
          const abwesenheiten = Array.isArray(data.abwesenheiten) ? data.abwesenheiten : [];
          absenceKategorien = Array.isArray(data.kategorien) ? data.kategorien : [];
          const today = new Date().toISOString().slice(0, 10);
          absences = abwesenheiten
            .filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.bis || "") && a.bis >= today)
            .sort((a, b) => absenceSortKey(a).localeCompare(absenceSortKey(b)))
            .slice(0, ABSENCE_WIDGET_COUNT);
        })
        .catch((e) => { console.warn("Abwesenheitskalender-Widget nicht ladbar:", e); absenceFailed = true; })
    : Promise.resolve();

  const ablaufPromise = showAblauf
    // hintergrund: siehe Kalender-Widget darueber, gleicher Grund -- ohne die
    // Marke buchte die Punktezaehlung eine Nutzung des Ablaufplans, die nie
    // stattgefunden hat (genau der Fehler vom 2026-08-04).
    ? callWorker("dav-load", { app: ABLAUF_WIDGET_APP_ID, hintergrund: true })
        .then((res) => {
          const data = res && res.data && typeof res.data === "object" ? res.data : {};
          const ablaeufe = Array.isArray(data.ablaeufe) ? data.ablaeufe : [];
          // ⚠️ Bewusst NICHT toISOString().slice(0,10) wie zwei Bloecke weiter
          // oben: das rechnet in UTC und liefert in deutscher Sommerzeit vor
          // 02:00 Uhr den VORTAG -- ein gestern beendeter Ablauf haenge dann
          // noch zwei Stunden auf der Startseite. Gleiche Regel wie
          // isoAusDatum() in E:\ablaufplan\zeitlogik.js.
          const jetzt = new Date();
          const today = jetzt.getFullYear() + "-" +
            String(jetzt.getMonth() + 1).padStart(2, "0") + "-" +
            String(jetzt.getDate()).padStart(2, "0");
          // Ein Ablauf zaehlt bis zum Ende seines LETZTEN Tages -- am Medientag
          // selbst soll er nicht schon aus der Startseite fallen. Gleiche Regel
          // wie istVergangen() in E:\ablaufplan\zeitlogik.js.
          naechsterAblauf = ablaeufe
            .filter((a) => a && /^\d{4}-\d{2}-\d{2}$/.test(String(a.startDatum || "")))
            .filter((a) => String(a.endDatum || a.startDatum) >= today)
            .sort((a, b) => String(a.startDatum).localeCompare(String(b.startDatum)))[0] || null;
        })
        .catch((e) => { console.warn("Ablaufplan-Widget nicht ladbar:", e); ablaufFailed = true; })
    : Promise.resolve();

  await Promise.all([calendarPromise, absencePromise, ablaufPromise]);

  const calendarOk = showCalendar && !calendarFailed;
  const absenceOk = showAbsences && !absenceFailed;
  const ablaufOk = showAblauf && !ablaufFailed && !!naechsterAblauf;
  if (!calendarOk && !absenceOk && !ablaufOk) {
    termineEl.innerHTML = "";
    updateSidebarSichtbarkeit();
    return;
  }

  renderSidebarWidget(widget, {
    showCalendar: calendarOk, oeffentlich, privat, kategorien, geburtstage,
    showAbsences: absenceOk, absences, absenceKategorien,
    showAblauf: ablaufOk, ablauf: naechsterAblauf
  });
}

function renderSidebarWidget(widget, opts) {
  const { showCalendar, oeffentlich, privat, kategorien, geburtstage, showAbsences, absences, absenceKategorien,
          showAblauf, ablauf } = opts;
  const tool = toolById(CALENDAR_WIDGET_APP_ID);
  const url = tool ? tool.url : "#";
  const katFarbe = (id) => {
    const k = kategorien.find((k2) => k2.id === id);
    return k ? k.farbe : "#6b7280";
  };
  // row = { termin, datum, zeit, candId } (siehe calendarWidgetRows) -- das Datum
  // kommt aus der Zeile, nicht aus dem Termin, damit jeder Umfrage-Vorschlag sein
  // eigenes Datum zeigt statt dreimal dem frühesten.
  const rowHtml = (row) => {
    const inner =
      `<span class="cw-date">${escapeHtml(formatCalendarDate(row.datum))}</span>` +
      `<span class="cw-dot" style="background:${escapeHtml(katFarbe(row.termin.kategorie))}"></span>` +
      `<span class="cw-title">${escapeHtml(row.termin.titel || "")}</span>`;
    if (!row.candId || !row.termin.id) {
      return `<a class="calendar-widget-item" href="${escapeHtml(url)}">${inner}</a>`;
    }
    // Umfrage-Vorschlag: Zeile führt weiter in die App, bekommt darunter aber die
    // Zu-/Absage-Knöpfe. Die Buttons dürfen NICHT im <a> stecken -- verschachtelte
    // interaktive Elemente sind ungültiges HTML, und der Klick würde zusätzlich
    // der Verlinkung folgen und das Dashboard verlassen.
    const c = calendarVoteCounts(row.termin, row.candId, currentUser ? currentUser.username : null);
    const knopf = (val, zeichen, anzahl, titel) => `
            <button type="button" class="cw-vote cw-vote-${val}${c.meins === val ? " active" : ""}"
              data-termin-id="${escapeHtml(row.termin.id)}" data-cand-id="${escapeHtml(row.candId)}"
              data-val="${val}" title="${titel}">${zeichen} ${anzahl}</button>`;
    // .cw-vote-msg steht als Geschwister von .cw-votes, nicht darin: sie bricht
    // im Fehlerfall in eine eigene Zeile um (flex-basis 100%) und drückt die
    // Knöpfe nicht aus der schmalen Spalte. Leer ist sie per :empty ausgeblendet.
    return `
        <div class="calendar-widget-item calendar-widget-poll">
          <a class="cw-main" href="${escapeHtml(url)}" title="${escapeHtml(row.termin.titel || "")}">${inner}</a>
          <div class="cw-votes">
            ${knopf("ja", "✓", c.ja, "Zusagen (nochmal klicken = zurückziehen)")}
            ${knopf("nein", "✗", c.nein, "Absagen (nochmal klicken = zurückziehen)")}
          </div>
          <span class="cw-vote-msg"></span>
        </div>
      `;
  };
  // Geburtstage (immer nur die von HEUTE, siehe list-birthdays-today) stehen
  // als eigene, nicht verlinkte Zeilen ganz oben -- kein Termin-Objekt aus dem
  // Vereinskalender, daher kein href dorthin.
  const birthdayRowHtml = (name) => `
        <div class="calendar-widget-item calendar-widget-birthday">
          <span class="cw-date">Heute</span>
          <span class="cw-emoji">🎂</span>
          <span class="cw-title">${escapeHtml(name)} hat Geburtstag</span>
        </div>
      `;

  // ⚠️ Der Ablaufplan steht GANZ OBEN und mit genau EINER Zeile (Michel-
  // Entscheidung 2026-08-12). formatAbsenceRange wird mitbenutzt statt kopiert --
  // es liefert schon "16.08." bzw. "16.–18.08." fuer ein- und mehrtaegig.
  let ablaufHtml = "";
  if (showAblauf && ablauf) {
    const ablaufTool = toolById(ABLAUF_WIDGET_APP_ID);
    const ablaufUrl = ablaufTool ? ablaufTool.url : "#";
    const anzahl = Array.isArray(ablauf.punkte) ? ablauf.punkte.length : 0;
    ablaufHtml = `
      <h2>⏱️ Nächster Ablauf</h2>
      <div class="calendar-widget-list">
        <a class="calendar-widget-item" href="${escapeHtml(ablaufUrl)}">
          <span class="cw-date">${escapeHtml(formatAbsenceRange(ablauf.startDatum, ablauf.endDatum || ablauf.startDatum))}</span>
          <span class="cw-emoji">⏱️</span>
          <span class="cw-title">${escapeHtml(ablauf.titel || "Ohne Titel")}${
            anzahl ? ` (${anzahl} ${anzahl === 1 ? "Punkt" : "Punkte"})` : ""}</span>
        </a>
      </div>
    `;
  }

  let calendarHtml = "";
  if (showCalendar) {
    const rows = (geburtstage.length || oeffentlich.length)
      ? geburtstage.map(birthdayRowHtml).join("") + oeffentlich.map(rowHtml).join("")
      : '<p class="muted" style="padding:4px 0;">Keine anstehenden Termine.</p>';
    // Private Termine (nur für den eingeloggten Nutzer sichtbar, siehe
    // calendarTerminVisibleFor) stehen als eigener Abschnitt UNTER den normalen
    // Terminen — der Abschnitt fehlt ganz, wenn der Nutzer keine hat.
    const privateSection = privat.length ? `
      <h2 class="calendar-widget-sub-heading">🔒 Private Termine</h2>
      <div class="calendar-widget-list">${privat.map(rowHtml).join("")}</div>
    ` : "";
    // Steht der Ablaufplan darueber, braucht diese Ueberschrift den Abstand der
    // Unterueberschrift -- sonst klebt sie an der Ablauf-Zeile.
    calendarHtml = `
      <h2${ablaufHtml ? ' class="calendar-widget-sub-heading"' : ""}>📅 Nächste Termine</h2>
      <div class="calendar-widget-list">${rows}</div>
      ${privateSection}
    `;
  }

  // Abwesenheiten-Abschnitt: eigene App/Sichtbarkeit, daher unabhängig vom
  // Kalender-Teil gerendert (siehe loadSidebarWidget) — nutzt dasselbe
  // .calendar-widget-item/.cw-date/.cw-dot/.cw-title-Markup für optische
  // Konsistenz mit den Termin-Zeilen darüber.
  let absenceHtml = "";
  if (showAbsences) {
    const absTool = toolById(ABSENCE_WIDGET_APP_ID);
    const absUrl = absTool ? absTool.url : "#";
    const absKatFarbe = (id) => {
      const k = absenceKategorien.find((k2) => k2.id === id);
      return k ? k.farbe : "#6b7280";
    };
    const absKatName = (id) => {
      const k = absenceKategorien.find((k2) => k2.id === id);
      return k ? k.name : "Sonstiges";
    };
    const absRowHtml = (a) => `
      <a class="calendar-widget-item" href="${escapeHtml(absUrl)}">
        <span class="cw-date">${escapeHtml(formatAbsenceRange(a.von, a.bis))}</span>
        <span class="cw-dot" style="background:${escapeHtml(absKatFarbe(a.kategorie))}"></span>
        <span class="cw-title">${escapeHtml(absencePersonName(a))} (${escapeHtml(absKatName(a.kategorie))})</span>
      </a>
    `;
    const absRows = absences.length
      ? absences.map(absRowHtml).join("")
      : '<p class="muted" style="padding:4px 0;">Keine anstehenden Abwesenheiten.</p>';
    absenceHtml = `
      <h2 class="calendar-widget-sub-heading">🧳 Nächste Abwesenheiten</h2>
      <div class="calendar-widget-list">${absRows}</div>
    `;
  }

  const termineEl = document.getElementById("termine-widget-inhalt");
  if (termineEl) termineEl.innerHTML = `<div class="card">${ablaufHtml}${calendarHtml}${absenceHtml}</div>`;
  updateSidebarSichtbarkeit();

  // Für das Neu-Rendern nach einer abgegebenen Stimme merken; der Klick-Handler
  // hängt am Container (überlebt das innerHTML-Ersetzen) und wird nur einmal
  // gebunden.
  calendarWidgetOpts = opts;
  if (!widget.dataset.voteBound) {
    widget.addEventListener("click", onCalendarWidgetClick);
    widget.dataset.voteBound = "1";
  }
}

function calendarWidgetTerminById(id) {
  if (!calendarWidgetOpts) return null;
  const alle = (calendarWidgetOpts.oeffentlich || []).concat(calendarWidgetOpts.privat || []);
  const row = alle.find((r) => r && r.termin && r.termin.id === id);
  return row ? row.termin : null;
}

// Abstimmen direkt aus dem Dashboard. Läuft über die BESTEHENDE Worker-Aktion
// `vereinskalender-vote` -- nicht über dav-save: vereinskalender steht in
// WRITE_REQUIRES_EDIT_PERMISSION, ein generisches Speichern liefe für genau die
// eingeladenen Nicht-Bearbeiter ins 403 (derselbe Bug wie 2026-07-23 in der App).
// Bewusst KEIN optimistisches Update: die Knöpfe sperren bis der Server geantwortet
// hat und zeigen dann dessen Zahlen -- so steht im Widget nie ein Stand, den der
// Server nicht bestätigt hat.
async function onCalendarWidgetClick(e) {
  const btn = e.target.closest(".cw-vote");
  if (!btn || btn.disabled) return;
  e.preventDefault();

  const zeile = btn.closest(".calendar-widget-poll");
  const knoepfe = Array.from(zeile.querySelectorAll(".cw-vote"));
  const msgEl = zeile.querySelector(".cw-vote-msg");
  knoepfe.forEach((b) => { b.disabled = true; });
  if (msgEl) msgEl.textContent = "";

  // Zweiter Klick auf denselben Knopf zieht die eigene Stimme zurück (wie in der App).
  const wert = btn.classList.contains("active") ? "" : btn.dataset.val;
  try {
    const res = await callWorker("vereinskalender-vote", {
      terminId: btn.dataset.terminId, candId: btn.dataset.candId, wert: wert
    });
    const t = calendarWidgetTerminById(btn.dataset.terminId);
    if (t && t.umfrage) {
      t.umfrage.stimmen = (res && res.stimmen && typeof res.stimmen === "object") ? res.stimmen : {};
    }
    const widget = document.getElementById("calendar-widget");
    if (widget && calendarWidgetOpts) renderSidebarWidget(widget, calendarWidgetOpts);
  } catch (err) {
    console.warn("Abstimmen im Termine-Widget fehlgeschlagen:", err);
    knoepfe.forEach((b) => { b.disabled = false; });
    if (msgEl) msgEl.textContent = err && err.message ? err.message : "Abstimmen fehlgeschlagen.";
  }
}

// ---------- Persönliche Aufgaben (zweite Karte der linken Spalte) ----------

// Alles, was der Worker zu den Aufgaben liefert. canAssign entscheidet nur über
// die Oberfläche -- die echte Schranke sitzt im Worker (darfAufgabenZuweisen).
let aufgabenState = { meine: [], zugewiesenVonMir: [], canAssign: false, canAssignDocs: false, assignGroupIds: [], dokumentGroupIds: [], geladen: false };
let aufgabenEmpfaengerCache = null; // list-directory-Ergebnis, einmal je Sitzung
// Rohbytes der im Zuweisen-Dialog gewählten PDF. Bewusst außerhalb des States:
// sie gehören zu einem offenen Dialog, nicht zum geladenen Datenstand.
let zuweisenPdfBytes = null;


function heuteIso() {
  return new Date().toISOString().slice(0, 10);
}

// Reihenfolge: überfällig/heute zuerst, dann datierte, dann undatierte, erledigte
// zuletzt. Der Schlüssel ist ein String, damit stabil sortiert werden kann.
// Reihenfolge: überfällig, dann was heute dran ist ODER neu zugewiesen wurde,
// dann kommende Fristen, dann Fristloses, zuletzt Abgeschlossenes.
//
// Dass eine ungesehene Zuweisung mit nach oben rückt, ist der Punkt: ohne Frist
// fiel sie vorher in dieselbe Gruppe wie alles Fristlose und stand damit unter
// jedem Termin, der Monate entfernt ist -- ausgerechnet das, worauf der Zähler
// oben aufmerksam machen soll, wäre ans Ende der Liste gerutscht.
function aufgabeSortKey(a, heute) {
  const gruppe = (a.erledigt || a.zurueckgezogenAm) ? 4
    : aufgabeIstUeberfaellig(a, heute) ? 0
    : (aufgabeIstHeuteFaellig(a, heute) || aufgabeIstNeu(a)) ? 1
    : a.faellig ? 2 : 3;
  return `${gruppe}|${a.faellig || "9999-99-99"}|${a.erstelltAm || ""}`;
}

// Überfällig heißt seit 2026-07-28 wirklich "der Termin ist vorbei" (< heute).
// Vorher lief "heute fällig" unter derselben roten Kennzeichnung mit; damit sah
// eine Aufgabe, für die noch der ganze Tag Zeit ist, genauso alarmierend aus wie
// eine, die seit einer Woche liegt. Michel nennt die beiden Fälle getrennt, also
// werden sie auch getrennt gezeigt.
function aufgabeIstUeberfaellig(a, heute) {
  return !a.erledigt && !a.zurueckgezogenAm && !!a.faellig && a.faellig < heute;
}

function aufgabeIstHeuteFaellig(a, heute) {
  return !a.erledigt && !a.zurueckgezogenAm && a.faellig === heute;
}

function aufgabeIstNeu(a) {
  return !!a.von && !a.gesehenAm && !a.erledigt && !a.zurueckgezogenAm;
}

// Was am Kopf-Knopf ein Signal auslöst: neu zugewiesen, heute fällig, überfällig.
// Eine Aufgabe kann mehreres gleichzeitig sein (neu UND heute fällig), deshalb
// zählt die Gesamtzahl über eine Menge und nicht über die Summe der drei Zahlen.
function aufgabenSignal(liste, heute) {
  const neu = liste.filter(aufgabeIstNeu);
  const heuteFaellig = liste.filter((a) => aufgabeIstHeuteFaellig(a, heute));
  const ueberfaellig = liste.filter((a) => aufgabeIstUeberfaellig(a, heute));
  const ids = new Set();
  [neu, heuteFaellig, ueberfaellig].forEach((gruppe) => gruppe.forEach((a) => ids.add(a.id)));
  return {
    neu: neu.length,
    heuteFaellig: heuteFaellig.length,
    ueberfaellig: ueberfaellig.length,
    gesamt: ids.size
  };
}

// Ein Satz je Fall, in der Reihenfolge der Dringlichkeit. Wird sowohl für den
// Tooltip am Kopf-Knopf als auch für den Hinweis im Fenster gebraucht.
function aufgabenSignalTexte(sig) {
  const t = [];
  if (sig.neu) t.push(sig.neu === 1 ? "1 neue Aufgabe für dich" : `${sig.neu} neue Aufgaben für dich`);
  if (sig.ueberfaellig) t.push(sig.ueberfaellig === 1 ? "1 Aufgabe ist überfällig" : `${sig.ueberfaellig} Aufgaben sind überfällig`);
  if (sig.heuteFaellig) t.push(sig.heuteFaellig === 1 ? "1 Aufgabe ist heute fällig" : `${sig.heuteFaellig} Aufgaben sind heute fällig`);
  return t;
}

async function loadAufgaben() {
  const ziel = document.getElementById("aufgaben-widget-inhalt");
  if (!ziel) return;
  // Spielerkonten und Abgemeldete bekommen die Karte gar nicht erst -- der Worker
  // antwortet ihnen ohnehin mit 403/401, ein Fehlversuch je Seitenaufruf wäre nur Lärm.
  if (!currentUser || currentUser.art === "spieler") {
    aufgabenState = { meine: [], zugewiesenVonMir: [], canAssign: false, canAssignDocs: false, assignGroupIds: [], dokumentGroupIds: [], geladen: false };
    ziel.innerHTML = "";
    aufgabenKopfZaehlerLeeren();
    updateKopfKnoepfe();
    return;
  }
  try {
    const res = await callWorker("aufgaben-load", {});
    aufgabenState = {
      meine: Array.isArray(res && res.meine) ? res.meine : [],
      zugewiesenVonMir: Array.isArray(res && res.zugewiesenVonMir) ? res.zugewiesenVonMir : [],
      canAssign: !!(res && res.canAssign),
      // Kommt gratis aus aufgaben-load mit; der Dokumente-Tab wird davon
      // unabhängig noch einmal geladen, das Widget braucht es aber sofort.
      canAssignDocs: !!(res && res.canAssignDocs),
      assignGroupIds: Array.isArray(res && res.assignGroupIds) ? res.assignGroupIds : [],
      dokumentGroupIds: Array.isArray(res && res.dokumentGroupIds) ? res.dokumentGroupIds : [],
      geladen: true
    };
    renderAufgabenWidget();
  } catch (e) {
    console.warn("Aufgaben nicht ladbar:", e);
    ziel.innerHTML = "";
    aufgabenKopfZaehlerLeeren();
    updateKopfKnoepfe();
  }
}

// Ein Satz je Fall wie aufgabenSignalTexte, nur für die andere Kopfzeilen-Hälfte.
// Bewusst eigene Sätze statt eines Wort-Parameters: "1 neue Aufgabe für dich"
// ließe sich nicht sinnvoll auf Unterschriften umbiegen.
function dokumentSignalTexte(sig) {
  const t = [];
  if (sig.neu) t.push(sig.neu === 1 ? "1 neue Unterschrift angefragt" : `${sig.neu} neue Unterschriften angefragt`);
  if (sig.ueberfaellig) t.push(sig.ueberfaellig === 1 ? "1 Unterschrift ist überfällig" : `${sig.ueberfaellig} Unterschriften sind überfällig`);
  if (sig.heuteFaellig) t.push(sig.heuteFaellig === 1 ? "1 Unterschrift ist heute fällig" : `${sig.heuteFaellig} Unterschriften sind heute fällig`);
  return t;
}

// Zähler und Signal sitzen seit 2026-07-29 an ZWEI Kopf-Knöpfen (ToDos rechts,
// Unterschriften links) und funktionieren an beiden gleich -- deshalb einmal hier.
// Die Zahl bleibt die Gesamtzahl der offenen Einträge; rot wird sie nur bei einem
// echten Signal (neu, heute fällig, überfällig).
function kopfKnopfSignal(knopfId, zaehlerId, offen, sig, texte, ruheTitel) {
  const zaehler = document.getElementById(zaehlerId);
  if (zaehler) {
    zaehler.textContent = offen || "";
    zaehler.style.display = offen ? "" : "none";
    zaehler.classList.toggle("warn", sig.gesamt > 0);
  }
  const knopf = document.getElementById(knopfId);
  if (!knopf) return;
  knopf.classList.toggle("hat-signal", sig.gesamt > 0);
  knopf.title = texte.length ? texte.join(" · ") : ruheTitel;
}

// Die Zähler an den Kopf-Knöpfen hängen nicht am Fenster, sondern am geladenen
// Stand -- sie müssen deshalb auch dann verschwinden, wenn gar nichts gerendert
// wird. Beide zusammen: sie werden aus derselben Quelle gespeist.
function aufgabenKopfZaehlerLeeren() {
  ["aufgaben-kopf-zaehler", "dokumente-kopf-zaehler"].forEach((id) => {
    const z = document.getElementById(id);
    if (!z) return;
    z.textContent = "";
    z.style.display = "none";
    z.classList.remove("warn");
  });
  ["btn-todos-oeffnen", "btn-dokumente-oeffnen"].forEach((id) => {
    const k = document.getElementById(id);
    if (k) k.classList.remove("hat-signal");
  });
}

function renderAufgabenWidget() {
  const ziel = document.getElementById("aufgaben-widget-inhalt");
  if (!ziel || !aufgabenState.geladen) return;

  const heute = heuteIso();
  const sortiert = aufgabenState.meine.slice().sort((a, b) => aufgabeSortKey(a, heute).localeCompare(aufgabeSortKey(b, heute)));
  // Zwei Fenster, zwei Listen (Michel-Vorgabe 2026-07-29): eine Aufgabe mit dokId
  // steht vollständig im Unterschriften-Fenster -- mit Absender, Status und PDF.
  // Sie hier ein zweites Mal aufzuführen wäre genau die Vermischung, die das
  // Aufteilen beenden soll; abhaken ließe sie sich hier ohnehin nie (403).
  // ⚠️ Sichtbar bleibt sie damit NUR noch drüben: der Zähler am Unterschriften-
  // Knopf unten ist deshalb Pflicht, nicht Kür.
  const liste = sortiert.filter((a) => !a.dokId);
  const mitDok = sortiert.filter((a) => a.dokId);
  const offen = liste.filter((a) => !a.erledigt && !a.zurueckgezogenAm).length;
  const sig = aufgabenSignal(liste, heute);
  const wegraeumbar = liste.some((a) => (a.erledigt && !a.von) || a.zurueckgezogenAm);

  // Die Zähler an den Kopf-Knöpfen sind der Ersatz für die frühere Karte auf der
  // Startseite: ohne sie merkt man beim Seitenaufruf nicht mehr, dass etwas offen
  // ist. Die Zahl bleibt die Gesamtzahl der offenen Einträge -- sie darf nicht
  // schrumpfen, nur weil gerade nichts dringend ist.
  //
  // Rot allein hat sich als zu leise erwiesen: "3" sagt nicht, ob eine neue
  // Zuweisung dabei ist oder heute etwas fällig wird. Der Knopf trägt die
  // Aufschlüsselung deshalb im Tooltip. Bewusst kein zusätzliches Badge: das
  // kostet Layoutbreite, und die Kopfzeile hat am Handy keine mehr übrig.
  //
  // ⚠️ Beide Zahlen kommen aus aufgabenState, NICHT aus dokumenteState: die
  // Aufgaben werden beim Seitenstart geladen, die Dokumente erst beim Öffnen des
  // Fensters. Jede Dokument-Zuweisung legt eine Aufgabe mit dokId an, der Zähler
  // stimmt also -- eine zweite Quelle würde nur auseinanderlaufen.
  const offenDok = mitDok.filter((a) => !a.erledigt && !a.zurueckgezogenAm).length;
  const sigDok = aufgabenSignal(mitDok, heute);
  kopfKnopfSignal("btn-todos-oeffnen", "aufgaben-kopf-zaehler", offen, sig, aufgabenSignalTexte(sig),
    offen ? `${offen} offene ${offen === 1 ? "Aufgabe" : "Aufgaben"}` : "Eigene ToDos anlegen und abhaken");
  kopfKnopfSignal("btn-dokumente-oeffnen", "dokumente-kopf-zaehler", offenDok, sigDok, dokumentSignalTexte(sigDok),
    offenDok ? `${offenDok} ${offenDok === 1 ? "Dokument wartet" : "Dokumente warten"} auf deine Unterschrift`
             : "Unterschriften anfordern und selbst unterschreiben");
  // Erst hier steht fest, ob der Unterschriften-Knopf ueberhaupt gezeigt wird:
  // beim Seitenstart lief renderNavTabs() noch ohne geladene Aufgaben.
  updateKopfKnoepfe();

  const zeile = (a) => {
    const klassen = ["aufgabe-item"];
    if (a.erledigt) klassen.push("erledigt");
    if (a.zurueckgezogenAm) klassen.push("zurueckgezogen");
    if (aufgabeIstUeberfaellig(a, heute)) klassen.push("ueberfaellig");
    if (aufgabeIstHeuteFaellig(a, heute)) klassen.push("heute");
    if (aufgabeIstNeu(a)) klassen.push("neu");
    if (a.dokId) klassen.push("mit-dokument");
    // "neu" steht vorn: es ist der einzige Vermerk, der etwas über die Aufgabe
    // sagt, was man beim nächsten Öffnen nicht mehr sieht.
    const meta = [];
    if (aufgabeIstNeu(a)) meta.push("neu");
    if (a.faellig) {
      meta.push(aufgabeIstHeuteFaellig(a, heute)
        ? "heute fällig"
        : (aufgabeIstUeberfaellig(a, heute)
            ? "überfällig seit " + escapeHtml(formatCalendarDate(a.faellig))
            : "bis " + escapeHtml(formatCalendarDate(a.faellig))));
    }
    if (a.von) meta.push("von " + escapeHtml(a.vonName || a.von));
    if (a.zurueckgezogenAm) meta.push("zurückgezogen");
    // Löschen darf man nur Selbstangelegtes; eine zurückgezogene Zuweisung ist nur
    // noch ein Hinweis und darf deshalb ebenfalls weg (Worker prüft das genauso).
    const loeschbar = !a.von || !!a.zurueckgezogenAm;
    // Eine Aufgabe mit Dokument lässt sich hier nicht abhaken -- erledigt wird sie
    // erst durch die Unterschrift im Dokumente-Tab. Der Haken bleibt sichtbar (er
    // zeigt den Stand), ist aber gesperrt; der Worker weist ihn ohnehin ab.
    if (a.dokId) {
      // Der Haken bleibt bedienbar, obwohl er nichts umschaltet: ein gesperrtes
      // Kästchen schluckt den Klick, und wer draufdrückt bekäme gar keine Antwort.
      // So fängt der change-Handler ihn ab und zeigt den Weg zum Dokument.
      return `
        <div class="${klassen.join(" ")}" data-id="${escapeHtml(a.id)}" data-dok-id="${escapeHtml(a.dokId)}">
          <input type="checkbox" class="aufgabe-check" ${a.erledigt ? "checked" : ""}
            aria-label="Wird durch die Unterschrift erledigt" />
          <button type="button" class="aufgabe-dok-link" title="Dokument öffnen">
            <span aria-hidden="true">📄</span> ${escapeHtml(a.text || "")}
          </button>
          <span class="aufgabe-meta">${meta.concat([a.erledigt ? "unterschrieben" : "zu unterschreiben"]).join(" · ")}</span>
        </div>`;
    }
    return `
      <div class="${klassen.join(" ")}" data-id="${escapeHtml(a.id)}">
        <input type="checkbox" class="aufgabe-check" ${a.erledigt ? "checked" : ""}
          ${a.zurueckgezogenAm ? "disabled" : ""} aria-label="Erledigt" />
        <span class="aufgabe-text">${escapeHtml(a.text || "")}</span>
        ${meta.length ? `<span class="aufgabe-meta">${meta.join(" · ")}</span>` : ""}
        ${loeschbar ? '<button type="button" class="aufgabe-del" title="Löschen" aria-label="Löschen">✕</button>' : ""}
      </div>`;
  };

  // Abgeschlossenes darf der Zuweiser selbst wegräumen -- sonst steht es hier bis
  // zum Ablauf der 14-Tage-Frist und verdeckt, was noch offen ist.
  // ⚠️ Diese Rückansicht wird bewusst NICHT nach dokId gefiltert (anders als die
  // eigene Liste oben): "Abgeschlossene aufräumen" wirkt serverseitig auf alle
  // abgeschlossenen Einträge, ein gefilterter Zähler würde also etwas anderes
  // versprechen als der Knopf tut. Sie ist ohnehin nur noch Altbestand --
  // zugewiesen wird in dieser App seit 2026-07-28 nicht mehr.
  const zugAbgeschlossen = aufgabenState.zugewiesenVonMir.filter((z) => z.erledigt || z.zurueckgezogenAm).length;
  const zugewiesenHtml = aufgabenState.zugewiesenVonMir.length ? `
    <details class="aufgaben-zugewiesen">
      <summary>Von mir zugewiesen (${aufgabenState.zugewiesenVonMir.length})</summary>
      ${aufgabenState.zugewiesenVonMir.map((z) => {
        const fertig = z.erledigt || z.zurueckgezogenAm;
        return `
        <div class="aufgabe-zug-item${z.erledigt ? " erledigt" : ""}" data-id="${escapeHtml(z.id)}" data-empfaenger="${escapeHtml(z.empfaenger)}">
          <span class="aufgabe-text">${z.dokId ? '<span aria-hidden="true">📄</span> ' : ""}${escapeHtml(z.text || "")}</span>
          <span class="aufgabe-meta">${escapeHtml(z.empfaengerName || z.empfaenger)} · ${
            z.zurueckgezogenAm ? "zurückgezogen" : (z.erledigt ? (z.dokId ? "unterschrieben" : "erledigt") : "offen")
          }</span>
          ${(!fertig && !z.dokId)
            ? '<button type="button" class="aufgabe-zurueck" title="Zurückziehen">Zurückziehen</button>'
            : ""}
          ${fertig
            ? `<button type="button" class="aufgabe-zug-weg" title="${z.dokId ? "Aus der Liste entfernen (das Dokument bleibt)" : "Aus der Liste entfernen"}" aria-label="Aus der Liste entfernen">✕</button>`
            : ""}
        </div>`;
      }).join("")}
      ${zugAbgeschlossen > 1
        ? `<button type="button" class="aufgaben-zug-aufraeumen">Abgeschlossene aufräumen (${zugAbgeschlossen})</button>`
        : ""}
    </details>` : "";

  // Ohne aufklappbare Karte: im Fenster ist Platz, und wer es öffnet, will die
  // Liste sehen. Der frühere Zugeklappt-Zustand samt localStorage-Merker ist mit
  // der Dashboard-Karte weggefallen.
  // Der Hinweis steht über dem Eingabefeld, nicht unter der Liste: er ist der
  // Grund, aus dem man das Fenster geöffnet hat. Er wird mit der Liste zusammen
  // gerendert und kann deshalb nicht stehenbleiben, wenn sich der Stand ändert.
  const signalTexte = aufgabenSignalTexte(sig);
  const signalHtml = signalTexte.length
    ? `<p class="aufgaben-signal${sig.ueberfaellig ? " dringend" : ""}">
         <span aria-hidden="true">${sig.ueberfaellig ? "⚠" : "🔔"}</span>
         ${escapeHtml(signalTexte.join(" · "))}
       </p>`
    : "";

  ziel.innerHTML = `
      ${signalHtml}
      <form class="aufgaben-neu" id="aufgaben-neu-form">
        <input type="text" id="aufgabe-neu-text" maxlength="200" placeholder="Neue Aufgabe …" autocomplete="off" />
        <input type="date" id="aufgabe-neu-faellig" aria-label="Fällig bis" />
        <button type="submit" class="btn small" title="Hinzufügen">+</button>
      </form>
      <div class="aufgaben-liste">${
        liste.length ? liste.map(zeile).join("") : '<p class="muted" style="padding:4px 0;">Noch nichts zu tun.</p>'
      }</div>
      <div class="aufgaben-aktionen">
        ${wegraeumbar ? '<button type="button" class="aufgaben-aufraeumen">Erledigte aufräumen</button>' : ""}
      </div>
      <p class="aufgaben-fehler" id="aufgaben-fehler"></p>
      ${zugewiesenHtml}`;

  // Gesehen wird nur gemeldet, wenn die Liste wirklich vor Augen steht -- das
  // Rendern allein passiert auch bei geschlossenem Fenster (Zähler-Aktualisierung).
  // Und nur die eigenen: wer seine ToDos aufmacht, hat die Unterschriftsanfrage
  // im anderen Fenster damit nicht gesehen.
  if (todosFensterOffen()) markiereAufgabenGesehen(false);
}

function aufgabenFehler(text) {
  const el = document.getElementById("aufgaben-fehler");
  // innerHTML statt textContent zurücksetzen, sonst bliebe ein zuvor gesetzter
  // Knopf (siehe unten) stehen und würde neben der neuen Meldung weiterleben.
  if (el) { el.innerHTML = ""; el.textContent = text || ""; }
}

// „Diese Aufgabe wird durch die Unterschrift erledigt" ist als reiner roter Satz
// eine Sackgasse: er sagt, was nicht geht, aber nicht wohin. Deshalb kommt der
// Weg gleich als Knopf mit.
function aufgabenHinweisMitWeg(text, dokId) {
  const el = document.getElementById("aufgaben-fehler");
  if (!el) return;
  el.innerHTML = escapeHtml(text) +
    ` <button type="button" class="aufgabe-zu-dokumenten"${dokId ? ` data-dok-id="${escapeHtml(dokId)}"` : ""}>Zu den Unterschriften</button>`;
}

// Meldet ungesehene Zuweisungen als gesehen. Bewusst nicht awaited und ohne
// Neu-Rendern: die Markierung ist Nebensache, sie darf den Klick nicht bremsen
// und die Liste nicht unter dem Finger neu sortieren.
// Seit der Aufteilung in zwei Fenster (2026-07-29) immer nur die Hälfte, die
// gerade offen ist -- sonst nähme ein Blick in die ToDos dem Unterschriften-Knopf
// sein Signal weg, ohne dass jemand die Anfrage gesehen hätte.
function markiereAufgabenGesehen(mitDokument) {
  const ids = aufgabenState.meine
    .filter((a) => aufgabeIstNeu(a) && !!a.dokId === !!mitDokument)
    .map((a) => a.id);
  if (!ids.length) return;
  aufgabenState.meine.forEach((a) => { if (ids.includes(a.id)) a.gesehenAm = new Date().toISOString(); });
  callWorker("aufgaben-gesehen", { ids }).catch((e) => console.warn("Gesehen-Markierung fehlgeschlagen:", e));
}

function setupAufgabenWidget() {
  const container = document.getElementById("aufgaben-widget-inhalt");
  if (!container) return;

  // Das Fenster, in dem der Container steckt. Eigener Kopf-Knopf rechts, seit die
  // ToDos nicht mehr im Unterschriften-Fenster wohnen (Michel-Vorgabe 2026-07-29).
  const overlay = document.getElementById("todos-overlay");
  document.getElementById("btn-todos-oeffnen").addEventListener("click", oeffneTodosFenster);
  document.getElementById("btn-todos-close").addEventListener("click", schliesseTodosFenster);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) schliesseTodosFenster(); });
  document.addEventListener("keydown", (e) => {
    // Über diesem Fenster geht kein Dialog auf -- die Sichtprüfung, die das
    // Unterschriften-Fenster braucht, entfällt hier deshalb. Die Markierung wird
    // trotzdem respektiert UND gesetzt, damit ein später ergänzter Dialog nicht
    // zwei Ebenen auf einen Tastendruck zuklappt.
    if (e.key !== "Escape" || !todosFensterOffen() || e.escapeVerbraucht) return;
    e.escapeVerbraucht = true;
    schliesseTodosFenster();
  });

  // Ein Handler am Container: die Karte wird bei jeder Änderung neu gebaut, ein
  // Listener an den Zeilen selbst wäre nach dem ersten Klick verwaist.
  container.addEventListener("click", async (e) => {
    if (e.target.closest(".aufgabe-check")) return; // hat einen eigenen change-Handler

    const delBtn = e.target.closest(".aufgabe-del");
    if (delBtn) {
      const id = delBtn.closest(".aufgabe-item").dataset.id;
      await aufgabeLoeschen(id);
      return;
    }
    if (e.target.closest(".aufgaben-aufraeumen")) {
      await aufgabenAufraeumen();
      return;
    }
    // Eine Unterschriftsaufgabe führt ins Unterschriften-Fenster -- unterschrieben
    // wird nicht im Widget, dafür ist es zu klein (PDF ansehen braucht Fläche).
    // Seit der Aufteilung (2026-07-29) stehen Aufgaben mit dokId gar nicht mehr in
    // dieser Liste; die beiden Sprung-Wege bleiben als Netz und wechseln dann
    // sauber das Fenster, statt zwei übereinander offen zu lassen.
    const dokLink = e.target.closest(".aufgabe-dok-link");
    if (dokLink) {
      const dokId = dokLink.closest(".aufgabe-item").dataset.dokId;
      schliesseTodosFenster();
      await oeffneDokumenteFenster();
      oeffneDokumentAnsicht(dokId);
      return;
    }
    const zurueckBtn = e.target.closest(".aufgabe-zurueck");
    if (zurueckBtn) {
      const row = zurueckBtn.closest(".aufgabe-zug-item");
      await aufgabeZurueckziehen(row.dataset.id, row.dataset.empfaenger);
      return;
    }
    // Weg aus dem Hinweis heraus, den das Abhaken einer Unterschriftsaufgabe zeigt.
    const wegBtn = e.target.closest(".aufgabe-zu-dokumenten");
    if (wegBtn) {
      const dokId = wegBtn.dataset.dokId;
      schliesseTodosFenster();
      await oeffneDokumenteFenster();
      if (dokId) oeffneDokumentAnsicht(dokId);
      return;
    }
    // Rückansicht aufräumen: einzeln oder alles Abgeschlossene auf einmal.
    const wegRow = e.target.closest(".aufgabe-zug-weg");
    if (wegRow) {
      const row = wegRow.closest(".aufgabe-zug-item");
      await zuweisungEntfernen(row.dataset.id, row.dataset.empfaenger);
      return;
    }
    if (e.target.closest(".aufgaben-zug-aufraeumen")) {
      await zuweisungEntfernen();
      return;
    }
  });

  container.addEventListener("change", async (e) => {
    const box = e.target.closest(".aufgabe-check");
    if (!box) return;
    const zeile = box.closest(".aufgabe-item");
    // Unterschriftsaufgaben lassen sich hier nicht abhaken. Den Haken sofort
    // zurücksetzen und statt einer Absage den Weg dorthin anbieten -- der Server
    // würde es ohnehin mit 403 ablehnen, aber erst nach einem Rundlauf.
    if (zeile.dataset.dokId) {
      box.checked = !box.checked;
      aufgabenHinweisMitWeg("Das erledigt erst deine Unterschrift.", zeile.dataset.dokId);
      return;
    }
    await aufgabeAbhaken(zeile.dataset.id, box.checked);
  });

  container.addEventListener("submit", async (e) => {
    if (!e.target.closest("#aufgaben-neu-form")) return;
    e.preventDefault();
    await aufgabeAnlegen();
  });
}

async function aufgabeAnlegen() {
  const textEl = document.getElementById("aufgabe-neu-text");
  const faelligEl = document.getElementById("aufgabe-neu-faellig");
  const text = (textEl.value || "").trim();
  if (!text) return;
  aufgabenFehler("");
  try {
    const res = await callWorker("aufgabe-speichern", { text, faellig: faelligEl.value || "" });
    if (res && res.aufgabe) aufgabenState.meine.push(res.aufgabe);
    textEl.value = "";
    faelligEl.value = "";
    renderAufgabenWidget();
    const neuesFeld = document.getElementById("aufgabe-neu-text");
    if (neuesFeld) neuesFeld.focus();
  } catch (e) {
    aufgabenFehler(e && e.message ? e.message : "Speichern fehlgeschlagen.");
  }
}

// Optimistisch: der Haken sitzt schon, wir bestätigen ihn nur noch. Schlägt das
// fehl, wird der lokale Stand zurückgedreht und neu gerendert -- im Widget steht
// dann wieder das, was der Server tatsächlich kennt.
async function aufgabeAbhaken(id, erledigt) {
  const a = aufgabenState.meine.find((x) => x.id === id);
  if (!a) return;
  const vorher = { erledigt: a.erledigt, erledigtAm: a.erledigtAm };
  a.erledigt = erledigt;
  a.erledigtAm = erledigt ? new Date().toISOString() : null;
  aufgabenFehler("");
  try {
    await callWorker("aufgabe-speichern", { id, erledigt });
    renderAufgabenWidget();
  } catch (e) {
    a.erledigt = vorher.erledigt;
    a.erledigtAm = vorher.erledigtAm;
    renderAufgabenWidget();
    aufgabenFehler(e && e.message ? e.message : "Speichern fehlgeschlagen.");
  }
}

async function aufgabeLoeschen(id) {
  aufgabenFehler("");
  try {
    await callWorker("aufgabe-loeschen", { id });
    aufgabenState.meine = aufgabenState.meine.filter((a) => a.id !== id);
    renderAufgabenWidget();
  } catch (e) {
    aufgabenFehler(e && e.message ? e.message : "Löschen fehlgeschlagen.");
  }
}

async function aufgabenAufraeumen() {
  aufgabenFehler("");
  try {
    await callWorker("aufgaben-aufraeumen", {});
    // Serverregel spiegeln: erledigte Zuweisungen bleiben stehen (der Zuweiser
    // soll sie noch sehen), Selbstangelegtes und Zurückgezogenes geht.
    aufgabenState.meine = aufgabenState.meine.filter((a) => {
      if (a.zurueckgezogenAm) return false;
      if (!a.erledigt) return true;
      return !!a.von;
    });
    renderAufgabenWidget();
  } catch (e) {
    aufgabenFehler(e && e.message ? e.message : "Aufräumen fehlgeschlagen.");
  }
}

// Räumt die Rückansicht auf. Ohne Argumente: alles Abgeschlossene auf einmal.
// Ein daran hängendes Dokument bleibt erhalten -- das steht im Dokumente-Tab und
// hat mit der Erinnerung nichts mehr zu tun.
async function zuweisungEntfernen(id, empfaenger) {
  aufgabenFehler("");
  try {
    await callWorker("zuweisung-entfernen", id ? { id, empfaenger } : {});
    aufgabenState.zugewiesenVonMir = aufgabenState.zugewiesenVonMir.filter((z) => {
      const abgeschlossen = z.erledigt || z.zurueckgezogenAm;
      if (!abgeschlossen) return true;
      return id ? !(z.id === id && z.empfaenger === empfaenger) : false;
    });
    renderAufgabenWidget();
  } catch (e) {
    aufgabenFehler(e && e.message ? e.message : "Aufräumen fehlgeschlagen.");
  }
}

async function aufgabeZurueckziehen(id, empfaenger) {
  aufgabenFehler("");
  try {
    await callWorker("aufgabe-zurueckziehen", { id, empfaenger });
    const z = aufgabenState.zugewiesenVonMir.find((x) => x.id === id && x.empfaenger === empfaenger);
    if (z) z.zurueckgezogenAm = new Date().toISOString();
    renderAufgabenWidget();
  } catch (e) {
    aufgabenFehler(e && e.message ? e.message : "Zurückziehen fehlgeschlagen.");
  }
}

// ---- Aufgabe zuweisen (Dialog) ----

// Zwei Vorgänge, ein Dialog: "aufgabe" verteilt eine Aufgabe, "unterschrift"
// fordert eine Unterschrift auf einem PDF an. Bewusst getrennt (Michel-Vorgabe) --
// sie hängen an verschiedenen Rechten und meinen verschiedene Dinge. Gemeinsam
// bleiben nur Empfängerauswahl und Fälligkeit, deshalb dieselbe Maske.
let zuweisenModus = "aufgabe";

async function oeffneAufgabeZuweisen(modus) {
  const overlay = document.getElementById("aufgaben-zuweisen-overlay");
  if (!overlay) return;
  zuweisenModus = modus === "unterschrift" ? "unterschrift" : "aufgabe";
  const istDok = zuweisenModus === "unterschrift";

  document.getElementById("aufgaben-zuweisen-titel").textContent =
    istDok ? "✍️ Unterschrift anfordern" : "📋 Aufgabe zuweisen";
  document.getElementById("aufgabe-zuweisen-text-label").textContent =
    istDok ? "Bezeichnung des Dokuments" : "Aufgabe";
  const textFeld = document.getElementById("aufgabe-zuweisen-text");
  textFeld.placeholder = istDok ? "z. B. Trainervertrag 2026/27" : "z. B. Trikots zählen";
  textFeld.value = "";
  document.getElementById("btn-aufgabe-zuweisen-senden").textContent =
    istDok ? "Anfordern" : "Zuweisen";

  document.getElementById("aufgabe-zuweisen-faellig").value = "";
  document.getElementById("aufgabe-zuweisen-suche").value = "";
  document.getElementById("aufgabe-zuweisen-error").style.display = "none";

  // Dokument-Teil in den Ausgangszustand: eine offene Datei aus einem früheren
  // Aufruf darf nicht versehentlich an der nächsten Zuweisung hängen.
  //
  // Beim Zuweisen ist das Dokument optional und liegt hinter einem Häkchen; beim
  // Anfordern ist es der Zweck der Sache und damit Pflicht, dort entfällt das
  // Häkchen. In beiden Fällen braucht es das Dokument-Recht.
  document.getElementById("aufgabe-zuweisen-dok-block").style.display =
    (istDok || aufgabenState.canAssignDocs) ? "" : "none";
  document.getElementById("aufgabe-zuweisen-dok-an-zeile").style.display = istDok ? "none" : "";
  document.getElementById("aufgabe-zuweisen-dok-an").checked = false;
  document.getElementById("aufgabe-zuweisen-dok-felder").style.display = istDok ? "" : "none";
  document.getElementById("aufgabe-zuweisen-dok-datei").value = "";
  document.getElementById("aufgabe-zuweisen-dok-status").textContent = "";
  document.getElementById("aufgabe-zuweisen-dok-vorschau").style.display = "none";
  // Mail-Häkchen bewusst bei JEDEM Öffnen zurück auf aus: der Versand ist eine
  // Einzelfall-Entscheidung, kein Zustand, der aus dem letzten Vorgang stehenbleibt.
  document.getElementById("aufgabe-zuweisen-mail").checked = false;
  zuweisenMailZeileZeigen();
  // Schmal starten: die Breite kommt erst mit der Vorschau dazu (siehe unten am
  // Datei-Handler). Ein 860px-Formular ohne PDF darin sieht nur leer aus.
  overlay.querySelector(".code-dialog").classList.remove("mit-vorschau");
  zuweisenFeldInfoZeigen();
  vorschauZuweisen.doc = null;
  vorschauZuweisen.feld = null;
  zuweisenPdfBytes = null;

  overlay.style.display = "flex";
  textFeld.focus();

  const listeEl = document.getElementById("aufgabe-zuweisen-empfaenger");
  listeEl.innerHTML = '<p class="muted">Namen werden geladen …</p>';
  try {
    // list-directory gibt es schon (Picker "Teilen mit" im Vereinskalender): nur
    // Personal, Spielerkonten sind serverseitig ausgeschlossen.
    if (!aufgabenEmpfaengerCache) {
      const res = await callWorker("list-directory", {});
      aufgabenEmpfaengerCache = Array.isArray(res && res.users) ? res.users : [];
    }
    renderAufgabenEmpfaenger("");
  } catch (e) {
    listeEl.innerHTML = '<p class="muted">Namen konnten nicht geladen werden.</p>';
  }
}

function renderAufgabenEmpfaenger(filter) {
  const listeEl = document.getElementById("aufgabe-zuweisen-empfaenger");
  if (!listeEl || !aufgabenEmpfaengerCache) return;
  const ich = currentUser ? currentUser.username : "";
  const suche = (filter || "").trim().toLowerCase();
  // Bereits Angehakte bleiben immer sichtbar -- sonst verschwindet eine Auswahl
  // beim Weitertippen aus dem Bild und wird später überraschend mitgeschickt.
  const gewaehlt = aufgabenGewaehlteEmpfaenger();
  const treffer = aufgabenEmpfaengerCache
    .filter((u) => u.username !== ich)
    .filter((u) => !suche || (u.displayName || "").toLowerCase().includes(suche) || gewaehlt.includes(u.username));
  listeEl.innerHTML = treffer.length
    ? treffer.map((u) => `
        <label class="aufgaben-empfaenger-zeile">
          <input type="checkbox" value="${escapeHtml(u.username)}" ${gewaehlt.includes(u.username) ? "checked" : ""} />
          <span>${escapeHtml(u.displayName || u.username)}</span>
        </label>`).join("")
    : '<p class="muted">Kein Name gefunden.</p>';
}

function aufgabenGewaehlteEmpfaenger() {
  const listeEl = document.getElementById("aufgabe-zuweisen-empfaenger");
  if (!listeEl) return [];
  return Array.from(listeEl.querySelectorAll("input[type=checkbox]:checked")).map((c) => c.value);
}

function schliesseAufgabeZuweisen() {
  const overlay = document.getElementById("aufgaben-zuweisen-overlay");
  if (overlay) overlay.style.display = "none";
}

function setupAufgabenZuweisenDialog() {
  const overlay = document.getElementById("aufgaben-zuweisen-overlay");
  if (!overlay) return;
  document.getElementById("btn-aufgaben-zuweisen-close").addEventListener("click", schliesseAufgabeZuweisen);
  document.getElementById("btn-aufgabe-zuweisen-abbrechen").addEventListener("click", schliesseAufgabeZuweisen);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) schliesseAufgabeZuweisen(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.style.display === "flex") {
      // Markieren, damit das darunterliegende Aufgaben-Fenster nicht im selben
      // Tastendruck mitschließt -- es prüft sonst einen bereits zugeklappten
      // Dialog und hielte sich für die oberste Ebene.
      e.escapeVerbraucht = true;
      schliesseAufgabeZuweisen();
    }
  });
  document.getElementById("aufgabe-zuweisen-suche").addEventListener("input", (e) => {
    renderAufgabenEmpfaenger(e.target.value);
  });
  document.getElementById("btn-aufgabe-zuweisen-senden").addEventListener("click", aufgabeZuweisenSenden);

  // ---- Zu unterschreibendes PDF ----
  document.getElementById("aufgabe-zuweisen-dok-an").addEventListener("change", (e) => {
    document.getElementById("aufgabe-zuweisen-dok-felder").style.display = e.target.checked ? "" : "none";
    zuweisenMailZeileZeigen();
  });
  document.getElementById("aufgabe-zuweisen-dok-datei").addEventListener("change", async (e) => {
    const datei = e.target.files && e.target.files[0];
    const statusEl = document.getElementById("aufgabe-zuweisen-dok-status");
    if (!datei) return;
    if (datei.size > 10 * 1024 * 1024) {
      statusEl.textContent = "Die Datei ist größer als 10 MB.";
      return;
    }
    statusEl.textContent = "Vorschau wird erzeugt …";
    try {
      zuweisenPdfBytes = await dateiAlsBytes(datei);
      vorschauZuweisen.feld = null;
      document.getElementById("aufgabe-zuweisen-dok-vorschau").style.display = "";
      // Erst jetzt breit werden -- vorher ist nichts da, wofür sich die Breite lohnt.
      document.querySelector("#aufgaben-zuweisen-overlay .code-dialog").classList.add("mit-vorschau");
      zuweisenFeldInfoZeigen();
      await vorschauLaden(vorschauZuweisen, zuweisenPdfBytes);
      statusEl.textContent = datei.name;
    } catch (err) {
      zuweisenPdfBytes = null;
      statusEl.textContent = "Die PDF konnte nicht gelesen werden.";
    }
  });
  document.getElementById("dok-seite-zurueck").addEventListener("click", async () => {
    if (vorschauZuweisen.seite > 1) { vorschauZuweisen.seite--; await vorschauRendern(vorschauZuweisen); }
  });
  document.getElementById("dok-seite-vor").addEventListener("click", async () => {
    if (vorschauZuweisen.seite < vorschauZuweisen.seiten) { vorschauZuweisen.seite++; await vorschauRendern(vorschauZuweisen); }
  });
  vorschauZiehenAktivieren(vorschauZuweisen, zuweisenFeldInfoZeigen);
}

// Erklärt die Platzierung, statt sie nur zu quittieren (Michel-Rückmeldung
// 2026-07-29: "ein Hinweis, der diese Funktion erklärt, wäre super"). Vorher stand
// hier ein reiner Zustandssatz -- wer nicht wusste, dass man überhaupt ein Rechteck
// aufziehen KANN, erfuhr es nirgends. Der Text nennt jetzt auch, was ohne Rechteck
// passiert, und das ist seit heute nicht mehr zwingend die angehängte Seite: ohne
// Vorgabe darf der Empfänger die Stelle selbst wählen.
function zuweisenFeldInfoZeigen() {
  const info = document.getElementById("dok-feld-info");
  if (!info) return;
  info.className = "dok-platz-info";
  info.textContent = vorschauZuweisen.feld
    ? `Unterschrift kommt auf Seite ${vorschauZuweisen.feld.seite} an die markierte Stelle. Zum Ändern einfach ein neues Rechteck aufziehen.`
    : "Zieh ein Rechteck auf die Stelle im Dokument, an der unterschrieben werden soll (mit der Maus oder dem Finger) — dort wird die Unterschrift später eingesetzt. Lässt du es weg, darf der Empfänger die Stelle selbst wählen; tut auch er es nicht, kommt die Unterschrift auf ein zusätzliches Blatt am Ende.";
}

// Das Mail-Häkchen gehört zur Unterschriftsanforderung und erscheint nur, wenn mit
// diesem Vorgang auch wirklich ein Dokument rausgeht: im Anfordern-Modus immer, im
// Zuweisen-Modus erst mit gesetztem Dokument-Häkchen. Ohne Dokument gäbe es nichts
// zu unterschreiben, und die Mail hätte keinen Gegenstand.
// ⚠️ Beim Ausblenden wird das Häkchen mit geleert -- ein unsichtbares, aber gesetztes
// Kästchen würde beim Senden trotzdem gelesen (dieselbe Falle wie bei jedem
// versteckten Formularfeld).
function zuweisenMailZeileZeigen() {
  const zeile = document.getElementById("aufgabe-zuweisen-mail-zeile");
  if (!zeile) return;
  const haken = document.getElementById("aufgabe-zuweisen-dok-an");
  const mitDok = zuweisenModus === "unterschrift" || (haken && haken.checked);
  zeile.style.display = mitDok ? "" : "none";
  if (!mitDok) document.getElementById("aufgabe-zuweisen-mail").checked = false;
}

async function aufgabeZuweisenSenden() {
  const fehlerEl = document.getElementById("aufgabe-zuweisen-error");
  const btn = document.getElementById("btn-aufgabe-zuweisen-senden");
  const text = (document.getElementById("aufgabe-zuweisen-text").value || "").trim();
  const faellig = document.getElementById("aufgabe-zuweisen-faellig").value || "";
  const empfaenger = aufgabenGewaehlteEmpfaenger();
  const zeige = (msg) => { fehlerEl.textContent = msg; fehlerEl.style.display = "block"; };

  fehlerEl.style.display = "none";
  if (!text) return zeige(zuweisenModus === "unterschrift"
    ? "Bitte eine Bezeichnung für das Dokument eintragen."
    : "Bitte eine Aufgabe eintragen.");
  if (!empfaenger.length) return zeige("Bitte mindestens eine Person auswählen.");

  // Im Anfordern-Modus immer, im Zuweisen-Modus nur wenn angehakt.
  const hakenEl = document.getElementById("aufgabe-zuweisen-dok-an");
  const mitDokument = zuweisenModus === "unterschrift" || (hakenEl && hakenEl.checked);
  if (mitDokument && !zuweisenPdfBytes) return zeige("Bitte eine PDF-Datei auswählen.");

  btn.disabled = true;
  try {
    if (mitDokument) {
      // Zwei Schritte: erst die Bytes ablegen, dann den Vorgang anlegen. Alle
      // Empfänger teilen sich dasselbe Original -- unterschrieben wird trotzdem
      // je Person eine eigene Kopie.
      const fileId = neueDateiId();
      await callWorker("dokument-datei-put", {
        id: fileId, zweck: "original", dataBase64: bytesZuBase64(zuweisenPdfBytes)
      });
      // mail = das Häkchen unten im Dialog. Ein fehlendes/false-Feld heißt beim
      // Worker "nicht verschicken" -- der alte Weg ohne Mail bleibt damit exakt der
      // Ausgangszustand, auch wenn ein alter Client den Schlüssel gar nicht kennt.
      const mailAn = document.getElementById("aufgabe-zuweisen-mail").checked;
      const dokRes = await callWorker("dokument-anlegen", {
        titel: text, faellig, empfaenger, originalFileId: fileId,
        feld: vorschauZuweisen.feld, mail: mailAn
      });
      schliesseAufgabeZuweisen();
      // Ein misslungener Versand darf den Vorgang nicht kippen -- er IST angelegt.
      // Aber er muss gesagt werden: sonst verlässt sich der Absender auf eine
      // Zustellung, die es nie gab (der Worker liefert die Zahlen dafür mit).
      if (mailAn && dokRes) {
        if (dokRes.mailAus) {
          aufgabenFehler("Angefordert — aber der E-Mail-Versand ist serverseitig nicht eingerichtet, es wurde nichts verschickt.");
        } else if (Array.isArray(dokRes.ohneAdresse) && dokRes.ohneAdresse.length) {
          aufgabenFehler("Angefordert. Ohne E-Mail-Adresse und deshalb nicht benachrichtigt: " + dokRes.ohneAdresse.join(", "));
        }
      }
      await Promise.all([loadAufgaben(), loadDokumente()]);
      return;
    }

    const res = await callWorker("aufgabe-zuweisen", { text, faellig, empfaenger });
    schliesseAufgabeZuweisen();
    if (res && Array.isArray(res.uebersprungen) && res.uebersprungen.length) {
      aufgabenFehler("Übersprungen (Liste voll): " + res.uebersprungen.join(", "));
    }
    await loadAufgaben(); // Rückkanal neu holen, damit die Zuweisung sofort dasteht
  } catch (e) {
    zeige(e && e.message ? e.message : "Zuweisen fehlgeschlagen.");
  } finally {
    btn.disabled = false;
  }
}

// ---- Admin: wer darf Unterschriften anfordern (Einstellungen-Tab) ----
//
// Bis 2026-07-29 zeichnete das Panel zwei Listen: assignGroupIds (wer darf anderen
// eine Aufgabe in die Liste legen) und dokumentGroupIds. Die erste ist ersatzlos
// weg -- sie schaltete seit dem Umzug des Zuweisens in die App Vereinsaufgaben
// nichts mehr. aufgabenState.assignGroupIds wird vom Worker weiterhin geliefert
// und bleibt bewusst ungenutzt; siehe den Kommentar an speichereAufgabenGruppen().

async function renderAufgabenAdminPanel() {
  const dokListeEl = document.getElementById("aufgaben-dok-gruppen-liste");
  if (!dokListeEl) return;
  const gesetzt = aufgabenState.dokumentGroupIds || [];
  try {
    const res = await callWorker("list-groups", {});
    const gruppen = Array.isArray(res && res.groups) ? res.groups : [];
    dokListeEl.innerHTML = gruppen.length
      ? gruppen.map((g) => `
          <label class="aufgaben-gruppen-zeile">
            <input type="checkbox" value="${escapeHtml(g.id)}" ${gesetzt.includes(g.id) ? "checked" : ""} />
            <span>${escapeHtml(g.name || g.id)}</span>
          </label>`).join("")
      : '<p class="muted">Es sind noch keine Gruppen angelegt.</p>';
  } catch (e) {
    dokListeEl.innerHTML = '<p class="muted">Gruppen konnten nicht geladen werden.</p>';
  }
}

async function speichereAufgabenGruppen() {
  const errorEl = document.getElementById("aufgaben-admin-error");
  const successEl = document.getElementById("aufgaben-admin-success");
  const metaEl = document.getElementById("aufgaben-admin-meta");
  errorEl.style.display = "none";
  successEl.style.display = "none";
  const dokumentGroupIds = Array.from(document.querySelectorAll("#aufgaben-dok-gruppen-liste input[type=checkbox]:checked")).map((c) => c.value);
  // groupIds (assignGroupIds) wird bewusst NICHT mitgeschickt, seit die zugehoerige
  // Haekchenreihe entfernt ist: der Worker liest ein FEHLENDES Feld als "unveraendert"
  // und bewahrt den gespeicherten Wert; ein mitgeschicktes [] wuerde ihn leeren. Der
  // Altbestand bereits zugewiesener Aufgaben bleibt damit zurueckziehbar. Wer die Reihe
  // je zurueckholt, muss beide Felder wieder gemeinsam schicken -- sonst kaeme ein
  // Abwaehlen serverseitig nicht an.
  try {
    const res = await callWorker("set-aufgaben-gruppen", { dokumentGroupIds });
    aufgabenState.assignGroupIds = Array.isArray(res && res.assignGroupIds) ? res.assignGroupIds : aufgabenState.assignGroupIds;
    aufgabenState.dokumentGroupIds = Array.isArray(res && res.dokumentGroupIds) ? res.dokumentGroupIds : dokumentGroupIds;
    successEl.style.display = "block";
    if (res && res.geaendertAm) {
      metaEl.textContent = "Zuletzt geändert am " + new Date(res.geaendertAm).toLocaleString("de-DE") + " von " + (res.geaendertVon || "");
    }
    await loadAufgaben(); // eigene Berechtigung kann sich damit geändert haben
  } catch (e) {
    errorEl.textContent = e && e.message ? e.message : "Speichern fehlgeschlagen.";
    errorEl.style.display = "block";
  }
}

// ---------- Dokumente zum Unterschreiben ----------
//
// Der Unterschied zum digitalen Stempel: dort legt jeder sein eigenes Bild an und
// setzt es auf ein beliebiges Dokument. Hier zeichnet die unterschreibende Person
// selbst, in ihrer eigenen Sitzung, und der Server hält fest, wer wann.

let dokumenteState = { anMich: [], vonMir: [], canAssignDocs: false, geladen: false };

// Zwei Bibliotheken, zusammen ~830 KB. Sie hängen an einer konkreten Handlung
// (ein PDF ansehen oder unterschreiben) und werden deshalb erst dann geholt --
// nicht bei jedem Seitenaufruf des Dashboards. Muster aus digitaler-stempel.
const dokBibliotheken = new Map();
function ladeBibliothek(url) {
  if (dokBibliotheken.has(url)) return dokBibliotheken.get(url);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => {
      dokBibliotheken.delete(url); // Fehlschlag vergessen, damit ein zweiter Versuch geht
      reject(new Error("Bibliothek konnte nicht geladen werden."));
    };
    document.head.appendChild(s);
  });
  dokBibliotheken.set(url, p);
  return p;
}
async function ladePdfJs() {
  // workerSrc erst NACH dem Laden setzen -- vorher gibt es kein pdfjsLib.
  await ladeBibliothek("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
function ladePdfLib() {
  return ladeBibliothek("https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js");
}

async function loadDokumente() {
  if (!currentUser || currentUser.art === "spieler") {
    dokumenteState = { anMich: [], vonMir: [], canAssignDocs: false, geladen: false };
    return;
  }
  try {
    const res = await callWorker("dokumente-load", {});
    dokumenteState = {
      anMich: Array.isArray(res && res.anMich) ? res.anMich : [],
      vonMir: Array.isArray(res && res.vonMir) ? res.vonMir : [],
      canAssignDocs: !!(res && res.canAssignDocs),
      geladen: true
    };
    renderDokumente();
  } catch (e) {
    dokumenteFehler(e && e.message ? e.message : "Dokumente konnten nicht geladen werden.");
  }
}

function dokumenteFehler(text) {
  const el = document.getElementById("dokumente-fehler");
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

function dokStatusText(d) {
  if (d.status === "unterschrieben") return "unterschrieben am " + new Date(d.unterschriebenAm).toLocaleString("de-DE");
  if (d.status === "abgelehnt") return "abgelehnt am " + new Date(d.abgelehntAm).toLocaleString("de-DE");
  return d.faellig ? "offen · bis " + formatCalendarDate(d.faellig) : "offen";
}

function renderDokumente() {
  const anMichEl = document.getElementById("dokumente-an-mich");
  const vonMirEl = document.getElementById("dokumente-von-mir");
  if (!anMichEl || !vonMirEl) return;

  const zeile = (d, rolle) => {
    const offen = d.status === "offen";
    const knoepfe = [];
    if (rolle === "empfaenger" && offen) {
      knoepfe.push('<button type="button" class="btn small dok-oeffnen">Ansehen & unterschreiben</button>');
    } else {
      knoepfe.push('<button type="button" class="btn small secondary dok-download-original">Original</button>');
    }
    if (d.status === "unterschrieben") {
      knoepfe.push('<button type="button" class="btn small dok-download-signiert">Unterschrieben herunterladen</button>');
    }
    if (rolle === "absender") {
      knoepfe.push('<button type="button" class="btn small secondary dok-loeschen">Löschen</button>');
    }
    const gegenueber = rolle === "empfaenger"
      ? "von " + escapeHtml(d.vonName || d.von)
      : "an " + escapeHtml(d.empfaengerName || d.empfaenger);
    return `
      <div class="dok-item status-${escapeHtml(d.status)}" data-dok-id="${escapeHtml(d.id)}">
        <div class="dok-item-kopf">
          <span class="dok-item-titel">${escapeHtml(d.titel || "")}</span>
          <span class="dok-item-status">${escapeHtml(dokStatusText(d))}</span>
        </div>
        <div class="dok-item-meta">${gegenueber}</div>
        ${d.status === "abgelehnt" && d.ablehnGrund
          ? `<div class="dok-item-grund">Begründung: ${escapeHtml(d.ablehnGrund)}</div>` : ""}
        <div class="dok-item-aktionen">${knoepfe.join("")}</div>
      </div>`;
  };

  anMichEl.innerHTML = dokumenteState.anMich.length
    ? dokumenteState.anMich.map((d) => zeile(d, "empfaenger")).join("")
    : '<p class="muted">Nichts zu unterschreiben.</p>';
  vonMirEl.innerHTML = dokumenteState.vonMir.length
    ? dokumenteState.vonMir.map((d) => zeile(d, "absender")).join("")
    : '<p class="muted">Du hast noch nichts zum Unterschreiben verschickt.</p>';

  // Der Bereich "Von mir verschickt" ist für alle sichtbar, die etwas verschickt
  // haben ODER verschicken dürfen -- sonst steht bei einem reinen Empfänger eine
  // leere Karte herum, deren Zweck er nie erlebt.
  const vonMirKarte = document.getElementById("dokumente-von-mir-karte");
  if (vonMirKarte) {
    vonMirKarte.style.display = (dokumenteState.vonMir.length || dokumenteState.canAssignDocs) ? "" : "none";
  }

  // Seit 2026-07-28 gibt es hier nur noch EINEN Vorgang: Unterschriften einfordern
  // (dokumentGroupIds). Das Zuweisen von Aufgaben ist in die App "Vereinsaufgaben"
  // gewandert, der zugehörige Knopf ist aus dem Markup entfernt. aufgabenState.canAssign
  // wird vom Worker weiterhin geliefert und bleibt hier bewusst ungenutzt — die
  // Aktion aufgabe-zuweisen existiert serverseitig noch (Altbestand an Zuweisungen
  // muss weiter abhakbar und zurückziehbar bleiben), sie hat nur keinen Einstieg
  // mehr in dieser Oberfläche.
  const unterschriftBtn = document.getElementById("btn-fenster-unterschrift");
  if (unterschriftBtn) unterschriftBtn.style.display = aufgabenState.canAssignDocs ? "" : "none";

  // "Selbst unterschreiben" haengt seit 2026-07-29 am SELBEN Recht (Michel-Vorgabe).
  // Es ist zwar kein Vereinsvorgang -- das PDF wird im Browser signiert und direkt
  // heruntergeladen, der Server sieht es nie --, aber es war der einzige Grund,
  // aus dem ein Trainer dieses Fenster ueberhaupt oeffnen konnte. Wer ein eigenes
  // Dokument stempeln will, hat dafuer weiterhin den digitalen Stempel.
  const selbstBtn = document.getElementById("btn-dokument-selbst");
  if (selbstBtn) selbstBtn.style.display = aufgabenState.canAssignDocs ? "" : "none";
}

// PDF-Bytes einer Datei holen. Der Worker löst die Datei-Id selbst aus dem
// Dokument auf -- der Client kann also keine fremde Id unterschieben.
async function dokumentDateiHolen(dokId, welche) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + loadStoredToken() },
    body: JSON.stringify({ action: "dokument-datei-get", dokId, welche })
  });
  if (!res.ok) {
    let msg = "Datei konnte nicht geladen werden.";
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function bytesAlsBlobOeffnen(bytes, dateiname) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = dateiname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- PDF-Vorschau mit aufziehbarem Unterschriftsfeld ----
//
// Position wird als Fraktion (0..1) der Seite gehalten, nie in Pixeln: der
// Absender sieht eine andere Vorschaugröße als der Empfänger, und gerechnet wird
// am Ende gegen die echte PDF-Seite.

function neueVorschau(canvasId, wrapId, markerId, anzeigeId) {
  return {
    doc: null, seite: 1, seiten: 1, feld: null, renderLauf: null,
    canvas: () => document.getElementById(canvasId),
    wrap: () => document.getElementById(wrapId),
    marker: () => document.getElementById(markerId),
    anzeige: () => document.getElementById(anzeigeId)
  };
}
let vorschauZuweisen = neueVorschau("dok-vorschau-canvas", "dok-canvas-wrap", "dok-feld-marker", "dok-seite-anzeige");
let vorschauSignieren = neueVorschau("dok-sig-canvas", "dok-sig-canvas-wrap", "dok-sig-feld-marker", "dok-sig-seite-anzeige");

async function vorschauLaden(v, bytes) {
  await ladePdfJs();
  // pdf.js übernimmt den Puffer -- eine eigene Kopie geben, sonst ist er beim
  // späteren Signieren mit pdf-lib "detached".
  v.doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  v.seiten = v.doc.numPages;
  v.seite = 1;
  await vorschauRendern(v);
}

async function vorschauRendern(v) {
  const canvas = v.canvas();
  if (!canvas || !v.doc) return;
  // Überlappende render()-Aufrufe auf demselben Canvas brechen pdf.js ab --
  // deshalb den laufenden Auftrag erst abwarten/abbrechen (Fix aus dem Stempel-Tool).
  if (v.renderLauf) { try { v.renderLauf.cancel(); } catch (_) {} }
  const page = await v.doc.getPage(v.seite);
  const wrap = v.wrap();
  const breite = Math.max(200, (wrap ? wrap.clientWidth : 0) || 600);
  const roh = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: breite / roh.width });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  v.renderLauf = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  try { await v.renderLauf.promise; } catch (_) { /* abgebrochen ist kein Fehler */ }
  v.renderLauf = null;
  const anzeige = v.anzeige();
  if (anzeige) anzeige.textContent = `Seite ${v.seite} / ${v.seiten}`;
  markerZeichnen(v);
}

function markerZeichnen(v) {
  const marker = v.marker();
  const canvas = v.canvas();
  if (!marker || !canvas) return;
  if (!v.feld || v.feld.seite !== v.seite) { marker.style.display = "none"; return; }
  marker.style.display = "block";
  marker.style.left = (v.feld.x * canvas.clientWidth) + "px";
  marker.style.top = (v.feld.y * canvas.clientHeight) + "px";
  marker.style.width = (v.feld.w * canvas.clientWidth) + "px";
  marker.style.height = (v.feld.h * canvas.clientHeight) + "px";
  // Sobald etwas unterschrieben ist, zeigt das Rechteck die ECHTE Unterschrift
  // statt eines leeren Kastens -- man sieht dann vor dem Export, wie das Blatt
  // wirklich aussieht, statt es raten zu müssen.
  if (v.signatur) {
    marker.style.backgroundImage = "url(" + v.signatur + ")";
    marker.classList.add("mit-unterschrift");
  } else {
    marker.style.backgroundImage = "";
    marker.classList.remove("mit-unterschrift");
  }
}

// Verbindet das Signaturfeld mit der Seitenvorschau: jeder fertige Strich
// aktualisiert das platzierte Bild sofort.
function signaturInVorschauSpiegeln(v, dataUrl) {
  v.signatur = dataUrl || "";
  markerZeichnen(v);
  dokSigStatusZeigen();
}

// Hat der Absender eine Stelle vorgegeben? Nur dann ist das Feld für den
// Unterzeichner gesperrt. Eigene Funktion, weil dieselbe Frage an drei Stellen
// beantwortet werden muss (Anzeige, Ziehen, Text) und sie sonst auseinanderliefe.
function dokSigStelleVorgegeben() {
  return !!(dokSigModus === "zugewiesen" && dokSigAktuell && dokSigAktuell.feld);
}

// Sagt an, woran es noch fehlt -- in BEIDEN Modi. Bis 2026-07-29 schwieg die
// Zeile beim zugewiesenen Dokument ganz; wer dort ein Rechteck aufzog, sah es
// beim Loslassen kommentarlos verschwinden und hielt das für einen Fehler.
function dokSigStatusZeigen() {
  const el = document.getElementById("dok-sig-platz-info");
  if (!el) return;
  el.style.display = "";

  if (dokSigModus !== "selbst") {
    if (dokSigStelleVorgegeben()) {
      const wer = dokSigAktuell.vonName || dokSigAktuell.von || "der Absender";
      el.textContent = `Die Stelle für die Unterschrift hat ${wer} auf Seite ${dokSigAktuell.feld.seite} festgelegt — sie lässt sich hier nicht verschieben.`;
    } else if (vorschauSignieren.feld) {
      el.textContent = `Unterschrift steht auf Seite ${vorschauSignieren.feld.seite}.` +
        (vorschauSignieren.signatur ? "" : " — jetzt noch unten unterschreiben.");
    } else {
      el.textContent = "Es ist keine Stelle vorgegeben: zieh ein Rechteck dorthin, wo deine Unterschrift stehen soll. Ohne Auswahl kommt sie auf ein zusätzliches Blatt am Ende.";
    }
    return;
  }

  if (!dokSigOriginalBytes) {
    el.textContent = "Wähle zuerst eine PDF-Datei aus.";
  } else if (!vorschauSignieren.feld) {
    el.textContent = "Unterschreibe unten und ziehe dann ein Rechteck auf die Stelle, an der die Unterschrift stehen soll.";
  } else {
    el.textContent = `Unterschrift steht auf Seite ${vorschauSignieren.feld.seite}.` +
      (vorschauSignieren.signatur ? "" : " — jetzt noch unten unterschreiben.");
  }
}

// Rechteck aufziehen. Alles in Fraktionen, und mit Guard gegen ein Canvas ohne
// Ausdehnung -- ein unsichtbarer Container liefert 0 und erzeugte im Stempel-Tool
// NaN-Positionen.
function vorschauZiehenAktivieren(v, onFertig) {
  const wrap = v.wrap();
  if (!wrap || wrap.dataset.ziehenAktiv === "1") return;
  wrap.dataset.ziehenAktiv = "1";
  let start = null;
  wrap.addEventListener("pointerdown", (e) => {
    const canvas = v.canvas();
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
    const r = canvas.getBoundingClientRect();
    start = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!start) return;
    const canvas = v.canvas();
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const jetzt = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    v.feld = {
      seite: v.seite,
      x: Math.max(0, Math.min(start.x, jetzt.x)),
      y: Math.max(0, Math.min(start.y, jetzt.y)),
      w: Math.min(1, Math.abs(jetzt.x - start.x)),
      h: Math.min(1, Math.abs(jetzt.y - start.y))
    };
    markerZeichnen(v);
  });
  const ende = () => {
    if (!start) return;
    start = null;
    // Ein Klick ohne Ziehen ist keine Auswahl, sondern ein Fehlgriff.
    if (v.feld && (v.feld.w < 0.02 || v.feld.h < 0.01)) { v.feld = null; markerZeichnen(v); }
    if (onFertig) onFertig();
  };
  wrap.addEventListener("pointerup", ende);
  wrap.addEventListener("pointercancel", ende);
}

// ---- Signieren: Unterschrift + Nachweiszeile ins PDF brennen ----

async function pdfMitUnterschrift(originalBytes, feld, signaturDataUrl, name) {
  await ladePdfLib();
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.load(originalBytes);
  const png = await pdf.embedPng(signaturDataUrl);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const zeile = `${name}, ${new Date().toLocaleString("de-DE")}`;

  if (feld) {
    const seiten = pdf.getPages();
    // Ein Feld auf einer Seite, die es nicht (mehr) gibt, darf nicht zum Absturz
    // führen -- dann lieber hinten anhängen.
    const seite = seiten[feld.seite - 1];
    if (seite) {
      const { width, height } = seite.getSize();
      const w = feld.w * width;
      const h = feld.h * height;
      // PDF zählt y von UNTEN, die Vorschau von oben.
      const x = feld.x * width;
      const y = height - (feld.y * height) - h;
      seite.drawImage(png, { x, y: y + 10, width: w, height: Math.max(1, h - 10) });
      seite.drawText(zeile, { x, y: Math.max(2, y - 2), size: 7, font, color: rgb(0.25, 0.25, 0.25) });
      return await pdf.save();
    }
  }

  // Kein (brauchbares) Feld: eigene Nachweisseite hinten anhängen.
  const seite = pdf.addPage();
  const { width, height } = seite.getSize();
  seite.drawText("Unterschrift", { x: 60, y: height - 80, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
  seite.drawImage(png, { x: 60, y: height - 220, width: Math.min(260, width - 120), height: 90 });
  seite.drawText(zeile, { x: 60, y: height - 240, size: 9, font, color: rgb(0.25, 0.25, 0.25) });
  return await pdf.save();
}

function bytesZuBase64(bytes) {
  let s = "";
  // In Blöcken, sonst sprengt ein großes PDF den Argument-Stack von String.fromCharCode.
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
  }
  return btoa(s);
}

// Blob.arrayBuffer() gibt es erst ab iOS 14 -- auf den älteren Geräten in der
// Flotte schlüge das Auswählen einer PDF sonst stumm fehl. FileReader kann das
// seit jeher.
function dateiAlsBytes(datei) {
  if (typeof datei.arrayBuffer === "function") {
    return datei.arrayBuffer().then((b) => new Uint8Array(b));
  }
  return new Promise((resolve, reject) => {
    const leser = new FileReader();
    leser.onload = () => resolve(new Uint8Array(leser.result));
    leser.onerror = () => reject(new Error("Die Datei konnte nicht gelesen werden."));
    leser.readAsArrayBuffer(datei);
  });
}

function neueDateiId() {
  // Der Worker verlangt echtes UUID-Format; ältere iOS-Geräte in der Flotte haben
  // kein crypto.randomUUID, deshalb der Rückfallweg.
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : ((r & 0x3) | 0x8)).toString(16);
  });
}

// ---- Overlay: unterschreiben ----

let dokSigModus = "zugewiesen"; // oder "selbst"
let dokSigAktuell = null;       // das Dokument (Modus zugewiesen)
let dokSigOriginalBytes = null;
let dokSigPad = null;

function dokSigFehler(text) {
  const el = document.getElementById("dok-sig-fehler");
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

async function oeffneDokumentAnsicht(dokId) {
  const dok = dokumenteState.anMich.find((d) => d.id === dokId);
  if (!dok) return dokumenteFehler("Dokument nicht gefunden.");
  dokSigModus = "zugewiesen";
  dokSigAktuell = dok;
  dokSigOriginalBytes = null;
  vorschauSignieren.feld = dok.feld || null;

  document.getElementById("dokument-signieren-titel").textContent = dok.titel || "Dokument unterschreiben";
  document.getElementById("dok-sig-selbst-block").style.display = "none";
  document.getElementById("btn-dok-sig-ablehnen").style.display = "";
  document.getElementById("dok-sig-meta").textContent =
    "von " + (dok.vonName || dok.von) + (dok.faellig ? " · bis " + formatCalendarDate(dok.faellig) : "");
  dokSigFehler("");
  dokSigOverlayZeigen();

  try {
    dokSigOriginalBytes = await dokumentDateiHolen(dok.id, "original");
    await vorschauLaden(vorschauSignieren, dokSigOriginalBytes);
  } catch (e) {
    dokSigFehler(e && e.message ? e.message : "Dokument konnte nicht geladen werden.");
  }
}

function oeffneSelbstUnterschreiben() {
  dokSigModus = "selbst";
  dokSigAktuell = null;
  dokSigOriginalBytes = null;
  vorschauSignieren.doc = null;
  vorschauSignieren.feld = null;
  document.getElementById("dokument-signieren-titel").textContent = "Selbst unterschreiben";
  document.getElementById("dok-sig-selbst-block").style.display = "";
  document.getElementById("btn-dok-sig-ablehnen").style.display = "none";
  document.getElementById("dok-sig-meta").textContent = "";
  document.getElementById("dok-sig-titel").value = "";
  document.getElementById("dok-sig-datei").value = "";
  const canvas = document.getElementById("dok-sig-canvas");
  if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  dokSigFehler("");
  dokSigOverlayZeigen();
}

function dokSigOverlayZeigen() {
  const overlay = document.getElementById("dokument-signieren-overlay");
  if (!overlay) return;
  overlay.style.display = "flex";
  // Das Pad erst hier erzeugen und in jedem Fall neu vermessen: sein Canvas lag
  // bis eben hinter display:none und hätte sonst ein 0x0-Bitmap. Der onChange
  // spiegelt jeden fertigen Strich sofort an die platzierte Stelle.
  if (!dokSigPad) {
    dokSigPad = createSignaturePad(
      document.getElementById("dok-sig-pad"),
      (dataUrl) => signaturInVorschauSpiegeln(vorschauSignieren, dataUrl)
    );
  }
  dokSigPad.resetSilent();
  dokSigPad.resize();
  vorschauSignieren.signatur = "";
  markerZeichnen(vorschauSignieren);
  dokSigStatusZeigen();
  document.getElementById("dok-sig-original-laden").style.display = dokSigAktuell ? "" : "none";
  // Beim eigenen Dokument ist das Ergebnis ein Download, kein Vorgang mit Gegenüber.
  document.getElementById("btn-dok-sig-senden").textContent =
    dokSigModus === "selbst" ? "Unterschreiben & herunterladen" : "Unterschreiben";
}

function schliesseDokSigOverlay() {
  const overlay = document.getElementById("dokument-signieren-overlay");
  if (overlay) overlay.style.display = "none";
}

async function dokumentUnterschreibenSenden() {
  const btn = document.getElementById("btn-dok-sig-senden");
  dokSigFehler("");
  if (!dokSigPad || dokSigPad.isEmpty()) return dokSigFehler("Bitte zuerst unterschreiben.");
  if (!dokSigOriginalBytes) return dokSigFehler("Es ist kein Dokument geladen.");
  // Beim eigenen Dokument ist das Platzieren Pflicht -- dann entsteht nie ein
  // zusätzliches Blatt am Ende. Die Ausweichseite bleibt dem zugewiesenen Fall
  // vorbehalten, wo der Absender bewusst keine Stelle vorgegeben hat und man
  // sonst gar nicht unterschreiben könnte.
  if (dokSigModus === "selbst" && !vorschauSignieren.feld) {
    return dokSigFehler("Bitte zieh noch ein Rechteck auf die Stelle im Dokument, an der die Unterschrift stehen soll.");
  }

  const name = currentUser
    ? [currentUser.vorname, currentUser.nachname].filter(Boolean).join(" ") || currentUser.username
    : "";

  btn.disabled = true;
  try {
    const signiert = await pdfMitUnterschrift(
      dokSigOriginalBytes, vorschauSignieren.feld, dokSigPad.toDataURL(), name
    );
    const bytes = new Uint8Array(signiert);

    if (dokSigModus === "selbst") {
      // Ohne Zuweisung bleibt nichts auf dem Server liegen: das ist der Ersatz
      // fürs eigene Stempeln, kein Vorgang mit Gegenüber.
      bytesAlsBlobOeffnen(bytes, (document.getElementById("dok-sig-titel").value || "unterschrieben") + ".pdf");
      schliesseDokSigOverlay();
      return;
    }

    const fileId = neueDateiId();
    await callWorker("dokument-datei-put", {
      id: fileId, zweck: "signiert", dokId: dokSigAktuell.id,
      dataBase64: bytesZuBase64(bytes)
    });
    await callWorker("dokument-unterschreiben", { dokId: dokSigAktuell.id, signedFileId: fileId });
    schliesseDokSigOverlay();
    await Promise.all([loadDokumente(), loadAufgaben()]);
  } catch (e) {
    dokSigFehler(e && e.message ? e.message : "Unterschreiben fehlgeschlagen.");
  } finally {
    btn.disabled = false;
  }
}

async function dokumentAblehnenSenden() {
  if (!dokSigAktuell) return;
  const grund = prompt("Warum möchtest du nicht unterschreiben?\n(Die Begründung geht an " +
    (dokSigAktuell.vonName || dokSigAktuell.von) + ".)");
  if (grund === null) return;
  if (!grund.trim()) return dokSigFehler("Bitte eine Begründung angeben.");
  try {
    await callWorker("dokument-ablehnen", { dokId: dokSigAktuell.id, grund: grund.trim() });
    schliesseDokSigOverlay();
    await Promise.all([loadDokumente(), loadAufgaben()]);
  } catch (e) {
    dokSigFehler(e && e.message ? e.message : "Ablehnen fehlgeschlagen.");
  }
}

// Öffnet das Unterschriften-Fenster und lädt den Inhalt nach. Der Header-Knopf und
// der Weg aus dem Aufgaben-Widget landen beide hier.
async function oeffneDokumenteFenster() {
  const overlay = document.getElementById("dokumente-overlay");
  if (!overlay) return;
  dokumenteFehler("");
  overlay.style.display = "flex";
  // Die Aufgaben kommen mit, obwohl sie hier nichts rendern: aus ihnen speist sich
  // der Zähler am Kopf-Knopf, und eine gerade geleistete Unterschrift soll ihn
  // sofort kleiner machen.
  await Promise.all([loadDokumente(), loadAufgaben()]);
  markiereAufgabenGesehen(true);
}

function schliesseDokumenteFenster() {
  const overlay = document.getElementById("dokumente-overlay");
  if (overlay) overlay.style.display = "none";
  // Beim Öffnen wurden die neuen Zuweisungen als gesehen markiert -- allerdings
  // nur im Zustand, ohne neu zu rendern (das würde die Liste unter dem Finger
  // umsortieren). Ohne diesen Aufruf behielte der Kopf-Knopf sein Signal, obwohl
  // man gerade nachgesehen hat.
  renderAufgabenWidget();
}

function dokumenteFensterOffen() {
  const overlay = document.getElementById("dokumente-overlay");
  return !!overlay && overlay.style.display === "flex";
}

// Persönliche ToDos: eigenes Fenster am rechten Kopf-Knopf (Michel-Vorgabe
// 2026-07-29). Gleicher Bauplan wie das Unterschriften-Fenster, nur ohne
// Nachladen von Dokumenten -- hier steht nichts, was von dokumente.json käme.
async function oeffneTodosFenster() {
  const overlay = document.getElementById("todos-overlay");
  if (!overlay) return;
  overlay.style.display = "flex";
  // Frisch holen: die Liste kann auf einem anderen Gerät gewachsen sein, und der
  // Stand aus dem Seitenaufruf ist bei einem lange offenen Tab der Normalfall.
  // renderAufgabenWidget() meldet danach von selbst "gesehen" (Fenster ist offen).
  await loadAufgaben();
}

function schliesseTodosFenster() {
  const overlay = document.getElementById("todos-overlay");
  if (overlay) overlay.style.display = "none";
  // Wie beim Unterschriften-Fenster: die Gesehen-Markierung steht nur im Zustand,
  // der Kopf-Zähler übernimmt sie erst beim nächsten Rendern.
  renderAufgabenWidget();
}

function todosFensterOffen() {
  const overlay = document.getElementById("todos-overlay");
  return !!overlay && overlay.style.display === "flex";
}

function setupDokumenteTab() {
  const tab = document.getElementById("dokumente-overlay");
  if (!tab) return;

  document.getElementById("btn-dokumente-neuladen").addEventListener("click", loadDokumente);
  document.getElementById("btn-dokument-selbst").addEventListener("click", oeffneSelbstUnterschreiben);
  document.getElementById("btn-dokumente-oeffnen").addEventListener("click", oeffneDokumenteFenster);
  document.getElementById("btn-dokumente-close").addEventListener("click", schliesseDokumenteFenster);
  // btn-fenster-zuweisen gibt es seit 2026-07-28 nicht mehr (Aufgaben zuweisen ist
  // in die App "Vereinsaufgaben" gewandert). Der Handler MUSS mit dem Knopf weg:
  // getElementById liefert sonst null und der TypeError bricht setupDokumenteTab()
  // mitten in der Registrierung ab -- alle danach folgenden Handler (Escape,
  // Unterschrift) wären tot, und zwar lautlos.
  document.getElementById("btn-fenster-unterschrift").addEventListener("click", () => oeffneAufgabeZuweisen("unterschrift"));
  tab.addEventListener("click", (e) => { if (e.target === tab) schliesseDokumenteFenster(); });
  document.addEventListener("keydown", (e) => {
    // Nur schließen, wenn KEIN Dialog darüber liegt -- die haben ihre eigenen
    // Escape-Handler; sonst gingen zwei Ebenen auf einen Druck zu.
    //
    // ZWEI Prüfungen, weil beide Reihenfolgen vorkommen: der Zuweisen-Dialog
    // hängt seinen Handler FRÜHER an document als dieser hier, hat beim Eintreffen
    // also schon geschlossen -- da hilft nur die Markierung am Event. Der
    // Signier-Dialog hängt seinen SPÄTER an, ist hier also noch offen -- da greift
    // die Sichtprüfung. Eine allein liesse jeweils die andere Reihenfolge durch.
    if (e.key !== "Escape" || !dokumenteFensterOffen() || e.escapeVerbraucht) return;
    const darueber = ["dokument-signieren-overlay", "aufgaben-zuweisen-overlay"]
      .some((id) => { const el = document.getElementById(id); return el && el.style.display === "flex"; });
    if (!darueber) schliesseDokumenteFenster();
  });

  tab.addEventListener("click", async (e) => {
    const item = e.target.closest(".dok-item");
    if (!item) return;
    const dokId = item.dataset.dokId;
    const alle = dokumenteState.anMich.concat(dokumenteState.vonMir);
    const dok = alle.find((d) => d.id === dokId);
    dokumenteFehler("");
    try {
      if (e.target.closest(".dok-oeffnen")) {
        await oeffneDokumentAnsicht(dokId);
      } else if (e.target.closest(".dok-download-original")) {
        bytesAlsBlobOeffnen(await dokumentDateiHolen(dokId, "original"), (dok ? dok.titel : "dokument") + ".pdf");
      } else if (e.target.closest(".dok-download-signiert")) {
        bytesAlsBlobOeffnen(await dokumentDateiHolen(dokId, "signiert"), (dok ? dok.titel : "dokument") + " (unterschrieben).pdf");
      } else if (e.target.closest(".dok-loeschen")) {
        if (!confirm("Dieses Dokument endgültig löschen? Auch das unterschriebene Exemplar wird entfernt.")) return;
        await callWorker("dokument-loeschen", { dokId });
        await loadDokumente();
      }
    } catch (err) {
      dokumenteFehler(err && err.message ? err.message : "Aktion fehlgeschlagen.");
    }
  });

  // Overlay
  document.getElementById("btn-dokument-signieren-close").addEventListener("click", schliesseDokSigOverlay);
  document.getElementById("btn-dok-sig-abbrechen").addEventListener("click", schliesseDokSigOverlay);
  document.getElementById("btn-dok-sig-senden").addEventListener("click", dokumentUnterschreibenSenden);
  document.getElementById("btn-dok-sig-ablehnen").addEventListener("click", dokumentAblehnenSenden);
  document.getElementById("btn-dok-sig-pad-clear").addEventListener("click", () => { if (dokSigPad) dokSigPad.clear(); });
  document.getElementById("dok-sig-seite-zurueck").addEventListener("click", async () => {
    if (vorschauSignieren.seite > 1) { vorschauSignieren.seite--; await vorschauRendern(vorschauSignieren); dokSigStatusZeigen(); }
  });
  document.getElementById("dok-sig-seite-vor").addEventListener("click", async () => {
    if (vorschauSignieren.seite < vorschauSignieren.seiten) { vorschauSignieren.seite++; await vorschauRendern(vorschauSignieren); dokSigStatusZeigen(); }
  });
  document.getElementById("dok-sig-original-laden").addEventListener("click", async () => {
    if (!dokSigAktuell) return;
    try {
      bytesAlsBlobOeffnen(await dokumentDateiHolen(dokSigAktuell.id, "original"), (dokSigAktuell.titel || "dokument") + ".pdf");
    } catch (e) { dokSigFehler(e && e.message ? e.message : "Download fehlgeschlagen."); }
  });
  // Gesperrt ist das Feld nur, wenn der Absender eine Stelle VORGEGEBEN hat --
  // sonst wäre seine Vorgabe wirkungslos. Hat er keine gesetzt, darf der
  // Unterzeichner selbst platzieren: es gibt dann nichts zu überschreiben, und
  // die Alternative wäre ein zusätzliches Blatt hinten, obwohl er genau weiß,
  // wohin die Unterschrift gehört.
  //
  // ⚠️ Bis 2026-07-29 setzte dieser Zweig das Feld in JEDEM zugewiesenen Fall auf
  // dokSigAktuell.feld zurück. Ohne Vorgabe war das null -- das eben aufgezogene
  // Rechteck verschwand beim Loslassen kommentarlos (von Michel als Fehler
  // gemeldet, im Preview reproduziert). Das Zurücksetzen bleibt für den Fall MIT
  // Vorgabe, aber nicht mehr stumm.
  vorschauZiehenAktivieren(vorschauSignieren, () => {
    if (dokSigStelleVorgegeben()) {
      vorschauSignieren.feld = dokSigAktuell.feld;
      markerZeichnen(vorschauSignieren);
    }
    dokSigStatusZeigen();
  });
  document.getElementById("dok-sig-datei").addEventListener("change", async (e) => {
    const datei = e.target.files && e.target.files[0];
    if (!datei) return;
    dokSigFehler("");
    if (datei.size > 10 * 1024 * 1024) return dokSigFehler("Die Datei ist größer als 10 MB.");
    try {
      dokSigOriginalBytes = await dateiAlsBytes(datei);
      vorschauSignieren.feld = null;
      await vorschauLaden(vorschauSignieren, dokSigOriginalBytes);
      dokSigStatusZeigen();
    } catch (err) {
      dokSigOriginalBytes = null;
      dokSigFehler("Die PDF konnte nicht gelesen werden.");
      dokSigStatusZeigen();
    }
  });

  const overlay = document.getElementById("dokument-signieren-overlay");
  overlay.addEventListener("click", (e) => { if (e.target === overlay) schliesseDokSigOverlay(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.style.display === "flex") {
      e.escapeVerbraucht = true; // siehe Kommentar am Fenster-Handler
      schliesseDokSigOverlay();
    }
  });
}

// ---- Admin: Neuigkeiten verwalten (Einstellungen-Tab) ----

function newsToolOptionsOnce() {
  const sel = document.getElementById("news-tool");
  if (!sel || sel.dataset.filled === "1") return;
  TOOLS.forEach((t) => {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.name;
    sel.appendChild(o);
  });
  sel.dataset.filled = "1";
}

function newsFormReset() {
  const f = document.getElementById("news-form");
  if (!f) return;
  document.getElementById("news-edit-id").value = "";
  document.getElementById("news-type").value = "neu";
  document.getElementById("news-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("news-tool").value = "";
  document.getElementById("news-title").value = "";
  document.getElementById("news-text").value = "";
  document.getElementById("news-video-url").value = "";
  newsMedienEntwurf = [];
  newsMedienEditorRendern();
  document.getElementById("btn-news-submit").textContent = "Hinzufügen";
  document.getElementById("btn-news-cancel").style.display = "none";
}

function startEditNews(id) {
  const n = newsState.find((x) => x.id === id);
  if (!n) return;
  document.getElementById("news-edit-id").value = n.id;
  document.getElementById("news-type").value = n.type || "neu";
  document.getElementById("news-date").value = /^\d{4}-\d{2}-\d{2}$/.test(n.date || "") ? n.date : new Date().toISOString().slice(0, 10);
  document.getElementById("news-tool").value = n.toolId || "";
  document.getElementById("news-title").value = n.title || "";
  document.getElementById("news-text").value = n.text || "";
  document.getElementById("news-video-url").value = n.videoUrl || "";
  // Kopie, nicht die Referenz: sonst schriebe ein "Entfernen" im Formular direkt
  // in newsState und wäre auch dann weg, wenn der Admin auf Abbrechen drückt.
  newsMedienEntwurf = (Array.isArray(n.medien) ? n.medien : []).map((m) => ({ ...m }));
  newsMedienEditorRendern();
  document.getElementById("btn-news-submit").textContent = "Änderung speichern";
  document.getElementById("btn-news-cancel").style.display = "inline-block";
  document.getElementById("admin-news-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function deleteNews(id) {
  if (!confirm("Diese Meldung wirklich löschen?")) return;
  const prev = newsState.slice();
  newsState = newsState.filter((x) => x.id !== id);
  await persistNews(prev);
}

// Speichert newsState serverseitig; bei Fehler Rollback auf den vorherigen Stand.
async function persistNews(prevOnError) {
  const errorEl = document.getElementById("news-error");
  const successEl = document.getElementById("news-success");
  errorEl.style.display = "none";
  successEl.style.display = "none";
  try {
    const res = await callWorker("save-news", { news: newsState });
    if (res && Array.isArray(res.news)) newsState = res.news;
    newsCarouselIndex = 0;
    renderNews();
    renderNewsAdmin();
    successEl.style.display = "block";
  } catch (err) {
    if (prevOnError) newsState = prevOnError;
    renderNewsAdmin();
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
  }
}

function renderNewsAdmin() {
  const list = document.getElementById("news-admin-list");
  if (!list) return;
  newsToolOptionsOnce();
  const sorted = newsState.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  if (sorted.length === 0) {
    list.innerHTML = '<p class="muted">Noch keine Meldungen.</p>';
    return;
  }
  list.innerHTML = sorted.map((n) => {
    const tool = n.toolId ? toolById(n.toolId) : null;
    const type = String(n.type || "hinweis");
    return `
      <div class="news-admin-row" data-id="${escapeHtml(n.id || "")}">
        <div class="news-admin-main">
          <div class="news-item-head">
            <span class="news-badge news-badge-${escapeHtml(type)}">${escapeHtml(NEWS_TYPE_LABELS[type] || type)}</span>
            <span class="news-date">${escapeHtml(formatNewsDate(n.date))}</span>
          </div>
          <div class="news-item-title">${escapeHtml(n.title || "")}</div>
          ${n.text ? `<div class="news-item-text">${escapeHtml(n.text)}</div>` : ""}
          ${tool ? `<div class="muted" style="font-size:12px; margin-top:2px;">→ ${escapeHtml(tool.name)}</div>` : ""}
        </div>
        <div class="news-admin-actions">
          <button type="button" class="btn secondary small news-edit-btn">Bearbeiten</button>
          <button type="button" class="btn danger small news-del-btn">Löschen</button>
        </div>
      </div>`;
  }).join("");
  list.querySelectorAll(".news-admin-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".news-edit-btn").addEventListener("click", () => startEditNews(id));
    row.querySelector(".news-del-btn").addEventListener("click", () => deleteNews(id));
  });
}

// ---------- Medien-Anhänge der Neuigkeiten (seit 2026-08-03) ----------
//
// ⚠️ Die Dateien liegen NICHT in der Meldung, sondern im Nextcloud-Ordner
// neuigkeiten/ -- in sichtbarkeit.json steht nur die Id. Diese Datei wird bei
// JEDEM Seitenaufruf gelesen, um die Kachel-Sichtbarkeit zu bestimmen; ein
// eingebettetes base64-Bild schleppte jeder einzelne Aufruf der Startseite mit.

const NEWS_MEDIEN_MAX = 4;
const NEWS_MEDIEN_MAX_BYTES = 10 * 1024 * 1024;

// Anhänge der Meldung, die gerade im Formular bearbeitet wird.
let newsMedienEntwurf = [];

// id -> Objekt-URL. Ohne Cache lädt jeder Klick auf den Karussell-Pfeil dieselben
// Bilder erneut, und jedes createObjectURL ohne revoke ist ein Leck.
const newsMedienBlobs = new Map();

// ⚠️ Der Abruf verlangt den Token (Neuigkeiten sind login-gated), ein einfaches
// <img src="..."> geht deshalb nicht -- die Bytes müssen geholt und als
// Objekt-URL eingehängt werden.
async function newsMedienUrl(m) {
  if (!m || !m.id) return null;
  const vorhanden = newsMedienBlobs.get(m.id);
  if (vorhanden) return vorhanden;
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + loadStoredToken() },
    body: JSON.stringify({ action: "news-datei-get", id: m.id })
  });
  if (!res.ok) {
    let msg = "Die Datei konnte nicht geladen werden.";
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  const url = URL.createObjectURL(await res.blob());
  newsMedienBlobs.set(m.id, url);
  return url;
}

// Beim Abmelden alles freigeben -- eine Objekt-URL bleibt sonst gültig, solange
// die Seite offen ist, und die Meldungen sind Vereinsinterna. Gleiche Linie wie
// das innerHTML-Leeren in renderNews().
function newsMedienBlobsLeeren() {
  newsMedienBlobs.forEach((url) => { try { URL.revokeObjectURL(url); } catch (_) {} });
  newsMedienBlobs.clear();
}

function newsMedienEditorRendern() {
  const box = document.getElementById("news-medien-edit");
  if (!box) return;
  if (!newsMedienEntwurf.length) {
    box.innerHTML = '<p class="muted" style="font-size:13px; margin:0 0 8px;">Noch nichts angehängt.</p>';
    return;
  }
  box.innerHTML = newsMedienEntwurf.map((m, i) =>
    '<div class="news-medien-zeile">'
    + '<span class="news-medien-art">' + (m.art === "video" ? "🎬" : "🖼️") + '</span>'
    + '<span class="news-medien-titel">' + escapeHtml(m.name || (m.art === "video" ? "Video" : "Bild")) + '</span>'
    + '<button type="button" class="btn danger small news-medien-weg" data-i="' + i + '">Entfernen</button>'
    + '</div>').join("");
  box.querySelectorAll(".news-medien-weg").forEach((b) => {
    b.addEventListener("click", () => {
      newsMedienEntwurf.splice(Number(b.dataset.i), 1);
      newsMedienEditorRendern();
    });
  });
}

// ⚠️ Die Datei geht sofort raus, nicht erst beim Speichern der Meldung. Sonst
// müsste der Submit mehrere Uploads bündeln und bei einem Fehler mittendrin
// zurückrollen. Bricht der Admin danach ab, bleibt eine verwaiste Datei liegen --
// über news-datei-get ist sie nicht erreichbar, weil dort gegen die Meldungen
// geprüft wird. Gleiches akzeptiertes Muster wie beim Unterschriften-Upload.
async function newsMedienDateiGewaehlt(datei) {
  const errorEl = document.getElementById("news-error");
  if (errorEl) errorEl.style.display = "none";
  if (!datei) return;
  const meldung = (text) => {
    if (!errorEl) return;
    errorEl.textContent = text;
    errorEl.style.display = "block";
  };
  if (newsMedienEntwurf.length >= NEWS_MEDIEN_MAX) {
    meldung("Mehr als " + NEWS_MEDIEN_MAX + " Anhänge gehen nicht.");
    return;
  }
  // Vor dem Lesen prüfen: eine 200-MB-Datei erst komplett einzulesen und dann am
  // Server abzulehnen, kostet den Nutzer eine Minute für ein absehbares Nein.
  if (datei.size > NEWS_MEDIEN_MAX_BYTES) {
    meldung("Die Datei ist " + (datei.size / 1024 / 1024).toFixed(1)
      + " MB groß — hochladen lassen sich 10 MB. Für längere Videos gibt es das Link-Feld darunter.");
    return;
  }
  const btn = document.getElementById("btn-news-medien-add");
  const beschriftung = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Lädt hoch…"; }
  try {
    const bytes = await dateiAlsBytes(datei);
    const id = neueDateiId();
    const res = await callWorker("news-datei-put", { id, dataBase64: bytesZuBase64(bytes) });
    newsMedienEntwurf.push({ id, mime: res.mime, art: res.art, name: datei.name || "" });
    newsMedienEditorRendern();
  } catch (e) {
    meldung(e && e.message ? e.message : "Hochladen fehlgeschlagen.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = beschriftung; }
  }
}

async function newsMedienOverlayOeffnen(m) {
  const ov = document.getElementById("news-medien-overlay");
  const buehne = document.getElementById("news-medien-buehne");
  if (!ov || !buehne) return;
  buehne.innerHTML = '<p class="muted">Lädt…</p>';
  const nameEl = document.getElementById("news-medien-name");
  if (nameEl) nameEl.textContent = m.name || "";
  ov.style.display = "flex";
  try {
    const url = await newsMedienUrl(m);
    // playsinline: iOS spielt ein Video sonst zwangsweise im Vollbild ab und
    // reißt den Nutzer aus der Seite.
    buehne.innerHTML = m.art === "video"
      ? '<video src="' + url + '" controls playsinline preload="metadata"></video>'
      : '<img src="' + url + '" alt="' + escapeHtml(m.name || "Bild zur Meldung") + '" />';
  } catch (e) {
    buehne.innerHTML = '<p class="muted">' + escapeHtml(e && e.message ? e.message : "Die Datei konnte nicht geladen werden.") + '</p>';
  }
}

function newsMedienOverlaySchliessen() {
  const ov = document.getElementById("news-medien-overlay");
  if (!ov) return;
  ov.style.display = "none";
  // ⚠️ Inhalt leeren, nicht nur ausblenden: ein laufendes Video spielte hinter
  // dem geschlossenen Fenster weiter und wäre nur noch zu hören.
  const buehne = document.getElementById("news-medien-buehne");
  if (buehne) buehne.innerHTML = "";
}

// Vorschau-Streifen unter der Meldung. Michel-Vorgabe 2026-08-03: klein zeigen,
// Klick öffnet groß -- das Karussell steht ganz oben auf der Startseite und
// schöbe die Kacheln sonst bei jeder bebilderten Meldung nach unten.
//
// ⚠️ Der Streifen steht AUSSERHALB von .news-item. Ist ein Tool verknüpft, ist
// das ein <a>, und ein <button> darin wäre ungültiges HTML — der Klick auf ein
// Vorschaubild landete beim Tool statt beim Bild.
function newsMedienStreifen(n) {
  const medien = Array.isArray(n.medien) ? n.medien : [];
  if (!medien.length && !n.videoUrl) return "";
  const thumbs = medien.map((m, i) =>
    '<button type="button" class="news-medien-thumb" data-mi="' + i + '"'
    + ' title="' + escapeHtml(m.name || (m.art === "video" ? "Video" : "Bild")) + '"'
    + ' aria-label="' + escapeHtml((m.art === "video" ? "Video" : "Bild") + " groß ansehen") + '">'
    + '<span class="news-medien-thumb-zeichen">' + (m.art === "video" ? "🎬" : "🖼️") + '</span>'
    + '</button>').join("");
  // ⚠️ Externer Videolink wird NICHT eingebettet, sondern nur verlinkt: ein
  // iframe schickte schon beim Anzeigen der Startseite Daten an YouTube & Co.,
  // ohne dass jemand darauf geklickt hat.
  const link = n.videoUrl
    ? '<a class="news-medien-link" href="' + escapeHtml(n.videoUrl) + '" target="_blank" rel="noopener noreferrer">🎬 Video ansehen →</a>'
    : "";
  return '<div class="news-medien">' + thumbs + link + '</div>';
}

function newsMedienThumbsBeleben(banner, n) {
  const medien = Array.isArray(n.medien) ? n.medien : [];
  banner.querySelectorAll(".news-medien-thumb").forEach((btn) => {
    const m = medien[Number(btn.dataset.mi)];
    if (!m) return;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      newsMedienOverlayOeffnen(m);
    });
    // Nur Bilder bekommen eine echte Vorschau. Für ein Video-Standbild müsste die
    // ganze Datei geladen werden -- bei bis zu 10 MB pro Meldung beim bloßen
    // Anzeigen der Startseite. Videos bleiben deshalb beim Symbol.
    if (m.art !== "bild") return;
    newsMedienUrl(m).then((url) => {
      if (!url || !btn.isConnected) return;
      btn.style.backgroundImage = 'url("' + url + '")';
      btn.classList.add("hat-bild");
    }).catch(() => { /* Symbol bleibt stehen -- besser als eine Fehlermeldung im Karussell */ });
  });
}

// ---------- Bildschirmvideo für eine Meldung (seit 2026-08-07) ----------
//
// Zweck: eine kurze Vorführung aufnehmen ("so schaltest du Push ein") und direkt
// an eine Neuigkeit hängen. Zwei Dinge machen das Ganze aus:
//
// ⚠️ 1. Die Klick-Kreise gibt es NUR bei einer Tab-Aufnahme. Eine Seite bekommt
// keine Maus-Ereignisse von außerhalb ihres eigenen Tabs -- wer den ganzen
// Bildschirm aufnimmt, kann deshalb prinzipiell nicht wissen, wo geklickt wurde.
// Deshalb lädt die Betriebsart "tool" das Werkzeug in einen RAHMEN auf dieser
// Seite: die ganze Flotte liegt auf sc1911heiligenstadt.github.io, der Rahmen ist
// also gleichen Ursprungs und sein contentDocument lesbar. Bei "frei" gibt es
// bewusst keine Kreise statt schlecht geratener.
//
// ⚠️ 2. Bei "tool"/"seite" läuft das Bild über ein Canvas (Kreise einzeichnen,
// Bedienleiste wegschneiden), bei "frei" wird der Stream DIREKT aufgenommen.
// Grund: für "frei" schaut der Nutzer in ein anderes Fenster, der Tab kann dabei
// in den Hintergrund geraten -- und dort drosselt der Browser sowohl
// requestAnimationFrame als auch setInterval auf ~1 Bild je Sekunde. Eine
// Canvas-Aufnahme fröre in dem Moment ein, die Direktaufnahme läuft weiter.

// ⚠️ 3. Die Größe wird GERECHNET, nicht gemessen -- das ist der tragende Punkt.
// Chromes MP4-Muxer gibt seine Daten trotz Zeitscheibe erst beim Stopp heraus
// (am 2026-08-07 nachgemessen: 6 Sekunden Aufnahme, NULL Datenereignisse, Datei
// hinterher 299 KB da; auch requestData() erzwingt keine Herausgabe). Eine
// Notbremse "bei 9 MB abbrechen" hätte also nie ausgelöst. WebM liefert zwar im
// Sekundentakt, spielt aber auf den älteren iPhones der Flotte nicht ab -- und
// genau dort werden die Meldungen gelesen. Deshalb bleibt es bei MP4, und die
// Zusage kommt aus der Rechnung: Bitrate × Höchstdauer ≤ Zielgröße. Die Dauer
// ist hart begrenzt, die Bitrate ist vorgegeben, damit steht die Obergrenze
// VOR der ersten Sekunde fest. Die Byte-Notbremse bleibt als zusätzliches Netz
// für die Fälle, in denen doch laufend Daten kommen.

const AUFNAHME_ZIEL_BYTES = 8 * 1024 * 1024;     // Budget: Bitrate × Höchstdauer
const AUFNAHME_HART_BYTES = 9.3 * 1024 * 1024;   // Netz, falls doch laufend gemessen wird
const AUFNAHME_RING_MS = 550;                    // Lebensdauer eines Klick-Rings

let aufnahmeState = null;

function aufnahmeEl(id) { return document.getElementById(id); }

function aufnahmeFehler(text, feldId) {
  const el = aufnahmeEl(feldId || "aufnahme-fehler");
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

// Unter einem Megabyte in KB: ein 25-KB-Video als "0,0 MB" auszuweisen sieht aus,
// als wäre die Aufnahme leer geblieben.
function aufnahmeMB(bytes) {
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
}

function aufnahmeZeitText(sek) {
  const m = Math.floor(sek / 60);
  const s = Math.floor(sek % 60);
  return m + ":" + (s < 10 ? "0" : "") + s;
}

// Der Browser entscheidet, was er kann. MP4/H.264 steht bewusst VORN: WebM/VP9
// spielt auf den älteren iPhones der Flotte nicht ab, und die Meldungen werden
// überwiegend am Handy gelesen.
function aufnahmeFormat(mitTon) {
  const kandidaten = mitTon
    ? ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', "video/mp4",
       "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ['video/mp4;codecs="avc1.42E01E"', "video/mp4",
       "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== "function") return "";
  for (let i = 0; i < kandidaten.length; i++) {
    if (MediaRecorder.isTypeSupported(kandidaten[i])) return kandidaten[i];
  }
  return "";
}

// Welcher Tab steht gerade offen? Wird vor dem Start gemerkt, um hinterher
// dorthin zurückzukehren.
function aufnahmeAktiverTab() {
  const sec = document.querySelector(".tab-section.active");
  return sec && sec.id.indexOf("tab-") === 0 ? sec.id.slice(4) : "uebersicht";
}

// ⚠️ Michel-Vorgabe 2026-08-07: die Aufnahme beginnt IMMER auf der Übersicht.
// Der Knopf steht im Neuigkeiten-Formular, also in den Einstellungen -- ohne
// diesen Wechsel wäre das erste Bild jeder Vorführung das Pflege-Formular samt
// offener Admin-Maske. Der Sprung passiert VOR der Freigabe-Abfrage, damit auch
// die Vorschau im Auswahlfenster des Browsers schon das Richtige zeigt.
function aufnahmeAufsDashboard() {
  activateTab("uebersicht");
  // Ohne das begänne die Aufnahme an der Stelle, bis zu der zum Formular
  // heruntergescrollt war -- also mitten in der Seite statt oben.
  window.scrollTo(0, 0);
}

function aufnahmeTabZurueck(name) {
  if (!name || name === "uebersicht") return;
  if (!document.getElementById("tab-" + name)) return;
  activateTab(name);
}

function aufnahmeMoeglich() {
  return !!(window.MediaRecorder && navigator.mediaDevices
    && typeof navigator.mediaDevices.getDisplayMedia === "function"
    && document.createElement("canvas").captureStream);
}

const AUFNAHME_TON_BITS = 64000;

// Zielgröße geteilt durch Höchstdauer. Der Tonanteil geht vom Videoanteil AB,
// sonst käme er oben drauf und die Rechnung stimmte nicht mehr.
//
// ⚠️ Die untere Schranke ist bewusst niedrig (120 kbit/s). Zöge man sie höher,
// risse bei den langen Aufnahmen genau die Zusage, um die es hier geht: bei
// 250 kbit/s und 5 Minuten wären es 9,4 MB Video plus 2,4 MB Ton — über der
// Grenze. Alle angebotenen Dauern liegen über der Schranke, sie greift also
// nie; wer eine längere Dauer anbietet, muss das nachrechnen.
function aufnahmeBitrate(maxSek, mitTon) {
  const ton = mitTon ? AUFNAHME_TON_BITS : 0;
  const roh = Math.floor((AUFNAHME_ZIEL_BYTES * 8) / Math.max(1, maxSek)) - ton;
  return Math.max(120000, Math.min(4000000, roh));
}

function aufnahmeDauerText(sek) {
  if (sek < 60) return sek + " Sekunden";
  const m = sek / 60;
  return m === 1 ? "1 Minute" : m + " Minuten";
}

// Die eigene Adresse ohne Anhängsel -- die Übersicht selbst im Rahmen.
// Michel-Wunsch 2026-08-07: eine Vorführung soll auf dem Dashboard anfangen
// können und von dort in ein Werkzeug führen.
//
// ⚠️ Das ist NICHT dasselbe wie die Betriebsart "seite". Dort läuft die Aufnahme
// auf der echten Seite, und ein Klick auf eine Kachel navigiert das Fenster weg
// -- damit stirbt die Aufnahme mitsamt allem, was schon aufgezeichnet war. Im
// Rahmen navigiert nur der Rahmen, die Aufnahme läuft weiter. Der Weg
// "Dashboard → Kachel → im Werkzeug etwas zeigen" geht deshalb NUR hierüber.
function aufnahmeUebersichtUrl() {
  return location.origin + location.pathname;
}

// ⚠️ Sortierung und Gruppierung spiegeln das Dashboard (Michel-Vorgabe): dieselbe
// Kategorienfolge wie renderToolGrid() und dieselbe persönliche Reihenfolge über
// applyCustomOrder(). Eine eigene Sortierung hier liefe auseinander, sobald jemand
// seine Kacheln umsortiert -- und man sucht ein Werkzeug an der Stelle, an der es
// auf der Übersicht steht.
function aufnahmeToolListe() {
  const sel = aufnahmeEl("aufnahme-tool");
  if (!sel) return;
  sel.innerHTML = "";

  const dash = document.createElement("option");
  dash.value = aufnahmeUebersichtUrl();
  dash.textContent = "🧰 Dashboard — die Tools-Übersicht";
  sel.appendChild(dash);

  let anzahl = 0;
  [...new Set(TOOLS.map((t) => t.category))].forEach((kategorie) => {
    const sichtbar = TOOLS.filter((t) => t.category === kategorie && t.url && isVisibleToUser(t.id, currentUser));
    if (!sichtbar.length) return;
    const gruppe = document.createElement("optgroup");
    gruppe.label = kategorie;
    applyCustomOrder(kategorie, sichtbar).forEach((t) => {
      const o = document.createElement("option");
      o.value = t.url;
      o.textContent = (t.icon ? t.icon + " " : "") + t.name;
      // Öffnet das Werkzeug in einem neuen Tab, führt im Rahmen also aus der
      // Aufnahme heraus. Beim Namen sagen statt hinterher wundern.
      if (t.newTab) o.textContent += " (öffnet ein eigenes Fenster)";
      gruppe.appendChild(o);
      anzahl++;
    });
    sel.appendChild(gruppe);
  });
  if (!anzahl) dash.textContent += " (nur diese)";
}

function aufnahmeHinweisSetzen() {
  const el = aufnahmeEl("aufnahme-hinweis");
  if (!el) return;
  const quelle = aufnahmeEl("aufnahme-quelle").value;
  const maxSek = Number(aufnahmeEl("aufnahme-dauer").value) || 60;
  const mitTon = aufnahmeEl("aufnahme-ton").checked;
  const format = aufnahmeFormat(mitTon);
  const teile = [];
  // Die Zusage steht hier ehrlich als Rechnung da, nicht als Versprechen:
  // die Höchstdauer ist es, die die Größe deckelt.
  teile.push("Höchstens " + aufnahmeMB(AUFNAHME_ZIEL_BYTES) + ": die Bildqualität wird so eingestellt, "
    + "dass " + aufnahmeDauerText(maxSek) + " in dieses Budget passen. Nach "
    + aufnahmeDauerText(maxSek) + " endet die Aufnahme von selbst.");
  if (quelle === "tool") {
    teile.push("Beginnst du auf dem Dashboard, kannst du von dort in ein Werkzeug klicken — die Aufnahme läuft mit, weil sich nur der Rahmen bewegt.");
  }
  if (quelle === "seite") {
    teile.push("Die Aufnahme beginnt oben auf der Übersicht, nicht hier in den Einstellungen. Danach bist du wieder bei deinem Meldungs-Entwurf.");
    // ⚠️ Der Unterschied, der sonst erst auffällt, wenn die Aufnahme weg ist.
    teile.push("⚠️ Hier geht der Weg in ein Werkzeug NICHT: ein Klick auf eine Kachel verlässt die Seite und beendet die Aufnahme ersatzlos. Dafür ist die erste Betriebsart da.");
  }
  if (quelle === "frei") {
    teile.push("In dieser Betriebsart gibt es keine Klick-Kreise — eine Seite erfährt nichts von Klicks außerhalb ihres eigenen Tabs. Der Mauszeiger des Rechners wird aber mit aufgezeichnet.");
  } else {
    teile.push("Bleib während der Aufnahme in diesem Browser-Tab: im Hintergrund bremst der Browser das Zeichnen aus, und das Video stünde still.");
  }
  // Ehrlich benennen statt still ausliefern: ein WebM lässt sich auf älteren
  // iPhones nicht abspielen, und genau dort werden die Meldungen gelesen.
  if (!format) {
    teile.push("⚠️ Dieser Browser kann gar kein Video aufnehmen.");
  } else if (format.indexOf("mp4") === -1) {
    teile.push("⚠️ Dieser Browser nimmt nur WebM auf. Das spielt auf älteren iPhones nicht ab — für eine Meldung an alle besser Chrome oder Edge benutzen.");
  }
  el.textContent = teile.join(" ");
}

function aufnahmeQuelleUmschalten() {
  const quelle = aufnahmeEl("aufnahme-quelle").value;
  const zeile = aufnahmeEl("aufnahme-tool-zeile");
  if (zeile) zeile.style.display = quelle === "tool" ? "" : "none";
  const ringeZeile = aufnahmeEl("aufnahme-ringe").closest(".aufnahme-haken");
  if (ringeZeile) ringeZeile.style.display = quelle === "frei" ? "none" : "";
  aufnahmeHinweisSetzen();
}

function aufnahmeOeffnen() {
  const ov = aufnahmeEl("aufnahme-overlay");
  if (!ov) return;
  aufnahmeAufraeumen();
  aufnahmeFehler("");
  aufnahmeFehler("", "aufnahme-ergebnis-fehler");
  aufnahmeEl("aufnahme-setup").style.display = "";
  aufnahmeEl("aufnahme-ergebnis").style.display = "none";
  aufnahmeToolListe();
  aufnahmeQuelleUmschalten();
  const start = aufnahmeEl("btn-aufnahme-start");
  if (!aufnahmeMoeglich()) {
    start.disabled = true;
    aufnahmeFehler("Dieser Browser kann keine Bildschirmaufnahme. Am Rechner geht es mit Chrome oder Edge; auf dem Handy gibt es diesen Weg nicht.");
  } else {
    start.disabled = false;
  }
  ov.style.display = "flex";
}

function aufnahmeSchliessen() {
  const ov = aufnahmeEl("aufnahme-overlay");
  aufnahmeAufraeumen();
  if (ov) ov.style.display = "none";
}

// Räumt ALLES ab, was eine laufende Aufnahme hält. Wird sowohl beim Schließen
// als auch vor jedem neuen Anlauf gerufen -- eine zweite Aufnahme über einer
// noch laufenden ersten wäre der klassische Weg zu zwei Aufnahmezeigern.
function aufnahmeAufraeumen() {
  const s = aufnahmeState;
  aufnahmeState = null;
  const ov = aufnahmeEl("aufnahme-overlay");
  if (ov) ov.classList.remove("laeuft");
  const buehne = aufnahmeEl("aufnahme-buehne");
  if (buehne) buehne.style.display = "none";
  const rahmen = aufnahmeEl("aufnahme-iframe");
  if (rahmen) rahmen.src = "about:blank";
  const leiste = aufnahmeEl("aufnahme-leiste");
  if (leiste) leiste.style.display = "none";
  if (!s) return;
  if (s.tick) clearInterval(s.tick);
  if (s.maltakt) clearInterval(s.maltakt);
  try { if (s.rec && s.rec.state !== "inactive") s.rec.stop(); } catch (_) {}
  [s.stream, s.tonStream].forEach((st) => {
    if (!st) return;
    st.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
  });
  if (s.video) { try { s.video.pause(); } catch (_) {} s.video.srcObject = null; }
  if (s.abfahrtWaechter) window.removeEventListener("beforeunload", s.abfahrtWaechter);
  aufnahmeLauscherLoesen(s);
  if (s.blobUrl) { try { URL.revokeObjectURL(s.blobUrl); } catch (_) {} }
}

// ---- Maus mitschreiben ----
//
// Zwei Dokumente können Ereignisse liefern: diese Seite und der Rahmen. Beide
// zählen in ihren EIGENEN Fensterkoordinaten -- die des Rahmens müssen deshalb
// um dessen Position auf der Seite verschoben werden, sonst säße der Kreis bei
// jedem Klick oben links.
function aufnahmeVersatz(imRahmen) {
  if (!imRahmen) return { x: 0, y: 0 };
  const f = aufnahmeEl("aufnahme-iframe");
  if (!f) return { x: 0, y: 0 };
  const r = f.getBoundingClientRect();
  return { x: r.left, y: r.top };
}

function aufnahmeLauscherAn(doc, imRahmen) {
  const s = aufnahmeState;
  if (!s || !doc) return;
  const move = (ev) => {
    const o = aufnahmeVersatz(imRahmen);
    s.maus = { x: ev.clientX + o.x, y: ev.clientY + o.y, da: true };
  };
  const down = (ev) => {
    const o = aufnahmeVersatz(imRahmen);
    s.maus = { x: ev.clientX + o.x, y: ev.clientY + o.y, da: true };
    s.klicks.push({ x: s.maus.x, y: s.maus.y, t: performance.now() });
  };
  const weg = () => { s.maus = { x: 0, y: 0, da: false }; };
  // capture: true -- ein Werkzeug, das den Klick mit stopPropagation abfängt,
  // dürfte den Kreis nicht verschlucken.
  doc.addEventListener("pointermove", move, true);
  doc.addEventListener("pointerdown", down, true);
  doc.addEventListener("pointerleave", weg, true);
  s.lauscher.push({ doc: doc, move: move, down: down, weg: weg, imRahmen: !!imRahmen });
}

function aufnahmeLauscherLoesen(s, nurRahmen) {
  if (!s || !s.lauscher) return;
  const bleiben = [];
  s.lauscher.forEach((l) => {
    if (nurRahmen && !l.imRahmen) { bleiben.push(l); return; }
    try {
      l.doc.removeEventListener("pointermove", l.move, true);
      l.doc.removeEventListener("pointerdown", l.down, true);
      l.doc.removeEventListener("pointerleave", l.weg, true);
    } catch (_) { /* Dokument des Rahmens kann schon fort sein */ }
  });
  s.lauscher = bleiben;
}

// Nach jedem Seitenwechsel im Rahmen sind die Lauscher weg -- der Klick auf
// einen Link im Werkzeug lädt ein neues Dokument. Ohne dieses Nachhängen
// verschwänden die Kreise beim ersten Navigieren.
function aufnahmeRahmenAnbinden() {
  const s = aufnahmeState;
  const f = aufnahmeEl("aufnahme-iframe");
  if (!s || !f) return;
  // ⚠️ Erst die alten lösen. Der Rahmen lädt mindestens zweimal (about:blank,
  // dann das Werkzeug), und ohne diese Zeile hingen danach zwei Lauscher am
  // selben Dokument -- jeder Klick hätte ZWEI deckungsgleiche Ringe erzeugt.
  // Am 2026-08-07 im Preview genau so gemessen (2 Einträge statt 1).
  aufnahmeLauscherLoesen(s, true);
  let doc = null;
  try { doc = f.contentDocument; } catch (_) { doc = null; }
  if (!doc) {
    s.rahmenStumm = true;
    return;
  }
  aufnahmeLauscherAn(doc, true);
}

// ---- Der aufgenommene Ausschnitt ----
//
// Gemessen wird bei JEDEM Bild neu: die Leiste bricht am Handy um, und der
// Rahmen ändert seine Höhe mit ihr.
function aufnahmeBereich() {
  const s = aufnahmeState;
  if (!s || s.quelle === "frei") return null;
  if (s.quelle === "tool") {
    const f = aufnahmeEl("aufnahme-iframe");
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  const leiste = aufnahmeEl("aufnahme-leiste");
  const h = leiste && leiste.style.display !== "none" ? leiste.getBoundingClientRect().height : 0;
  return {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: Math.max(60, window.innerHeight - h)
  };
}

// Fensterkoordinate -> Bildpunkt auf dem Canvas. Gibt null zurück, wenn der
// Punkt außerhalb des aufgenommenen Ausschnitts liegt (Maus über der Leiste).
function aufnahmeZuCanvas(vx, vy) {
  const s = aufnahmeState;
  if (!s || !s.bereich || !s.ziel || s.bereich.width <= 0 || s.bereich.height <= 0) return null;
  const ax = (vx - s.bereich.left) / s.bereich.width;
  const ay = (vy - s.bereich.top) / s.bereich.height;
  if (ax < 0 || ax > 1 || ay < 0 || ay > 1) return null;
  return {
    x: s.ziel.x + ax * s.ziel.w,
    y: s.ziel.y + ay * s.ziel.h,
    k: s.ziel.w / s.bereich.width
  };
}

function aufnahmeZeichnen() {
  const s = aufnahmeState;
  if (!s || !s.ctx || !s.video) return;
  const ctx = s.ctx;
  const vw = s.video.videoWidth;
  const vh = s.video.videoHeight;
  if (!vw || !vh) return;

  s.bereich = aufnahmeBereich();
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (s.bereich && window.innerWidth > 0 && window.innerHeight > 0) {
    // Der aufgenommene Tab ist genau das Sichtfenster -- das Verhältnis
    // Videobreite/innerWidth rechnet Fenster- in Bildpunkte um, unabhängig
    // davon, mit welcher Pixeldichte der Browser aufnimmt.
    const kx = vw / window.innerWidth;
    const ky = vh / window.innerHeight;
    sx = s.bereich.left * kx;
    sy = s.bereich.top * ky;
    sw = s.bereich.width * kx;
    sh = s.bereich.height * ky;
  }
  if (sw <= 0 || sh <= 0) return;

  // Seitenverhältnis halten statt zu verzerren: das Fenster kann sich während
  // der Aufnahme ändern, die Canvas-Größe darf es nicht (das risse den Strom ab).
  const f = Math.min(s.canvas.width / sw, s.canvas.height / sh);
  const zw = sw * f;
  const zh = sh * f;
  s.ziel = { x: (s.canvas.width - zw) / 2, y: (s.canvas.height - zh) / 2, w: zw, h: zh };

  ctx.fillStyle = "#11151d";
  ctx.fillRect(0, 0, s.canvas.width, s.canvas.height);
  try {
    ctx.drawImage(s.video, sx, sy, sw, sh, s.ziel.x, s.ziel.y, zw, zh);
  } catch (_) { return; }

  if (!s.ringeAn) return;

  // Weicher Kreis unter dem Zeiger. Bei einer Tab-Aufnahme zeichnet der Browser
  // den Mauszeiger NICHT mit -- ohne diesen Kreis wäre im Video gar nicht zu
  // sehen, wo die Maus steht.
  if (s.maus.da) {
    const p = aufnahmeZuCanvas(s.maus.x, s.maus.y);
    if (p) {
      const r = 15 * Math.max(0.5, p.k);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 214, 64, 0.30)";
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, 2 * p.k);
      ctx.strokeStyle = "rgba(201, 148, 31, 0.85)";
      ctx.stroke();
    }
  }

  const jetzt = performance.now();
  s.klicks = s.klicks.filter((k) => jetzt - k.t < AUFNAHME_RING_MS);
  s.klicks.forEach((k) => {
    const p = aufnahmeZuCanvas(k.x, k.y);
    if (!p) return;
    const a = (jetzt - k.t) / AUFNAHME_RING_MS;
    const r = (12 + a * 34) * Math.max(0.5, p.k);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, 4 * (1 - a) * p.k);
    ctx.strokeStyle = "rgba(229, 72, 77, " + (0.9 * (1 - a)).toFixed(3) + ")";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(229, 72, 77, " + (0.18 * (1 - a)).toFixed(3) + ")";
    ctx.fill();
  });
}

function aufnahmeLeisteZeigen() {
  const s = aufnahmeState;
  const leiste = aufnahmeEl("aufnahme-leiste");
  if (!leiste || !s) return;
  const sek = (Date.now() - s.startMs) / 1000;
  aufnahmeEl("aufnahme-zeit").textContent = aufnahmeZeitText(sek) + " / " + aufnahmeZeitText(s.maxSek);
  // ⚠️ Bei MP4 kommt bis zum Stopp kein einziges Byte heraus (siehe Kopf des
  // Abschnitts). Dann steht hier die Rechnung aus der eingestellten Bitrate --
  // und zwar als "max.", denn genau das ist sie: eine OBERGRENZE, keine Schätzung.
  // Ruhige Bilder bleiben weit darunter (gemessen: 25 KB, wo 1,1 MB möglich
  // gewesen wären). Eine Anzeige, die drei Minuten lang "0 KB" behauptet, wäre falsch.
  const gemessen = s.bytes > 0;
  const zeigeBytes = gemessen ? s.bytes : Math.round((sek * s.gesamtBits) / 8);
  aufnahmeEl("aufnahme-groesse").textContent = (gemessen ? "" : "max. ") + aufnahmeMB(zeigeBytes);
  // Der Balken zeigt, was zuerst voll wird: die Zeit oder der Platz.
  const anteil = Math.max(sek / s.maxSek, zeigeBytes / AUFNAHME_HART_BYTES);
  const fuell = aufnahmeEl("aufnahme-balken-fuellung");
  fuell.style.width = Math.min(100, anteil * 100).toFixed(1) + "%";
  fuell.classList.toggle("knapp", anteil >= 0.75 && anteil < 0.92);
  fuell.classList.toggle("voll", anteil >= 0.92);
  if (sek >= s.maxSek) aufnahmeStoppen("Die eingestellte Höchstdauer war erreicht.");
}

async function aufnahmeStarten() {
  const startBtn = aufnahmeEl("btn-aufnahme-start");
  aufnahmeFehler("");
  const quelle = aufnahmeEl("aufnahme-quelle").value;
  const breite = Number(aufnahmeEl("aufnahme-breite").value) || 960;
  const fps = Number(aufnahmeEl("aufnahme-fps").value) || 15;
  const maxSek = Number(aufnahmeEl("aufnahme-dauer").value) || 60;
  const mitTon = aufnahmeEl("aufnahme-ton").checked;
  const ringeAn = aufnahmeEl("aufnahme-ringe").checked && quelle !== "frei";
  const toolUrl = aufnahmeEl("aufnahme-tool").value;
  const format = aufnahmeFormat(mitTon);

  if (!format) return aufnahmeFehler("Dieser Browser kann kein Video aufnehmen.");
  if (quelle === "tool" && !toolUrl) return aufnahmeFehler("Für dich ist gerade kein Werkzeug sichtbar, das sich aufnehmen ließe.");

  startBtn.disabled = true;
  startBtn.textContent = "Wird vorbereitet…";
  // Vor dem Aufräumen merken: aufnahmeAufraeumen() wirft den Zustand weg.
  const vorherTab = aufnahmeAktiverTab();
  aufnahmeAufraeumen();
  aufnahmeAufsDashboard();

  aufnahmeState = {
    vorherTab: vorherTab,
    quelle: quelle, maxSek: maxSek, ringeAn: ringeAn, fps: fps,
    stream: null, tonStream: null, video: null, canvas: null, ctx: null,
    rec: null, chunks: [], bytes: 0, blob: null, blobUrl: null, dateiname: "",
    mimeType: format, startMs: 0, tick: null, maltakt: null, gesamtBits: 0,
    klicks: [], maus: { x: 0, y: 0, da: false }, lauscher: [],
    bereich: null, ziel: null, rahmenStumm: false, grund: "", abfahrtWaechter: null
  };
  const s = aufnahmeState;

  try {
    if (mitTon) {
      // Vor dem Bildschirm fragen: bricht das Mikrofon ab, soll nicht schon eine
      // laufende Bildschirmfreigabe im Raum stehen, die wieder eingesammelt werden muss.
      s.tonStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    if (quelle === "tool") {
      const rahmen = aufnahmeEl("aufnahme-iframe");
      const buehne = aufnahmeEl("aufnahme-buehne");
      const ov = aufnahmeEl("aufnahme-overlay");
      ov.classList.add("laeuft");
      buehne.style.display = "block";
      aufnahmeEl("aufnahme-leiste").style.display = "flex";
      buehne.style.bottom = aufnahmeEl("aufnahme-leiste").getBoundingClientRect().height + "px";
      rahmen.onload = aufnahmeRahmenAnbinden;
      rahmen.src = toolUrl;
      // Ein Bild abwarten, damit der Rahmen seine endgültige Größe hat, bevor
      // daraus die Canvas-Maße gerechnet werden.
      await new Promise((r) => setTimeout(r, 60));
    }

    const wunsch = { video: { frameRate: { ideal: fps } }, audio: false };
    if (quelle !== "frei") {
      // Chrome zeigt damit gleich den richtigen Eintrag an. Kennt ein Browser die
      // Angabe nicht, überspringt er sie und der Nutzer wählt von Hand.
      wunsch.preferCurrentTab = true;
    } else {
      wunsch.video.cursor = "always";
      wunsch.video.width = { max: breite };
    }
    s.stream = await navigator.mediaDevices.getDisplayMedia(wunsch);
  } catch (e) {
    const abgebrochen = e && (e.name === "NotAllowedError" || e.name === "AbortError");
    aufnahmeAufraeumen();
    // Bricht die Freigabe ab, war der Sprung aufs Dashboard umsonst -- zurück,
    // wo der Nutzer herkam, sonst steht er nach einem Fehlklick woanders.
    aufnahmeTabZurueck(vorherTab);
    aufnahmeEl("aufnahme-overlay").style.display = "flex";
    startBtn.disabled = false;
    startBtn.textContent = "Aufnahme starten";
    return aufnahmeFehler(abgebrochen
      ? "Die Aufnahme wurde nicht freigegeben."
      : "Die Aufnahme ließ sich nicht starten: " + (e && e.message ? e.message : "unbekannter Fehler"));
  }

  startBtn.disabled = false;
  startBtn.textContent = "Aufnahme starten";

  // Beendet der Nutzer die Freigabe über die Leiste des Browsers, ist das ein
  // gültiges "fertig" -- nicht ein Fehler.
  const spur = s.stream.getVideoTracks()[0];
  if (spur) spur.addEventListener("ended", () => aufnahmeStoppen("Die Freigabe wurde beendet."));

  let aufnahmeStream;
  if (quelle === "frei") {
    // Direktaufnahme, siehe Begründung am Kopf des Abschnitts.
    aufnahmeStream = new MediaStream(s.stream.getVideoTracks());
  } else {
    s.video = document.createElement("video");
    s.video.muted = true;
    s.video.playsInline = true;
    s.video.srcObject = s.stream;
    try { await s.video.play(); } catch (_) { /* stumm abspielen darf nicht scheitern */ }

    const b = aufnahmeBereich() || { width: window.innerWidth, height: window.innerHeight };
    const seiten = b.height > 0 ? b.width / b.height : 16 / 9;
    s.canvas = document.createElement("canvas");
    // Gerade Kantenlängen: ungerade Maße mag kein H.264-Encoder.
    s.canvas.width = Math.max(2, Math.round(breite / 2) * 2);
    s.canvas.height = Math.max(2, Math.round(breite / seiten / 2) * 2);
    s.ctx = s.canvas.getContext("2d");

    aufnahmeLauscherAn(document, false);
    if (quelle === "tool") aufnahmeRahmenAnbinden();

    // setInterval statt requestAnimationFrame: der Strom nimmt ohnehin nur fps
    // Bilder je Sekunde ab, 60 Zeichenläufe wären verschenkte Rechenzeit.
    s.maltakt = setInterval(aufnahmeZeichnen, Math.round(1000 / fps));
    aufnahmeZeichnen();
    aufnahmeStream = s.canvas.captureStream(fps);
  }

  if (s.tonStream) s.tonStream.getAudioTracks().forEach((t) => aufnahmeStream.addTrack(t));

  const optionen = { mimeType: format, videoBitsPerSecond: aufnahmeBitrate(maxSek, mitTon) };
  if (mitTon) optionen.audioBitsPerSecond = AUFNAHME_TON_BITS;
  // Grundlage der Hochrechnung in der Leiste, solange nichts gemessen werden kann.
  s.gesamtBits = optionen.videoBitsPerSecond + (mitTon ? AUFNAHME_TON_BITS : 0);
  try {
    s.rec = new MediaRecorder(aufnahmeStream, optionen);
  } catch (e) {
    aufnahmeAufraeumen();
    aufnahmeEl("aufnahme-overlay").style.display = "flex";
    return aufnahmeFehler("Die Aufnahme ließ sich nicht einrichten: " + (e && e.message ? e.message : "unbekannter Fehler"));
  }

  s.rec.ondataavailable = (ev) => {
    if (!ev.data || !ev.data.size) return;
    s.chunks.push(ev.data);
    s.bytes += ev.data.size;
    // Der Notaus. Die Bitrate ist so gerechnet, dass er im Normalfall nie greift.
    if (s.bytes >= AUFNAHME_HART_BYTES) {
      aufnahmeStoppen("Die Aufnahme wurde bei " + aufnahmeMB(s.bytes) + " beendet, damit sie anhängbar bleibt.");
    }
  };
  s.rec.onstop = aufnahmeErgebnisZeigen;

  // ⚠️ Erst das Fenster wegblenden, DANN aufnehmen -- andersherum könnte der
  // Einstellungs-Dialog im ersten Bild der Vorführung stehen.
  aufnahmeEl("aufnahme-leiste").style.display = "flex";
  if (quelle !== "tool") aufnahmeEl("aufnahme-overlay").style.display = "none";
  // ⚠️ Bei "seite" läuft die Aufnahme auf der echten Seite. Ein Klick auf eine
  // Kachel navigiert das Fenster weg -- und nimmt die ganze bis dahin
  // aufgezeichnete Vorführung ersatzlos mit, ohne Nachfrage und ohne Datei.
  // Der Browser fragt dank dieses Wächters vorher nach. Bei "tool" bewegt sich
  // nur der Rahmen, bei "frei" ist die Seite gar nicht im Bild -- dort wäre die
  // Rückfrage bloß lästig.
  if (quelle === "seite") {
    s.abfahrtWaechter = (ev) => { ev.preventDefault(); ev.returnValue = ""; return ""; };
    window.addEventListener("beforeunload", s.abfahrtWaechter);
  }
  s.startMs = Date.now();
  // Ein Block je Sekunde: nur so lässt sich die Größe überhaupt laufend messen,
  // wo der Muxer sie herausgibt (bei MP4 tut er das nicht, siehe oben).
  s.rec.start(1000);
  s.tick = setInterval(aufnahmeLeisteZeigen, 250);
  aufnahmeLeisteZeigen();
}

function aufnahmeStoppen(grund) {
  const s = aufnahmeState;
  if (!s || !s.rec || s.rec.state === "inactive") return;
  s.grund = grund || "";
  if (s.tick) { clearInterval(s.tick); s.tick = null; }
  try { s.rec.stop(); } catch (_) { /* onstop kommt dann nicht -- Fenster bleibt offen */ }
}

function aufnahmeErgebnisZeigen() {
  const s = aufnahmeState;
  if (!s) return;
  if (s.maltakt) { clearInterval(s.maltakt); s.maltakt = null; }
  [s.stream, s.tonStream].forEach((st) => {
    if (!st) return;
    st.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
  });
  aufnahmeLauscherLoesen(s);
  // Der Wächter hat seinen Zweck erfüllt -- jetzt ist die Datei da, und eine
  // Rückfrage beim Verlassen wäre nur noch im Weg.
  if (s.abfahrtWaechter) { window.removeEventListener("beforeunload", s.abfahrtWaechter); s.abfahrtWaechter = null; }

  const ov = aufnahmeEl("aufnahme-overlay");
  ov.classList.remove("laeuft");
  aufnahmeEl("aufnahme-buehne").style.display = "none";
  const rahmen = aufnahmeEl("aufnahme-iframe");
  if (rahmen) { rahmen.onload = null; rahmen.src = "about:blank"; }
  aufnahmeEl("aufnahme-leiste").style.display = "none";
  // ⚠️ Zurück in den Tab, aus dem gestartet wurde -- praktisch immer die
  // Einstellungen mit dem halbfertigen Meldungs-Entwurf. Ohne das hinge das
  // Video gleich an einer Meldung, deren Formular nicht mehr zu sehen ist.
  // Steht hier und nicht in aufnahmeStoppen(): erst wenn der Rekorder wirklich
  // fertig ist, kann kein Bild mehr in die Aufnahme geraten.
  aufnahmeTabZurueck(s.vorherTab);

  const dauer = (Date.now() - s.startMs) / 1000;
  const basisTyp = s.mimeType.indexOf("mp4") !== -1 ? "video/mp4" : "video/webm";
  s.blob = new Blob(s.chunks, { type: basisTyp });
  s.bytes = s.blob.size;
  s.blobUrl = URL.createObjectURL(s.blob);
  const stempel = new Date();
  const zwei = (n) => (n < 10 ? "0" : "") + n;
  s.dateiname = "Bildschirmvideo-" + stempel.getFullYear() + "-" + zwei(stempel.getMonth() + 1)
    + "-" + zwei(stempel.getDate()) + "-" + zwei(stempel.getHours()) + zwei(stempel.getMinutes())
    + (basisTyp === "video/mp4" ? ".mp4" : ".webm");

  aufnahmeEl("aufnahme-setup").style.display = "none";
  aufnahmeEl("aufnahme-ergebnis").style.display = "";
  aufnahmeFehler("", "aufnahme-ergebnis-fehler");

  const saetze = ["Länge " + aufnahmeZeitText(dauer) + ", " + aufnahmeMB(s.bytes) + ", " + s.dateiname + "."];
  if (s.grund) saetze.push(s.grund);
  if (s.bytes > NEWS_MEDIEN_MAX_BYTES) {
    saetze.push("⚠️ Damit liegt es über den 10 MB und lässt sich nicht anhängen — lade es herunter und verlinke es, oder nimm es kürzer oder kleiner noch einmal auf.");
  }
  if (s.rahmenStumm) {
    saetze.push("Hinweis: die Klicks im Rahmen ließen sich nicht mitlesen, dort fehlen die Kreise.");
  }
  aufnahmeEl("aufnahme-ergebnis-text").textContent = saetze.join(" ");

  const v = aufnahmeEl("aufnahme-video");
  v.src = s.blobUrl;
  aufnahmeEl("btn-aufnahme-anhaengen").disabled = s.bytes > NEWS_MEDIEN_MAX_BYTES || !s.bytes;
  ov.style.display = "flex";
}

async function aufnahmeAnhaengen() {
  const s = aufnahmeState;
  if (!s || !s.blob) return;
  if (newsMedienEntwurf.length >= NEWS_MEDIEN_MAX) {
    return aufnahmeFehler("Mehr als " + NEWS_MEDIEN_MAX + " Anhänge gehen nicht.", "aufnahme-ergebnis-fehler");
  }
  if (s.blob.size > NEWS_MEDIEN_MAX_BYTES) {
    return aufnahmeFehler("Das Video ist " + aufnahmeMB(s.blob.size) + " groß — anhängen lassen sich 10 MB.", "aufnahme-ergebnis-fehler");
  }
  const btn = aufnahmeEl("btn-aufnahme-anhaengen");
  btn.disabled = true;
  btn.textContent = "Lädt hoch…";
  try {
    const bytes = await dateiAlsBytes(s.blob);
    const id = neueDateiId();
    const res = await callWorker("news-datei-put", { id, dataBase64: bytesZuBase64(bytes) });
    newsMedienEntwurf.push({ id, mime: res.mime, art: res.art, name: s.dateiname });
    newsMedienEditorRendern();
    aufnahmeSchliessen();
  } catch (e) {
    aufnahmeFehler(e && e.message ? e.message : "Hochladen fehlgeschlagen.", "aufnahme-ergebnis-fehler");
    btn.disabled = false;
  } finally {
    btn.textContent = "An die Meldung anhängen";
  }
}

function aufnahmeHerunterladen() {
  const s = aufnahmeState;
  if (!s || !s.blobUrl) return;
  const a = document.createElement("a");
  a.href = s.blobUrl;
  a.download = s.dateiname;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function setupAufnahme() {
  const oeffnen = document.getElementById("btn-news-video-aufnehmen");
  if (oeffnen) oeffnen.addEventListener("click", aufnahmeOeffnen);
  const ov = document.getElementById("aufnahme-overlay");
  if (!ov) return;

  ["btn-aufnahme-close", "btn-aufnahme-abbrechen"].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", aufnahmeSchliessen);
  });
  const start = document.getElementById("btn-aufnahme-start");
  if (start) start.addEventListener("click", aufnahmeStarten);
  const stopp = document.getElementById("btn-aufnahme-stopp");
  if (stopp) stopp.addEventListener("click", () => aufnahmeStoppen(""));
  const anhaengen = document.getElementById("btn-aufnahme-anhaengen");
  if (anhaengen) anhaengen.addEventListener("click", aufnahmeAnhaengen);
  const runter = document.getElementById("btn-aufnahme-download");
  if (runter) runter.addEventListener("click", aufnahmeHerunterladen);
  const neu = document.getElementById("btn-aufnahme-neu");
  if (neu) neu.addEventListener("click", aufnahmeOeffnen);

  const quelle = document.getElementById("aufnahme-quelle");
  if (quelle) quelle.addEventListener("change", aufnahmeQuelleUmschalten);
  ["aufnahme-dauer", "aufnahme-ton", "aufnahme-breite", "aufnahme-fps"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", aufnahmeHinweisSetzen);
  });

  // ⚠️ Kein Schließen per Hintergrundklick und kein Escape, SOLANGE aufgenommen
  // wird -- ein Fehlgriff neben den Dialog würfe sonst die laufende Aufnahme weg.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ov.style.display !== "flex") return;
    if (aufnahmeState && aufnahmeState.rec && aufnahmeState.rec.state === "recording") return;
    ev.escapeVerbraucht = true;
    aufnahmeSchliessen();
  });
}

// ---- Feedback & Hilfe ----

// Bewusst kein "Once"-Cache wie bei newsToolOptionsOnce: welche Tools zur Auswahl
// stehen, hängt von isVisibleToUser() (Login-Status + Gruppen des AKTUELLEN Nutzers)
// ab, nicht von einer festen Liste — muss bei jedem Tab-/Login-Wechsel neu gebaut
// werden, sonst zeigt das Dropdown nach einem Nutzerwechsel noch die Tools des
// vorherigen Nutzers.
function renderFeedbackToolOptions() {
  const sel = document.getElementById("feedback-tool");
  if (!sel) return;
  sel.innerHTML = "";
  const allgemein = document.createElement("option");
  allgemein.value = "";
  allgemein.textContent = "— Allgemein —";
  sel.appendChild(allgemein);
  TOOLS.filter((t) => isVisibleToUser(t.id, currentUser)).forEach((t) => {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.name;
    sel.appendChild(o);
  });
}

// Feedback-Tab ist komplett login-gated (wie das Dashboard bis zum ersten sichtbaren
// Tool) — einfaches an/aus je nach currentUser, kein Feingranulares wie renderToolGrid.
function renderFeedbackTab() {
  const emptyEl = document.getElementById("feedback-empty");
  const contentEl = document.getElementById("feedback-content");
  if (!emptyEl || !contentEl) return;
  if (!currentUser) {
    emptyEl.style.display = "block";
    contentEl.style.display = "none";
    // ⚠️ Leeren, nicht nur ausblenden: die eigenen Einreichungen des vorherigen
    // Nutzers blieben sonst im DOM lesbar (gleiche Falle wie bei renderNews).
    meineFeedbacksLeeren();
    return;
  }
  emptyEl.style.display = "none";
  contentEl.style.display = "block";
  renderFeedbackToolOptions();
  const wikiCard = document.getElementById("wiki-ask-card");
  if (wikiCard) wikiCard.style.display = isVisibleToUser("vereinswiki", currentUser) ? "block" : "none";
}

function meineFeedbacksLeeren() {
  const card = document.getElementById("meine-feedbacks-card");
  const liste = document.getElementById("meine-feedbacks-liste");
  if (card) card.style.display = "none";
  if (liste) liste.innerHTML = "";
}

// Die eigenen Einreichungen samt Antwort.
//
// ⚠️ Aufgerufen wird das aus activateTab("feedback"), NICHT aus
// renderFeedbackTab(): letzteres laeuft bei jedem Seitenaufbau und nach jeder
// An-/Abmeldung: ein Nextcloud-Read (200-450 ms) fuer jeden Nutzer bei jedem
// Aufruf der Startseite, auch wenn er den Tab nie oeffnet.
async function loadMeineFeedbacks() {
  const card = document.getElementById("meine-feedbacks-card");
  const liste = document.getElementById("meine-feedbacks-liste");
  if (!card || !liste || !currentUser) return;

  // ⚠️ NUR der Worker-Aufruf steht im try, nicht das Rendern. Ein alter Worker
  // kennt die Aktion noch nicht — dann bleibt die Karte still weg, statt einen
  // roten Hinweis auf eine Funktion zu zeigen, die es serverseitig noch nicht
  // gibt (gleiche Linie wie bei push-status). Ein Fehler BEIM RENDERN ist
  // dagegen ein echter Fehler und soll in der Konsole stehen, statt sich als
  // "keine Einreichungen" zu tarnen.
  let data;
  try {
    data = await callWorker("meine-feedbacks", {});
  } catch (e) {
    card.style.display = "none";
    liste.innerHTML = "";
    return;
  }

  const entries = Array.isArray(data.entries) ? data.entries : [];
  // Wer noch nie etwas eingereicht hat, sieht auch keine leere Karte.
  if (!entries.length) {
    card.style.display = "none";
    liste.innerHTML = "";
    return;
  }
  card.style.display = "block";
  // Beantwortete zuerst — das ist, weswegen jemand nach der Push-Nachricht
  // hierherkommt. Innerhalb dessen neueste zuerst.
  const sorted = entries.slice().sort((a, b) => {
      if (!!a.antwort !== !!b.antwort) return a.antwort ? -1 : 1;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
  liste.innerHTML = sorted.map((f) => {
    const tool = f.toolId ? toolById(f.toolId) : null;
    const type = f.type === "wunsch" ? "wunsch" : "feedback";
    return `
      <div class="meine-feedback-row">
        <div class="feedback-item-head">
          <span class="feedback-badge feedback-badge-${type}">${type === "wunsch" ? "Wunsch" : "Feedback"}</span>
          <span class="muted">${escapeHtml(fmtDatumKurz(f.createdAt))}</span>
          ${f.done ? '<span class="muted">· erledigt</span>' : ""}
        </div>
        <div class="muted" style="font-size:12px; margin-top:2px;">${tool ? `→ ${escapeHtml(tool.name)}` : "— Allgemein —"}</div>
        <div class="feedback-item-text">${escapeHtml(f.text || "")}</div>
        ${f.antwort ? `
        <div class="meine-feedback-antwort">
          <div class="meine-feedback-antwort-kopf">Antwort von ${escapeHtml(f.antwortVon || "?")}${f.antwortAm ? " · " + escapeHtml(fmtDatumKurz(f.antwortAm)) : ""}</div>
          <div class="feedback-item-text">${escapeHtml(f.antwort)}</div>
        </div>` : '<p class="muted" style="font-size:12px; margin-top:8px;">Noch keine Antwort.</p>'}
      </div>`;
  }).join("");
}

// Fragen ans Toolbox Wiki, direkt hier ganz oben im Tab eingebettet (statt einer
// eigenen Kachel) — wer Hilfe braucht, soll sich erst selbst helfen lassen können,
// bevor Feedback/Hilfe angefragt wird. Ruft den separaten wiki-worker (Gemini)
// direkt mit dem hier schon vorhandenen currentToken auf (gleiches Login-Token,
// gleiche Origin) — kein eigener Login-Umweg nötig. Sichtbarkeit folgt derselben
// isVisibleToUser()-Regel wie die Tool-Kachel (siehe renderFeedbackTab), da der
// wiki-worker serverseitig denselben Zugriffscheck macht.
async function askWiki(question) {
  let resp;
  try {
    resp = await fetch(WIKI_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + currentToken },
      body: JSON.stringify({ question })
    });
  } catch (e) {
    throw new Error("Wissens-Assistent nicht erreichbar.");
  }
  let data = null;
  try { data = await resp.json(); } catch (_) { /* kein JSON-Body */ }
  if (!resp.ok) {
    throw new Error((data && data.error) || ("Assistent-Fehler (HTTP " + resp.status + ")"));
  }
  return data;
}

function setupWikiFrage() {
  const btn = document.getElementById("btn-wiki-frage");
  if (!btn) return;
  btn.addEventListener("click", handleWikiFrage);
  document.getElementById("wiki-frage-input").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); handleWikiFrage(); }
  });
}

async function handleWikiFrage() {
  const input = document.getElementById("wiki-frage-input");
  const q = input.value.trim();
  if (!q) { input.focus(); return; }
  const btn = document.getElementById("btn-wiki-frage");
  btn.disabled = true;
  showWikiAntwortLoading(q);
  try {
    const res = await askWiki(q);
    const anzahl = typeof res.dokumentAnzahl === "number" ? res.dokumentAnzahl : null;
    const meta = "KI-generiert" + (anzahl != null ? ` auf Basis von ${anzahl} Dokument${anzahl === 1 ? "" : "en"}` : "") + ", bitte im Zweifel im Originaldokument prüfen.";
    showWikiAntwort(q, res.answer || "(keine Antwort erhalten)", meta);
  } catch (e) {
    showWikiAntwort(q, "Es ist ein Fehler aufgetreten: " + e.message, "");
  } finally {
    btn.disabled = false;
  }
}

function showWikiAntwortLoading(frage) {
  const card = document.getElementById("wiki-antwort-card");
  card.style.display = "block";
  document.getElementById("wiki-antwort-frage").textContent = frage;
  document.getElementById("wiki-antwort-text").innerHTML = '<span class="muted">Der Assistent liest die Dokumente und formuliert eine Antwort …</span>';
  document.getElementById("wiki-antwort-meta").textContent = "";
}

function showWikiAntwort(frage, text, meta) {
  const card = document.getElementById("wiki-antwort-card");
  card.style.display = "block";
  document.getElementById("wiki-antwort-frage").textContent = frage;
  document.getElementById("wiki-antwort-text").innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
  document.getElementById("wiki-antwort-meta").textContent = meta || "";
}

function setupWhatsappLink() {
  const link = document.getElementById("feedback-whatsapp-link");
  if (!link) return;
  const text = "Hallo Michel, ich habe eine Frage/ein Feedback zu einem Tool:";
  link.href = "https://wa.me/" + WHATSAPP_CONTACT + "?text=" + encodeURIComponent(text);
}

// Lazy geladen (nur beim Kachel-Klick, siehe buildAdminDashboardCard und
// btn-admin-dashboard-refresh) statt in init()/afterAuthChange() wie die
// immer sichtbaren Einstellungen-Panels — spart den Worker-Call für Admins,
// die die Ansicht nie öffnen.
async function loadAndRenderAdminStats() {
  const errorEl = document.getElementById("admin-dashboard-error");
  const contentEl = document.getElementById("admin-dashboard-content");
  errorEl.style.display = "none";
  contentEl.style.display = "none";
  try {
    const data = await callWorker("get-admin-stats", {});
    renderAdminStats(data);
    contentEl.style.display = "block";
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }
}

function renderAdminStats(data) {
  document.getElementById("stat-users").textContent = `${data.users.passwordSet} von ${data.users.total}`;

  const trainerNote = document.getElementById("admin-dashboard-trainer-note");
  if (!data.trainerGroup.exists) {
    trainerNote.style.display = "block";
    document.getElementById("stat-trainervertrag").textContent = "–";
    document.getElementById("stat-trainervertrag-sub").textContent = "erstellt";
    document.getElementById("stat-trainerkodex").textContent = "–";
    document.getElementById("stat-jugendschutz").textContent = "–";
  } else {
    trainerNote.style.display = "none";
    const tv = data.trainervertrag;
    document.getElementById("stat-trainervertrag").textContent = `${tv.generiert} von ${tv.total}`;
    document.getElementById("stat-trainervertrag-sub").textContent =
      `erstellt · ${tv.ausstehend} ausstehend · ${tv.unvollstaendig} unvollständig`;
    document.getElementById("stat-trainerkodex").textContent = `${data.trainerkodex.confirmed} von ${data.trainerkodex.total}`;
    // Fallback "–", solange der Worker das Feld noch nicht liefert (alter Deploy).
    document.getElementById("stat-jugendschutz").textContent = data.jugendschutz ? `${data.jugendschutz.confirmed} von ${data.jugendschutz.total}` : "–";
  }

  document.getElementById("stat-feedback").textContent = String(data.feedbackOpen);
  document.getElementById("stat-materialbedarf").textContent = String(data.materialbedarfOpen);
  document.getElementById("stat-busplan").textContent = String(data.busplanOpen);
  // Fallback "–", solange der Worker das Feld noch nicht liefert (alter Deploy).
  document.getElementById("stat-testspielplaner").textContent = data.testspielplanerAngefragt == null ? "–" : String(data.testspielplanerAngefragt);

  renderRecentActivity(data);
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Seit 2026-08-10 nur noch die Anmeldungen (Michel-Vorgabe): das Dropdown mit den
// vier Listen ist weg, dafür sind es zehn statt fünf Einträge. Die Länge bestimmt
// der Worker -- hier wird ungekürzt gerendert, was ankommt (ein alter Worker
// liefert eben noch fünf, kein Fehlerfall).
//
// Die frühere Modulvariable adminStatsState ist damit ebenfalls entfallen: sie hielt
// die letzte Antwort nur fest, damit ein Dropdown-Wechsel ohne neuen Worker-Aufruf
// umschalten konnte. Ohne Dropdown gibt es nichts umzuschalten, und die Antwort
// kommt als Parameter aus renderAdminStats().
function renderRecentActivity(data) {
  const list = document.getElementById("admin-dashboard-recent-list");
  if (!list) return;
  const entries = (data && Array.isArray(data.recentLogins)) ? data.recentLogins : [];
  if (entries.length === 0) {
    list.innerHTML = '<li class="muted">Keine Daten vorhanden.</li>';
    return;
  }
  list.innerHTML = entries.map((e) => {
    const name = (e.vorname && e.nachname) ? `${e.vorname} ${e.nachname}` : e.username;
    return `<li><span>${escapeHtml(name)}</span><span class="recent-activity-when">${escapeHtml(fmtDateTime(e.at))}</span></li>`;
  }).join("");
}

async function loadAndRenderFeedback() {
  const errorEl = document.getElementById("feedback-admin-error");
  errorEl.style.display = "none";
  try {
    const data = await callWorker("list-feedback", {});
    feedbackState = Array.isArray(data.entries) ? data.entries : [];
    renderFeedbackAdmin();
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }
}

function renderFeedbackAdmin() {
  const list = document.getElementById("feedback-admin-list");
  if (!list) return;
  // Unerledigt zuerst, sonst neueste zuerst — Admin sieht offene Einträge oben.
  const sorted = feedbackState.slice().sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
  if (sorted.length === 0) {
    list.innerHTML = '<p class="muted">Noch kein Feedback vorhanden.</p>';
    return;
  }
  list.innerHTML = sorted.map((f) => {
    const tool = f.toolId ? toolById(f.toolId) : null;
    const type = f.type === "wunsch" ? "wunsch" : "feedback";
    const name = (f.vorname && f.nachname) ? `${f.vorname} ${f.nachname}` : (f.username || "?");
    const bereitsBeantwortet = !!f.antwort;
    return `
      <div class="feedback-admin-row" data-id="${escapeHtml(f.id || "")}">
        <div class="feedback-admin-main">
          <div class="feedback-item-head">
            <span class="feedback-badge feedback-badge-${type}">${type === "wunsch" ? "Wunsch" : "Feedback"}</span>
            <span class="muted">${escapeHtml(name)}</span>
          </div>
          <div class="muted" style="font-size:12px; margin-top:2px;">${tool ? `→ ${escapeHtml(tool.name)}` : "— Allgemein —"}</div>
          <div class="feedback-item-text">${escapeHtml(f.text || "")}</div>
          <div class="feedback-antwort-block">
            <label class="feedback-antwort-label" for="feedback-antwort-${escapeHtml(f.id || "")}">${bereitsBeantwortet ? `Antwort (von ${escapeHtml(f.antwortVon || "?")}${f.antwortAm ? ", " + escapeHtml(fmtDatumKurz(f.antwortAm)) : ""})` : "Antwort an " + escapeHtml(name)}</label>
            <textarea id="feedback-antwort-${escapeHtml(f.id || "")}" class="feedback-antwort-text" rows="2" maxlength="2000" placeholder="Antwort schreiben — der Einreicher bekommt sie im Tab „Feedback &amp; Hilfe“ und als Push-Nachricht.">${escapeHtml(f.antwort || "")}</textarea>
            <div class="feedback-antwort-aktionen">
              <button type="button" class="btn small feedback-antwort-btn">${bereitsBeantwortet ? "Antwort ändern" : "Antworten"}</button>
              <span class="muted feedback-antwort-status"></span>
            </div>
          </div>
        </div>
        <div class="feedback-admin-actions">
          <label class="checkbox-label"><input type="checkbox" class="feedback-done-checkbox" ${f.done ? "checked" : ""} /> Erledigt</label>
          <button type="button" class="btn danger small feedback-del-btn">Löschen</button>
        </div>
      </div>`;
  }).join("");
  list.querySelectorAll(".feedback-admin-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".feedback-done-checkbox").addEventListener("change", (e) => toggleFeedbackDone(id, e.target.checked));
    row.querySelector(".feedback-del-btn").addEventListener("click", () => deleteFeedbackEntry(id));
    row.querySelector(".feedback-antwort-btn").addEventListener("click", () => sendeFeedbackAntwort(id, row));
  });
}

// Eigene schmale Aktion statt eines Feldes im save-feedback-Array: nur so weiss
// der Worker, dass wirklich JETZT geantwortet wurde, und schickt genau dann eine
// Push-Nachricht (siehe handleFeedbackAntwort). Deshalb wird hier auch NICHT
// persistFeedback gerufen.
async function sendeFeedbackAntwort(id, row) {
  const feld = row.querySelector(".feedback-antwort-text");
  const statusEl = row.querySelector(".feedback-antwort-status");
  const knopf = row.querySelector(".feedback-antwort-btn");
  const text = feld.value.trim();
  const eintrag = feedbackState.find((f) => f.id === id);
  if (!text && !(eintrag && eintrag.antwort)) {
    statusEl.textContent = "Bitte erst eine Antwort schreiben.";
    return;
  }
  if (!text && !confirm("Antwort wirklich entfernen? Der Einreicher sieht sie dann nicht mehr.")) return;

  knopf.disabled = true;
  statusEl.style.color = "";
  statusEl.textContent = "Wird gesendet …";
  try {
    const res = await callWorker("feedback-antwort", { id, text });
    // Den Server-Stand uebernehmen statt die Eingabe zu spiegeln — antwortVon und
    // antwortAm setzt erst der Worker.
    if (res && res.entry) {
      feedbackState = feedbackState.map((f) => (f.id === id ? res.entry : f));
    }
    renderFeedbackAdmin();
  } catch (err) {
    knopf.disabled = false;
    statusEl.style.color = "#c0392b";
    statusEl.textContent = err.message;
  }
}

async function toggleFeedbackDone(id, done) {
  const prev = feedbackState.slice();
  feedbackState = feedbackState.map((f) => (f.id === id ? { ...f, done } : f));
  await persistFeedback(prev);
}

async function deleteFeedbackEntry(id) {
  if (!confirm("Diesen Eintrag wirklich löschen?")) return;
  const prev = feedbackState.slice();
  feedbackState = feedbackState.filter((f) => f.id !== id);
  await persistFeedback(prev);
}

// Speichert feedbackState serverseitig; bei Fehler Rollback auf den vorherigen Stand
// (identisches Muster zu persistNews).
async function persistFeedback(prevOnError) {
  const errorEl = document.getElementById("feedback-admin-error");
  const successEl = document.getElementById("feedback-admin-success");
  errorEl.style.display = "none";
  successEl.style.display = "none";
  try {
    const res = await callWorker("save-feedback", { entries: feedbackState });
    if (res && Array.isArray(res.entries)) feedbackState = res.entries;
    renderFeedbackAdmin();
    successEl.style.display = "block";
  } catch (err) {
    if (prevOnError) feedbackState = prevOnError;
    renderFeedbackAdmin();
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
  }
}

function activateTab(name) {
  document.querySelectorAll("nav button[data-tab]").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-section").forEach((s) => s.classList.remove("active"));
  const btn = document.querySelector('nav button[data-tab="' + name + '"]');
  if (btn) btn.classList.add("active");
  const section = document.getElementById("tab-" + name);
  if (section) section.classList.add("active");
  // Kalender-Widget hängt außerhalb von #tab-uebersicht (siehe loadSidebarWidget) —
  // beim Tab-Wechsel Sichtbarkeit anhand des geladenen Inhalts neu bewerten.
  const widget = document.getElementById("calendar-widget");
  if (widget) widget.style.display = (name === "uebersicht" && widget.dataset.hasContent === "1") ? "block" : "none";
  // Eigene Einreichungen erst beim Oeffnen des Tabs holen, nicht beim
  // Seitenaufbau — siehe loadMeineFeedbacks.
  if (name === "feedback") loadMeineFeedbacks();
}

function setupTabs() {
  document.querySelectorAll("nav button[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  document.getElementById("btn-empty-login").addEventListener("click", () => activateTab("konto"));
  document.getElementById("btn-feedback-empty-login").addEventListener("click", () => activateTab("konto"));
  document.getElementById("btn-admin-dashboard-back").addEventListener("click", () => activateTab("uebersicht"));
  document.getElementById("btn-admin-dashboard-refresh").addEventListener("click", () => loadAndRenderAdminStats());

  // Aktivitäts-Auswertung. Eigener Knopf statt Mitladen beim Dashboard-Öffnen —
  // sie kostet einen Worker-Aufruf je 20 Konten.
  const aktivitaetKnopf = document.getElementById("btn-aktivitaet-laden");
  if (aktivitaetKnopf) {
    aktivitaetKnopf.addEventListener("click", ladeAktivitaetsAuswertung);
    const monatEl = document.getElementById("aktivitaet-monat");
    if (monatEl && !monatEl.value) monatEl.value = aktuellerMonatIso();
  }
  document.getElementById("btn-admin-dashboard-open").addEventListener("click", () => {
    activateTab("admin-dashboard");
    loadAndRenderAdminStats();
  });

  // Push: der Einschalten-Knopf ruft die Erlaubnis-Abfrage direkt aus dem Klick.
  document.getElementById("btn-push-ein").addEventListener("click", pushEinschalten);
  // Delegation: die Schalter werden bei jedem Aufbau neu geschrieben, einzeln
  // registrierte Handler waeren nach dem ersten Rendern verwaist.
  document.getElementById("push-schalter").addEventListener("change", (e) => {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-push-anlass")) {
      pushSchalterSpeichern();
    }
  });
  // Abmelden per Delegation: die Liste wird bei jedem Aufbau neu geschrieben,
  // einzeln registrierte Handler waeren nach dem ersten Rendern verwaist.
  document.getElementById("push-geraete").addEventListener("click", (e) => {
    const knopf = e.target.closest ? e.target.closest("[data-push-ab]") : null;
    if (knopf) pushGeraetAbmelden(knopf.getAttribute("data-push-ab"));
  });

  document.getElementById("btn-materialcontainer").addEventListener("click", oeffneMaterialcontainer);
  document.getElementById("btn-materialcontainer-close").addEventListener("click", schliesseMaterialcontainer);
  // Klick auf den abgedunkelten Hintergrund schliesst ebenfalls -- aber nur dort,
  // nicht bei einem Klick INNERHALB des Fensters (z.B. beim Markieren des Codes).
  document.getElementById("materialcontainer-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) schliesseMaterialcontainer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") schliesseMaterialcontainer();
  });
  document.getElementById("btn-materialcontainer-save").addEventListener("click", speichereMaterialcontainerCode);
  document.getElementById("btn-aufgaben-gruppen-save").addEventListener("click", speichereAufgabenGruppen);

  // Nachricht an alle Handys. ⚠️ Der Verlauf wird beim AUFKLAPPEN geholt, nicht
  // beim Seitenaufbau -- zwei Nextcloud-Reads fuer ein Panel, das meistens
  // niemand oeffnet. Das toggle-Ereignis feuert auch beim Zuklappen, deshalb die
  // Abfrage auf .open.
  document.getElementById("admin-rundnachricht-panel").addEventListener("toggle", (e) => {
    if (e.target.open) rundnachrichtPanelLaden();
    else rundEmojiSchliessen();
  });
  document.getElementById("btn-rund-senden").addEventListener("click", sendeRundnachricht);
  document.getElementById("rund-kreis").addEventListener("change", () => {
    // ⚠️ Reihenfolge bindend: erst die Auswahl an den neuen Kreis anpassen, dann
    // rendern, dann die Reichweite. Andersherum stünde eine Zahl da, die eine
    // gerade entfernte Person noch mitzählt.
    rundAuswahlAnKreisAnpassen();
    rundAuswahlRendern();
    rundnachrichtReichweiteZeigen();
  });
  document.getElementById("rund-text").addEventListener("input", rundnachrichtZaehler);
  document.getElementById("rund-personen-suche").addEventListener("input", rundAuswahlRendern);
  document.getElementById("btn-rund-auswahl-leeren").addEventListener("click", () => rundAuswahlLeeren(false));

  // Emoji-Auswahl. ⚠️ Der Schließen-Handler an document muss den Klick auf einen
  // .emoji-knopf und auf die Palette selbst durchlassen: beide bubbeln bis
  // hierher, und sonst schlösse der Öffnen-Klick die Palette sofort wieder.
  const emojiKnoepfe = document.querySelectorAll(".emoji-knopf");
  for (let i = 0; i < emojiKnoepfe.length; i++) {
    emojiKnoepfe[i].addEventListener("click", (e) => rundEmojiUmschalten(e.currentTarget));
  }
  document.addEventListener("click", (e) => {
    if (!rundEmojiOffen()) return;
    if (rundEmojiPalette.contains(e.target)) return;
    if (e.target.closest && e.target.closest(".emoji-knopf")) return;
    rundEmojiSchliessen();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !rundEmojiOffen()) return;
    rundEmojiSchliessen();
    e.escapeVerbraucht = true;
  });

  const jumpToAdminPanel = (panelId) => {
    activateTab("admin");
    const panel = document.getElementById(panelId);
    if (panel) { panel.open = true; panel.scrollIntoView({ behavior: "smooth", block: "start" }); }
  };
  const openTool = (toolId) => {
    const tool = toolById(toolId);
    if (tool) window.open(tool.url, "_blank", "noopener");
  };
  const statTileActions = {
    "stat-tile-users": () => jumpToAdminPanel("admin-users-panel"),
    "stat-tile-feedback": () => jumpToAdminPanel("admin-feedback-panel"),
    "stat-tile-trainervertrag": () => openTool("trainerdaten"),
    "stat-tile-trainerkodex": () => openTool("trainerdaten"),
    "stat-tile-jugendschutz": () => openTool("trainerdaten"),
    "stat-tile-materialbedarf": () => openTool("materialbedarf"),
    "stat-tile-busplan": () => openTool("busplan"),
    "stat-tile-testspielplaner": () => openTool("testspielplaner")
  };
  Object.keys(statTileActions).forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", statTileActions[id]);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); statTileActions[id](); }
    });
  });
}

function renderHeaderUser() {
  const el = document.getElementById("header-user");
  const logoutBtn = document.getElementById("btn-logout");
  if (!currentUser) {
    el.style.display = "none";
    el.innerHTML = "";
    logoutBtn.style.display = "none";
    renderViewAsControl();
    return;
  }
  const adminBadge = currentUser.isAdmin ? '<span class="version-badge">Admin</span>' : "";
  const viewAsBadge = currentUser.viewAsGroupId ? '<span class="version-badge badge-view-as">🎭 Testansicht</span>' : "";
  el.innerHTML = `👤 ${escapeHtml(currentUser.username)}${adminBadge}${viewAsBadge}`;
  el.style.display = "flex";
  logoutBtn.style.display = "inline-flex";
  renderViewAsControl();
}

// Testansicht-Umschalter im Header: nur für echte Admins sichtbar (auch
// während eine Testansicht bereits aktiv ist, siehe realIsAdmin), lädt die
// Gruppenliste per list-directory nach (kein Admin-Gate im Worker, bleibt
// also auch während der Testansicht selbst abrufbar).
async function loadDirectoryGroupsIfNeeded() {
  if (!currentUser || !currentUser.realIsAdmin) return;
  try {
    const data = await callWorker("list-directory", {});
    directoryGroupsState = (data && data.groups) || [];
  } catch (e) {
    directoryGroupsState = [];
  }
  renderViewAsControl();
}

function renderViewAsControl() {
  const select = document.getElementById("view-as-select");
  if (!select) return;
  if (!currentUser || !currentUser.realIsAdmin) {
    select.style.display = "none";
    return;
  }
  select.innerHTML = '<option value="">👑 Admin (echt)</option>' +
    directoryGroupsState.map((g) => `<option value="${escapeHtml(g.id)}">🎭 Ansicht: ${escapeHtml(g.name)}</option>`).join("");
  select.value = currentUser.viewAsGroupId || "";
  select.style.display = "inline-block";
}

function setupViewAsControl() {
  const select = document.getElementById("view-as-select");
  if (!select) return;
  select.addEventListener("change", async () => {
    const groupId = select.value || null;
    try {
      const data = await callWorker("set-view-as", { groupId });
      currentUser = buildCurrentUser({ ...currentUser, ...data });
      await afterAuthChange();
    } catch (e) {
      alert("Testansicht konnte nicht umgeschaltet werden: " + e.message);
      renderViewAsControl();
    }
  });
}

// Maske "Passwort ändern" in der Karte "Mein Konto". Zugeklappt bis zum Klick, damit
// die Karte in erster Linie eine Auskunft bleibt und nicht wie ein Formular wirkt.
// Feste Beschriftung, damit das Zuruecksetzen nach dem Speichern nicht versehentlich
// den Zwischenstand ("Wird geändert …") festschreibt.
const PASSWORT_BTN_TEXT = "Passwort ändern";
let passwortWechselLaeuft = false;

function resetPasswortForm() {
  const form = document.getElementById("passwort-form");
  if (!form) return;
  form.reset();
  form.style.display = "none";
  document.getElementById("btn-passwort-aendern").style.display = "";
  document.getElementById("passwort-error").style.display = "none";
  document.getElementById("passwort-success").style.display = "none";
}

function setupPasswortForm() {
  const oeffnenBtn = document.getElementById("btn-passwort-aendern");
  const form = document.getElementById("passwort-form");
  const errorEl = document.getElementById("passwort-error");
  const successEl = document.getElementById("passwort-success");
  const speichernBtn = document.getElementById("btn-passwort-speichern");

  oeffnenBtn.addEventListener("click", () => {
    resetPasswortForm();
    oeffnenBtn.style.display = "none";
    form.style.display = "block";
    document.getElementById("passwort-alt").focus();
  });
  document.getElementById("btn-passwort-abbrechen").addEventListener("click", resetPasswortForm);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.style.display = "none";
    successEl.style.display = "none";
    const alt = document.getElementById("passwort-alt").value;
    const neu = document.getElementById("passwort-neu").value;

    // Regeln schon hier pruefen (identisch im Worker), spart einen Roundtrip.
    const pwError = validatePasswordStrength(neu);
    if (pwError) {
      errorEl.textContent = pwError;
      errorEl.style.display = "block";
      return;
    }

    // Das Hashen laeuft mit 100.000 PBKDF2-Iterationen und braucht spuerbar Zeit --
    // ohne Sperre loest ein zweiter Absendevorgang einen zweiten Wechsel aus, dessen
    // erste Antwort dann ein bereits entwertetes Token in den localStorage schreibt.
    // Das Flag statt nur btn.disabled: der Button sperrt zwar den Klick, aber nicht
    // jeden anderen Weg, ein submit-Event auszuloesen.
    if (passwortWechselLaeuft) return;
    passwortWechselLaeuft = true;
    speichernBtn.disabled = true;
    speichernBtn.textContent = "Wird geändert …";
    try {
      await changePassword(alt, neu);
      resetPasswortForm();
      successEl.textContent = "Passwort geändert. Auf anderen Geräten musst du dich neu anmelden.";
      successEl.style.display = "block";
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    } finally {
      passwortWechselLaeuft = false;
      speichernBtn.disabled = false;
      speichernBtn.textContent = PASSWORT_BTN_TEXT;
    }
  });
}

// Nav-Leiste an den Anmeldestatus anpassen. Drei Dinge haengen daran: "Einstellungen"
// ist rein administrativ und fuer alle anderen gar nicht erst sichtbar, "Info" steht
// nur Angemeldeten offen (siehe infoTabOffen), und der Konto-Tab heisst je nach Status
// "Anmelden" oder "Mein Konto" -- wer noch kein Konto hat, kann mit der Beschriftung
// "Mein Konto" nichts anfangen.
function renderNavTabs() {
  const istAdmin = !!(currentUser && currentUser.isAdmin);
  const infoOffen = infoTabOffen();
  document.getElementById("nav-konto").textContent = currentUser ? "Mein Konto" : "Anmelden";
  document.getElementById("nav-admin").style.display = istAdmin ? "" : "none";
  document.getElementById("nav-info").style.display = infoOffen ? "" : "none";
  // Unterschriften UND ToDos sind Personalsache: Spielerkonten bekommen auf allen
  // zugehoerigen Aktionen ohnehin 403, die Fenster haben fuer sie also nichts zu
  // zeigen. Beide Zugaenge sitzen im Header, nicht in der Nav -- Unterschriften
  // links neben dem Materialcontainercode, die ToDos rechts. Die beiden Knoepfe
  // haben unterschiedliche Bedingungen, siehe todosTabOffen/dokumenteTabOffen.
  const personalDa = todosTabOffen();
  updateKopfKnoepfe();

  // Wer sich aus einem Admin- oder dem Info-Tab heraus abmeldet, saehe sonst eine
  // Sektion, deren Inhalt gerade komplett ausgeblendet wurde: leere Seite, kein Tab
  // markiert. Aus dem Info-Tab geht es aufs Dashboard, nicht in die Anmeldemaske --
  // beim Abmelden will man die oeffentliche Startseite, kein Login-Formular.
  const aktiv = document.querySelector(".tab-section.active");
  if (!istAdmin && aktiv && (aktiv.id === "tab-admin" || aktiv.id === "tab-admin-dashboard")) {
    activateTab("konto");
  } else if (!infoOffen && aktiv && aktiv.id === "tab-info") {
    activateTab("uebersicht");
  }

  // Wer sich bei offenem Fenster abmeldet, stuende sonst weiter vor der zuletzt
  // geladenen Liste -- die Eintraege bleiben im DOM, bis etwas sie ersetzt.
  // Ausblenden allein genuegt hier nicht, der Inhalt muss auch weg. Gilt fuer
  // BEIDE Fenster; den Inhalt der ToDo-Liste raeumt loadAufgaben() selbst weg.
  if (!personalDa) {
    schliesseDokumenteFenster();
    schliesseTodosFenster();
    // Die Zahlen im DOM stehen zu lassen genuegt nicht -- beim Wechsel in die
    // Testansicht eines Spielerkontos laeuft renderNavTabs() ohne ein
    // anschliessendes loadAufgaben(), und die alten Zaehler kaemen beim naechsten
    // Einblenden unveraendert zurueck.
    aufgabenKopfZaehlerLeeren();
    if (dokumenteState.geladen || dokumenteState.anMich.length || dokumenteState.vonMir.length) {
      dokumenteState = { anMich: [], vonMir: [], canAssignDocs: false, geladen: false };
      renderDokumente();
    }
  }
}

// Gleiche Linie wie im Worker (aufgabenSession): angemeldetes Personal, keine
// Spielerkonten. Gilt unveraendert fuer die persoenlichen ToDos -- die stehen
// jedem Mitarbeiterkonto zu.
function todosTabOffen() {
  return !!currentUser && currentUser.art !== "spieler";
}

// Den Unterschriften-Knopf sieht seit 2026-07-29 NICHT mehr jedes Personalkonto
// (Michel-Vorgabe): entweder man darf Unterschriften anfordern, oder es liegt
// gerade eine eigene an. Ein Trainer ohne offenes Dokument hat dort nichts zu
// tun -- er konnte bisher nur "Selbst unterschreiben" benutzen, und das ist ein
// reiner Datei-Download ohne Vereinsvorgang.
// ⚠️ Bewusst KEIN reines Gruppen-Gate: sonst saehe ein Trainer den ihm
// zugewiesenen Vertrag nie und der ganze Anfordern-Weg liefe ins Leere.
// Die Daten kommen aus aufgabenState (beim Seitenstart geladen), nicht aus
// dokumenteState -- das wird erst beim Oeffnen des Fensters gefuellt.
function dokumenteTabOffen() {
  if (!todosTabOffen()) return false;
  if (aufgabenState.canAssignDocs) return true;
  return aufgabenState.meine.some((a) => a.dokId && !a.erledigt && !a.zurueckgezogenAm);
}

// Beide Kopf-Knoepfe an den geladenen Stand anpassen. Wird aus renderNavTabs
// (Anmeldestatus) UND aus renderAufgabenWidget (Datenstand) gerufen: beim
// Seitenstart laeuft checkSession() vor loadAufgaben(), da steht canAssignDocs
// noch auf false und der Knopf muss nachtraeglich erscheinen koennen.
function updateKopfKnoepfe() {
  const darfAnfordern = !!aufgabenState.canAssignDocs;
  const dokKnopf = document.getElementById("btn-dokumente-oeffnen");
  if (dokKnopf) dokKnopf.style.display = dokumenteTabOffen() ? "" : "none";
  const todoKnopf = document.getElementById("btn-todos-oeffnen");
  if (todoKnopf) todoKnopf.style.display = todosTabOffen() ? "" : "none";
  // "anfordern" nur bei denen, die es duerfen -- fuer einen Unterzeichner waere
  // die Beschriftung schlicht falsch. Als Klasse, NICHT als inline-style: unter
  // 860px blendet die Media-Query denselben Teil aus, und ein inline gesetztes
  // display:"" wuerde sie aushebeln.
  const lang = document.getElementById("dok-btn-lang");
  if (lang) lang.classList.toggle("aus", !darfAnfordern);
  // Der Knopf im Fenster hat dasselbe Gate wie das Anfordern (siehe renderDokumente).
  // Dritter Kopf-Knopf, gleiche Stelle: er verschwindet, sobald die App abgelegt
  // ist, damit die enge Kopfzeile nicht dauerhaft eine Zeile mehr traegt.
  const appKnopf = document.getElementById("btn-app-ablegen");
  if (appKnopf) appKnopf.style.display = appAblegenMoeglich() ? "" : "none";
}

// ---------- App auf dem Startbildschirm ablegen ----------

// Manifest und Service Worker liegen auf der WURZEL (eigenes Repo
// sc1911heiligenstadt.github.io), damit der Geltungsbereich "/" die ganze Flotte umfasst.
// Laegen sie hier, umfasste die abgelegte App nur /ToolsUebersicht/ und jeder
// Klick auf eine Kachel fuehrte heraus in den Browser -- auf dem iPhone in ein
// eigenes Safari-Fenster. Entwurf:
// docs/superpowers/specs/2026-08-01-pwa-app-icon-knopf-design.md

// Chrome feuert beforeinstallprompt einmal und erwartet, dass man das Ereignis
// aufhebt und spaeter selbst ausloest.
let appInstallEreignis = null;

// Laeuft die Seite schon als abgelegte App? Dann waere der Knopf sinnlos.
// ⚠️ Beide Wege noetig: display-mode deckt Android und den Rechner ab,
// navigator.standalone ist der aeltere iOS-Weg -- Safari kennt display-mode
// erst ab iOS 16.4, und in der Flotte sind aeltere Geraete unterwegs.
function istAlsAppGestartet() {
  const mm = window.matchMedia;
  const alsApp = !!mm && (mm("(display-mode: standalone)").matches
    || mm("(display-mode: fullscreen)").matches
    || mm("(display-mode: minimal-ui)").matches);
  return alsApp || window.navigator.standalone === true;
}

// Auf iOS gibt es keinen programmatischen Weg: Apple hat beforeinstallprompt nie
// umgesetzt. Dort kann der Knopf nur anleiten -- und das nur in Safari, denn
// "Zum Home-Bildschirm" bietet kein anderer iOS-Browser an, obwohl alle
// dieselbe Engine benutzen.
function istIosSafari() {
  const ua = navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua)
    // iPadOS meldet sich seit 13 als Macintosh; die Touchpunkte verraten es.
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!iOS) return false;
  return !/CriOS|FxiOS|EdgiOS|OPiOS|Mercury/.test(ua);
}

// Drei Bedingungen, alle noetig: angemeldet (Michel-Vorgabe, gleiche Linie wie
// Info-Tab und Neuigkeiten), noch nicht abgelegt, und die Plattform kann
// ueberhaupt etwas anbieten. Firefox und die iOS-Fremdbrowser fallen hier
// heraus -- ein Knopf, der nichts bewirkt, ist schlimmer als gar keiner.
function appAblegenMoeglich() {
  if (!currentUser) return false;
  if (istAlsAppGestartet()) return false;
  return !!appInstallEreignis || istIosSafari();
}

function setupAppInstallation() {
  // Der Geltungsbereich richtet sich nach dem ORT DER SKRIPTDATEI, nicht nach
  // dem der registrierenden Seite -- deshalb darf diese Seite im Unterordner
  // den Wurzel-Worker registrieren. Fehler werden geschluckt: ohne Service
  // Worker laesst sich die App nur nicht ablegen, die Uebersicht selbst
  // funktioniert unveraendert weiter.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    appInstallEreignis = e;
    // ⚠️ Das Ereignis trifft NACH dem Seitenaufbau ein. Ohne diesen Aufruf
    // bliebe der Knopf beim ersten Besuch aus, obwohl Ablegen moeglich waere --
    // dieselbe Falle wie bei canAssignDocs (siehe updateKopfKnoepfe).
    updateKopfKnoepfe();
  });

  window.addEventListener("appinstalled", () => {
    appInstallEreignis = null;
    schliesseAppAnleitung();
    updateKopfKnoepfe();
  });

  const knopf = document.getElementById("btn-app-ablegen");
  if (knopf) knopf.addEventListener("click", appAblegenKlick);
  const zu = document.getElementById("btn-app-ablegen-close");
  if (zu) zu.addEventListener("click", schliesseAppAnleitung);
  const overlay = document.getElementById("app-ablegen-overlay");
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) schliesseAppAnleitung();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const o = document.getElementById("app-ablegen-overlay");
    if (!o || o.style.display !== "flex") return;
    schliesseAppAnleitung();
    // Markierung wie bei den uebrigen Fenstern: ein anderer Handler an document
    // soll dasselbe Escape nicht ein zweites Mal verbrauchen.
    e.escapeVerbraucht = true;
  });
}

async function appAblegenKlick() {
  if (appInstallEreignis) {
    const ereignis = appInstallEreignis;
    // ⚠️ Ein Ereignis laesst sich genau EINMAL verwenden -- auch wenn der Nutzer
    // im Systemdialog abbricht, ist es verbraucht. Der Knopf verschwindet dann
    // bis zum naechsten Seitenaufruf, wo der Browser es erneut anbietet. Das ist
    // ehrlicher als ein Knopf, der beim zweiten Druck stumm bleibt.
    appInstallEreignis = null;
    try {
      await ereignis.prompt();
      await ereignis.userChoice;
    } catch (err) {
      // Dialog abgebrochen oder Ereignis abgelaufen -- nichts weiter zu tun.
    }
    updateKopfKnoepfe();
    return;
  }
  // Kein Ereignis heisst hier iOS-Safari (siehe appAblegenMoeglich): anleiten.
  oeffneAppAnleitung();
}

function oeffneAppAnleitung() {
  const o = document.getElementById("app-ablegen-overlay");
  if (o) o.style.display = "flex";
}

function schliesseAppAnleitung() {
  const o = document.getElementById("app-ablegen-overlay");
  if (o) o.style.display = "none";
}

// Der Info-Tab enthaelt die komplette Aenderungsliste, und die beschreibt Anmeldewege,
// Rechte-Stufen und interne Ablaeufe. Diese Seite ist die einzige, die ein nicht
// angemeldeter Besucher ueberhaupt erreicht -- fuer den bleibt der Tab deshalb zu.
function infoTabOffen() {
  return !!currentUser;
}

// Datum ohne Uhrzeit. Zweistellig erzwingen, sonst liefert de-DE "14.7.2026" statt
// "14.07.2026" und die Karte weicht vom Rest der App ab (vgl. fmtDateTime).
// Leerer String bei allem, was sich nicht als Datum lesen laesst -- die Aufrufer
// lassen die Zeile dann weg.
function fmtDatumKurz(wert) {
  if (!wert) return "";
  const d = new Date(wert);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// Ablaufdatum der aktuellen Anmeldung. Das Token ist "payloadB64.sigB64" (base64url),
// der Payload traegt exp als Unix-Sekunden. Wird hier nur GELESEN -- ausgestellt und
// geprueft wird serverseitig, ein manipuliertes Token wuerde beim naechsten Aufruf
// ohnehin abgelehnt; hier haengt nur eine Anzeige daran.
// Jeder Fehler (kein Token, falsches Format, kaputtes base64, kein exp) endet in "",
// nie in einer Exception: eine Konto-Auskunft darf nicht am Anzeigen scheitern.
function tokenAblaufDatum() {
  try {
    const token = loadStoredToken();
    const payloadTeil = token ? token.split(".")[0] : "";
    if (!payloadTeil) return "";
    const exp = JSON.parse(atob(payloadTeil.replace(/-/g, "+").replace(/_/g, "/"))).exp;
    return Number.isFinite(exp) ? fmtDatumKurz(exp * 1000) : "";
  } catch (_) {
    return "";
  }
}

// In welchen Tools darf ich mehr als lesen? Schnittmenge aus den Bearbeiter-/
// Administrieren-Gruppen je Tool (editGroupIds/adminGroupIds -- kommen mit der
// oeffentlichen Sichtbarkeits-Konfiguration ohnehin in den Client, kostet also
// keinen zusaetzlichen Aufruf) und den eigenen Gruppen. Tools ohne Sichtbarkeit
// bleiben draussen: ein Schreibrecht auf etwas, das man gar nicht sieht, ist
// wirkungslos. Administrieren wird ausgewiesen und impliziert Bearbeiten.
// Bewusst ueber isAdmin/groupIds und NICHT ueber realIsAdmin -- waehrend einer
// Admin-Testansicht soll hier stehen, was die getestete Gruppe darf.
function eigeneBearbeitenRechte() {
  const meine = new Set(currentUser.groupIds || []);
  const inMeinen = (ids) => (ids || []).some((id) => meine.has(id));
  return TOOLS
    .filter((t) => isVisibleToUser(t.id, currentUser))
    .map((t) => {
      const entry = visibilityState[t.id] || {};
      if (inMeinen(entry.adminGroupIds)) return t.name + " (administrieren)";
      if (inMeinen(entry.editGroupIds)) return t.name;
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "de"));
}

// Karte "Mein Konto" im gleichnamigen Tab. Sie steht dort zusammen mit den
// Anmeldewegen; der Einstellungen-Tab ist seit dem Umbau rein administrativ.
// ---------- Nutzerfoto (seit 2026-08-04) ----------
//
// Ein Bild je Konto, hinterlegt im Tab "Mein Konto". Zwei Wege hinein: die normale
// Dateiauswahl und -- am Handy -- direkt die Frontkamera. Beide landen im selben
// Zuschnitt-Dialog, aus dem immer ein quadratisches JPEG herauskommt. Das Quadrat
// entsteht HIER und nicht erst bei der Anzeige, damit jede App, die das Bild
// spaeter zeigt (Kadermanager), es fertig passend bekommt.
const FOTO_ZIEL_PX = 320;            // Kantenlaenge des gespeicherten Quadrats
const FOTO_QUALITAET = 0.85;
const FOTO_MAX_BYTES = 512 * 1024;   // muss zum Cap in admin-worker.js passen

// "<nutzername>@<fotoVersion>" -> Objekt-URL.
//
// ⚠️ Der Schluessel traegt die VERSION mit. Ohne sie bliebe nach dem Hochladen
// eines neuen Bildes das alte im Cache haengen, und der Nutzer saehe seine eigene
// Aenderung erst nach einem Seitenaufruf nicht mehr.
const nutzerfotoBlobs = new Map();

// ⚠️ Der Abruf verlangt den Token, ein schlichtes <img src="..."> geht deshalb
// nicht -- die Bytes muessen geholt und als Objekt-URL eingehaengt werden. Gleiche
// Lage wie bei den Neuigkeiten-Medien.
async function nutzerfotoUrl(username, version) {
  if (!username || !version) return null;
  const schluessel = username + "@" + version;
  const vorhanden = nutzerfotoBlobs.get(schluessel);
  if (vorhanden) return vorhanden;
  try {
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + loadStoredToken() },
      body: JSON.stringify({ action: "nutzerfoto-get", username })
    });
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    nutzerfotoBlobs.set(schluessel, url);
    return url;
  } catch (_) {
    return null;
  }
}

// Beim Abmelden aufraeumen: eine Objekt-URL bleibt sonst gueltig, solange die Seite
// offen ist -- auch fuer den naechsten, der sich an diesem Geraet anmeldet.
function nutzerfotoBlobsLeeren() {
  nutzerfotoBlobs.forEach((url) => URL.revokeObjectURL(url));
  nutzerfotoBlobs.clear();
}

function fotoStatusSetzen(id, text, istFehler) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "" : "none";
  el.classList.toggle("fehler", !!istFehler);
}

async function renderKontoFoto() {
  const kreis = document.getElementById("konto-foto-vorschau");
  const entfernen = document.getElementById("btn-foto-entfernen");
  if (!kreis || !entfernen || !currentUser) return;

  const version = currentUser.fotoVersion;
  entfernen.style.display = version ? "" : "none";
  // Immer erst auf den Buchstaben zuruecksetzen: sonst bliebe nach dem Entfernen
  // das alte Bild als Hintergrund stehen.
  kreis.style.backgroundImage = "";
  kreis.textContent = ((currentUser.vorname || currentUser.username || "?").trim()[0] || "?").toUpperCase();
  if (!version) return;

  const url = await nutzerfotoUrl(currentUser.username, version);
  // ⚠️ Nach dem await kann alles anders sein (abgemeldet, Bild inzwischen ersetzt
  // oder entfernt). Nur uebernehmen, wenn die Version noch dieselbe ist -- sonst
  // schreibt eine langsame Antwort einen ueberholten Stand zurueck.
  if (!url || !currentUser || currentUser.fotoVersion !== version) return;
  kreis.textContent = "";
  kreis.style.backgroundImage = 'url("' + url + '")';
}

// ---- Zuschnitt ----
//
// Zustand des offenen Dialogs. `ziel` ist null fuer das eigene Konto und traegt
// sonst den fremden Nutzernamen (Admin-Weg aus der Nutzerverwaltung).
let fotoZuschnitt = null;

// Zielkonto des Admin-Wegs, gemerkt zwischen Knopfdruck und Dateiauswahl. Die
// Eingabe ist global (die Nutzerzeilen werden bei jedem Rendern neu gebaut).
let adminFotoZiel = null;

// Der Canvas-Puffer ist GENAU so gross wie das Ergebnis (320x320). Dadurch ist
// "was ich sehe" byte-genau "was gespeichert wird" -- es gibt keine zweite
// Umrechnung beim Export, in der sich ein Rundungsfehler verstecken koennte.
function fotoZeichnen(mitMaske) {
  const z = fotoZuschnitt;
  if (!z || !z.bild) return;
  const c = z.ctx;
  const S = FOTO_ZIEL_PX;
  c.clearRect(0, 0, S, S);
  c.fillStyle = "#2b2b2b";
  c.fillRect(0, 0, S, S);

  const b = z.bild;
  const m = fotoMassstab();
  c.save();
  c.translate(S / 2 + z.x, S / 2 + z.y);
  c.rotate((z.drehung * Math.PI) / 180);
  c.drawImage(b, (-b.naturalWidth * m) / 2, (-b.naturalHeight * m) / 2,
    b.naturalWidth * m, b.naturalHeight * m);
  c.restore();

  // Runde Hilfsmaske: der Ausschnitt ist quadratisch, angezeigt wird er rund.
  // Ohne sie schneidet man ein Gesicht zurecht, das in der Kachel dann an den
  // Ecken abgeschnitten ist.
  //
  // ⚠️ Beim Speichern wird OHNE Maske neu gezeichnet -- sonst braenne die
  // Abdunklung mit ins Bild ein.
  if (mitMaske === false) return;
  c.save();
  c.fillStyle = "rgba(0, 0, 0, 0.45)";
  c.beginPath();
  c.rect(0, 0, S, S);
  // Gegenlaeufiger Kreis => Loch in der Flaeche (nonzero-Fuellregel).
  c.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2, true);
  c.fill();
  c.restore();
}

// Bildmasse bei 90/270 Grad vertauscht -- sonst laesst eine Drehung Luecken am Rand.
function fotoGedrehteMasse() {
  const b = fotoZuschnitt.bild;
  const quer = Math.abs(fotoZuschnitt.drehung % 180) === 90;
  return {
    w: quer ? b.naturalHeight : b.naturalWidth,
    h: quer ? b.naturalWidth : b.naturalHeight
  };
}

// Grundskalierung ist "fuellt den Rahmen" (cover), darauf der Zoom des Reglers.
function fotoMassstab() {
  const { w, h } = fotoGedrehteMasse();
  return Math.max(FOTO_ZIEL_PX / w, FOTO_ZIEL_PX / h) * fotoZuschnitt.zoom;
}

// Das Bild darf nie so weit wandern, dass ein leerer Rand im Ausschnitt steht.
function fotoGrenzenHalten() {
  const z = fotoZuschnitt;
  if (!z || !z.bild) return;
  const { w, h } = fotoGedrehteMasse();
  const m = fotoMassstab();
  const maxX = Math.max(0, (w * m) / 2 - FOTO_ZIEL_PX / 2);
  const maxY = Math.max(0, (h * m) / 2 - FOTO_ZIEL_PX / 2);
  z.x = Math.min(maxX, Math.max(-maxX, z.x));
  z.y = Math.min(maxY, Math.max(-maxY, z.y));
}

function oeffneFotoZuschnitt(bild, objektUrl, zielUsername) {
  const overlay = document.getElementById("foto-zuschnitt-overlay");
  const canvas = document.getElementById("foto-canvas");
  const buehne = document.getElementById("foto-buehne");

  // ⚠️ Erst sichtbar machen, DANN messen. Ein Canvas hinter display:none meldet
  // seine Standardmasse 300x150, und die Buehne daneben clientWidth 0 -- der erste
  // Zuschnitt kaeme verzerrt und winzig heraus.
  overlay.style.display = "flex";
  canvas.width = FOTO_ZIEL_PX;
  canvas.height = FOTO_ZIEL_PX;
  const platz = Math.max(180, Math.min(FOTO_ZIEL_PX, buehne.clientWidth || FOTO_ZIEL_PX));
  canvas.style.width = platz + "px";
  canvas.style.height = platz + "px";

  fotoZuschnitt = {
    bild, objektUrl,
    ziel: zielUsername || null,
    ctx: canvas.getContext("2d"),
    zoom: 1, drehung: 0, x: 0, y: 0, zieht: null
  };
  document.getElementById("foto-zoom").value = "100";
  fotoStatusSetzen("foto-zuschnitt-status", "", false);
  fotoGrenzenHalten();
  fotoZeichnen(true);
}

function schliesseFotoZuschnitt() {
  const overlay = document.getElementById("foto-zuschnitt-overlay");
  if (overlay) overlay.style.display = "none";
  if (fotoZuschnitt && fotoZuschnitt.objektUrl) URL.revokeObjectURL(fotoZuschnitt.objektUrl);
  fotoZuschnitt = null;
  document.getElementById("btn-foto-speichern").disabled = false;
}

function fotoZuschnittOffen() {
  const o = document.getElementById("foto-zuschnitt-overlay");
  return !!o && o.style.display === "flex";
}

// Eine gewaehlte Datei in den Zuschnitt bringen. `zielUsername` nur fuer den
// Admin-Weg; ohne Angabe gilt das eigene Konto.
function fotoDateiUebernehmen(datei, zielUsername, statusId) {
  if (!datei) return;
  if (!/^image\//.test(datei.type || "")) {
    fotoStatusSetzen(statusId, "Das ist kein Bild — bitte JPEG, PNG oder WebP wählen.", true);
    return;
  }
  fotoStatusSetzen(statusId, "", false);
  const url = URL.createObjectURL(datei);
  const bild = new Image();
  bild.onload = () => oeffneFotoZuschnitt(bild, url, zielUsername);
  bild.onerror = () => {
    URL.revokeObjectURL(url);
    fotoStatusSetzen(statusId, "Das Bild konnte nicht gelesen werden.", true);
  };
  bild.src = url;
}

// toBlob kennt jeder Browser der Flotte, aber sehr alte Safari-Staende nur
// toDataURL -- ohne den Rueckfallweg schluege das Speichern dort stumm fehl.
function canvasAlsJpeg(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Das Bild konnte nicht erzeugt werden."))),
        "image/jpeg", FOTO_QUALITAET
      );
      return;
    }
    try {
      const roh = atob(canvas.toDataURL("image/jpeg", FOTO_QUALITAET).split(",")[1]);
      const bytes = new Uint8Array(roh.length);
      for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
      resolve(new Blob([bytes], { type: "image/jpeg" }));
    } catch (_) {
      reject(new Error("Das Bild konnte nicht erzeugt werden."));
    }
  });
}

async function fotoSpeichern() {
  const z = fotoZuschnitt;
  if (!z) return;
  const btn = document.getElementById("btn-foto-speichern");
  btn.disabled = true;
  fotoStatusSetzen("foto-zuschnitt-status", "Wird gespeichert …", false);
  const canvas = document.getElementById("foto-canvas");
  try {
    fotoZeichnen(false);          // ohne Maske: die darf nicht mit eingebrannt werden
    const blob = await canvasAlsJpeg(canvas);
    fotoZeichnen(true);
    const bytes = await dateiAlsBytes(blob);
    if (bytes.length > FOTO_MAX_BYTES) {
      throw new Error("Das Bild ist zu groß geworden. Bitte einen kleineren Ausschnitt wählen.");
    }
    const nutzlast = { dataBase64: bytesZuBase64(bytes) };
    if (z.ziel) nutzlast.username = z.ziel;
    const res = await callWorker("nutzerfoto-put", nutzlast);

    if (z.ziel) {
      // Admin hat ein fremdes Bild gesetzt: die Nutzerliste traegt die Versionen.
      schliesseFotoZuschnitt();
      await loadAndRenderUsers();
    } else {
      currentUser.fotoVersion = (res && res.fotoVersion) || Date.now();
      schliesseFotoZuschnitt();
      await renderKontoFoto();
      fotoStatusSetzen("foto-status", "Foto gespeichert.", false);
    }
  } catch (e) {
    fotoZeichnen(true);
    fotoStatusSetzen("foto-zuschnitt-status", e.message || "Speichern fehlgeschlagen.", true);
    btn.disabled = false;
  }
}

async function eigenesFotoEntfernen() {
  if (!confirm("Dein Foto wirklich entfernen?")) return;
  try {
    await callWorker("nutzerfoto-loeschen", {});
    currentUser.fotoVersion = null;
    await renderKontoFoto();
    fotoStatusSetzen("foto-status", "Foto entfernt.", false);
  } catch (e) {
    fotoStatusSetzen("foto-status", e.message || "Entfernen fehlgeschlagen.", true);
  }
}

function setupKontoFoto() {
  const datei = document.getElementById("foto-datei");
  const kamera = document.getElementById("foto-kamera-datei");

  document.getElementById("btn-foto-waehlen").addEventListener("click", () => datei.click());
  document.getElementById("btn-foto-kamera").addEventListener("click", () => kamera.click());
  document.getElementById("btn-foto-entfernen").addEventListener("click", eigenesFotoEntfernen);

  // ⚠️ value danach leeren: waehlt jemand zweimal dieselbe Datei, feuert `change`
  // sonst kein zweites Mal -- nach einem Abbruch im Zuschnitt kaeme man dann nicht
  // mehr an dasselbe Bild heran.
  [datei, kamera].forEach((eingabe) => {
    eingabe.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      fotoDateiUebernehmen(f, null, "foto-status");
    });
  });

  // Admin-Weg: dieselbe Zuschnitt-Strecke, nur mit fremdem Zielkonto.
  document.getElementById("admin-foto-datei").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    fotoDateiUebernehmen(f, adminFotoZiel, "users-error");
  });

  document.getElementById("btn-foto-speichern").addEventListener("click", fotoSpeichern);
  document.getElementById("btn-foto-abbrechen").addEventListener("click", schliesseFotoZuschnitt);
  document.getElementById("btn-foto-zuschnitt-close").addEventListener("click", schliesseFotoZuschnitt);
  document.getElementById("foto-zuschnitt-overlay").addEventListener("click", (e) => {
    if (e.target.id === "foto-zuschnitt-overlay") schliesseFotoZuschnitt();
  });
  document.addEventListener("keydown", (e) => {
    // Gleiche Staffelung wie bei den anderen Dialogen: die Markierung setzen, damit
    // ein darunterliegendes Fenster nicht auf denselben Tastendruck mit zuklappt.
    if (e.key !== "Escape" || !fotoZuschnittOffen() || e.escapeVerbraucht) return;
    e.escapeVerbraucht = true;
    schliesseFotoZuschnitt();
  });

  document.getElementById("foto-zoom").addEventListener("input", (e) => {
    if (!fotoZuschnitt) return;
    fotoZuschnitt.zoom = Math.max(1, Number(e.target.value) / 100);
    fotoGrenzenHalten();
    fotoZeichnen(true);
  });
  document.getElementById("btn-foto-drehen").addEventListener("click", () => {
    if (!fotoZuschnitt) return;
    fotoZuschnitt.drehung = (fotoZuschnitt.drehung + 90) % 360;
    // Verschiebung zuruecksetzen: nach einer Drehung zeigt der alte Versatz in eine
    // andere Richtung als vorher und wirkt wie ein Sprung.
    fotoZuschnitt.x = 0;
    fotoZuschnitt.y = 0;
    fotoGrenzenHalten();
    fotoZeichnen(true);
  });

  // Ziehen ueber Pointer-Events mit setPointerCapture -- dasselbe Muster wie das
  // Taktikboard im Kadermanager, das damit auf Touch UND Maus einheitlich laeuft.
  const canvas = document.getElementById("foto-canvas");
  canvas.addEventListener("pointerdown", (e) => {
    if (!fotoZuschnitt) return;
    fotoZuschnitt.zieht = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("zieht");
  });
  canvas.addEventListener("pointermove", (e) => {
    const z = fotoZuschnitt;
    if (!z || !z.zieht || z.zieht.id !== e.pointerId) return;
    // Der Canvas wird kleiner angezeigt, als sein Puffer gross ist: die
    // Mausbewegung muss in Puffer-Pixel umgerechnet werden, sonst wandert das Bild
    // am Handy spuerbar langsamer als der Finger.
    const rect = canvas.getBoundingClientRect();
    const faktor = rect.width ? FOTO_ZIEL_PX / rect.width : 1;
    z.x += (e.clientX - z.zieht.x) * faktor;
    z.y += (e.clientY - z.zieht.y) * faktor;
    z.zieht.x = e.clientX;
    z.zieht.y = e.clientY;
    fotoGrenzenHalten();
    fotoZeichnen(true);
  });
  ["pointerup", "pointercancel"].forEach((typ) => {
    canvas.addEventListener(typ, (e) => {
      if (fotoZuschnitt) fotoZuschnitt.zieht = null;
      canvas.classList.remove("zieht");
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    });
  });
}

function renderKontoKarte() {
  renderKontoFoto();
  const rows = [];
  const name = [currentUser.vorname, currentUser.nachname].filter(Boolean).join(" ");
  if (name) rows.push(["Name", escapeHtml(name)]);
  rows.push(["Nutzername", escapeHtml(currentUser.username)]);
  if (currentUser.lizenz) rows.push(["Trainerlizenz", escapeHtml(currentUser.lizenz)]);
  if (currentUser.mannschaften.length) {
    rows.push(["Mannschaften", currentUser.mannschaften.map(escapeHtml).join(", ")]);
  }
  // Namen kommen fertig aufgeloest aus "me" (groupNames). Vor dem Worker-Deploy vom
  // 2026-07-21 fehlt das Feld -- dann bleibt die Zeile weg, statt IDs zu zeigen.
  if (currentUser.groupNames.length) {
    rows.push(["Gruppen", currentUser.groupNames.map(escapeHtml).join(", ")]);
  }
  if (currentUser.isAdmin) rows.push(["Rechte", "Administrator"]);

  // Diese Zeile erscheint IMMER, auch ohne jedes Schreibrecht: sie beantwortet die
  // Frage "warum kann ich dort nichts speichern" -- sie wegzulassen liesse genau die
  // Frage offen, fuer die sie da ist.
  if (currentUser.isAdmin) {
    rows.push(["Bearbeiten", "Alle Tools (als Administrator)"]);
  } else {
    const bearbeitbar = eigeneBearbeitenRechte();
    rows.push(["Bearbeiten", bearbeitbar.length ? bearbeitbar.map(escapeHtml).join(", ") : "Nur Ansehen"]);
  }

  const passwortDatum = fmtDatumKurz(currentUser.passwordSetAt);
  if (passwortDatum) rows.push(["Passwort geändert", escapeHtml(passwortDatum)]);
  const ablauf = tokenAblaufDatum();
  if (ablauf) rows.push(["Anmeldung gültig bis", escapeHtml(ablauf)]);

  document.getElementById("konto-details").innerHTML = rows
    .map(([dt, dd]) => `<dt>${dt}</dt><dd>${dd}</dd>`)
    .join("");
}

function renderAdminPanels() {
  renderHeaderUser();
  renderNavTabs();
  document.getElementById("admin-bootstrap-panel").style.display = "none";
  document.getElementById("admin-login-gate").style.display = "none";
  document.getElementById("login-password-panel").style.display = "none";
  document.getElementById("first-login-panel").style.display = "none";
  document.getElementById("admin-logged-in-panel").style.display = "none";
  document.getElementById("admin-users-panel").style.display = "none";
  document.getElementById("admin-groups-panel").style.display = "none";
  document.getElementById("admin-visibility-panel").style.display = "none";
  document.getElementById("admin-news-panel").style.display = "none";
  document.getElementById("admin-feedback-panel").style.display = "none";
  document.getElementById("admin-materialcontainer-panel").style.display = "none";
  document.getElementById("admin-rundnachricht-panel").style.display = "none";
  document.getElementById("admin-aufgaben-panel").style.display = "none";
  document.getElementById("push-panel").style.display = "none";
  document.getElementById("punkte-panel").style.display = "none";
  document.getElementById("btn-admin-dashboard-open").style.display = "none";
  // Der Knopf im Kopfbereich haengt nicht an isAdmin, sondern am Angemeldetsein --
  // ihn sehen alle ausser Spielerkonten. Der Worker prueft dasselbe noch einmal.
  document.getElementById("btn-materialcontainer").style.display =
    (currentUser && currentUser.art !== "spieler") ? "inline-flex" : "none";

  if (currentUser) {
    renderKontoKarte();
    document.getElementById("admin-logged-in-panel").style.display = "block";
    // Laeuft nebenher: der Aufbau fragt den Server und darf den Rest des
    // Konto-Tabs nicht aufhalten. Fehler landen sichtbar in der Karte selbst.
    pushPanelAufbauen();
    // Ebenfalls nebenher, aus demselben Grund.
    punktePanelAufbauen();
    if (currentUser.isAdmin) {
      document.getElementById("admin-users-panel").style.display = "block";
      document.getElementById("admin-groups-panel").style.display = "block";
      document.getElementById("admin-visibility-panel").style.display = "block";
      document.getElementById("admin-news-panel").style.display = "block";
      document.getElementById("admin-feedback-panel").style.display = "block";
      document.getElementById("admin-materialcontainer-panel").style.display = "block";
      document.getElementById("admin-rundnachricht-panel").style.display = "block";
      document.getElementById("admin-aufgaben-panel").style.display = "block";
      document.getElementById("btn-admin-dashboard-open").style.display = "inline-flex";
    }
    return;
  }
  if (pendingFirstLoginUsername) {
    document.getElementById("first-login-username").textContent = pendingFirstLoginUsername;
    document.getElementById("first-login-panel").style.display = "block";
    return;
  }
  if (pendingLoginUsername) {
    document.getElementById("login-password-username").textContent = pendingLoginUsername;
    document.getElementById("login-password-panel").style.display = "block";
    return;
  }
  if (bootstrapAvailable) {
    document.getElementById("admin-bootstrap-panel").style.display = "block";
    return;
  }
  document.getElementById("admin-login-gate").style.display = "block";
}

// ---------- Materialcontainer-Code ----------

// Der Code wird bewusst erst beim Oeffnen des Fensters geholt und nirgends
// zwischengespeichert: er gehoert zu einem echten Schloss und soll nur dann ueber
// die Leitung gehen, wenn ihn jemand ausdruecklich sehen will.
async function oeffneMaterialcontainer() {
  const statusEl = document.getElementById("materialcontainer-status");
  const codeEl = document.getElementById("materialcontainer-code");
  const hinweisEl = document.getElementById("materialcontainer-hinweis");
  const metaEl = document.getElementById("materialcontainer-meta");

  document.getElementById("materialcontainer-overlay").style.display = "flex";
  statusEl.style.display = "";
  statusEl.style.color = "";
  statusEl.textContent = "Code wird geladen …";
  codeEl.style.display = "none";
  hinweisEl.style.display = "none";
  metaEl.style.display = "none";
  document.getElementById("btn-materialcontainer-close").focus();

  try {
    const data = await callWorker("get-materialcontainer-code", {});
    if (!data.code) {
      statusEl.textContent = "Es ist noch kein Code hinterlegt. Ein Administrator trägt ihn unter „Einstellungen → Materialcontainer-Code“ ein.";
      return;
    }
    statusEl.style.display = "none";
    codeEl.textContent = data.code;
    codeEl.style.display = "";
    if (data.hinweis) {
      hinweisEl.textContent = data.hinweis;
      hinweisEl.style.display = "";
    }
    const datum = fmtDatumKurz(data.geaendertAm);
    if (datum) {
      metaEl.textContent = "Zuletzt geändert am " + datum;
      metaEl.style.display = "";
    }
  } catch (e) {
    statusEl.style.color = "#c0392b";
    statusEl.textContent = e.message;
  }
}

function schliesseMaterialcontainer() {
  document.getElementById("materialcontainer-overlay").style.display = "none";
}

function zeigeMaterialcontainerAdminMeta(data) {
  const datum = fmtDatumKurz(data && data.geaendertAm);
  document.getElementById("materialcontainer-admin-meta").textContent = datum
    ? "Zuletzt geändert am " + datum + ((data && data.geaendertVon) ? " von " + data.geaendertVon : "")
    : "Noch kein Code hinterlegt.";
}

// Den hinterlegten Code echt ins Feld schreiben, nicht nur als Platzhalter
// andeuten: der Admin soll sehen, was gerade gilt, bevor er ihn ersetzt.
async function ladeMaterialcontainerInsAdminFeld() {
  try {
    const data = await callWorker("get-materialcontainer-code", {});
    document.getElementById("materialcontainer-code-input").value = data.code || "";
    document.getElementById("materialcontainer-hinweis-input").value = data.hinweis || "";
    zeigeMaterialcontainerAdminMeta(data);
  } catch (_) { /* best effort -- das Panel bleibt bedienbar, Speichern geht trotzdem */ }
}

async function speichereMaterialcontainerCode() {
  const errEl = document.getElementById("materialcontainer-admin-error");
  const okEl = document.getElementById("materialcontainer-admin-success");
  errEl.style.display = "none";
  okEl.style.display = "none";
  try {
    const data = await callWorker("set-materialcontainer-code", {
      code: document.getElementById("materialcontainer-code-input").value,
      hinweis: document.getElementById("materialcontainer-hinweis-input").value
    });
    zeigeMaterialcontainerAdminMeta(data);
    okEl.style.display = "block";
    setTimeout(() => { okEl.style.display = "none"; }, 3000);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = "block";
  }
}

// ---------- Nachricht an alle Handys (seit 2026-08-06) ----------
//
// Gegenstueck zum Push-Panel im Konto-Tab: dort stellt jeder seinen eigenen
// Empfang ein, hier verschickt ein Admin an alle.

// Zuletzt vom Worker gemeldete Reichweite je Empfaengerkreis. Wird beim
// Aufklappen geholt und beim Umschalten des Dropdowns nur noch angezeigt --
// ein Read je Klick auf ein Auswahlfeld waere Verschwendung.
let rundErreichbarCache = null;

// ⚠️ Haengt am Aufklappen des Panels, NICHT an renderAdminPanels(). Der Aufruf
// kostet zwei Nextcloud-Reads (Abos + Verlauf) und wuerde sonst bei jedem
// Seitenaufbau und nach jeder An-/Abmeldung eines Admins mitlaufen, auch wenn
// niemand eine Nachricht schicken will. Gleiche Ueberlegung wie bei
// loadMeineFeedbacks().
async function rundnachrichtPanelLaden() {
  const errEl = document.getElementById("rund-error");
  const verlaufEl = document.getElementById("rund-verlauf");
  if (!verlaufEl) return;
  rundnachrichtZaehler();

  // ⚠️ Nur der Worker-Aufruf steht im try. Kennt ein aelterer Worker die Aktion
  // noch nicht, bleibt das Panel bedienbar (Senden meldet dann selbst) -- ein
  // Fehler BEIM RENDERN soll dagegen in der Konsole stehen.
  let data;
  try {
    data = await callWorker("push-rundnachricht-verlauf", {});
  } catch (e) {
    console.warn("Rundnachricht-Verlauf nicht verfügbar", e && e.message ? e.message : e);
    document.getElementById("rund-reichweite").textContent = "";
    verlaufEl.innerHTML = "";
    return;
  }
  if (errEl) errEl.style.display = "none";

  rundErreichbarCache = (data && data.erreichbar) || null;
  // ⚠️ Fehlt das Feld (aelterer Worker), bleibt der Eingrenzen-Block versteckt.
  // Eine Auswahl anzubieten, die der Server verwirft, hiesse: die Nachricht geht
  // an alle, obwohl die Maske drei Haken zeigt.
  rundAuswahlQuelle = (data && data.auswahl && Array.isArray(data.auswahl.personen)) ? data.auswahl : null;
  rundAuswahlLeeren(true);
  rundAuswahlRendern();
  rundnachrichtReichweiteZeigen();
  rundnachrichtVerlaufRendern((data && data.verlauf) || []);
}

function rundKreis() {
  const el = document.getElementById("rund-kreis");
  return (el && el.value === "alle") ? "alle" : "personal";
}

// ---------- Eingrenzen auf Gruppen und Personen (seit 2026-08-07) ----------
//
// Michel-Wunsch: nicht immer an den ganzen Kreis. Gerechnet wird die Auswahl
// clientseitig aus den Daten, die der Verlauf-Aufruf ohnehin mitliefert -- der
// Worker prueft dieselbe Regel beim Senden noch einmal selbst (rundEmpfaenger),
// die Anzeige hier ist Vorschau, keine Schranke.
let rundAuswahlQuelle = null;
const rundAuswahl = { gruppen: [], personen: [] };
const RUND_PERSONEN_SICHTBAR = 60;   // darueber hilft nur noch das Suchfeld

function rundAuswahlAktiv() {
  return !!(rundAuswahl.gruppen.length || rundAuswahl.personen.length);
}

// Konten, die der Kreis zulaesst -- die aeussere Grenze, wie im Worker.
function rundImKreis() {
  if (!rundAuswahlQuelle) return [];
  const kreis = rundKreis();
  return rundAuswahlQuelle.personen.filter((p) => kreis === "alle" || p.art !== "spieler");
}

// Wen die Nachricht bei der aktuellen Einstellung wirklich trifft: erst der
// Kreis, dann die Eingrenzung -- dieselbe Reihenfolge wie rundEmpfaenger im
// Worker. Ohne Auswahl ist es der ganze Kreis.
function rundGetroffene() {
  const imKreis = rundImKreis();
  if (!rundAuswahlAktiv()) return imKreis;
  // Object.create(null): ein Konto oder eine Gruppe namens "__proto__" traefe
  // sonst den Prototyp und gaelte faelschlich als ausgewaehlt.
  const erlaubt = Object.create(null);
  rundAuswahl.gruppen.forEach((gid) => {
    const g = rundAuswahlQuelle.gruppen.filter((x) => x.id === gid)[0];
    if (g && Array.isArray(g.mitglieder)) g.mitglieder.forEach((m) => { erlaubt[m] = true; });
  });
  rundAuswahl.personen.forEach((u) => { erlaubt[u] = true; });
  return imKreis.filter((p) => erlaubt[p.username] === true);
}

// Liefert dieselben Felder wie die Worker-Antwort, damit Reichweitenzeile und
// die beiden Namenslisten unveraendert weiterlaufen -- ohne Auswahl kommt der
// Wert direkt vom Server, mit Auswahl aus der Rechnung oben.
function rundZahlenFuerAnzeige() {
  const ausCache = rundErreichbarCache && rundErreichbarCache[rundKreis()];
  if (!rundAuswahlAktiv() || !rundAuswahlQuelle) return ausCache || null;
  const treffer = rundGetroffene();
  const namen = (liste) => liste.map((p) => p.name).sort((a, b) => a.localeCompare(b, "de"));
  const mit = treffer.filter((p) => p.geraete > 0);
  return {
    personen: mit.length,
    geraete: mit.reduce((s, p) => s + p.geraete, 0),
    infrage: treffer.length,
    wer: namen(mit),
    ohne: namen(treffer.filter((p) => !(p.geraete > 0)))
  };
}

// Klartext fuer die Sicherheitsabfrage und den Verlauf. Gruppen mit NAMEN, weil
// eine Id wie "foerderung" vor dem Absenden nichts sagt; Personen als Zahl, weil
// zwanzig Namen die Abfrage unlesbar machen.
function rundAuswahlBeschreibung(gruppenIds, personenAnzahl) {
  const ids = Array.isArray(gruppenIds) ? gruppenIds : rundAuswahl.gruppen;
  const anzahl = (typeof personenAnzahl === "number") ? personenAnzahl : rundAuswahl.personen.length;
  const namen = ids.map((gid) => {
    const g = rundAuswahlQuelle ? rundAuswahlQuelle.gruppen.filter((x) => x.id === gid)[0] : null;
    // Ohne Quelle (oder bei geloeschter Gruppe) die Id zeigen statt nichts --
    // ein leerer Platz sieht aus, als sei gar nicht eingegrenzt worden.
    return (g && g.name) ? g.name : gid;
  });
  const teile = [];
  if (namen.length) teile.push(namen.join(", "));
  if (anzahl) teile.push(anzahl + (anzahl === 1 ? " einzelne Person" : " einzelne Personen"));
  return teile.join(" und ");
}

function rundAuswahlLeeren(stumm) {
  rundAuswahl.gruppen = [];
  rundAuswahl.personen = [];
  if (!stumm) {
    rundAuswahlRendern();
    rundnachrichtReichweiteZeigen();
  }
}

function rundHakenZeile(text, gesetzt, beiWechsel, zusatz) {
  const label = document.createElement("label");
  label.className = "rund-auswahl-zeile";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !!gesetzt;
  box.addEventListener("change", () => beiWechsel(box.checked));
  const span = document.createElement("span");
  span.textContent = text;
  label.appendChild(box);
  label.appendChild(span);
  if (zusatz) {
    const klein = document.createElement("small");
    klein.textContent = zusatz;
    label.appendChild(klein);
  }
  return label;
}

function rundAuswahlUmschalten(liste, wert, an) {
  const i = liste.indexOf(wert);
  if (an && i < 0) liste.push(wert);
  if (!an && i >= 0) liste.splice(i, 1);
  rundAuswahlRendern();
  rundnachrichtReichweiteZeigen();
}

function rundAuswahlRendern() {
  const feld = document.getElementById("rund-eingrenzen-feld");
  if (!feld) return;
  if (!rundAuswahlQuelle) { feld.style.display = "none"; return; }
  // "block", nicht "": der Startwert im Markup ist display:none, und ein leerer
  // Wert fiele auf den Standard des Elements zurueck -- der ist hier block, aber
  // ausdruecklich gesetzt bleibt es unabhaengig vom Element.
  feld.style.display = "block";

  const imKreis = rundImKreis();
  const imKreisNamen = Object.create(null);
  imKreis.forEach((p) => { imKreisNamen[p.username] = true; });

  // --- Gruppen ---
  const gEl = document.getElementById("rund-gruppen-liste");
  gEl.innerHTML = "";
  if (!rundAuswahlQuelle.gruppen.length) {
    gEl.innerHTML = '<p class="muted" style="font-size:13px;">Keine Gruppen angelegt.</p>';
  }
  rundAuswahlQuelle.gruppen.forEach((g) => {
    // Gezaehlt wird, wie viele Mitglieder der KREIS zulaesst -- eine Gruppe mit
    // 12 Spielern zeigt bei "ohne Spielerkonten" sonst 12 und trifft null.
    const zahl = (g.mitglieder || []).filter((m) => imKreisNamen[m] === true).length;
    gEl.appendChild(rundHakenZeile(
      g.name,
      rundAuswahl.gruppen.indexOf(g.id) >= 0,
      (an) => rundAuswahlUmschalten(rundAuswahl.gruppen, g.id, an),
      zahl === 1 ? "1 Konto" : zahl + " Konten"
    ));
  });

  // --- Personen ---
  const pEl = document.getElementById("rund-personen-liste");
  const sucheEl = document.getElementById("rund-personen-suche");
  const suche = sucheEl ? sucheEl.value.trim().toLowerCase() : "";
  pEl.innerHTML = "";
  // ⚠️ Gewaehlte stehen IMMER oben und werden von der Suche nie ausgeblendet:
  // ein gesetzter Haken, den man nicht mehr sieht, bleibt trotzdem gesetzt und
  // verschickt an jemanden, an den man nicht mehr denkt.
  const gewaehlt = imKreis.filter((p) => rundAuswahl.personen.indexOf(p.username) >= 0);
  const rest = imKreis.filter((p) => rundAuswahl.personen.indexOf(p.username) < 0
    && (!suche || p.name.toLowerCase().indexOf(suche) >= 0 || p.username.indexOf(suche) >= 0));
  const zeigen = gewaehlt.concat(rest.slice(0, RUND_PERSONEN_SICHTBAR));
  zeigen.forEach((p) => {
    pEl.appendChild(rundHakenZeile(
      p.name,
      rundAuswahl.personen.indexOf(p.username) >= 0,
      (an) => rundAuswahlUmschalten(rundAuswahl.personen, p.username, an),
      p.geraete > 0 ? null : "kein Gerät"
    ));
  });
  const verborgen = rest.length - Math.min(rest.length, RUND_PERSONEN_SICHTBAR);
  if (verborgen > 0) {
    const hin = document.createElement("p");
    hin.className = "muted";
    hin.style.fontSize = "12px";
    hin.textContent = verborgen + " weitere — über das Suchfeld einschränken.";
    pEl.appendChild(hin);
  }
  if (!zeigen.length && !verborgen) {
    pEl.innerHTML = '<p class="muted" style="font-size:13px;">Kein Treffer.</p>';
  }

  // --- Zusammenfassung in der Zeile zum Aufklappen ---
  const status = document.getElementById("rund-eingrenzen-status");
  if (status) {
    if (!rundAuswahlAktiv()) {
      status.textContent = "alle im gewählten Kreis";
    } else {
      const teile = [];
      if (rundAuswahl.gruppen.length) teile.push(rundAuswahl.gruppen.length + (rundAuswahl.gruppen.length === 1 ? " Gruppe" : " Gruppen"));
      if (rundAuswahl.personen.length) teile.push(rundAuswahl.personen.length + (rundAuswahl.personen.length === 1 ? " Person" : " Personen"));
      const treffer = rundGetroffene().length;
      status.textContent = teile.join(" und ") + " · " + treffer + (treffer === 1 ? " Konto" : " Konten");
    }
  }
}

// ⚠️ Beim Wechsel des Kreises fallen Ausgewaehlte weg, die der neue Kreis nicht
// zulaesst -- und das wird GESAGT. Sie stumm stehen zu lassen hiesse: der Haken
// ist gesetzt, sichtbar, und trifft trotzdem niemanden (siehe
// [[feedback-filter-hides-selection-persists]]).
function rundAuswahlAnKreisAnpassen() {
  if (!rundAuswahlQuelle || !rundAuswahl.personen.length) return;
  const erlaubt = Object.create(null);
  rundImKreis().forEach((p) => { erlaubt[p.username] = true; });
  const vorher = rundAuswahl.personen.length;
  rundAuswahl.personen = rundAuswahl.personen.filter((u) => erlaubt[u] === true);
  const weg = vorher - rundAuswahl.personen.length;
  if (weg > 0) {
    const errEl = document.getElementById("rund-error");
    if (errEl) {
      errEl.textContent = weg + (weg === 1 ? " Spielerkonto wurde" : " Spielerkonten wurden")
        + " aus der Auswahl genommen — der Empfängerkreis „Mitarbeiter“ schließt Spielerkonten aus.";
      errEl.style.display = "block";
    }
  }
}

function rundnachrichtReichweiteZeigen() {
  const el = document.getElementById("rund-reichweite");
  if (!el) return;
  const zahlen = rundZahlenFuerAnzeige();
  if (!zahlen) { el.textContent = ""; rundnachrichtWerZeigen(null); return; }
  // ⚠️ Der Bezug muss mitwandern: steht eine Eingrenzung, ist "in diesem Kreis"
  // schlicht falsch -- die Zahl bezieht sich dann auf die Ausgewählten.
  const bezug = rundAuswahlAktiv() ? "in dieser Auswahl" : "in diesem Kreis";
  // ⚠️ Zwei verschiedene Gründe, und der Unterschied ist der zwischen "geht
  // raus, kommt nur nirgends an" und "der Worker lehnt das ab": trifft die
  // Eingrenzung schon gar kein Konto, liegt es nicht an ausgeschalteten
  // Benachrichtigungen, sondern an der Auswahl selbst (leere Gruppe,
  // Spielerkonto im falschen Kreis).
  if (rundAuswahlAktiv() && !zahlen.infrage) {
    el.textContent = "Diese Auswahl trifft niemanden — Gruppe leer, oder die Gewählten passen nicht zum Empfängerkreis.";
    rundnachrichtWerZeigen(zahlen);
    return;
  }
  if (!zahlen.personen) {
    el.textContent = "Erreicht im Moment niemanden — " + bezug
      + " hat noch niemand Benachrichtigungen eingeschaltet.";
    rundnachrichtWerZeigen(zahlen);
    return;
  }
  // Der Nenner steht bewusst dabei: „15 Personen" allein klingt nach einer
  // vollständigen Zustellung, „15 von 87" sagt, dass die Nachricht die meisten
  // gar nicht erreicht -- und genau das entscheidet, ob man sie so verschickt.
  // ⚠️ Bei einem Nenner richtet sich das Wort nach DIESEM, nicht nach dem
  // Zähler: "1 von 2 Person" stand vorher da, sobald genau eine Person erreicht
  // wurde. Ohne Nenner zählt weiter der Zähler ("1 Person").
  const hatNenner = typeof zahlen.infrage === "number";
  const massgeblich = hatNenner ? zahlen.infrage : zahlen.personen;
  el.textContent = "Erreicht im Moment "
    + zahlen.personen
    + (hatNenner ? " von " + zahlen.infrage : "")
    + (massgeblich === 1 ? " Person" : " Personen")
    + " auf " + zahlen.geraete + (zahlen.geraete === 1 ? " Gerät." : " Geräten.")
    + (rundAuswahlAktiv() ? " Eingegrenzt." : "");
  rundnachrichtWerZeigen(zahlen);
}

// ⚠️ Fehlen die Listen (aelterer Worker), bleibt der Bereich LEER statt eine
// leere Liste zu behaupten -- „niemand wird erreicht" waere eine falsche
// Aussage, wo in Wahrheit nur die Angabe fehlt.
function rundnachrichtWerZeigen(zahlen) {
  const el = document.getElementById("rund-wer");
  if (!el) return;
  const wer = (zahlen && Array.isArray(zahlen.wer)) ? zahlen.wer : null;
  const ohne = (zahlen && Array.isArray(zahlen.ohne)) ? zahlen.ohne : null;
  if (!wer && !ohne) { el.innerHTML = ""; return; }

  const block = (titel, liste) => {
    if (!liste || !liste.length) return "";
    return '<details class="collapsible rund-wer-block"><summary>'
      + escapeHtml(titel) + " (" + liste.length + ")</summary>"
      + '<div class="rund-wer-liste">'
      + liste.map((n) => escapeHtml(n)).join(" · ")
      + "</div></details>";
  };

  el.innerHTML = block("Erreicht die Nachricht", wer)
    + block("Bekommt nichts — kein Gerät angemeldet oder Mitteilungen aus", ohne);
}

// ⚠️ Nur die ANZEIGE ist begrenzt, nicht das Protokoll: der Worker führt
// weiterhin die letzten 30 (PUSH_RUND_VERLAUF_MAX). Eine Push-Nachricht lässt
// sich nicht zurückholen -- wer wann was an die ganze Belegschaft geschickt hat,
// ist der Nachweis dahinter und darf nicht an einer Anzeige-Vorliebe hängen.
// Steht mehr dahinter, sagt die Überschrift das ("3 von 12") statt den Rest
// verschwinden zu lassen.
const RUND_VERLAUF_ANZEIGE = 3;

function rundnachrichtVerlaufRendern(liste) {
  const el = document.getElementById("rund-verlauf");
  if (!el) return;
  if (!Array.isArray(liste) || !liste.length) { el.innerHTML = ""; return; }
  const gezeigt = liste.slice(0, RUND_VERLAUF_ANZEIGE);
  const beschriftung = liste.length > gezeigt.length
    ? gezeigt.length + " von " + liste.length
    : String(gezeigt.length);
  el.innerHTML = '<details class="collapsible"><summary>Zuletzt verschickt ('
    + beschriftung + ')</summary><div class="rund-verlauf-liste">'
    + gezeigt.map((e) => {
        const d = new Date((e && e.am) || "");
        const wann = isNaN(d.getTime()) ? "" : d.toLocaleString("de-DE");
        const kreis = (e && e.kreis === "alle") ? "alle Konten" : "Mitarbeiter";
        // Eingrenzung nur zeigen, wenn eine da war -- ein Eintrag von vor dieser
        // Änderung trägt die Felder gar nicht und soll aussehen wie bisher.
        const anGruppen = (e && Array.isArray(e.anGruppen)) ? e.anGruppen : [];
        const anPersonen = (e && Array.isArray(e.anPersonen)) ? e.anPersonen : [];
        const eingegrenzt = (anGruppen.length || anPersonen.length)
          ? " · nur " + rundAuswahlBeschreibung(anGruppen, anPersonen.length)
          : "";
        const anzahlPersonen = Number((e && e.personen) || 0);
        const anzahlGeraete = Number((e && e.geraete) || 0);
        return '<div class="rund-verlauf-eintrag">'
          + '<strong>' + escapeHtml(e && e.titel) + '</strong>'
          + '<div>' + escapeHtml(e && e.text) + '</div>'
          + '<div class="muted" style="font-size:12px;">'
          + escapeHtml(wann) + ' · ' + escapeHtml(String((e && e.von) || ""))
          + ' · an ' + kreis + escapeHtml(eingegrenzt)
          + ' · ' + anzahlPersonen + (anzahlPersonen === 1 ? ' Person, ' : ' Personen, ')
          + anzahlGeraete + (anzahlGeraete === 1 ? ' Gerät' : ' Geräte') + '</div></div>';
      }).join("")
    + "</div></details>";
}

function rundnachrichtZaehler() {
  const el = document.getElementById("rund-zaehler");
  if (!el) return;
  const rest = 200 - document.getElementById("rund-text").value.length;
  el.textContent = "Noch " + rest + " Zeichen. Längere Texte schneiden die Handys ohnehin ab.";
}

// ---------- Emoji-Auswahl für die Rundnachricht (seit 2026-08-07) ----------
// Genau EIN Palettenelement für beide Felder; es wird beim Öffnen in die Leiste
// des angeklickten Knopfes umgehängt. Zwei Paletten wären zwei Orte, an denen
// dieselbe Liste gerendert wird -- die liefen beim ersten Nachtragen auseinander.
let rundEmojiPalette = null;
let rundEmojiZielId = null;

function rundEmojiPaletteBauen() {
  if (rundEmojiPalette) return rundEmojiPalette;
  const box = document.createElement("div");
  box.className = "emoji-palette";
  box.id = "rund-emoji-palette";
  const liste = (typeof MITTEILUNG_EMOJIS !== "undefined" && Array.isArray(MITTEILUNG_EMOJIS)) ? MITTEILUNG_EMOJIS : [];
  liste.forEach((eintrag) => {
    const knopf = document.createElement("button");
    knopf.type = "button";
    knopf.className = "emoji-wahl";
    knopf.textContent = eintrag.e;
    // Der Name steht im title UND im aria-label: ohne ihn heißt der Knopf für
    // ein Vorlese-Programm nur "Schaltfläche".
    knopf.title = eintrag.name;
    knopf.setAttribute("aria-label", eintrag.name);
    knopf.addEventListener("click", () => rundEmojiEinfuegen(eintrag.e));
    box.appendChild(knopf);
  });
  rundEmojiPalette = box;
  return box;
}

function rundEmojiOffen() {
  return !!rundEmojiPalette && rundEmojiPalette.style.display !== "none" && !!rundEmojiPalette.parentElement;
}

function rundEmojiSchliessen() {
  if (rundEmojiPalette) rundEmojiPalette.style.display = "none";
  rundEmojiZielId = null;
  const knoepfe = document.querySelectorAll(".emoji-knopf");
  for (let i = 0; i < knoepfe.length; i++) knoepfe[i].setAttribute("aria-expanded", "false");
}

function rundEmojiUmschalten(knopf) {
  const leiste = knopf.parentElement;
  const box = rundEmojiPaletteBauen();
  // Zweiter Druck auf denselben Knopf schließt wieder -- ein Knopf, der nur
  // aufmacht, zwingt zum Klick irgendwohin daneben.
  const warOffenHier = rundEmojiOffen() && box.parentElement === leiste;
  rundEmojiSchliessen();
  if (warOffenHier) return;
  leiste.appendChild(box);
  box.style.display = "flex";
  rundEmojiZielId = knopf.getAttribute("data-ziel");
  knopf.setAttribute("aria-expanded", "true");
}

function rundEmojiEinfuegen(emoji) {
  const feld = rundEmojiZielId ? document.getElementById(rundEmojiZielId) : null;
  if (!feld) return;
  const errEl = document.getElementById("rund-error");
  const grenze = Number(feld.getAttribute("maxlength")) || 0;
  // ⚠️ maxlength bremst nur das TIPPEN, nicht das Setzen per JS -- und der
  // Worker kürzt hart auf dieselbe Länge. Ein Emoji genau an der Grenze käme
  // dort halbiert an und stünde als leeres Kästchen auf dem Sperrbildschirm.
  // Deshalb absagen statt still zu kürzen.
  if (grenze && feld.value.length + emoji.length > grenze) {
    if (errEl) {
      errEl.textContent = "Kein Platz mehr für ein weiteres Emoji — "
        + (rundEmojiZielId === "rund-titel" ? "die Überschrift ist voll." : "der Text ist voll.");
      errEl.style.display = "block";
    }
    return;
  }
  if (errEl) errEl.style.display = "none";

  const start = (typeof feld.selectionStart === "number") ? feld.selectionStart : feld.value.length;
  const ende = (typeof feld.selectionEnd === "number") ? feld.selectionEnd : start;
  feld.value = feld.value.slice(0, start) + emoji + feld.value.slice(ende);
  // Schreibmarke HINTER das Emoji und Fokus zurück ins Feld: sonst tippt man
  // nach der Auswahl wieder am Anfang der Zeile weiter.
  feld.focus();
  const neu = start + emoji.length;
  if (feld.setSelectionRange) feld.setSelectionRange(neu, neu);
  rundnachrichtZaehler();
}

async function sendeRundnachricht() {
  const errEl = document.getElementById("rund-error");
  const okEl = document.getElementById("rund-success");
  const knopf = document.getElementById("btn-rund-senden");
  errEl.style.display = "none";
  okEl.style.display = "none";

  const titel = document.getElementById("rund-titel").value.trim();
  const text = document.getElementById("rund-text").value.trim();
  const kreis = document.getElementById("rund-kreis").value === "alle" ? "alle" : "personal";
  if (!titel || !text) {
    errEl.textContent = "Überschrift und Text werden beide gebraucht.";
    errEl.style.display = "block";
    return;
  }

  // ⚠️ Sicherheitsabfrage mit der ECHTEN Zahl, nicht mit "an alle". Eine
  // Push-Nachricht laesst sich nicht zurueckholen, und der Unterschied zwischen
  // 3 und 200 geweckten Handys soll vor dem Klick dastehen. Bei einer
  // Eingrenzung ist das die Zahl der AUSGEWAEHLTEN, nicht die des Kreises --
  // sonst nennt die Abfrage 87, wo drei gemeint sind.
  const zahlen = rundZahlenFuerAnzeige();
  const wieviele = zahlen
    ? zahlen.personen + " Person" + (zahlen.personen === 1 ? "" : "en") + " auf " + zahlen.geraete + " Gerät" + (zahlen.geraete === 1 ? "" : "en")
    : "alle erreichbaren Geräte";
  const anWen = rundAuswahlAktiv()
    ? "\n\nEingegrenzt auf: " + rundAuswahlBeschreibung()
    : "";
  if (!window.confirm("Jetzt an " + wieviele + " senden?" + anWen + "\n\n" + titel + "\n" + text + "\n\nDas lässt sich nicht zurückholen.")) return;

  knopf.disabled = true;
  try {
    const data = await callWorker("push-rundnachricht", {
      titel, text, kreis,
      // Leere Listen mitzuschicken ist unschaedlich: der Worker wertet sie wie
      // "nicht eingegrenzt" (rundAuswahlFilter gibt dann null zurueck).
      gruppen: rundAuswahl.gruppen.slice(),
      personen: rundAuswahl.personen.slice()
    });
    document.getElementById("rund-titel").value = "";
    document.getElementById("rund-text").value = "";
    // ⚠️ Auch die Eingrenzung faellt zurueck. Sie gilt fuer DIESE Nachricht --
    // eine stehengebliebene Auswahl waere beim naechsten Mal ein stiller
    // Blindgaenger (gleiche Linie wie das Mail-Haekchen beim Anfordern).
    rundAuswahlLeeren(true);
    rundAuswahlRendern();
    rundnachrichtZaehler();
    okEl.textContent = "Verschickt an " + Number((data && data.personen) || 0)
      + " Personen auf " + Number((data && data.geraete) || 0) + " Geräten.";
    okEl.style.display = "block";
    // Frisch nachladen statt den neuen Eintrag lokal vorn anzuhaengen: der
    // Worker fuehrt die Liste, und die Reichweite kann sich geaendert haben.
    await rundnachrichtPanelLaden();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = "block";
  } finally {
    knopf.disabled = false;
  }
}

async function afterAuthChange() {
  // Vor dem ersten Rendern: die Kacheln sollen gleich in der Ansicht und Reihenfolge
  // stehen, die am Konto haengt -- sonst blitzt nach jeder Anmeldung kurz die
  // Standardsortierung auf. Ohne Token setzt die Funktion auf den Standard zurueck.
  await ladeAnsicht();
  renderAdminPanels();
  renderToolGrid();
  renderFeedbackTab();
  refreshMyNewsReactions(); // eigene Neuigkeiten-Reaktionen nach An-/Abmeldung neu laden (bzw. leeren)
  await Promise.all([refreshNews(), loadSidebarWidget(), loadAufgaben(), loadTrainerdatenStatus(), loadTestspielplanerStatus()]);
  if (currentUser && currentUser.isAdmin) {
    await loadAndRenderGroups();
    // Frueher stand hier ein zweites renderKontoKarte(): die Gruppennamen liessen sich
    // erst nach loadAndRenderGroups() aufloesen. Seit "me" sie als groupNames mitliefert,
    // ist die Karte schon beim ersten Rendern vollstaendig.
    await loadAndRenderUsers();
    renderVisibilityList();
    renderNewsAdmin();
    await loadAndRenderFeedback();
    await ladeMaterialcontainerInsAdminFeld();
    await renderAufgabenAdminPanel();
  }
  await loadDirectoryGroupsIfNeeded();
}

// Passwort-Regeln (identisch im admin-worker.js dupliziert, da separates Deployment):
// min. 12 Zeichen, Groß- und Kleinbuchstabe, dazu eine Zahl ODER ein Sonderzeichen.
function validatePasswordStrength(password) {
  const pw = String(password == null ? "" : password);
  if (pw.length < 12) return "Passwort muss mindestens 12 Zeichen lang sein.";
  if (!/[A-ZÄÖÜ]/.test(pw)) return "Passwort braucht mindestens einen Großbuchstaben.";
  if (!/[a-zäöüß]/.test(pw)) return "Passwort braucht mindestens einen Kleinbuchstaben.";
  if (!/[0-9]/.test(pw) && !/[^A-Za-z0-9ÄÖÜäöüß]/.test(pw)) return "Passwort braucht mindestens eine Zahl oder ein Sonderzeichen.";
  return null;
}

function setupAuthForms() {
  document.getElementById("bootstrap-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("bootstrap-username").value;
    const password = document.getElementById("bootstrap-password").value;
    const errorEl = document.getElementById("bootstrap-error");
    errorEl.style.display = "none";
    const pwError = validatePasswordStrength(password);
    if (pwError) {
      errorEl.textContent = pwError;
      errorEl.style.display = "block";
      return;
    }
    try {
      await bootstrapAdmin(username, password);
      await afterAuthChange();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("login-username").value;
    const errorEl = document.getElementById("login-error");
    errorEl.style.display = "none";
    pendingFirstLoginUsername = null;
    pendingLoginUsername = null;
    try {
      const result = await login(username, "");
      if (result.needsPasswordSetup) {
        renderAdminPanels();
      } else {
        await afterAuthChange();
      }
    } catch (err) {
      if (err.archived) {
        errorEl.textContent = err.message;
        errorEl.style.display = "block";
        return;
      }
      // Konto existiert bereits und hat ein Passwort -> Passwort-Schritt zeigen statt Fehler.
      pendingLoginUsername = username;
      renderAdminPanels();
    }
  });

  document.getElementById("login-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-password-error");
    errorEl.style.display = "none";
    try {
      const result = await login(pendingLoginUsername, password);
      pendingLoginUsername = null;
      if (result.needsPasswordSetup) {
        renderAdminPanels();
      } else {
        await afterAuthChange();
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });

  document.getElementById("btn-login-back").addEventListener("click", () => {
    pendingLoginUsername = null;
    document.getElementById("login-password").value = "";
    document.getElementById("login-username").value = "";
    renderAdminPanels();
  });

  document.getElementById("btn-first-login-back").addEventListener("click", () => {
    pendingFirstLoginUsername = null;
    document.getElementById("first-login-password").value = "";
    document.getElementById("login-username").value = "";
    renderAdminPanels();
  });

  document.getElementById("first-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = document.getElementById("first-login-password").value;
    const errorEl = document.getElementById("first-login-error");
    errorEl.style.display = "none";
    const pwError = validatePasswordStrength(password);
    if (pwError) {
      errorEl.textContent = pwError;
      errorEl.style.display = "block";
      return;
    }
    try {
      await setFirstPassword(pendingFirstLoginUsername, password);
      await afterAuthChange();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });

  document.getElementById("btn-logout").addEventListener("click", () => {
    logout();
  });

  setupPasswortForm();

  const backfillBtn = document.getElementById("btn-backfill-personalkosten");
  if (backfillBtn) backfillBtn.addEventListener("click", openBackfillFromPersonalkosten);

  // Filter der Nutzerliste. Neu rendern statt Zeilen ein-/auszublenden, damit die
  // Zähler in den Abschnitts-Überschriften zum Filterergebnis passen.
  const filterText = document.getElementById("users-filter-text");
  const filterGroup = document.getElementById("users-filter-group");
  const filterReset = document.getElementById("users-filter-reset");
  if (filterText) filterText.addEventListener("input", () => {
    usersFilter.text = filterText.value;
    renderUsersList(usersState);
  });
  if (filterGroup) filterGroup.addEventListener("change", () => {
    usersFilter.groupId = filterGroup.value;
    renderUsersList(usersState);
  });
  if (filterReset) filterReset.addEventListener("click", () => {
    usersFilter = { text: "", groupId: "" };
    if (filterText) filterText.value = "";
    renderUsersList(usersState);
  });

  // Trainerlizenz, Mannschaften, Admin-Rechte und "Vertrag benötigt" sind
  // Personal-Felder -- bei einem Spielerkonto ignoriert der Worker sie ohnehin
  // (art === "spieler" erzwingt isAdmin:false). Sie auszublenden macht sichtbar,
  // dass die Art die Bedeutung des Formulars ändert, statt sie nur wirkungslos
  // anzubieten.
  const artSelect = document.getElementById("new-user-art");
  if (artSelect) {
    const personalFelder = ["new-user-lizenz", "new-user-mannschaften", "new-user-is-admin", "new-user-vertrag-benoetigt"];
    const syncArtFelder = () => {
      const istSpieler = artSelect.value === "spieler";
      personalFelder.forEach((id) => {
        const el = document.getElementById(id);
        // Das umschließende .form-field ausblenden, nicht nur das Eingabefeld --
        // sonst bleibt das Label allein stehen.
        const feld = el && el.closest(".form-field");
        if (feld) feld.style.display = istSpieler ? "none" : "";
      });
    };
    artSelect.addEventListener("change", syncArtFelder);
    syncArtFelder();
  }

  document.getElementById("create-user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const art = document.getElementById("new-user-art").value;
    const vorname = document.getElementById("new-user-vorname").value;
    const nachname = document.getElementById("new-user-nachname").value;
    const isAdmin = document.getElementById("new-user-is-admin").checked;
    const lizenz = document.getElementById("new-user-lizenz").value;
    const mannschaften = document.getElementById("new-user-mannschaften").value
      .split(",").map((s) => s.trim()).filter(Boolean);
    const vertragBenoetigt = document.getElementById("new-user-vertrag-benoetigt").checked;
    const groupIds = getCheckedValues(document.getElementById("new-user-groups"));
    const errorEl = document.getElementById("users-error");
    const successEl = document.getElementById("users-success");
    errorEl.style.display = "none";
    successEl.style.display = "none";
    try {
      const data = await callWorker("create-user", { art, vorname, nachname, isAdmin, lizenz, mannschaften, vertragBenoetigt, groupIds });
      document.getElementById("new-user-vorname").value = "";
      document.getElementById("new-user-nachname").value = "";
      document.getElementById("new-user-lizenz").value = "";
      document.getElementById("new-user-mannschaften").value = "";
      document.getElementById("new-user-is-admin").checked = false;
      document.getElementById("new-user-vertrag-benoetigt").checked = false;
      // Art bewusst NICHT zurücksetzen: Konten werden in Serie angelegt (erst der
      // Trainerstab, später eine ganze Mannschaft) -- die Auswahl stehen zu lassen
      // spart bei 20 Spielern hintereinander 20 Umstellungen und den Fehler, den
      // 21. versehentlich wieder als Personal anzulegen.
      const prov = summarizeProvisionReport(data.provisioned);
      successEl.textContent = `Angelegt: ${data.username}` + (prov ? ` · Auto-Einträge → ${prov}` : "");
      successEl.style.display = "block";
      await loadAndRenderGroups();
      await loadAndRenderUsers();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });

  document.getElementById("create-group-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("new-group-name").value;
    const errorEl = document.getElementById("groups-error");
    errorEl.style.display = "none";
    try {
      await callWorker("create-group", { name });
      document.getElementById("new-group-name").value = "";
      await loadAndRenderGroups();
      renderVisibilityList();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });

  document.getElementById("btn-save-visibility").addEventListener("click", async () => {
    // Sammelt inkl. des neuen "kritisch"-Flags je Tool (save-visibility ersetzt config.tools
    // komplett, deshalb müssen alle Felder — auch provisionGroupIds — mitgeliefert werden).
    const tools = collectVisibilityTools();
    const errorEl = document.getElementById("admin-save-error");
    const successEl = document.getElementById("admin-save-success");
    errorEl.style.display = "none";
    successEl.style.display = "none";
    try {
      await callWorker("save-visibility", { tools });
      visibilityState = tools;
      renderToolGrid();
      renderFeedbackTab();
      renderVisibilityList();
      successEl.style.display = "block";
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });

  const newsForm = document.getElementById("news-form");
  if (newsForm) {
    newsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = document.getElementById("news-title").value.trim();
      const errorEl = document.getElementById("news-error");
      document.getElementById("news-success").style.display = "none";
      errorEl.style.display = "none";
      if (!title) {
        errorEl.textContent = "Titel ist ein Pflichtfeld.";
        errorEl.style.display = "block";
        return;
      }
      const editId = document.getElementById("news-edit-id").value;
      const item = {
        id: editId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
        type: document.getElementById("news-type").value,
        date: document.getElementById("news-date").value || new Date().toISOString().slice(0, 10),
        title,
        text: document.getElementById("news-text").value.trim()
      };
      const toolId = document.getElementById("news-tool").value;
      if (toolId) item.toolId = toolId;
      if (newsMedienEntwurf.length) item.medien = newsMedienEntwurf.map((m) => ({ ...m }));
      // ⚠️ Nicht still verwerfen: der Worker nimmt nur https an, und wer hier
      // etwas eingetippt hat, verließe sich sonst auf einen Link, der nie
      // erscheint. Zu diesem Zeitpunkt ist noch nichts gespeichert.
      const videoUrl = document.getElementById("news-video-url").value.trim();
      if (videoUrl && !/^https:\/\/[^\s]+$/i.test(videoUrl)) {
        errorEl.textContent = "Der Video-Link muss mit https:// beginnen.";
        errorEl.style.display = "block";
        return;
      }
      if (videoUrl) item.videoUrl = videoUrl;
      const prev = newsState.slice();
      newsState = editId ? newsState.map((x) => (x.id === editId ? item : x)) : [item, ...newsState];
      newsFormReset();
      await persistNews(prev);
    });
    document.getElementById("btn-news-cancel").addEventListener("click", () => newsFormReset());

    // Medien-Anhänge: Knopf öffnet den Datei-Dialog, die Auswahl lädt sofort hoch.
    const medienBtn = document.getElementById("btn-news-medien-add");
    const medienInput = document.getElementById("news-medien-datei");
    if (medienBtn && medienInput) {
      medienBtn.addEventListener("click", () => medienInput.click());
      medienInput.addEventListener("change", async () => {
        const datei = medienInput.files && medienInput.files[0];
        // ⚠️ Feld VOR dem Hochladen leeren: sonst löst dieselbe Datei ein zweites
        // Mal kein change-Ereignis aus, wenn sie nach einem Fehler erneut gewählt wird.
        medienInput.value = "";
        await newsMedienDateiGewaehlt(datei);
      });
      newsMedienEditorRendern();
    }
    // Zweiter Weg zu einem Anhang: selbst aufgenommen statt aus einer Datei.
    setupAufnahme();
    const medienClose = document.getElementById("btn-news-medien-close");
    if (medienClose) medienClose.addEventListener("click", newsMedienOverlaySchliessen);
    const medienOverlay = document.getElementById("news-medien-overlay");
    if (medienOverlay) {
      medienOverlay.addEventListener("click", (ev) => {
        if (ev.target === medienOverlay) newsMedienOverlaySchliessen();
      });
    }
    document.addEventListener("keydown", (ev) => {
      const ov = document.getElementById("news-medien-overlay");
      if (ev.key !== "Escape" || !ov || ov.style.display !== "flex") return;
      // Wie bei den anderen gestaffelten Dialogen: markieren, damit ein
      // darunterliegendes Fenster dasselbe Escape nicht ebenfalls verbraucht.
      ev.escapeVerbraucht = true;
      newsMedienOverlaySchliessen();
    });
    newsFormReset();
  }

  const feedbackForm = document.getElementById("feedback-form");
  if (feedbackForm) {
    feedbackForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = document.getElementById("feedback-text").value.trim();
      const errorEl = document.getElementById("feedback-error");
      const successEl = document.getElementById("feedback-success");
      errorEl.style.display = "none";
      successEl.style.display = "none";
      if (!text) {
        errorEl.textContent = "Text ist ein Pflichtfeld.";
        errorEl.style.display = "block";
        return;
      }
      try {
        await callWorker("submit-feedback", {
          type: document.getElementById("feedback-type").value,
          toolId: document.getElementById("feedback-tool").value,
          text
        });
        document.getElementById("feedback-text").value = "";
        successEl.style.display = "block";
        // Admin sieht die eigene Einreichung sofort in admin-feedback-panel, ohne neu zu laden.
        if (currentUser && currentUser.isAdmin) await loadAndRenderFeedback();
        // Und jeder sieht sie sofort unter "Meine Einreichungen" — sonst wirkt der
        // Absenden-Knopf, als waere nichts angekommen.
        await loadMeineFeedbacks();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = "block";
      }
    });
  }
}

// ===========================================================================
// Push-Nachrichten (seit 2026-08-03)
//
// Der Service Worker und das Manifest liegen im Wurzel-Repo, hier steht nur das
// Verhalten. Entwurf:
// docs/superpowers/specs/2026-08-03-push-nachrichten-design.md
// ===========================================================================

// Merkt sich die Id des eigenen Abos, damit die Geraeteliste "dieses Geraet"
// kennzeichnen kann -- sonst stuenden dort mehrere ununterscheidbare Namen.
const PUSH_ID_SPEICHER = "sc1911-push-geraet-id";

// ⚠️ Feature-Test mit echtem Rueckfallweg, nicht nur ein if: auf den aelteren
// iPhones der Flotte gibt es diese Objekte gar nicht, und ein ungeschuetzter
// Zugriff reisst den Rest des Konto-Tabs mit.
function pushGrundsaetzlichMoeglich() {
  return typeof Notification !== "undefined"
    && typeof navigator !== "undefined" && !!navigator.serviceWorker
    && typeof window.PushManager !== "undefined";
}

function pushMeldung(text, fehler) {
  const el = document.getElementById("push-meldung");
  if (!el) return;
  if (!text) { el.style.display = "none"; return; }
  el.textContent = text;
  el.style.color = fehler ? "#c0392b" : "#2d8c4e";
  el.style.display = "";
}

async function pushPanelAufbauen() {
  const panel = document.getElementById("push-panel");
  if (!panel) return;
  if (!currentUser) { panel.style.display = "none"; return; }
  panel.style.display = "block";

  const hinweis = document.getElementById("push-hinweis");
  const knopf = document.getElementById("btn-push-ein");
  const fertig = document.getElementById("push-eingerichtet");
  hinweis.style.display = "none";
  knopf.style.display = "none";
  fertig.style.display = "none";
  pushMeldung("");

  // Zustand 1: Die Plattform kann es nicht. Firefox und die iOS-Fremdbrowser
  // fallen hier heraus, ebenso jedes iPhone vor iOS 16.4.
  if (!pushGrundsaetzlichMoeglich()) {
    hinweis.textContent = istIosSafari()
      ? "Dieses Gerät kann noch keine Benachrichtigungen empfangen. Apple bietet sie erst ab iOS 16.4 an (iPhone 8 und neuer)."
      : "Dieser Browser kann keine Benachrichtigungen empfangen. Mit Chrome, Edge oder Safari klappt es.";
    hinweis.style.display = "";
    return;
  }

  // Zustand 2: iPhone, aber die App liegt nicht auf dem Startbildschirm. Auf
  // iOS gibt es Push AUSSCHLIESSLICH fuer abgelegte Web-Apps, im Safari-Tab
  // existiert das Notification-Objekt nicht einmal.
  if (istIosSafari() && !istAlsAppGestartet()) {
    hinweis.textContent = "Auf dem iPhone gibt es Benachrichtigungen nur, wenn die Übersicht als App auf dem Startbildschirm liegt. Lege sie oben über „📲 Als App ablegen“ ab und öffne sie danach über das neue Symbol — hier erscheint dann der Einschalten-Knopf.";
    hinweis.style.display = "";
    return;
  }

  let status;
  try {
    status = await callWorker("push-status", {});
  } catch (e) {
    // ⚠️ Die ganze Karte verschwindet, statt einen Fehler anzuzeigen. Der Grund
    // ist die Reihenfolge beim Ausrollen: Pages ist sofort live, der Worker
    // braucht einen eigenen Deploy. Kennt er "push-status" noch nicht, saehe
    // sonst JEDER Angemeldete einen roten Hinweis in seinem Konto -- fuer eine
    // Funktion, die es serverseitig noch gar nicht gibt. Ein nicht angebotener
    // Dienst ist besser als ein kaputt aussehender.
    console.warn("push-status nicht verfügbar", e && e.message ? e.message : e);
    panel.style.display = "none";
    return;
  }

  let abo = null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (reg) abo = await reg.pushManager.getSubscription();
  } catch (_) { abo = null; }

  const an = !!abo && Notification.permission === "granted";

  if (!an) {
    // Eine einmal abgelehnte Erlaubnis laesst sich nicht erneut erfragen --
    // der Browser antwortet sofort wieder mit "denied". Das muss dastehen,
    // sonst drueckt der Nutzer wirkungslos auf den Knopf.
    if (Notification.permission === "denied") {
      hinweis.textContent = "Benachrichtigungen sind für diese Seite gesperrt. Das lässt sich nur in den Einstellungen des Geräts wieder erlauben — auf dem iPhone unter Einstellungen › Mitteilungen, sonst über das Schloss-Symbol in der Adresszeile.";
      hinweis.style.display = "";
      return;
    }
    knopf.style.display = "inline-flex";
    knopf.dataset.publicKey = (status && status.publicKey) || "";
    return;
  }

  fertig.style.display = "block";
  pushSchalterRendern((status && status.liste) || [], (status && status.anlaesse) || {});
  pushGeraeteRendern((status && status.geraete) || []);
}

// Baut die Schalter aus der Liste, die der Worker mitliefert. ⚠️ Fallback auf
// die drei urspruenglichen Anlaesse: liefert ein aelterer Worker das Feld noch
// nicht, stuende hier sonst gar kein Schalter -- und der Nutzer koennte nichts
// mehr abstellen, obwohl Nachrichten ankommen.
function pushSchalterRendern(liste, anlaesse) {
  const box = document.getElementById("push-schalter");
  if (!box) return;
  const quelle = (Array.isArray(liste) && liste.length) ? liste : [
    { id: "kalender", label: "Vereinskalender" },
    { id: "aufgaben", label: "Vereinsaufgaben" },
    { id: "unterschriften", label: "Unterschriften" }
  ];
  box.innerHTML = quelle.map((a) =>
    "<label><input type=\"checkbox\" data-push-anlass=\"" + escapeHtml(a.id) + "\""
    + (anlaesse[a.id] !== false ? " checked" : "") + " /> <span>"
    + escapeHtml(a.label) + "</span></label>"
  ).join("");
}

function pushGeraeteRendern(geraete) {
  const ul = document.getElementById("push-geraete");
  if (!ul) return;
  let eigeneId = "";
  try { eigeneId = window.localStorage.getItem(PUSH_ID_SPEICHER) || ""; } catch (_) { eigeneId = ""; }

  if (!geraete.length) {
    ul.innerHTML = "<li class=\"muted\">Noch kein Gerät angemeldet.</li>";
    return;
  }
  ul.innerHTML = geraete.map((g) => {
    const seit = fmtDatumKurz(g.angelegtAm);
    const dieses = (g.id && g.id === eigeneId) ? " <span class=\"push-dieses\">dieses Gerät</span>" : "";
    return "<li><span>" + escapeHtml(g.geraet) + dieses
      + (seit ? " <span class=\"muted\">seit " + escapeHtml(seit) + "</span>" : "")
      + "</span><button type=\"button\" class=\"btn secondary small\" data-push-ab=\"" + escapeHtml(g.id) + "\">Abmelden</button></li>";
  }).join("");
}

// Grobe Geraetebezeichnung fuer die Liste. Bewusst grob: sie soll dem Nutzer
// helfen, seine eigenen Geraete auseinanderzuhalten, nicht ihn wiedererkennbar
// machen.
function pushGeraeteName() {
  const ua = navigator.userAgent || "";
  let geraet = "Rechner";
  if (/iPhone/.test(ua)) geraet = "iPhone";
  else if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) geraet = "iPad";
  else if (/Android/.test(ua)) geraet = "Android-Gerät";
  else if (/Macintosh/.test(ua)) geraet = "Mac";

  let browser = "";
  if (/EdgiOS|Edg\//.test(ua)) browser = "Edge";
  else if (/CriOS|Chrome\//.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return browser ? geraet + " · " + browser : geraet;
}

function pushBase64UrlZuBytes(b64url) {
  const roh = String(b64url || "").replace(/-/g, "+").replace(/_/g, "/");
  const voll = roh + "=".repeat((4 - (roh.length % 4)) % 4);
  const bin = window.atob(voll);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pushBytesZuBase64Url(buffer) {
  const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return window.btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ⚠️ Diese Funktion wird DIREKT aus dem Klick gerufen und ruft
// Notification.requestPermission() als ALLERERSTES. Steht davor auch nur ein
// await, verwirft Safari die Abfrage stillschweigend -- dieselbe Falle wie bei
// window.open nach einem await.
async function pushEinschalten() {
  const knopf = document.getElementById("btn-push-ein");
  const publicKey = (knopf && knopf.dataset.publicKey) || "";

  let erlaubnis;
  try {
    const ergebnis = Notification.requestPermission();
    // Aeltere Safari-Fassungen kennen nur die Rueckruf-Form ohne Promise.
    erlaubnis = (ergebnis && typeof ergebnis.then === "function")
      ? await ergebnis
      : await new Promise((fertig) => Notification.requestPermission(fertig));
  } catch (e) {
    pushMeldung("Die Abfrage ließ sich nicht öffnen: " + (e && e.message ? e.message : e), true);
    return;
  }

  if (erlaubnis !== "granted") {
    pushMeldung("Ohne Erlaubnis kann nichts zugestellt werden. Du kannst es später hier erneut versuchen.", true);
    return;
  }
  if (!publicKey) {
    pushMeldung("Der Server hat keinen Schlüssel hinterlegt (VAPID_PUBLIC_KEY fehlt). Bitte Michel Bescheid geben.", true);
    return;
  }

  if (knopf) { knopf.disabled = true; knopf.textContent = "Wird eingerichtet …"; }
  try {
    // register() statt .ready: idempotent, und es haengt nicht ewig, falls die
    // Registrierung beim Seitenstart fehlgeschlagen ist.
    const reg = await navigator.serviceWorker.register("/sw.js");
    const abo = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: pushBase64UrlZuBytes(publicKey)
    });

    const antwort = await callWorker("push-abo-anlegen", {
      endpoint: abo.endpoint,
      p256dh: pushBytesZuBase64Url(abo.getKey("p256dh")),
      auth: pushBytesZuBase64Url(abo.getKey("auth")),
      geraet: pushGeraeteName()
    });
    try {
      if (antwort && antwort.id) window.localStorage.setItem(PUSH_ID_SPEICHER, antwort.id);
    } catch (_) { /* privater Modus: dann fehlt nur die Markierung */ }

    pushMeldung("Eingeschaltet. Dieses Gerät bekommt ab jetzt Bescheid.", false);
  } catch (e) {
    pushMeldung("Einschalten fehlgeschlagen: " + (e && e.message ? e.message : e), true);
  } finally {
    if (knopf) { knopf.disabled = false; knopf.textContent = "Einschalten"; }
  }
  await pushPanelAufbauen();
}

async function pushSchalterSpeichern() {
  const anlaesse = {};
  const kaestchen = document.querySelectorAll("#push-schalter [data-push-anlass]");
  for (let i = 0; i < kaestchen.length; i++) {
    anlaesse[kaestchen[i].getAttribute("data-push-anlass")] = !!kaestchen[i].checked;
  }
  try {
    await callWorker("push-anlaesse-setzen", { anlaesse });
    pushMeldung("Gespeichert.", false);
  } catch (e) {
    pushMeldung("Konnte nicht gespeichert werden: " + (e && e.message ? e.message : e), true);
    await pushPanelAufbauen();
  }
}

async function pushGeraetAbmelden(id) {
  let eigeneId = "";
  try { eigeneId = window.localStorage.getItem(PUSH_ID_SPEICHER) || ""; } catch (_) { eigeneId = ""; }

  try {
    await callWorker("push-abo-loeschen", { id });
    // Ist es das eigene Geraet, auch lokal abbestellen -- sonst bliebe ein
    // Abo bestehen, das der Server nicht mehr kennt, und der Konto-Tab zeigte
    // weiterhin "eingeschaltet".
    if (id === eigeneId) {
      try {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const abo = reg ? await reg.pushManager.getSubscription() : null;
        if (abo) await abo.unsubscribe();
        window.localStorage.removeItem(PUSH_ID_SPEICHER);
      } catch (_) { /* das Serverseitige zaehlt, der Rest ist Kosmetik */ }
    }
    pushMeldung("Abgemeldet.", false);
  } catch (e) {
    pushMeldung("Abmelden fehlgeschlagen: " + (e && e.message ? e.message : e), true);
  }
  await pushPanelAufbauen();
}

// ---------- Aktivitätspunkte (seit 2026-08-04) ----------
//
// ⚠️ Der Client rechnet NICHTS. Punktzahl, Regelwerte und Protokoll kommen fertig
// aus der Worker-Aktion `meine-punkte`. Eine zweite Kopie der Regeln hier liefe
// mit der ersten Regeländerung auseinander — und geändert werden sie, das ist der
// erklärte Zweck der Erprobungsphase.

function punkteMeldung(text, fehler) {
  const el = document.getElementById("punkte-meldung");
  if (!el) return;
  if (!text) { el.style.display = "none"; return; }
  el.textContent = text;
  el.style.color = fehler ? "#c0392b" : "#2d8c4e";
  el.style.display = "";
}

async function punktePanelAufbauen() {
  const panel = document.getElementById("punkte-panel");
  if (!panel) return;
  // Spielerkonten werden gar nicht erst erfasst — der Worker antwortet ihnen mit
  // 403. Die Karte bleibt weg, statt ihnen eine dauerhafte Null zu zeigen.
  if (!currentUser || currentUser.art === "spieler") { panel.style.display = "none"; return; }

  let daten;
  try {
    daten = await callWorker("meine-punkte", {});
  } catch (e) {
    // Die Karte ist rein informativ und additiv. Kennt der Worker die Aktion noch
    // nicht (Pages geht bewusst VOR dem Worker live, damit der Datenschutz-Text
    // vor dem ersten Ereignis dasteht), gibt es sie eben noch nicht — das ist
    // kein Fehler, den der Nutzer sehen müsste.
    panel.style.display = "none";
    return;
  }

  panel.style.display = "block";
  punkteMeldung("");

  const optOut = !!daten.optOut;
  document.getElementById("punkte-opt-out").checked = optOut;

  const zahl = document.getElementById("punkte-zahl");
  const label = document.getElementById("punkte-zahl-label");
  const verfuegbar = document.getElementById("punkte-verfuegbar");
  const erarbeitet = Number(daten.erarbeitet) || 0;

  if (optOut) {
    zahl.textContent = "–";
    label.textContent = "Wird nicht mitgezählt";
    verfuegbar.textContent = "Für dein Konto wird nichts erfasst.";
  } else {
    zahl.textContent = String(erarbeitet);
    label.textContent = erarbeitet === 1 ? "Punkt erarbeitet" : "Punkte erarbeitet";
    // Das Einlösen gibt es noch nicht. Die Zeile erscheint erst, wenn wirklich
    // etwas abgezogen wurde — bis dahin wäre "0 eingelöst" nur Rauschen.
    verfuegbar.textContent = Number(daten.eingeloest)
      ? ("davon " + daten.eingeloest + " eingelöst · " + (Number(daten.verfuegbar) || 0) + " verfügbar")
      : "";
  }

  punkteRegelnRendern(daten.regeln || {});
  punkteProtokollRendern(Array.isArray(daten.protokoll) ? daten.protokoll : []);
}

function punkteRegelnRendern(r) {
  const el = document.getElementById("punkte-regeln");
  if (!el) return;
  const zeilen = [];
  if (r.proFenster) {
    zeilen.push([r.proFenster, "für je " + (r.fensterMinuten || 5) + " Minuten, in denen du wirklich etwas tust"]);
  }
  if (r.proAppStart) {
    zeilen.push([r.proAppStart, "wenn du ein Werkzeug an einem Tag zum ersten Mal öffnest"]);
  }
  if (r.proTat) {
    zeilen.push([r.proTat, "für einen abgeschlossenen Vorgang — eine erledigte Aufgabe, einen gestellten Antrag, eine geleistete Unterschrift"]);
  }
  // Seit Regeln 2. Ohne diese Zeile bekämen Trainerinnen und Trainer die Punkte
  // zwar, wüssten aber nicht wofür: in ihren Werkzeugen gibt es keine der oben
  // genannten Vorgänge, ihre Arbeit besteht aus Eintragen und Speichern.
  if (r.proTagewerk) {
    zeilen.push([r.proTagewerk, "wenn du an einem Tag in einem Werkzeug wirklich etwas eingetragen hast — einmal je Werkzeug, egal wie oft du speicherst"]);
  }
  // Seit Regeln 4. Steht bei den Vorgängen, nicht bei den Zugaben — es IST ein
  // Vorgang, nur ein höher bewerteter.
  if (r.proTerminAntwort) {
    zeilen.push([r.proTerminAntwort, "wenn du einem Termin zu- oder absagst — die anderen müssen dir dann nicht hinterhertelefonieren"]);
  }
  // Seit Regeln 3 (Michel-Vorgabe). Stehen bewusst UNTER den oberen: die
  // erklären, wie das Arbeiten selbst zählt, diese drei sind Zugaben obendrauf.
  if (r.proAktivemTag) {
    zeilen.push([r.proAktivemTag, "obendrauf für jeden Tag, an dem du überhaupt etwas gemacht hast"]);
  }
  if (r.proPasswortwechsel) {
    zeilen.push([r.proPasswortwechsel, "wenn du dein Passwort wechselst — höchstens alle "
      + (r.passwortSperreTage || 90) + " Tage, es bringt also nichts, gleich mehrmals zu wechseln"]);
  }
  if (r.proRueckkehr) {
    zeilen.push([r.proRueckkehr, "wenn du dich wieder anmeldest, nachdem deine Anmeldung nach "
      + (r.rueckkehrNachTagen || 7) + " Tagen abgelaufen war"]);
  }
  // Seit Regeln 5. Wochen statt Tage — eine Tagesserie bestrafte jeden Urlaub.
  if (r.proSerienwoche) {
    zeilen.push([r.proSerienwoche, "für jede Woche, in der du drangeblieben bist — also auch in der Woche davor schon aktiv warst"]);
  }
  if (r.proVielseitigeWoche) {
    zeilen.push([r.proVielseitigeWoche, "für jede Woche, in der du mindestens "
      + (r.vielseitigAbWerkzeugen || 3) + " verschiedene Werkzeuge benutzt hast"]);
  }
  if (r.einmalPflichten) {
    zeilen.push([r.einmalPflichten, "einmalig, sobald deine Trainer-Unterlagen vollständig sind — Vertrag, Kodex, Jugendschutz und der Rest"]);
  }
  if (r.einmalFoto) {
    zeilen.push([r.einmalFoto, "einmalig, wenn du ein Foto hinterlegst"]);
  }
  if (r.einmalPush) {
    zeilen.push([r.einmalPush, "einmalig, wenn du Benachrichtigungen aufs Handy einschaltest"]);
  }

  const extra = [];
  if (r.tagesdeckel) {
    // ⚠️ Zahl im Text bewusst vermieden: der Deckel gilt fürs laufende Sammeln
    // (Fenster, Werkzeug-Start, Vorgänge, Tagewerk), alle Zugaben und einmaligen
    // Boni stehen außerhalb. Stünde hier eine Anzahl, wäre sie beim nächsten
    // neuen Bonus still falsch — genau so war es nach Regelversion 5.
    extra.push("Mehr als <strong>" + escapeHtml(String(r.tagesdeckel)) + "</strong> Punkte an einem Tag werden fürs laufende Sammeln nicht gezählt. Zugaben und einmalige Boni zählen davon unabhängig immer.");
  }
  extra.push("Nur angemeldet zu sein gibt nichts — es muss etwas passieren.");
  if (r.aufbewahrungMonate) {
    extra.push("Die einzelnen Aufzeichnungen werden nach " + escapeHtml(String(r.aufbewahrungMonate)) + " Monaten gelöscht.");
    // Michel-Entscheidung 2026-08-04: das Verwerfen alter Monatssummen bei einem
    // Regelwechsel bleibt, wird aber benannt statt verschwiegen. Ohne diesen Satz
    // sähe ein späterer Rückgang des eigenen Standes wie ein Fehler aus.
    extra.push("Ändern sich die Regeln, wird nur diese Zeit neu berechnet — was davor liegt, behält seinen damaligen Wert nicht.");
  }

  el.innerHTML =
    zeilen.map(([n, t]) => "<li><strong>" + escapeHtml(String(n)) + "</strong> " + escapeHtml(t) + "</li>").join("") +
    extra.map((t) => '<li class="muted">' + t + "</li>").join("");
}

function punkteProtokollRendern(zeilen) {
  const el = document.getElementById("punkte-protokoll");
  if (!el) return;
  if (!zeilen.length) {
    el.innerHTML = '<p class="muted">Für die letzten 30 Tage ist nichts gespeichert.</p>';
    return;
  }
  const rows = zeilen.map((z) => {
    const tool = toolById(z.app);
    const name = tool ? tool.name : (z.app === "uebersicht" ? "Tools-Übersicht" : z.app);
    return "<tr><td>" + escapeHtml(z.tag) + "</td><td>" + escapeHtml(name) + "</td>" +
      '<td class="zahl">' + escapeHtml(String(z.handlungen)) + "</td>" +
      '<td class="zahl">' + escapeHtml(String(z.taten)) + "</td></tr>";
  }).join("");
  // Eigener Scroll-Container: die Tabelle darf am Handy überlaufen, die Seite nicht.
  el.innerHTML =
    '<div class="punkte-tabelle-scroll"><table class="punkte-tabelle">' +
    '<colgroup><col class="spalte-zahl" /><col /><col class="spalte-zahl" /><col class="spalte-zahl" /></colgroup>' +
    "<thead><tr>" +
    "<th>Tag</th><th>Werkzeug</th>" +
    '<th class="zahl">Vorgänge</th><th class="zahl">davon Abschlüsse</th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>";
}

function setupPunktePanel() {
  const schalter = document.getElementById("punkte-opt-out");
  if (!schalter) return;

  schalter.addEventListener("change", async () => {
    const aus = schalter.checked;
    // Nachfragen, weil das Einschalten die eigenen Aufzeichnungen mit löscht und
    // sich nicht rückgängig machen lässt.
    if (aus && !window.confirm(
      "Ab jetzt wird für dein Konto nichts mehr erfasst, und dein bisher gespeichertes Protokoll wird gelöscht.\n\n" +
      "Das lässt sich nicht rückgängig machen. Fortfahren?"
    )) {
      schalter.checked = false;
      return;
    }

    schalter.disabled = true;
    let meldung = null;
    try {
      await callWorker("punkte-opt-out", { optOut: aus });
      meldung = [aus ? "Erfassung beendet, gespeicherte Aufzeichnungen gelöscht." : "Erfassung wieder eingeschaltet.", false];
    } catch (e) {
      schalter.checked = !aus;
      meldung = ["Hat nicht geklappt: " + (e && e.message ? e.message : e), true];
    } finally {
      schalter.disabled = false;
    }
    // Erst neu aufbauen, dann melden — der Aufbau leert die Meldezeile.
    await punktePanelAufbauen();
    if (meldung) punkteMeldung(meldung[0], meldung[1]);
  });
}

// ---------- Aktivitäts-Auswertung im Admin-Dashboard (seit 2026-08-04) ----------
//
// ⚠️ Der Worker beantwortet höchstens 20 Konten je Aufruf (PUNKTE_AUSWERTUNG_MAX_NUTZER).
// Das ist Absicht: bei über hundert Personal-Konten wäre eine Auswertung in EINEM
// Request ein Rundlauf mit hundert Nextcloud-Lesevorgängen — die Bauform, an der ein
// Worker stirbt. Deshalb blättert der Client hier durch und zählt selbst zusammen.

function aktivitaetStatus(text, fehler) {
  const el = document.getElementById("aktivitaet-status");
  if (!el) return;
  if (!text) { el.style.display = "none"; return; }
  el.textContent = text;
  el.style.color = fehler ? "#c0392b" : "";
  el.style.display = "";
}

async function ladeAktivitaetsAuswertung() {
  const knopf = document.getElementById("btn-aktivitaet-laden");
  const ziel = document.getElementById("aktivitaet-ergebnis");
  const monatEl = document.getElementById("aktivitaet-monat");
  if (!knopf || !ziel || !monatEl) return;

  const monat = monatEl.value || aktuellerMonatIso();
  monatEl.value = monat;
  knopf.disabled = true;
  ziel.innerHTML = "";
  aktivitaetStatus("Hole die Nutzerliste…");

  try {
    // usersState steht nur, wenn der Einstellungen-Tab schon geladen wurde —
    // das Dashboard ist über den Kopf-Knopf auch direkt erreichbar.
    let alle = Array.isArray(usersState) && usersState.length ? usersState : null;
    if (!alle) {
      const data = await callWorker("list-users", {});
      alle = Array.isArray(data && data.users) ? data.users : [];
    }
    // Spielerkonten werden gar nicht erst erfasst — sie hier mitzufragen wäre je
    // 20 Stück ein Worker-Aufruf für garantiert leere Antworten.
    const personal = alle.filter((u) => u && u.username && u.art !== "spieler");
    if (!personal.length) {
      aktivitaetStatus("Keine Personal-Konten gefunden.");
      knopf.disabled = false;
      return;
    }

    const bloecke = [];
    for (let i = 0; i < personal.length; i += 20) bloecke.push(personal.slice(i, i + 20));

    const nutzer = [];
    for (let i = 0; i < bloecke.length; i++) {
      aktivitaetStatus("Werte aus… Block " + (i + 1) + " von " + bloecke.length
        + " (" + personal.length + " Konten)");
      const res = await callWorker("aktivitaet-auswertung", {
        monat,
        usernames: bloecke[i].map((u) => u.username)
      });
      if (res && Array.isArray(res.nutzer)) nutzer.push(...res.nutzer);
    }

    aktivitaetStatus("");
    renderAktivitaetsAuswertung(nutzer, personal, monat);
  } catch (e) {
    aktivitaetStatus("Auswertung fehlgeschlagen: " + (e && e.message ? e.message : e), true);
  } finally {
    knopf.disabled = false;
  }
}

function aktuellerMonatIso() {
  // sv-SE liefert YYYY-MM-DD, Europe/Berlin wie serverseitig — sonst zeigte der
  // Vorschlag in der Nacht zum Monatsersten den falschen Monat.
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }).slice(0, 7);
}

// "2026-08" -> "August 2026". Der Monat kommt aus einem <input type="month">,
// also immer in dieser Form; ein unerwarteter Wert wird unverändert durchgereicht.
function monatLesbar(monat) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monat || ""));
  if (!m) return String(monat || "");
  const namen = ["Januar", "Februar", "März", "April", "Mai", "Juni",
                 "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const i = Number(m[2]) - 1;
  return (namen[i] || m[2]) + " " + m[1];
}

function renderAktivitaetsAuswertung(nutzer, personal, monat) {
  const ziel = document.getElementById("aktivitaet-ergebnis");
  if (!ziel) return;

  const namen = {};
  personal.forEach((u) => { namen[u.username] = u.displayName || u.username; });

  const widersprochen = nutzer.filter((n) => n && n.optOut);
  const gezaehlt = nutzer.filter((n) => n && !n.optOut);
  const aktive = gezaehlt.filter((n) => (Number(n.punkte) || 0) > 0 || Object.keys(n.proApp || {}).length);

  // Je Werkzeug: wie viele Vorgänge, und von wie vielen Personen. Die Personenzahl
  // ist die wichtigere Spalte — ein einzelner Vielnutzer soll ein Werkzeug nicht
  // gebraucht aussehen lassen.
  const proApp = new Map();
  gezaehlt.forEach((n) => {
    Object.keys(n.proApp || {}).forEach((app) => {
      if (!proApp.has(app)) proApp.set(app, { vorgaenge: 0, personen: 0 });
      const z = proApp.get(app);
      z.vorgaenge += Number(n.proApp[app]) || 0;
      z.personen += 1;
    });
  });

  const appZeilen = Array.from(proApp.entries())
    .sort((a, b) => b[1].personen - a[1].personen || b[1].vorgaenge - a[1].vorgaenge)
    .map(([app, z]) => {
      const tool = toolById(app);
      const name = tool ? tool.name : (app === "uebersicht" ? "Tools-Übersicht" : app);
      return "<tr><td>" + escapeHtml(name) + "</td>" +
        '<td class="zahl">' + escapeHtml(String(z.personen)) + "</td>" +
        '<td class="zahl">' + escapeHtml(String(z.vorgaenge)) + "</td></tr>";
    }).join("");

  const personZeilen = aktive
    .slice()
    .sort((a, b) => (Number(b.punkte) || 0) - (Number(a.punkte) || 0))
    .map((n) => {
      const apps = Object.keys(n.proApp || {})
        .sort((a, b) => (n.proApp[b] || 0) - (n.proApp[a] || 0))
        .slice(0, 3)
        .map((a) => { const t = toolById(a); return t ? t.name : (a === "uebersicht" ? "Übersicht" : a); });
      return "<tr><td>" + escapeHtml(namen[n.username] || n.username) + "</td>" +
        '<td class="zahl">' + escapeHtml(String(Number(n.punkte) || 0)) + "</td>" +
        "<td>" + escapeHtml(apps.join(", ") || "—") + "</td></tr>";
    }).join("");

  // ⚠️ Die Werkzeuge, die NIEMAND benutzt hat, sind der eigentliche Zweck dieser
  // Auswertung — sie stehen in keiner Zeile und wären sonst genau das, was man
  // übersieht. Deshalb ausdrücklich aufzählen.
  const ungenutzt = TOOLS
    .filter((t) => t && t.id && !proApp.has(t.id))
    .map((t) => t.name);

  const stille = gezaehlt.length - aktive.length;

  ziel.innerHTML =
    '<p class="muted" style="margin-top:14px;">' +
      escapeHtml(String(aktive.length)) + " von " + escapeHtml(String(gezaehlt.length)) +
      " erfassten Konten waren im " + escapeHtml(monatLesbar(monat)) + " aktiv" +
      (stille ? ", " + escapeHtml(String(stille)) + " ohne einen einzigen Vorgang" : "") +
      (widersprochen.length
        ? " · " + escapeHtml(String(widersprochen.length))
          + (widersprochen.length === 1 ? " hat" : " haben") + " der Erfassung widersprochen"
        : "") +
    ".</p>" +
    (appZeilen
      ? '<h4 class="aktivitaet-titel">Nach Werkzeug</h4>' +
        '<div class="punkte-tabelle-scroll"><table class="punkte-tabelle">' +
        '<colgroup><col /><col class="spalte-zahl" /><col class="spalte-zahl" /></colgroup>' +
        "<thead><tr>" +
        "<th>Werkzeug</th><th class=\"zahl\">Personen</th><th class=\"zahl\">Vorgänge</th>" +
        "</tr></thead><tbody>" + appZeilen + "</tbody></table></div>"
      : '<p class="muted">In diesem Monat wurde nichts aufgezeichnet.</p>') +
    (ungenutzt.length
      ? '<p class="muted aktivitaet-ungenutzt"><strong>Von niemandem benutzt:</strong> '
        + escapeHtml(ungenutzt.join(", ")) + "</p>"
      : "") +
    (personZeilen
      ? '<h4 class="aktivitaet-titel">Nach Person</h4>' +
        '<div class="punkte-tabelle-scroll"><table class="punkte-tabelle">' +
        '<colgroup><col /><col class="spalte-zahl" /><col /></colgroup>' +
        "<thead><tr>" +
        "<th>Person</th><th class=\"zahl\">Punkte</th><th>Meistgenutzt</th>" +
        "</tr></thead><tbody>" + personZeilen + "</tbody></table></div>"
      : "");
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function init() {
  document.getElementById("version-badge-2").textContent = "v" + APP_VERSION;
  renderChangelog();
  setupTabs();
  setupSidebarWidgetPlacement();
  setupAufgabenWidget();
  setupAufgabenZuweisenDialog();
  setupDokumenteTab();
  setupAuthForms();
  setupKontoFoto();
  setupPunktePanel();
  setupWhatsappLink();
  setupWikiFrage();
  setupViewAsControl();
  setupAnsichtLeiste();
  // Frueh registrieren: beforeinstallprompt kann jederzeit eintreffen, auch
  // bevor die Worker-Aufrufe unten zurueck sind.
  setupAppInstallation();

  // fetchVisibility() (öffentlich, kein Login nötig) und checkSession() (prüft
  // ein vorhandenes Token) sind voneinander unabhängige Worker-Aufrufe — parallel
  // statt seriell spart einen kompletten Roundtrip beim Erstladen.
  // ladeAnsicht() laeuft im selben Zug mit: es liest den Token direkt aus dem Speicher
  // und braucht checkSession() nicht abzuwarten -- so kostet die persoenliche Ansicht
  // keinen zusaetzlichen Roundtrip beim Erstladen.
  const [data] = await Promise.all([fetchVisibility(), checkSession(), ladeAnsicht()]);
  // Hat der Worker nicht geantwortet (offline, alter Worker), greift der
  // Zwischenspeicher dieses Geraets -- besser die zuletzt bekannte eigene Ansicht als
  // eine fremde Standardsortierung.
  if (currentUser) {
    if (ansichtVomServer) ansichtCacheSchreiben(currentUser.username, ansichtState);
    else ansichtAusCacheVorbelegen();
  }
  visibilityState = (data && data.tools) || defaultVisibility();
  newsState = (data && Array.isArray(data.news)) ? data.news : newsState; // Server-News, sonst statisches Seed behalten
  newsReactionCounts = (data && data.newsReactions && typeof data.newsReactions === "object") ? data.newsReactions : {}; // öffentliche Zähler
  newsReactionNames = (data && data.newsReactionNames && typeof data.newsReactionNames === "object") ? data.newsReactionNames : {}; // Namen für den Tooltip, nur angemeldet gefüllt
  bootstrapAvailable = !!(data && data.bootstrapAvailable);
  // ERST hier rendern, nicht schon oben im synchronen Teil: der News-Bereich ist die
  // einzige Stelle, deren Inhalt komplett vom Server kommt. Ein Render vor dem Fetch
  // zeigte das statische Seed aus config.js und ersetzte es danach — sichtbar als
  // kurz aufblitzendes Karussell alter Meldungen bei jedem Seitenaufruf.
  renderNews();
  // Eigene Reaktionen nachladen (nur wenn eingeloggt) — bewusst NICHT awaited, damit die
  // eigene Hervorhebung nachrutscht, ohne den restlichen Seitenaufbau zu bremsen.
  refreshMyNewsReactions();

  renderAdminPanels();
  renderToolGrid();
  renderFeedbackTab();
  await Promise.all([loadSidebarWidget(), loadAufgaben(), loadTrainerdatenStatus(), loadTestspielplanerStatus()]);
  if (currentUser && currentUser.isAdmin) {
    // Seriell statt Promise.all: renderUsersList baut aus groupsState das
    // Gruppen-Dropdown des Nutzer-Filters, das also schon geladen sein muss,
    // bevor loadAndRenderUsers() rendert (sonst Race, je nachdem welcher der
    // beiden Worker-Aufrufe zuerst zurückkommt).
    await loadAndRenderGroups();
    await loadAndRenderUsers();
    renderVisibilityList();
    renderNewsAdmin();
    await loadAndRenderFeedback();
    await ladeMaterialcontainerInsAdminFeld();
    await renderAufgabenAdminPanel();
  }
  await loadDirectoryGroupsIfNeeded();

  // Beim allerersten Besuch (noch kein Nutzerkonto vorhanden) direkt in den
  // Konto-Tab springen, wo das "Admin-Konto einrichten"-Formular wartet.
  if (bootstrapAvailable && !currentUser) {
    activateTab("konto");
  }
}

init();

// Mehrfach live beobachtet (siehe project-toolsuebersicht-Memory): loadTrainerdatenStatus()
// wurde bisher nur einmal beim Seitenladen/Login geholt. Kehrt ein Nutzer aus einer
// verlinkten App zurück, nachdem er dort gerade eine fehlende Bestätigung nachgeholt
// hat, blieb die Kachel bis zum manuellen Reload auf dem alten (roten) Stand hängen,
// obwohl der Server längst "vollständig" berechnet. Fix: bei Rückkehr in den
// sichtbaren Tab erneut abfragen -- mit Mindestabstand, damit schnelles Tab-Switching
// den Worker nicht flutet (Timestamp wird auch vom Erstladen selbst gesetzt, siehe
// loadTrainerdatenStatus()).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (Date.now() - _trainerdatenStatusLastFetch >= 10000) loadTrainerdatenStatus();
  // Gleiches Muster für die Testspielplaner-Kachel: wer aus der App zurückkehrt und
  // dort gerade den Gegner eingetragen/den Platz freigegeben hat, soll das Badge
  // ohne manuellen Reload verschwinden sehen.
  if (Date.now() - _testspielplanerStatusLastFetch >= 10000) loadTestspielplanerStatus();
});
