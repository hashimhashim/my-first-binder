"""Build a standalone app (no Python install needed on the target machine).

Run once on the OS you want the app for:

    pip install pyinstaller
    python build_app.py

Output lands in dist/ — "Image to VM Converter.exe" on Windows,
"Image to VM Converter.app" on macOS, a single binary on Linux.
"""

from __future__ import annotations

import os
import subprocess
import sys

NAME = "Image to VM Converter"
HERE = os.path.dirname(os.path.abspath(__file__))
ENTRY = os.path.join(HERE, "vmconvert", "__main__.py")


def main() -> int:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("PyInstaller is missing. Run:  pip install pyinstaller", file=sys.stderr)
        return 1

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--windowed",          # no console window behind the GUI
        "--name", NAME,
        "--paths", HERE,
        "--hidden-import", "vmconvert.gui",
        "--hidden-import", "vmconvert.cli",
        ENTRY,
    ]
    if sys.platform == "darwin":
        cmd += ["--osx-bundle-identifier", "com.local.vmconvert"]

    print("Running:", " ".join(cmd))
    result = subprocess.run(cmd, cwd=HERE)
    if result.returncode == 0:
        print(f"\nBuilt. Look in {os.path.join(HERE, 'dist')}")
        print("qemu-img still needs to be installed on the machine that runs it.")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
