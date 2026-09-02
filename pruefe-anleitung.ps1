# Prueft, ob die Wissensbasis des Toolbox Wiki (E:\SC1911-Tools-Anleitung.txt) noch
# zum aktuellen Stand der Tool-Flotte passt.
#
# Warum: Die Anleitung ist die Datei, aus der der KI-Assistent im Wiki Bedienfragen
# beantwortet. Sie wird von Hand gepflegt und synchronisiert sich NICHT automatisch —
# wenn ein Tool dazukommt oder sich stark aendert, antwortet der Assistent so lange
# veraltet, bis jemand die Datei aktualisiert UND neu hochlaedt. Genau das ist zwischen
# Juli 2026 mehrfach untergegangen, einmal sogar in die falsche Richtung (eine
# Memory-Notiz behauptete monatelang "nie hochgeladen", obwohl die Datei laengst im
# Wiki lag). Dieses Skript ersetzt die Gedaechtnisstuetze durch eine Messung.
#
# Bewusst NICHT automatisiert: das Schreiben der Beschreibungen. Quelle waeren die
# CLAUDE.md-Dateien, aber das ist Entwicklerdoku (Gotchas, Worker-URLs, Deploy-Schritte,
# Sicherheitsueberlegungen). Wuerde man die automatisch einspeisen, erklaert der
# Assistent Vereinsmitgliedern irgendwann die Cloudflare-Deploy-Schritte. Die
# Uebersetzung in Nutzersprache bleibt Handarbeit — dieses Skript sagt nur, WANN sie
# faellig ist und WOFUER.
#
# Aufruf:  .\pruefe-anleitung.ps1

[CmdletBinding()]
param(
  [string]$Anleitung = 'E:\SC1911-Tools-Anleitung.txt',
  [string]$Config    = 'E:\ToolsUebersicht\config.js',
  [string]$RepoWurzel = 'E:\'
)

$ErrorActionPreference = 'Stop'

function Kopf($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "   [ok]   $t" -ForegroundColor Green }
function Hin($t)  { Write-Host "   [!]    $t" -ForegroundColor Yellow }

if (-not (Test-Path $Anleitung)) { Write-Host "Anleitung nicht gefunden: $Anleitung" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $Config))    { Write-Host "config.js nicht gefunden: $Config"    -ForegroundColor Red; exit 1 }

$text  = [System.IO.File]::ReadAllText($Anleitung, [System.Text.Encoding]::UTF8)
$klein = $text.ToLower()
$datei = Get-Item $Anleitung
$cfg   = [System.IO.File]::ReadAllText($Config, [System.Text.Encoding]::UTF8)

