#!/usr/bin/env bash
#
# Follow-up PR to ethereum-lists/chains, after #8674 merged.
#
#   bash listing/followup-icon-and-eip3091.sh
#
# It adds two things the merged listing does not have:
#   _data/icons/molibra.json          the pinned icon
#   "icon": "molibra"                 on the chain
#   "standard": "EIP3091"             instead of "none"
#
# ⛔ It REFUSES to run until the live site actually backs both claims. A chain
#    registry is read by wallets; "standard": "EIP3091" against a site that 404s
#    on /tx/ hands every user a dead link and is worse than the "none" that is
#    there now. So the preconditions below are checks, not comments - deploy
#    first, then run this.
#
# Requires the GitHub CLI, authenticated:  gh auth status

set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=${WORK:-"$(cd "$SRC/../.." && pwd)/chain-listings"}
SITE=${SITE:-https://molibra.org}
CID=$(grep -o 'ipfs://[A-Za-z0-9]*' "$SRC/icons/molibra.json" | head -1 | sed 's|ipfs://||')

fail() { echo "ABORT: $*" >&2; exit 1; }

echo "=================================================================="
echo " Preconditions - the registry may only claim what the site does"
echo "=================================================================="

# 1. EIP-3091, all three shapes a wallet builds.
for p in /molibra/moliscan/block/1 /molibra/moliscan/tx/0x0 /molibra/moliscan/address/0x0; do
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$SITE$p")
  echo "  $SITE$p -> $code"
  [ "$code" = "200" ] || fail "EIP-3091 is not live yet ($p is $code). Push and deploy first."
done

# 2. The icon must be fetchable by someone who is not us. Their README wants a
#    CID retrievable over the network, not one that only our own node can serve.
echo "  icon CID: $CID"
got=$(curl -s -m 60 "https://ipfs.io/ipfs/$CID" | head -c 4 || true)
[ "$got" = "<svg" ] || fail "the icon CID did not come back from an independent gateway - is the IPFS daemon up?"
echo "  ipfs.io returned a real SVG -> retrievable"

echo
echo "=================================================================="
echo " Follow-up PR"
echo "=================================================================="
mkdir -p "$WORK"
cd "$WORK"
[ -d chains ] || gh repo fork ethereum-lists/chains --clone=true --remote=true
cd chains

# Start from CURRENT upstream master: #8674 is merged, so the file is already
# there and ours must be an edit of theirs, not a blind overwrite.
git fetch upstream master
git checkout -B followup-molibra-icon-eip3091 upstream/master

UP=_data/chains/eip155-20226.json
[ -f "$UP" ] || fail "$UP is not on master - did #8674 actually merge?"

# ⛔ Only two fields may differ. If upstream has been edited since the merge,
# stop and look rather than clobber a maintainer's change.
DIFF=$(diff <(sed -e '/"icon"/d' -e 's/"EIP3091"/"none"/' "$SRC/eip155-20226.json") "$UP" || true)
[ -z "$DIFF" ] || {
  echo "$DIFF"
  fail "upstream differs from ours by more than the icon and the standard - review before pushing"
}

cp "$SRC/eip155-20226.json" "$UP"
mkdir -p _data/icons
cp "$SRC/icons/molibra.json" _data/icons/molibra.json
git add "$UP" _data/icons/molibra.json
git commit -m "Molibra (20226): add icon, and mark the explorer EIP-3091"
git push -u origin followup-molibra-icon-eip3091 --force-with-lease

gh pr create --repo ethereum-lists/chains --base master \
  --title "Molibra (EIP-155:20226): add icon, and mark the explorer EIP-3091" \
  --body "Follow-up to #8674, which is merged. Two changes:

**Icon.** Left out of #8674 because it was not pinned. It is now, on our own node, and reprovided: \`ipfs://$CID\` — a 935-byte SVG. Retrievable over the network rather than via one gateway: fetched by ipfs.io and others that had never seen the CID.

**Explorer is now EIP-3091.** When #8674 was opened, Moliscan answered 404 on \`/tx/\`, \`/address/\` and \`/block/\`, so it was honestly declared \`\"standard\": \"none\"\`. It implements all three now — please check:

- ${SITE}/molibra/moliscan/block/1
- ${SITE}/molibra/moliscan/address/0x5851cc5884313f7a66697dE3Bb772466dD5895c7

Both files pass \`prettier --check\` against this repo's \`.prettierrc.json\`.

Source: https://github.com/BaronOdon/molibra"

echo
echo "Done. Watch it with:"
echo "  gh pr status --repo ethereum-lists/chains"
