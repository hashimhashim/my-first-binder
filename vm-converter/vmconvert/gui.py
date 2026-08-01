"""Minimal Tkinter front-end: pick a file, pick a format, watch the bar."""

from __future__ import annotations

import os
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from .core import TARGETS, ConversionError, convert, default_output_path

_LABEL_TO_KEY = {spec["label"]: key for key, spec in TARGETS.items()}


class App(ttk.Frame):
    def __init__(self, master: tk.Tk) -> None:
        super().__init__(master, padding=12)
        self.grid(sticky="nsew")
        master.columnconfigure(0, weight=1)
        master.rowconfigure(0, weight=1)
        self.columnconfigure(1, weight=1)

        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.worker: threading.Thread | None = None

        self.src_var = tk.StringVar()
        self.dst_var = tk.StringVar()
        self.fmt_var = tk.StringVar(value=TARGETS["vmdk"]["label"])
        self.sub_var = tk.StringVar()
        self.compress_var = tk.BooleanVar(value=False)
        self.status_var = tk.StringVar(value="Pick a source image to begin.")

        self._build()
        self._on_format_change()
        self.after(100, self._drain_events)

    def _build(self) -> None:
        ttk.Label(self, text="Source image").grid(row=0, column=0, sticky="w", pady=4)
        ttk.Entry(self, textvariable=self.src_var).grid(row=0, column=1, sticky="ew", padx=6)
        ttk.Button(self, text="Browse…", command=self._pick_source).grid(row=0, column=2)

        ttk.Label(self, text="Output disk").grid(row=1, column=0, sticky="w", pady=4)
        ttk.Entry(self, textvariable=self.dst_var).grid(row=1, column=1, sticky="ew", padx=6)
        ttk.Button(self, text="Save as…", command=self._pick_output).grid(row=1, column=2)

        ttk.Label(self, text="Target format").grid(row=2, column=0, sticky="w", pady=4)
        fmt = ttk.Combobox(
            self,
            textvariable=self.fmt_var,
            values=[spec["label"] for spec in TARGETS.values()],
            state="readonly",
        )
        fmt.grid(row=2, column=1, sticky="ew", padx=6)
        fmt.bind("<<ComboboxSelected>>", lambda _e: self._on_format_change())

        ttk.Label(self, text="Variant").grid(row=3, column=0, sticky="w", pady=4)
        self.sub_box = ttk.Combobox(self, textvariable=self.sub_var, state="readonly")
        self.sub_box.grid(row=3, column=1, sticky="ew", padx=6)

        ttk.Checkbutton(self, text="Compress (qcow2/vmdk only)", variable=self.compress_var).grid(
            row=4, column=1, sticky="w", padx=6, pady=4
        )

        self.progress = ttk.Progressbar(self, maximum=100)
        self.progress.grid(row=5, column=0, columnspan=3, sticky="ew", pady=(10, 4))

        ttk.Label(self, textvariable=self.status_var, wraplength=520, justify="left").grid(
            row=6, column=0, columnspan=3, sticky="w"
        )

        self.log = tk.Text(self, height=8, wrap="word")
        self.log.grid(row=7, column=0, columnspan=3, sticky="nsew", pady=8)
        self.rowconfigure(7, weight=1)

        self.run_btn = ttk.Button(self, text="Convert", command=self._start)
        self.run_btn.grid(row=8, column=2, sticky="e")

    # --- ui helpers -------------------------------------------------
    def _target_key(self) -> str:
        return _LABEL_TO_KEY[self.fmt_var.get()]

    def _on_format_change(self) -> None:
        spec = TARGETS[self._target_key()]
        self.sub_box["values"] = spec["subformats"]
        self.sub_var.set(spec["default_subformat"] or "")
        self.sub_box.configure(state="readonly" if spec["subformats"] else "disabled")
        if self.src_var.get():
            self.dst_var.set(default_output_path(self.src_var.get(), self._target_key()))

    def _pick_source(self) -> None:
        path = filedialog.askopenfilename(
            title="Select a disk image",
            filetypes=[
                ("Disk images", "*.vhd *.vhdx *.vmdk *.vdi *.qcow2 *.img *.raw *.tib *.tibx"),
                ("All files", "*.*"),
            ],
        )
        if path:
            self.src_var.set(path)
            self.dst_var.set(default_output_path(path, self._target_key()))

    def _pick_output(self) -> None:
        spec = TARGETS[self._target_key()]
        path = filedialog.asksaveasfilename(defaultextension=spec["ext"])
        if path:
            self.dst_var.set(path)

    def _append(self, text: str) -> None:
        self.log.insert("end", text + "\n")
        self.log.see("end")

    # --- work -------------------------------------------------------
    def _start(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        src, dst = self.src_var.get().strip(), self.dst_var.get().strip()
        if not src or not dst:
            messagebox.showwarning("Missing paths", "Choose both a source image and an output path.")
            return

        self.run_btn.state(["disabled"])
        self.progress["value"] = 0
        self.status_var.set("Converting…")

        target = self._target_key()
        sub = self.sub_var.get() or None
        compress = self.compress_var.get()

        def run() -> None:
            try:
                convert(
                    src,
                    dst,
                    target,
                    subformat=sub,
                    compress=compress,
                    overwrite=os.path.exists(dst),
                    on_progress=lambda p: self.events.put(("progress", p)),
                    on_log=lambda m: self.events.put(("log", m)),
                )
                self.events.put(("done", dst))
            except ConversionError as exc:
                self.events.put(("error", str(exc)))
            except Exception as exc:  # unexpected — still surface it in the UI
                self.events.put(("error", f"{type(exc).__name__}: {exc}"))

        self.worker = threading.Thread(target=run, daemon=True)
        self.worker.start()

    def _drain_events(self) -> None:
        while True:
            try:
                kind, payload = self.events.get_nowait()
            except queue.Empty:
                break
            if kind == "progress":
                self.progress["value"] = payload
                self.status_var.set(f"Converting… {payload:.1f}%")
            elif kind == "log":
                self._append(str(payload))
            elif kind == "done":
                self.status_var.set(f"Finished: {payload}")
                self.run_btn.state(["!disabled"])
            elif kind == "error":
                self.status_var.set("Failed — see log below.")
                self._append(str(payload))
                messagebox.showerror("Conversion failed", str(payload))
                self.run_btn.state(["!disabled"])
        self.after(100, self._drain_events)


def main() -> int:
    root = tk.Tk()
    root.title("Image → VM Disk Converter")
    root.geometry("640x480")
    App(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