Kopf 'Anleitung'
Ok ("{0}, {1} KB, zuletzt geaendert {2}" -f (Split-Path $Anleitung -Leaf), [math]::Round($datei.Length/1KB,1), $datei.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
if ($text -match 'Stand: (\d{4}-\d{2}-\d{2})') { Ok "Stand-Vermerk im Dokument: $($Matches[1])" }
else { Hin 'Kein "Stand: JJJJ-MM-TT"-Vermerk im Kopf — waere hilfreich.' }

# ---------------------------------------------------------------- Tool-Abdeckung
Kopf 'Sind alle Tools beschrieben?'
# id/name-Paare aus dem TOOLS-Array. Treffer zaehlt, wenn die Anleitung die Tool-Id,
# den vollen Anzeigenamen ODER dessen erstes Wort enthaelt — die Abschnitte sind nach
# Anzeigenamen benannt, nicht nach Ids (eine reine Id-Suche meldet Fehlalarme).
# Abschnitts-UEBERSCHRIFTEN einsammeln (Zeile zwischen zwei Trennlinien). Eine reine
# Volltextsuche taugt hier NICHT: "Busplan" steht z.B. auch im Kadermanager-Abschnitt
# ("dafuer ist weiterhin das Tool Busplan zustaendig") — ein geloeschter Abschnitt
# faellt damit nicht auf. Genau das hat der Negativtest beim Bau dieses Skripts
# aufgedeckt.
$zeilen = $text -split "`r?`n"
$ueberschriften = New-Object System.Collections.Generic.List[string]
for ($i = 1; $i -lt $zeilen.Count - 1; $i++) {
  if ($zeilen[$i-1] -match '^-{10,}$' -and $zeilen[$i+1] -match '^-{10,}$') { $ueberschriften.Add($zeilen[$i].ToLower()) }
}
$kopfText = ($ueberschriften -join ' | ')

$gesehen = @{}
$fehlend    = New-Object System.Collections.Generic.List[string]
$nurErwaehnt = New-Object System.Collections.Generic.List[string]
foreach ($m in [regex]::Matches($cfg, '(?s)id:\s*"([a-z0-9-]+)".*?name:\s*"([^"]+)"')) {
  $id = $m.Groups[1].Value; $name = $m.Groups[2].Value
  if ($gesehen.ContainsKey($id)) { continue }
  $gesehen[$id] = $true
  $kern = ($name -split '[ (/–-]')[0].ToLower().Trim()
  $imKopf = $kopfText.Contains($id.ToLower()) -or $kopfText.Contains($name.ToLower()) -or ($kern.Length -gt 4 -and $kopfText.Contains($kern))
  $imText = $klein.Contains($id.ToLower())    -or $klein.Contains($name.ToLower())    -or ($kern.Length -gt 4 -and $klein.Contains($kern))
  if      ($imKopf) { }
  elseif  ($imText) { $nurErwaehnt.Add("$name  ($id)") }
  else              { $fehlend.Add("$name  ($id)") }
}
Ok "$($ueberschriften.Count) Abschnitte in der Anleitung, $($gesehen.Count) Tools in config.js"
if ($fehlend.Count -eq 0 -and $nurErwaehnt.Count -eq 0) { Ok 'jedes Tool hat einen eigenen Abschnitt' }
if ($nurErwaehnt.Count -gt 0) {
  Hin "$($nurErwaehnt.Count) Tool(s) nur nebenbei erwaehnt, ohne eigenen Abschnitt:"
  $nurErwaehnt | ForEach-Object { Write-Host "          $_" -ForegroundColor Yellow }
}
if ($fehlend.Count -gt 0) {
  Hin "$($fehlend.Count) Tool(s) kommen gar nicht vor:"
  $fehlend | ForEach-Object { Write-Host "          $_" -ForegroundColor Yellow }
}

# ---------------------------------------------------- Tote Gruppennamen in der Doku
Kopf 'Nennt die Anleitung Gruppen, die es nicht mehr gibt?'
# Das alte Rechte-Modell hatte Gruppen wie "busplan-bearbeiter". Seit dem
# editGroupIds-Umbau existieren nur noch die Organisationsgruppen. Der Live-Stand
# ist ohne Login abrufbar: ein GET auf den Worker liefert die tools-Konfiguration.
$tote = [regex]::Matches($text, '[a-z]+-bearbeiter')
if ($tote.Count -eq 0) { Ok 'keine "*-bearbeiter"-Gruppen erwaehnt' }
else {
  Hin "$($tote.Count) Erwaehnung(en) alter Bearbeiter-Gruppen — die gibt es nicht mehr:"
  $tote | ForEach-Object { $_.Value } | Sort-Object -Unique | ForEach-Object { Write-Host "          $_" -ForegroundColor Yellow }
}

try {
  $live = (Invoke-WebRequest -Uri 'https://landingpage.michel-brunner.workers.dev' -Method GET -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json
  $gruppen = @($live.tools.PSObject.Properties | ForEach-Object { @($_.Value.groupIds) + @($_.Value.editGroupIds) } | Where-Object { $_ } | Sort-Object -Unique)
  Ok ("live tatsaechlich verwendete Gruppen: {0}" -f ($gruppen -join ', '))
} catch {
  Hin "Live-Konfiguration nicht abrufbar ($($_.Exception.Message)) — Gruppenabgleich uebersprungen."
}

# ------------------------------------------------------------- Aenderte sich etwas?
Kopf 'Welche Tools haben sich seit der letzten Aktualisierung geaendert?'
$neuer = Get-ChildItem -Path $RepoWurzel -Depth 1 -Filter 'CLAUDE.md' -File -ErrorAction SilentlyContinue |
         Where-Object { $_.LastWriteTime -gt $datei.LastWriteTime } |
         Sort-Object LastWriteTime -Descending
if (-not $neuer) { Ok 'keine Tool-Dokumentation ist neuer als die Anleitung' }
else {
  Hin "$($neuer.Count) Repo(s) mit neuerer Doku — dort ggf. Beschreibung nachziehen:"
  $neuer | ForEach-Object { Write-Host ("          {0,-28} {1}" -f $_.Directory.Name, $_.LastWriteTime.ToString('yyyy-MM-dd')) -ForegroundColor Yellow }
}

# ------------------------------------------------------------------------ Fazit
Kopf 'Fazit'
$handlungsbedarf = ($fehlend.Count -gt 0) -or ($nurErwaehnt.Count -gt 0) -or ($tote.Count -gt 0) -or ($neuer -and $neuer.Count -gt 0)
if ($handlungsbedarf) {
  Write-Host '   Aktualisierung faellig. Danach die Datei im Toolbox Wiki neu hochladen:' -ForegroundColor Yellow
  Write-Host '   https://sc1911heiligenstadt.github.io/Vereinswiki/ -> Tab "Dokumente" -> alte Version' -ForegroundColor DarkGray
  Write-Host '   entfernen, neue hochladen (nur Admin). Ohne Upload aendert sich fuer die' -ForegroundColor DarkGray
  Write-Host '   Nutzer nichts — die Datei auf der Platte ist nicht die im Wiki.' -ForegroundColor DarkGray
  exit 1
}
Write-Host '   Anleitung ist auf Stand. Trotzdem daran denken: das sagt nur, dass die Datei' -ForegroundColor Green
Write-Host '   HIER aktuell ist — ob dieselbe Fassung auch im Wiki liegt, weiss nur ein Blick' -ForegroundColor DarkGray
Write-Host '   in den Dokumente-Tab.' -ForegroundColor DarkGray
