#!/usr/bin/env python3
"""Smoke test: start every service on ephemeral ports, poke them, check events."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    ports = {name: free_port() for name in ("ssh", "http", "telnet", "ftp")}
    syslog_port = free_port()
    collector = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    collector.bind(("127.0.0.1", syslog_port))
    collector.settimeout(3)

    with tempfile.TemporaryDirectory() as tmp:
        log = Path(tmp) / "events.jsonl"
        cmd = [sys.executable, str(HERE / "honeypot.py"), "--bind", "127.0.0.1", "--quiet",
               "--log-file", str(log), "--syslog", f"127.0.0.1:{syslog_port}"]
        for name, port in ports.items():
            cmd += ["--listen", f"{name}:{port}"]
        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE)
        try:
            time.sleep(1.0)
            sim = subprocess.run(
                [sys.executable, str(HERE / "simulate_attacks.py"), "--host", "127.0.0.1", "--seed", "1",
                 "--count", "2", *sum(([f"--{n}", str(p)] for n, p in ports.items()), [])],
                capture_output=True, text=True, timeout=60,
            )
            assert sim.returncode == 0, sim.stderr
            time.sleep(0.5)
        finally:
            proc.terminate()
            proc.wait(timeout=10)

        events = [json.loads(l) for l in log.read_text().splitlines()]
        types = {e["event_type"] for e in events}
        services = {e.get("service") for e in events if "service" in e}
        expected = {"honeypot_start", "honeypot_stop", "connection", "disconnect", "ssh_banner",
                    "ssh_kexinit", "login_attempt", "http_request"}
        missing = expected - types
        assert not missing, f"missing event types: {missing}"
        assert services == set(ports), f"services seen: {services}"
        assert any(e["event_type"] == "login_attempt" and e["service"] == "telnet" for e in events)
        assert any(e["event_type"] == "login_attempt" and e["service"] == "ftp" for e in events)
        assert all("src_ip" in e for e in events if e["event_type"] == "connection")

        collector.settimeout(1)
        received = 0
        try:
            while True:
                collector.recv(65535)
                received += 1
        except socket.timeout:
            pass
        assert received == len(events), f"syslog got {received} frames, log has {len(events)} events"

    print(f"OK: {len(events)} events, {len(types)} event types, {received} syslog frames")
    return 0


if __name__ == "__main__":
    sys.exit(main())
