# Hoshmand Photo Studio - local server for Windows without Node.js or Python.
# Uses the built-in .NET HttpListener. Listens on 127.0.0.1 only.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File server\serve.ps1
param([int]$Port = 8787, [switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$AllowedFiles = @('index.html', 'sw.js', 'manifest.webmanifest', 'favicon.ico')
$AllowedDirs = @('app', 'vendor', 'models', 'icons', 'docs')
$Mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8';
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json';
  '.wasm' = 'application/wasm'; '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon';
  '.woff2' = 'font/woff2'; '.txt' = 'text/plain; charset=utf-8'; '.md' = 'text/markdown; charset=utf-8';
  '.task' = 'application/octet-stream'; '.tflite' = 'application/octet-stream'; '.onnx' = 'application/octet-stream'
}

$listener = $null
for ($i = 0; $i -lt 20; $i++) {
  try {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://127.0.0.1:$($Port + $i)/")
    $listener.Start()
    $Port = $Port + $i
    break
  } catch { $listener = $null }
}
if (-not $listener) { Write-Host 'Error: no free port found.'; exit 1 }

$url = "http://127.0.0.1:$Port/"
Write-Host "Hoshmand Photo Studio is running (this computer only): $url"
Write-Host 'Close this window to stop the server.'
if (-not $NoOpen) { Start-Process $url }

function Resolve-Safe([string]$rawPath) {
  try { $rel = [System.Uri]::UnescapeDataString($rawPath.Split('?')[0]) } catch { return $null }
  if ($rel.Contains([char]0)) { return $null }
  $rel = $rel.TrimStart('/')
  if ($rel -eq '') { $rel = 'index.html' }
  if ($rel.Contains('..') -or $rel.Contains('\') -or $rel.Contains(':')) { return $null }
  $first = $rel.Split('/')[0]
  if (-not (($AllowedFiles -contains $rel) -or (($AllowedDirs -contains $first) -and $rel.Contains('/')))) { return $null }
  $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))
  if (-not $full.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar)) { return $null }
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return $null }
  return $full
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request; $res = $ctx.Response
    $res.Headers.Add('Cross-Origin-Opener-Policy', 'same-origin')
    $res.Headers.Add('Cross-Origin-Embedder-Policy', 'require-corp')
    $res.Headers.Add('Cross-Origin-Resource-Policy', 'same-origin')
    $res.Headers.Add('X-Content-Type-Options', 'nosniff')
    try {
      if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') { $res.StatusCode = 405; $res.Close(); continue }
      $file = Resolve-Safe $req.Url.AbsolutePath
      if (-not $file) { $res.StatusCode = 404; $res.Close(); continue }
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $res.ContentType = if ($Mime.ContainsKey($ext)) { $Mime[$ext] } else { 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $res.ContentLength64 = $bytes.Length
      if ($req.HttpMethod -eq 'GET') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
      $res.Close()
    } catch { try { $res.StatusCode = 500; $res.Close() } catch {} }
  }
} finally { $listener.Stop() }
