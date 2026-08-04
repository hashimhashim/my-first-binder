#!/bin/sh
# Double-click this file on macOS (or run it on Linux) to open the converter.
cd "$(dirname "$0")" || exit 1

for py in python3 python; do
    if command -v "$py" >/dev/null 2>&1; then
        "$py" -m vmconvert
        exit $?
    fi
done

echo ""
echo "Python 3 is not installed."
echo "macOS: install it from https://www.python.org/downloads/"
echo "Linux: sudo apt install python3 python3-tk"
echo ""
read -r _ </dev/tty
exit 1
