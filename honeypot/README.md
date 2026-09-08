# honey-bit — a tiny honeypot for SIEM and detection testing

`honey-bit` is a low-interaction honeypot written with only the Python
standard library. It exposes fake services, records everything that touches
them as structured JSON events, and forwards those events to your SIEM over
syslog. A companion script generates realistic test traffic so you can verify
that your SIEM, alerting rules, and downstream tooling actually see and
classify the events.

**Use it only on hosts and networks you own or are authorised to test.**

## Contents

| File | Purpose |
| --- | --- |
| `honeypot.py` | The honeypot server (SSH banner, HTTP, Telnet, FTP, generic TCP) |
| `simulate_attacks.py` | Traffic generator that produces a predictable set of events |
| `honeypot.example.json` | Sample config file |
| `test_honeypot.py` | End-to-end smoke test (starts the honeypot, attacks it, checks the log and syslog output) |
| `TESTING.md` | Where and how to test: controlled lab test vs. live internet-exposed honeypot |
| `deploy/` | One-command server installer (systemd), Dockerfile, docker-compose and `DEPLOY.md` |
| `samples/` | Captured example output (JSONL, syslog JSON, CEF) for SIEM replay |

## Quick start

```bash
cd honeypot

# 1. start the honeypot (defaults: ssh:2222 http:8080 telnet:2323 ftp:2121)
python3 honeypot.py --syslog YOUR-SIEM-IP:514

# 2. in another terminal, generate test traffic
python3 simulate_attacks.py --host 127.0.0.1

# 3. events are echoed to stdout and appended to honeypot-events.jsonl
```

To run the built-in test:

```bash
python3 test_honeypot.py
```

## Command line options

```
--listen SERVICE:PORT   service to expose; repeatable. Services: ssh, http, telnet, ftp, tcp
--bind ADDR             address to bind (default 0.0.0.0)
--log-file PATH         JSON lines output (default honeypot-events.jsonl, '' to disable)
--syslog HOST:PORT      forward every event to this syslog collector
--syslog-proto udp|tcp  transport for syslog (default udp)
--syslog-format json|cef  body format inside the syslog frame (default json)
--sensor-name NAME      value of the "sensor" field (default: hostname)
--quiet                 do not echo events to stdout
--config FILE           load settings from a JSON file (see honeypot.example.json)
```

Ports below 1024 need root. Prefer high ports plus a firewall or NAT redirect
(for example `iptables -t nat -A PREROUTING -p tcp --dport 22 -j REDIRECT --to-port 2222`)
so the honeypot never runs privileged.

## Event format

Every event is one JSON object per line. Common fields:

| Field | Meaning |
| --- | --- |
| `@timestamp` | ISO 8601 UTC time |
| `event_type` | `connection`, `disconnect`, `login_attempt`, `http_request`, `ssh_banner`, `ssh_kexinit`, `ftp_command`, `payload`, `honeypot_start`, `honeypot_stop` |
| `severity` | `low`, `medium`, `high` |
| `service` | `ssh`, `http`, `telnet`, `ftp`, `tcp` |
| `session_id` | ties all events of one TCP connection together |
| `src_ip`, `src_port`, `dst_ip`, `dst_port` | connection endpoints |
| `sensor` | which honeypot host produced the event |

Type-specific fields: `username`, `password`, `outcome` (login attempts);
`http_method`, `http_path`, `user_agent`, `body`, `indicators` (HTTP);
`client_banner` (SSH); `payload`, `payload_len` (raw data).

Example:

```json
{"event_type":"login_attempt","message":"Telnet credential attempt on honeypot","severity":"high","service":"telnet","session_id":"3f9c1e2a7b8d4c10","src_ip":"192.0.2.10","src_port":51234,"dst_ip":"10.0.0.5","dst_port":2323,"username":"root","password":"123456","attempt":1,"outcome":"failure","ts_epoch":1788880000.123,"@timestamp":"2026-09-08T17:06:40.123Z","sensor":"honey-bit-01","product":"honey-bit"}
```

### Syslog framing

With `--syslog` each event is sent as an RFC 5424 message, facility `local0`,
severity `notice`, app-name `honey-bit`, msgid = `event_type`. The body is the
JSON object, or a CEF line when `--syslog-format cef` is set:

```
CEF:0|my-first-binder|honey-bit|1.0.0|login_attempt|FTP credential attempt on honeypot|8|rt=... src=192.0.2.10 spt=51234 dst=10.0.0.5 dpt=2121 proto=TCP app=ftp username=admin password=admin
```

## SIEM integration notes

- **Splunk**: create a UDP/TCP data input on 514, sourcetype `_json` (or
  `cef` if using CEF). Field extraction is automatic for JSON.
- **Elastic / OpenSearch**: point Filebeat at `honeypot-events.jsonl` with
  `json.keys_under_root: true`, or use the Filebeat `syslog` input.
- **Wazuh**: add a `<localfile>` with `<log_format>json</log_format>` for the
  JSONL file, then write rules on `event_type` and `severity`.
- **Microsoft Sentinel**: ship via the Azure Monitor Agent syslog facility
  `local0`, or use the CEF connector with `--syslog-format cef`.
- **Graylog / QRadar / others**: any syslog UDP/TCP listener works; the CEF
  format is the most portable.

### Detection ideas to test

- Any `login_attempt` from the honeypot → high-priority alert (nobody should log in).
- More than N `connection` events from one `src_ip` in 5 minutes → scan detection.
- `http_request` where `indicators` is non-empty → web exploitation attempt.
- `event_type:honeypot_stop` without a matching `honeypot_start` shortly after → sensor down.
- Correlate `src_ip` seen on the honeypot against firewall / VPN / EDR logs from real assets.

## Traffic generator

```bash
python3 simulate_attacks.py --host 10.0.0.5 --scenario all --count 5
python3 simulate_attacks.py --scenario bruteforce --count 25   # only telnet/ftp logins
python3 simulate_attacks.py --scenario webscan                 # every probe path once
python3 simulate_attacks.py --seed 42                          # reproducible credentials/paths
```

Scenarios: `recon` (SSH banner + two HTTP probes), `bruteforce` (Telnet and
FTP credential guesses), `webscan` (path traversal, SQLi, XSS, Log4Shell-style
and admin-panel probes), `all`.

## Safety and limits

- The honeypot never executes, evaluates, or stores client input anywhere
  except the log. All replies are canned banners and error pages.
- SSH is banner-only: there is no key exchange, so real SSH clients
  disconnect after the first packet. That is enough to log scanners and
  brute-forcers, which is what most SIEM tests need.
- Reads are capped (4 KiB per message, 12 messages per session, 15 s idle
  timeout) so a noisy client cannot exhaust memory.
- Logged passwords are captured attacker input. Treat the log file as sensitive.
- Run as an unprivileged user, ideally in a container or isolated VLAN.
