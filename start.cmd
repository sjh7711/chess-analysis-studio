@echo off
setlocal
cd /d "%~dp0"
set "CHESS_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "CHESS_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "node_modules\chess.js\dist\esm\chess.js" (
  echo Dependencies are missing. Run: npm install --ignore-scripts
  pause
  exit /b 1
)
"%CHESS_NODE%" server.mjs --open
if errorlevel 1 pause
