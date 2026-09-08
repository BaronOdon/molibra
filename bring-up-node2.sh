#!/usr/bin/env bash
#
# Bring node 2 up to the head, then make it mine for the airdrop wallet.
#
#   bash bring-up-node2.sh
#
# ⛔ Mining is enabled ONLY after this proves node 2 holds the same head as
#    node 1. A node that mines while behind does not join the chain - it forks
#    it, and a fork it cannot reorg out of is how 645 blocks were lost on
#    30 Aug. The convergence check below is a gate, not a status line.

set -euo pipefail

N1=193.123.191.142
N2=141.147.99.86
AIRDROP=0x5851cc5884313f7a66697dE3Bb772466dD5895c7
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20"
# ⛔ `python3` on Windows resolves to a Store stub that exits with "Permission
#    denied", so the local half of this script needs a real interpreter found at
#    run time. The remote halves run on the Oracle boxes, where python3 is real.
PY=python3
command -v python3 >/dev/null 2>&1 && python3 -c "" 2>/dev/null ||   PY="/c/Users/Administrator/AppData/Local/Python/pythoncore-3.14-64/python.exe"

head_of() { curl -s --max-time 15 "http://$1:8545/molibra" | $PY -c 'import sys,json;d=json.load(sys.stdin);print(d["height"], d["head"])'; }

echo "=================================================================="
echo " 1. node 2 takes the sync fix"
echo "=================================================================="
$SSH opc@$N2 'cd /home/opc/molibra && git fetch origin -q && git reset --hard origin/main -q && git log --oneline -1'

echo
echo "=================================================================="
echo " 2. catch up - one uninterrupted pass, service stopped"
echo "=================================================================="
# ⛔ The service is stopped first. Two processes on one datadir corrupt it, and
#    the 10s sync loop restarting from block 0 is what stopped this converging
#    in the first place.
$SSH opc@$N2 "sudo systemctl stop molibra && cd /home/opc/molibra && \
  nohup node src/cli.js sync --peer http://$N1:8545 --datadir /var/lib/molibra > /tmp/catchup.log 2>&1 & echo started"

for i in $(seq 1 60); do
  sleep 20
  line=$($SSH opc@$N2 'tail -1 /tmp/catchup.log 2>/dev/null' || true)
  echo "  t+$((i*20))s  ${line:0:100}"
  case "$line" in
    *"rate-limited this sync"*|*"answered "*) echo "SYNC FAILED - see /tmp/catchup.log on node 2"; exit 1 ;;
    *adopted*) break ;;
  esac
done

echo
echo "=================================================================="
echo " 3. ⛔ THE GATE - same head, or no mining"
echo "=================================================================="
$SSH opc@$N2 'sudo systemctl start molibra' && sleep 45
read -r H1 HEAD1 <<<"$(head_of $N1)"
read -r H2 HEAD2 <<<"$($SSH opc@$N2 'curl -s --max-time 15 localhost:8545/molibra | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[\"height\"], d[\"head\"])"')"
echo "  node 1: $H1  $HEAD1"
echo "  node 2: $H2  $HEAD2"

# Heights drift by a block or two while node 1 keeps mining; that is fine. What
# is NOT fine is node 2 being far behind, or holding a hash node 1 has never
# seen - the second is a fork wearing a healthy status line.
BEHIND=$(( H1 - H2 ))
echo "  behind by $BEHIND block(s)"
if [ "$BEHIND" -gt 20 ] || [ "$BEHIND" -lt -20 ]; then
  echo "ABORT: node 2 is not caught up. Mining stays OFF."
  exit 1
fi
if ! curl -s --max-time 15 "http://$N1:8545/molibra/block/$H2?decoded=1" | grep -q "$HEAD2"; then
  echo "ABORT: node 1 does not recognise node 2's head at $H2 - that is a FORK. Mining stays OFF."
  exit 1
fi
echo "  ✓ node 1 confirms node 2's head at its own height - same chain"

echo
echo "=================================================================="
echo " 4. mine, to the airdrop wallet"
echo "=================================================================="
$SSH opc@$N2 "sudo cp /etc/systemd/system/molibra.service /etc/systemd/system/molibra.service.bak-\$(date +%Y%m%d-%H%M%S) && \
  sudo sed -i 's|--peers http://$N1:8545|--peers http://$N1:8545 --miner $AIRDROP --mine|' /etc/systemd/system/molibra.service && \
  grep -o '\-\-miner [^ ]*' /etc/systemd/system/molibra.service && \
  sudo systemctl daemon-reload && sudo systemctl restart molibra"

echo
echo "Give it a minute, then check who is mining on each node:"
echo "  bash $(dirname "$0")/check-nodes.sh"
