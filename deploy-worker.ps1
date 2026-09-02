# Deployt die Cloudflare-Worker dieser Flotte per API statt per Copy-Paste ins Dashboard.
#
# Warum: der Dashboard-Weg hat am 2026-07-14 alle "02_Foerderung"-Pfade als Mojibake
# deployt (Get-Content -Raw liest die BOM-losen UTF-8-Worker als ANSI) -> saemtliche
# Dashboard-Quoten fielen auf 0. Hier gehen die Datei-Bytes unveraendert raus, dieser
# Fehlermodus ist strukturell ausgeschlossen. Nebeneffekt: der Live-Code laesst sich
# herunterladen und per Hash vergleichen - damit ist "ist Commit X live?" byte-genau
# beantwortbar, auch fuer Aenderungen ohne neue Aktion.
#
# Voraussetzung: API-Token mit "Account -> Workers Scripts -> Edit", als Umgebungs-
# variable (NIE ins Skript schreiben, Repo ist oeffentlich):
#   $env:CF_API_TOKEN = "..."          bzw. dauerhaft in der Benutzer-Registry
#   $env:CF_ACCOUNT_ID = "..."         optional, sonst automatisch ermittelt
#
# Aufruf:
#   .\deploy-worker.ps1                          # Analyse aller Worker, KEIN Schreibzugriff
#   .\deploy-worker.ps1 -Worker vereinswiki      # Analyse eines einzelnen
#   .\deploy-worker.ps1 -Worker alle -Deploy     # alle abweichenden deployen
#   .\deploy-worker.ps1 -Worker landingpage -Deploy

