@echo off
rem Visible launcher for troubleshooting. Double-click this file to start the app
rem with a console window so every step can be seen. Also writes launcher\launcher.log.
chcp 65001 >nul
cd /d "%~dp0.."
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
echo Starting the app (this window shows progress)...
echo node: %NODE_EXE%
"%NODE_EXE%" "%~dp0start-app.mjs"
echo.
echo Exit code: %ERRORLEVEL%
echo Log file: %~dp0launcher.log
pause
