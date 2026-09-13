#!/usr/bin/env bash
# validate_siem.sh - Prove, one capability at a time, that the SIEM actually
# detects what the capability matrix claims it detects.
#
# Workflow:
#   1. sudo ./validate_siem.sh clean            # reset baseline + clear test noise
#   2. sudo ./validate_siem.sh list             # see the test catalogue
#   3. sudo ./validate_siem.sh run fim-01       # fire ONE test
#   4. ...look in the SIEM dashboard for the expected alert...
#   5. ./validate_siem.sh record fim-01 pass "rule 550 fired in 12s"
#   6. ./validate_siem.sh report                # the value table, built up test by test
#
# Every test is non-destructive: it creates marked files under a test directory,
# writes synthetic log lines, or reads inventory. Nothing is deleted except the
# artifacts this script itself created.
#
# Env overrides:
#   VS_DIR      working dir for markers/results (default /var/lib/siem-validation)
#   VS_FIMPATH  monitored path to plant FIM test files (default /etc)
#   VS_TAG      marker string embedded in every artifact (default siem-validation)

set -u

VS_DIR="${VS_DIR:-/var/lib/siem-validation}"
VS_FIMPATH="${VS_FIMPATH:-/etc}"
VS_TAG="${VS_TAG:-siem-validation}"
RESULTS="$VS_DIR/results.csv"
ARTIFACTS="$VS_DIR/artifacts.list"

C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_B=$'\033[1m'; C_0=$'\033[0m'
[ -t 1 ] || { C_OK=""; C_WARN=""; C_ERR=""; C_B=""; C_0=""; }

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
need_root() { [ "$(id -u)" -eq 0 ] || echo "${C_WARN}warning: not root; this test may not be able to write to $VS_FIMPATH${C_0}" >&2; }
track()  { mkdir -p "$VS_DIR"; echo "$1" >> "$ARTIFACTS"; }

# ---------------------------------------------------------------- test catalogue
# id | capability | what the test does | where to look | expected signal
catalogue() {
  cat <<'CAT'
fim-01|File Integrity Monitoring|Creates a new file in a monitored directory|Dashboard > Integrity monitoring|rule 554 "File added to the system"
fim-02|File Integrity Monitoring|Modifies that file's contents|Dashboard > Integrity monitoring|rule 550 "Integrity checksum changed"
fim-03|File Integrity Monitoring|Deletes that file|Dashboard > Integrity monitoring|rule 553 "File deleted"
fim-04|FIM who-data|Modifies the file again and records the acting user|Alert fields audit.effective_user / audit.process|who-data fields populated on rule 550
sca-01|Configuration Assessment|Forces an on-demand SCA scan|Dashboard > Configuration assessment|CIS policy score and failed-check list refresh
mal-01|Malware Detection|Writes the EICAR antivirus test string to disk|Dashboard > Malware detection|VirusTotal / YARA / rootcheck alert on the test file
log-01|Log Data Analysis|Writes a synthetic failed-password line to the auth log|Dashboard > Security events|rule 5710 "Attempt to login using a non-existent user"
bf-01|Brute-force + Incident Response|Writes 8 failed-password lines in quick succession|Dashboard > Security events|rule 5712 "SSHD brute force" and active-response firing
ar-01|Incident Response|Reads the local active-response log for a reaction to bf-01|/var/ossec/logs/active-responses.log|firewall-drop or equivalent entry
vul-01|Vulnerability Detection|Reads the package inventory the detector scans|Dashboard > Vulnerabilities|CVE list populated for installed packages
inv-01|IT Hygiene|Reads syscollector inventory counts|Dashboard > Inventory data|non-zero packages / ports / processes
cmp-01|Regulatory Compliance|Checks that generated alerts carry compliance tags|Dashboard > Compliance (PCI DSS / NIST)|alerts tagged pci_dss / nist_800_53
att-01|Threat Hunting|Checks that generated alerts carry MITRE mapping|Dashboard > MITRE ATT&CK|technique IDs on the brute-force alerts
own-01|fim_hardening_scan.sh ingestion|Emits one high-severity event from our own script|Dashboard > Security events|custom rule 100201 "fim_hardening_scan HIGH"
CAT
}

