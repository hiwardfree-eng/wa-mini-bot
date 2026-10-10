@echo off
rem ── wa-mini-bot: arranque ──
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js no esta instalado.
  pause
  exit /b 1
)
if not exist node_modules (
  echo [*] Faltan dependencias. Corre install.bat primero.
  pause
  exit /b 1
)
echo Escanea el QR con WhatsApp si es la primera vez.
echo La sesion se guarda en auth/ para la proxima.
call npm start
pause