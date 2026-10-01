#!/bin/bash
#
# Control the local SkySpark: start, stop, restart, status, install.
#
# Usage: ./skyspark.sh <start|stop|restart|status|install> [version] [port:<n>] [api:<n>] [-noAuth]
#
#   ./skyspark.sh start                     default install, port 8080
#   ./skyspark.sh start 3.1.12 port:8888    install skyspark-3.1.12 on :8888
#   ./skyspark.sh restart 3.1.12            switch whatever runs on :8080 to 3.1.12
#   ./skyspark.sh restart 3.1.12 -noAuth    same, with authentication disabled
#   ./skyspark.sh stop port:8888            stop whatever is on :8888
#   ./skyspark.sh status 3.1.12 port:8888   exit 3 if another install runs there
#   ./skyspark.sh install 3.1.12 -noAuth    build pod 3.1.12.4, install it, restart
#
# version  folder suffix under $SKYSPARK_ROOT (skyspark-<version>); any installed
#          suffix works (3.1.12, 3.1.8Bugra), or an absolute path.
# port     http port. Default 8080. Also accepted as --port <n>, -p <n> or a
#          bare number. `start` writes it to the install's host folio
#          (var/host/folio.trio httpPort) before boot, so SkySpark binds it.
# --wait   start/restart/install: wait until HTTP is up and every project is
#          in steady state (up to START_TIMEOUT). Without it the script
#          returns right after launching SkySpark; follow with `status`.
# -noAuth  start/restart/install only: boot with SkySpark's -noAuth option, which
#          disables authentication and runs every request as 'su'. Local
#          development only. Also accepted as --noAuth or --no-auth.
# api      install only: pod API level, the last part of the pod version.
#          Default 5. install runs skyspark_pod/buildLocal<version>.fan
#          (dots removed, e.g. buildLocal3112.fan), then restarts.
#
# Env overrides: SKYSPARK_ROOT, SKYSPARK_HOME, SKYSPARK_PORT, SKYSPARK_LOG,
# STOP_TIMEOUT, START_TIMEOUT.
#
set -uo pipefail

usage() {
  sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# --- arguments ---------------------------------------------------------------

CMD="${1:-}"
[ -n "$CMD" ] || usage 1
shift

SKYSPARK_VERSION=""
PORT_ARG=""
NO_AUTH=""
WAIT=""
API_LEVEL=5
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)       usage 0 ;;
    -noAuth|--noAuth|--no-auth|-noauth|--noauth) NO_AUTH=1 ;;
    --wait|-wait|wait) WAIT=1 ;;
    port:*|port=*)   PORT_ARG="${1#port?}" ;;
    api:*|api=*)     API_LEVEL="${1#api?}" ;;
    --port=*)        PORT_ARG="${1#--port=}" ;;
    --port|-p)       shift; PORT_ARG="${1:-}" ;;
    *[!0-9]*)        SKYSPARK_VERSION="$1" ;;  # has a non-digit: a version
    *)               PORT_ARG="$1" ;;          # digits only: a port
  esac
  shift
done

if [ -n "$PORT_ARG" ]; then
  case "$PORT_ARG" in
    ''|*[!0-9]*) echo "ERROR: invalid port '$PORT_ARG'" >&2; exit 1 ;;
  esac
  SKYSPARK_PORT="$PORT_ARG"
fi

# --- config ------------------------------------------------------------------

SKYSPARK_ROOT="${SKYSPARK_ROOT:-/Users/alper/skyspark}"

if [ -n "$SKYSPARK_VERSION" ]; then
  case "$SKYSPARK_VERSION" in
    /*) SKYSPARK_HOME="$SKYSPARK_VERSION" ;;
    *)  SKYSPARK_HOME="$SKYSPARK_ROOT/skyspark-$SKYSPARK_VERSION" ;;
  esac
fi

SKYSPARK_HOME="${SKYSPARK_HOME:-$SKYSPARK_ROOT/skyspark-3.1.8}"
SKYSPARK_PORT="${SKYSPARK_PORT:-8080}"
SKYSPARK_LOG="${SKYSPARK_LOG:-$SKYSPARK_HOME/var/log/skyspark-console.log}"

# Graceful shutdown normally completes in ~10-15s; startup reaches HTTP in ~30s.
# These are ceilings for the polling loops, not fixed waits.
STOP_TIMEOUT="${STOP_TIMEOUT:-60}"
START_TIMEOUT="${START_TIMEOUT:-300}"  # --wait only; cluster boots are slower

# --- helpers -----------------------------------------------------------------

# Installed versions, i.e. the suffixes accepted as the version argument.
skyspark_versions() {
  local d
  for d in "$SKYSPARK_ROOT"/skyspark-*/; do
    [ -x "${d}bin/skyspark" ] && basename "$d" | sed 's/^skyspark-//'
  done
}

