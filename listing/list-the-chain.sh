#!/usr/bin/env bash
#
# List Molibra (chainId 20226) in BOTH chain registries, in one pass.
#
#   bash listing/list-the-chain.sh
#
# Forks each registry, branches, copies the file this repo already carries,
# and opens the pull request. The two files it copies are the ones in this
# folder; README.md next door records how each was verified.
#
# Requires the GitHub CLI, authenticated:  gh auth status

set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=${WORK:-"$(cd "$SRC/../.." && pwd)/chain-listings"}
mkdir -p "$WORK"

echo "=================================================================="
echo " 1/2  ethereum-lists/chains   — this is what MetaMask reads"
echo "=================================================================="
cd "$WORK"
[ -d chains ] || gh repo fork ethereum-lists/chains --clone=true --remote=true
cd chains
git checkout master
git pull upstream master 2>/dev/null || git pull origin master
git checkout -B add-molibra-20226
cp "$SRC/eip155-20226.json" _data/chains/eip155-20226.json
git add _data/chains/eip155-20226.json
git commit -m "Add Molibra chain (EIP-155:20226)"
git push -u origin add-molibra-20226 --force-with-lease

gh pr create --repo ethereum-lists/chains --base master \
  --title "Add Molibra chain (EIP-155:20226)" \
  --body "Adds Molibra, an EVM chain, chainId 20226.

- RPC \`https://molibra.org\` answers \`eth_chainId\` → \`0x4f02\` and \`net_version\` → \`20226\` at the bare origin, over TLS.
- Explorer: Moliscan — https://molibra.org/molibra/moliscan (standard: \`none\`).
- \`chainId\` 20226, \`shortName\` \`moli\` and \`name\` \`Molibra\` were each checked against the published list and are unused.
- EIP-155 is mandatory on this chain — transactions without replay protection are rejected — so it is declared. EIP-1559 is not supported, so it is not.
- No \`icon\` field: the icon is not pinned to IPFS yet. Happy to follow up with a separate PR adding it once it is.
- The file passes \`prettier --check\` against this repo's \`.prettierrc.json\`.

Source: https://github.com/BaronOdon/molibra"

echo
echo "=================================================================="
echo " 2/2  DefiLlama/chainlist     — this is what chainlist.org shows"
echo "=================================================================="
cd "$WORK"
[ -d chainlist ] || gh repo fork DefiLlama/chainlist --clone=true --remote=true
cd chainlist
DEF=$(git symbolic-ref --short HEAD)
git checkout "$DEF"
git pull upstream "$DEF" 2>/dev/null || git pull origin "$DEF"
git checkout -B add-molibra-20226
cp "$SRC/chainid-20226.js" constants/additionalChainRegistry/chainid-20226.js
git add constants/additionalChainRegistry/chainid-20226.js
git commit -m "Add Molibra chain (20226)"
git push -u origin add-molibra-20226 --force-with-lease

gh pr create --repo DefiLlama/chainlist --base "$DEF" \
  --title "Add Molibra chain (20226)" \
  --body "Adds Molibra to \`constants/additionalChainRegistry\`, per the README.

RPC \`https://molibra.org\` answers \`eth_chainId\` → \`0x4f02\` at the bare origin, over TLS.
Explorer: Moliscan — https://molibra.org/molibra/moliscan

Source: https://github.com/BaronOdon/molibra"

echo
echo "Both PRs opened. Watch CI with:"
echo "  gh pr status --repo ethereum-lists/chains"
echo "  gh pr status --repo DefiLlama/chainlist"
