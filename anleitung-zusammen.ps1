# Setzt die vier Schritt-Bilder zu EINEM Blatt zusammen.
#
# 2x2 statt alles untereinander: eine Spalte waere rund 900 x 4000 px, und in der
# Grossansicht der Neuigkeiten wird ein Bild proportional eingepasst -- ein so
# schmales Hochformat schrumpfte auf einem 800 px hohen Fenster auf ~270 px Breite
# und waere nicht mehr lesbar. Beim Raster bleibt jede Zelle knapp halb so breit
# wie das Fenster.
#
# Quelle sind die fertigen PNGs, nicht neu gezeichneter Code -- so koennen Einzel-
# und Gesamtfassung gar nicht auseinanderlaufen.
param(
  [string]$Quelle = ".",
  [string]$Ziel   = "push-anleitung-komplett.png"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$AUF = [char]0x201E
$ZU  = [char]0x201C

$BLAU      = [System.Drawing.Color]::FromArgb(26, 86, 160)
$RAND      = [System.Drawing.Color]::FromArgb(221, 225, 232)
$TEXT      = [System.Drawing.Color]::FromArgb(30, 35, 48)
$MUTED     = [System.Drawing.Color]::FromArgb(107, 114, 128)
$WEISS     = [System.Drawing.Color]::White
$PAPIER    = [System.Drawing.Color]::FromArgb(244, 245, 247)

$LUFT   = 40   # zwischen den Zellen und zum Blattrand
$KOPF   = 190  # Titelbereich oben

$dateien = 1..4 | ForEach-Object { Join-Path $Quelle ("push-schritt-" + $_ + ".png") }
foreach ($d in $dateien) { if (-not (Test-Path $d)) { throw "Fehlt: $d" } }
$bilder = $dateien | ForEach-Object { [System.Drawing.Image]::FromFile($_) }

$spalten = 2
$zellB = ($bilder | ForEach-Object { $_.Width } | Measure-Object -Maximum).Maximum
# Zeilenhoehe = das hoechste Bild der jeweiligen Zeile
$zeile1H = [Math]::Max($bilder[0].Height, $bilder[1].Height)
$zeile2H = [Math]::Max($bilder[2].Height, $bilder[3].Height)

$W = $LUFT + ($zellB + $LUFT) * $spalten
$H = $KOPF + $zeile1H + $LUFT + $zeile2H + $LUFT

$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear($PAPIER)

# ---- Kopfzeile
$fTitel = New-Object System.Drawing.Font("Segoe UI", 40, [System.Drawing.FontStyle]::Bold)
$fUnter = New-Object System.Drawing.Font("Segoe UI", 21)
$bT = New-Object System.Drawing.SolidBrush($TEXT)
$bM = New-Object System.Drawing.SolidBrush($MUTED)
$g.DrawString("Benachrichtigungen aufs Handy", $fTitel, $bT, [float]$LUFT, 42.0)
$g.DrawString("So schaltest du sie ein " + [char]0x2014 + " in vier Schritten. Auf Android geht es ab Schritt 2 los.",
              $fUnter, $bM, [float]($LUFT + 4), 116.0)
$bT.Dispose(); $bM.Dispose(); $fTitel.Dispose(); $fUnter.Dispose()

# Feine Linie unter dem Kopf
$pen = New-Object System.Drawing.Pen($RAND, 2)
$g.DrawLine($pen, [float]$LUFT, [float]($KOPF - 24), [float]($W - $LUFT), [float]($KOPF - 24))
$pen.Dispose()

# ---- Zellen
$positionen = @(
  @{ i = 0; x = $LUFT;                    y = $KOPF },
  @{ i = 1; x = ($LUFT * 2 + $zellB);     y = $KOPF },
  @{ i = 2; x = $LUFT;                    y = ($KOPF + $zeile1H + $LUFT) },
  @{ i = 3; x = ($LUFT * 2 + $zellB);     y = ($KOPF + $zeile1H + $LUFT) }
)
foreach ($p in $positionen) {
  $b = $bilder[$p.i]
  # Weisser Grund in voller Zellenhoehe, damit kuerzere Schritte keine graue
  # Stufe unter sich lassen
  $zellH = if ($p.i -lt 2) { $zeile1H } else { $zeile2H }
  $zelle = New-Object System.Drawing.Rectangle($p.x, $p.y, $zellB, $zellH)
  $br = New-Object System.Drawing.SolidBrush($WEISS)
  $g.FillRectangle($br, $zelle)
  $br.Dispose()
  $g.DrawImage($b, [int]$p.x, [int]$p.y, [int]$b.Width, [int]$b.Height)
  $pen = New-Object System.Drawing.Pen($RAND, 2)
  $g.DrawRectangle($pen, $zelle)
  $pen.Dispose()
}

$g.Dispose()
$bmp.Save($Ziel, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$bilder | ForEach-Object { $_.Dispose() }

"Geschrieben: $Ziel ($W x $H px)"
