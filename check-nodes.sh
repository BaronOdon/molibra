#!/usr/bin/env bash
#
# Are both nodes on the same chain, and who is each one mining for?
#
#   bash check-nodes.sh
#
# ⛔ Height alone proves nothing. Two nodes can sit at the same height on
#    different chains - that is what a fork IS. The check that matters is
#    whether each node's head hash is a block the OTHER one recognises.

set -uo pipefail
N1=193.123.191.142
N2=141.147.99.86
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20"
# ⛔ `python3` on Windows resolves to a Store stub that exits with "Permission
#    denied", so the local half of this script needs a real interpreter found at
#    run time. The remote halves run on the Oracle boxes, where python3 is real.
PY=python3
command -v python3 >/dev/null 2>&1 && python3 -c "" 2>/dev/null ||   PY="/c/Users/Administrator/AppData/Local/Python/pythoncore-3.14-64/python.exe"

read -r H1 HEAD1 W1 <<<"$(curl -s --max-time 20 "http://$N1:8545/molibra" | $PY -c 'import sys,json;d=json.load(sys.stdin);print(d["height"],d["head"],d["totalDifficulty"])')"
read -r H2 HEAD2 W2 <<<"$($SSH opc@$N2 'curl -s --max-time 20 localhost:8545/molibra | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[\"height\"],d[\"head\"],d[\"totalDifficulty\"])"' 2>/dev/null)"

printf "node 1  height %-8s work %-14s %s\n" "$H1" "$W1" "$HEAD1"
printf "node 2  height %-8s work %-14s %s\n" "${H2:-?}" "${W2:-?}" "${HEAD2:-unreachable}"
echo

if [ -z "${H2:-}" ]; then echo "⛔ node 2 did not answer"; exit 1; fi

echo "same chain?"
if curl -s --max-time 20 "http://$N1:8545/molibra/block/$H2?decoded=1" | grep -q "$HEAD2"; then
  echo "  ✓ node 1 recognises node 2's head at height $H2"
else
  echo "  ⛔ FORK - node 1 does not have node 2's head at height $H2"
fi

echo
echo "who mined the last block on each?"
for pair in "1 http://$N1:8545" "2 http://$N2:8545"; do
  set -- $pair
  h=$( [ "$1" = 1 ] && echo "$H1" || echo "$H2" )
  m=$(curl -s --max-time 20 "$2/molibra/block/$h?decoded=1" 2>/dev/null \
      | $PY -c 'import sys,json;d=json.load(sys.stdin);print((d.get("header") or d)["miner"])' 2>/dev/null \
      || $SSH opc@$N2 "curl -s --max-time 15 localhost:8545/molibra/block/$h?decoded=1 | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get(\"header\") or d)[\"miner\"])'" 2>/dev/null)
  printf "  node %s  block %-8s %s\n" "$1" "$h" "$m"
done

echo
echo "balances"
for pair in "operator 0xf51ac8FD4112bF1d45fD5C38D5aBfe0c61Ec3F5a" "airdrop  0x5851cc5884313f7a66697dE3Bb772466dD5895c7"; do
  set -- $pair
  b=$(curl -s --max-time 20 -X POST "http://$N1:8545" -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$2\",\"latest\"]}" \
      | $PY -c 'import sys,json;print(f"{int(json.load(sys.stdin)[\"result\"],16)/1e18:,.6f}")')
  printf "  %-9s %18s MOLI\n" "$1" "$b"
done
