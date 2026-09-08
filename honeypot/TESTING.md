# Where and how to test honey-bit

There are two ways to feed events into your SIEM with this honeypot. Start
with Phase 1. Only move to Phase 2 once Phase 1 alerts work end to end.

| | Phase 1: controlled test | Phase 2: live honeypot |
| --- | --- | --- |
| Who attacks it | You, with `simulate_attacks.py` | Real internet scanners and attackers |
| Where it runs | Any lab VM / laptop / container on your internal network | Isolated VM in a DMZ or cloud, on its own VLAN |
| Exposure | None. Firewall stays closed. | One or more ports opened to the internet |
| Purpose | Prove SIEM parsing, dashboards and alert rules work | Collect real attacker data, test SOC response |
| Risk | None | Low but real: the box will be attacked constantly |

Nothing in this repo opens anything to the internet by itself. Phase 2 only
happens if you deliberately configure a public IP or firewall rule.

---

## Phase 1: controlled test on your own network (do this first)

### Where

- One machine to run the honeypot: a Linux VM, a spare laptop, a Docker
  container, or even the SIEM host itself for a first try.
- One machine to run the simulator: can be the same machine (`--host 127.0.0.1`)
  or a second machine on the same network so the `src_ip` field shows a real
  internal address.
- The SIEM must be reachable from the honeypot host on its syslog port
  (usually UDP or TCP 514).

### How

1. **Prepare the SIEM input.** Create a syslog listener (UDP 514 or TCP 514).
   For JSON, use a JSON sourcetype/parser. For CEF, use the CEF connector.
   See the SIEM notes in `README.md`.

2. **Start the honeypot** on the honeypot host:

   ```bash
   cd honeypot
   python3 honeypot.py --sensor-name lab-honeypot-01 --syslog <SIEM-IP>:514
   # or, for CEF-based SIEMs (Sentinel, ArcSight, QRadar):
   python3 honeypot.py --sensor-name lab-honeypot-01 --syslog <SIEM-IP>:514 --syslog-format cef
   ```

   You should see one `honeypot_start` event on screen. Check the SIEM
   receives it. If not, fix network/firewall/parsing before continuing.

3. **Run the simulator** from the attacker machine:

   ```bash
   python3 simulate_attacks.py --host <HONEYPOT-IP> --scenario all --count 5 --seed 42
   ```

   Using `--seed 42` gives the same usernames, passwords and paths every run,
   so you can compare results across SIEM changes.

4. **Verify in the SIEM.** Expected results for the command above:

   | Check | Expected |
   | --- | --- |
   | `event_type = honeypot_start` | 1 event |
   | `event_type = login_attempt`, `service = telnet` | 5 events, all `outcome = failure` |
   | `event_type = login_attempt`, `service = ftp` | 5 events |
   | `event_type = http_request` | 7 events (2 recon + 5 webscan) |
   | `http_request` with non-empty `indicators` | at least 1 (traversal / SQLi / XSS / jndi) |
   | `event_type = ssh_banner` | 1, `client_banner = SSH-2.0-libssh2_1.11.0` |
   | Every event has `src_ip` = attacker machine and `sensor = lab-honeypot-01` | yes |

5. **Test each alert rule** with a targeted scenario:

   | Rule you want to test | Command |
   | --- | --- |
   | Credential brute force | `simulate_attacks.py --scenario bruteforce --count 30` |
   | Web attack / scanner | `simulate_attacks.py --scenario webscan` |
   | Port scan / recon | `simulate_attacks.py --scenario recon`, or `nmap -sV -p 2222,8080,2323,2121 <HONEYPOT-IP>` |
   | Sensor down | stop the honeypot with Ctrl-C; expect `honeypot_stop` and no heartbeat afterwards |

   Confirm the alert fires, the ticket or notification is created, and the
   analyst can pivot from `src_ip` to other log sources.

6. **Test other applications** the same way: anything that consumes syslog or
   reads the `honeypot-events.jsonl` file (log forwarders, SOAR playbooks,
   dashboards, threat intel enrichment) can be pointed at this output.

### Optional: real tools instead of the simulator

Once the simulator works, you can run real attacker tooling from your own
machine against your own honeypot for more realistic noise:

```bash
nmap -sV -p 2222,8080,2323,2121 <HONEYPOT-IP>
hydra -l admin -P /usr/share/wordlists/rockyou.txt -t 4 ftp://<HONEYPOT-IP>:2121
ssh -p 2222 root@<HONEYPOT-IP>          # logs banner + kexinit, then fails
curl http://<HONEYPOT-IP>:8080/.env
```

---

## Phase 2: live honeypot exposed to real attackers (optional)

Do this only if you want real-world data and have approval to expose a host.

### Where

- A dedicated VM with nothing else on it. A small cloud instance (1 vCPU,
  1 GB) is enough and is the safest option because it is off your network.
- If on-premises, put it in a DMZ or its own VLAN. It must NOT be able to
  reach internal systems except the SIEM syslog port.
- Never run it on a machine that holds real data or credentials.

### How

1. Build the VM, create an unprivileged user, copy the `honeypot/` folder.
2. Run it as a service on high ports and redirect the standard ports to it,
   so the process never runs as root:

   ```bash
   # redirect real ports to honeypot ports
   sudo iptables -t nat -A PREROUTING -p tcp --dport 22 -j REDIRECT --to-port 2222
   sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8080
   sudo iptables -t nat -A PREROUTING -p tcp --dport 23 -j REDIRECT --to-port 2323
   sudo iptables -t nat -A PREROUTING -p tcp --dport 21 -j REDIRECT --to-port 2121
   ```

   Move your own real SSH admin access to a different port or use the cloud
   console, so it does not collide with the honeypot on port 22.

3. Egress firewall: allow only outbound syslog to the SIEM and DNS/NTP.
   Block everything else so the box cannot be used to attack others.
4. Open the inbound ports (22, 80, 23, 21) on the cloud security group or
   perimeter firewall. Within minutes you will see real scanners.
5. Use `--syslog-proto tcp` so events are not lost, and `--quiet` to avoid
   filling the console.
6. Tag the events in the SIEM (by `sensor` name) so analysts know it is a
   honeypot and every hit is by definition unauthorised.

### What to expect

- Hundreds to thousands of `connection` events per day, mostly automated
  scanners.
- Constant Telnet and FTP `login_attempt` events with IoT default credentials.
- HTTP probes for `.env`, `wp-login.php`, `phpmyadmin`, Log4Shell and similar.
- The `password` field holds real attacker input. Treat the log as sensitive.

### Rules

- Everything the honeypot records is attacker data; do not reuse or "test"
  any credential or payload it captures.
- Do not attack back. Report abusive IPs through normal channels if you wish.
- Rotate or destroy the VM periodically; it is disposable by design.

---

## Quick decision

- **"I just want to know my SIEM ingests and alerts correctly"** → Phase 1 only.
- **"I want to see what real attackers do to us"** → Phase 1, then Phase 2 on
  an isolated cloud VM.
