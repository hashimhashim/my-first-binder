"""Entry point.

No arguments (the double-click case) opens the window; anything else is CLI.
"""

import sys


def _run_gui() -> int:
    try:
        from .gui import main as gui_main
    except ImportError:  # Tkinter missing — say so in plain language
        print(
            "The graphical window needs Tkinter, which is not installed with this Python.\n"
            "  Debian/Ubuntu: sudo apt install python3-tk\n"
            "  Fedora:        sudo dnf install python3-tkinter\n"
            "  macOS/Windows: install Python from python.org (Tkinter is included)\n"
            "\nYou can still use the command line, e.g.:\n"
            "  python3 -m vmconvert convert disk.vhd -t vmdk",
            file=sys.stderr,
        )
        return 1
    return gui_main()


def main() -> int:
    if len(sys.argv) <= 1 or sys.argv[1] == "gui":
        return _run_gui()
    from .cli import main as cli_main

    return cli_main()


if __name__ == "__main__":
    raise SystemExit(main())
