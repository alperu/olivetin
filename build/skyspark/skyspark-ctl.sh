#!/usr/bin/env bash
#
# skyspark-ctl.sh — OliveTin glue for the SkySpark tab. One row per install
# under $SKYSPARK_ROOT (skyspark-<version>/bin/skyspark).
#
# Usage:
#   skyspark-ctl.sh <start|stop|restart|status> <version>
#       Runs skyspark.sh (a copy of mobilytik's skyspark_pod/tools/scripts/
#       skyspark/skyspark.sh) with the http port this install has set in its
#       var folder, so every button acts on that install's own port.
#   skyspark-ctl.sh open <version>
#       Opens http://localhost:<port>/ if this install serves that port.
#   skyspark-ctl.sh folder <version>
#       Opens the install folder in Finder.
#   skyspark-ctl.sh set-port <version> <port>
#       Writes httpPort into the var folder. Refuses while the install runs.
#   skyspark-ctl.sh probe <entityFile> <version>
#       Writes the row's entity JSON {state,label,port}; rewrites only on change.
#   skyspark-ctl.sh any
#       Exit 0 if any install's JVM is up (drives the tab colour).
#
set -uo pipefail
# OliveTin's action PATH omits Homebrew and /usr/sbin (lsof).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin:$PATH"

ROOT="${SKYSPARK_ROOT:-$HOME/skyspark}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# httpPort from the var folder: 3.x keeps it in var/host/folio.trio, 4.x in
# var/sys/db/folio.trio. SkySpark's default is 8080.
port_of() {
  local f p
  for f in "$1/var/host/folio.trio" "$1/var/sys/db/folio.trio"; do
    p=$(sed -n 's/^httpPort:\([0-9]*\).*/\1/p' "$f" 2>/dev/null | head -1)
    [ -n "$p" ] && { echo "$p"; return; }
  done
  echo 8080
}

# This install's JVM. fanlaunch puts the main class right after the home, so
# anchoring on it keeps "skyspark-3.1.8" from matching "skyspark-3.1.8 2".
jvm_pid() {
  pgrep -f -- "-Dfan\\.home=${1//./\\.} fanx\\.tools\\." 2>/dev/null | head -1
}

CMD="${1:-}"
case "$CMD" in
  any)
    pgrep -f -- "-Dfan\\.home=${ROOT//./\\.}/skyspark-.* fanx\\.tools\\." >/dev/null 2>&1
    exit $?
    ;;
  probe)
    file="${2:?entity file}"; ver="${3:?version}"
    home="$ROOT/skyspark-$ver"; port=$(port_of "$home")
    pid=$(jvm_pid "$home")
    if [ -z "$pid" ]; then
      state=stopped; label=STOPPED
      # Name the install that holds this port, if another one does.
      lpid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
      if [ -n "$lpid" ]; then
        other=$(ps -o command= -p "$lpid" 2>/dev/null | sed -n 's/.*-Dfan\.home=.*\/skyspark-\(.*\) fanx\.tools\..*/\1/p')
        label="STOPPED (:$port used by ${other:-pid $lpid})"
      fi
    elif lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      state=running; label=RUNNING
    else
      state=running; label=STARTING
    fi
    new=$(printf '{"state":"%s","label":"%s","port":"%s"}' "$state" "$label" "$port")
    [ "$new" = "$(cat "$file" 2>/dev/null)" ] || printf '%s\n' "$new" > "$file"
    ;;
  open)
    # Open this install's UI, but only when it is the one serving its port.
    ver="${2:?version}"; home="$ROOT/skyspark-$ver"; port=$(port_of "$home")
    pid=$(jvm_pid "$home")
    if [ -n "$pid" ] && lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      open "http://localhost:$port/"
      echo "Opening http://localhost:$port/"
    else
      echo "skyspark-$ver is not serving on :$port - start it first."
    fi
    ;;
  folder)
    ver="${2:?version}"; home="$ROOT/skyspark-$ver"
    open "$home" && echo "Opened $home"
    ;;
  set-port)
    # Write a new httpPort into the install's var folder. Only while stopped:
    # the running folio owns that file and would overwrite the edit.
    ver="${2:?version}"; new="${3:-}"; home="$ROOT/skyspark-$ver"
    case "$new" in ''|*[!0-9]*) echo "ERROR: invalid port '$new'" >&2; exit 1 ;; esac
    if [ "$new" -lt 1 ] || [ "$new" -gt 65535 ]; then echo "ERROR: port out of range: $new" >&2; exit 1; fi
    if [ -n "$(jvm_pid "$home")" ]; then
      echo "ERROR: skyspark-$ver is running - stop it first, then set the port" >&2; exit 1
    fi
    for f in "$home/var/host/folio.trio" "$home/var/sys/db/folio.trio"; do
      cur=$(sed -n 's/^httpPort:\([0-9]*\).*/\1/p' "$f" 2>/dev/null | head -1)
      [ -n "$cur" ] || continue
      if [ "$cur" = "$new" ]; then echo "skyspark-$ver: port already $new"; exit 0; fi
      cp -p "$f" "$f.bak" || exit 1
      sed -i '' "s/^httpPort:$cur\$/httpPort:$new/" "$f" || exit 1
      echo "skyspark-$ver: httpPort $cur -> $new"
      echo "  file: $f (backup .bak)"
      exit 0
    done
    echo "ERROR: no httpPort in $home/var (start it once so SkySpark creates it)" >&2
    exit 1
    ;;
  start|stop|restart|status)
    ver="${2:?version}"; home="$ROOT/skyspark-$ver"
    SKYSPARK_ROOT="$ROOT" exec bash "$HERE/skyspark.sh" "$CMD" "$ver" "port:$(port_of "$home")"
    ;;
  *)
    sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
