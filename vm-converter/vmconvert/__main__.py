import sys

from .cli import main

if __name__ == "__main__":
    # `python -m vmconvert gui` opens the window; anything else is CLI.
    if len(sys.argv) > 1 and sys.argv[1] == "gui":
        from .gui import main as gui_main

        raise SystemExit(gui_main())
    raise SystemExit(main())
