#!/bin/bash
# Uninstall Molibra Miner (macOS). Asks for your Mac password once.
# ⛔ Your wallet key (MY-WALLET-KEEP-SECRET.txt) and config are KEPT: deleting a
#    private key would destroy the MOLI it controls. Delete them yourself if you
#    are sure you no longer need them.
ROOT="$HOME/Library/Application Support/Molibra"
echo "Stopping and removing Molibra Miner..."
sudo launchctl bootout system/org.molibra.miner 2>/dev/null
sudo rm -f /Library/LaunchDaemons/org.molibra.miner.plist
[ -f "$ROOT/molibra-miner.mjs" ] && [ -x "$ROOT/runtime/bin/node" ] && "$ROOT/runtime/bin/node" "$ROOT/molibra-miner.mjs" stop >/dev/null 2>&1
rm -rf "$ROOT/app" "$ROOT/app-new" "$ROOT/app-old" "$ROOT/runtime" "$ROOT/data" "$ROOT/logs" \
       "$ROOT"/*.pid "$ROOT/install-summary.json" "$ROOT/molibra-miner.mjs"
sudo rm -rf "/Library/Application Support/Molibra Miner" "/Applications/Molibra Miner"
sudo pkgutil --forget org.molibra.miner >/dev/null 2>&1
echo
echo "Molibra Miner is removed."
[ -f "$ROOT/MY-WALLET-KEEP-SECRET.txt" ] && echo "Your wallet key was kept at: $ROOT/MY-WALLET-KEEP-SECRET.txt"
echo "You can close this window."
