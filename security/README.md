# File Integrity Monitoring (FIM) + Hardening Scan

`fim_hardening_scan.sh` is a dependency-free Bash script that gives a Linux host
two things a SIEM needs but does not do by itself:

1. **File integrity monitoring** - SHA-256, mode, and owner baseline of critical
   paths (`/etc`, `/bin`, `/sbin`, `/usr/bin`, `/boot`, SSH keys, cron...) and
   detection of added / deleted / modified files.
2. **Hardening (CIS-style) audit** - SSH config, account hygiene, critical file
   permissions, world-writable / unowned / SUID files, kernel `sysctl` settings,
   firewall, auditd, logging, brute-force protection, MAC (AppArmor/SELinux),
   automatic updates, core dumps, cron and sudo settings.

Every result is one JSON line, written to stdout, to `/var/log/fim-hardening.log`,
and optionally to syslog, so any SIEM agent can ship it.

## Does the SIEM do this itself?

| SIEM | FIM | Hardening scan | Notes |
|------|-----|----------------|-------|
| Wazuh | Yes (`syscheck`) | Yes (SCA, CIS policies) | Built into the agent. This script is optional there. |
| Splunk / Elastic / Graylog / Sentinel / QRadar | No | No | They ingest and correlate logs. Use this script (or Wazuh agent, AIDE, OpenSCAP) to *generate* the events. |

## Usage

```bash
sudo install -m 755 security/fim_hardening_scan.sh /usr/local/sbin/fim_hardening_scan.sh

sudo fim_hardening_scan.sh baseline   # once, on a known-good system
sudo fim_hardening_scan.sh check      # detect integrity changes
sudo fim_hardening_scan.sh harden     # run hardening checks
sudo fim_hardening_scan.sh all        # both
```

Exit codes: `0` clean, `1` FIM changes, `2` hardening failures, `3` both.

Environment overrides: `FIM_PATHS`, `FIM_DB`, `FIM_LOG`, `FIM_SYSLOG=1`, `FIM_HOST`.

Re-run `baseline` after every legitimate change (package upgrade, config deploy).

### Schedule it

```cron
# /etc/cron.d/fim-hardening
*/30 * * * * root FIM_SYSLOG=1 /usr/local/sbin/fim_hardening_scan.sh check  >/dev/null 2>&1
0 2 * * *    root FIM_SYSLOG=1 /usr/local/sbin/fim_hardening_scan.sh harden >/dev/null 2>&1
```

## Sending events to the SIEM

**Wazuh agent** - add to `/var/ossec/etc/ossec.conf`:

```xml
<localfile>
  <log_format>json</log_format>
  <location>/var/log/fim-hardening.log</location>
</localfile>
```

Or rely on Wazuh's own modules instead of the script:

```xml
<syscheck>
  <disabled>no</disabled>
  <frequency>1800</frequency>
  <directories check_all="yes" realtime="yes" report_changes="yes">/etc,/usr/bin,/usr/sbin,/bin,/sbin,/boot</directories>
</syscheck>
<sca>
  <enabled>yes</enabled>
  <scan_on_start>yes</scan_on_start>
  <interval>12h</interval>
</sca>
```

**Splunk universal forwarder** - `inputs.conf`:

```ini
[monitor:///var/log/fim-hardening.log]
sourcetype = _json
index = security
```

**Elastic Agent / Filebeat** - `filebeat.yml`:

```yaml
filebeat.inputs:
  - type: filestream
    paths: [/var/log/fim-hardening.log]
    parsers:
      - ndjson: { target: "", add_error_key: true }
```

**Syslog-based SIEMs** - run with `FIM_SYSLOG=1`; events are logged with tag
`fim_hardening_scan` on facility `auth` (warning for high severity, info otherwise).

## Event schema

```json
{"timestamp":"2026-09-08T15:00:29Z","host":"web01","source":"fim_hardening_scan",
 "module":"fim","severity":"high","event":"file_modified",
 "detail":"/etc/passwd changed: content","path":"/etc/passwd",
 "old_sha256":"...","new_sha256":"..."}
```

Alert on `severity:high` and on `event:file_modified|file_deleted|check_fail`.

## Wazuh capability matrix vs. this script

Wazuh is a free, open source SIEM/XDR whose agent already ships the modules
below. The script in this folder covers only the two rows marked **Yes**. If you
deploy Wazuh, keep the script as an independent cross-check or drop it; every
other capability should come from Wazuh itself rather than custom scripts.

