// apps.mjs — declarative definition of every MCP application that should get
// its own OliveTin tab, plus the buttons (actions) for that tab.
//
// Each action's `shell` is run by OliveTin. We `cd` into the app dir first so
// the project's own scripts resolve their relative paths correctly.
//
// `group` is used to lay buttons out under a labelled divider inside the tab.
// Edit this file and re-run generate-olivetin-config.mjs to update the UI.

import { readdirSync, existsSync, readFileSync } from "node:fs";

const HOME = process.env.HOME;
// Control script for Jevbridge lives in THIS repo (the Jevbridge clone is
// third-party and stays pristine so `git pull` never conflicts).
const JEV_CTL = new URL("../build/jevbridge/jevbridge-ctl.sh", import.meta.url).pathname;
// SkySpark: one table row per install found under ~/skyspark at generate time.
// Re-run the generator after adding or removing an install.
const SKY_ROOT = `${HOME}/skyspark`;
const SKY_CTL = new URL("../build/skyspark/skyspark-ctl.sh", import.meta.url).pathname;
const skysparkVersions = existsSync(SKY_ROOT)
  ? readdirSync(SKY_ROOT)
      .filter((d) => d.startsWith("skyspark-") && existsSync(`${SKY_ROOT}/${d}/bin/skyspark`))
      .map((d) => d.slice("skyspark-".length))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  : [];
// Current httpPort from the var folder (3.x var/host, 4.x var/sys/db) — the
// default shown in the "Set port" form. Mirrors port_of in skyspark-ctl.sh.
const skysparkPort = (v) => {
  for (const f of ["var/host/folio.trio", "var/sys/db/folio.trio"]) {
    try {
      const m = readFileSync(`${SKY_ROOT}/skyspark-${v}/${f}`, "utf8").match(/^httpPort:(\d+)/m);
      if (m) return Number(m[1]);
    } catch {}
  }
  return 8080;
};

/**
 * popupOnStart presets:
 *   dialog  -> execution-dialog            (command + status)
 *   output  -> execution-dialog-stdout-only (just the output, good for status/logs)
 */
export const POPUP = {
  dialog: "execution-dialog",
  output: "execution-dialog-stdout-only",
};

