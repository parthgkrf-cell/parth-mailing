@echo off
setlocal EnableExtensions
title Parth Mailing
cd /d "%~dp0."

echo.
echo Parth Mailing
echo Share this file by itself. It downloads the desk from GitHub, then opens it here.
echo Mailbox passwords stay on this computer. They are not stored on GitHub.
echo.

call :findpython
if not defined PY_EXE call :installpython
if not defined PY_EXE goto nopython

if exist "%~dp0backend\server.py" (
  set "APP=%~dp0"
  echo Using the desk folder next to this file.
  goto launch
)

if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"
set "APP=%LOCALAPPDATA%\ParthMailing\app"
echo Fetching the latest desk from GitHub...
findstr /b /c:"#PY " "%~f0" > "%TEMP%\parth_fetch_raw.txt"
if not exist "%TEMP%\parth_fetch_raw.txt" goto fetchfail
"%PY_EXE%" -c "from pathlib import Path; p=Path(r'%TEMP%\parth_fetch_raw.txt'); b=p.read_bytes(); raw=b.decode('utf-16') if b[:2] in (b'\xff\xfe', b'\xfe\xff') else b.decode('utf-8'); Path(r'%TEMP%\parth_fetch.py').write_text(''.join(line[4:] if line.startswith('#PY ') else line for line in raw.splitlines(True)), encoding='utf-8')"
if errorlevel 1 (
  echo Could not prepare the downloader.
  goto fetchfail
)
"%PY_EXE%" "%TEMP%\parth_fetch.py" "%APP%"
if errorlevel 1 (
  echo.
  echo The latest desk could not be downloaded.
  if exist "%APP%\backend\server.py" (
    echo Opening the desk already saved on this computer.
    goto launch
  )
  goto fetchfail
)
if not exist "%APP%\backend\server.py" goto fetchfail
if not exist "%APP%\frontend\index.html" goto fetchfail
echo Desk files are on this computer.
goto launch

:launch
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
if not exist "%APP%\backend\server.py" goto missing
cd /d "%APP%\backend"
if exist "%APP%\backend\launch_desk.py" goto runlauncher
"%PY_EXE%" -c "import urllib.request,sys; u=urllib.request.urlopen('http://127.0.0.1:8787/', timeout=3); sys.exit(0 if b'Parth Mailing' in u.read(8000) else 1)"
if not errorlevel 1 goto already
"%PY_EXE%" "%APP%\backend\server.py"
set "ERR=%ERRORLEVEL%"
goto started

:runlauncher
"%PY_EXE%" "%APP%\backend\launch_desk.py"
set "ERR=%ERRORLEVEL%"
goto started

:already
start "" "http://127.0.0.1:8787/"
set "ERR=2"
goto started

:started
echo.
if "%ERR%"=="2" (
  echo The desk is open. You can close this window.
) else if "%ERR%"=="0" (
  echo The desk stopped. Double-click this file again when you want it back.
) else (
  echo The desk did not start. Read the message above, then double-click this file again.
)
pause
exit /b %ERR%

:missing
echo.
echo The desk files are missing from:
echo %APP%
echo Double-click this file again when the internet is connected.
pause
exit /b 1

:fetchfail
echo.
echo The desk could not be downloaded from GitHub.
echo Check the internet connection, then double-click this file again.
pause
exit /b 1

:findpython
set "PY_EXE="
where py >nul 2>&1 && (
  for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do set "PY_EXE=%%P"
)
if not defined PY_EXE where python >nul 2>&1 && (
  for /f "delims=" %%P in ('python -c "import sys; print(sys.executable)" 2^>nul') do set "PY_EXE=%%P"
)
for %%V in (314 313 312 311 310) do (
  if not defined PY_EXE if exist "%LocalAppData%\Programs\Python\Python%%V\python.exe" set "PY_EXE=%LocalAppData%\Programs\Python\Python%%V\python.exe"
  if not defined PY_EXE if exist "%ProgramFiles%\Python%%V\python.exe" set "PY_EXE=%ProgramFiles%\Python%%V\python.exe"
)
exit /b 0

:installpython
echo Python was not found. Installing Python 3.12 for this Windows user...
where winget >nul 2>&1
if errorlevel 1 exit /b 0
winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
if exist "%LocalAppData%\Programs\Python\Python312\python.exe" set "PY_EXE=%LocalAppData%\Programs\Python\Python312\python.exe"
if not defined PY_EXE call :findpython
exit /b 0

:nopython
echo Python was not found.
echo Install Python 3.10 or newer from https://www.python.org/downloads/
echo Tick "Add python.exe to PATH", then double-click this file again.
pause
exit /b 1