cap_of()  { catalogue | awk -F'|' -v i="$1" '$1==i {print $2}'; }
does_of() { catalogue | awk -F'|' -v i="$1" '$1==i {print $3}'; }
look_of() { catalogue | awk -F'|' -v i="$1" '$1==i {print $4}'; }
sig_of()  { catalogue | awk -F'|' -v i="$1" '$1==i {print $5}'; }
valid_id(){ catalogue | cut -d'|' -f1 | grep -qx "$1"; }

# ---------------------------------------------------------------- helpers
fim_file() { echo "$VS_FIMPATH/${VS_TAG}-marker.conf"; }

auth_log() {
  for f in /var/log/auth.log /var/log/secure; do [ -f "$f" ] && { echo "$f"; return; }; done
  echo /var/log/auth.log
}

fake_auth_line() {
  # A syslog-shaped sshd failure line. Synthetic, written locally, never sent anywhere.
  printf '%s %s sshd[%s]: Failed password for invalid user %s from 192.0.2.77 port %s ssh2\n' \
    "$(date '+%b %e %H:%M:%S')" "$(hostname -s)" "$$" "${VS_TAG}-probe" "$((RANDOM % 60000 + 1024))"
}

announce() {
  local id="$1"
  printf '%s== %s  (%s)%s\n' "$C_B" "$id" "$(cap_of "$id")" "$C_0"
  printf '   fired at : %s\n' "$(now)"
  printf '   action   : %s\n' "$(does_of "$id")"
  printf '   look in  : %s\n' "$(look_of "$id")"
  printf '   expect   : %s\n' "$(sig_of "$id")"
}

verdict_hint() {
  printf '\n   when you have looked, record it:\n'
  printf '     %s record %s pass "what you saw"\n' "$0" "$1"
  printf '     %s record %s fail "what was missing"\n\n' "$0" "$1"
}

# ---------------------------------------------------------------- tests
t_fim_01() {
  need_root; local f; f=$(fim_file)
  printf '# %s created %s\n' "$VS_TAG" "$(now)" > "$f" 2>/dev/null \
    || { echo "${C_ERR}could not write $f${C_0}"; return 1; }
  track "$f"
  echo "   created  : $f"
}

t_fim_02() {
  need_root; local f; f=$(fim_file)
  [ -f "$f" ] || { echo "${C_ERR}run fim-01 first${C_0}"; return 1; }
  printf '# %s modified %s\n' "$VS_TAG" "$(now)" >> "$f"
  echo "   modified : $f"
  echo "   sha256   : $(sha256sum "$f" | cut -d' ' -f1)"
}

t_fim_03() {
  need_root; local f; f=$(fim_file)
  [ -f "$f" ] || { echo "${C_ERR}run fim-01 first${C_0}"; return 1; }
  rm -f "$f"
  echo "   deleted  : $f"
}

t_fim_04() {
  need_root; local f; f=$(fim_file)
  [ -f "$f" ] || { t_fim_01 || return 1; }
  printf '# %s who-data probe %s\n' "$VS_TAG" "$(now)" >> "$f"
  echo "   modified : $f"
  echo "   acting as: uid=$(id -u) user=$(id -un) pid=$$"
  echo "   the alert should name that user and process; if those fields are"
  echo "   absent, whodata is off or auditd is not running."
}

t_sca_01() {
  if [ -x /var/ossec/bin/wazuh-control ]; then
    echo "   restarting agent modules to force an SCA scan..."
    /var/ossec/bin/wazuh-control restart >/dev/null 2>&1 \
      && echo "   ${C_OK}agent restarted; SCA scan runs on start${C_0}" \
      || echo "   ${C_ERR}restart failed; run it yourself${C_0}"
  else
    echo "   ${C_WARN}no Wazuh agent on this host${C_0}"
    echo "   on the agent host run: sudo /var/ossec/bin/wazuh-control restart"
  fi
  echo "   scan_on_start must be yes in the <sca> block for this to fire."
}