# Fail before touching anything if the requested install does not exist, so a
# typo in `restart` does not leave you with nothing running.
check_home() {
  [ -x "$SKYSPARK_HOME/bin/skyspark" ] && return 0
  echo "ERROR: no skyspark binary at $SKYSPARK_HOME/bin/skyspark" >&2
  echo "       installed versions:" >&2
  skyspark_versions | sed 's/^/         /' >&2
  exit 1
}

#
# PID of the process listening on the SkySpark port.
#
# Deliberately NOT read from var/skyspark.pid: that file goes stale after an
# unclean shutdown and will happily name a PID that no longer exists (observed
# 2026-09-22 - the file said 92474 while the live JVM was 21290). The listening
# socket is the only thing that cannot lie about whether the server is up.
#
skyspark_pid() {
  lsof -nP -iTCP:"$SKYSPARK_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1
}

skyspark_running() {
  [ -n "$(skyspark_pid)" ]
}

# PID of this install's JVM, whether or not it has bound the port yet (or at
# all - an install configured for another http port never binds ours).
# fanlaunch always puts the main class (fanx.tools.*) right after the home, so
# anchoring on it keeps "skyspark-3.1.8" from matching "skyspark-3.1.8 2".
skyspark_jvm_pid() {
  pgrep -f -- "-Dfan\\.home=${SKYSPARK_HOME//./\\.} fanx\\.tools\\." 2>/dev/null | head -1
}

# Install folder of whatever is listening on the port. The launcher passes
# -Dfan.home=<install> to the JVM; the process cwd is the fallback.
skyspark_running_home() {
  local pid home
  pid=$(skyspark_pid)
  [ -n "$pid" ] || return 1
  home=$(ps -o command= -p "$pid" 2>/dev/null | sed -n 's/.*-Dfan\.home=\(.*\) fanx\.tools\..*/\1/p' | head -1)
  [ -n "$home" ] || home=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  echo "${home%/}"
}

# Is the running server this install? Compares resolved paths, so a trailing
# slash or symlink does not cause a false mismatch.
skyspark_is_this_home() {
  local running
  running=$(skyspark_running_home) || return 1
  [ "$(cd "$running" 2>/dev/null && pwd -P)" = "$(cd "$SKYSPARK_HOME" && pwd -P)" ]
}

# HTTP reachable? /user/login is public - no credentials, no redirect chase.
skyspark_http_ok() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
         "http://127.0.0.1:$SKYSPARK_PORT/user/login" 2>/dev/null)
  [ "$code" = "200" ]
}

# SkySpark reads its http port at boot from the @http rec in the host folio
# (var/host/folio.trio, `httpPort:<n>`). Point it at $SKYSPARK_PORT so the
# server binds the port we ask for. Only called while this install is stopped:
# the folio owns that file while running.
skyspark_set_port() {
  local trio="$SKYSPARK_HOME/var/host/folio.trio" cur
  [ -f "$trio" ] || return 0   # fresh install: SkySpark default port applies
  cur=$(sed -n 's/^httpPort:\([0-9]*\).*/\1/p' "$trio" | head -1)
  if [ -z "$cur" ]; then
    echo "  WARNING: no httpPort in $trio - cannot set port $SKYSPARK_PORT" >&2
    return 0
  fi
  [ "$cur" = "$SKYSPARK_PORT" ] && return 0
  cp -p "$trio" "$trio.bak" || return 1
  sed -i '' "s/^httpPort:$cur\$/httpPort:$SKYSPARK_PORT/" "$trio" || return 1
  echo "  httpPort: $cur -> $SKYSPARK_PORT ($trio, backup .bak)"
}

# Port the install last reported binding, from the console log.
skyspark_log_port() {
  grep -o 'http started on port [0-9]*' "$SKYSPARK_LOG" 2>/dev/null | tail -1 | grep -o '[0-9]*$'
}

# Hint text that repeats the port only when it is not the default, plus
# -noAuth when it was asked for.
port_hint() {
  local h=""
  [ "$SKYSPARK_PORT" = "8080" ] || h=" port:$SKYSPARK_PORT"
  [ -z "$NO_AUTH" ] || h="$h -noAuth"
  echo "$h"
}

