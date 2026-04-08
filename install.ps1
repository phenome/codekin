param(
  [string]$CodekinVersion = 'latest'
)

$ErrorActionPreference = 'Stop'
$MinNodeVersion = 20

function Write-Info($Message) {
  Write-Host "[codekin] $Message" -ForegroundColor Blue
}

function Write-Success($Message) {
  Write-Host "[codekin] $Message" -ForegroundColor Green
}

function Write-Warn($Message) {
  Write-Warning $Message
}

function Fail($Message) {
  Write-Host "[codekin] ERROR: $Message" -ForegroundColor Red
  exit 1
}

function Get-NodeMajorVersion {
  try {
    $version = (& node -p "process.versions.node.split('.')[0]").Trim()
    return [int]$version
  } catch {
    return 0
  }
}

function Ensure-Node {
  if ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-NodeMajorVersion) -ge $MinNodeVersion) {
    Write-Info "Node.js $(& node --version) found."
    return
  }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Fail "Node.js >=$MinNodeVersion is required. Install Node.js from https://nodejs.org or with winget, then re-run this installer."
  }

  Write-Info "Installing Node.js LTS with winget..."
  & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Host
  if ((Get-NodeMajorVersion) -lt $MinNodeVersion) {
    Fail "Node.js installation did not complete successfully. Open a new PowerShell window and re-run this installer."
  }
  Write-Info "Node.js $(& node --version) installed."
}

function Install-Codekin {
  if ($CodekinVersion -eq 'latest') {
    Write-Info 'Installing codekin (latest)...'
    & npm install -g codekin --loglevel=error | Out-Host
  } else {
    Write-Info "Installing codekin@$CodekinVersion..."
    & npm install -g "codekin@$CodekinVersion" --loglevel=error | Out-Host
  }

  if ($LASTEXITCODE -ne 0) {
    Fail 'Failed to install the codekin npm package.'
  }

  Write-Success "codekin $(& codekin --version 2>$null)"
}

function Check-Agents {
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Info "Claude Code CLI found ($(& claude --version 2>$null | Select-Object -First 1))."
  } else {
    Write-Warn 'Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code'
  }

  Write-Info 'Codex support is available through the bundled ACP adapter.'
  Write-Info 'Configure the Codex backend in Codekin after installation to use it.'
}

function Run-Setup {
  Write-Info 'Running initial setup...'
  & codekin setup | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Fail 'codekin setup failed.'
  }
}

function Install-Service {
  Write-Info 'Installing background service...'
  & codekin service install | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Fail 'codekin service install failed.'
  }
}

Write-Host ''
Write-Host '  Codekin Installer'
Write-Host '  ================='
Write-Host ''

Ensure-Node
Install-Codekin
Check-Agents
Run-Setup
Install-Service

Write-Host ''
Write-Success 'Installation complete!'
Write-Info "Run 'codekin token' at any time to get your access URL."
Write-Info "Run 'codekin service status' to check the service."
Write-Host ''
