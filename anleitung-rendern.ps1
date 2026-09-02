# Rendert die Schritt-Bilder für die Push-Anleitung.
# Farben, Tab-Namen und Beschriftungen sind 1:1 aus style.css / index.html der
# ToolsUebersicht übernommen -- niemand soll einen Knopf suchen, den es so nicht gibt.
param([string]$Ziel = ".")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$BLAU       = [System.Drawing.Color]::FromArgb(26, 86, 160)   # --blue
$BLAU_HELL  = [System.Drawing.Color]::FromArgb(232, 240, 251) # --blue-light
$RAND       = [System.Drawing.Color]::FromArgb(221, 225, 232) # --border
$TEXT       = [System.Drawing.Color]::FromArgb(30, 35, 48)    # --text
$MUTED      = [System.Drawing.Color]::FromArgb(107, 114, 128) # --muted
$GRAU       = [System.Drawing.Color]::FromArgb(244, 245, 247) # --gray
$WEISS      = [System.Drawing.Color]::White
$AKZENT     = [System.Drawing.Color]::FromArgb(192, 57, 43)   # --red, nur fuer Markierungen

$AUF = [char]0x201E   # oeffnendes deutsches Anfuehrungszeichen
$ZU  = [char]0x201C   # schliessendes -- als Literal im Quelltext BEENDET es den String
$W = 900
$H_ARBEIT = 1600   # grosszuegig gezeichnet, am Ende auf den echten Inhalt zugeschnitten

function Rund($g, $rect, $r, $fuellung, $randfarbe) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $p.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $p.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $p.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  if ($fuellung) { $b = New-Object System.Drawing.SolidBrush($fuellung); $g.FillPath($b, $p); $b.Dispose() }
  if ($randfarbe) { $pen = New-Object System.Drawing.Pen($randfarbe, 2); $g.DrawPath($pen, $p); $pen.Dispose() }
  $p.Dispose()
}

function Text($g, $s, $font, $farbe, $x, $y, $breite) {
  $b = New-Object System.Drawing.SolidBrush($farbe)
  if ($breite) {
    $rect = New-Object System.Drawing.RectangleF($x, $y, $breite, 10000)
    $g.DrawString($s, $font, $b, $rect)
    $gr = $g.MeasureString($s, $font, [int]$breite)
    $b.Dispose()
    return [int]$gr.Height
  }
  $g.DrawString($s, $font, $b, [float]$x, [float]$y)
  $h = $g.MeasureString($s, $font).Height
  $b.Dispose()
  return [int]$h
}

function NeueSeite() {
  $bmp = New-Object System.Drawing.Bitmap($W, $H_ARBEIT, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear($WEISS)
  return @($bmp, $g)
}

function Kopf($g, $nr, $titel, $unterzeile) {
  $fNr    = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold)
  $fTitel = New-Object System.Drawing.Font("Segoe UI", 30, [System.Drawing.FontStyle]::Bold)
  $fUnter = New-Object System.Drawing.Font("Segoe UI", 17)

  $kreis = New-Object System.Drawing.Rectangle(60, 55, 66, 66)
  $b = New-Object System.Drawing.SolidBrush($BLAU); $g.FillEllipse($b, $kreis); $b.Dispose()
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $bw = New-Object System.Drawing.SolidBrush($WEISS)
  $g.DrawString([string]$nr, $fNr, $bw, [System.Drawing.RectangleF]$kreis, $sf)
  $bw.Dispose()

  [void](Text $g $titel $fTitel $TEXT 145 60 700)
  $y = 138
  if ($unterzeile) { $y += (Text $g $unterzeile $fUnter $MUTED 60 $y 780) + 16 }
  $fNr.Dispose(); $fTitel.Dispose(); $fUnter.Dispose()
  return $y
}

# Hinweiskasten; liefert das y NACH dem Kasten
function Fuss($g, $y, $satz) {
  $f = New-Object System.Drawing.Font("Segoe UI", 16)
  $innen = $W - 164
  $hoehe = [int]($g.MeasureString($satz, $f, $innen).Height) + 44
  $rect = New-Object System.Drawing.Rectangle(60, $y, ($W - 120), $hoehe)
  Rund $g $rect 12 $BLAU_HELL $null
  [void](Text $g $satz $f $TEXT 82 ($y + 22) $innen)
  $f.Dispose()
  return $rect.Bottom
}

