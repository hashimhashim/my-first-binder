"""Command-line interface: `python -m vmconvert ...`"""

from __future__ import annotations

import argparse
import sys

from .core import TARGETS, ConversionError, convert, default_output_path, inspect


def _print_progress(pct: float) -> None:
    width = 30
    filled = int(width * pct / 100)
    bar = "#" * filled + "-" * (width - filled)
    sys.stdout.write(f"\r  [{bar}] {pct:5.1f}%")
    sys.stdout.flush()


def _log(msg: str) -> None:
    print(msg)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vmconvert",
        description="Convert disk images into VM disks (VMware, Hyper-V, VirtualBox, KVM).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_conv = sub.add_parser("convert", help="convert an image to a VM disk")
    p_conv.add_argument("source", help="input image (.vhd, .vhdx, .vmdk, .vdi, .qcow2, .img, .iso-less raw)")
    p_conv.add_argument("-o", "--output", help="output path (default: same name, new extension)")
    p_conv.add_argument(
        "-t", "--to", dest="target", default="vmdk", choices=sorted(TARGETS),
        help="target format (default: vmdk)",
    )
    p_conv.add_argument("--subformat", help="format variant, e.g. streamOptimized for vmdk, fixed for vpc")
    p_conv.add_argument("--compress", action="store_true", help="compress output (qcow2/vmdk only)")
    p_conv.add_argument("--threads", type=int, default=4, help="parallel coroutines (default: 4)")
    p_conv.add_argument("--overwrite", action="store_true", help="replace an existing output file")

    p_info = sub.add_parser("info", help="show format and size of an image")
    p_info.add_argument("source")

    sub.add_parser("formats", help="list supported target formats")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        if args.command == "formats":
            for key, spec in sorted(TARGETS.items()):
                variants = ", ".join(spec["subformats"]) or "-"
                print(f"  {key:<6} {spec['label']:<32} ext={spec['ext']:<7} subformats: {variants}")
            return 0

        if args.command == "info":
            info = inspect(args.source)
            print(f"  path:         {info.path}")
            print(f"  format:       {info.fmt}")
            print(f"  virtual size: {info.virtual_size_h}")
            print(f"  on disk:      {info.actual_size_h}")
            return 0

        out = args.output or default_output_path(args.source, args.target)
        convert(
            args.source,
            out,
            args.target,
            subformat=args.subformat,
            compress=args.compress,
            threads=args.threads,
            overwrite=args.overwrite,
            on_progress=_print_progress,
            on_log=_log,
        )
        print()
        return 0

    except ConversionError as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\naborted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
