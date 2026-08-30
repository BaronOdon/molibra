#!/usr/bin/env bash
#
# Stand up a public Molibra node. Run this ON the server.
#
#   curl -fsSL https://raw.githubusercontent.com/BaronOdon/molibra/main/deploy/install.sh | bash
#
# or, having cloned already:  bash deploy/install.sh
#
# Idempotent: safe to run again. It re-clones nothing it already has, and it
# never touches the datadir.
#
# ⛔ It deliberately does NOT enable --treasury or --chalk. Those turn on
# POST /molibra/airdrop, /earn and /grant, which hand out value to whoever
# asks. Correct on a private node; a faucet for strangers on a public one.
#
# Environment:
#   MOLIBRA_PEERS   comma-separated peers to follow, e.g. http://1.2.3.4:8545
#   MOLIBRA_MINER   0x address to mine to. Mining is OFF unless this is set.
#                   It is an ADDRESS, never a key: this script handles no secret.
#   MOLIBRA_PORT    default 8545
#   MOLIBRA_BIND    default 0.0.0.0; set 127.0.0.1 when a reverse proxy fronts it

set -euo pipefail

PORT="${MOLIBRA_PORT:-8545}"
BIND="${MOLIBRA_BIND:-0.0.0.0}"
PEERS="${MOLIBRA_PEERS:-}"
MINER="${MOLIBRA_MINER:-}"
DIR="${MOLIBRA_DIR:-$HOME/molibra}"
REPO="https://github.com/BaronOdon/molibra.git"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m  x %s\033[0m\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------- node runtime
say "Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  warn "installing Node.js 22 (needs >= 20)"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf module reset -y nodejs || true
    sudo dnf module enable -y nodejs:22 || true
    sudo dnf install -y nodejs
  else
    die "no apt-get or dnf; install Node.js >= 20 yourself and re-run"
  fi
fi
node --version

# ------------------------------------------------------------------ the code
say "Molibra"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  command -v git >/dev/null 2>&1 || sudo apt-get install -y git || sudo dnf install -y git
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
npm ci --omit=dev

# ⛔ The one check worth failing the install over. A build without startSyncing
# joins once and then freezes forever, looking joined while mining a fork
# nobody accepts. See deploy/public-node.md §4.
grep -q startSyncing src/node.js || die "this build cannot follow the chain - update to b168c68 or later"

say "Tests (do not take anyone's word for it)"
npm test >/tmp/molibra-test.log 2>&1 && echo "  all suites passed" \
  || { tail -30 /tmp/molibra-test.log; die "tests failed - not installing a node that does not pass them"; }

# ------------------------------------------------------------------ firewall
say "Firewall (the instance's own - the cloud Security List is separate)"
if command -v firewall-cmd >/dev/null 2>&1; then
  sudo firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null && sudo firewall-cmd --reload >/dev/null
  echo "  firewalld: ${PORT}/tcp open"
elif command -v iptables >/dev/null 2>&1; then
  # Oracle's Ubuntu images drop everything but SSH in iptables. ufw is NOT the
  # rule set in play, so editing ufw here would appear to work and do nothing.
  if ! sudo iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport "$PORT" -j ACCEPT
    command -v netfilter-persistent >/dev/null 2>&1 && sudo netfilter-persistent save >/dev/null || \
      warn "install iptables-persistent, or this rule is lost on reboot"
  fi
  echo "  iptables: ${PORT}/tcp open"
else
  warn "no firewalld or iptables found - open ${PORT}/tcp yourself"
fi
warn "the cloud-side rule is SEPARATE: add TCP ${PORT} ingress in your VCN Security List"

# ------------------------------------------------------------------- service
say "systemd service"
ARGS="node src/cli.js node --host ${BIND} --port ${PORT} --datadir %S/molibra"
[ -n "$PEERS" ] && ARGS="$ARGS --peers ${PEERS}"
if [ -n "$MINER" ]; then
  ARGS="$ARGS --miner ${MINER} --mine"
else
  warn "MOLIBRA_MINER not set - the node will NOT mine."
  warn "On an always-free tier an idle instance can be reclaimed; see public-node.md."
fi

sudo tee /etc/systemd/system/molibra.service >/dev/null <<UNIT
[Unit]
Description=Molibra node
Documentation=https://github.com/BaronOdon/molibra
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${DIR}
ExecStart=/usr/bin/env ${ARGS}
Restart=always
RestartSec=5
StateDirectory=molibra
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now molibra
sleep 8
sudo systemctl is-active --quiet molibra || { sudo journalctl -u molibra -n 30 --no-pager; die "service did not start"; }
echo "  molibra.service active"

# ------------------------------------------------------- ⛔ verify, don't assume
say "Verifying it actually serves"
for i in $(seq 1 15); do
  if curl -fsS -m 5 "http://127.0.0.1:${PORT}/molibra/head" >/dev/null 2>&1; then break; fi
  [ "$i" = 15 ] && die "the node is running but does not answer on ${PORT}"
  sleep 2
done
H1=$(curl -fsS "http://127.0.0.1:${PORT}/molibra" | grep -o '"height": *[0-9]*' | grep -o '[0-9]*')
echo "  height ${H1}"

# ⛔ Serving is not following. A node that answers but never advances looks
# healthy and is useless - it is the exact bug fixed in b168c68. So if this node
# has peers or mines, its height MUST move, and a static height is a failure.
if [ -n "$PEERS" ] || [ -n "$MINER" ]; then
  say "Confirming the height MOVES (60s)"
  sleep 60
  H2=$(curl -fsS "http://127.0.0.1:${PORT}/molibra" | grep -o '"height": *[0-9]*' | grep -o '[0-9]*')
  echo "  height ${H1} -> ${H2}"
  if [ "$H1" = "$H2" ]; then
    warn "HEIGHT DID NOT MOVE."
    warn "Serving is not the same as following. Check: peers reachable? mining configured?"
    warn "  curl http://127.0.0.1:${PORT}/molibra/peers"
    warn "  sudo journalctl -u molibra -n 50"
    exit 1
  fi
  echo "  following the chain"
else
  warn "no peers and no miner: this node serves only its own genesis, by design"
fi

say "Done"
IP=$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || echo "<public-ip>")
cat <<DONE

  audit surface : http://${IP}:${PORT}/molibra
  head          : http://${IP}:${PORT}/molibra/head
  logs          : sudo journalctl -u molibra -f

  If the address above does not answer from OUTSIDE this machine, the cloud
  Security List rule is missing - that is a separate firewall from the one this
  script configured.
DONE
