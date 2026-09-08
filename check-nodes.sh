#!/usr/bin/env bash
#
# Are both nodes on the same chain, and who is each one mining for?
#
#   bash check-nodes.sh [depth]        default depth 10
#
# ⛔ Compares at a CONFIRMATION DEPTH, not at the tip.
#
#    With two miners the tips legitimately differ: both find blocks, each
#    briefly prefers its own, and the heavier chain wins. Comparing tips reports
#    a FORK every time that happens, which is most of the time - and a check
#    that cries wolf is a check someone stops reading. What separates a race
#    from a fork is whether the two agree once a few blocks have settled.
#
#    Tip divergence is printed as information. Divergence at depth is the alarm.

set -uo pipefail
N1=193.123.191.142
N2=141.147.99.86
DEPTH=${1:-10}
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20"
# `python3` on Windows is a Store stub that exits "Permission denied", so the
# local half resolves a real interpreter; the remote halves run on the Oracle
# boxes, where python3 is real.
# ⛔ Do NOT probe for python3 here. On Windows `python3` is the Store alias, and
#    it is INTERMITTENT: `python3 -c ""` exits 0, a real script runs fine, and
#    the next invocation in the same script dies "Permission denied". A probe
#    therefore passes and the thing still fails later, which is worse than no
#    probe at all. Prefer the real interpreter by path; fall back to python3
#    only where that path does not exist, i.e. when run on Linux.
WINPY="/c/Users/Administrator/AppData/Local/Python/pythoncore-3.14-64/python.exe"
if [ -x "$WINPY" ]; then PY="$WINPY"; else PY=python3; fi

n1() { curl -s --max-time 20 "http://$N1:8545$1"; }
n2() { $SSH opc@$N2 "curl -s --max-time 15 'localhost:8545$1'" 2>/dev/null; }
jq1() { "$PY" -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

read -r H1 W1 R1 HEAD1 <<<"$(n1 /molibra | jq1 'd["height"],d["totalDifficulty"],("reorg@"+str((d["lastReorg"] or {}).get("depth","-"))),d["head"]' | tr '\n' ' ')"
read -r H2 W2 R2 HEAD2 <<<"$(n2 /molibra | jq1 'd["height"],d["totalDifficulty"],("reorg@"+str((d["lastReorg"] or {}).get("depth","-"))),d["head"]' | tr '\n' ' ')"

printf "node 1  height %-8s work %-14s %-9s %s…\n" "$H1" "$W1" "$R1" "${HEAD1:0:26}"
printf "node 2  height %-8s work %-14s %-9s %s…\n" "${H2:-?}" "${W2:-?}" "${R2:-?}" "${HEAD2:0:26}"
[ -z "${H2:-}" ] && { echo; echo "⛔ node 2 did not answer"; exit 1; }
echo "        tips differ by $(( H1 - H2 )) block(s) — expected while both mine"
echo

# --- the check that matters -------------------------------------------------
LOW=$(( H1 < H2 ? H1 : H2 ))
N=$(( LOW - DEPTH ))
h1=$(n1 "/molibra/block/$N?decoded=1" | jq1 'd["hash"]')
h2=$(n2 "/molibra/block/$N?decoded=1" | jq1 'd["hash"]')
echo "same chain at depth $DEPTH (block $N)?"
if [ -n "$h1" ] && [ "$h1" = "$h2" ]; then
  echo "  ✓ identical — $h1"
else
  echo "  ⛔ FORK — the nodes disagree about settled history"
  echo "     node 1  $h1"
  echo "     node 2  $h2"
fi

echo
echo "who mined the last block on each?"
printf "  node 1  %-8s %s\n" "$H1" "$(n1 "/molibra/block/$H1?decoded=1" | jq1 '(d.get("header") or d)["miner"]')"
printf "  node 2  %-8s %s\n" "$H2" "$(n2 "/molibra/block/$H2?decoded=1" | jq1 '(d.get("header") or d)["miner"]')"

echo
echo "balances (read from node 1)"
for pair in "operator 0xf51ac8FD4112bF1d45fD5C38D5aBfe0c61Ec3F5a" "airdrop 0x5851cc5884313f7a66697dE3Bb772466dD5895c7"; do
  set -- $pair
  b=$(curl -s --max-time 20 -X POST "http://$N1:8545" -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$2\",\"latest\"]}" \
      | "$PY" -c 'import sys,json;v=json.load(sys.stdin)["result"];print(format(int(v,16)/1e18, ",.6f"))')
  printf "  %-9s %18s MOLI\n" "$1" "$b"
done
