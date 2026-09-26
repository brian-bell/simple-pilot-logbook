# Stops and removes the SimplePilotLogbook Windows service (WinSW or the older
# pywin32 registration). Leaves agent\.env, agent\outbox.db and the logs alone.

$ErrorActionPreference = "Stop"

$ServiceName = "SimplePilotLogbook"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message"
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$wrapperExe = Join-Path $repoRoot "agent\service\$ServiceName.exe"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session (Run as Administrator)."
}

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Step "Service not installed"
    Write-Host "$ServiceName is not currently installed."
    exit 0
}

if ((Test-Path $wrapperExe) -and ($service.PathName -like "*$wrapperExe*")) {
    Write-Step "Stopping service"
    & $wrapperExe stop | Out-Null
    Write-Step "Removing service"
    & $wrapperExe uninstall
    if ($LASTEXITCODE -ne 0) { throw "WinSW uninstall failed with exit code $LASTEXITCODE." }
}
else {
    Write-Step "Stopping service ($($service.PathName))"
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Write-Step "Removing service"
    & sc.exe delete $ServiceName
    if ($LASTEXITCODE -ne 0) { throw "sc.exe delete failed with exit code $LASTEXITCODE." }
}

Write-Step "Done"
Write-Host "Removed service : $ServiceName"
