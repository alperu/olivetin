// docker-hosts.example.mjs — TEMPLATE for the Docker Management tab.
//
// Copy this to src/docker-hosts.mjs (which is gitignored) and fill in real
// values, then run:  node src/generate-olivetin-config.mjs --install
// NEVER commit src/docker-hosts.mjs — it holds plaintext passwords.
//
// AUTH: buttons run headless (no terminal), so each host authenticates with a
// stored password via sshpass. Requires sshpass on this Mac:
//   brew install hudochenkov/sshpass/sshpass
// (Omit `password` to use SSH-key auth instead: ssh-copy-id user@host.)
//
// Each entry:
//   name        — label on the buttons (unique within its OS list)
//   host        — IP or hostname
//   user        — SSH login. Windows + Bitvise Personal: must be a LOCAL Windows
//                 account in the docker-users group (domain accounts are rejected
//                 by Bitvise Personal on domain members).
//   password    — SSH password (plaintext). Omit for SSH-key auth.
//   dockerUser  — (windows) the account Docker Desktop is configured for and that
//                 has the live desktop session. The Start/Stop scheduled tasks run
//                 AS this user so the GUI launches in their session. Find it via
//                 the "Diagnose Windows" button (the Active console session).
//                 Differs per machine. Falls back to `user` if unset.
//   startTask   — (windows) Scheduled Task that starts Docker (create once via the
//                 "Create Windows tasks" button; runs as dockerUser, interactive).
//   stopTask    — (windows) Scheduled Task that stops Docker.
//
// Optional two-stage elevation (only if you SSH in as one account but must RUN as
// another — e.g. a Bitvise virtual user): set winUser / winPassword and commands
// run as that account via PowerShell -Credential. Usually NOT needed if `user`
// already logs in as a real local account.

export const dockerHosts = {
  windows: [
    { name: "win-box-1", host: "192.168.1.100", user: "dockerAdmin", password: "REPLACE", dockerUser: "", startTask: "StartDocker", stopTask: "StopDocker" },
  ],
  mac: [
    { name: "mac-mini", host: "192.168.1.50", user: "youruser", password: "REPLACE" },
  ],
};