export const apps = [
  {
    id: "mcp-proxy",
    title: "MCP Proxy Server",
    icon: "🔌",
    dir: `${HOME}/Code/mcp-proxy`,
    port: 9191, // single HTTP frontend / admin GUI
    log: "logs/proxy.out logs/proxy.err", // tail target for live logs
    actions: [
      { group: "Lifecycle", label: "Start",   icon: "▶️", cmd: "bash scripts/start.sh",   popup: "dialog" },
      { group: "Lifecycle", label: "Stop",    icon: "⏹️", cmd: "bash scripts/stop.sh",    popup: "dialog" },
      { group: "Lifecycle", label: "Restart", icon: "🔄", cmd: "bash scripts/restart.sh", popup: "dialog" },
      { group: "Diagnostics", label: "Smoke test", icon: "🧪", cmd: "npm run smoke",                         popup: "output" },
      { group: "Diagnostics", label: "Tail logs",  icon: "📜", cmd: "tail -n 120 logs/proxy.out logs/proxy.err 2>/dev/null || echo 'no logs yet'", popup: "output" },
    ],
  },
  {
    id: "mcpfantom",
    title: "Fantom MCP Server",
    icon: "👻",
    dir: `${HOME}/Code/mcpfantom`,
    port: 3848, // HTTP server (config/fantomMcpServer-config.json)
    path: "/dashboard/", // web UI lives under /dashboard/
    log: "logs/server.log",
    actions: [
      { group: "Lifecycle", label: "Start (HTTP)", icon: "▶️", cmd: "bash scripts/start-server.sh",   popup: "dialog" },
      { group: "Lifecycle", label: "Start (dev)",  icon: "🛠️", cmd: "bash scripts/start-dev.sh",      popup: "dialog" },
      { group: "Lifecycle", label: "Stop",         icon: "⏹️", cmd: "bash scripts/stop-server.sh",    popup: "dialog" },
      { group: "Lifecycle", label: "Restart",      icon: "🔄", cmd: "bash scripts/restart-server.sh", popup: "dialog" },
      { group: "Diagnostics", label: "Status",   icon: "📈", cmd: "bash scripts/status-server.sh", popup: "output" },
      { group: "Diagnostics", label: "Tail logs", icon: "📜", cmd: "tail -n 120 logs/server.log 2>/dev/null || echo 'no logs yet'", popup: "output" },
      { group: "Build", label: "Build", icon: "🏗️", cmd: "npm run build", popup: "output" },
      // Non-streaming: `npm run daemon:logs` (pm2 logs) streams forever and would
      // hold an OliveTin connection until timeout. --nostream prints and exits.
      { group: "Build", label: "PM2 logs", icon: "🪵", cmd: "pm2 logs fantom-mcp --lines 150 --nostream", popup: "output" },
    ],
  },
  {
    id: "axon-mcp-server",
    title: "Axon MCP Server",
    icon: "⚡",
    dir: `${HOME}/Code/axon-mcp-server`,
    port: 3847, // HTTP server (MCP_PORT) — dashboard / health / admin
    path: "/dashboard/", // web UI lives under /dashboard/
    log: "/tmp/axon-mcp-server.log",
    actions: [
      { group: "Lifecycle", label: "Start (HTTP)", icon: "▶️", cmd: "bash scripts/start-server.sh",   popup: "dialog" },
      { group: "Lifecycle", label: "Stop",         icon: "⏹️", cmd: "bash scripts/stop-server.sh",    popup: "dialog" },
      { group: "Lifecycle", label: "Restart",      icon: "🔄", cmd: "bash scripts/restart-server.sh", popup: "dialog" },
      { group: "Diagnostics", label: "Status",    icon: "📈", cmd: "bash scripts/status-server.sh", popup: "output" },
      { group: "Diagnostics", label: "Tail logs",  icon: "📜", cmd: "tail -n 120 /tmp/axon-mcp-server.log 2>/dev/null || echo 'no logs yet'", popup: "output" },
      { group: "Build", label: "Build", icon: "🏗️", cmd: "npm run build", popup: "output" },
      // Non-streaming snapshot (see Fantom note) — OliveTin actions run to their
      // timeout regardless of whether the page is open, so streaming would hold
      // a connection even after you navigate away.
      { group: "Build", label: "PM2 logs", icon: "🪵", cmd: "pm2 logs axon-mcp --lines 150 --nostream", popup: "output" },
    ],
  },
  {
    id: "court-lens-mcp",
    // No dot in the title: OliveTin's server 404s on /dashboards/<name>.<ext>,
    // which makes the dashboard hang on "Loading dashboard…" when it re-resolves.
    title: "SoundSuite AI",
    icon: "⚖️",
    dir: `${HOME}/Code/court-lens-mcp`,
    port: 3000, // Next.js dashboard
    log: "logs/*.log",
    actions: [
      // Lifecycle is driven by a launchd user agent (com.soundsuite.dashboard),
      // NOT by launching start.sh as an OliveTin child. Reason: a backgrounded
      // child of an OliveTin action dies on SIGHUP/SIGKILL when the action is
      // reaped (e.g. Restart held start.sh's `tail -f` open until OliveTin's
      // timeout killed the whole tree). launchd owns the lifecycle instead, so
      // these buttons just poke launchctl and return instantly (detach:false so
      // you SEE the result). Run "Install service" once to lay down the plist.
      { group: "Lifecycle", label: "Start",   icon: "▶️", cmd: "bash scripts/svc-ctl.sh start",   popup: "output", detach: false },
      { group: "Lifecycle", label: "Stop",    icon: "⏹️", cmd: "bash scripts/svc-ctl.sh stop",    popup: "output", detach: false },
      { group: "Lifecycle", label: "Restart", icon: "🔄", cmd: "bash scripts/svc-ctl.sh restart", popup: "output", detach: false },
      { group: "Lifecycle", label: "Install service", icon: "📦", cmd: "bash scripts/svc-ctl.sh install", popup: "output", detach: false },
      { group: "Diagnostics", label: "Health check", icon: "❤️", cmd: "bash scripts/health-check.sh", popup: "output" },
      { group: "Diagnostics", label: "Service status", icon: "📊", cmd: "bash scripts/svc-ctl.sh status", popup: "output", detach: false },
      { group: "Diagnostics", label: "Tail logs",    icon: "📜", cmd: "tail -n 120 logs/*.log 2>/dev/null || echo 'no logs yet'", popup: "output" },
      // The Chrome-MCP launcher also lives natively in this repo; surfaced here
      // and again on the dedicated Chrome MCP tab.
      { group: "Chrome", label: "Run Chrome MCP", icon: "🌐", cmd: "bash scripts/chromeMcpRun.sh", popup: "dialog" },
    ],
  },
  {
    id: "mcpserversedona",
    title: "Sedona MCP Server",
    icon: "🌲",
    dir: `${HOME}/Code/mcpserversedona`,
    // Driven via npm scripts; stop.sh added to the repo for clean shutdown.
    actions: [
      { group: "Lifecycle", label: "Start",     icon: "▶️", cmd: "npm start",     popup: "dialog" },
      { group: "Lifecycle", label: "Start (dev)", icon: "🛠️", cmd: "npm run dev", popup: "dialog" },
      { group: "Lifecycle", label: "Stop",      icon: "⏹️", cmd: "bash scripts/stop.sh", popup: "output" },
      { group: "Build", label: "Build", icon: "🏗️", cmd: "npm run build", popup: "output" },
      { group: "Build", label: "Test",  icon: "🧪", cmd: "npm test",      popup: "output" },
      { group: "Devices", label: "List devices", icon: "📟", cmd: "npm run devices:list", popup: "output" },
      { group: "Devices", label: "Device stats", icon: "📊", cmd: "npm run devices:stats", popup: "output" },
      { group: "Devices", label: "Show config",  icon: "⚙️", cmd: "npm run config:list",  popup: "output" },
    ],
  },
  {
    id: "skyspark",
    title: "SkySpark",
    icon: "📡",
    iconImg: new URL("../build/skyspark/skyspark-logo.png", import.meta.url).pathname,
    dir: SKY_ROOT,
    // Green while any install's JVM is up. Per-install state is in the table.
    statusCmd: `bash ${SKY_CTL} any`,
    actions: [],
    develop: [
      { label: "Open axon-library in IntelliJ", path: `${HOME}/Code/axon_library_2025/axon-library` },
      { label: "Open axon-mcp-server/proj in IntelliJ", path: `${HOME}/Code/axon-mcp-server/proj` },
    ],
    // Rendered as a table: Version · Status · Port · Start · Stop · Restart · Status · Open · Folder · Set port.
    // Port is read from each install's var folder when the button runs.
    table: {
      head: ["Status", "Port", "Start", "Stop", "Restart", "Status", "Open", "Folder", "Set port"],
      cells: [["dh-status", "label"], ["dh-ver", "port"]], // [cssClass, entity field]
      // Probe line per row: `<probe> <entityFile> <name>` writes the row entity.
      probe: `bash ${SKY_CTL} probe`,
      rows: skysparkVersions.map((v) => ({
        name: v,
        actions: [
          // detach:false — skyspark.sh detaches the JVM itself and returns.
          { label: `Start ${v}`,   icon: "▶️", cmd: `bash ${SKY_CTL} start '${v}'`,   popup: "output", detach: false },
          { label: `Stop ${v}`,    icon: "⏹️", cmd: `bash ${SKY_CTL} stop '${v}'`,    popup: "output", detach: false },
          { label: `Restart ${v}`, icon: "🔄", cmd: `bash ${SKY_CTL} restart '${v}'`, popup: "output", detach: false },
          { label: `Status ${v}`,  icon: "📈", cmd: `bash ${SKY_CTL} status '${v}'`,  popup: "output", detach: false },
          { label: `Open ${v}`,    icon: "🌐", cmd: `bash ${SKY_CTL} open '${v}'`,    popup: "output", detach: false },
          { label: `Folder ${v}`,  icon: "📁", cmd: `bash ${SKY_CTL} folder '${v}'`,  popup: "output", detach: false },
          // OliveTin shows a form for the argument; the install must be stopped.
          { label: `Set port ${v}`, icon: "✏️", cmd: `bash ${SKY_CTL} set-port '${v}' {{ port }}`, popup: "output", detach: false,
            arguments: [{ name: "port", title: `New http port for ${v}`, type: "int", default: skysparkPort(v),
              description: "Stop this install first. Takes effect on next Start." }] },
        ],
      })),
    },
  },
  {
    id: "jevbridge",
    title: "Jevbridge",
    icon: "🧭",
    dir: `${HOME}/Code/Jevbridge`,
    // STDIO MCP server: no daemon, no port. Claude Code spawns one copy per
    // session. Start/Stop = register/unregister with Claude Code (user scope);
    // the tab is green while registered. See build/jevbridge/jevbridge-ctl.sh.
    statusCmd: `bash ${JEV_CTL} check`,
    actions: [
      // detach:false — these return instantly and you want to SEE the result.
      { group: "Lifecycle", label: "Start",   icon: "▶️", cmd: `bash ${JEV_CTL} start`,   popup: "output", detach: false },
      { group: "Lifecycle", label: "Stop",    icon: "⏹️", cmd: `bash ${JEV_CTL} stop`,    popup: "output", detach: false },
      { group: "Lifecycle", label: "Restart", icon: "🔄", cmd: `bash ${JEV_CTL} restart`, popup: "output", detach: false },
      { group: "Diagnostics", label: "Status", icon: "📈", cmd: `bash ${JEV_CTL} status`, popup: "output" },
      { group: "Diagnostics", label: "Test",   icon: "🧪", cmd: `bash ${JEV_CTL} test`,   popup: "output" },
      { group: "Build", label: "Update (git pull)", icon: "⬇️", cmd: `bash ${JEV_CTL} update`, popup: "output" },
    ],
  },
];

