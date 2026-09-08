# Sample output

Captured from a Phase 1 controlled run (`simulate_attacks.py --scenario all --count 5 --seed 42`)
against a honeypot started with `--sensor-name lab-honeypot-01`. All source IPs are 127.0.0.1
because attacker and honeypot ran on the same host.

| File | What it is | Use it to |
| --- | --- | --- |
| `events.jsonl` | The honeypot's own log: 57 JSON events, one per line | Test file-based ingestion (Filebeat, Wazuh, Splunk monitor input) and parsing |
| `syslog-json.log` | The same 57 events exactly as they arrived at a UDP syslog collector (RFC 5424 frame, JSON body) | Replay into the SIEM syslog input, e.g. `while read l; do echo "$l" \| nc -u -w0 SIEM 514; done < syslog-json.log` |
| `syslog-cef.log` | A shorter run in CEF format (FTP brute force + HTTP recon) | Test CEF connectors (Sentinel, ArcSight, QRadar) |

Expected counts in `events.jsonl`: 1 honeypot_start, 18 connection, 18 disconnect, 1 ssh_banner,
1 ssh_kexinit, 7 http_request (4 with indicators), 10 login_attempt (5 telnet, 5 ftp), 1 honeypot_stop.
