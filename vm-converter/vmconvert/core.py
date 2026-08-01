"""Core conversion logic: wraps qemu-img to turn disk images into VM disks."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Callable, Iterable

# Output formats a hypervisor can boot from, keyed by the value passed to
# `qemu-img convert -O`.
TARGETS: dict[str, dict] = {
    "vmdk": {
        "label": "VMware (.vmdk)",
        "ext": ".vmdk",
        # monolithicSparse imports everywhere; streamOptimized is the OVA/OVF flavour.
        "subformats": ["monolithicSparse", "streamOptimized", "monolithicFlat", "twoGbMaxExtentSparse"],
        "default_subformat": "monolithicSparse",
    },
    "vhdx": {
        "label": "Hyper-V (.vhdx)",
        "ext": ".vhdx",
        "subformats": [],
        "default_subformat": None,
    },
    "vpc": {
        "label": "Hyper-V legacy / Azure (.vhd)",
        "ext": ".vhd",
        "subformats": ["dynamic", "fixed"],
        "default_subformat": "dynamic",
    },
    "vdi": {
        "label": "VirtualBox (.vdi)",
        "ext": ".vdi",
        "subformats": [],
        "default_subformat": None,
    },
    "qcow2": {
        "label": "KVM/QEMU/Proxmox (.qcow2)",
        "ext": ".qcow2",
        "subformats": [],
        "default_subformat": None,
    },
    "raw": {
        "label": "Raw image (.img)",
        "ext": ".img",
        "subformats": [],
        "default_subformat": None,
    },
}

# Extensions qemu-img cannot read directly — they need a vendor tool first.
PROPRIETARY_HINTS: dict[str, str] = {
    ".tib": (
        "Acronis .tib/.tibx backups are a proprietary format that qemu-img cannot read.\n"
        "Convert in two steps:\n"
        "  1. Acronis True Image -> Tools & Utilities -> Mount Image, pick the backup,\n"
        "     then export the mounted disk to a .vhd (Acronis 'Convert to VHD' does this too).\n"
        "  2. Feed that .vhd back into this app to get .vmdk/.vhdx/.vdi/.qcow2.\n"
        "If Acronis reports 'backup archive file is corrupted', mount the image read-only\n"
        "and copy off the intact data first — a corrupted archive cannot be converted whole."
    ),
    ".tibx": None,  # filled in below
    ".spf": "Macrium Reflect .mrimg/.spf images must be restored or mounted by Macrium first.",
    ".mrimg": "Macrium Reflect .mrimg images must be restored or mounted by Macrium first.",
    ".spi": "ShadowProtect .spf/.spi images must be mounted by ShadowProtect first.",
    ".v2i": "Veritas/Symantec .v2i images must be mounted by System Recovery first.",
}
PROPRIETARY_HINTS[".tibx"] = PROPRIETARY_HINTS[".tib"]


class ConversionError(RuntimeError):
    """Raised for anything that stops a conversion before or during the run."""


@dataclass
class SourceInfo:
    path: str
    fmt: str
    virtual_size: int
    actual_size: int
    raw: dict = field(default_factory=dict)

    @property
    def virtual_size_h(self) -> str:
        return human_size(self.virtual_size)

    @property
    def actual_size_h(self) -> str:
        return human_size(self.actual_size)


def human_size(num: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(num) < 1024 or unit == "TiB":
            return f"{num:.1f} {unit}" if unit != "B" else f"{int(num)} B"
        num /= 1024
    return f"{num:.1f} TiB"


def qemu_img() -> str:
    """Locate qemu-img, or explain how to install it."""
    exe = shutil.which("qemu-img") or shutil.which("qemu-img.exe")
    if exe:
        return exe
    raise ConversionError(
        "qemu-img not found on PATH. Install it:\n"
        "  macOS:          brew install qemu\n"
        "  Debian/Ubuntu:  sudo apt install qemu-utils\n"
        "  Fedora/RHEL:    sudo dnf install qemu-img\n"
        "  Windows:        https://qemu.weilnetz.de/w64/ (add the install dir to PATH)"
    )


def check_source(path: str) -> None:
    """Fail early with a useful message for missing or vendor-locked sources."""
    if not os.path.isfile(path):
        raise ConversionError(f"Source image not found: {path}")
    hint = PROPRIETARY_HINTS.get(os.path.splitext(path)[1].lower())
    if hint:
        raise ConversionError(hint)


def inspect(path: str) -> SourceInfo:
    """Read format and sizes out of `qemu-img info`."""
    check_source(path)
    proc = subprocess.run(
        [qemu_img(), "info", "--output=json", path],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise ConversionError(f"qemu-img could not read {path}:\n{proc.stderr.strip()}")
    data = json.loads(proc.stdout)
    return SourceInfo(
        path=path,
        fmt=data.get("format", "unknown"),
        virtual_size=int(data.get("virtual-size", 0)),
        actual_size=int(data.get("actual-size", 0)),
        raw=data,
    )


def default_output_path(src: str, target: str) -> str:
    ext = TARGETS[target]["ext"]
    return os.path.splitext(src)[0] + ext


def build_command(
    src: str,
    dst: str,
    target: str,
    *,
    src_format: str | None = None,
    subformat: str | None = None,
    compress: bool = False,
    threads: int = 4,
) -> list[str]:
    """Assemble the qemu-img convert invocation."""
    if target not in TARGETS:
        raise ConversionError(f"Unknown target format '{target}'. Choose from: {', '.join(TARGETS)}")

    cmd = [qemu_img(), "convert", "-p", "-m", str(threads)]
    if src_format:
        cmd += ["-f", src_format]
    cmd += ["-O", target]

    spec = TARGETS[target]
    sub = subformat or spec["default_subformat"]
    opts: list[str] = []
    if sub:
        if spec["subformats"] and sub not in spec["subformats"]:
            raise ConversionError(
                f"'{sub}' is not a valid subformat for {target}. "
                f"Choose from: {', '.join(spec['subformats'])}"
            )
        opts.append(f"subformat={sub}")
    if opts:
        cmd += ["-o", ",".join(opts)]
    if compress:
        if target not in ("qcow2", "vmdk"):
            raise ConversionError("Compression is only supported for qcow2 and vmdk targets.")
        cmd.append("-c")

    cmd += [src, dst]
    return cmd


_PROGRESS_RE = re.compile(r"\((\d+(?:\.\d+)?)/100%\)")


def _read_progress(stream: Iterable[str], on_progress: Callable[[float], None] | None) -> str:
    """qemu-img -p emits '(12.34/100%)' separated by \\r; report each update.

    Reads arrive in fixed-size chunks, so a single '(45.67/100%)' can straddle
    two chunks — match against a rolling buffer and keep only the unmatched
    remainder so nothing is missed or reported twice.
    """
    buf = ""
    tail = ""
    for chunk in stream:
        buf += chunk
        tail = (tail + chunk)[-400:]
        last_end = 0
        for match in _PROGRESS_RE.finditer(buf):
            if on_progress:
                on_progress(float(match.group(1)))
            last_end = match.end()
        # Keep a short unmatched suffix in case a token is still incomplete.
        buf = buf[last_end:][-64:]
    return tail


def check_free_space(dst: str, needed: int) -> None:
    target_dir = os.path.dirname(os.path.abspath(dst)) or "."
    free = shutil.disk_usage(target_dir).free
    if needed and free < needed:
        raise ConversionError(
            f"Not enough free space in {target_dir}: need up to {human_size(needed)}, "
            f"have {human_size(free)}."
        )


def convert(
    src: str,
    dst: str,
    target: str,
    *,
    subformat: str | None = None,
    compress: bool = False,
    threads: int = 4,
    overwrite: bool = False,
    on_progress: Callable[[float], None] | None = None,
    on_log: Callable[[str], None] | None = None,
) -> str:
    """Convert `src` into a VM disk at `dst`. Returns the output path."""
    info = inspect(src)
    if os.path.exists(dst) and not overwrite:
        raise ConversionError(f"Output already exists: {dst} (pass --overwrite to replace it)")
    check_free_space(dst, info.virtual_size if not compress else info.actual_size)

    cmd = build_command(
        src,
        dst,
        target,
        src_format=info.fmt if info.fmt != "unknown" else None,
        subformat=subformat,
        compress=compress,
        threads=threads,
    )
    if on_log:
        on_log(f"Source: {src} ({info.fmt}, {info.virtual_size_h} virtual)")
        on_log("Running: " + " ".join(cmd))

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    tail = _read_progress(iter(lambda: proc.stdout.read(64), ""), on_progress)
    code = proc.wait()
    if code != 0:
        if os.path.exists(dst):
            os.remove(dst)  # never leave a half-written disk behind
        raise ConversionError(f"qemu-img convert failed (exit {code}):\n{tail.strip()}")

    if on_progress:
        on_progress(100.0)
    if on_log:
        on_log(f"Done: {dst} ({human_size(os.path.getsize(dst))} on disk)")
    return dst
