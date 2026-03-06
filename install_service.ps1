param(
    [string]$PythonCommand = ""
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message"
}

function Write-WarningLine {
    param([string]$Message)
    Write-Host "WARNING: $Message" -ForegroundColor Yellow
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

function Get-PythonStringResult {
    param(
        [string[]]$Command,
        [string]$Code
    )

    $fullArgs = @(Get-CommandTail -Command $Command)
    $fullArgs += @("-c", $Code)
    return (& $Command[0] @fullArgs)
}

function Invoke-Pywin32PostInstall {
    param([string[]]$Command)

    $moduleExitCode = Invoke-PythonCommand -Command $Command -Arguments @("-m", "pywin32_postinstall", "-install") -AllowFailure
    if ($moduleExitCode -eq 0) {
        return $true
    }

    $pythonCode = @"
import pathlib
import sysconfig

candidates = []
for key in ("scripts", "purelib", "platlib"):
    value = sysconfig.get_path(key)
    if not value:
        continue
    root = pathlib.Path(value)
    candidates.extend([
        root / "pywin32_postinstall.py",
        root / "pywin32_postinstall.pyw",
    ])

for candidate in candidates:
    if candidate.exists():
        print(candidate)
        break
else:
    raise SystemExit(1)
"@

    $scriptPath = Get-PythonStringResult -Command $Command -Code $pythonCode
    if (-not $scriptPath) {
        Write-WarningLine "pywin32 post-install entrypoint was not found. Continuing because the service can still run without it on some systems."
        return $false
    }

    $scriptPath = ($scriptPath | Select-Object -First 1).Trim()
    Write-Host "Using pywin32 post-install script: $scriptPath"
    Invoke-PythonCommand -Command $Command -Arguments @($scriptPath, "-install")
    return $true
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

Write-Step "Installing backend dependencies"
Invoke-PythonCommand -Command $pythonCmd -Arguments @("-m", "pip", "install", "-r", (Join-Path $backendDir "requirements.txt"))

Write-Step "Installing pywin32 for Windows service support"
Invoke-PythonCommand -Command $pythonCmd -Arguments @("-m", "pip", "install", "pywin32")

Write-Step "Running pywin32 post-install registration"
Invoke-Pywin32PostInstall -Command $pythonCmd | Out-Null

if ($serviceExists) {
    Write-Step "Updating existing Windows service"
    Invoke-PythonCommand -Command $pythonCmd -Arguments @($serviceScript, "update")
}
else {
    Write-Step "Registering Windows service"
    Invoke-PythonCommand -Command $pythonCmd -Arguments @($serviceScript, "--startup", "auto", "install")
}

Write-Step "Restarting service"
Invoke-PythonCommand -Command $pythonCmd -Arguments @($serviceScript, "restart")

Write-Step "Done"
Write-Host "Service name : SimplePilotLogbook"
Write-Host "App URL      : http://localhost:8080"
Write-Host "Service log  : $(Join-Path $backendDir 'service.log')"
Write-Host "Remove later : $pythonCmdDisplay $serviceScript stop"
Write-Host "               $pythonCmdDisplay $serviceScript remove"