t_mal_01() {
  mkdir -p "$VS_DIR"
  local f="$VS_DIR/${VS_TAG}-eicar.txt"
  # EICAR: the industry-standard harmless antivirus test file. Split so this
  # script itself is not flagged while it sits in git.
  local p1='X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR'
  local p2='-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
  printf '%s%s\n' "$p1" "$p2" > "$f"
  track "$f"
  echo "   wrote    : $f"
  echo "   sha256   : $(sha256sum "$f" | cut -d' ' -f1)"
  echo "   this is the EICAR test string. It is not malware; it exists so you"
  echo "   can prove detection works without handling a real sample."
}

t_log_01() {
  need_root; local log; log=$(auth_log)
  fake_auth_line >> "$log" 2>/dev/null \
    || { echo "${C_ERR}could not append to $log${C_0}"; return 1; }
  echo "   appended : 1 synthetic failure to $log"
  echo "   source IP: 192.0.2.77 (TEST-NET-1, reserved for documentation)"
}

t_bf_01() {
  need_root; local log i; log=$(auth_log)
  for i in $(seq 1 8); do fake_auth_line >> "$log" 2>/dev/null || {
      echo "${C_ERR}could not append to $log${C_0}"; return 1; }; done
  echo "   appended : 8 synthetic failures to $log"
  echo "   rule 5712 needs 8 in 120s by default, so this should trip it."
}

t_ar_01() {
  local arlog=/var/ossec/logs/active-responses.log
  if [ -r "$arlog" ]; then
    echo "   last 10 lines of $arlog:"
    tail -10 "$arlog" | sed 's/^/     /'
    [ -s "$arlog" ] || echo "     (empty - no active response has ever fired)"
  else
    echo "   ${C_WARN}$arlog not readable here${C_0}"
    echo "   run on the agent host: sudo tail -20 $arlog"
  fi
}

t_vul_01() {
  if command -v dpkg-query >/dev/null; then
    echo "   packages installed: $(dpkg-query -f '.\n' -W 2>/dev/null | wc -l)"
  elif command -v rpm >/dev/null; then
    echo "   packages installed: $(rpm -qa 2>/dev/null | wc -l)"
  else
    echo "   ${C_WARN}no dpkg/rpm found${C_0}"
  fi
  echo "   the detector correlates this inventory against CVE feeds."
  echo "   a healthy result is a non-empty CVE list, NOT zero findings."
  echo "   zero usually means the feed never downloaded."
}

t_inv_01() {
  local db=/var/ossec/queue/syscollector
  if [ -d "$db" ]; then echo "   ${C_OK}syscollector data present at $db${C_0}"
  else echo "   ${C_WARN}no local syscollector data; check the dashboard instead${C_0}"; fi
  echo "   host facts this capability should be reporting:"
  echo "     processes : $(ps -e 2>/dev/null | wc -l)"
  echo "     listening : $(ss -tuln 2>/dev/null | tail -n +2 | wc -l)"
  echo "     users     : $(wc -l < /etc/passwd)"
  echo "   compare these against Inventory data in the dashboard. They should match."
}

t_cmp_01() {
  echo "   this test reads, it does not trigger."
  echo "   open the brute-force alert from bf-01 and expand its rule block."
  echo "   a compliance-tagged alert carries fields like:"
  echo "     rule.pci_dss: [\"10.2.4\", \"10.2.5\"]"
  echo "     rule.nist_800_53: [\"AU.14\", \"AC.7\"]"
  echo "     rule.gdpr: [\"IV_35.7.d\"]"
  echo "   if those arrays are absent, the ruleset is stripped or out of date."
}

t_att_01() {
  echo "   this test reads, it does not trigger."
  echo "   open the same brute-force alert and look for:"
  echo "     rule.mitre.id: [\"T1110\"]   (Brute Force)"
  echo "     rule.mitre.tactic: [\"Credential Access\"]"
  echo "   then confirm it appears under the MITRE ATT&CK dashboard."
}