function Markiere($g, $x, $y, $b, $h) {
  $pen = New-Object System.Drawing.Pen($AKZENT, 4)
  $pen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
  $rect = New-Object System.Drawing.Rectangle(($x - 8), ($y - 8), ($b + 16), ($h + 16))
  $g.DrawRectangle($pen, $rect)
  $pen.Dispose()
}

function Knopf($g, $x, $y, $beschriftung, $primaer) {
  $f = New-Object System.Drawing.Font("Segoe UI", 17, [System.Drawing.FontStyle]::Bold)
  $mass = $g.MeasureString($beschriftung, $f)
  $b = [int]$mass.Width + 44
  $h = 54
  $rect = New-Object System.Drawing.Rectangle($x, $y, $b, $h)
  if ($primaer) { Rund $g $rect 9 $BLAU $null } else { Rund $g $rect 9 $WEISS $RAND }
  $farbe = if ($primaer) { $WEISS } else { $TEXT }
  $br = New-Object System.Drawing.SolidBrush($farbe)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString($beschriftung, $f, $br, [System.Drawing.RectangleF]$rect, $sf)
  $br.Dispose(); $f.Dispose()
  return @($b, $h)
}

# Auf die tatsaechlich genutzte Hoehe zuschneiden statt auf ein festes Format --
# sonst steht unter kurzen Schritten eine halbe Seite Weiss.
function Speichern($bmp, $endeY, $pfad) {
  $hoehe = [Math]::Min($H_ARBEIT, $endeY + 45)
  $aus = New-Object System.Drawing.Bitmap($W, $hoehe, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g2 = [System.Drawing.Graphics]::FromImage($aus)
  $g2.Clear($WEISS)
  $g2.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $W, $hoehe)),
                       (New-Object System.Drawing.Rectangle(0, 0, $W, $hoehe)),
                       [System.Drawing.GraphicsUnit]::Pixel)
  $g2.Dispose()
  $aus.Save($pfad, [System.Drawing.Imaging.ImageFormat]::Png)
  $aus.Dispose()
  return $hoehe
}

$fT = New-Object System.Drawing.Font("Segoe UI", 17)
$fB = New-Object System.Drawing.Font("Segoe UI", 17, [System.Drawing.FontStyle]::Bold)

# ---------------------------------------------------------------- Bild 1
$r = NeueSeite; $bmp = $r[0]; $g = $r[1]
$y = Kopf $g 1 "Nur auf dem iPhone" "Mit einem Android-Handy überspringst du diesen Schritt und machst gleich bei Schritt 2 weiter."

$karte = New-Object System.Drawing.Rectangle(60, $y, ($W - 120), 190)
Rund $g $karte 12 $WEISS $RAND
[void](Text $g "Tools-Übersicht" $fB $BLAU 88 ($y + 24) 400)
$kb = Knopf $g 88 ($y + 78) "Als App ablegen" $true
Markiere $g 88 ($y + 78) $kb[0] $kb[1]
$y = $karte.Bottom + 36

$y += (Text $g "Apple erlaubt Benachrichtigungen nur für Web-Apps, die auf dem Startbildschirm liegen. Im normalen Safari-Fenster gibt es sie nicht — dort fehlt der Einschalten-Knopf deshalb ganz." $fT $TEXT 60 $y 780) + 24
$y += (Text $g "So geht es:" $fB $TEXT 60 $y 780) + 12
foreach ($s in @(
  "1.  Tools-Übersicht in Safari öffnen und anmelden.",
  "2.  Oben auf den Knopf ${AUF}Als App ablegen${ZU} tippen.",
  "3.  Der Anleitung folgen: Teilen-Symbol, dann ${AUF}Zum Home-Bildschirm${ZU}.",
  "4.  Die App ab jetzt über das neue Symbol öffnen — nicht mehr über Safari.")) {
  $y += (Text $g $s $fT $TEXT 82 $y 760) + 12
}
$y = Fuss $g ($y + 16) "Wichtig: Nach dem Ablegen die App wirklich über das neue Symbol starten. Im Safari-Fenster bleibt der Einschalten-Knopf aus, egal wie oft man nachsieht."
$h1 = Speichern $bmp $y (Join-Path $Ziel "push-schritt-1.png")
$g.Dispose(); $bmp.Dispose()