[CmdletBinding()]
param(
  [string]$Worker = 'alle',
  [string]$Datei,
  [string]$Sicherungsordner = 'E:\_worker-archiv',
  [switch]$Deploy,
  [switch]$KeinBackup,
  [switch]$Erzwingen
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$API = 'https://api.cloudflare.com/client/v4'

# ---------------------------------------------------------------------------
# Registry: welcher Cloudflare-Worker haengt an welcher lokalen Datei, und was
# antwortet er im gesunden Zustand auf eine harmlose, unauthentifizierte Anfrage?
# Die Erwartungswerte wurden am 2026-07-21 an den laufenden Workern gemessen.
# Die Probe beweist einen INTAKTEN Deploy (ein abgeschnittener Upload zerlegt den
# Worker und faellt hier auf), nicht das Verhalten einzelner Commits.
# ---------------------------------------------------------------------------
$REGISTRY = [ordered]@{
  'landingpage' = @{
    datei = 'E:\ToolsUebersicht\admin-worker.js'
    url   = 'https://landingpage.michel-brunner.workers.dev'
    hinweis = 'Zentrales Gateway: Login, Sessions, WebDAV fuer alle Tools. 17 Secrets.'
    proben = @(
      @{ name = '400 unbekannte Aktion'; methode = 'POST'; body = '{"action":"zzz-deploy-kontrolle"}'; erwartet = 400 }
      @{ name = '401 ohne Token';        methode = 'POST'; body = '{"action":"me"}';                   erwartet = 401 }
      @{ name = '403 Passwort-Scope';    methode = 'POST'; body = '{"action":"verify-action-password","scope":"checkliste-sperre","password":"absichtlich-falsch"}'; erwartet = 403 }
    )
  }
  'push' = @{
    datei = 'E:\ToolsUebersicht\push-worker.js'
    url   = 'https://push.michel-brunner.workers.dev'
    hinweis = 'Web-Push-Versand. Zustandslos, KEIN Nextcloud-Zugang - landingpage uebergibt die Abos im Aufruf.'
    # KEINE Gesundheitsproben, und das ist Absicht: workers.dev ist fuer diesen
    # Worker abgeschaltet (am 2026-08-03 per API geprueft: enabled = False). Er
    # ist ausschliesslich ueber das Service Binding von landingpage erreichbar,
    # jeder HTTP-Aufruf von aussen endet in Error 1042. Proben wuerden hier also
    # dauerhaft fehlschlagen und einen Fehlalarm erzeugen.
    #
    # Der Nachweis, dass dieser Worker laeuft, fuehrt deshalb ueber landingpage:
    # eine echte Push-Zustellung auf ein angemeldetes Geraet. Dass der richtige
    # Code oben liegt, prueft dieses Skript ohnehin byte-genau.
    #
    # Wer die Proben doch braucht, schaltet workers.dev voruebergehend ein und
    # muss danach mehrere Minuten auf die Route warten -- 8 Sekunden reichten
    # am 2026-08-03 nicht, alle drei Versuche liefen in 1042.
    proben = @()
  }
  'trainerdaten1' = @{
    datei = 'E:\Trainerdaten\submit-worker.js'
    url   = 'https://trainerdaten1.michel-brunner.workers.dev'
    hinweis = 'Trainerdaten: IBAN + Vertraege. Bewusst NICHT im zentralen DAV_APPS-Gateway.'
    # verifySession() laeuft VOR der Aktions-Weiche -> immer 401, nie "Unbekannte Aktion".
    proben = @(
      @{ name = '401 ohne Token'; methode = 'POST'; body = '{"action":"zzz-deploy-kontrolle"}'; erwartet = 401 }
    )
  }
  'trainerdaten' = @{
    datei = 'E:\Trainerdaten\cors-proxy-worker.js'
    url   = 'https://trainerdaten.michel-brunner.workers.dev'
    hinweis = 'CORS-Proxy (kein Auth, kein Secret). Genutzt von Trainerdaten + Dokumentenvorlagen.'
    proben = @(
      @{ name = '400 ohne url-Parameter'; methode = 'GET'; body = $null; erwartet = 400 }
    )
  }
  'vereinswiki' = @{
    datei = 'E:\Vereinswiki\wiki-worker.js'
    url   = 'https://vereinswiki.michel-brunner.workers.dev'
    hinweis = 'Toolbox Wiki, eigener Gemini-Key.'
    # 401 statt 500 beweist nebenbei, dass GEMINI_API_KEY gesetzt ist - der Worker
    # prueft das Secret VOR dem Token (siehe wiki-worker.js).
    proben = @(
      @{ name = '405 bei GET';                     methode = 'GET';  body = $null; erwartet = 405 }
      @{ name = '401 POST ohne Token (Secret da)'; methode = 'POST'; body = '{}';  erwartet = 401 }
    )
  }
  'beleg-scanner' = @{
    # ACHTUNG: deploybar ist das BUNDLE, nicht worker.js. worker.bundle.js ist eine
    # VON HAND gepflegte Zusammenfuehrung von worker.js + categories.js + pdf.js +
    # storage/google-drive.js (kein Build-Schritt). Vor einem Deploy pruefen, ob das
    # Bundle die Aenderungen aus den Quelldateien wirklich enthaelt.
    datei = 'E:\beleg-scanner\worker.bundle.js'
    url   = 'https://beleg-scanner.michel-brunner.workers.dev'
    hinweis = 'Privates Tool, bewusst von der Landingpage entkoppelt. Bundle statt Quelle!'
    proben = @(
      @{ name = '405 bei GET'; methode = 'GET'; body = $null; erwartet = 405 }
    )
  }
  'sc-heiligenstadt-beleg-upload' = @{
    datei = 'E:\sc-heiligenstadt-budget\worker.js'
    url   = 'https://sc-heiligenstadt-beleg-upload.michel-brunner.workers.dev'
    hinweis = 'Beleg-Eingang des Vereinsbudgets, per Zugriffscode geschuetzt.'
    proben = @(
      @{ name = '405 bei GET'; methode = 'GET'; body = $null; erwartet = 405 }
    )
  }
  'vereinsverwaltung' = @{
    datei = 'E:\vereinsverwaltung\vereinsverwaltung-worker.js'
    url   = 'https://vereinsverwaltung.michel-brunner.workers.dev'
    hinweis = 'Mitglieder, Beitraege, SEPA. Einziger Worker mit D1 (Binding VV_DB) + Service Binding LANDINGPAGE.'
    # verifySession() laeuft VOR der Aktions-Weiche -> immer 401, nie "Unbekannte Aktion".
    # Ein 500 statt 401 heisst: eines der beiden Bindings fehlt (der Worker faellt
    # bewusst geschlossen aus, statt jemanden ungeprueft durchzulassen).
    proben = @(
      @{ name = '405 bei GET';    methode = 'GET';  body = $null; erwartet = 405 }
      @{ name = '401 ohne Token'; methode = 'POST'; body = '{"action":"zzz-deploy-kontrolle"}'; erwartet = 401 }
    )
  }
}

function Schritt($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text)      { Write-Host "   [ok]   $text" -ForegroundColor Green }
function Warn($text)    { Write-Host "   [warn] $text" -ForegroundColor Yellow }
# Sauberer Abbruch statt throw - throw druckt in PS 5.1 einen Stacktrace, den hier niemand braucht.
function Abbruch($text) { Write-Host "`n!! $text`n" -ForegroundColor Red; exit 1 }

function CfCall {
  param([string]$Pfad, [string]$Methode = 'GET', $Body)
  $kopf = @{ Authorization = "Bearer $env:CF_API_TOKEN" }
  # NICHT $args nennen - das ist eine automatische Variable und wird beim Splatten stillschweigend falsch aufgeloest.
  $anfrage = @{ Uri = "$API$Pfad"; Method = $Methode; Headers = $kopf; UseBasicParsing = $true }
  if ($Body) { $anfrage.Body = $Body; $anfrage.ContentType = 'application/json' }
  try {
    return ((Invoke-WebRequest @anfrage).Content | ConvertFrom-Json)
  } catch {
    # PS 5.1: der Fehler-Body steht in ErrorDetails, nicht im Response-Stream.
    throw "Cloudflare-API $Methode $Pfad -> HTTP $($_.Exception.Response.StatusCode.value__)`n$($_.ErrorDetails.Message)"
  }
}

# Mojibake = UTF-8-Bytes als Latin-1 gelesen. Das ergibt IMMER U+00C3 gefolgt von
# einem Zeichen aus U+0080..U+00BF. Bewusst als Codepoint-Vergleich statt als
# literales Suchmuster: ein literales Mojibake-Muster wird beim naechsten Encoding-
# Wechsel der Datei selbst zerstoert - genau das ist beim ersten Entwurf dieses
# Skripts passiert, die Pruefung war danach blind.
function HatMojibake([string]$s) {
  for ($i = 0; $i -lt $s.Length - 1; $i++) {
    if ([int]$s[$i] -eq 0xC3) {
      $folge = [int]$s[$i + 1]
      if ($folge -ge 0x80 -and $folge -le 0xBF) { return $true }
    }
  }
  return $false
}

# Laedt den tatsaechlich laufenden Code. /content (ohne v2) lehnt Token-Auth ab
# (HTTP 405, code 10405); nur /content/v2 geht, liefert aber multipart/form-data.
function Hole-LiveCode($accountId, $name) {
  $antwort = Invoke-WebRequest -Uri "$API/accounts/$accountId/workers/scripts/$name/content/v2" `
               -Headers @{ Authorization = "Bearer $env:CF_API_TOKEN" } -UseBasicParsing
  $roh = if ($antwort.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($antwort.Content) } else { [string]$antwort.Content }
  $grenze = ($antwort.Headers['Content-Type'] -split 'boundary=')[-1].Trim('"', ' ')
  foreach ($teil in ($roh -split [regex]::Escape("--$grenze"))) {
    $trenn = $teil.IndexOf("`r`n`r`n")
    if ($trenn -lt 0) { continue }
    if ($teil.Substring(0, $trenn) -match 'javascript') { return ($teil.Substring($trenn + 4) -replace "`r?`n$", '') }
  }
  return $null
}

function Probiere($url, $probe) {
  $anfrage = @{ Uri = $url; Method = $probe.methode; UseBasicParsing = $true; TimeoutSec = 25 }
  if ($probe.body) { $anfrage.Body = $probe.body; $anfrage.ContentType = 'application/json' }
  try   { $r = Invoke-WebRequest @anfrage; return @{ code = [int]$r.StatusCode; text = $r.Content } }
  catch { return @{ code = [int]$_.Exception.Response.StatusCode.value__; text = $_.ErrorDetails.Message } }
}

# ---------------------------------------------------------------- 1. Token
Schritt 'Token pruefen'
# setx schreibt in die Benutzer-Registry. Ein bereits laufender Prozess - und damit
# jede Shell, die er startet - sieht das erst nach einem Neustart. Statt einen
# Neustart zu verlangen, notfalls direkt aus der Registry nachladen.
foreach ($name in 'CF_API_TOKEN', 'CF_ACCOUNT_ID') {
  if (-not (Get-Item "env:$name" -ErrorAction SilentlyContinue)) {
    $wert = [System.Environment]::GetEnvironmentVariable($name, 'User')
    if ($wert) { Set-Item "env:$name" $wert }
  }
}
if (-not $env:CF_API_TOKEN) {
  Abbruch 'CF_API_TOKEN ist nicht gesetzt. Token anlegen (dash.cloudflare.com -> My Profile -> API Tokens), dann in die Benutzerumgebung legen.'
}
$pruef = CfCall '/user/tokens/verify'
if (-not $pruef.success) { Abbruch 'Token ist ungueltig oder abgelaufen.' }
Ok "Token aktiv (Status: $($pruef.result.status))"

# ------------------------------------------------------------- 2. Account
Schritt 'Account ermitteln'
$accountId = $env:CF_ACCOUNT_ID
if ($accountId) {
  Ok "aus CF_ACCOUNT_ID: $accountId"
} else {
  $konten = (CfCall '/accounts').result
  if (-not $konten -or $konten.Count -eq 0) { Abbruch 'Kein Account lesbar. Entweder CF_ACCOUNT_ID setzen oder dem Token Account-Leserecht geben.' }
  if ($konten.Count -gt 1) {
    Warn 'Mehrere Accounts gefunden - nehme den ersten. Sonst CF_ACCOUNT_ID setzen:'
    $konten | ForEach-Object { Write-Host "          $($_.id)  $($_.name)" }
  }
  $accountId = $konten[0].id
  Ok "$accountId  ($($konten[0].name))"
}

# ---------------------------------------------------- Auswahl bestimmen
if ($Worker -eq 'alle') {
  if ($Datei) { Abbruch '-Datei laesst sich nur mit einem EINZELNEN -Worker kombinieren.' }
  $auswahl = @($REGISTRY.Keys)
} elseif ($REGISTRY.Contains($Worker)) {
  $auswahl = @($Worker)
} else {
  Abbruch "Unbekannter Worker '$Worker'. Bekannt: $((@($REGISTRY.Keys)) -join ', ') - oder 'alle'."
}

# ===========================================================================
function Verarbeite-Worker {
  param([string]$name, $eintrag, [string]$accountId)

  $pfad = if ($Datei) { $Datei } else { $eintrag.datei }
  Schritt "$name"
  Write-Host "   $($eintrag.hinweis)" -ForegroundColor DarkGray

  # ---- lokale Datei
  if (-not (Test-Path $pfad)) { throw "Datei nicht gefunden: $pfad" }
  $bytes = [System.IO.File]::ReadAllBytes($pfad)
  $text  = [System.Text.Encoding]::UTF8.GetString($bytes)
  if ($bytes.Length -lt 200)            { throw "Datei ist nur $($bytes.Length) Bytes - sieht abgeschnitten aus." }
  if ($text -notmatch 'export default') { throw 'Kein "export default" gefunden - das ist kein Modul-Worker.' }
  if (HatMojibake $text)                { throw 'Mojibake in der Datei (doppelt kodiertes UTF-8). Erst die Datei reparieren.' }
  $umlaute = ([regex]::Matches($text, "[äöüÄÖÜß]")).Count
  Ok "$(Split-Path $pfad -Leaf): $([math]::Round($bytes.Length/1KB,1)) KB, $(($text -split "`n").Count) Zeilen, $umlaute Umlaute intakt"

  # ---- Live-Stand: Bindings, compat, Code
  $settings  = (CfCall "/accounts/$accountId/workers/scripts/$name/settings").result
  $bindings  = @($settings.bindings)
  $bindingTypen = @($bindings | ForEach-Object { $_.type } | Sort-Object -Unique)
  Ok "$($bindings.Count) Bindings: $(if ($bindings) { ($bindings | ForEach-Object { $_.name }) -join ', ' } else { '(keine)' })"

  $compatDate = $settings.compatibility_date
  if (-not $compatDate) { $compatDate = (CfCall "/accounts/$accountId/workers/scripts/$name").result.compatibility_date }
  $compatFlags = @($settings.compatibility_flags)

  $live = Hole-LiveCode $accountId $name
  if (-not $live) { throw 'Live-Code liess sich nicht aus der multipart-Antwort loesen.' }
  # Zeilenenden normalisieren: die lokalen Dateien sind teils CRLF (git autocrlf),
  # Cloudflare liefert immer LF zurueck. Ohne das melden beleg-scanner und
  # sc-heiligenstadt dauerhaft "abweichend", obwohl der Code identisch ist.
  $liveN = ($live -replace "`r`n", "`n").TrimEnd()
  $textN = ($text -replace "`r`n", "`n").TrimEnd()
  $gleich = ($liveN -eq $textN)
  if ($gleich) { Ok 'Live-Stand ist inhaltsgleich mit der lokalen Datei - nichts zu tun.' }
  else         { Warn "Live-Stand WEICHT AB (live $([math]::Round($liveN.Length/1KB,1)) KB / lokal $([math]::Round($textN.Length/1KB,1)) KB)" }
  if (HatMojibake $liveN) { Warn 'Der LIVE laufende Code enthaelt Mojibake - ein frueherer Dashboard-Deploy hat Umlaute zerstoert. Deploy repariert das.' }

  if (-not $Deploy) { return @{ status = $(if ($gleich) { 'aktuell' } else { 'abweichend' }) } }
  if ($gleich)      { Ok 'Deploy uebersprungen (waere ein No-Op).'; return @{ status = 'aktuell' } }

  # ---- Plausibilitaet: schrumpft die Datei drastisch, ist das verdaechtig
  if (-not $Erzwingen -and $textN.Length -lt ($liveN.Length * 0.6)) {
    throw "Lokale Datei ist nur $([math]::Round($textN.Length / $liveN.Length * 100))% der Live-Groesse. Mit -Erzwingen ueberstimmen, falls beabsichtigt."
  }

  # ---- Backup
  if (-not $KeinBackup) {
    if (-not (Test-Path $Sicherungsordner)) { [void](New-Item -ItemType Directory -Path $Sicherungsordner) }
    $sicherung = Join-Path $Sicherungsordner ("{0}-{1}.js" -f $name, (Get-Date -Format 'yyyyMMdd-HHmmss'))
    [System.IO.File]::WriteAllText($sicherung, $live, (New-Object System.Text.UTF8Encoding($false)))
    Ok "Backup: $sicherung"
  }

  # ---- Upload
  $dateiName = Split-Path $pfad -Leaf
  # Secrets und uebrige Bindings unangetastet lassen - ohne keep_bindings loescht der
  # PUT sie, und Secret-WERTE sind nirgends rueckauslesbar. Am 2026-07-21 an einem
  # Wegwerf-Worker verifiziert, bevor es auf Produktion angewendet wurde.
  # @(...) erzwingen, sonst wird ein Ein-Element-Array beim JSON-Bau zum Skalar.
  $behalten = @(if ($bindingTypen.Count) { $bindingTypen } else { 'secret_text', 'plain_text' })
  $metadata = @{ main_module = $dateiName; keep_bindings = $behalten }
  if ($compatDate)        { $metadata.compatibility_date  = $compatDate }
  if ($compatFlags.Count) { $metadata.compatibility_flags = @($compatFlags) }
  $metaJson = $metadata | ConvertTo-Json -Depth 5 -Compress

  $grenze = "----claude$([guid]::NewGuid().ToString('N'))"
  $strom  = New-Object System.IO.MemoryStream
  $schreib = {
    param($s)
    $b = [System.Text.Encoding]::UTF8.GetBytes($s); $strom.Write($b, 0, $b.Length)
  }
  & $schreib "--$grenze`r`nContent-Disposition: form-data; name=`"metadata`"`r`nContent-Type: application/json`r`n`r`n$metaJson`r`n"
  & $schreib "--$grenze`r`nContent-Disposition: form-data; name=`"$dateiName`"; filename=`"$dateiName`"`r`nContent-Type: application/javascript+module`r`n`r`n"
  $strom.Write($bytes, 0, $bytes.Length)   # Datei-Bytes 1:1, keine Umkodierung
  & $schreib "`r`n--$grenze--`r`n"

  $ergebnis = Invoke-WebRequest -Uri "$API/accounts/$accountId/workers/scripts/$name" `
    -Method PUT -Headers @{ Authorization = "Bearer $env:CF_API_TOKEN" } `
    -ContentType "multipart/form-data; boundary=$grenze" -Body $strom.ToArray() -UseBasicParsing
  $strom.Dispose()
  $json = $ergebnis.Content | ConvertFrom-Json
  if (-not $json.success) { throw "Upload abgelehnt: $($ergebnis.Content)" }
  Ok "deployed - $($json.result.modified_on)"

  # ---- Gesundheitsprobe
  Start-Sleep -Seconds 2
  $fehler = 0
  foreach ($probe in $eintrag.proben) {
    $a = Probiere $eintrag.url $probe
    if ($a.code -eq $probe.erwartet) { Ok "Probe $($probe.name): $($a.code)" }
    else { Warn "Probe $($probe.name): erwartet $($probe.erwartet), bekommen $($a.code) $($a.text)"; $fehler++ }
  }
  if ($fehler -gt 0) { throw "Gesundheitsprobe fehlgeschlagen ($fehler von $($eintrag.proben.Count)). Rueckfall: Backup ins Dashboard einfuegen." }
  return @{ status = 'deployed' }
}
# ===========================================================================

$ergebnisse = [ordered]@{}
foreach ($name in $auswahl) {
  try { $ergebnisse[$name] = (Verarbeite-Worker $name $REGISTRY[$name] $accountId).status }
  catch {
    Write-Host "   !! $($_.Exception.Message)" -ForegroundColor Red
    $ergebnisse[$name] = 'FEHLER'
  }
}

Schritt 'Zusammenfassung'
foreach ($n in $ergebnisse.Keys) {
  $farbe = switch ($ergebnisse[$n]) { 'deployed' { 'Green' } 'aktuell' { 'DarkGray' } 'abweichend' { 'Yellow' } default { 'Red' } }
  Write-Host ("   {0,-32} {1}" -f $n, $ergebnisse[$n]) -ForegroundColor $farbe
}
if (-not $Deploy) {
  Write-Host "`n-- Analyse-Modus, nichts geschrieben. Zum Deployen: -Deploy anhaengen." -ForegroundColor Magenta
}
if ($ergebnisse.Values -contains 'FEHLER') { exit 1 }
