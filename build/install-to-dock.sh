#!/usr/bin/env bash
# install-to-dock.sh — install build/OliveTin.app into /Applications and pin it
# to the Dock so it shows up as a real, clickable app with the OliveTin icon.
#
# Usage: bash build/install-to-dock.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/OliveTin.app"
DEST="/Applications/OliveTin.app"

[ -d "$SRC" ] || { echo "Build the app first: bash build/build-app.sh"; exit 1; }

echo "==> installing to $DEST"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
# Re-sign ad-hoc after the copy so Gatekeeper is happy.
codesign --force --deep -s - "$DEST" 2>/dev/null || true
# Refresh Launch Services so the icon/metadata register immediately.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$DEST" 2>/dev/null || true

echo "==> pinning to Dock"
if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "OliveTin.app"; then
  echo "    already in the Dock"
else
  defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${DEST}</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
  killall Dock
  echo "    added OliveTin to the Dock"
fi

echo "==> done. Click the OliveTin icon in the Dock to open the WebUI."
