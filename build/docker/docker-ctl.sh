#!/usr/bin/env bash
# docker-ctl.sh — start/stop/restart Docker Desktop on ONE remote host over SSH.
#
# Usage: docker-ctl.sh <os> <action> <user> <host> [startTask] [stopTask] [winUser]
#   os        windows | mac
#   action    start | stop | restart | check | info
#   user      SSH (stage-1) username — on Windows this is the Bitvise login
#   host      IP or hostname
#   startTask (windows only) Scheduled Task name that launches Docker Desktop
#   stopTask  (windows only) Scheduled Task name that stops Docker Desktop;
#             empty -> fall back to docker-desktop-stop / taskkill + wsl shutdown
#   winUser   (windows only) real Windows account to run commands AS (stage 2)
#
# Env: SSHPASS = stage-1 SSH password (sshpass). WINPASS = stage-2 Windows
# account password (used to elevate on Windows via PowerShell -Credential).
#
# Two-stage auth on Windows: SSH in via Bitvise (user/SSHPASS), then run the
# actual command as the real Windows account (winUser/WINPASS) — because a
# Bitvise virtual user can't reach the Docker engine. Mac runs commands directly.
#
# Non-interactive by design: BatchMode means an unreachable / password-needing
# host FAILS FAST instead of hanging the OliveTin action until timeout.
set -u

# OliveTin runs actions with a minimal PATH that omits Homebrew, so sshpass/node
# (in /opt/homebrew/bin) wouldn't be found. Prepend the Homebrew bin dirs.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

OS="${1:?os}"; ACTION="${2:?action}"; USER_="${3:?user}"; HOST="${4:?host}"
START_TASK="${5:-StartDocker}"
STOP_TASK="${6:-}"
WIN_USER="${7:-}"
# DOCKER_USER (windows): the account Docker Desktop is configured for and that
# has the live desktop session. The StartDocker/StopDocker tasks run AS this user
# so the GUI launches in THEIR session. Falls back to the SSH account if unset.
DOCKER_USER="${8:-}"
# Username is passed via `-l` (not user@host) so a Windows account that includes
# a domain/computer qualifier — e.g. HQ2\alper, .\localadmin, alper@hq2.bassg.com
# — survives intact. Logging in as a real Windows account (not a Bitvise virtual
# user) is required for Docker engine + service access on Windows.

