# Serves the HUKUM prototype over HTTP and opens it in the default browser.
# Usage: .\run.ps1 [-Port 8000] [-NoBrowser] [-Scan]
#   -Scan   opens HUKUM Scan (scan.html) instead of the building twin.
#   -Agents starts the LangGraph agent server (python -m agents.server), which
#           also serves every page, and opens agents.html. Set GROQ_API_KEY
#           (or agents/.env) to use GPT-OSS on Groq; without it the agents run
#           on their scripted offline fallback.
param(
    [int]$Port = 8000,
    [switch]$NoBrowser,
    [switch]$Scan,
    [switch]$Agents
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# Move to the next free port if the requested one is taken.
while (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Port $Port is in use, trying $($Port + 1)..."
    $Port++
}

$url = "http://localhost:$Port"
if ($Scan) { $url = "$url/scan.html" }
if ($Agents) { $url = "http://localhost:$Port/agents.html" }

# Pick a static server: Python first (as in the README), then Node's npx.
$python = $null
foreach ($name in 'python', 'py', 'python3') {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    # Skip the Windows Store "python" stub, which only opens the Store.
    if ($cmd -and $cmd.Source -notlike '*WindowsApps*') { $python = $cmd.Source; break }
}

if ($Agents) {
    if (-not $python) { Write-Error 'The agent server needs Python with: pip install -r agents/requirements.txt'; exit 1 }
    $env:PORT = "$Port"
    $exe = $python
    $serverArgs = @('-m', 'agents.server')
} elseif ($python) {
    $exe = $python
    $serverArgs = @('-m', 'http.server', $Port, '--bind', '127.0.0.1')
} elseif (Get-Command npx -ErrorAction SilentlyContinue) {
    $exe = 'npx'
    $serverArgs = @('--yes', 'http-server', '-p', $Port, '-a', '127.0.0.1', '-c-1')
} else {
    Write-Error 'Neither Python nor Node.js (npx) was found. Install one of them and try again.'
    exit 1
}

Write-Host "Serving HUKUM prototype at $url  (Ctrl+C to stop)"
Write-Host "  Twin: http://localhost:$Port/twin.html    Scan: http://localhost:$Port/scan.html    Agents: http://localhost:$Port/agents.html"

if (-not $NoBrowser) {
    # Open the browser shortly after the server starts.
    Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 1; Start-Process $u } -ArgumentList $url | Out-Null
}

& $exe @serverArgs
