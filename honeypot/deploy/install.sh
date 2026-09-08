#!/usr/bin/env bash
# One-command installer for honey-bit on a Linux server (systemd based:
# Ubuntu, Debian, RHEL, Rocky, Alma, Amazon Linux).
#
# Usage (run as root on the server):
#   sudo bash install.sh --siem 10.0.0.5:514 [--format json|cef] [--proto udp|tcp] [--redirect] [--sensor NAME]
#
# --redirect adds iptables NAT rules so the real ports 22/80/23/21 forward to the
# honeypot's unprivileged ports. Only use it on a dedicated machine where port 22
# is not your admin SSH.
set -euo pipefail

SIEM=""; FORMAT="json"; PROTO="udp"; REDIRECT="no"; SENSOR="$(hostname)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --siem) SIEM="$2"; shift 2;;
    --format) FORMAT="$2"; shift 2;;
    --proto) PROTO="$2"; shift 2;;
    --sensor) SENSOR="$2"; shift 2;;
    --redirect) REDIRECT="yes"; shift;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "unknown option $1" >&2; exit 1;;
  esac
done
[[ -n "$SIEM" ]] || { echo "error: --siem HOST:PORT is required" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "error: run as root (sudo)" >&2; exit 1; }
command -v python3 >/dev/null || { echo "error: python3 not found. Install it (apt install python3 / dnf install python3)" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR=/opt/honey-bit
LOG_DIR=/var/log/honey-bit
USER=honeybit

echo "==> creating user $USER"
id -u $USER >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin $USER

echo "==> installing to $INSTALL_DIR"
mkdir -p $INSTALL_DIR $LOG_DIR
cp "$SRC"/honeypot.py "$SRC"/simulate_attacks.py $INSTALL_DIR/
chmod 755 $INSTALL_DIR/*.py
chown -R $USER:$USER $LOG_DIR
chmod 750 $LOG_DIR   # captured passwords live here; keep it private

echo "==> writing config"
cat > $INSTALL_DIR/honeypot.json <<JSON
{
  "bind": "0.0.0.0",
  "listen": ["ssh:2222", "http:8080", "telnet:2323", "ftp:2121"],
  "log_file": "$LOG_DIR/events.jsonl",
  "syslog": "$SIEM",
  "syslog_proto": "$PROTO",
  "syslog_format": "$FORMAT",
  "sensor_name": "$SENSOR",
  "quiet": true
}
JSON

echo "==> installing systemd service"
cat > /etc/systemd/system/honey-bit.service <<UNIT
[Unit]
Description=honey-bit honeypot (SIEM test sensor)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
Group=$USER
ExecStart=/usr/bin/python3 $INSTALL_DIR/honeypot.py --config $INSTALL_DIR/honeypot.json
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$LOG_DIR
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/logrotate.d/honey-bit <<ROT
$LOG_DIR/events.jsonl {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
ROT

systemctl daemon-reload
systemctl enable --now honey-bit
sleep 1
systemctl --no-pager --lines=5 status honey-bit || true

if [[ "$REDIRECT" == "yes" ]]; then
  echo "==> adding iptables redirects 22->2222 80->8080 23->2323 21->2121"
  command -v iptables >/dev/null || { echo "iptables not found; skipping redirect" >&2; REDIRECT="no"; }
fi
if [[ "$REDIRECT" == "yes" ]]; then
  for pair in 22:2222 80:8080 23:2323 21:2121; do
    from=${pair%%:*}; to=${pair##*:}
    iptables -t nat -C PREROUTING -p tcp --dport $from -j REDIRECT --to-port $to 2>/dev/null || \
    iptables -t nat -A PREROUTING -p tcp --dport $from -j REDIRECT --to-port $to
  done
  echo "    NOTE: rules are not persistent across reboot. Install iptables-persistent / netfilter-persistent to keep them."
fi

cat <<DONE

honey-bit is running.
  service:   systemctl status honey-bit     |  journalctl -u honey-bit -f
  events:    tail -f $LOG_DIR/events.jsonl
  syslog ->  $SIEM ($PROTO, $FORMAT)
  ports:     ssh 2222, http 8080, telnet 2323, ftp 2121$( [[ $REDIRECT == yes ]] && echo " (+ redirects from 22/80/23/21)")

Test it from another machine:
  python3 simulate_attacks.py --host $(hostname -I 2>/dev/null | awk '{print $1}') --scenario all --count 5 --seed 42
Then search your SIEM for sensor="$SENSOR".
DONE
