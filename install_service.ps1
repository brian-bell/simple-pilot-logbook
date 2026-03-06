param(
    [string]$PythonExe = ""
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
        [string[]]$Arguments
    )

    $fullArgs = @(Get-CommandTail -Command $Command)
    $fullArgs += $Arguments

    & $Command[0] @fullArgs
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repoRoot "backend"
$serviceScript = Join-Path $backendDir "windows_service.py"
$pythonCmd = Get-PythonCommand -Preferred $PythonExe
$pythonCmdDisplay = $pythonCmd -join " "

if (-not (Test-Path $serviceScript)) {
    throw "Service script not found: $serviceScript"
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session (Run as Administrator)."
}

Write-Step "Checking Python"
Invoke-PythonCommand -Command $pythonCmd -Arguments @("--version")

Write-Step "Installing backend dependencies"
Invoke-PythonCommand -Command $pythonCmd -Arguments @("-m", "pip", "install", "-r", (Join-Path $backendDir "requirements.txt"))

Write-Step "Installing pywin32 for Windows service support"
Invoke-PythonCommand -Command $pythonCmd -Arguments @("-m", "pip", "install", "pywin32")

Write-Step "Registering Windows service"
Invoke-PythonCommand -Command $pythonCmd -Arguments @($serviceScript, "--startup", "auto", "install")

Write-Step "Starting service"
Invoke-PythonCommand -Command $pythonCmd -Arguments @($serviceScript, "start")

Write-Step "Done"
Write-Host "Service name : SimplePilotLogbook"
Write-Host "App URL      : http://localhost:8080"
Write-Host "Remove later : $pythonCmdDisplay $serviceScript stop"
Write-Host "               $pythonCmdDisplay $serviceScript remove"
