@echo off
title Parth Mailing Launcher
echo ========================================================
echo         Launching Parth Mailing Platform
echo    Google Policy Compliant Email Scheduler & Drafts
echo ========================================================
echo.

echo [1/2] Starting Backend Server (Port 5000)...
start "Parth Mailing Backend" cmd /k "cd /d %~dp0backend && node server.js"

echo [2/2] Starting Frontend WebApp (Port 5173)...
start "Parth Mailing Frontend" cmd /k "cd /d %~dp0frontend && npm.cmd run dev"

echo.
echo ========================================================
echo Backend:  http://localhost:5000
echo Frontend: http://127.0.0.1:5173
echo.
echo Sign in with the master account, then change that password.
echo ========================================================
pause

