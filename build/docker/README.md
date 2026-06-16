# Docker Management tab

Bulk start/stop/restart of **Docker Desktop** on remote Macs and Windows boxes,
from the OliveTin sidebar. Hosts are defined in
[`src/docker-hosts.mjs`](../../src/docker-hosts.mjs); the buttons shell out to
[`docker-ctl.sh`](./docker-ctl.sh) over SSH.

## How it works

- **`src/docker-hosts.mjs`** — your machines, grouped `windows` / `mac`.
- The generator emits, on the **Docker Management** tab, three button groups:
  - **All** — Start / Stop / Restart *every* host.
  - **Windows** — Start/Stop/Restart all Windows, then per-host buttons.
  - **Mac** — Start/Stop/Restart all Mac, then per-host buttons.
- The sidebar **dot** is green only when *all* hosts answer on SSH `:22`
  (i.e. "host reachable" — not a guarantee that the Docker daemon is up).
- Edit the config, then regenerate: `node src/generate-olivetin-config.mjs --install`
  and restart OliveTin.

## Prerequisites (without these the buttons do nothing)

### 1. Passwordless SSH from this Mac to every host
Actions run **non-interactively** (`ssh -o BatchMode=yes`). A host that would
prompt for a password is treated as *failed*, never prompted.
```bash
ssh-copy-id user@host        # macOS / Linux targets
# Windows: append your ~/.ssh/id_*.pub to C:\Users\<user>\.ssh\authorized_keys
```

### 1b. Two-stage Windows auth (Bitvise SSH → real Windows account)
A Bitvise SSH Server **virtual user** (you land in `C:\Users\BvSsh_VirtualUsers`)
cannot reach the Docker engine: `docker --version` works but `docker ps` returns
`permission denied … pipe/docker_engine`, and `Get-Service` can't open the SCM.
So we keep Bitvise as the transport and then run the actual commands **as a real
Windows account** via PowerShell `-Credential`. That needs **two** credentials:

| field | meaning |
|-------|---------|
| `user` / `password` | **stage 1** — the Bitvise SSH login |
| `winUser` / `winPassword` | **stage 2** — the real Windows account Docker runs as |

Set up per Windows host:
- `winUser`: a local/domain account in the **`docker-users`** group. Qualify it:
  `HQ2\alper` (domain), `.\localadmin` (local), or `alper@hq2.bassg.com`.
  Add it: `net localgroup docker-users <winUser> /add` (admin PowerShell; then
  sign that user out/in).
- That account also needs the **"Log on as a batch job"** right
  (`secpol.msc → Local Policies → User Rights Assignment`), which
  `Start-Process -Credential` uses.
- Click **Check access** on the Docker Management tab — it prints `whoami` for
  *both* the stage-1 SSH login and the elevated account, plus `docker --version`
  and `docker ps` (with errors) for every host. The two whoami lines should
  differ (Bitvise virtual user vs `winUser`), and `docker ps` should succeed.

How it works internally: commands are sent as
`powershell -EncodedCommand <base64>` (base64 avoids cross-shell quoting issues);
the script builds a `PSCredential` from `winUser`/`winPassword` and runs the
command under `Start-Process -Credential`, capturing its output back to you.

### 2. Windows hosts — enable OpenSSH Server + a "StartDocker" Scheduled Task
Starting a GUI app (Docker Desktop) over SSH fails because the SSH session is
isolated from the interactive desktop (Session 0). The fix is a Scheduled Task
that launches Docker in the **logged-on user's** session; we trigger it with
`schtasks /run`.

One-time, on each Windows machine:
1. **Settings → Apps → Optional Features** → install **OpenSSH Server**, then
   `Start-Service sshd; Set-Service -Name sshd -StartupType Automatic`.
2. **Task Scheduler → Create Basic Task** named **`StartDocker`**
   (must match `startTask` in `docker-hosts.mjs`):
   - Action: *Start a program* →
     `C:\Program Files\Docker\Docker\Docker Desktop.exe`
   - In the task **Properties**: *Run only when user is logged on* (this is what
     makes the GUI actually appear on the screen).
3. *(optional)* **Create a second Basic Task** named **`StopDocker`**
   (must match `stopTask` in `docker-hosts.mjs`):
   - Action: *Start a program* → `powershell` with arguments:
     `-WindowStyle Hidden -Command "& {docker desktop stop 2>$null; if (Get-Process 'Docker Desktop' -EA SilentlyContinue) { Stop-Process -Name 'Docker Desktop' -Force; wsl --shutdown }}"`
   - Same *Run only when user is logged on*.

`stop` triggers the `StopDocker` Scheduled Task when set. If it's omitted (or the
task run fails), it falls back to `docker desktop stop` → `taskkill /F /IM
"Docker Desktop.exe" /T` + `wsl --shutdown`.

### 3. macOS hosts — nothing extra
`docker desktop start|stop` (v4.34+) is used, falling back to `open -a Docker` /
`osascript -e 'quit app "Docker"'`. Enable **Remote Login** (System Settings →
General → Sharing) so SSH works.

## Manual test
```bash
build/docker/docker-ctl.sh mac restart alper 192.168.1.50
build/docker/docker-ctl.sh windows start alper 192.168.1.100 StartDocker
```
An unreachable host prints `UNREACHABLE (no SSH on <host>:22) — skipped` and exits
non-zero instead of hanging.
