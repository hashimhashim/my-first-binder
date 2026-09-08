# Deploying honey-bit on a server the SIEM can reach

Pick one of the three options. All of them need only Python 3 on the server
and a network path from the server to the SIEM's syslog port (UDP or TCP 514).

## Option A: one command, systemd (recommended)

On the server, as root:

```bash
git clone https://github.com/hashimhashim/my-first-binder.git
cd my-first-binder/honeypot
sudo bash deploy/install.sh --siem <SIEM-IP>:514 --sensor honey-bit-01
# add --format cef for CEF-based SIEMs, --proto tcp for reliable delivery,
# --redirect to also forward real ports 22/80/23/21 (dedicated machine only)
```

The script creates an unprivileged `honeybit` user, installs to
`/opt/honey-bit`, writes `/opt/honey-bit/honeypot.json`, starts a hardened
systemd service (`honey-bit`), and rotates `/var/log/honey-bit/events.jsonl`
daily.

Manage it with:

```bash
systemctl status honey-bit
journalctl -u honey-bit -f
sudo nano /opt/honey-bit/honeypot.json && sudo systemctl restart honey-bit
```

## Option B: Docker

```bash
git clone https://github.com/hashimhashim/my-first-binder.git
cd my-first-binder/honeypot
# edit SIEM in deploy/docker-compose.yml, then:
docker compose -f deploy/docker-compose.yml up -d
docker logs -f honey-bit
```

## Option C: no install, just run it

```bash
python3 honeypot.py --syslog <SIEM-IP>:514 --sensor-name honey-bit-01
```

## Firewall

Inbound to the server: allow the honeypot ports (2222, 8080, 2323, 2121, or
22/80/23/21 if redirected) from wherever the test traffic comes from.
Outbound from the server: allow UDP/TCP 514 to the SIEM. Nothing else is needed.

## Verify

1. `journalctl -u honey-bit -n 3` should show `listening ssh on 0.0.0.0:2222` etc.
2. In the SIEM, search for the `honeypot_start` event with your sensor name.
   If it is not there, the problem is network/firewall or the SIEM input, not
   the honeypot. Test with `nc -u -w1 <SIEM-IP> 514 <<< "test"` from the server.
3. From another machine run
   `python3 simulate_attacks.py --host <SERVER-IP> --scenario all --count 5 --seed 42`
   and check the expected counts in `TESTING.md`.
