# Black Hole Simulation — PowerShell launcher
$ErrorActionPreference = "Stop"
$PORT = 8000
$env:PORT = $PORT

Set-Location $PSScriptRoot

Write-Host "Black Hole Simulation" -ForegroundColor Cyan

$pythonExe = $null

if (Test-Path ".venv\Scripts\python.exe") {
    $pythonExe = ".venv\Scripts\python.exe"
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $pythonExe = "python"
} elseif (Test-Path "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe") {
    $pythonExe = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
}

if (-not $pythonExe) {
    Write-Error "Python 3.12+ not found. Install Python 3.12+."
    exit 1
}

Write-Host "Using Python: $pythonExe" -ForegroundColor Green

Write-Host ""
Write-Host "Starting server on http://localhost:$PORT" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

& $pythonExe main.py
