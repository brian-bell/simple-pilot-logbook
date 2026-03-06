param(
    [string]$PythonCommand = ""
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message"
}

function Get-CommandTail {
    param([string[]]$Command)

    if ($Command.Length -gt 1) {
        return $Command[1..($Command.Length - 1)]
    }

    return @()
}

function Test-PythonCommand {
    param([string[]]$Command)

    try {
        $tail = Get-CommandTail -Command $Command
        $null = & $Command[0] @tail --version 2>$null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

function Get-PythonCommand {
    param([string]$Preferred)

    if ($Preferred) {
        $candidate = @($Preferred)
        if (Test-PythonCommand -Command $candidate) {
            return $candidate
        }
        throw "The requested Python command '$Preferred' did not run successfully."
    }

    $candidates = @(
        @("python"),
        @("py", "-3")
    )

    foreach ($candidate in $candidates) {
        if (Test-PythonCommand -Command $candidate) {
            return $candidate
        }
    }

    throw "Python 3.11+ was not found. Install Python and rerun this script."
}

function Invoke-PythonCommand {
    param(
        [string[]]$Command,
        [string[]]$Arguments,
        [switch]$AllowFailure
    )

    $fullArgs = @(Get-CommandTail -Command $Command)
    $fullArgs += $Arguments

    & $Command[0] @fullArgs
    $exitCode = $LASTEXITCODE

    if (-not $AllowFailure -and $exitCode -ne 0) {
        throw "Python command failed with exit code ${exitCode}: $($Command -join ' ') $($Arguments -join ' ')"
    }

    return $exitCode
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repoRoot "backend"
$serviceScript = Join-Path $backendDir "windows_service.py"
$pythonCmd = Get-PythonCommand -Preferred $PythonCommand
$pythonCmdDisplay = $pythonCmd -join " "
$serviceExists = $null -ne (Get-Service -Name "SimplePilotLogbook" -ErrorAction SilentlyContinue)

if (-not (Test-Path $serviceScript)) {
    throw "Service script not found: $serviceScript"
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session (Run as Administrator)."
}

Write-Step "Checking Python"
Invoke-PythonCommand -Command $pythonCmd -Arguments @("--version")

if (-not $serviceExists) {
    Write-Step "Service not installed"
    Write-Host "SimplePilotLogbook is not currently installed."
    exit 0
}

Write-Step "Stopping service"
Invoke-PythonCommand -Command $pythonCmd -Arguments @($serviceScript, "stop") -AllowFailure | Out-Null

Write-Step "Removing service"
Invoke-PythonCommand -Command $pythonCmd -Arguments @($serviceScript, "remove")

Write-Step "Done"
Write-Host "Removed service : SimplePilotLogbook"
Write-Host "Command used    : $pythonCmdDisplay"

