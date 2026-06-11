// apps.mjs — declarative definition of every MCP application that should get
// its own OliveTin tab, plus the buttons (actions) for that tab.
//
// Each action's `shell` is run by OliveTin. We `cd` into the app dir first so
// the project's own scripts resolve their relative paths correctly.
//
// `group` is used to lay buttons out under a labelled divider inside the tab.
// Edit this file and re-run generate-olivetin-config.mjs to update the UI.

const HOME = process.env.HOME;

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
    actions: [
      { group: "Lifecycle", label: "Start",   icon: "▶️", cmd: "bash scripts/start.sh",   popup: "dialog" },
      { group: "Lifecycle", label: "Stop",    icon: "⏹️", cmd: "bash scripts/stop.sh",    popup: "dialog" },
      { group: "Lifecycle", label: "Restart", icon: "🔄", cmd: "bash scripts/restart.sh", popup: "dialog" },
      { group: "Diagnostics", label: "Health check", icon: "❤️", cmd: "bash scripts/health-check.sh", popup: "output" },
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
