# Pairwave one-line installer (Windows PowerShell 5.1+ / pwsh)
#
#   Person A:  iex "& { $(iwr -useb https://raw.githubusercontent.com/goofypluto999/pairwave/main/scripts/install.ps1) } init"
#   Person B:  iex "& { $(iwr -useb https://raw.githubusercontent.com/goofypluto999/pairwave/main/scripts/install.ps1) } join <invite-code>"
#
# What it does (and nothing else): checks git+node, clones/updates Pairwave into
# %LOCALAPPDATA%\pairwave\app, builds it, installs a global `pairwave` command, then wires THE
# FOLDER YOU RAN IT FROM (config + Claude Code MCP entry + /pairwave skill) and prints next steps.
param([string]$Command = "init", [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)

$ErrorActionPreference = "Stop"
function Fail($msg) { Write-Host "  [pairwave] $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "  [pairwave] $msg" -ForegroundColor Cyan }

# 1. prerequisites
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git is required — install from https://git-scm.com" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js 20+ is required — install from https://nodejs.org" }
$nodeMajor = [int]((node -v).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) { Fail "Node 20+ required (you have $(node -v))" }

# 2. clone or update the app (kept out of your project; your project only gets .pairwave/ config)
$repo = if ($env:PAIRWAVE_REPO) { $env:PAIRWAVE_REPO } else { "https://github.com/goofypluto999/pairwave.git" }
$app = Join-Path $env:LOCALAPPDATA "pairwave\app"
$projectDir = (Get-Location).Path
if (Test-Path (Join-Path $app ".git")) {
  Step "updating Pairwave in $app"
  git -C $app pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { Fail "git pull failed in $app" }
} else {
  Step "installing Pairwave into $app"
  New-Item -ItemType Directory -Force -Path (Split-Path $app) | Out-Null
  git clone --quiet $repo $app
  if ($LASTEXITCODE -ne 0) { Fail "git clone failed ($repo)" }
}

# 3. build (npm output suppressed unless it fails)
Step "building (first run takes ~30s)…"
Push-Location $app
try {
  $log = npm install --no-audit --no-fund 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host $log; Fail "npm install failed" }
  $log = npm run build 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host $log; Fail "build failed" }

  # Some machines (AV/folder-protection policies) break npm's workspace junctions. Probe one; if it
  # doesn't resolve, replace the links with real copies — node then resolves them like any package.
  node -e "process.exit(require('fs').existsSync('node_modules/@pairwave/protocol/package.json')?0:1)" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Step "workspace links unavailable on this machine — using copies instead"
    Remove-Item "node_modules\@pairwave" -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path "node_modules\@pairwave" | Out-Null
    foreach ($p in "protocol", "companion", "relay") {
      Copy-Item "packages\$p" "node_modules\@pairwave\$p" -Recurse -Force
    }
  }
} finally { Pop-Location }

# 4. global `pairwave` command (shim in npm's global bin — already on your PATH)
$npmBin = (npm prefix -g).Trim()
$cliEntry = Join-Path $app "packages\cli\dist\index.js"
Set-Content -Path (Join-Path $npmBin "pairwave.cmd") -Value "@node `"$cliEntry`" %*" -Encoding ascii
Step "installed global command: pairwave"

# 5. wire THIS project (the folder you ran the line from)
Set-Location $projectDir
$cliArgs = @($Command) + ($Rest | Where-Object { $_ })
node $cliEntry @cliArgs
if ($LASTEXITCODE -ne 0) { Fail "setup command failed" }

Write-Host ""
Step "done. Open Claude Code in this folder, approve the 'pairwave' MCP server, type /pairwave"
Step "later: pairwave status | pairwave relay | pairwave join <code>"
