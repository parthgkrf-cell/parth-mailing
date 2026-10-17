@echo off
setlocal
cd /d "%~dp0"

echo Installing packager and Drive signing library...
python -m pip install -r requirements.txt
if errorlevel 1 goto :fail

echo Building relay_engine.exe ...
python -m PyInstaller --noconfirm --clean --onefile --name relay_engine ^
  --add-data "..\frontend;frontend" ^
  --add-data "..\config;config" ^
  --hidden-import cryptography ^
  --hidden-import cryptography.hazmat.primitives.asymmetric.padding ^
  --hidden-import cryptography.hazmat.primitives.serialization ^
  server.py
if errorlevel 1 goto :fail

echo Building Setup-Mailing-Agent.exe ...
python -m PyInstaller --noconfirm --clean --onefile --name Setup-Mailing-Agent ^
  --add-data "..\config;config" ^
  setup_agent.py
if errorlevel 1 goto :fail

if not exist "dist\config" mkdir "dist\config"
copy /Y "..\config\config.example.json" "dist\config\config.example.json" >nul
copy /Y "..\config\drive_service_account.example.json" "dist\config\drive_service_account.example.json" >nul

echo.
echo Built:
echo   %cd%\dist\relay_engine.exe
echo   %cd%\dist\Setup-Mailing-Agent.exe
echo.
echo Give users the dist folder. They run Setup-Mailing-Agent.exe, edit dist\config\config.json,
echo and open the browser page the relay prints. Source stays with you; the exe is the runtime.
echo.
echo Optional code signing, only when you already have a certificate:
echo   signtool sign /fd SHA256 /a dist\relay_engine.exe
echo   signtool sign /fd SHA256 /a dist\Setup-Mailing-Agent.exe
goto :eof

:fail
echo Build failed.
exit /b 1
