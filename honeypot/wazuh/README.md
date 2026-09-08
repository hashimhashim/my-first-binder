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

## Compliance tags

Every alerting rule carries PCI DSS, NIST 800-53, HIPAA, GDPR, TSC and GPG13
tags, so honeypot alerts appear under the Regulatory Compliance filters in the
dashboard. Mapping to NCA ECC (for the ECC evidence counter):

| Rules | NCA ECC control | Evidence provided |
| --- | --- | --- |
| 100810, 100831 | 2-5-3 Network security: monitoring | Detection of scanning and unauthorised connection attempts |
| 100812, 100830 | 2-2-3 Identity and access: brute-force protection | Detection of credential guessing |
| 100814, 100832 | 2-7-3 Web application security | Detection of web attack patterns |
| 100801, 100802 | 2-12-3 Event logs and monitoring: log availability | Sensor start/stop tracking |
| all | 2-13-3 Incident and threat management | MITRE-tagged detections feeding response |

Level 12 and above trigger email alerts with the default `email_alert_level`
and are good candidates for Active Response (block the `src_ip` with
`firewall-drop` on real servers, never on the honeypot itself).

## Testing, step by step

Wazuh alerts on the most specific rule that matches, so once a correlation
rule fires it absorbs the events that would otherwise alert individually. The
counts below reflect that.

### Step 1: put the honeypot on an endpoint

On one of the enrolled endpoints (or a fourth small VM), as root:

```bash
git clone https://github.com/hashimhashim/my-first-binder.git
cd my-first-binder/honeypot
sudo bash deploy/install.sh --siem 127.0.0.1:1514 --sensor honey-bit-01
# the --siem value is unused in this setup (the agent reads the file); any value is fine
```

If the Wazuh agent is not installed yet, install and enrol it (Agents > Deploy
new agent in the dashboard gives the exact command). Then add the log source
and let the agent read the honeypot log:

```bash
sudo usermod -aG honeybit wazuh
sudo tee -a /var/ossec/etc/ossec.conf >/dev/null <<'XML'
<ossec_config>
  <localfile>
    <log_format>json</log_format>
    <location>/var/log/honey-bit/events.jsonl</location>
    <label key="honeypot">true</label>
  </localfile>
</ossec_config>
XML
sudo systemctl restart wazuh-agent
sudo tail -n 20 /var/ossec/logs/ossec.log | grep -i honey     # expect "Analyzing file: /var/log/honey-bit/events.jsonl"
```

### Step 2: load the rules on the manager and dry-run them

```bash
sudo cp wazuh/honey-bit_rules.xml /var/ossec/etc/rules/
sudo chown wazuh:wazuh /var/ossec/etc/rules/honey-bit_rules.xml
sudo /var/ossec/bin/wazuh-analysisd -t          # must print nothing or "Configuration test OK"
sudo systemctl restart wazuh-manager
```

Now test a real sample line before sending any traffic. Either use the
dashboard (Tools > Ruleset Test) or the CLI:

```bash
sudo /var/ossec/bin/wazuh-logtest
# paste this line and press Enter:
{"event_type":"login_attempt","message":"Telnet credential attempt on honeypot","severity":"high","service":"telnet","session_id":"abc123","src_ip":"192.0.2.10","src_port":51234,"dst_ip":"10.0.0.5","dst_port":2323,"username":"root","password":"123456","attempt":1,"outcome":"failure","ts_epoch":1788880000.1,"@timestamp":"2026-09-08T17:06:40.100Z","sensor":"honey-bit-01","product":"honey-bit"}
```

Expected output:

```
**Phase 2: Completed decoding.
        name: 'json'
        ...
**Phase 3: Completed filtering (rules).
        id: '100812'
        level: '12'
        description: 'honey-bit: credential attempt on honeypot telnet from 192.0.2.10 - user "root"'
        groups: '["honeypot","honey-bit","honeypot_login","authentication_failed"]'
        mitre.id: '["T1110","T1078"]'
        pci_dss: '["10.2.4","10.2.5","10.6.1"]'
**Alert to be generated.
```

Paste the same line five times in the same logtest session and the fifth
should report rule 100830, level 13 (brute force). If you see level 12 five
times instead, your Wazuh version counts differently; raise `frequency` by 1.

### Step 3: generate traffic

From any other machine that can reach the endpoint:

```bash
python3 simulate_attacks.py --host <ENDPOINT-IP> --scenario all --count 5 --seed 42
```

It runs for about 30 seconds.

### Step 4: check the dashboard

Open Threat Hunting, set the time range to the last 15 minutes and filter:

```
rule.groups: honeypot
```

Expected alerts for the seed-42 run (verified with the offline replay checker
in this folder; confirm on your manager):

| Rule | Level | Expected | What it proves |
| --- | --- | --- | --- |
| 100801 start, 100802 stop | 3, 8 | 1 each | lifecycle tracking (stop only if you restart the service) |
| 100812 credential attempt | 12 | about 4 | single-event detection and email threshold |
| 100833 multi-service attacker | 12 | about 5 | different_field correlation |
| 100830 brute force | 13 | 1 or more | frequency correlation |
| 100810 connection | 5 | about 7 | baseline visibility |
| 100831 scan | 10 | 1 or more | connection-rate correlation |
| 100813 HTTP request | 5 | about 3 | HTTP decoding |
| 100814 web attack pattern | 10 | 1 or more | indicator matching |
| 100832 web scan | 12 | 1 or more | web-scan correlation |
| 100815 SSH banner, 100816 SSH kexinit | 7, 8 | 1 each | SSH probe detection |

Login attempts (100812 + 100830 + 100833) total 10, connections
(100810 + 100831) total 18, and HTTP (100813 + 100814 + 100832) total 7.

Then check the other cards: in MITRE ATT&CK you should see T1110 and T1190;
in Regulatory Compliance filter PCI DSS 10.2.4 and 11.4; if Active Response
is configured for level 12, check the endpoint's active-responses.log.

### Offline check without a manager

```bash
python3 wazuh/replay_check.py                   # replays samples/events.jsonl through the rules
```

Dashboard query:

```
rule.groups: honeypot AND rule.level >= 10
```
