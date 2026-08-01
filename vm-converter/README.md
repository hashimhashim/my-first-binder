# Image → VM Disk Converter

A small app that turns a disk/backup image into a bootable VM disk — VMware
(`.vmdk`), Hyper-V (`.vhdx`/`.vhd`), VirtualBox (`.vdi`), or KVM/Proxmox
(`.qcow2`). It wraps `qemu-img` with sane defaults, pre-flight checks, a
progress bar, and a one-window GUI.

## Requirements

- Python 3.10+
- `qemu-img` on PATH
  - macOS: `brew install qemu`
  - Debian/Ubuntu: `sudo apt install qemu-utils`
  - Fedora/RHEL: `sudo dnf install qemu-img`
  - Windows: https://qemu.weilnetz.de/w64/ (add the install folder to PATH)
- Tkinter for the GUI (bundled with python.org and Windows builds; on Debian:
  `sudo apt install python3-tk`). The CLI works without it.

No third-party Python packages.

## Use

```bash
cd vm-converter

# GUI
python3 -m vmconvert gui

# CLI
python3 -m vmconvert convert disk.vhd -t vmdk                  # -> disk.vmdk
python3 -m vmconvert convert disk.vhd -t vmdk --subformat streamOptimized
python3 -m vmconvert convert disk.vhd -o /vms/win.vhdx -t vhdx
python3 -m vmconvert convert disk.vhd -t qcow2 --compress
python3 -m vmconvert info disk.vhd
python3 -m vmconvert formats
```

Flags: `--subformat`, `--compress` (qcow2/vmdk only), `--threads N`,
`--overwrite`.

## Picking a target

| Hypervisor | Use | Notes |
|---|---|---|
| VMware Workstation/ESXi | `-t vmdk` | default `monolithicSparse`; use `streamOptimized` when building an OVA |
| Hyper-V | `-t vhdx` | modern format, >2 TB support |
| Azure / legacy Hyper-V | `-t vpc --subformat fixed` | Azure requires fixed-size VHD |
| VirtualBox | `-t vdi` | |
| KVM / Proxmox / QEMU | `-t qcow2` | `--compress` shrinks the file |

## Acronis `.tib` / `.tibx` and other vendor backups

`qemu-img` cannot read proprietary backup archives, so the app stops early with
instructions instead of failing halfway through. For Acronis it's two steps:

1. In Acronis True Image: **Tools & Utilities → Mount Image**, select the
   backup, then export the mounted disk to `.vhd` (Acronis' *Convert to VHD*
   does the same thing).
2. Run this app on that `.vhd` to get `.vmdk` / `.vhdx` / `.vdi` / `.qcow2`.

If Acronis reports **"backup archive file is corrupted"**, the archive cannot be
converted whole — mount it read-only and copy off whatever data is intact, then
build a fresh image from that. The same two-step rule applies to Macrium
(`.mrimg`), ShadowProtect (`.spf`), and Symantec (`.v2i`) archives.

## After converting

The disk carries the original OS's storage drivers, so a Windows guest moved
between hypervisors may bluescreen with `INACCESSIBLE_BOOT_DEVICE` until the
matching controller is used (IDE/SATA rather than paravirtual) or the driver is
injected. Attach the disk to a new VM with a matching firmware type — BIOS for
MBR disks, UEFI for GPT.

## Tests

```bash
cd vm-converter && python3 -m unittest discover -s tests
```
