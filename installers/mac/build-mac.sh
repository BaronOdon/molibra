#!/bin/bash
# Build, sign, notarize and staple Molibra-Miner.pkg. Runs ON A MAC (mini1).
#
#   bash build-mac.sh <app.tar> <molibra-miner.mjs> <version>
#
# <app.tar> is the same staged app the Windows build uses (src + pure-JS
# node_modules + COMMIT): one commit, identical on both platforms.
#
# ⛔ Signing uses the dedicated keychain ~/Library/Keychains/devid.keychain-db
#    (password in ~/devid/.keychain-pass); notarization uses the App Store
#    Connect API key already on this Mac. Gatekeeper's own verdict (spctl) is
#    the last step, and a build it does not accept is not published.
set -euo pipefail
APP_TAR="$1"; LAUNCHER="$2"; VERSION="${3:-1.0.0}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"; WORK="$(mktemp -d)"
KC="$HOME/Library/Keychains/devid.keychain-db"
INSTALLER_ID="Developer ID Installer: MARCELO MARSHALL DE SIQUEIRA (VZW9226DZB)"
ASC_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_JX7G28UWGC.p8"
ASC_KEY_ID="JX7G28UWGC"; ASC_ISSUER="fefb6481-a18e-42e4-af82-509bf3877a67"

mkdir -p "$OUT"
ROOTFS="$WORK/root"
PAY="$ROOTFS/Library/Application Support/Molibra Miner/payload"
APPS="$ROOTFS/Applications/Molibra Miner"
mkdir -p "$PAY/app" "$APPS"
tar -xf "$APP_TAR" -C "$PAY/app"
cp "$LAUNCHER" "$PAY/molibra-miner.mjs"
cp "$(dirname "$LAUNCHER")/status.html" "$PAY/status.html"
cp "$HERE/Uninstall Molibra Miner.command" "$APPS/"
chmod 755 "$APPS/Uninstall Molibra Miner.command"
cat > "$APPS/Molibra Miner.webloc" <<'W'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>http://127.0.0.1:20227/</string></dict></plist>
W
mkdir -p "$WORK/scripts"
cp "$HERE/scripts/postinstall" "$WORK/scripts/postinstall"
chmod 755 "$WORK/scripts/postinstall"
# Strip Windows line endings if any travelled with the files.
sed -i '' $'s/\r$//' "$WORK/scripts/postinstall" "$APPS/Uninstall Molibra Miner.command"

pkgbuild --root "$ROOTFS" --scripts "$WORK/scripts" --identifier org.molibra.miner \
  --version "$VERSION" --install-location / "$WORK/unsigned.pkg"

security unlock-keychain -p "$(cat "$HOME/devid/.keychain-pass")" "$KC"
productsign --sign "$INSTALLER_ID" --keychain "$KC" "$WORK/unsigned.pkg" "$OUT/Molibra-Miner.pkg"
pkgutil --check-signature "$OUT/Molibra-Miner.pkg" | head -6

xcrun notarytool submit "$OUT/Molibra-Miner.pkg" --key "$ASC_KEY" --key-id "$ASC_KEY_ID" \
  --issuer "$ASC_ISSUER" --wait --timeout 30m | tee "$WORK/notary.txt"
grep -q "status: Accepted" "$WORK/notary.txt" || { echo "⛔ notarization was not accepted"; exit 1; }
xcrun stapler staple "$OUT/Molibra-Miner.pkg"

# ⛔ Gatekeeper's verdict is the release gate.
spctl --assess --type install -vv "$OUT/Molibra-Miner.pkg" 2>&1 | tee "$WORK/spctl.txt"
grep -q "accepted" "$WORK/spctl.txt" || { echo "⛔ Gatekeeper does not accept the package"; exit 1; }
shasum -a 256 "$OUT/Molibra-Miner.pkg" | sed 's#  .*/#  #' > "$OUT/SHA256SUMS-mac.txt"
cat "$OUT/SHA256SUMS-mac.txt"
rm -rf "$WORK"
