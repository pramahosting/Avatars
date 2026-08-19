@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

if "%1"=="" (
    echo Usage: tag_avatars_2d.bat export    - scan avatars, write CSV + contact sheet
    echo    or: tag_avatars_2d.bat apply     - apply your edited CSV back to meta.json files
    pause
    exit /b 1
)

for %%A in ("%CD%") do set "PROJECT_NAME=%%~nxA"
set "PROJECT_NAME=%PROJECT_NAME: =_%"
set "VENV_DIR=%SystemDrive%\LiteAvatarApp\%PROJECT_NAME%\venv"

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo ERROR: No virtual environment found at %VENV_DIR%
    echo Run app.cmd first - it sets up the environment this script reuses.
    pause
    exit /b 1
)

"%VENV_DIR%\Scripts\python.exe" scripts\tag_avatars_2d.py %1

echo.
pause
