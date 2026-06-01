$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root "dist"
$manifestPath = Join-Path $root "manifest.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$zipName = "useradmin-route-log-downloader-$($manifest.version).zip"
$zipPath = Join-Path $dist $zipName

$files = @(
  "manifest.json",
  "content.js",
  "worker.js",
  "styles.css",
  "README.md",
  "PRIVACY.md",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png"
)

New-Item -ItemType Directory -Force -Path $dist | Out-Null

$missing = $files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root $_)) }
if ($missing) {
  throw "Missing package files: $($missing -join ', ')"
}

$temp = Join-Path $dist "package"
$resolvedRoot = [System.IO.Path]::GetFullPath($root)
$resolvedDist = [System.IO.Path]::GetFullPath($dist)
$resolvedTemp = [System.IO.Path]::GetFullPath($temp)
if (-not $resolvedDist.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Package output directory must be inside the project root."
}
if (-not $resolvedTemp.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Temporary package directory must be inside the output directory."
}

Get-ChildItem -LiteralPath $dist -Filter "*.zip" -File | Remove-Item

if (Test-Path -LiteralPath $temp) {
  Remove-Item -LiteralPath $temp -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $temp | Out-Null

foreach ($file in $files) {
  $source = Join-Path $root $file
  $target = Join-Path $temp $file
  $targetDir = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  Copy-Item -LiteralPath $source -Destination $target
}

Compress-Archive -Path (Join-Path $temp "*") -DestinationPath $zipPath
Remove-Item -LiteralPath $temp -Recurse -Force
Write-Output $zipPath
