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