# Does the server on the port run with -noAuth? The launcher passes boot
# options straight through to the JVM command line.
skyspark_running_noauth() {
  local pid
  pid=$(skyspark_pid)
  [ -n "$pid" ] || return 1
  ps -o command= -p "$pid" 2>/dev/null | tr ' ' '\n' | grep -qx -- '-noAuth'
}

auth_label() {
  if [ -n "$1" ]; then echo "OFF (-noAuth, every request runs as su)"; else echo "on"; fi
}

# --- commands ----------------------------------------------------------------

#
# Stop SkySpark and wait for the port to actually free.
#
# Returning before the socket closes is what makes a scripted restart flaky:
# the next start races the dying JVM for the port and dies with a bind error,
# or worse, two JVMs briefly hold the same folio.
#
# With a version given, refuses to stop a different install on the port.
#
cmd_stop() {
  local pid i
  pid=$(skyspark_pid)
  if [ -z "$pid" ]; then
    # Nothing on the port, but this install's JVM may still be up - serving on
    # another port, or wedged while holding var/vm.lock. Stop that one too,
    # otherwise the next start dies with CannotAcquireLockFileErr.
    pid=$(skyspark_jvm_pid)
    if [ -z "$pid" ]; then
      echo "SkySpark already stopped (nothing on :$SKYSPARK_PORT)"
      return 0
    fi
    echo "Stopping SkySpark JVM not on :$SKYSPARK_PORT (pid $pid, $SKYSPARK_HOME)..."
    kill "$pid" 2>/dev/null
    for i in $(seq 1 "$STOP_TIMEOUT"); do
      kill -0 "$pid" 2>/dev/null || { echo "Stopped after ${i}s"; return 0; }
      sleep 1
    done
    echo "WARNING: still up after ${STOP_TIMEOUT}s - sending SIGKILL" >&2
    kill -9 "$pid" 2>/dev/null
    sleep 2
    kill -0 "$pid" 2>/dev/null && { echo "ERROR: pid $pid will not die" >&2; return 1; }
    echo "Killed"
    return 0
  fi

  if [ -n "$SKYSPARK_VERSION" ] && ! skyspark_is_this_home; then
    echo "ERROR: :$SKYSPARK_PORT is held by another install (pid $pid), not stopping it" >&2
    echo "       running: $(skyspark_running_home)" >&2
    echo "       asked:   $SKYSPARK_HOME" >&2
    echo "       stop it anyway with: $0 stop$(port_hint)" >&2
    return 1
  fi

  echo "Stopping SkySpark (pid $pid, $(skyspark_running_home))..."
  kill "$pid" 2>/dev/null

  for i in $(seq 1 "$STOP_TIMEOUT"); do
    if ! skyspark_running; then
      # The port frees before the JVM exits (cluster/arcbeam shutdown takes
      # a few seconds more); a start in that window finds the old JVM.
      local j
      for j in $(seq 1 "$STOP_TIMEOUT"); do
        [ -z "$(skyspark_jvm_pid)" ] && break
        sleep 1
      done
      echo "Stopped after ${i}s (JVM exited after $((i + j))s)"
      return 0
    fi
    sleep 1
  done

  # SIGTERM ignored. Escalate, but say so loudly: a SIGKILL skips folio's clean
  # shutdown, so the next start may replay from the journal.
  echo "WARNING: still up after ${STOP_TIMEOUT}s - sending SIGKILL" >&2
  echo "         folio will not have flushed cleanly; expect journal replay" >&2
  kill -9 "$pid" 2>/dev/null

  for i in $(seq 1 15); do
    skyspark_running || { echo "Killed after ${i}s"; return 0; }
    sleep 1
  done

  echo "ERROR: pid $pid still holding :$SKYSPARK_PORT" >&2
  return 1
}

