@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

echo ============================================================
echo  Get 10 real human-voice sample clips (Mozilla Common Voice)
echo ============================================================
echo.
echo Downloads real, CC0-licensed (public domain) human voice clips
echo from Mozilla Common Voice via Hugging Face, and builds 10 new
echo sample_XX_*.wav files - 5 male, 5 female - to replace the
echo synthesized ones. Needs a normal internet connection.
echo.
echo This does NOT remove the old synthesized samples automatically -
echo delete sample_01..sample_10 from data\Audio\ yourself afterward
echo if you want only the real-voice ones left.
echo.
pause

for %%A in ("%CD%") do set "PROJECT_NAME=%%~nxA"
set "PROJECT_NAME=%PROJECT_NAME: =_%"
set "VENV_DIR=%SystemDrive%\LiteAvatarApp\%PROJECT_NAME%\venv"

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo ERROR: No virtual environment found at %VENV_DIR%
    echo Run app.cmd first - it sets up the environment this script reuses.
    pause
    exit /b 1
)

"%VENV_DIR%\Scripts\python.exe" -c "import datasets" >nul 2>nul
if errorlevel 1 (
    echo Installing datasets + soundfile...
    "%VENV_DIR%\Scripts\python.exe" -m pip install datasets soundfile
)

"%VENV_DIR%\Scripts\python.exe" scripts\generate_sample_audio_real_voices.py
set SCRIPT_EXIT=%errorlevel%

echo.
if %SCRIPT_EXIT% neq 0 (
    echo Failed - see the error above.
) else (
    echo Done - reload the app in your browser to see the new samples.
)
pause
