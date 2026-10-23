Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "       Launching Parth Mailing Platform" -ForegroundColor Green
Write-Host "  Google Policy Compliant Email Scheduler & Drafts" -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Start Backend
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$scriptDir\backend'; node server.js"

# Start Frontend
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$scriptDir\frontend'; npm.cmd run dev"

Write-Host "Backend running on http://localhost:5000" -ForegroundColor Green
Write-Host "Frontend running on http://127.0.0.1:5173" -ForegroundColor Green
Write-Host "Sign in with the master account, then change that password." -ForegroundColor Magenta
Write-Host "========================================================" -ForegroundColor Cyan

