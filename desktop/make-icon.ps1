# Draws the Circuit Toolkit icon with GDI+ at every Windows icon size and writes:
#   desktop\icon.ico  (embedded in CircuitToolkit.exe)    icon.png (256 px, the web favicon)
# Run: powershell -ExecutionPolicy Bypass -File desktop\make-icon.ps1
Add-Type -AssemblyName System.Drawing

function New-Color([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function New-Pen([string]$hex, [float]$width) {
    $p = New-Object System.Drawing.Pen (New-Color $hex), $width
    $p.LineJoin = 'Round'; $p.StartCap = 'Round'; $p.EndCap = 'Round'
    $p
}

# All geometry is on a 256-unit grid and scaled per size, so every size is drawn crisp rather than resampled.
function Draw-Icon([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
    $g.ScaleTransform($size / 256.0, $size / 256.0)

    # rounded tile, blue gradient (palette blue 400 -> 650)
    $r = 60
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tile.AddArc(6, 6, $r, $r, 180, 90); $tile.AddArc(250 - $r, 6, $r, $r, 270, 90)
    $tile.AddArc(250 - $r, 250 - $r, $r, $r, 0, 90); $tile.AddArc(6, 250 - $r, $r, $r, 90, 90); $tile.CloseFigure()
    $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush ((New-Object System.Drawing.PointF 0, 0)), ((New-Object System.Drawing.PointF 256, 256)), (New-Color '#3987e5'), (New-Color '#104281')
    $g.FillPath($fill, $tile)

    $white = New-Object System.Drawing.SolidBrush (New-Color '#ffffff')
    if ($size -le 24) {
        # tiny sizes: one bold resistor zigzag, nothing else
        $pts = @((28, 128), (64, 128), (84, 88), (112, 168), (140, 88), (168, 168), (192, 128), (228, 128))
        $g.DrawLines((New-Pen '#ffffff' 26), [System.Drawing.PointF[]]($pts | ForEach-Object { New-Object System.Drawing.PointF $_[0], $_[1] }))
    } else {
        # resistor zigzag between two terminal dots
        $pts = @((44, 100), (78, 100), (90, 74), (106, 126), (122, 74), (138, 126), (154, 74), (170, 126), (180, 100), (212, 100))
        $g.DrawLines((New-Pen '#ffffff' 14), [System.Drawing.PointF[]]($pts | ForEach-Object { New-Object System.Drawing.PointF $_[0], $_[1] }))
        $g.FillEllipse($white, 32, 88, 24, 24); $g.FillEllipse($white, 200, 88, 24, 24)
        # one sine period underneath (amber) — the waveform side of the tool
        $sine = New-Pen '#fab219' 13
        $g.DrawBezier($sine, 44, 182, 74, 138, 98, 138, 128, 182)
        $g.DrawBezier($sine, 128, 182, 158, 226, 182, 226, 212, 182)
    }
    $g.Dispose()
    $bmp
}

# Classic 32-bit DIB icon entry: BITMAPINFOHEADER (height doubled), bottom-up BGRA rows, then an all-zero AND mask.
function ConvertTo-IconDib([System.Drawing.Bitmap]$bmp) {
    $s = $bmp.Width
    $data = $bmp.LockBits((New-Object System.Drawing.Rectangle 0, 0, $s, $s), 'ReadOnly', ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
    $px = New-Object byte[] ($data.Stride * $s)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $px.Length)
    $bmp.UnlockBits($data)
    $maskRow = [int][Math]::Ceiling($s / 32.0) * 4
    $ms = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter $ms
    $w.Write([uint32]40); $w.Write([int32]$s); $w.Write([int32]($s * 2)); $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]0); $w.Write([uint32]($s * $s * 4 + $maskRow * $s)); $w.Write([int32]0); $w.Write([int32]0); $w.Write([uint32]0); $w.Write([uint32]0)
    for ($y = $s - 1; $y -ge 0; $y--) { $w.Write($px, $y * $data.Stride, $s * 4) }
    $w.Write((New-Object byte[] ($maskRow * $s)))
    $w.Flush()
    , $ms.ToArray() # leading comma: return the byte[] intact instead of letting PowerShell unroll it
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$entries = @()
foreach ($s in $sizes) {
    $bmp = Draw-Icon $s
    if ($s -eq 256) { # PNG only for the big entry (standard practice; older readers mis-decode small PNG entries)
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $entries += , $ms.ToArray()
        $png256 = $ms.ToArray()
    } else { $entries += , (ConvertTo-IconDib $bmp) }
    $bmp.Dispose()
}
$pngs = $entries

# ICO container: directory of entries, then the image data
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = [byte]($sizes[$i] % 256)  # 0 means 256
    $w.Write($dim); $w.Write($dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write([byte[]]$p) }
$w.Flush()

[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'icon.ico'), $out.ToArray())
[System.IO.File]::WriteAllBytes((Join-Path (Split-Path $PSScriptRoot -Parent) 'icon.png'), $png256)
"Wrote icon.ico ($($out.Length) bytes, sizes $($sizes -join ', ')) and icon.png"
