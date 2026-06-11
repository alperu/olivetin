#!/bin/bash
# olivetin-launch.sh — launched by the OliveTin.app (Platypus wrapper).
# Starts OliveTin if it isn't already listening, then opens the WebUI.
# OliveTin keeps running after this script (and the .app) exits.

OT="$HOME/.local/opt/olivetin"
PORT="1337"
URL="http://localhost:${PORT}"

cd "$OT" || exit 1

if ! /usr/sbin/lsof -i ":${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  # Detach so OliveTin survives this script/app exiting.
  nohup "$OT/OliveTin" >/tmp/olivetin.log 2>&1 &
  disown
  # Wait (up to ~6s) for the port to come up before opening the browser.
  for _ in $(seq 1 20); do
    /usr/sbin/lsof -i ":${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1 && break
    sleep 0.3
  done
fi

open "$URL"
