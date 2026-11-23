#!/bin/bash
# Schedule the orphaned-work self-scan on a Molibra node (run ON node 2).
# Daily: values every orphan in chain.json and folds what each address is owed
# into recover-claims.json. Moves NO money. Payout stays recover-tool.mjs.
#
# Usage:  REPO=/path/to/molibra [CHAIN=/path/to/chain.json] bash recover_schedule.sh
set -e

REPO="${REPO:-$HOME/molibra}"
[ -d "$REPO" ] || { echo "repo not found at $REPO (set REPO=...)"; exit 1; }
cd "$REPO"

NODE_BIN="$(command -v node)"
RUN_USER="$(id -un)"

# Locate chain.json if not given: search common datadir spots, newest first.
if [ -z "$CHAIN" ]; then
  CHAIN="$(find "$REPO" "$HOME" /var/lib 2>/dev/null -name chain.json -type f -printf '%T@ %p\n' \
           | sort -rn | head -1 | cut -d' ' -f2-)"
fi
[ -n "$CHAIN" ] && [ -f "$CHAIN" ] || { echo "chain.json not found (set CHAIN=/path/to/chain.json)"; exit 1; }
LEDGER="$(dirname "$CHAIN")/recover-claims.json"
echo "repo=$REPO  node=$NODE_BIN  chain=$CHAIN  ledger=$LEDGER  user=$RUN_USER"

echo "=== 1. oneshot service ==="
sudo tee /etc/systemd/system/molibra-recover.service >/dev/null <<UNIT
[Unit]
Description=Molibra orphaned-work self-scan (records owed MOLI per address; moves no money)
After=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
WorkingDirectory=${REPO}
ExecStart=${NODE_BIN} installers/recover-scan.mjs --chain ${CHAIN} --ledger ${LEDGER}
Nice=10
UNIT

echo "=== 2. daily timer ==="
sudo tee /etc/systemd/system/molibra-recover.timer >/dev/null <<'UNIT'
[Unit]
Description=Run the Molibra orphaned-work self-scan daily

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now molibra-recover.timer

echo "=== 3. cron fallback (daily 03:40, belt-and-suspenders) ==="
CRON_LINE="40 3 * * * cd ${REPO} && ${NODE_BIN} installers/recover-scan.mjs --chain ${CHAIN} --ledger ${LEDGER} >> /var/log/molibra-recover.log 2>&1"
( crontab -l 2>/dev/null | grep -v recover-scan; echo "$CRON_LINE" ) | crontab -
echo "cron installed:"; crontab -l | grep recover-scan

echo "=== 4. run once now ==="
"${NODE_BIN}" installers/recover-scan.mjs --chain "${CHAIN}" --ledger "${LEDGER}"
echo "=== timer status ==="
systemctl list-timers molibra-recover.timer --no-pager | head -3
echo DONE
