#!/usr/bin/env bash
# fim_hardening_scan.sh - File Integrity Monitoring (FIM) + Linux hardening audit
#
# Produces JSON-lines events that any SIEM can ingest (Wazuh, Splunk, Elastic,
# Graylog, Sentinel...). Events go to stdout, to a log file, and optionally to
# syslog so a forwarder/agent can pick them up.
#
# Usage:
#   sudo ./fim_hardening_scan.sh baseline        # record hashes/perms of monitored paths
#   sudo ./fim_hardening_scan.sh check           # compare current state with baseline
#   sudo ./fim_hardening_scan.sh harden          # run hardening (CIS-style) checks
#   sudo ./fim_hardening_scan.sh all             # check + harden
#
# Options (env vars):
#   FIM_PATHS   - space-separated paths to monitor (default: critical system dirs)
#   FIM_DB      - baseline database file    (default: /var/lib/fim/baseline.db)
#   FIM_LOG     - JSON-lines output log     (default: /var/log/fim-hardening.log)
#   FIM_SYSLOG  - "1" to also send events to syslog via logger (default: 0)
#   FIM_HOST    - hostname reported in events (default: $(hostname -f))
#
# Exit codes: 0 = clean, 1 = FIM changes detected, 2 = hardening failures, 3 = both

set -u

FIM_PATHS="${FIM_PATHS:-/etc /bin /sbin /usr/bin /usr/sbin /usr/local/bin /usr/local/sbin /boot /root/.ssh /home/*/.ssh /var/spool/cron /etc/cron.d}"
FIM_DB="${FIM_DB:-/var/lib/fim/baseline.db}"
FIM_LOG="${FIM_LOG:-/var/log/fim-hardening.log}"
FIM_SYSLOG="${FIM_SYSLOG:-0}"
FIM_HOST="${FIM_HOST:-$(hostname -f 2>/dev/null || hostname)}"

fim_changes=0
harden_failures=0

# ---------- helpers ----------
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n'; }

emit() {
  # emit <module> <severity> <event> <detail> [extra-json]
  local module="$1" sev="$2" event="$3" detail="$4" extra="${5:-}"
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local line
  line=$(printf '{"timestamp":"%s","host":"%s","source":"fim_hardening_scan","module":"%s","severity":"%s","event":"%s","detail":"%s"%s}' \
    "$ts" "$(json_escape "$FIM_HOST")" "$module" "$sev" "$(json_escape "$event")" "$(json_escape "$detail")" \
    "${extra:+,$extra}")
  echo "$line"
  { mkdir -p "$(dirname "$FIM_LOG")" && echo "$line" >> "$FIM_LOG"; } 2>/dev/null || true
  if [ "$FIM_SYSLOG" = "1" ] && command -v logger >/dev/null; then
    logger -t fim_hardening_scan -p "auth.$( [ "$sev" = "high" ] && echo warning || echo info )" -- "$line"
  fi
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "warning: not running as root; some files/checks will be skipped" >&2
  fi
}

# ---------- FIM ----------
snapshot() {
  # Output: sha256|mode|uid|gid|size|path   (sorted by path)
  local p
  # shellcheck disable=SC2086
  for p in $FIM_PATHS; do
    [ -e "$p" ] || continue
    find "$p" -xdev -type f 2>/dev/null
  done | sort -u | while IFS= read -r f; do
    local st hash
    st=$(stat -c '%a|%u|%g|%s' -- "$f" 2>/dev/null) || continue
    hash=$(sha256sum -- "$f" 2>/dev/null | cut -d' ' -f1) || hash="unreadable"
    printf '%s|%s|%s\n' "$hash" "$st" "$f"
  done
}

fim_baseline() {
  require_root
  mkdir -p "$(dirname "$FIM_DB")"
  local tmp; tmp=$(mktemp)
  snapshot > "$tmp"
  mv "$tmp" "$FIM_DB"
  chmod 600 "$FIM_DB"
  emit fim info baseline_created "Baseline written to $FIM_DB" "\"files\":$(wc -l < "$FIM_DB")"
}

