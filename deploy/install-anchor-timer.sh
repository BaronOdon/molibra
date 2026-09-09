set -euo pipefail
for H in 193.123.191.142 141.147.99.86; do
  echo "=== $H ==="
  ssh -o BatchMode=yes -o ConnectTimeout=20 opc@$H "set -e
sudo tee /etc/systemd/system/molibra-anchors.service >/dev/null <<'UNIT'
[Unit]
Description=Read Ethereum anchors into anchors.json for the Molibra node
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=opc
WorkingDirectory=/home/opc/molibra
# --once: a oneshot run per timer tick. The node mines and cannot make
# outbound HTTP reliably, which is the whole reason this is a separate
# process - see anchor-poller.mjs.
ExecStart=/usr/bin/env node anchor-poller.mjs --datadir /var/lib/molibra --once
UNIT
sudo tee /etc/systemd/system/molibra-anchors.timer >/dev/null <<'UNIT'
[Unit]
Description=Refresh Molibra Ethereum anchors every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
# Anchors are rare and the floor only moves when one is published, so a
# missed tick costs nothing and does not need catching up in a burst.
Persistent=false

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now molibra-anchors.timer
sudo systemctl start molibra-anchors.service
echo \"  timer: \$(systemctl is-active molibra-anchors.timer)  last run: \$(systemctl show molibra-anchors.service -p Result --value)\"
echo \"  anchors.json: \$(sudo stat -c '%y' /var/lib/molibra/anchors.json | cut -c1-19)\"" 2>&1 | grep -v "post-quantum\|store now\|upgraded"
done
