@echo off
rem Koyo map: vegetation GeoPackage -> public\data\koyoVegetation.json / .bin.gz
rem Double-click to run. Needs Node.js 22.13 or newer (the same Node used for the app).
chcp 65001 >nul
cd /d "%~dp0.."
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" scripts\build-koyo-vegetation.mjs %*
echo.
echo ---- finished (exit code %ERRORLEVEL%). Press any key to close. ----
pause >nul
