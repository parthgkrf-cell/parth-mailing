#!/usr/bin/env python3
"""One-click starter. Ensures config exists and launches the relay."""

import os
import shutil
import subprocess
import sys


def project_root():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def main():
    root = project_root()
    if not getattr(sys, "frozen", False):
        server = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")
        os.execv(sys.executable, [sys.executable, server])

    relay = os.path.join(root, "relay_engine.exe")
    if not os.path.exists(relay):
        print("relay_engine.exe was not found next to Setup-Mailing-Agent.exe.")
        print("Run build_locked_binary.bat first, then keep both executables in the same folder.")
        input("Press Enter to close...")
        return 1

    config_dir = os.path.join(root, "config")
    os.makedirs(config_dir, exist_ok=True)
    target = os.path.join(config_dir, "config.json")
    if not os.path.exists(target):
        bundled = os.path.join(getattr(sys, "_MEIPASS", ""), "config", "config.example.json")
        sibling = os.path.join(config_dir, "config.example.json")
        source = sibling if os.path.exists(sibling) else bundled
        if os.path.exists(source):
            shutil.copy(source, target)
            print("Created", target)

    print("Starting the mailing relay...")
    return subprocess.call([relay])


if __name__ == "__main__":
    raise SystemExit(main())
