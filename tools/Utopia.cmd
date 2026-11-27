@echo off
rem Starts Utopia from your WHDLoad copy (see tools\launch-local.mjs). Keeps the window open if something fails.
cd /d "%~dp0.."
node tools\launch-local.mjs
if errorlevel 1 pause
