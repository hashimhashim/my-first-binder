"""vmconvert — turn backup/disk images into bootable VM disks."""

from .core import TARGETS, ConversionError, convert, default_output_path, inspect

__all__ = ["TARGETS", "ConversionError", "convert", "default_output_path", "inspect"]
__version__ = "0.1.0"
