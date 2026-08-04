@echo off
REM Double-click this file on Windows to open the converter.
cd /d "%~dp0"

where py >nul 2>&1
if %errorlevel%==0 (
    py -3 -m vmconvert
    goto :end
)

where python >nul 2>&1
if %errorlevel%==0 (
    python -m vmconvert
    goto :end
)

echo.
echo Python is not installed.
echo Install it from https://www.python.org/downloads/ and tick
echo "Add python.exe to PATH" during setup, then run this file again.
echo.
pause

:end
if %errorlevel% neq 0 pause
