@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo  LiteAvatar - browser player
echo ============================================================
echo.
echo This starts a local web server on this machine and opens a
echo page in your browser where you can pick an avatar, choose an
echo audio file, and watch the generated video play back directly
echo - instead of running the command line tool and hunting for
echo the .mp4 it produces. Nothing is uploaded anywhere; the server
echo only listens on this computer (localhost).
echo.

REM ---------------------------------------------------------------
REM 0. Decide where the virtual environment will live.
REM    Several dependencies (openai-whisper, funasr, numba) build
REM    from source during "pip install", and their build scripts
REM    shell out to Python internally WITHOUT quoting the
REM    interpreter path - so if the venv's own path contains a
REM    space, those subprocess calls silently split at the space
REM    and fail deep inside a pip build step. This is a bug in
REM    those packages, not fixable from here - so instead of
REM    requiring you to keep this whole project on a space-free
REM    path, the venv is created in a fixed, guaranteed-space-free
REM    location on the system drive instead of inside this folder.
REM    Everything else (data, weights, output) still lives here.
REM ---------------------------------------------------------------
for %%A in ("%CD%") do set "PROJECT_NAME=%%~nxA"
set "PROJECT_NAME=%PROJECT_NAME: =_%"
set "VENV_DIR=%SystemDrive%\LiteAvatarApp\%PROJECT_NAME%\venv"

REM ---------------------------------------------------------------
REM 1. Find Python. numba (a pinned dependency) refuses to install
REM    on Python 3.13+, so hunt for a compatible version rather than
REM    trusting whatever "python" happens to resolve to.
REM ---------------------------------------------------------------
set PYTHON_CMD=
where py >nul 2>nul
if %errorlevel%==0 (
    for %%V in (3.10 3.11 3.12 3.9) do (
        if "!PYTHON_CMD!"=="" (
            py -%%V --version >nul 2>nul
            if !errorlevel!==0 (
                set PYTHON_CMD=py -%%V
                echo Found compatible Python %%V via the "py" launcher.
            )
        )
    )
)
if "%PYTHON_CMD%"=="" (
    echo.
    echo ERROR: No compatible Python installation found ^(need 3.9,
    echo 3.10, 3.11, or 3.12 - one of this project's pinned
    echo dependencies, numba, explicitly refuses to install on 3.13
    echo or newer^).
    echo.
    echo Install Python 3.10 from https://www.python.org/downloads/
    echo ^(check "Add python.exe to PATH" during installation^), then
    echo run this script again.
    pause
    exit /b 1
)

REM ---------------------------------------------------------------
REM 2. Create/reuse the virtual environment. If you already ran
REM    this script once, this reuses the same venv instead of
REM    installing everything again. Written with goto instead of
REM    nested if/else blocks on purpose - the body needs to run a
REM    python -c one-liner containing parentheses, and cmd.exe's
REM    block parser can misparse literal parentheses that appear
REM    inside an already-open ( ... ) block, even when quoted. Goto
REM    keeps each risky command at the top level, outside any block.
REM ---------------------------------------------------------------
if not exist "%VENV_DIR%\Scripts\python.exe" goto :create_venv

"%VENV_DIR%\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info < (3, 13) else 1)" >nul 2>nul
if !errorlevel! neq 0 goto :rebuild_venv
goto :venv_ready

:rebuild_venv
for /f "tokens=2" %%V in ('"%VENV_DIR%\Scripts\python.exe" --version 2^>^&1') do set VENV_PY_VER=%%V
echo.
echo Existing venv was built with Python !VENV_PY_VER!, which
echo is too new for this project - rebuilding it with a
echo compatible version instead.
rmdir /s /q "%VENV_DIR%"

:create_venv
echo.
echo Creating a virtual environment in %VENV_DIR% ...
mkdir "%VENV_DIR%" >nul 2>nul
%PYTHON_CMD% -m venv "%VENV_DIR%"
if errorlevel 1 (
    echo ERROR: Failed to create the virtual environment.
    pause
    exit /b 1
)

:venv_ready
call "%VENV_DIR%\Scripts\activate.bat"