// A dedicated "Chrome MCP" tab. court-lens-mcp ships the canonical
// chromeMcpRun.sh; it accepts an optional route path and a PORT env override.
export const chromeMcp = {
  title: "Chrome MCP",
  icon: "🌐",
  dir: `${HOME}/Code/court-lens-mcp`,
  actions: [
    // Default: launch the MCP Chrome and open its CDP info page (:9222) so you
    // can confirm it's the MCP-enabled instance.
    { group: "Launch", label: "Run Chrome MCP",       icon: "🌐", cmd: "bash scripts/chromeMcpRun.sh",            popup: "dialog" },
    // Same MCP Chrome, but open the app under test on :3000 for debugging.
    { group: "Launch", label: "Run Chrome MCP (app :3000)", icon: "🔎", cmd: "PORT=3000 bash scripts/chromeMcpRun.sh /", popup: "dialog" },
    // Stop the debug Chrome by its unique user-data-dir so we don't touch the
    // user's normal Chrome windows.
    { group: "Launch", label: "Stop Chrome MCP", icon: "⏹️", cmd: 'pkill -f "claude-debug-chrome" && echo "Stopped Chrome MCP" || echo "Chrome MCP not running"', popup: "output" },
    // Inspect: confirm WHICH Chrome is the MCP/CDP one. The /json/version
    // endpoint is served by the debug Chrome on port 9222.
    { group: "Inspect", label: "Open CDP info (:9222)", icon: "🔍", cmd: 'open "http://localhost:9222/json/version"', popup: "output" },
    { group: "Inspect", label: "Show CDP info (text)", icon: "📋", cmd: 'curl -s http://localhost:9222/json/version || echo "No Chrome MCP on :9222"', popup: "output" },
  ],
};
