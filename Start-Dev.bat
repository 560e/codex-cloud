@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 LTS, then reopen this window.
  goto failed
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 24 or newer is required.
  goto failed
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm is missing. Reinstall Node.js with npm.
  goto failed
)
if not exist "node_modules\.bin\tsx.cmd" (
  echo Dependencies missing. Run: npm ci --include=dev
  echo First setup: see docs\LOCAL.md
  goto failed
)
echo Open http://127.0.0.1:18473 after the server is ready.
echo Keep this window open. Press Ctrl+C to stop.
call npm.cmd run dev
set "launch_exit=%errorlevel%"
if not "%launch_exit%"=="0" pause
exit /b %launch_exit%
:failed
pause
exit /b 1