fim_check() {
  require_root
  if [ ! -f "$FIM_DB" ]; then
    emit fim high baseline_missing "No baseline at $FIM_DB - run 'baseline' first"
    fim_changes=1
    return
  fi
  local cur; cur=$(mktemp)
  snapshot > "$cur"

  # Index by path
  local old_idx new_idx
  old_idx=$(mktemp); new_idx=$(mktemp)
  awk -F'|' '{print $6"\t"$0}' "$FIM_DB" | sort > "$old_idx"
  awk -F'|' '{print $6"\t"$0}' "$cur"    | sort > "$new_idx"

  # deleted
  join -t $'\t' -v1 "$old_idx" "$new_idx" | cut -f1 | while IFS= read -r f; do
    emit fim high file_deleted "$f" "\"path\":\"$(json_escape "$f")\""
  done
  # added
  join -t $'\t' -v2 "$old_idx" "$new_idx" | cut -f1 | while IFS= read -r f; do
    emit fim medium file_added "$f" "\"path\":\"$(json_escape "$f")\""
  done
  # modified (present in both but record differs)
  join -t $'\t' "$old_idx" "$new_idx" | awk -F'\t' '$2 != $3 {print $2"\t"$3}' | while IFS=$'\t' read -r o n; do
    local of om ou og nf nm nu ng path
    IFS='|' read -r of om ou og _ path <<<"$o"
    IFS='|' read -r nf nm nu ng _ _    <<<"$n"
    local what=""
    [ "$of" != "$nf" ] && what="content"
    [ "$om" != "$nm" ] && what="${what:+$what,}mode($om->$nm)"
    [ "$ou$og" != "$nu$ng" ] && what="${what:+$what,}owner($ou:$og->$nu:$ng)"
    emit fim high file_modified "$path changed: $what" \
      "\"path\":\"$(json_escape "$path")\",\"old_sha256\":\"$of\",\"new_sha256\":\"$nf\""
  done

  local n
  n=$(( $(join -t $'\t' -v1 "$old_idx" "$new_idx" | wc -l) \
      + $(join -t $'\t' -v2 "$old_idx" "$new_idx" | wc -l) \
      + $(join -t $'\t' "$old_idx" "$new_idx" | awk -F'\t' '$2 != $3' | wc -l) ))
  if [ "$n" -gt 0 ]; then
    fim_changes=1
    emit fim high fim_summary "$n integrity change(s) detected" "\"changes\":$n"
  else
    emit fim info fim_summary "No integrity changes" "\"changes\":0"
  fi
  rm -f "$cur" "$old_idx" "$new_idx"
}

# ---------- Hardening ----------
pass() { emit hardening info  check_pass "$1" "\"check\":\"$2\",\"result\":\"pass\""; }
fail() { emit hardening high  check_fail "$1" "\"check\":\"$2\",\"result\":\"fail\""; harden_failures=1; }
warn() { emit hardening medium check_warn "$1" "\"check\":\"$2\",\"result\":\"warn\""; }

sshd_opt() {  # sshd_opt <Key> -> effective value (lowercase) or ""
  if command -v sshd >/dev/null; then
    sshd -T 2>/dev/null | awk -v k="$(echo "$1" | tr 'A-Z' 'a-z')" '$1==k {print tolower($2)}'
  else
    grep -Ei "^\s*$1\s+" /etc/ssh/sshd_config 2>/dev/null | tail -1 | awk '{print tolower($2)}'
  fi
}

sysctl_is() { [ "$(sysctl -n "$1" 2>/dev/null)" = "$2" ]; }