| Area | Wazuh capability | Wazuh module | Covered by this script | Recommendation |
|------|------------------|--------------|------------------------|----------------|
| Endpoint Security | File Integrity Monitoring | `syscheck` (real-time, who-data, diff of changes) | Yes (hash/mode/owner, scheduled only) | Use Wazuh `syscheck` with `realtime="yes"` and `whodata="yes"` for audit-grade FIM; script is a fallback for hosts without an agent |
| Endpoint Security | Configuration Assessment (hardening) | SCA with CIS benchmark policies per OS | Yes (~40 CIS-style checks) | Enable SCA; it has hundreds of checks per OS and scores compliance. Script gives a quick subset only |
| Endpoint Security | Malware Detection | Rootcheck, YARA integration, VirusTotal integration, CDB lists | No | Enable `rootcheck`; add YARA rules and VirusTotal API key for hash lookups on FIM events |
| Threat Intelligence | Threat Hunting | Dashboard queries, MITRE ATT&CK mapping on rules | No | Use the Wazuh dashboard MITRE and Threat Hunting modules |
| Threat Intelligence | Log Data Analysis | Log collection, decoders, 3000+ rules | No (script only emits its own events) | Point Wazuh `localfile` at app/system logs; write custom rules for the script's JSON events (see rule example below) |
| Threat Intelligence | Vulnerability Detection | Vulnerability Detector (package inventory vs. NVD/OS feeds) | No | Enable `vulnerability-detection` in `ossec.conf`; it needs no extra tooling |
| Security Operations | Incident Response | Active Response (block IP, kill process, quarantine file) | No | Enable active response for brute-force (rule 5712) and FIM-driven quarantine |
| Security Operations | Regulatory Compliance | PCI DSS, HIPAA, GDPR, NIST 800-53, TSC tags on rules + SCA | Partial (hardening checks only) | Use compliance dashboards; map to NCA ECC via SCA custom policy if needed |
| Security Operations | IT Hygiene | Syscollector inventory (packages, ports, processes, users) | No | Enable `syscollector`; feeds vulnerability detection too |
| Cloud Security | Container Security | Docker listener, Kubernetes audit log ingestion | No | Enable `docker-listener` wodle on container hosts |
| Cloud Security | Posture Management | AWS, Azure, GCP, GitHub, Office 365 log/config modules | No | Configure cloud wodles with read-only credentials |
| Cloud Security | Workload Protection | Agent on cloud VMs + all of the above | No | Install the Wazuh agent on every cloud workload |

### Minimal Wazuh agent config that covers the matrix

```xml
<ossec_config>
  <syscheck>
    <disabled>no</disabled>
    <frequency>1800</frequency>
    <directories check_all="yes" realtime="yes" report_changes="yes" whodata="yes">/etc,/usr/bin,/usr/sbin,/bin,/sbin,/boot</directories>
    <directories check_all="yes" realtime="yes">/root/.ssh,/home</directories>
  </syscheck>
  <rootcheck><disabled>no</disabled></rootcheck>
  <sca><enabled>yes</enabled><scan_on_start>yes</scan_on_start><interval>12h</interval></sca>
  <wodle name="syscollector"><disabled>no</disabled><interval>1h</interval>
    <packages>yes</packages><ports all="no">yes</ports><processes>yes</processes></wodle>
  <localfile><log_format>json</log_format><location>/var/log/fim-hardening.log</location></localfile>
</ossec_config>
```

On the manager, enable vulnerability detection in `/var/ossec/etc/ossec.conf`:

```xml
<vulnerability-detection>
  <enabled>yes</enabled>
  <index-status>yes</index-status>
  <feed-update-interval>60m</feed-update-interval>
</vulnerability-detection>
```

### Custom rule for this script's events

Add to `/var/ossec/etc/rules/local_rules.xml` so script output raises alerts:

```xml
<group name="fim_hardening_scan,">
  <rule id="100200" level="3">
    <decoded_as>json</decoded_as>
    <field name="source">fim_hardening_scan</field>
    <description>fim_hardening_scan event: $(event)</description>
  </rule>
  <rule id="100201" level="10">
    <if_sid>100200</if_sid>
    <field name="severity">high</field>
    <description>fim_hardening_scan HIGH: $(detail)</description>
    <group>pci_dss_11.5,gdpr_II_5.1.f,nist_800_53_SI.7,</group>
  </rule>
</group>
```

Tip from the Wazuh docs: any documentation page is available as Markdown by
replacing `.html` with `.md` in its URL, which is handy for feeding into an LLM.
