@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

echo ============================================================
echo  Regenerate sample audio (natural neural voices)
echo ============================================================
echo.
echo This replaces the 10 clips in data\Audio\ with new ones spoken
echo by Microsoft's free neural TTS voices ^(5 male, 5 female,
echo genuinely natural-sounding, not robotic^) instead of the
echo original espeak-ng voice. Needs a normal internet connection -
echo it calls out to Microsoft's TTS service.
echo.

REM Same venv location app.cmd itself uses - this script assumes
REM you've already run app.cmd at least once, so edge-tts (in
REM requirements.txt) is already installed there.
for %%A in ("%CD%") do set "PROJECT_NAME=%%~nxA"
set "PROJECT_NAME=%PROJECT_NAME: =_%"
set "VENV_DIR=%SystemDrive%\LiteAvatarApp\%PROJECT_NAME%\venv"

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo ERROR: No virtual environment found at %VENV_DIR%
    echo Run app.cmd first - it sets up the environment this script
    echo reuses, including installing edge-tts.
    pause
    exit /b 1
)

"%VENV_DIR%\Scripts\python.exe" -c "import edge_tts" >nul 2>nul
if errorlevel 1 (
    echo Installing edge-tts...
    "%VENV_DIR%\Scripts\python.exe" -m pip install "edge-tts>=6.1,<8"
)

"%VENV_DIR%\Scripts\python.exe" scripts\generate_sample_audio.py
set SCRIPT_EXIT=%errorlevel%

echo.
if %SCRIPT_EXIT% neq 0 (
    echo Generation failed - see the error above.
) else (
    echo Done - reload the app in your browser to see the new samples.
)
pause