t_own_01() {
  local script; script="$(dirname "$0")/fim_hardening_scan.sh"
  if [ -x "$script" ]; then
    echo "   running the hardening scan to emit real events..."
    FIM_SYSLOG=1 "$script" harden >/dev/null 2>&1
    local rc=$?
    echo "   exit code: $rc (2 or 3 means hardening failures were found and logged)"
    echo "   log tail :"
    tail -3 /var/log/fim-hardening.log 2>/dev/null | sed 's/^/     /' \
      || echo "     (no /var/log/fim-hardening.log yet)"
  else
    echo "   ${C_ERR}fim_hardening_scan.sh not found next to this script${C_0}"
    return 1
  fi
  echo "   custom rule 100201 must exist in local_rules.xml for these to alert."
}

# ---------------------------------------------------------------- commands
cmd_list() {
  printf '%s%-8s %-34s %s%s\n' "$C_B" "TEST" "CAPABILITY" "RECORDED" "$C_0"
  catalogue | while IFS='|' read -r id cap _ _ _; do
    local v=""
    [ -f "$RESULTS" ] && v=$(awk -F',' -v i="$id" '$2==i {print $3}' "$RESULTS" | tail -1)
    case "$v" in
      pass) v="${C_OK}pass${C_0}" ;;
      fail) v="${C_ERR}fail${C_0}" ;;
      *)    v="${C_WARN}not run${C_0}" ;;
    esac
    printf '%-8s %-34s %b\n' "$id" "$cap" "$v"
  done
  printf '\nrun one with: %s run <TEST>\n' "$0"
}

cmd_run() {
  local id="${1:-}"
  [ -n "$id" ] || { echo "usage: $0 run <test-id>   (see: $0 list)"; exit 64; }
  valid_id "$id" || { echo "${C_ERR}unknown test '$id'${C_0}  (see: $0 list)"; exit 64; }
  mkdir -p "$VS_DIR"
  announce "$id"
  echo
  case "$id" in
    fim-01) t_fim_01 ;; fim-02) t_fim_02 ;; fim-03) t_fim_03 ;; fim-04) t_fim_04 ;;
    sca-01) t_sca_01 ;; mal-01) t_mal_01 ;; log-01) t_log_01 ;; bf-01)  t_bf_01 ;;
    ar-01)  t_ar_01  ;; vul-01) t_vul_01 ;; inv-01) t_inv_01 ;; cmp-01) t_cmp_01 ;;
    att-01) t_att_01 ;; own-01) t_own_01 ;;
  esac
  verdict_hint "$id"
}

cmd_record() {
  local id="${1:-}" v="${2:-}" note="${3:-}"
  [ -n "$id" ] && [ -n "$v" ] || { echo "usage: $0 record <test-id> pass|fail [note]"; exit 64; }
  valid_id "$id" || { echo "${C_ERR}unknown test '$id'${C_0}"; exit 64; }
  case "$v" in pass|fail) ;; *) echo "verdict must be pass or fail"; exit 64 ;; esac
  mkdir -p "$VS_DIR"
  [ -f "$RESULTS" ] || echo "timestamp,test,verdict,capability,note" > "$RESULTS"
  printf '%s,%s,%s,"%s","%s"\n' "$(now)" "$id" "$v" "$(cap_of "$id")" "${note//\"/\'}" >> "$RESULTS"
  echo "recorded: $id = $v"
}

