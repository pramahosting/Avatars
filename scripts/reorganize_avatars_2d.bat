@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo  Reorganize downloaded LiteAvatarGallery folders
echo ============================================================
echo.
echo This extracts each zip file in:
echo   data\Avatars_2D\20250408\
echo   data\Avatars_2D\20250612\
echo and moves the extracted content up into data\Avatars_2D\ as
echo avatar_03, avatar_04, and so on - continuing from whatever
echo avatar_NN folders already exist there. The original zip files
echo are never deleted or modified.
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reorganize_avatars_2d.ps1"

echo.
pause
