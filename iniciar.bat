@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  PlumaViva - iniciando (recuerde encender MySQL en XAMPP)
echo.
if not exist node_modules (
  echo Instalando dependencias...
  call npm install
  if errorlevel 1 ( echo No se pudo instalar. Revise su conexion a internet. & pause & exit /b 1 )
)
call npm run setup
if errorlevel 1 ( echo. & echo Corrija lo indicado arriba y vuelva a ejecutar. & pause & exit /b 1 )
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
call npm run dev
pause
