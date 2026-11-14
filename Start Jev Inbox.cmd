@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js LTS from https://nodejs.org/en/download, then open this file again.
  pause
  exit /b 1
)
node scripts\start.mjs --open
if errorlevel 1 pause

