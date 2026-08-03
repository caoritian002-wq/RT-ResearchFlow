param(
  [string]$OutputPath = 'resources/icon.ico'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  [System.IO.Path]::GetFullPath($OutputPath)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputPath))
}
$resourcesRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'resources'))
if (-not $resolvedOutput.StartsWith($resourcesRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Icon output must stay inside the repository resources directory: $resolvedOutput"
}

function New-RoundedRectanglePath {
  param(
    [single]$X,
    [single]$Y,
    [single]$Width,
    [single]$Height,
    [single]$Radius
  )

  $diameter = $Radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-GradientBrush {
  param(
    [System.Drawing.PointF]$Start,
    [System.Drawing.PointF]$End,
    [System.Drawing.Color[]]$Colors,
    [single[]]$Positions
  )

  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($Start, $End, $Colors[0], $Colors[$Colors.Length - 1])
  $blend = [System.Drawing.Drawing2D.ColorBlend]::new($Colors.Length)
  $blend.Colors = $Colors
  $blend.Positions = $Positions
  $brush.InterpolationColors = $blend
  return $brush
}

function New-IconPngBytes {
  param([int]$Size)

  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $stream = [System.IO.MemoryStream]::new()
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $scale = [single]($Size / 48.0)
    $graphics.ScaleTransform($scale, $scale)

    $surfacePath = New-RoundedRectanglePath -X 3 -Y 3 -Width 42 -Height 42 -Radius 12
    $surfaceBrush = New-GradientBrush `
      -Start ([System.Drawing.PointF]::new(8, 6)) `
      -End ([System.Drawing.PointF]::new(40, 42)) `
      -Colors ([System.Drawing.Color[]]@(
        [System.Drawing.ColorTranslator]::FromHtml('#0F766E'),
        [System.Drawing.ColorTranslator]::FromHtml('#0EA5E9'),
        [System.Drawing.ColorTranslator]::FromHtml('#1D4ED8')
      )) `
      -Positions ([single[]]@(0, 0.58, 1))
    try {
      $graphics.FillPath($surfaceBrush, $surfacePath)
    } finally {
      $surfaceBrush.Dispose()
      $surfacePath.Dispose()
    }

    $lineBrush = New-GradientBrush `
      -Start ([System.Drawing.PointF]::new(11, 30)) `
      -End ([System.Drawing.PointF]::new(38, 15)) `
      -Colors ([System.Drawing.Color[]]@(
        [System.Drawing.ColorTranslator]::FromHtml('#ECFEFF'),
        [System.Drawing.ColorTranslator]::FromHtml('#BAE6FD')
      )) `
      -Positions ([single[]]@(0, 1))
    $linePen = [System.Drawing.Pen]::new($lineBrush, 4)
    try {
      $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $linePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      $graphics.DrawLines($linePen, [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(12, 32.5),
        [System.Drawing.PointF]::new(19, 25.5),
        [System.Drawing.PointF]::new(25, 28.5),
        [System.Drawing.PointF]::new(36, 16)
      ))
    } finally {
      $linePen.Dispose()
      $lineBrush.Dispose()
    }

    $tickColor = [System.Drawing.Color]::FromArgb(184, 223, 251, 255)
    $tickPen = [System.Drawing.Pen]::new($tickColor, 2)
    try {
      $tickPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $tickPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      foreach ($y in @(16.5, 22.5, 28.5)) {
        $graphics.DrawLine($tickPen, [single]12, [single]$y, [single]16.5, [single]$y)
      }
    } finally {
      $tickPen.Dispose()
    }

    $outerDotBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#ECFEFF'))
    $innerDotBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#0284C7'))
    try {
      $graphics.FillEllipse($outerDotBrush, [single]31.5, [single]11.5, [single]9, [single]9)
      $graphics.FillEllipse($innerDotBrush, [single]34, [single]14, [single]4, [single]4)
    } finally {
      $outerDotBrush.Dispose()
      $innerDotBrush.Dispose()
    }

    $detailColor = [System.Drawing.ColorTranslator]::FromHtml('#E0F2FE')
    foreach ($detail in @(
      @{ Alpha = 230; Width = 2.4; X1 = 31.5; Y1 = 33.5; X2 = 37; Y2 = 33.5 },
      @{ Alpha = 158; Width = 2.4; X1 = 33; Y1 = 37.5; X2 = 39; Y2 = 37.5 }
    )) {
      $color = [System.Drawing.Color]::FromArgb($detail.Alpha, $detailColor.R, $detailColor.G, $detailColor.B)
      $pen = [System.Drawing.Pen]::new($color, [single]$detail.Width)
      try {
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $graphics.DrawLine($pen, [single]$detail.X1, [single]$detail.Y1, [single]$detail.X2, [single]$detail.Y2)
      } finally {
        $pen.Dispose()
      }
    }

    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return $stream.ToArray()
  } finally {
    $stream.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$images = [System.Collections.Generic.List[byte[]]]::new()
foreach ($size in $sizes) {
  $images.Add((New-IconPngBytes -Size $size))
}

$parent = [System.IO.Path]::GetDirectoryName($resolvedOutput)
[System.IO.Directory]::CreateDirectory($parent) | Out-Null
$file = [System.IO.File]::Create($resolvedOutput)
$writer = [System.IO.BinaryWriter]::new($file)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$sizes.Count)

  $offset = 6 + (16 * $sizes.Count)
  for ($index = 0; $index -lt $sizes.Count; $index += 1) {
    $size = $sizes[$index]
    $image = $images[$index]
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$image.Length)
    $writer.Write([uint32]$offset)
    $offset += $image.Length
  }

  foreach ($image in $images) {
    $writer.Write($image)
  }
} finally {
  $writer.Dispose()
  $file.Dispose()
}

Write-Host "Generated Windows icon: $resolvedOutput ($($sizes -join ', ') px)"
