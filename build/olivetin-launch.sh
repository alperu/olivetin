#!/bin/bash
# olivetin-launch.sh — run by OliveTin.app (Platypus "Text Window" interface).
#
# Runs OliveTin in the FOREGROUND and streams its log into the app window so you
# can see the status. The app stays open while OliveTin runs; QUITTING the app
# (Cmd-Q / closing the window) STOPS OliveTin via the cleanup trap.

OT="$HOME/.local/opt/olivetin"
PORT="1337"
URL="http://localhost:${PORT}"
LOG="/tmp/olivetin.log"

OT_PID=""
cleanup() {
  echo ""
  echo "Stopping OliveTin…"
  [ -n "$OT_PID" ] && kill "$OT_PID" 2>/dev/null
  # Make sure no OliveTin we own is left behind on this port.
  pkill -x OliveTin 2>/dev/null
}
trap cleanup EXIT INT TERM

cd "$OT" || { echo "OliveTin dir not found: $OT"; exit 1; }

if /usr/sbin/lsof -i ":${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  STATUS="already running"
else
  # Send OliveTin's verbose log to a file — keep this window clean.
  : > "$LOG"
  "$OT/OliveTin" >"$LOG" 2>&1 &
  OT_PID=$!
  for _ in $(seq 1 20); do
    /usr/sbin/lsof -i ":${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1 && break
    sleep 0.3
  done
  STATUS="started"
fi

open "$URL"

echo "╭───────────────────────────────────────────────╮"
echo "│            OliveTin  —  $STATUS"
echo "╰───────────────────────────────────────────────╯"
echo ""
echo "  ●  Running at   ${URL}"
echo "  ●  Full log     ${LOG}"
echo ""
echo "  Close this window (or press ⌘Q) to STOP OliveTin."
echo ""

# Keep the app alive while OliveTin runs (quiet window — log goes to \$LOG).
if [ -n "$OT_PID" ]; then
  wait "$OT_PID"
else
  while /usr/sbin/lsof -i ":${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; do sleep 2; done
fi