REM ---------------------------------------------------------------
REM 2.4. Force the correct typeguard version even on an existing
REM    venv from before this fix. requirements.txt used to leave
REM    typeguard unpinned, which let pip install a too-new version
REM    that breaks funasr_local (bundled in this project) with
REM    "TypeCheckError: argument 'default' (None) is not an instance
REM    of str" - confirmed by an actual failure. This is a single
REM    small package, so it's cheap to always double-check rather
REM    than only fixing it for venvs created fresh after this point.
REM ---------------------------------------------------------------
python -m pip install "typeguard==2.13.3" >nul 2>nul

REM ---------------------------------------------------------------
REM 2.5. Same reasoning as 2.4 above, for edge-tts: it was added to
REM    requirements.txt after this project's venv-setup step already
REM    existed for anyone who'd run this before, so the "does this
REM    look like a fresh venv" check below never re-triggers a full
REM    install and edge-tts silently never gets installed - it's what
REM    powers the "Regenerate with edge-tts" button and the standalone
REM    scripts\generate_sample_audio.bat script, and without it both
REM    fail with "No module named 'edge_tts'". Cheap to always
REM    double-check, same as typeguard above.
REM ---------------------------------------------------------------
python -m pip install "edge-tts>=6.1,<8" >nul 2>nul

REM ---------------------------------------------------------------
REM 3. Install dependencies, only if this looks like a fresh venv
REM    (checked via the "fastapi" package, which the web app needs).
REM    Re-running pip install every launch "just to be safe" would
REM    make every click of app.cmd slow, so skip it once things are
REM    clearly already in place.
REM ---------------------------------------------------------------
"%VENV_DIR%\Scripts\python.exe" -c "import fastapi, torch, cv2" >nul 2>nul
if !errorlevel! neq 0 (
    echo.
    echo Installing compatible setuptools + wheel ^(fixes an openai-whisper build issue^)...
    python -m pip install "setuptools<81" wheel

    echo.
    echo Installing PyTorch ^(CPU-only build^) - this can take a few minutes...
    python -m pip install torch==2.9.0 torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cpu
    if !errorlevel! neq 0 (
        echo ERROR: Failed to install PyTorch.
        pause
        exit /b 1
    )

    echo.
    echo Installing the rest of the dependencies - this can take a while...
    python -m pip install -r requirements.txt --no-build-isolation
    if !errorlevel! neq 0 (
        echo ERROR: Failed to install dependencies. See the error above.
        pause
        exit /b 1
    )
) else (
    echo.
    echo Dependencies already installed - skipping.
    REM Still make sure packages added after your last setup (the web
    REM server itself) are present, without redoing the slow torch install.
    python -m pip install "python-multipart>=0.0.9,<1" "fastapi>=0.100,<1" "uvicorn>=0.23,<1" >nul 2>nul
)

REM ---------------------------------------------------------------
REM 4. Download model weights, if not already done.
REM ---------------------------------------------------------------
if not exist "weights\model_1.onnx" (
    echo.
    echo Downloading model weights ^(this is a real download, can
    echo take a while depending on your connection^)...
    call download_model.bat
    if !errorlevel! neq 0 (
        echo ERROR: Model download failed. See the error above.
        pause
        exit /b 1
    )
) else (
    echo.
    echo Model weights already present - skipping download.
)

REM ---------------------------------------------------------------
REM 5. (No extraction step needed here anymore - the bundled 2D avatar
REM    preload data ships pre-extracted under data\Avatars_2D\, and the
REM    210 3D avatar models ship pre-extracted under data\Avatars_3D\.)
REM ---------------------------------------------------------------

REM ---------------------------------------------------------------
REM 6. Start the web server and open the browser to it.
REM ---------------------------------------------------------------
echo.
echo ============================================================
echo  Starting LiteAvatar at http://localhost:8000
echo  Leave this window open while you're using it. Close it, or
echo  press Ctrl+C, when you're done.
echo ============================================================
echo.

REM Give the server a few seconds to actually start listening before
REM opening the browser tab, so it doesn't land on a connection error.
start "" /min cmd /c "timeout /t 3 >nul & start "" http://localhost:8000"
python server.py

pause
