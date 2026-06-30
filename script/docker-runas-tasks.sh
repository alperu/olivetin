#!/usr/bin/env bash
# docker-runas-tasks.sh
#
# Discover the user currently LOGGED ON to a Windows host's desktop and
# (re)create the StartDocker / StopDocker scheduled tasks to run AS that user.
# Triggering those tasks then launches Docker Desktop in that user's session —
# which is the only way a GUI app appears (an SSH session is not a desktop).
#
# Run this whenever the logged-on user changes (it auto-detects, so you never
# hand-edit `dockerUser`). Delegates the actual task creation to
# build/docker/docker-ctl.sh so the logic lives in one place.
#
# Usage:
#   SSHPASS='<ssh-password>' script/docker-runas-tasks.sh <host> [ssh-user] [startTask] [stopTask]
#
#   host        Windows host (IP or name), e.g. basws41.hq2.bassg.com
#   ssh-user    admin SSH account used to connect/create tasks (default: dockerAdmin)
#   startTask   scheduled-task name to create  (default: StartDocker)
#   stopTask    scheduled-task name to create  (default: StopDocker)
#
# Requires: sshpass (brew install hudochenkov/sshpass/sshpass), host reachable
# on SSH :22, and the ssh-user being a local admin. The discovered account must
# have an Active or Disconnected session — if nobody is logged on, this exits
# without creating tasks (you can't launch a GUI into a session that does not
# exist; log in as the Docker user, or set up auto-logon first).
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

HOST="${1:?usage: SSHPASS=... $0 <host> [ssh-user] [startTask] [stopTask]}"
SSH_USER="${2:-dockerAdmin}"
START_TASK="${3:-StartDocker}"
STOP_TASK="${4:-StopDocker}"

HERE="$(cd "$(dirname "$0")" && pwd)"
CTL="$HERE/../build/docker/docker-ctl.sh"
[ -f "$CTL" ] || { echo "Cannot find docker-ctl.sh at $CTL" >&2; exit 2; }

[ -n "${SSHPASS:-}" ] || { echo "Set SSHPASS to the SSH password, e.g.:  SSHPASS='secret' $0 $HOST" >&2; exit 2; }
command -v sshpass >/dev/null 2>&1 || { echo "sshpass missing — brew install hudochenkov/sshpass/sshpass" >&2; exit 3; }

SSH=(sshpass -e ssh -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new \
     -o PreferredAuthentications=password -o PubkeyAuthentication=no)

# Override: set DOCKER_USER to skip auto-detection. Needed when the user is on an
# RDP session that `quser` over SSH can't enumerate (only the physical console
# session is reliably visible). The session still exists, so the task launches.
if [ -n "${DOCKER_USER:-}" ]; then
  echo "==> Using DOCKER_USER override: '$DOCKER_USER' (skipping detection)…"
  echo "==> Creating '$START_TASK' / '$STOP_TASK' to run as '$DOCKER_USER'…"
  SSHPASS="$SSHPASS" bash "$CTL" windows create-tasks "$SSH_USER" "$HOST" "$START_TASK" "$STOP_TASK" "" "$DOCKER_USER"
  exit $?
fi

echo "==> Discovering the logged-on user on $HOST (as $SSH_USER)…"
QU="$("${SSH[@]}" -l "$SSH_USER" "$HOST" "quser" 2>&1)" || true

# Parse quser. The username is always the first token (after an optional ">"
# marking the querying session). STATE (Active/Disc) anchors the choice — prefer
# an Active session, fall back to a Disconnected one.
USERNAME="$(printf '%s\n' "$QU" | awk '
  /USERNAME/ { next }
  {
    line = $0
    sub(/^[[:space:]]*>/, "", line)      # drop the ">" current-session marker
    sub(/^[[:space:]]+/, "", line)
    n = split(line, f, /[[:space:]]+/)
    if (n < 2) next
    u = f[1]
    if (line ~ /[[:space:]]Active([[:space:]]|$)/ && active == "") active = u
    else if (line ~ /[[:space:]]Disc([[:space:]]|$)/ && disc == "") disc = u
  }
  END { if (active != "") print active; else if (disc != "") print disc }')"

if [ -z "$USERNAME" ]; then
  echo "!! No logged-on user found on $HOST." >&2
  echo "   quser returned:" >&2
  printf '%s\n' "$QU" | sed 's/^/     /' >&2
  echo "   A GUI app needs a desktop session. Log in as the Docker user (RDP/console)" >&2
  echo "   or configure auto-logon, then re-run this script." >&2
  exit 1
fi

echo "    logged-on user: $USERNAME"
echo "==> Creating '$START_TASK' / '$STOP_TASK' to run as '$USERNAME'…"
SSHPASS="$SSHPASS" bash "$CTL" windows create-tasks "$SSH_USER" "$HOST" "$START_TASK" "$STOP_TASK" "" "$USERNAME"

echo
echo "Done. To launch Docker Desktop into $USERNAME's session now, run:"
echo "    SSHPASS='<pw>' bash $CTL windows start $SSH_USER $HOST $START_TASK $STOP_TASK"
echo "(Tip: also set dockerUser:\"$USERNAME\" for $HOST in src/docker-hosts.mjs to persist it.)"
