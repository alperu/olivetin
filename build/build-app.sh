#!/usr/bin/env bash
# build-app.sh — (re)build build/OliveTin.app from olivetin-launch.sh using
# Platypus, embedding the OliveTin logo as the app icon. Repeatable.
#
# Usage: bash build/build-app.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

RES="/Applications/Platypus.app/Contents/Resources"
PLATYPUS="$RES/platypus_clt"
LOGO="$HOME/.local/opt/olivetin/webui/assets/OliveTinLogo-180px-DBoTqUbn.png"

[ -x "$PLATYPUS" ] || { echo "Platypus CLI not found at $PLATYPUS"; exit 1; }

# 1. Icon: build a .icns from the committed OliveTin.iconset. If the source
#    logo is present on this machine, regenerate the iconset from it first
#    (dev convenience); otherwise the checked-in iconset is used as-is, so a
#    fresh clone builds without the logo.
echo "==> building icon"
if [ -f "$LOGO" ]; then
  echo "    regenerating OliveTin.iconset from $LOGO"
  rm -rf OliveTin.iconset && mkdir OliveTin.iconset
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s"       "$LOGO" --out "OliveTin.iconset/icon_${s}x${s}.png"    >/dev/null
    sips -z $((s*2)) $((s*2)) "$LOGO" --out "OliveTin.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
else
  echo "    logo not found; using committed OliveTin.iconset"
  [ -d OliveTin.iconset ] || { echo "OliveTin.iconset missing and no logo to build from"; exit 1; }
fi
iconutil -c icns OliveTin.iconset -o OliveTin.icns

# 2. ScriptExec: this Platypus install ships it base64-encoded and has no
#    /usr/local/share/platypus. Decode it locally and pass with -e / -E so we
#    never need sudo or the "Install Command Line Tool" step.
echo "==> decoding ScriptExec"
base64 -d -i "$RES/ScriptExec.b64" > ScriptExec && chmod +x ScriptExec

# 3. Build the .app.
#    Interface "Text Window" keeps a Dock icon + a window showing OliveTin's
#    live log while it runs. No -R: the app stays open until you quit it, and
#    quitting stops OliveTin (see olivetin-launch.sh's cleanup trap).
echo "==> building OliveTin.app"
chmod +x olivetin-launch.sh
"$PLATYPUS" \
  -y -a "OliveTin" -o "Text Window" -p "/bin/bash" \
  -i "OliveTin.icns" -V "1.0" -u "alper" -I "app.olivetin.launcher" \
  -n "Monaco 11" \
  -e "$HERE/ScriptExec" \
  -E "$RES/MainMenu.nib" \
  "olivetin-launch.sh" "OliveTin.app"

# 4. Ad-hoc sign so Gatekeeper doesn't complain about a locally-built app.
echo "==> ad-hoc signing"
codesign --force --deep -s - OliveTin.app

echo "==> done: $HERE/OliveTin.app"
