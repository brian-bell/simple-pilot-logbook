param(
    [string]$NodeCommand = ""
)

# Installs or updates the SimplePilotLogbook Windows service.
# The agent is a Node.js app (agent/dist/main.js) hosted by WinSW, a small
# service wrapper downloaded on first install and verified by SHA-256.
# Replaces the older pywin32 (Python) service registration if one exists.

$ErrorActionPreference = "Stop"

$ServiceName = "SimplePilotLogbook"
$MinNodeVersion = [version]"22.13.0"
$WinSWUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
$WinSWSha256 = "05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message"
}

function Invoke-Checked {
    param([string]$Exe, [string[]]$Arguments)
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Exe $($Arguments -join ' ')"
    }
}

function Get-NodeExe {
    param([string]$Preferred)
    if ($Preferred) {
        $cmd = Get-Command $Preferred -ErrorAction SilentlyContinue
        if (-not $cmd) { throw "The requested Node command '$Preferred' was not found." }
        return $cmd.Source
    }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "Node.js was not found. Install Node.js $MinNodeVersion or newer (https://nodejs.org/) and rerun this script." }
    return $cmd.Source
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentDir = Join-Path $repoRoot "agent"
$serviceDir = Join-Path $agentDir "service"
$wrapperExe = Join-Path $serviceDir "$ServiceName.exe"
$wrapperXml = Join-Path $serviceDir "$ServiceName.xml"
$template = Join-Path $serviceDir "$ServiceName.xml.template"
$envFile = Join-Path $agentDir ".env"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session (Run as Administrator)."
}

if (-not (Test-Path $envFile)) {
    throw "agent\.env not found. Copy agent\.env.example to agent\.env and set WORKER_URL and AGENT_TOKEN first (see docs\cloud-deploy.md)."
}
if (-not (Test-Path $template)) {
    throw "Service template not found: $template"
}

$workerUrl = Get-Content $envFile |
    Where-Object { $_ -match '^\s*WORKER_URL\s*=' } |
    Select-Object -First 1
if ($workerUrl) {
    $workerUrl = ($workerUrl -replace '^\s*WORKER_URL\s*=\s*', '').Trim().Trim('"', "'")
}

Write-Step "Checking Node.js"
$nodeExe = Get-NodeExe -Preferred $NodeCommand
$nodeVersion = [version](& $nodeExe -p "process.versions.node")
Write-Host "Node $nodeVersion at $nodeExe"
if ($nodeVersion -lt $MinNodeVersion) {
    throw "Node.js $MinNodeVersion or newer is required (found $nodeVersion)."
}
$npmCmd = Join-Path (Split-Path -Parent $nodeExe) "npm.cmd"
if (-not (Test-Path $npmCmd)) {
    $npmCmd = (Get-Command npm.cmd -ErrorAction Stop).Source
}

Write-Step "Installing agent dependencies and building"
Push-Location $agentDir
try {
    Invoke-Checked -Exe $npmCmd -Arguments @("ci", "--no-audit", "--no-fund")
    Invoke-Checked -Exe $npmCmd -Arguments @("run", "build")
}
finally {
    Pop-Location
}

Write-Step "Checking for an older service registration"
$existing = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if ($existing -and ($existing.PathName -notlike "*$wrapperExe*")) {
    Write-Host "Removing the previous registration ($($existing.PathName))."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $ServiceName | Out-Null
    for ($i = 0; $i -lt 20 -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue); $i++) {
        Start-Sleep -Milliseconds 500
    }
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        throw "The old $ServiceName service is still registered (it may be open in services.msc). Close it and rerun."
    }
    $existing = $null
}
elseif (-not $existing) {
    Write-Host "No existing service."
}

Write-Step "Preparing the service wrapper (WinSW)"
if (-not (Test-Path $wrapperExe)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $download = Join-Path $env:TEMP "WinSW-x64-$([guid]::NewGuid()).exe"
    Write-Host "Downloading $WinSWUrl"
    Invoke-WebRequest -Uri $WinSWUrl -OutFile $download -UseBasicParsing
    $hash = (Get-FileHash -Path $download -Algorithm SHA256).Hash
    if ($hash -ne $WinSWSha256) {
        Remove-Item $download -Force
        throw "WinSW download failed verification (SHA-256 $hash, expected $WinSWSha256)."
    }
    Move-Item -Path $download -Destination $wrapperExe -Force
}
else {
    $hash = (Get-FileHash -Path $wrapperExe -Algorithm SHA256).Hash
    if ($hash -ne $WinSWSha256) {
        throw "$wrapperExe does not match the pinned WinSW 2.12.0 hash. Delete it and rerun this script."
    }
}
Write-Host "WinSW 2.12.0 verified."

Write-Step "Writing service configuration"
$xml = Get-Content -Path $template -Raw
$xml = $xml.Replace("__NODE_EXE__", [System.Security.SecurityElement]::Escape($nodeExe))
$xml = $xml.Replace("__AGENT_DIR__", [System.Security.SecurityElement]::Escape($agentDir))
Set-Content -Path $wrapperXml -Value $xml -Encoding UTF8
Write-Host $wrapperXml

if ($existing) {
    Write-Step "Updating the existing service"
    & $wrapperExe stop | Out-Null
    Invoke-Checked -Exe $wrapperExe -Arguments @("refresh")
}
else {
    Write-Step "Registering the service"
    Invoke-Checked -Exe $wrapperExe -Arguments @("install")
}

Write-Step "Starting the service"
Invoke-Checked -Exe $wrapperExe -Arguments @("start")
Start-Sleep -Seconds 2
Get-Service -Name $ServiceName | Format-Table -AutoSize Name, Status, StartType

Write-Step "Done"
Write-Host "Service name : $ServiceName"
if ($workerUrl) {
    Write-Host "Logbook URL  : $workerUrl"
}
Write-Host "Agent log    : $(Join-Path $agentDir 'agent.log')"
Write-Host "Service logs : $serviceDir (wrapper, stdout, stderr)"
Write-Host "Remove later : .\uninstall_service.ps1"
