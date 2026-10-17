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
Write-Host "Frontend running on http://localhost:3000" -ForegroundColor Green
Write-Host "Master Login: master@parthmailing.com / MasterParth@2026" -ForegroundColor Magenta
Write-Host "========================================================" -ForegroundColor Cyan

