# Wazuh integration for honey-bit

Two ways to get events into Wazuh. **Option 1 is recommended**: it uses the
agent you probably already have, needs no custom decoder, and gives you the
agent name and IP on every alert.

## Option 1: Wazuh agent on the honeypot host (recommended)

1. Install the honeypot with `deploy/install.sh` (no `--syslog` needed) or make
   sure it writes to `/var/log/honey-bit/events.jsonl`.
2. Install the Wazuh agent on the same host and enrol it with the manager.
3. Add `agent-ossec.conf.snippet.xml` to the agent's `ossec.conf`, then
   `systemctl restart wazuh-agent`.
4. The `honeybit` user owns the log directory with mode 750. Let the agent read it:
   `usermod -aG honeybit wazuh && chmod 750 /var/log/honey-bit`
5. On the manager copy `honey-bit_rules.xml` to `/var/ossec/etc/rules/` and
   `systemctl restart wazuh-manager`.

## Option 2: syslog straight to the manager (no agent)

1. On the manager add `manager-syslog.conf.snippet.xml` to `ossec.conf`, copy
   `honey-bit_rules.xml` to `/var/ossec/etc/rules/`, restart `wazuh-manager`.
2. Start the honeypot with `--syslog <MANAGER-IP>:514 --syslog-format rawjson`.
   Bare JSON is decoded by Wazuh's built-in JSON decoder.
   If you must keep the RFC 5424 framing (`--syslog-format json`), also copy
   `honey-bit_decoders.xml` to `/var/ossec/etc/decoders/`.

## Rules installed

| ID | Level | Fires on | MITRE |
| --- | --- | --- | --- |
| 100800 | 0 | any honey-bit event (parent) | |
| 100801 | 3 | honeypot started | |
| 100802 | 8 | honeypot stopped (coverage lost) | |
| 100810 | 5 | any connection to a honeypot port | T1046 |
| 100811 | 0 | session closed (silenced) | |
| 100812 | 12 | credential attempt (Telnet, FTP, HTTP login page) | T1110, T1078 |
| 100813 | 5 | HTTP request | T1595 |
| 100814 | 10 | HTTP request containing an attack pattern | T1190 |
| 100815 | 7 | SSH client banner received | T1021.004 |
| 100816 | 8 | SSH key exchange attempted | T1110 |
| 100817 | 6 | FTP command before login | |
| 100818 | 7 | raw payload on a generic TCP port | |
| 100830 | 13 | 5+ credential attempts from one IP in 2 min | T1110.001 |
| 100831 | 10 | 8+ connections from one IP in 1 min (scan) | T1046, T1595.001 |
| 100832 | 12 | 3+ web attack patterns from one IP in 1 min | T1595.002, T1190 |
| 100833 | 12 | same IP tried credentials and probes HTTP | |

Level 12 and above trigger email alerts with the default `email_alert_level`
and are good candidates for Active Response (block the `src_ip` with
`firewall-drop` on real servers, never on the honeypot itself).

## Testing the rules

Before restarting anything you can dry-run a sample against the rule set:

```bash
# on the manager
/var/ossec/bin/wazuh-logtest
# paste one line from ../samples/events.jsonl, e.g. a login_attempt line, and
# check it shows  Rule id: 100812  level 12
```

Then run the full Phase 1 test from `../TESTING.md`
(`simulate_attacks.py --scenario all --count 5 --seed 42`) and check the
Wazuh dashboard, filtered on `rule.groups: honeypot`. Expected alerts:

| Rule | Expected count |
| --- | --- |
| 100812 login attempt | 10 (5 Telnet + 5 FTP) |
| 100830 brute force | 1 or more (fires at the 5th attempt, then every 5) |
| 100814 web attack pattern | 4 |
| 100832 web scan | 1 |
| 100810 connection | 18 |
| 100831 scan | 1 or more |
| 100815 SSH banner | 1 |
| 100801 / 100802 start / stop | 1 each |

Dashboard query:

```
rule.groups: honeypot AND rule.level >= 10
```
