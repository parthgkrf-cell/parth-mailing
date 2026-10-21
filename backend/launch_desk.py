#!/usr/bin/env python3
"""Start the desk for Start-Mailing-Suite.bat.

Exit 0 after the relay stops, 2 when an existing desk was opened, 1 on failure.
"""

import os
import subprocess
import sys
import time
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def say(message):
    try:
        print(message, flush=True)
    except Exception:
        pass


def page_ok(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=3) as response:
            body = response.read(12000)
            return response.status == 200 and b"Parth Mailing" in body
    except Exception:
        return False


def listening_pids(port):
    try:
        out = subprocess.check_output(["netstat", "-ano", "-p", "tcp"], text=True, errors="replace")
    except (OSError, subprocess.CalledProcessError):
        return []
    found = []
    needle = f":{port}"
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[3].upper() != "LISTENING":
            continue
        local = parts[1]
        if local.endswith(needle):
            try:
                found.append(int(parts[4]))
            except ValueError:
                continue
    return found


def command_line(pid):
    script = f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine"
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command", script],
            text=True,
            errors="replace",
        )
    except (OSError, subprocess.CalledProcessError):
        return ""
    return out.strip()


def stop_broken_relay(port):
    pids = listening_pids(port)
    if not pids:
        return True
    for pid in pids:
        command = command_line(pid).lower()
        if "server.py" not in command and "launch_desk.py" not in command:
            say(f"Port {port} is already used by another program (pid {pid}).")
            say("Close that program, then double-click Start-Mailing-Suite.bat again.")
            return False
        say(f"Replacing a relay that is not answering (pid {pid}).")
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(20):
        if not listening_pids(port):
            return True
        time.sleep(0.25)
    say(f"Port {port} is still busy. Close the other Parth Mailing window and try again.")
    return False


def ensure_cryptography():
    try:
        import cryptography  # noqa: F401
        return
    except ImportError:
        pass
    say("Installing the mail helper used for Google Sheet access...")
    subprocess.run([sys.executable, "-m", "pip", "install", "cryptography>=42.0.0"], check=False)


def main():
    os.chdir(HERE)
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    if sys.version_info < (3, 10):
        say("Python 3.10 or newer is required.")
        say("Install it from https://www.python.org/downloads/ and tick Add python.exe to PATH.")
        return 1
    if not os.path.isfile(os.path.join(ROOT, "frontend", "index.html")):
        say("The desk page is missing.")
        say("Copy the whole Parth Mailing folder, not only the .bat file, then double-click it again.")
        return 1
    if not os.path.isfile(os.path.join(HERE, "server.py")):
        say("backend\\server.py is missing. Copy the whole Parth Mailing folder and try again.")
        return 1
    ensure_cryptography()
    import server

    config = server.ensure_config()
    port = int((config.get("server") or {}).get("port") or 8787)
    url = f"http://127.0.0.1:{port}/"
    if page_ok(port):
        if os.environ.get("PARTH_NO_BROWSER") != "1":
            webbrowser.open(url)
        say(f"The desk is already running at {url}")
        say("You can close this window. Leave the other Parth Mailing window open.")
        return 2
    if not stop_broken_relay(port):
        return 1
    say(f"Starting the desk at {url}")
    say("Leave this window open while you use the desk.")
    try:
        server.main()
    except KeyboardInterrupt:
        say("Relay stopping")
    except SystemExit as exc:
        code = exc.code
        return code if isinstance(code, int) else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
