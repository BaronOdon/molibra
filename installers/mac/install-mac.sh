#!/bin/bash
# Molibra Miner - one-line install for macOS:
#
#   curl -fsSL https://molibra.org/download/install-mac.sh | bash
#
# It downloads the signed, notarized Molibra-Miner.pkg, has macOS check the
# signature (Gatekeeper's own verdict) and installs it. It asks for your Mac
# password once, because the miner registers to start at boot.
set -euo pipefail
PKG="$(mktemp -d)/Molibra-Miner.pkg"
echo "Downloading Molibra Miner..."
curl -fL --progress-bar https://molibra.org/download/Molibra-Miner.pkg -o "$PKG"
echo "Checking Apple's signature and notarization..."
spctl --assess --type install "$PKG" || { echo "This package is not accepted by macOS. Stopping."; exit 1; }
echo "Installing (your Mac password is needed once)..."
sudo installer -pkg "$PKG" -target / </dev/tty
rm -f "$PKG"
echo "Done. Molibra Miner is running; open http://127.0.0.1:20226/molibra/miner to watch it."