#
# Start SkySpark detached and wait until it is actually ready.
#
# HTTP answering is NOT the same as ready: SysMods start before the project
# manifest loads, so /user/login can serve while folio queries still fail.
# Wait for every local project to report steady state, so a caller can chain
# straight into a test.
#
cmd_start() {
  local i want got http_at="" jvm
  if skyspark_running; then
    if skyspark_is_this_home; then
      local running_noauth=""
      skyspark_running_noauth && running_noauth=1
      echo "SkySpark already running (pid $(skyspark_pid)) on :$SKYSPARK_PORT"
      echo "  home: $SKYSPARK_HOME"
      echo "  auth: $(auth_label "$running_noauth")"
      # Same install, but not in the auth mode asked for: say so rather than
      # letting a caller test against the wrong mode.
      if [ "$running_noauth" != "$NO_AUTH" ]; then
        echo "ERROR: running auth mode differs from the requested one" >&2
        echo "       switch with: $0 restart ${SKYSPARK_VERSION:-<version>}$(port_hint)" >&2
        return 1
      fi
      return 0
    fi
    # Another install owns the port. Starting this one would only lose the bind.
    echo "ERROR: :$SKYSPARK_PORT is held by another install (pid $(skyspark_pid))" >&2
    echo "       running: $(skyspark_running_home)" >&2
    echo "       wanted:  $SKYSPARK_HOME" >&2
    echo "       switch with: $0 restart ${SKYSPARK_VERSION:-<version>}$(port_hint)" >&2
    return 1
  fi

  # This install's JVM is already up but not on our port: either it serves on
  # another port, or it is wedged. A second JVM would only die on var/vm.lock.
  jvm=$(skyspark_jvm_pid)
  if [ -n "$jvm" ]; then
    local bound
    bound=$(skyspark_log_port)
    echo "ERROR: $SKYSPARK_HOME is already running (pid $jvm) but nothing is on :$SKYSPARK_PORT" >&2
    if [ -n "$bound" ] && [ "$bound" != "$SKYSPARK_PORT" ]; then
      echo "       it serves on :$bound - move it with: $0 restart ${SKYSPARK_VERSION:-<version>}$(port_hint)" >&2
    else
      echo "       it holds var/vm.lock without serving http - kill it: kill $jvm" >&2
    fi
    return 1
  fi

  mkdir -p "$(dirname "$SKYSPARK_LOG")"
  echo "Starting SkySpark from $SKYSPARK_HOME on :$SKYSPARK_PORT ..."
  skyspark_set_port || { echo "ERROR: could not set httpPort" >&2; return 1; }
  echo "  auth: $(auth_label "$NO_AUTH")"
  echo "  console log: $SKYSPARK_LOG"

  local args=()
  [ -z "$NO_AUTH" ] || args+=(-noAuth)
  # Fully detach the JVM: stdin from /dev/null, output to the log, and every
  # other inherited descriptor closed. A caller that waits for its pipes to
  # close (Claude Code's `!`, `| tail`, CI) would otherwise hang until
  # SkySpark stops.
  (
    cd "$SKYSPARK_HOME" || exit 1
    for fd in $(ls /dev/fd); do
      [ "$fd" -gt 2 ] 2>/dev/null && eval "exec $fd>&-"
    done
    nohup ./bin/skyspark ${args[@]+"${args[@]}"} </dev/null >"$SKYSPARK_LOG" 2>&1 &
  ) 2>/dev/null

  # Default: return now. Boots take 15 s to several minutes (clusters), and
  # a caller such as a chat session must not sit in this loop.
  if [ -z "$WAIT" ]; then
    sleep 2
    if grep -q 'Cannot boot' "$SKYSPARK_LOG" 2>/dev/null; then
      echo "ERROR: SkySpark cannot boot - last lines:" >&2
      grep -A3 'Cannot boot' "$SKYSPARK_LOG" >&2
      return 1
    fi
    jvm=$(skyspark_jvm_pid)
    if [ -z "$jvm" ]; then
      echo "ERROR: process exited right away - last lines:" >&2
      tail -20 "$SKYSPARK_LOG" >&2
      return 1
    fi
    echo "Launched (pid $jvm); booting in the background."
    echo "  check with: $0 status ${SKYSPARK_VERSION:-}$(port_hint)   (or add --wait)"
    return 0
  fi

  for i in $(seq 1 "$START_TIMEOUT"); do
    if [ -z "$http_at" ] && skyspark_http_ok; then
      http_at=$i
      echo "  http up after ${i}s"
    fi

    if [ -n "$http_at" ]; then
      # grep -c prints 0 AND exits 1 on no match, so `|| echo 0` would append a
      # second line and the arithmetic test blows up with "integer expression
      # expected". Take the first line and default only if grep printed nothing.
      want=$(ls -1 "$SKYSPARK_HOME/var/proj" 2>/dev/null | wc -l | tr -d ' ')
      got=$(grep -c 'Steady state' "$SKYSPARK_LOG" 2>/dev/null | head -1)
      want=${want:-0}; got=${got:-0}
      if [ "$want" -eq 0 ] || [ "$got" -ge "$want" ]; then
        echo "Ready after ${i}s - pid $(skyspark_pid), http://127.0.0.1:$SKYSPARK_PORT/"
        echo "  projects steady: $got/$want"
        return 0
      fi
    fi

    # SkySpark prints "Cannot boot" (lock file held, bad config) and exits.
    if grep -q 'Cannot boot' "$SKYSPARK_LOG" 2>/dev/null; then
      echo "ERROR: SkySpark cannot boot - last lines:" >&2
      grep -A3 'Cannot boot' "$SKYSPARK_LOG" >&2
      return 1
    fi

    # Fail fast on a boot that died rather than burning the whole timeout.
    # Check the JVM itself, not the port: an install whose http port is not
    # $SKYSPARK_PORT stays alive without ever binding it.
    if [ "$i" -gt 15 ] && ! skyspark_running && [ -z "$(skyspark_jvm_pid)" ]; then
      echo "ERROR: process exited during startup - last lines:" >&2
      tail -20 "$SKYSPARK_LOG" >&2
      return 1
    fi
    sleep 1
  done

  jvm=$(skyspark_jvm_pid)
  if [ -n "$jvm" ] && ! skyspark_running; then
    local bound
    bound=$(skyspark_log_port)
    echo "ERROR: JVM up (pid $jvm) but nothing on :$SKYSPARK_PORT after ${START_TIMEOUT}s" >&2
    if [ -n "$bound" ]; then
      echo "       this install serves on :$bound - use: $0 status ${SKYSPARK_VERSION:-<version>} port:$bound" >&2
    fi
    echo "       left running; stop it with: kill $jvm" >&2
  else
    echo "ERROR: no HTTP response after ${START_TIMEOUT}s - last lines:" >&2
  fi
  tail -20 "$SKYSPARK_LOG" >&2
  return 1
}