cmd_report() {
  [ -f "$RESULTS" ] || { echo "nothing recorded yet. Start with: $0 run fim-01"; exit 0; }
  local total pass fail
  total=$(catalogue | wc -l)
  pass=$(awk -F',' '$3=="pass"{print $2}' "$RESULTS" | sort -u | wc -l)
  fail=$(awk -F',' '$3=="fail"{print $2}' "$RESULTS" | sort -u | wc -l)

  printf '%sSIEM capability validation%s\n' "$C_B" "$C_0"
  printf 'host: %s   generated: %s\n\n' "$(hostname -f 2>/dev/null || hostname)" "$(now)"
  printf '| %-8s | %-32s | %-8s | %s\n' "Test" "Capability" "Verdict" "Evidence"
  printf '|%s|%s|%s|%s\n' "----------" "----------------------------------" "----------" "---------------"
  catalogue | cut -d'|' -f1 | while read -r id; do
    local line v note
    line=$(awk -F',' -v i="$id" '$2==i' "$RESULTS" | tail -1)
    if [ -z "$line" ]; then v="not run"; note=""
    else v=$(echo "$line" | cut -d',' -f3); note=$(echo "$line" | cut -d',' -f5- | tr -d '"'); fi
    printf '| %-8s | %-32s | %-8s | %s\n' "$id" "$(cap_of "$id")" "$v" "$note"
  done
  printf '\n%d of %d tests passed, %d failed, %d not yet run.\n' \
    "$pass" "$total" "$fail" "$((total - pass - fail))"
  printf 'raw results: %s\n' "$RESULTS"
}

cmd_clean() {
  echo "${C_B}Cleaning validation state${C_0}"
  # 1. artifacts this script created
  if [ -f "$ARTIFACTS" ]; then
    local n=0
    while IFS= read -r f; do
      [ -n "$f" ] && [ -e "$f" ] && rm -f "$f" && n=$((n+1))
    done < "$ARTIFACTS"
    : > "$ARTIFACTS"
    echo "  removed $n test artifact(s) this script had created"
  else
    echo "  no tracked artifacts to remove"
  fi
  # 2. our own scan log + baseline
  [ -f /var/log/fim-hardening.log ] && { : > /var/log/fim-hardening.log; echo "  truncated /var/log/fim-hardening.log"; }
  local base="${FIM_DB:-/var/lib/fim/baseline.db}"
  if [ -f "$base" ]; then
    rm -f "$base"; echo "  removed stale FIM baseline $base"
  fi
  local scan; scan="$(dirname "$0")/fim_hardening_scan.sh"
  if [ -x "$scan" ]; then
    "$scan" baseline >/dev/null 2>&1 && echo "  rebuilt FIM baseline from current known-good state"
  fi
  # 3. results - only on explicit request
  if [ "${1:-}" = "--results" ]; then
    rm -f "$RESULTS"; echo "  cleared recorded verdicts"
  else
    echo "  kept recorded verdicts (add --results to clear them too)"
  fi
  # 4. SIEM-side noise: print, never execute
  cat <<'NOTE'

  SIEM-side cleanup is NOT run by this script, because deleting indices is
  irreversible. If you want a clean alert window before testing, either:
    a) note the current time and filter the dashboard to "after now", or
    b) on the indexer, delete only the day's alert index yourself, e.g.
         curl -k -u admin:<pw> -XDELETE \
           "https://localhost:9200/wazuh-alerts-4.x-$(date +%Y.%m.%d)"
  Option (a) is safer and gives you the same clean read.
NOTE
  echo
  echo "Ready. Next: $0 list"
}

usage() {
  cat <<USAGE
validate_siem.sh - prove each SIEM capability one test at a time

  clean [--results]     reset baseline and test artifacts before a run
  list                  show all tests and what has been recorded
  run <test-id>         fire exactly one test
  record <id> pass|fail [note]
                        write down what the SIEM actually showed
  report                render the value table from recorded verdicts

Typical session:
  sudo $0 clean
  sudo $0 run fim-01        # then look in the dashboard
  $0 record fim-01 pass "rule 554 in 8s"
  sudo $0 run fim-02
  ...
  $0 report
USAGE
}

case "${1:-}" in
  clean)  shift; cmd_clean "$@" ;;
  list)   cmd_list ;;
  run)    shift; cmd_run "$@" ;;
  record) shift; cmd_record "$@" ;;
  report) cmd_report ;;
  ""|-h|--help|help) usage ;;
  *) echo "unknown command: $1"; echo; usage; exit 64 ;;
esac