hardening_scan() {
  require_root

  # -- SSH --
  if [ -f /etc/ssh/sshd_config ]; then
    v=$(sshd_opt PermitRootLogin)
    case "$v" in no|prohibit-password|without-password) pass "SSH root login restricted ($v)" ssh_root_login ;;
      *) fail "SSH PermitRootLogin is '${v:-unset(default yes)}'" ssh_root_login ;; esac
    v=$(sshd_opt PasswordAuthentication)
    [ "$v" = "no" ] && pass "SSH password auth disabled" ssh_password_auth || warn "SSH PasswordAuthentication is '${v:-unset}'" ssh_password_auth
    v=$(sshd_opt PermitEmptyPasswords)
    [ "$v" = "yes" ] && fail "SSH permits empty passwords" ssh_empty_passwords || pass "SSH empty passwords disabled" ssh_empty_passwords
    v=$(sshd_opt X11Forwarding)
    [ "$v" = "yes" ] && warn "SSH X11Forwarding enabled" ssh_x11 || pass "SSH X11Forwarding disabled" ssh_x11
    v=$(sshd_opt MaxAuthTries)
    [ -n "$v" ] && [ "$v" -le 4 ] 2>/dev/null && pass "SSH MaxAuthTries=$v" ssh_maxauthtries || warn "SSH MaxAuthTries is '${v:-default 6}' (recommend <=4)" ssh_maxauthtries
  else
    pass "sshd not installed" ssh_installed
  fi

  # -- Accounts --
  if awk -F: '($2 == "" ) {found=1} END {exit !found}' /etc/shadow 2>/dev/null; then
    fail "Accounts with empty password in /etc/shadow" empty_passwords
  else
    pass "No empty-password accounts" empty_passwords
  fi
  extra_root=$(awk -F: '$3 == 0 && $1 != "root" {print $1}' /etc/passwd | tr '\n' ',')
  [ -n "$extra_root" ] && fail "Non-root accounts with UID 0: $extra_root" uid0_accounts || pass "Only root has UID 0" uid0_accounts
  pmax=$(grep -E '^\s*PASS_MAX_DAYS' /etc/login.defs 2>/dev/null | awk '{print $2}')
  [ -n "$pmax" ] && [ "$pmax" -le 365 ] 2>/dev/null && pass "PASS_MAX_DAYS=$pmax" password_max_days || warn "PASS_MAX_DAYS is '${pmax:-unset}' (recommend <=365)" password_max_days
  umask_v=$(grep -E '^\s*UMASK' /etc/login.defs 2>/dev/null | awk '{print $2}')
  case "$umask_v" in 027|077) pass "Default UMASK=$umask_v" default_umask ;; *) warn "Default UMASK is '${umask_v:-unset}' (recommend 027)" default_umask ;; esac

  # -- Critical file permissions --
  check_perm() {  # <file> <max-mode-regex> <owner>
    [ -e "$1" ] || return 0
    m=$(stat -c '%a' "$1"); o=$(stat -c '%U' "$1")
    if echo "$m" | grep -Eq "$2" && [ "$o" = "$3" ]; then pass "$1 mode $m owner $o" "perm_$(basename "$1")"
    else fail "$1 mode $m owner $o (expected $2 / $3)" "perm_$(basename "$1")"; fi
  }
  check_perm /etc/passwd   '^644$' root
  check_perm /etc/shadow   '^(0|400|640)$' root
  check_perm /etc/gshadow  '^(0|400|640)$' root
  check_perm /etc/group    '^644$' root
  check_perm /etc/sudoers  '^440$' root
  check_perm /etc/ssh/sshd_config '^(600|644)$' root
  check_perm /etc/crontab  '^600$' root
  check_perm /boot/grub/grub.cfg '^(400|600)$' root

  # -- World-writable files / unowned files / SUID --
  ww=$(find / -xdev -type f -perm -0002 ! -path '/proc/*' ! -path '/sys/*' 2>/dev/null | head -20 | tr '\n' ',')
  [ -n "$ww" ] && warn "World-writable files: $ww" world_writable || pass "No world-writable files" world_writable
  nouser=$(find / -xdev \( -nouser -o -nogroup \) ! -path '/proc/*' 2>/dev/null | head -20 | tr '\n' ',')
  [ -n "$nouser" ] && warn "Unowned files: $nouser" unowned_files || pass "No unowned files" unowned_files
  suid_n=$(find / -xdev -type f \( -perm -4000 -o -perm -2000 \) 2>/dev/null | wc -l)
  emit hardening info suid_inventory "$suid_n SUID/SGID binaries present (review list)" "\"check\":\"suid_inventory\",\"count\":$suid_n"

  # -- Kernel / sysctl --
  sysctl_is net.ipv4.ip_forward 0                    && pass "IP forwarding disabled" sysctl_ip_forward || warn "net.ipv4.ip_forward != 0" sysctl_ip_forward
  sysctl_is net.ipv4.tcp_syncookies 1                && pass "TCP syncookies on" sysctl_syncookies || fail "net.ipv4.tcp_syncookies != 1" sysctl_syncookies
  sysctl_is net.ipv4.conf.all.rp_filter 1            && pass "Reverse path filtering on" sysctl_rp_filter || warn "net.ipv4.conf.all.rp_filter != 1" sysctl_rp_filter
  sysctl_is net.ipv4.conf.all.accept_redirects 0     && pass "ICMP redirects rejected" sysctl_redirects || warn "net.ipv4.conf.all.accept_redirects != 0" sysctl_redirects
  sysctl_is net.ipv4.conf.all.accept_source_route 0  && pass "Source routing rejected" sysctl_source_route || warn "accept_source_route != 0" sysctl_source_route
  sysctl_is net.ipv4.conf.all.log_martians 1         && pass "Martian packets logged" sysctl_martians || warn "log_martians != 1" sysctl_martians
  sysctl_is kernel.randomize_va_space 2              && pass "ASLR fully enabled" sysctl_aslr || fail "kernel.randomize_va_space != 2" sysctl_aslr
  sysctl_is fs.suid_dumpable 0                       && pass "SUID core dumps disabled" sysctl_suid_dumpable || warn "fs.suid_dumpable != 0" sysctl_suid_dumpable
  if sysctl_is kernel.kptr_restrict 1 || sysctl_is kernel.kptr_restrict 2; then pass "Kernel pointers restricted" sysctl_kptr; else warn "kernel.kptr_restrict < 1" sysctl_kptr; fi

  # -- Services --
  svc_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
  if svc_active ufw || svc_active firewalld || svc_active nftables || iptables -S 2>/dev/null | grep -q -- '-P INPUT DROP'; then
    pass "Host firewall active" firewall
  else
    fail "No active host firewall (ufw/firewalld/nftables/iptables DROP policy)" firewall
  fi
  svc_active auditd && pass "auditd running" auditd || warn "auditd not running" auditd
  { svc_active rsyslog || svc_active syslog-ng || svc_active systemd-journald; } && pass "System logging active" logging || fail "No logging daemon running" logging
  if svc_active fail2ban || svc_active sshguard; then pass "Brute-force protection running" bruteforce_protection; else warn "No fail2ban/sshguard" bruteforce_protection; fi
  for s in telnet rsh rlogin tftp vsftpd xinetd avahi-daemon cups; do
    svc_active "$s" && warn "Legacy/unnecessary service running: $s" "service_$s"
  done
  if [ -f /etc/apt/apt.conf.d/20auto-upgrades ] && grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then
    pass "Unattended upgrades enabled" auto_updates
  elif svc_active dnf-automatic.timer || svc_active yum-cron; then
    pass "Automatic updates enabled" auto_updates
  else
    warn "Automatic security updates not configured" auto_updates
  fi
  if command -v aa-status >/dev/null && aa-status --enabled 2>/dev/null; then pass "AppArmor enabled" mac
  elif command -v getenforce >/dev/null && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then pass "SELinux enforcing" mac
  else warn "No MAC (AppArmor/SELinux) enforcing" mac; fi

  # -- Misc --
  if grep -Eq '^\s*\*\s+hard\s+core\s+0' /etc/security/limits.conf /etc/security/limits.d/* 2>/dev/null; then pass "Core dumps limited" core_dumps; else warn "Core dumps not limited in limits.conf" core_dumps; fi
  [ -f /etc/cron.allow ] && pass "cron.allow present" cron_allow || warn "/etc/cron.allow missing (cron open to all users)" cron_allow
  if [ -f /etc/issue.net ] && [ -s /etc/issue.net ]; then pass "Login banner configured" login_banner; else warn "No /etc/issue.net login banner" login_banner; fi
  if grep -Eq '^\s*Defaults\s+.*use_pty' /etc/sudoers /etc/sudoers.d/* 2>/dev/null; then pass "sudo use_pty set" sudo_use_pty; else warn "sudo use_pty not set" sudo_use_pty; fi

  if [ "$harden_failures" -eq 1 ]; then
    emit hardening high hardening_summary "Hardening scan completed with failures" "\"result\":\"fail\""
  else
    emit hardening info hardening_summary "Hardening scan completed" "\"result\":\"pass\""
  fi
}

# ---------- main ----------
case "${1:-}" in
  baseline) fim_baseline ;;
  check)    fim_check ;;
  harden)   hardening_scan ;;
  all)      fim_check; hardening_scan ;;
  *) sed -n '2,20p' "$0"; exit 64 ;;
esac

rc=0
[ "$fim_changes" -eq 1 ] && rc=$((rc | 1))
[ "$harden_failures" -eq 1 ] && rc=$((rc | 2))
exit $rc