#
# Stop whatever install holds the port, then start the requested one. This is
# also how to switch versions (3.1.8 running -> restart 3.1.12). check_home
# already ran, so a typo does not leave you with nothing running.
#
cmd_restart() {
  local version="$SKYSPARK_VERSION"
  SKYSPARK_VERSION=""   # stop whatever is on the port, not only this install
  cmd_stop || return 1
  SKYSPARK_VERSION="$version"
  cmd_start
}

#
# Build the bassgMobilytik pod for this install with skyspark_pod's
# buildLocal<version>.fan (it installs into var/lib/fan), then restart so the
# pod and its lib/*.trio defs load.
#
cmd_install() {
  local pod_dir script
  pod_dir="$(cd "$(dirname "$0")/../../.." && pwd)"
  script="$pod_dir/buildLocal$(basename "$SKYSPARK_HOME" | sed 's/^skyspark-//; s/\.//g').fan"
  if [ ! -f "$script" ]; then
    echo "ERROR: no build script $script" >&2
    return 1
  fi
  echo "Building bassgMobilytik with $(basename "$script") (api $API_LEVEL)..."
  ( cd "$pod_dir" && FAN_HOME="$SKYSPARK_HOME" "$SKYSPARK_HOME/bin/fan" "$script" "$API_LEVEL" ) || {
    echo "ERROR: pod build failed, SkySpark left as it is" >&2
    return 1
  }
  cmd_restart
}

#
# Report whether SkySpark is up and serving HTTP.
# Exit 0 = running and serving, 1 = not running, 2 = process up but HTTP dead,
# 3 = a different install than the requested version is running.
#
cmd_status() {
  local pid
  pid=$(skyspark_pid)
  if [ -z "$pid" ]; then
    echo "SkySpark: STOPPED (nothing listening on :$SKYSPARK_PORT)"
    echo "  home: $SKYSPARK_HOME"
    return 1
  fi

  local running_noauth=""
  skyspark_running_noauth && running_noauth=1
  echo "SkySpark: RUNNING  pid=$pid  port=$SKYSPARK_PORT"
  echo "  home: $(skyspark_running_home)"
  echo "  auth: $(auth_label "$running_noauth")"

  if [ -n "$SKYSPARK_VERSION" ] && ! skyspark_is_this_home; then
    echo "  NOT the requested install: $SKYSPARK_HOME"
    echo "  switch with: $0 restart $SKYSPARK_VERSION$(port_hint)"
    return 3
  fi

  if skyspark_http_ok; then
    echo "  http: OK"
  else
    echo "  http: NOT RESPONDING (process is up - still starting, or wedged)"
    return 2
  fi

  return 0
}

case "$CMD" in
  start)   check_home; cmd_start ;;
  stop)    check_home; cmd_stop ;;
  restart) check_home; cmd_restart ;;
  status)  check_home; cmd_status ;;
  install) check_home; cmd_install ;;
  -h|--help|help) usage 0 ;;
  *) echo "ERROR: unknown command '$CMD'" >&2; usage 1 ;;
esac