# Short, non-interactive SSH. accept-new trusts a first-seen host key (so the
# very first connection doesn't hang on a yes/no prompt) but still pins it after.
#
# Auth: if $SSHPASS is set (the generator exports the per-host password from
# docker-hosts.mjs), use `sshpass -e` to feed it in — reading from the env var
# keeps the password OUT of the visible process args. Otherwise fall back to
# key-based auth with BatchMode (fail fast instead of hanging on a prompt).
if [ -n "${SSHPASS:-}" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "  sshpass not installed — run: brew install hudochenkov/sshpass/sshpass" >&2
    exit 3
  fi
  SSH=(sshpass -e ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
       -o PreferredAuthentications=password -o PubkeyAuthentication=no)
else
  SSH=(ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new)
fi

say() { printf '  %s\n' "$*"; }

run() { # run a remote command, tolerate failure
  "${SSH[@]}" -l "$USER_" "$HOST" "$@"
}

# Build a PowerShell -EncodedCommand (base64 UTF-16LE) that runs INNER as the
# real Windows account (WIN_USER / $WINPASS) and prints its output. Encoding the
# whole script as base64 sidesteps every bash->ssh->cmd->powershell quoting trap:
# the wire command is just `powershell -EncodedCommand <one base64 token>`.
ps_encoded() { # inner-command -> base64
  local inner="$1" pw="${WINPASS:-}" ps
  pw=${pw//\'/\'\'}   # PowerShell single-quote escaping is doubling (unquoted so the \' resolve)
  # ProgressPreference off -> no "Preparing modules" CLIXML noise. ErrorAction
  # Stop -> a failed elevation (e.g. missing "Log on as a batch job" right)
  # throws into catch instead of looking like success.
  ps="\$ErrorActionPreference='Stop';\$ProgressPreference='SilentlyContinue';"
  ps+="\$u='${WIN_USER}';"
  ps+="\$p=ConvertTo-SecureString '${pw}' -AsPlainText -Force;"
  ps+="\$c=New-Object System.Management.Automation.PSCredential(\$u,\$p);"
  ps+="\$o=[IO.Path]::GetTempFileName();"
  ps+="try{"
  # Run INNER under cmd /c as the credential, capturing stdout+stderr to a temp
  # file. -WindowStyle Hidden is required (-Credential rejects -NoNewWindow).
  # -PassThru -Wait gives us the real child exit code to propagate.
  ps+="\$pr=Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c ${inner} 1> \"'+\$o+'\" 2>&1') -Credential \$c -WindowStyle Hidden -PassThru -Wait;"
  ps+="\$out=Get-Content -Raw -ErrorAction SilentlyContinue \$o;"
  ps+="Remove-Item \$o -Force -ErrorAction SilentlyContinue;"
  ps+="Write-Output \$out;exit \$pr.ExitCode"
  ps+="}catch{Remove-Item \$o -Force -ErrorAction SilentlyContinue;"
  ps+="Write-Output ('ELEVATION FAILED as ${WIN_USER}: '+\$_.Exception.Message);exit 99}"
  printf '%s' "$ps" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n'
}

# Run a command on the host. On Windows with a winUser+WINPASS, elevate to that
# account via the encoded PowerShell wrapper; otherwise run it directly.
# -OutputFormat Text keeps PowerShell from serializing its streams as CLIXML.
remote() { # inner-command
  if [ "$OS" = "windows" ] && [ -n "$WIN_USER" ] && [ -n "${WINPASS:-}" ]; then
    run "powershell -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand $(ps_encoded "$1")"
  else
    run "$1"
  fi
}

# Run a raw PowerShell SCRIPT on the host via -EncodedCommand (base64 UTF-16LE),
# which avoids all cross-shell quoting. No credential wrapper — used for the
# scheduled-task setup that must run as the SSH account itself.
run_ps() { # powershell-script
  run "powershell -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand $(printf '%s' "$1" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')"
}

reachable() {
  nc -z -w 3 "$HOST" 22 >/dev/null 2>&1
}

win_stop() {
  # Prefer a Scheduled Task (runs in the logged-on session, symmetric with
  # start) when one is configured; fall back to CLI/taskkill otherwise.
  if [ -n "$STOP_TASK" ]; then
    if remote "schtasks /run /tn \"$STOP_TASK\""; then
      say "Triggered Scheduled Task '$STOP_TASK'."
      return 0
    fi
    say "Scheduled Task '$STOP_TASK' failed — falling back to CLI/taskkill."
  fi
  # Modern CLI first (Docker Desktop v4.34+), classic fallback otherwise.
  if remote "docker desktop stop" 2>/dev/null; then
    say "Stopped via 'docker desktop stop'."
  else
    say "Modern CLI unavailable — force-killing Docker Desktop + shutting down WSL."
    remote "taskkill /F /IM \"Docker Desktop.exe\" /T" 2>/dev/null
    remote "wsl --shutdown" 2>/dev/null
  fi
}

win_start() {
  # Try, in order: (1) the StartDocker scheduled task (launches the GUI in a
  # logged-on session), (2) the Docker Desktop CLI, (3) the dockerd Windows
  # service (headless Docker Engine / Docker CE — works with NO login).
  if remote "schtasks /run /tn \"$START_TASK\""; then
    say "Triggered Scheduled Task '$START_TASK' (GUI start; needs a logged-on session)."
    return 0
  fi
  say "Scheduled Task '$START_TASK' not found/runnable — trying 'docker desktop start'."
  if remote "docker desktop start"; then
    say "Started via 'docker desktop start'."
    return 0
  fi
  say "Docker Desktop CLI unavailable — trying the Docker engine Windows service."
  # net start succeeds only if Docker Engine is installed as a service. 'docker'
  # = Docker CE/Mirantis dockerd; 'com.docker.service' = Docker Desktop helper.
  if remote "net start docker" || remote "net start com.docker.service"; then
    say "Started the Docker engine service (headless)."
    return 0
  fi
  say "FAILED to start Docker. Either create the StartDocker task + log into the"
  say "desktop, or install Docker Engine as a service for headless use (see README)."
  return 1
}

mac_stop() {
  if run "command -v docker >/dev/null 2>&1 && docker desktop stop" 2>/dev/null; then
    say "Stopped via 'docker desktop stop'."
  else
    say "Modern CLI unavailable — quitting Docker via AppleScript."
    run "osascript -e 'quit app \"Docker\"'" 2>/dev/null
  fi
}

mac_start() {
  if run "command -v docker >/dev/null 2>&1 && docker desktop start" 2>/dev/null; then
    say "Started via 'docker desktop start'."
  else
    say "Modern CLI unavailable — launching with 'open -a Docker'."
    run "open -a Docker"
  fi
}

echo "==> [$OS] $ACTION  $USER_@$HOST"
if ! reachable; then
  echo "  UNREACHABLE (no SSH on $HOST:22) — skipped."
  exit 1
fi

# `check` is OS-agnostic: prove the SSH login can actually reach the Docker
# engine. `docker ps` failing with "permission denied … pipe/docker_engine"
# means you're logged in as the wrong account (e.g. a Bitvise virtual user) or
# the account isn't in the Windows `docker-users` group. stderr is shown.
if [ "$ACTION" = "check" ]; then
  say "whoami (stage-1 SSH login):"; run "whoami" || say "  (failed)"
  say "whoami (elevated):";  remote "whoami" || say "  (failed)"
  say "docker --version:";   remote "docker --version" || say "  (failed)"
  say "docker ps:"
  ps_out=$(remote "docker ps" 2>&1); printf '%s\n' "$ps_out"
  if printf '%s' "$ps_out" | grep -qi 'permission denied'; then
    say "  -> account lacks Docker access: net localgroup docker-users <user> /add (then sign out/in)."
  elif printf '%s' "$ps_out" | grep -qiE 'cannot find the file|pipe/docker_engine|daemon'; then
    say "  -> Docker daemon NOT running — click Start to launch Docker Desktop (needs a logged-on desktop session)."
  fi
  exit 0
fi

# `create-tasks` (windows) — create the StartDocker/StopDocker scheduled tasks
# over SSH. They use LogonType Interactive so `schtasks /run` launches Docker
# Desktop INTO the logged-on user's desktop session (where the GUI can appear).
# Requires the SSH account to be a local admin. No password stored in the task
# (interactive token). One-time setup.
if [ "$ACTION" = "create-tasks" ]; then
  DD='C:\Program Files\Docker\Docker\Docker Desktop.exe'
  PRINCIPAL="${DOCKER_USER:-$USER_}"   # task runs AS the Docker-owning user
  say "Creating '$START_TASK' to run as '$PRINCIPAL' (launches Docker Desktop in THEIR session)…"
  run_ps "\$ErrorActionPreference='Stop';\$ProgressPreference='SilentlyContinue';try{\$a=New-ScheduledTaskAction -Execute '${DD}';\$p=New-ScheduledTaskPrincipal -UserId '${PRINCIPAL}' -LogonType Interactive -RunLevel Highest;Register-ScheduledTask -TaskName '${START_TASK}' -Action \$a -Principal \$p -Force | Out-Null;Write-Output 'Created ${START_TASK} (runs as ${PRINCIPAL})'}catch{Write-Output ('FAILED ${START_TASK}: '+\$_.Exception.Message)}"
  say "Creating '$STOP_TASK' to run as '$PRINCIPAL' (stop Docker Desktop)…"
  run_ps "\$ErrorActionPreference='Stop';\$ProgressPreference='SilentlyContinue';try{\$a=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c docker desktop stop';\$p=New-ScheduledTaskPrincipal -UserId '${PRINCIPAL}' -LogonType Interactive -RunLevel Highest;Register-ScheduledTask -TaskName '${STOP_TASK}' -Action \$a -Principal \$p -Force | Out-Null;Write-Output 'Created ${STOP_TASK} (runs as ${PRINCIPAL})'}catch{Write-Output ('FAILED ${STOP_TASK}: '+\$_.Exception.Message)}"
  exit 0
fi

# `diag` (windows) — what kind of Docker is installed + how to start it headless.
if [ "$ACTION" = "diag" ]; then
  # The remote shell is PowerShell, where `sc`/`where` are aliases — use .exe.
  say "Logged-on sessions (who can host the Docker GUI):"; remote "quser" 2>&1 || remote "query.exe user" 2>&1 || say "  (no sessions / quser unavailable)"
  say "Docker engine service (Docker CE / dockerd):"; remote "sc.exe query docker"            2>&1 || say "  no 'docker' service"
  say "Docker Desktop helper service:";               remote "sc.exe query com.docker.service" 2>&1 || say "  no 'com.docker.service'"
  say "dockerd.exe in PATH?:";                        remote "where.exe dockerd"               2>&1 || say "  dockerd not found"
  say "Docker Desktop CLI:";                          remote "docker desktop version"          2>&1 || say "  no 'docker desktop' CLI"
  say "Docker Desktop running?:";                     remote "tasklist /FI \"IMAGENAME eq Docker Desktop.exe\"" 2>&1
  say "Existing StartDocker task?:";                  remote "schtasks /query /tn \"$START_TASK\"" 2>&1 || say "  task '$START_TASK' does not exist"
  exit 0
fi

# `info` — machine-readable VERSION=/IMAGES= lines (consumed by docker-refresh.sh
# to fill the table's Version/Running columns). Elevated on Windows.
if [ "$ACTION" = "info" ]; then
  v=$(remote 'docker version --format "{{.Server.Version}}"' 2>/dev/null | tr -d '\r' | grep -v '^[[:space:]]*$' | head -1)
  i=$(remote 'docker ps --format "{{.Image}}"' 2>/dev/null | tr -d '\r' | grep -v '^[[:space:]]*$' | paste -sd , -)
  printf 'VERSION=%s\nIMAGES=%s\n' "$v" "$i"
  exit 0
fi

case "$OS" in
  windows)
    case "$ACTION" in
      start)   win_start ;;
      stop)    win_stop ;;
      restart) win_stop; sleep 5; win_start ;;
      *) echo "  unknown action '$ACTION'"; exit 2 ;;
    esac ;;
  mac)
    case "$ACTION" in
      start)   mac_start ;;
      stop)    mac_stop ;;
      restart) mac_stop; sleep 5; mac_start ;;
      *) echo "  unknown action '$ACTION'"; exit 2 ;;
    esac ;;
  *) echo "  unknown os '$OS'"; exit 2 ;;
esac
