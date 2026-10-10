@echo off
rem ── wa-mini-bot: instalación rápida ──
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js no esta instalado. Descargalo de https://nodejs.org y reintenta.
  pause
  exit /b 1
)
if not exist .env (
  echo [*] Creando .env desde .env.example
  copy .env.example .env >nul
)
echo [*] Instalando dependencias...
call npm install
echo.
echo [OK] Listo. Arranca con start.bat (o npm start)
pause