#!/usr/bin/env python3
"""
honey-bit: a tiny low-interaction honeypot for SIEM / detection testing.

It opens fake network services, records everything that touches them as
structured JSON events, and can forward those events to a SIEM via syslog
(UDP or TCP) in RFC 5424 or CEF format.

Only the Python standard library is used. Nothing is ever executed from
client input; every service only records what it receives and replies with
a canned banner.

Usage:
    python3 honeypot.py                       # defaults: SSH 2222, HTTP 8080, Telnet 2323, FTP 2121
    python3 honeypot.py --listen ssh:2222 --listen http:8080 --syslog 10.0.0.5:514
    python3 honeypot.py --config honeypot.json
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import socket
import socketserver
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

VERSION = "1.0.0"
PRODUCT = "honey-bit"
VENDOR = "my-first-binder"

MAX_READ = 4096          # bytes we keep per client message
READ_TIMEOUT = 15.0      # seconds a client may idle before we hang up
MAX_INTERACTIONS = 12    # messages before we drop the connection

# --------------------------------------------------------------------------- #
# Event sink: JSON lines to stdout/file + optional syslog forwarder
# --------------------------------------------------------------------------- #


class EventSink:
    """Writes events as JSON lines and optionally forwards them via syslog."""

    def __init__(
        self,
        log_file: Optional[str],
        syslog_target: Optional[str],
        syslog_proto: str = "udp",
        syslog_format: str = "json",
        quiet: bool = False,
        sensor_name: Optional[str] = None,
    ) -> None:
        self.quiet = quiet
        self.sensor = sensor_name or socket.gethostname()
        self._lock = threading.Lock()
        self._fh = open(log_file, "a", encoding="utf-8") if log_file else None
        self._syslog_sock: Optional[socket.socket] = None
        self._syslog_addr = None
        self._syslog_proto = syslog_proto
        self._syslog_format = syslog_format
        if syslog_target:
            host, _, port = syslog_target.rpartition(":")
            self._syslog_addr = (host or "127.0.0.1", int(port or 514))
            self._connect_syslog()

    def _connect_syslog(self) -> None:
        if not self._syslog_addr:
            return
        try:
            if self._syslog_proto == "tcp":
                s = socket.create_connection(self._syslog_addr, timeout=5)
            else:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self._syslog_sock = s
        except OSError as exc:
            logging.warning("syslog connect to %s failed: %s", self._syslog_addr, exc)
            self._syslog_sock = None

    # --- formatting -------------------------------------------------------- #

    def _to_cef(self, ev: Dict[str, Any]) -> str:
        def esc(v: Any, header: bool = False) -> str:
            s = str(v).replace("\\", "\\\\")
            s = s.replace("|", "\\|") if header else s.replace("=", "\\=")
            return s.replace("\r", "\\r").replace("\n", "\\n")

        sev = {"low": 3, "medium": 5, "high": 8, "critical": 10}.get(ev.get("severity", "low"), 3)
        header = "|".join(
            [
                "CEF:0",
                esc(VENDOR, True),
                esc(PRODUCT, True),
                esc(VERSION, True),
                esc(ev["event_type"], True),
                esc(ev.get("message", ev["event_type"]), True),
                str(sev),
            ]
        )
        ext = {
            "rt": int(ev["ts_epoch"] * 1000),
            "src": ev.get("src_ip", ""),
            "spt": ev.get("src_port", ""),
            "dst": ev.get("dst_ip", ""),
            "dpt": ev.get("dst_port", ""),
            "proto": "TCP",
            "app": ev.get("service", ""),
            "dvchost": ev.get("sensor", ""),
            "externalId": ev.get("session_id", ""),
        }
        for k in ("username", "password", "http_method", "http_path", "user_agent", "payload"):
            if ev.get(k) not in (None, ""):
                ext[k] = ev[k]
        return header + "|" + " ".join(f"{k}={esc(v)}" for k, v in ext.items() if v != "")

    def _to_syslog(self, ev: Dict[str, Any]) -> bytes:
        # facility local0 (16), severity notice (5) => PRI 133
        ts = ev["@timestamp"]
        if self._syslog_format == "rawjson":
            # bare JSON object, no syslog header: Wazuh and other JSON-aware
            # collectors decode this directly
            return (json.dumps(ev, separators=(",", ":")) + "\n").encode("utf-8", "replace")
        body = self._to_cef(ev) if self._syslog_format == "cef" else json.dumps(ev, separators=(",", ":"))
        line = f"<133>1 {ts} {self.sensor} {PRODUCT} - {ev['event_type']} - {body}"
        return (line + "\n").encode("utf-8", "replace")

    # --- emit -------------------------------------------------------------- #

    def emit(self, ev: Dict[str, Any]) -> None:
        now = time.time()
        ev.setdefault("ts_epoch", now)
        ev.setdefault("@timestamp", datetime.fromtimestamp(now, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
        ev.setdefault("sensor", self.sensor)
        ev.setdefault("product", PRODUCT)
        ev.setdefault("severity", "low")
        line = json.dumps(ev, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            if not self.quiet:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            if self._fh:
                self._fh.write(line + "\n")
                self._fh.flush()
            if self._syslog_addr:
                self._send_syslog(self._to_syslog(ev))

    def _send_syslog(self, data: bytes) -> None:
        for attempt in range(2):
            if self._syslog_sock is None:
                self._connect_syslog()
            if self._syslog_sock is None:
                return
            try:
                if self._syslog_proto == "tcp":
                    self._syslog_sock.sendall(data)
                else:
                    self._syslog_sock.sendto(data, self._syslog_addr)
                return
            except OSError as exc:
                logging.warning("syslog send failed (attempt %d): %s", attempt + 1, exc)
                try:
                    self._syslog_sock.close()
                except OSError:
                    pass
                self._syslog_sock = None

    def close(self) -> None:
        with self._lock:
            if self._fh:
                self._fh.close()
            if self._syslog_sock:
                self._syslog_sock.close()


# --------------------------------------------------------------------------- #
# Service handlers
# --------------------------------------------------------------------------- #


def _printable(data: bytes) -> str:
    """Decode bytes for logging; keep it safe for JSON and terminals."""
    text = data.decode("utf-8", "replace")
    return "".join(ch if ch.isprintable() or ch in "\r\n\t" else f"\\x{ord(ch):02x}" for ch in text)[:MAX_READ]


class HoneyHandler(socketserver.BaseRequestHandler):
    """Base handler: records connect/disconnect and provides helpers."""

    service = "tcp"
    banner: bytes = b""

    def setup(self) -> None:
        self.request.settimeout(READ_TIMEOUT)
        self.session_id = uuid.uuid4().hex[:16]
        self.started = time.time()
        self.src_ip, self.src_port = self.client_address[:2]
        self.dst_ip, self.dst_port = self.request.getsockname()[:2]
        self.interactions = 0
        self.log("connection", "New connection to honeypot service")

    def log(self, event_type: str, message: str, severity: str = "low", **fields: Any) -> None:
        ev: Dict[str, Any] = {
            "event_type": event_type,
            "message": message,
            "severity": severity,
            "service": self.service,
            "session_id": self.session_id,
            "src_ip": self.src_ip,
            "src_port": self.src_port,
            "dst_ip": self.dst_ip,
            "dst_port": self.dst_port,
        }
        ev.update(fields)
        self.server.sink.emit(ev)  # type: ignore[attr-defined]

    def send(self, data: bytes) -> None:
        try:
            self.request.sendall(data)
        except OSError:
            pass

    def recv(self) -> Optional[bytes]:
        try:
            data = self.request.recv(MAX_READ)
        except (socket.timeout, OSError):
            return None
        if not data:
            return None
        self.interactions += 1
        return data

    def recv_line(self) -> Optional[str]:
        buf = b""
        while len(buf) < MAX_READ:
            try:
                chunk = self.request.recv(1)
            except (socket.timeout, OSError):
                return None
            if not chunk:
                return _printable(buf).strip() if buf else None
            buf += chunk
            if chunk == b"\n":
                break
        self.interactions += 1
        return _printable(buf).strip()

    def handle(self) -> None:
        if self.banner:
            self.send(self.banner)
        while self.interactions < MAX_INTERACTIONS:
            data = self.recv()
            if data is None:
                break
            self.log("payload", "Client sent data", payload=_printable(data), payload_len=len(data))

    def finish(self) -> None:
        self.log(
            "disconnect",
            "Session closed",
            duration_ms=int((time.time() - self.started) * 1000),
            interactions=self.interactions,
        )


class SSHHandler(HoneyHandler):
    service = "ssh"
    banner = b"SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6\r\n"

    def handle(self) -> None:
        self.send(self.banner)
        client_banner = self.recv_line()
        if client_banner is None:
            return
        self.log("ssh_banner", "SSH client identification", client_banner=client_banner)
        # We do not implement the SSH transport. Anything after the banner is
        # binary key exchange; record its size and shape, then hang up.
        data = self.recv()
        if data:
            self.log(
                "ssh_kexinit",
                "SSH key exchange attempted against honeypot",
                severity="medium",
                payload_len=len(data),
                payload_hex=data[:64].hex(),
            )


class TelnetHandler(HoneyHandler):
    service = "telnet"
    banner = b"\r\nUbuntu 22.04.4 LTS\r\nlogin: "

    def handle(self) -> None:
        self.send(self.banner)
        attempts = 0
        while attempts < 3 and self.interactions < MAX_INTERACTIONS:
            username = self.recv_line()
            if username is None:
                return
            self.send(b"Password: ")
            password = self.recv_line()
            if password is None:
                return
            attempts += 1
            self.log(
                "login_attempt",
                "Telnet credential attempt on honeypot",
                severity="high",
                username=username,
                password=password,
                attempt=attempts,
                outcome="failure",
            )
            time.sleep(1.0)
            self.send(b"\r\nLogin incorrect\r\nlogin: ")
        self.send(b"\r\nToo many failures.\r\n")


class FTPHandler(HoneyHandler):
    service = "ftp"
    banner = b"220 (vsFTPd 3.0.5)\r\n"

    def handle(self) -> None:
        self.send(self.banner)
        username = ""
        while self.interactions < MAX_INTERACTIONS:
            line = self.recv_line()
            if line is None:
                return
            cmd, _, arg = line.partition(" ")
            cmd = cmd.upper()
            if cmd == "USER":
                username = arg
                self.send(b"331 Please specify the password.\r\n")
            elif cmd == "PASS":
                self.log(
                    "login_attempt",
                    "FTP credential attempt on honeypot",
                    severity="high",
                    username=username,
                    password=arg,
                    outcome="failure",
                )
                time.sleep(1.0)
                self.send(b"530 Login incorrect.\r\n")
            elif cmd == "QUIT":
                self.send(b"221 Goodbye.\r\n")
                return
            else:
                self.log("ftp_command", "FTP command before authentication", command=cmd, argument=arg)
                self.send(b"530 Please login with USER and PASS.\r\n")


SUSPICIOUS_PATH_MARKERS = (
    "../", "..\\", "/etc/passwd", "wp-login", "wp-admin", ".env", "/.git", "phpmyadmin",
    "cgi-bin", "shell", "cmd=", "exec", "eval(", "union select", "' or ", "<script",
    "${jndi:", "/actuator", "/.aws", "xmlrpc.php", "/manager/html", "boaform", "/HNAP1",
)


class HTTPHandler(HoneyHandler):
    service = "http"

    def handle(self) -> None:
        raw = b""
        while b"\r\n\r\n" not in raw and len(raw) < MAX_READ * 4:
            try:
                chunk = self.request.recv(MAX_READ)
            except (socket.timeout, OSError):
                break
            if not chunk:
                break
            raw += chunk
        if not raw:
            return
        self.interactions += 1
        head, _, body = raw.partition(b"\r\n\r\n")
        lines = _printable(head).split("\r\n")
        request_line = lines[0] if lines else ""
        parts = request_line.split(" ")
        method = parts[0] if len(parts) > 0 else ""
        path = parts[1] if len(parts) > 1 else ""
        version = parts[2] if len(parts) > 2 else ""
        headers: Dict[str, str] = {}
        for line in lines[1:]:
            k, sep, v = line.partition(":")
            if sep:
                headers[k.strip().lower()] = v.strip()

        lowered = (path + " " + _printable(body)).lower()
        suspicious = [m for m in SUSPICIOUS_PATH_MARKERS if m in lowered]
        severity = "high" if suspicious else ("medium" if method in ("POST", "PUT", "DELETE") else "low")

        self.log(
            "http_request",
            "HTTP request to honeypot",
            severity=severity,
            http_method=method,
            http_path=path[:2048],
            http_version=version,
            host=headers.get("host", ""),
            user_agent=headers.get("user-agent", ""),
            authorization=headers.get("authorization", ""),
            content_length=int(headers.get("content-length", "0") or 0),
            body=_printable(body)[:1024],
            indicators=suspicious,
            indicator_count=len(suspicious),
        )

        if path.startswith("/admin") or path.startswith("/login"):
            self.log(
                "login_attempt",
                "HTTP login/admin page probed on honeypot",
                severity="high",
                http_method=method,
                http_path=path[:2048],
                outcome="failure",
            )
            status, page = "401 Unauthorized", b"<html><body><h1>401 Unauthorized</h1></body></html>"
            extra = "WWW-Authenticate: Basic realm=\"Restricted\"\r\n"
        else:
            status, page = "404 Not Found", b"<html><body><h1>404 Not Found</h1></body></html>"
            extra = ""
        response = (
            f"HTTP/1.1 {status}\r\n"
            "Server: Apache/2.4.52 (Ubuntu)\r\n"
            f"Date: {datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S GMT')}\r\n"
            "Content-Type: text/html\r\n"
            f"Content-Length: {len(page)}\r\n"
            f"{extra}"
            "Connection: close\r\n\r\n"
        ).encode() + page
        self.send(response)


class GenericTCPHandler(HoneyHandler):
    service = "tcp"


HANDLERS = {
    "ssh": SSHHandler,
    "http": HTTPHandler,
    "telnet": TelnetHandler,
    "ftp": FTPHandler,
    "tcp": GenericTCPHandler,
}

DEFAULT_LISTENERS = ["ssh:2222", "http:8080", "telnet:2323", "ftp:2121"]


# --------------------------------------------------------------------------- #
# Server plumbing
# --------------------------------------------------------------------------- #


class HoneyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, addr, handler, sink: EventSink) -> None:
        super().__init__(addr, handler)
        self.sink = sink

    def handle_error(self, request, client_address) -> None:  # keep noisy clients from spamming tracebacks
        logging.debug("handler error from %s", client_address, exc_info=True)


def parse_listener(spec: str):
    """'ssh:2222' -> ('ssh', 2222).  Also accepts 'tcp:9999'."""
    name, _, port = spec.partition(":")
    name = name.lower()
    if name not in HANDLERS:
        raise argparse.ArgumentTypeError(f"unknown service '{name}'. Choose from {', '.join(HANDLERS)}")
    if not port.isdigit() or not 0 < int(port) < 65536:
        raise argparse.ArgumentTypeError(f"bad port in '{spec}'")
    return name, int(port)


def load_config(path: str, args: argparse.Namespace) -> argparse.Namespace:
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    for key in ("bind", "log_file", "syslog", "syslog_proto", "syslog_format", "quiet", "sensor_name"):
        if key in cfg:
            setattr(args, key, cfg[key])
    if "listen" in cfg:
        args.listen = [parse_listener(s) for s in cfg["listen"]]
    return args


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--listen", action="append", type=parse_listener, metavar="SERVICE:PORT",
                   help="service to expose, e.g. ssh:2222 (repeatable). Default: %s" % " ".join(DEFAULT_LISTENERS))
    p.add_argument("--bind", default="0.0.0.0", help="address to bind (default 0.0.0.0)")
    p.add_argument("--log-file", dest="log_file", default="honeypot-events.jsonl", help="JSON lines output file ('' to disable)")
    p.add_argument("--syslog", metavar="HOST:PORT", help="forward events to this syslog collector")
    p.add_argument("--syslog-proto", dest="syslog_proto", choices=("udp", "tcp"), default="udp")
    p.add_argument("--syslog-format", dest="syslog_format", choices=("json", "cef", "rawjson"), default="json",
                   help="syslog body format: json (RFC 5424 + JSON), cef, or rawjson (bare JSON line, best for Wazuh)")
    p.add_argument("--sensor-name", dest="sensor_name", help="value for the 'sensor' field (default hostname)")
    p.add_argument("--quiet", action="store_true", help="do not echo events to stdout")
    p.add_argument("--config", help="JSON config file (see honeypot.example.json)")
    p.add_argument("--version", action="version", version=f"{PRODUCT} {VERSION}")
    return p


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)
    if args.config:
        args = load_config(args.config, args)
    listeners = args.listen or [parse_listener(s) for s in DEFAULT_LISTENERS]
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)

    sink = EventSink(
        log_file=args.log_file or None,
        syslog_target=args.syslog,
        syslog_proto=args.syslog_proto,
        syslog_format=args.syslog_format,
        quiet=args.quiet,
        sensor_name=args.sensor_name,
    )

    servers = []
    for name, port in listeners:
        try:
            srv = HoneyServer((args.bind, port), HANDLERS[name], sink)
        except OSError as exc:
            logging.error("cannot bind %s on %s:%d: %s", name, args.bind, port, exc)
            continue
        threading.Thread(target=srv.serve_forever, name=f"{name}:{port}", daemon=True).start()
        servers.append(srv)
        logging.info("listening %s on %s:%d", name, args.bind, port)

    if not servers:
        logging.error("no listeners started")
        return 1

    sink.emit({"event_type": "honeypot_start", "message": "Honeypot started", "severity": "low",
               "listeners": [f"{n}:{p}" for n, p in listeners], "pid": os.getpid()})

    stop = threading.Event()

    def _stop(*_):
        stop.set()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    try:
        while not stop.is_set():
            stop.wait(1.0)
    finally:
        for srv in servers:
            srv.shutdown()
            srv.server_close()
        sink.emit({"event_type": "honeypot_stop", "message": "Honeypot stopped", "severity": "low"})
        sink.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