# ---------------------------------------------------------------- Bild 2
$r = NeueSeite; $bmp = $r[0]; $g = $r[1]
$y = Kopf $g 2 "Mein Konto öffnen" "Ab hier ist alles auf Android und iPhone gleich."

$leiste = New-Object System.Drawing.Rectangle(60, $y, ($W - 120), 88)
Rund $g $leiste 12 $GRAU $RAND
$tx = 84
foreach ($t in @("Dashboard", "Mein Konto", "Info")) {
  $mass = $g.MeasureString($t, $fB)
  $tb = [int]$mass.Width + 32
  $rect = New-Object System.Drawing.Rectangle($tx, ($y + 16), $tb, 56)
  if ($t -eq "Mein Konto") {
    Rund $g $rect 8 $WEISS $BLAU
    [void](Text $g $t $fB $BLAU ($tx + 16) ($y + 30) $tb)
    Markiere $g $tx ($y + 16) $tb 56
  } else {
    [void](Text $g $t $fT $MUTED ($tx + 16) ($y + 31) $tb)
  }
  $tx += $tb + 18
}
$y = $leiste.Bottom + 36

$y += (Text $g "Der Tab heißt ${AUF}Mein Konto${ZU}, sobald du angemeldet bist — abgemeldet steht dort ${AUF}Anmelden${ZU}. Scrolle darin nach unten bis zu dieser Karte:" $fT $TEXT 60 $y 780) + 26

$karte = New-Object System.Drawing.Rectangle(60, $y, ($W - 120), 300)
Rund $g $karte 12 $WEISS $RAND
$fH = New-Object System.Drawing.Font("Segoe UI", 22, [System.Drawing.FontStyle]::Bold)
[void](Text $g "Benachrichtigungen aufs Handy" $fH $TEXT 88 ($y + 26) 700)
$fM = New-Object System.Drawing.Font("Segoe UI", 15)
[void](Text $g "Statt oder zusätzlich zur E-Mail meldet sich die App direkt auf dem Gerät, wenn ein Termin geteilt wird, eine Aufgabe für dich hereinkommt oder ein Dokument auf deine Unterschrift wartet. Die Nachricht nennt nie Namen oder Titel — nur worum es geht." $fM $MUTED 88 ($y + 76) 720)
$kb = Knopf $g 88 ($y + 210) "Einschalten" $true
Markiere $g 88 ($y + 210) $kb[0] $kb[1]
$fH.Dispose(); $fM.Dispose()
$y = $karte.Bottom + 30

$y = Fuss $g $y "Siehst du die Karte gar nicht? Dann bist du entweder nicht angemeldet — oder auf dem iPhone noch im Safari-Fenster statt in der abgelegten App (Schritt 1)."
$h2 = Speichern $bmp $y (Join-Path $Ziel "push-schritt-2.png")
$g.Dispose(); $bmp.Dispose()

# ---------------------------------------------------------------- Bild 3
$r = NeueSeite; $bmp = $r[0]; $g = $r[1]
$y = Kopf $g 3 "Zulassen antippen" "Das Gerät fragt einmalig nach — danach nie wieder."

$dlg = New-Object System.Drawing.Rectangle(170, $y, 560, 250)
$sch = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(28, 0, 0, 0))
$g.FillRectangle($sch, (New-Object System.Drawing.Rectangle(($dlg.X + 6), ($dlg.Y + 8), $dlg.Width, $dlg.Height)))
$sch.Dispose()
Rund $g $dlg 16 $WEISS $RAND
$fD = New-Object System.Drawing.Font("Segoe UI", 17, [System.Drawing.FontStyle]::Bold)
$fDm = New-Object System.Drawing.Font("Segoe UI", 15)
[void](Text $g "sc1911heiligenstadt.github.io" $fD $TEXT ($dlg.X + 34) ($dlg.Y + 30) 500)
[void](Text $g "möchte dir Benachrichtigungen senden" $fDm $MUTED ($dlg.X + 34) ($dlg.Y + 64) 500)
[void](Knopf $g ($dlg.X + 34) ($dlg.Y + 140) "Blockieren" $false)
$kb = Knopf $g ($dlg.X + 310) ($dlg.Y + 140) "Zulassen" $true
Markiere $g ($dlg.X + 310) ($dlg.Y + 140) $kb[0] $kb[1]
$fD.Dispose(); $fDm.Dispose()
$y = $dlg.Bottom + 40

