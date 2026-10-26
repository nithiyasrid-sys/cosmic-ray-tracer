@echo off
setlocal

REM Black Hole Simulation — Windows launcher
set PORT=8000

cd /d "%~dp0"

REM Check for virtual environment first
if exist ".venv\Scripts\python.exe" (
    set "PYTHON_EXE=.venv\Scripts\python.exe"
    goto :start
)

REM Check python command
python --version >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_EXE=python"
    goto :check_deps
)

REM Check py launcher
py -3.12 --version >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_EXE=py -3.12"
    goto :check_deps
)

REM Check default install location
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    goto :check_deps
)

echo ERROR: Python 3.12+ not found. Please install Python 3.12+.
pause
exit /b 1

:check_deps
echo Checking dependencies...
%PYTHON_EXE% -m pip install -r requirements.txt --quiet

:start
echo.
echo Starting Black Hole Simulation on http://localhost:%PORT%
echo Press Ctrl+C to stop.
echo.

%PYTHON_EXE% main.py

pause
