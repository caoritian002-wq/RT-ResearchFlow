param(
  [string]$ArtifactDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$trackedFiles = @(& git -C $repoRoot ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to enumerate tracked files.'
}

$violations = [System.Collections.Generic.List[string]]::new()
$forbiddenTrackedPath = '(?i)(^|/)(node_modules|out|release|dist|build|coverage|test-results|playwright-report)(/|$)|(^|/)\.env(?:\.|$)|\.(?:db|sqlite|log|pem|pfx|p12|key)(?:-shm|-wal|\.bak)?$'

foreach ($relativePath in $trackedFiles) {
  $normalizedPath = $relativePath.Replace('\', '/')
  if ($normalizedPath -eq '.env.example') {
    continue
  }
  if ($normalizedPath -match $forbiddenTrackedPath) {
    $violations.Add("tracked forbidden path: $normalizedPath")
  }
}

$textExtensions = @(
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.nsh',
  '.ps1', '.svg', '.ts', '.tsx', '.txt', '.yaml', '.yml'
)
$privateLocalPathPattern = '(?i)(?:C:' + '\\Users\\' + 'Admin|E:' + '\\workspace|E:' + '\\open-source)'
$contentRules = @(
  @{ Label = 'private local path'; Pattern = $privateLocalPathPattern },
  @{ Label = 'private key material'; Pattern = '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----' },
  @{ Label = 'OpenAI or provider secret'; Pattern = '\bsk-[A-Za-z0-9_-]{20,}\b' },
  @{ Label = 'GitHub token'; Pattern = '\bgh[pousr]_[A-Za-z0-9_]{20,}\b' },
  @{ Label = 'AWS access key'; Pattern = '\bAKIA[0-9A-Z]{16}\b' }
)

foreach ($relativePath in $trackedFiles) {
  $fullPath = Join-Path $repoRoot $relativePath
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    continue
  }
  $extension = [System.IO.Path]::GetExtension($relativePath).ToLowerInvariant()
  if ($textExtensions -notcontains $extension -and [System.IO.Path]::GetFileName($relativePath) -ne 'LICENSE') {
    continue
  }
  if ((Get-Item -LiteralPath $fullPath).Length -gt 5MB) {
    continue
  }

  $content = [System.IO.File]::ReadAllText($fullPath)
  foreach ($rule in $contentRules) {
    if ([System.Text.RegularExpressions.Regex]::IsMatch($content, $rule.Pattern)) {
      $violations.Add("$($rule.Label): $relativePath")
    }
  }
}

if ($ArtifactDirectory) {
  $artifactRoot = if ([System.IO.Path]::IsPathRooted($ArtifactDirectory)) {
    $ArtifactDirectory
  } else {
    Join-Path $repoRoot $ArtifactDirectory
  }
  if (-not (Test-Path -LiteralPath $artifactRoot -PathType Container)) {
    throw "Artifact directory does not exist: $artifactRoot"
  }

  $forbiddenArtifactPath = '(?i)(^|[\\/])(?:\.env(?:\.|$)|[^\\/]+\.(?:db|sqlite|log|pem|pfx|p12|key)(?:-shm|-wal|\.bak)?$)'
  foreach ($file in Get-ChildItem -LiteralPath $artifactRoot -Recurse -File) {
    if ($file.FullName -match $forbiddenArtifactPath) {
      $violations.Add("forbidden packaged file: $($file.FullName)")
    }
  }
}

if ($violations.Count -gt 0) {
  throw "Public boundary check failed:`n$($violations -join "`n")"
}

Write-Host "Public boundary check passed: $($trackedFiles.Count) repository files inspected."