$y += (Text $g "Diese Frage stellt das Handy selbst, nicht die App. Nur wenn du hier zulässt, können Nachrichten ankommen." $fT $TEXT 60 $y 780) + 24
$y += (Text $g "Aus Versehen blockiert?" $fB $TEXT 60 $y 780) + 12
$y += (Text $g "Dann fragt der Browser nicht noch einmal. Du gibst es in den Einstellungen des Geräts wieder frei — bei Android unter Einstellungen ▸ Benachrichtigungen, auf dem iPhone unter Einstellungen ▸ Mitteilungen." $fT $TEXT 82 $y 760) + 22

$y = Fuss $g $y "Nach dem Zulassen erscheint die Liste aus Schritt 4. Bleibt sie leer, hilft es meistens, die App einmal ganz zu schließen und neu zu öffnen."
$h3 = Speichern $bmp $y (Join-Path $Ziel "push-schritt-3.png")
$g.Dispose(); $bmp.Dispose()

# ---------------------------------------------------------------- Bild 4
$r = NeueSeite; $bmp = $r[0]; $g = $r[1]
$y = Kopf $g 4 "Aussuchen, was ankommt" "Zu Beginn ist alles eingeschaltet — abwählen kannst du jederzeit."

$anlaesse = @(
  "Vereinskalender — neue und geänderte Termine",
  "Vereinsaufgaben — neue Aufgaben für mich",
  "Unterschriften — Dokumente, die auf mich warten",
  "Testspielplaner — Anfragen und Entscheidungen",
  "Materialbedarf — Meldungen und Entscheidungen",
  "Fahrtenbuch — neu eingereichte Fahrten",
  "Fotoaufträge — neue Aufträge für meine Mannschaft"
)
$karte = New-Object System.Drawing.Rectangle(60, $y, ($W - 120), (86 + $anlaesse.Count * 52))
Rund $g $karte 12 $WEISS $RAND
$fH = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold)
[void](Text $g "Wobei soll sich die App melden?" $fH $TEXT 88 ($y + 24) 700)
$fH.Dispose()

$ay = $y + 80
foreach ($a in $anlaesse) {
  $box = New-Object System.Drawing.Rectangle(90, $ay, 26, 26)
  Rund $g $box 5 $BLAU $null
  $pen = New-Object System.Drawing.Pen($WEISS, 3)
  $g.DrawLines($pen, @(
    (New-Object System.Drawing.Point(($box.X + 6), ($box.Y + 13))),
    (New-Object System.Drawing.Point(($box.X + 11), ($box.Y + 19))),
    (New-Object System.Drawing.Point(($box.X + 20), ($box.Y + 7)))))
  $pen.Dispose()
  [void](Text $g $a $fT $TEXT 132 ($ay + 1) 700)
  $ay += 52
}
$y = $karte.Bottom + 36

$y += (Text $g "Jeder Punkt lässt sich einzeln abschalten. Die Änderung gilt sofort und für alle deine Geräte." $fT $TEXT 60 $y 780) + 24
$y += (Text $g "Gut zu wissen" $fB $TEXT 60 $y 780) + 12
foreach ($s in @(
  "Die Nachricht nennt nie Namen, Titel oder Beträge — immer nur, worum es geht.",
  "Die E-Mails laufen unverändert weiter. Die Nachricht kommt dazu, sie ersetzt nichts.",
  "Auf einem zweiten Gerät einfach dasselbe noch einmal machen.")) {
  $y += (Text $g ("•   " + $s) $fT $TEXT 82 $y 760) + 10
}

$y = Fuss $g ($y + 14) "Abschalten geht an derselben Stelle: Mein Konto ▸ Benachrichtigungen aufs Handy. Dort steht auch, welche Geräte angemeldet sind."
$h4 = Speichern $bmp $y (Join-Path $Ziel "push-schritt-4.png")
$g.Dispose(); $bmp.Dispose()

$fT.Dispose(); $fB.Dispose()
"Fertig. Hoehen: $h1 / $h2 / $h3 / $h4 px"