goto :eof
---FETCH---
#PY import io
#PY import os
#PY import shutil
#PY import subprocess
#PY import sys
#PY import time
#PY import urllib.request
#PY import zipfile
#PY 
#PY DEST = os.path.abspath(sys.argv[1])
#PY URL = "https://github.com/parthgkrf-cell/parth-mailing/archive/refs/heads/main.zip"
#PY KEEP = (
#PY     os.path.normcase(os.path.normpath(os.path.join(DEST, "config", "config.json"))),
#PY     os.path.normcase(os.path.normpath(os.path.join(DEST, "config", "drive_service_account.json"))),
#PY )
#PY 
#PY def download():
#PY     last = "unknown error"
#PY     curl = shutil.which("curl") or shutil.which("curl.exe")
#PY     zip_path = os.path.join(os.environ.get("TEMP") or ".", "parth_mailing_main.zip")
#PY     if curl:
#PY         print("Downloading the desk from GitHub...", flush=True)
#PY         try:
#PY             subprocess.run(
#PY                 [curl, "-L", "--fail", "--retry", "3", "--retry-all-errors", "-A", "ParthMailing/1.0", "-o", zip_path, URL],
#PY                 check=True,
#PY             )
#PY             with open(zip_path, "rb") as handle:
#PY                 raw = handle.read()
#PY             if raw.startswith(b"PK"):
#PY                 return raw
#PY             last = "GitHub did not return the desk archive"
#PY         except Exception as exc:
#PY             last = str(exc)
#PY         print("Download attempt failed: %s" % last, flush=True)
#PY     for attempt in range(1, 4):
#PY         print("Downloading the desk from GitHub (try %s)..." % attempt, flush=True)
#PY         try:
#PY             request = urllib.request.Request(URL, headers={"User-Agent": "ParthMailing/1.0"})
#PY             with urllib.request.urlopen(request, timeout=180) as response:
#PY                 raw = response.read()
#PY             if raw.startswith(b"PK"):
#PY                 return raw
#PY             last = "GitHub did not return the desk archive"
#PY         except Exception as exc:
#PY             last = str(exc)
#PY         print("Download attempt failed: %s" % last, flush=True)
#PY         time.sleep(2)
#PY     print("Trying the Windows download...", flush=True)
#PY     env = os.environ.copy()
#PY     env["PARTH_ZIP_URL"] = URL
#PY     env["PARTH_ZIP_PATH"] = zip_path
#PY     command = (
#PY         "$ProgressPreference='SilentlyContinue'; "
#PY         "Invoke-WebRequest -Uri $env:PARTH_ZIP_URL -OutFile $env:PARTH_ZIP_PATH "
#PY         "-UseBasicParsing -Headers @{ 'User-Agent' = 'ParthMailing/1.0' }"
#PY     )
#PY     try:
#PY         subprocess.run(["powershell", "-NoProfile", "-Command", command], check=True, env=env)
#PY         with open(zip_path, "rb") as handle:
#PY             raw = handle.read()
#PY         if raw.startswith(b"PK"):
#PY             return raw
#PY         last = "Windows download was not the desk archive"
#PY     except Exception as exc:
#PY         last = str(exc)
#PY     print("GitHub download failed: %s" % last, flush=True)
#PY     return None
#PY 
#PY def main():
#PY     raw = download()
#PY     if not raw:
#PY         return 1
#PY     pack = zipfile.ZipFile(io.BytesIO(raw))
#PY     marker = "backend/server.py"
#PY     prefix = ""
#PY     for name in pack.namelist():
#PY         if name.endswith(marker):
#PY             prefix = name[: -len(marker)]
#PY             break
#PY     if not prefix:
#PY         print("The GitHub archive does not contain the desk.", flush=True)
#PY         return 1
#PY     os.makedirs(DEST, exist_ok=True)
#PY     dest_root = os.path.normcase(DEST)
#PY     for info in pack.infolist():
#PY         name = info.filename.replace("\\", "/")
#PY         if not name.startswith(prefix):
#PY             continue
#PY         rel = name[len(prefix):]
#PY         if not rel or rel.startswith("data/"):
#PY             continue
#PY         target = os.path.normpath(os.path.join(DEST, *rel.split("/")))
#PY         target_key = os.path.normcase(target)
#PY         if target_key != dest_root and not target_key.startswith(dest_root + os.sep):
#PY             continue
#PY         if target_key in KEEP and os.path.isfile(target):
#PY             continue
#PY         if info.is_dir() or rel.endswith("/"):
#PY             os.makedirs(target, exist_ok=True)
#PY             continue
#PY         os.makedirs(os.path.dirname(target), exist_ok=True)
#PY         try:
#PY             with pack.open(info) as src, open(target, "wb") as out:
#PY                 shutil.copyfileobj(src, out)
#PY         except OSError as exc:
#PY             print("Could not update %s: %s" % (rel, exc), flush=True)
#PY     server = os.path.join(DEST, "backend", "server.py")
#PY     page = os.path.join(DEST, "frontend", "index.html")
#PY     if not os.path.isfile(server) or not os.path.isfile(page):
#PY         print("The download is missing the desk files.", flush=True)
#PY         return 1
#PY     print("Desk files are ready.", flush=True)
#PY     return 0
#PY 
#PY if __name__ == "__main__":
#PY     raise SystemExit(main())
