#!/usr/bin/env node
// generate-olivetin-config.mjs
//
// Generates an OliveTin config.yaml that gives every MCP application its own
// TAB, with buttons wired to that app's real scripts (see apps.mjs), a
// dedicated "Chrome MCP" tab, and a live running/stopped COLOR indicator per
// app (green = running, red = stopped).
//
// How the color works:
//   * status-probe.sh (generated into build/) checks each app and writes a
//     one-row entity JSON file ({"state":"running|stopped",...}).
//   * A hidden "status: Refresh" action runs the probe on startup, every
//     minute, and is `triggers`-ed by every lifecycle button.
//   * Each tab has a Status fieldset bound to that app's entity, containing a
//     `type: display` whose cssClass is `status-{{ entity.state }}`.
//   * custom-webui/themes/mcpstatus/theme.css colors `.status-running` green
//     and `.status-stopped` red. Activated via `themeName: mcpstatus`.
//
// Usage:
//   node src/generate-olivetin-config.mjs                # print config to stdout
//   node src/generate-olivetin-config.mjs --out FILE     # write config to FILE
//   node src/generate-olivetin-config.mjs --install      # install everything
//                                                          to the live OliveTin
//                                                          dir (backs up old)
//   node src/generate-olivetin-config.mjs --install --dir /path/to/olivetin
//
// After --install, restart OliveTin to load the new tabs.

import {
  readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { apps, chromeMcp, POPUP } from "./apps.mjs";
import { dockerHosts } from "./docker-hosts.mjs";

const DEFAULT_OLIVETIN_DIR = `${process.env.HOME}/.local/opt/olivetin`;
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const THEME_NAME = "mcpstatus";
const REFRESH_TITLE = "status: Refresh";
// Dashboard titles are kept CLEAN (no emoji/double-space): OliveTin's server
// 404s on emoji routes like /dashboards/%E2%9A%96%EF%B8%8F... but serves the
// SPA fine for clean paths. Per-app emoji live on the Home cards instead.
const HOME_TAB = "Home";

// Sidebar status dots are painted LIVE by dots.js (polling status.json), not by
// a cached CSS file — so they update on their own and are never stale after a
// refresh. This hidden <img onerror> bootstraps dots.js once per page load; it's
// injected into every dashboard so the poller is running no matter where you land.
// (innerHTML-inserted <script> tags don't execute, but an <img onerror> does.)
const INJECT_HTML =
  "<img src='/__mcpdots.png' style='display:none' onerror='" +
  "if(!window.__mcpDots){window.__mcpDots=1;" +
  "var s=document.createElement(\"script\");" +
  "s.src=\"/custom-webui/themes/" + THEME_NAME + "/dots.js\";" +
  "document.head.appendChild(s);}'>";

// ---------------------------------------------------------------------------
// Tiny YAML scalar emitter (no deps — we only emit shapes we control).
// ---------------------------------------------------------------------------
const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const actionTitle = (appId, label) => `${appId}: ${label}`;
// Entity name = template namespace; must be a bare identifier.
const entityName = (id) => id.replace(/[^a-z0-9]/gi, "").toLowerCase() + "status";

// ---------------------------------------------------------------------------
// Build actions
// ---------------------------------------------------------------------------
function actionsFor(appId, dir, defs, { withStatusTrigger } = {}) {
  return defs.map((a) => {
    // OliveTin treats timeout:0 as its 3s default and SIGKILLs the action.
    // "Start"/"Run" launchers run a server (often in the foreground, e.g. the
    // Chrome launcher `exec`s Chrome) so they must be DETACHED — backgrounded
    // with nohup so the action returns immediately and the process survives.
    // detach: false opts out (e.g. remote Docker ops, where we want to SEE the
    // per-host SSH result in the dialog, not a "launched in background" stub).
    const detach = a.detach === false ? false : /^(Start|Run)\b/.test(a.label);
    // dir is optional — Docker Management drives remote hosts and has no cwd.
    const cd = dir ? `cd ${dir} && ` : "";
    // OliveTin launched from the Dock app inherits a minimal PATH (no Homebrew),
    // so node/npm/sshpass aren't found and `bash scripts/start.sh` dies with
    // "node: No such file or directory". Prefix every action with Homebrew bins.
    const PATHX = 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
    const shell = detach
      ? `${PATHX}${cd}(nohup ${a.cmd} >/tmp/olivetin-${appId}.log 2>&1 &) ; echo "Launched in background — log: /tmp/olivetin-${appId}.log"`
      : `${PATHX}${cd}${a.cmd}`;
    return {
      title: actionTitle(appId, a.label),
      shell,
      icon: a.icon,
      popupOnStart: POPUP[a.popup] ?? POPUP.dialog,
      timeout: detach ? 20 : 600, // generous so builds/starts don't get killed
      arguments: a.arguments,
      // Re-probe status immediately after a lifecycle action runs.
      triggers: withStatusTrigger ? [REFRESH_TITLE] : undefined,
    };
  });
}

function dashboardFor(appId, title, icon, defs, { entity } = {}) {
  const groups = [];
  const byGroup = new Map();
  for (const a of defs) {
    if (!byGroup.has(a.group)) { byGroup.set(a.group, []); groups.push(a.group); }
    byGroup.get(a.group).push(a);
  }
  // tab = clean route/display title; icon kept separately for the Home cards.
  return { tab: title, name: title, icon, appId, groups, byGroup, entity };
}

const allActions = [];
const allDashboards = [];
const warpConfigs = []; // Warp launch configs to write on --install

for (const app of apps) {
  // Per-project shortcuts: open its web UI in a browser tab (so you don't have
  // to remember ports) and open the code in IntelliJ.
  const defs = [
    ...app.actions,
    ...(app.port
      ? [(() => {
          const url = `http://localhost:${app.port}${app.path || ""}`;
          return {
            group: "Open",
            label: `Open web UI (:${app.port})`,
            icon: "🌐",
            // Check the port is actually listening before opening, so you don't
            // get a dead browser tab when the server isn't running.
            cmd: `if lsof -i :${app.port} -sTCP:LISTEN -t >/dev/null 2>&1; then open "${url}"; echo "Opening ${url}"; else echo "Not running on :${app.port} — start it first."; fi`,
            popup: "output",
          };
        })()]
      : []),
    { group: "Develop", label: "Open in IntelliJ", icon: "🧠", cmd: 'open -a "IntelliJ IDEA" .', popup: "output" },
  ];
  allActions.push(...actionsFor(app.id, app.dir, defs, { withStatusTrigger: true }));
  const dash = dashboardFor(app.id, app.title, app.icon, defs, { entity: entityName(app.id) });
  // "Refresh logs" in the Status section — reuses this app's Tail logs command
  // so you can re-pull the latest log snapshot on demand.
  // "Watch logs (Warp)" — opens a Warp tab live-tailing the log. Live streaming
  // belongs in a terminal, not in OliveTin (which can't hold a stream open).
  if (app.log) {
    const cfgName = `${app.id}-logs`;
    warpConfigs.push({ name: cfgName, dir: app.dir, title: `${app.title} logs`, log: app.log });
    const t = `${app.id}: Watch logs (Warp)`;
    allActions.push({ title: t, shell: `open "warp://launch/${cfgName}"`, icon: "🪵", popupOnStart: POPUP.output, timeout: 20 });
    dash.watchLogs = t;
  }
  allDashboards.push(dash);
}
// Chrome MCP tab — running = a debug Chrome exposing CDP on :9222 (see probe).
allActions.push(...actionsFor("chrome-mcp", chromeMcp.dir, chromeMcp.actions, { withStatusTrigger: true }));
allDashboards.push(dashboardFor("chrome-mcp", chromeMcp.title, chromeMcp.icon, chromeMcp.actions, { entity: entityName("chrome-mcp") }));

// Docker Management tab — bulk start/stop/restart of Docker Desktop on remote
// machines (grouped All / Windows / Mac, plus per-host buttons). Hosts come from
// src/docker-hosts.mjs; each button shells docker-ctl.sh over non-interactive
// SSH so an unreachable host fails fast instead of hanging the action.
const DOCKER_CTL = join(REPO_ROOT, "build", "docker", "docker-ctl.sh");
const DOCKER_REFRESH = join(REPO_ROOT, "build", "docker", "docker-refresh.sh");
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`; // shell single-quote
// Shared entity merge: `node -e "$JS" file k1 v1 k2 v2 …` updates the given keys
// in a per-host entity JSON while PRESERVING the others — so the per-minute
// reachability probe (state/label) and the manual details refresh (version/
// images) can write the same file without clobbering each other. Defaults keep
// every field present so the table templates never render blank.
const ENTITY_MERGE_JS =
  'const fs=require("fs");const a=process.argv.slice(1);const f=a[0];let o={};' +
  'try{o=JSON.parse(fs.readFileSync(f))}catch(e){}' +
  'for(let i=1;i+1<a.length;i+=2){o[a[i]]=a[i+1]}' +
  'o.state=o.state||"stopped";o.label=o.label||"?";' +
  'o.version=o.version||"\\u2014";o.images=o.images||"(none)";' +
  'const n=JSON.stringify(o)+"\\n";let c="";' +
  'try{c=fs.readFileSync(f,"utf8")}catch(e){}if(c!==n)fs.writeFileSync(f,n)';
function dockerCmd(os, action, h) {
  const extra = os === "windows"
    ? ` ${sq(h.startTask || "StartDocker")} ${sq(h.stopTask || "")} ${sq(h.winUser || "")} ${sq(h.dockerUser || "")}`
    : "";
  // Stage-1 SSH password via SSHPASS (sshpass -e). Omit to fall back to keys.
  const auth = h.password ? `SSHPASS=${sq(h.password)} ` : "";
  // Stage-2 (Windows): real-account password, used to elevate via PowerShell.
  const win = os === "windows" && h.winPassword ? `WINPASS=${sq(h.winPassword)} ` : "";
  return `${auth}${win}bash ${sq(DOCKER_CTL)} ${os} ${action} ${sq(h.user)} ${sq(h.host)}${extra}`;
}
// Run every host sequentially with ";" (not "&&") so one failure doesn't abort
// the rest; the per-host script prints its own ==> header for each.
function bulkCmd(pairs, action, emptyMsg) {
  if (!pairs.length) return `echo ${sq(emptyMsg)}`;
  return pairs.map(([os, h]) => dockerCmd(os, action, h)).join(" ; ");
}
const winHosts = (dockerHosts.windows || []).map((h) => ["windows", h]);
const macHosts = (dockerHosts.mac || []).map((h) => ["mac", h]);
const VERBS = [["Start", "start", "▶️"], ["Stop", "stop", "⏹️"], ["Restart", "restart", "🔄"]];
// Per-host status entity (reachability on SSH :22, written by the probe). One
// per host so each table row colours independently.
const dockerHostEntity = (h) => entityName(`dockerhost-${h.host}`);
const dockerHostEntityNames = [...winHosts, ...macHosts].map(([, h]) => dockerHostEntity(h));
// Bulk buttons stay as grouped cards; per-host control lives in the table below.
const bulkDefs = [];
for (const [verb, action, icon] of VERBS) {
  bulkDefs.push({ group: "All", label: `${verb} all`, icon, popup: "output", detach: false,
    cmd: bulkCmd([...winHosts, ...macHosts], action, "No hosts configured (edit src/docker-hosts.mjs).") });
}
// Manual gather of Docker version + running images into the per-host entities
// (fills the Version/Running table columns). On demand — no per-minute SSH.
bulkDefs.push({ group: "All", label: "Refresh details", icon: "🔁", popup: "output", detach: false,
  cmd: `bash ${sq(DOCKER_REFRESH)}` });
// Diagnose the "docker ps: permission denied" / wrong-SSH-account problem:
// shows whoami + docker version + docker ps (with errors) for every host.
bulkDefs.push({ group: "All", label: "Check access", icon: "🩺", popup: "output", detach: false,
  cmd: bulkCmd([...winHosts, ...macHosts], "check", "No hosts configured.") });
// One-time setup: create the StartDocker/StopDocker scheduled tasks (interactive,
// so schtasks /run launches the GUI in the logged-on session) on Windows hosts.
bulkDefs.push({ group: "Setup", label: "Create Windows tasks", icon: "🛠️", popup: "output", detach: false,
  cmd: bulkCmd(winHosts, "create-tasks", "No Windows hosts configured.") });
// Diagnose Docker install type + how to start it (Desktop vs dockerd service).
bulkDefs.push({ group: "Setup", label: "Diagnose Windows", icon: "🔬", popup: "output", detach: false,
  cmd: bulkCmd(winHosts, "diag", "No Windows hosts configured.") });
for (const [G, pairs] of [["Windows", winHosts], ["Mac", macHosts]]) {
  for (const [verb, action, icon] of VERBS) {
    bulkDefs.push({ group: G, label: `${verb} all ${G}`, icon, popup: "output", detach: false,
      cmd: bulkCmd(pairs, action, `No ${G} hosts configured.`) });
  }
}
// Per-host actions — generated so the table can reference them by title, but NOT
// placed in any visible group (the table is their only UI).
const perHostDefs = [];
const dockerRows = []; // table rows: one per host
for (const [os, h] of [...winHosts, ...macHosts]) {
  for (const [verb, action, icon] of VERBS) {
    perHostDefs.push({ label: `${verb} ${h.name}`, icon, popup: "output", detach: false,
      cmd: dockerCmd(os, action, h) });
  }
  dockerRows.push({
    name: h.name,
    os,
    entity: dockerHostEntity(h),
    actions: VERBS.map(([verb]) => actionTitle("docker", `${verb} ${h.name}`)),
  });
}
allActions.push(...actionsFor("docker", null, [...bulkDefs, ...perHostDefs], { withStatusTrigger: true }));
const dockerDash = dashboardFor("docker", "Docker Management", "🐳", bulkDefs, { entity: entityName("docker") });
dockerDash.tableRows = dockerRows; // rendered as a status+buttons table by emitDashboards
allDashboards.push(dockerDash);

// Home landing page — FIRST dashboard so OliveTin opens here instead of the
// first project. One clickable card per project, linking to its dashboard.
// A project's dashboard route is /dashboards/<urlencoded tab title>.
function buildHomeDashboard(dashboards) {
  // Client-side nav (pushState+popstate) for an instant switch; the clean href
  // is the fallback (a full load of a clean /dashboards/<name> path serves the
  // SPA, which then routes to the dashboard).
  // NB: qualify with window. — in an inline handler, bare dispatchEvent binds
  // to document, but OliveTin's router listens for popstate on window.
  const onclick = "event.preventDefault();window.history.pushState({},'',this.getAttribute('href'));window.dispatchEvent(new PopStateEvent('popstate'));";
  const cards = dashboards.map((d) => {
    const href = `/dashboards/${encodeURIComponent(d.tab)}`;
    return `<a class='project-card' href='${href}' onclick="${onclick}"><span class='ic'>${d.icon}</span><span class='nm'>${d.tab}</span></a>`;
  }).join("");
  const html = `<div class='project-home'>${cards}</div>`;
  return { tab: HOME_TAB, home: true, html, icon: "🏠" };
}
allDashboards.unshift(buildHomeDashboard(allDashboards.slice()));

// ---------------------------------------------------------------------------
// Serialize config.yaml
// ---------------------------------------------------------------------------
function emitArguments(args, indent) {
  if (!args || args.length === 0) return "";
  const p = " ".repeat(indent);
  let out = `${p}arguments:\n`;
  for (const a of args) {
    out += `${p}  - name: ${q(a.name)}\n`;
    out += `${p}    title: ${q(a.title)}\n`;
    out += `${p}    type: ${a.type}\n`;
    if (a.default !== undefined) out += `${p}    default: ${JSON.stringify(a.default)}\n`;
    if (a.description) out += `${p}    description: ${q(a.description)}\n`;
  }
  return out;
}

function emitAction(a) {
  let out = `  - title: ${q(a.title)}\n`;
  out += `    shell: ${q(a.shell)}\n`;
  if (a.icon) out += `    icon: ${q(a.icon)}\n`;
  out += `    popupOnStart: ${a.popupOnStart}\n`;
  out += `    timeout: ${a.timeout}\n`;
  if (a.hidden) out += `    hidden: true\n`;
  if (a.execOnStartup) out += `    execOnStartup: true\n`;
  if (a.execOnCron) out += `    execOnCron: ${q(a.execOnCron)}\n`;
  if (a.triggers) {
    out += `    triggers:\n`;
    for (const t of a.triggers) out += `      - ${q(t)}\n`;
  }
  out += emitArguments(a.arguments, 4);
  return out + "\n";
}

function emitActions(actions, refreshAction) {
  let out = "actions:\n";
  out += emitAction(refreshAction);
  for (const a of actions) out += emitAction(a);
  return out;
}

function emitEntities(olivetinDir) {
  let out = "entities:\n";
  const names = [...apps.map((a) => entityName(a.id)), entityName("chrome-mcp"), entityName("docker"), ...dockerHostEntityNames];
  for (const name of names) {
    out += `  - file: ${q(join(olivetinDir, "entities", `${name}.json`))}\n`;
    out += `    name: ${name}\n`;
  }
  return out + "\n";
}

function emitDashboards(dashboards) {
  let out = "dashboards:\n";
  for (const d of dashboards) {
    out += `  - title: ${q(d.tab)}\n`;
    out += `    contents:\n`;
    // Boots the live sidebar-dot poller (hidden). Present on every dashboard.
    out += `      - type: display\n`;
    out += `        cssClass: ${q("dots-injector")}\n`;
    out += `        title: ${q(INJECT_HTML)}\n`;
    if (d.home) {
      out += `      - title: ${q("Projects")}\n`;
      out += `        type: fieldset\n`;
      out += `        contents:\n`;
      out += `          - type: display\n`;
      out += `            cssClass: ${q("home")}\n`;
      out += `            title: ${q(d.html)}\n`;
      out += "\n";
      continue;
    }
    if (d.entity) {
      // Running/stopped color indicator at the top of the tab.
      out += `      - title: ${q("Status")}\n`;
      out += `        type: fieldset\n`;
      out += `        entity: ${d.entity}\n`;
      out += `        contents:\n`;
      out += `          - type: display\n`;
      out += `            cssClass: ${q(`status-{{ ${d.entity}.state }}`)}\n`;
      out += `            title: ${q(`{{ ${d.entity}.label }}`)}\n`;
      if (d.watchLogs) out += `          - title: ${q(d.watchLogs)}\n`;
    }
    for (const group of d.groups) {
      out += `      - title: ${q(group)}\n`;
      out += `        type: fieldset\n`;
      out += `        contents:\n`;
      out += `          - type: display\n`;
      out += `            title: ${q(`<strong>━━ ${group} ━━</strong>`)}\n`;
      for (const a of d.byGroup.get(group)) {
        out += `          - title: ${q(actionTitle(d.appId, a.label))}\n`;
      }
    }
    // Per-host table (Docker Management): each host is a fieldset row laid out by
    // the theme CSS as Host · Status · Start · Stop · Restart. A `.dh-status`
    // marker class scopes the table CSS (fieldsets carry no class of their own).
    if (d.tableRows && d.tableRows.length) {
      // Header row — inert displays so columns line up with the rows below.
      out += `      - title: ${q("Host")}\n`;
      out += `        type: fieldset\n`;
      out += `        contents:\n`;
      for (const h of ["Status", "Version", "Running", "Start", "Stop", "Restart"]) {
        out += `          - type: display\n`;
        out += `            cssClass: ${q(`dh-head${h === "Status" ? " dh-status" : ""}`)}\n`;
        out += `            title: ${q(h)}\n`;
      }
      for (const row of d.tableRows) {
        out += `      - title: ${q(row.name)}\n`;
        out += `        type: fieldset\n`;
        out += `        entity: ${row.entity}\n`;
        out += `        contents:\n`;
        out += `          - type: display\n`;
        out += `            cssClass: ${q(`dh-status status-{{ ${row.entity}.state }}`)}\n`;
        out += `            title: ${q(`{{ ${row.entity}.label }}`)}\n`;
        out += `          - type: display\n`;
        out += `            cssClass: ${q("dh-ver")}\n`;
        out += `            title: ${q(`{{ ${row.entity}.version }}`)}\n`;
        out += `          - type: display\n`;
        out += `            cssClass: ${q("dh-img")}\n`;
        out += `            title: ${q(`{{ ${row.entity}.images }}`)}\n`;
        for (const t of row.actions) out += `          - title: ${q(t)}\n`;
      }
    }
    out += "\n";
  }
  return out;
}

function readServerSettings(olivetinDir) {
  const cfgPath = join(olivetinDir, "config.yaml");
  let listen = "0.0.0.0:1337";
  let logLevel = "INFO";
  if (existsSync(cfgPath)) {
    const txt = readFileSync(cfgPath, "utf8");
    const l = txt.match(/^listenAddressSingleHTTPFrontend:\s*(\S+)/m);
    const lv = txt.match(/^logLevel:\s*"?(\w+)"?/m);
    if (l) listen = l[1];
    if (lv) logLevel = lv[1];
  }
  return { listen, logLevel };
}

function buildConfig(olivetinDir) {
  const { listen } = readServerSettings(olivetinDir);
  const refreshAction = {
    title: REFRESH_TITLE,
    shell: `bash ${join(REPO_ROOT, "build", "status-probe.sh")} ${join(olivetinDir, "entities")} ${join(olivetinDir, "custom-webui", "themes", THEME_NAME)}`,
    icon: "🔄",
    popupOnStart: POPUP.output,
    timeout: 30,
    hidden: true,
    execOnStartup: true,
    execOnCron: "* * * * *",
  };
  const header =
    `# ============================================================================\n` +
    `# OliveTin config — GENERATED by olivetin/src/generate-olivetin-config.mjs\n` +
    `# Do not edit by hand; edit src/apps.mjs and regenerate.\n` +
    `# One tab per MCP application + a Chrome MCP tab + running/stopped colors.\n` +
    `# ============================================================================\n\n` +
    `listenAddressSingleHTTPFrontend: ${listen}\n` +
    // WARN keeps the app window quiet — INFO logs every entity reload and the
    // per-minute status action.
    `logLevel: "WARN"\n` +
    `themeName: ${THEME_NAME}\n` +
    `themeCacheDisabled: true\n\n`;
  return header + emitActions(allActions, refreshAction) + emitEntities(olivetinDir) + emitDashboards(allDashboards);
}

// ---------------------------------------------------------------------------
// Generated companion assets (probe script + theme + entity seeds)
// ---------------------------------------------------------------------------
function buildProbeScript(olivetinDir) {
  const lines = [
    "#!/usr/bin/env bash",
    "# status-probe.sh — GENERATED by generate-olivetin-config.mjs",
    "# Writes one entity JSON file per app: {\"state\":\"running|stopped\",\"label\":...}",
    "#",
    "# Detection (best-effort, macOS):",
    "#  * Apps WITH a port are RUNNING only when that port is LISTENING. This is",
    "#    deliberate: the MCP Proxy (server.mjs) boots several of these servers as",
    "#    stdio CHILD processes, which share the app's cwd but DON'T bind the port.",
    "#    cwd-detection would then show a 'shut down' server as green just because",
    "#    the proxy has it loaded. The standalone server is the one on the port.",
    "#  * Portless apps (stdio-only, e.g. Sedona) fall back to cwd detection — note",
    "#    that while the proxy is up it keeps such a child alive, so it reads RUNNING.",
    "",
    "# OliveTin's action PATH omits Homebrew; add it so node (entity merge) resolves.",
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"',
    "",
    `ENT_DIR="\${1:-${join(olivetinDir, "entities")}}"`,
    `THEME_DIR="\${2:-${join(olivetinDir, "custom-webui", "themes", THEME_NAME)}}"`,
    'mkdir -p "$ENT_DIR"',
    "",
    "# Accumulates the sidebar status-dot CSS (one colored dot per nav row).",
    'DOTS="/* status-dots.css — GENERATED each probe; colors the left-menu dots. */"',
    "# Accumulates live status as JSON for dots.js (polled by the browser so the",
    "# sidebar dots update without a refresh and are never served stale).",
    'STATUS_JSON=""',
    'GREEN="#1db954"; RED="#e0245e"',
    "",
    "# The MCP Proxy (server.mjs) boots portless servers (e.g. Sedona) as stdio",
    "# CHILD processes that share the app's cwd. To distinguish YOUR standalone",
    "# instance from a proxy-managed child, we collect the proxy pid + its direct",
    "# children and exclude them from cwd detection.",
    `PROXY_PID="$(lsof -i :${apps.find((a) => a.id === "mcp-proxy")?.port || 9191} -sTCP:LISTEN -t 2>/dev/null | head -1)"`,
    'PROXY_MANAGED=" "',
    'if [ -n "$PROXY_PID" ]; then',
    '  PROXY_MANAGED=" $PROXY_PID $(ps -o pid=,ppid= 2>/dev/null | awk -v pp="$PROXY_PID" \'$2==pp{print $1}\' | tr "\\n" " ") "',
    "fi",
    "",
    "cwd_running() { # appDir — true if a NON-proxy-managed node/bash/tsx proc lives here",
    '  local dir="$1" pid="" path',
    "  while IFS= read -r line; do",
    '    case "$line" in',
    '      p*) pid="${line#p}" ;;',
    '      n*) path="${line#n}"',
    '          if [ "${path#"$dir"}" != "$path" ] && [ "${PROXY_MANAGED#* $pid }" = "$PROXY_MANAGED" ]; then return 0; fi ;;',
    "    esac",
    '  done < <(lsof -a -c node -c bash -c npm -c tsx -d cwd -Fpn 2>/dev/null)',
    "  return 1",
    "}",
    "",
    "add_dot() { # navIndex color",
    '  DOTS="$DOTS',
    'nav.mainnav ul.navigation-links li:nth-child($1) > a::after { content: \\"\\\\25CF\\"; position: absolute; right: .7em; top: 50%; transform: translateY(-50%); font-size: .8em; color: $2; }"',
    "}",
    "",
    "emit() { # entityName appDir navIndex [port]",
    '  local name="$1" dir="$2" idx="$3" port="${4:-}" state label color new old f',
    "  # Port given -> running iff the port is listening (standalone server only,",
    "  # not the proxy's stdio child). No port -> fall back to cwd detection.",
    '  if { [ -n "$port" ] && lsof -i ":$port" -sTCP:LISTEN -t >/dev/null 2>&1; } || { [ -z "$port" ] && cwd_running "$dir"; }; then',
    '    state=running; label=RUNNING; color="$GREEN"',
    '  else',
    '    state=stopped; label=STOPPED; color="$RED"',
    '  fi',
    '  f="$ENT_DIR/$name.json"',
    '  new=$(printf \'{"state":"%s","label":"%s"}\' "$state" "$label")',
    '  old=$(cat "$f" 2>/dev/null)',
    "  # Only rewrite when the status actually changed — otherwise OliveTin",
    "  # reloads the entity file and re-renders the dashboard every minute.",
    '  if [ "$new" != "$old" ]; then printf \'%s\\n\' "$new" > "$f"; fi',
    '  add_dot "$idx" "$color"',
    '  STATUS_JSON="$STATUS_JSON{\\"idx\\":$idx,\\"state\\":\\"$state\\"},"',
    "}",
    "",
  ];
  // nav order: Home is li:nth-child(1), then apps, then Chrome.
  apps.forEach((app, i) => {
    lines.push(`emit ${entityName(app.id)} "${app.dir}" ${i + 2} "${app.port || ""}"`);
  });
  // Chrome MCP: running = a debug Chrome exposing CDP on :9222.
  lines.push("");
  lines.push("# Chrome MCP — running if CDP is reachable on :9222.");
  lines.push('if curl -s --max-time 1 -o /dev/null http://localhost:9222/json/version; then cs=running; cl=RUNNING; ccolor="$GREEN"; else cs=stopped; cl=STOPPED; ccolor="$RED"; fi');
  lines.push(`cf="$ENT_DIR/${entityName("chrome-mcp")}.json"`);
  lines.push('cnew=$(printf \'{"state":"%s","label":"%s"}\' "$cs" "$cl")');
  lines.push('if [ "$cnew" != "$(cat "$cf" 2>/dev/null)" ]; then printf \'%s\\n\' "$cnew" > "$cf"; fi');
  lines.push(`add_dot ${apps.length + 2} "$ccolor"`);
  lines.push(`STATUS_JSON="$STATUS_JSON{\\"idx\\":${apps.length + 2},\\"state\\":\\"$cs\\"}"`);
  lines.push("");
  // Docker Management — dot = SSH reachability (host up, NOT "Docker running").
  // Green only when EVERY configured host answers on :22; label shows "up/total".
  const dockerProbeHosts = [...(dockerHosts.windows || []), ...(dockerHosts.mac || [])];
  lines.push("# Docker Management — per-host SSH :22 reachability. Each host writes its");
  lines.push("# own entity (the table-row colour); the aggregate drives the sidebar dot.");
  lines.push(`dtot=${dockerProbeHosts.length}; dup=0`);
  for (const h of dockerProbeHosts) {
    const ent = dockerHostEntity(h);
    lines.push(`if nc -z -w 2 '${h.host}' 22 >/dev/null 2>&1; then hs=running; hl=UP; dup=$((dup+1)); else hs=stopped; hl=DOWN; fi`);
    // Merge state/label, keep version/images (set by the Refresh details button).
    lines.push(`node -e '${ENTITY_MERGE_JS}' "$ENT_DIR/${ent}.json" state "$hs" label "$hl"`);
  }
  lines.push('if [ "$dtot" -gt 0 ] && [ "$dup" -eq "$dtot" ]; then ds=running; dcolor="$GREEN"; else ds=stopped; dcolor="$RED"; fi');
  lines.push(`dfile="$ENT_DIR/${entityName("docker")}.json"`);
  lines.push('dnew=$(printf \'{"state":"%s","label":"%s hosts up"}\' "$ds" "$dup/$dtot")');
  lines.push('if [ "$dnew" != "$(cat "$dfile" 2>/dev/null)" ]; then printf \'%s\\n\' "$dnew" > "$dfile"; fi');
  lines.push(`add_dot ${apps.length + 3} "$dcolor"`);
  lines.push(`STATUS_JSON="$STATUS_JSON,{\\"idx\\":${apps.length + 3},\\"state\\":\\"$ds\\"}"`);
  lines.push("");
  lines.push("# Write the sidebar dot CSS (only when it changed, to avoid churn).");
  lines.push('df="$THEME_DIR/status-dots.css"');
  lines.push('if [ "$DOTS" != "$(cat "$df" 2>/dev/null)" ]; then printf \'%s\\n\' "$DOTS" > "$df"; fi');
  lines.push("");
  lines.push("# Write the live status JSON that dots.js polls (cache-busted by the");
  lines.push("# browser). This is what makes the dots auto-update and stay correct.");
  lines.push('sf="$THEME_DIR/status.json"');
  lines.push('snew="[$STATUS_JSON]"');
  lines.push('if [ "$snew" != "$(cat "$sf" 2>/dev/null)" ]; then printf \'%s\\n\' "$snew" > "$sf"; fi');
  lines.push("");
  return lines.join("\n");
}

// docker-refresh.sh — GENERATED. Run by the "Refresh details" button. SSHes each
// host for `docker version` + the images of currently-running containers and
// merges them into that host's entity JSON (preserving state/label). Passwords
// are baked in (stored-password mode); keep this repo private.
function buildDockerRefreshScript(olivetinDir) {
  const entDir = join(olivetinDir, "entities");
  const allHosts = [
    ...(dockerHosts.windows || []).map((h) => ["windows", h]),
    ...(dockerHosts.mac || []).map((h) => ["mac", h]),
  ];
  const lines = [
    "#!/usr/bin/env bash",
    "# docker-refresh.sh — GENERATED by generate-olivetin-config.mjs. Do not edit.",
    "# Reuses docker-ctl.sh's `info` action (which handles stage-1 SSH + stage-2",
    "# Windows elevation in one place) and merges the result into each entity.",
    "set -u",
    '# OliveTin\'s action PATH omits Homebrew; add it so sshpass/node resolve.',
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"',
    `ENT_DIR=${sq(entDir)}`,
    `CTL=${sq(DOCKER_CTL)}`,
    "",
    "gather() { # os user host entityName winUser   (SSHPASS / WINPASS exported)",
    '  local os="$1" user="$2" host="$3" ef="$ENT_DIR/$4.json" winUser="$5" out ver imgs',
    '  out=$(bash "$CTL" "$os" info "$user" "$host" "" "" "$winUser" 2>/dev/null)',
    `  ver=$(printf '%s' "$out" | sed -n 's/^VERSION=//p' | head -1); [ -z "$ver" ] && ver="-"`,
    `  imgs=$(printf '%s' "$out" | sed -n 's/^IMAGES=//p' | head -1); [ -z "$imgs" ] && imgs="(none)"`,
    `  node -e '${ENTITY_MERGE_JS}' "$ef" version "$ver" images "$imgs"`,
    '  echo "  $host -> v$ver | $imgs"',
    "}",
    "",
    'echo "Refreshing Docker details (version + running images)…"',
  ];
  for (const [os, h] of allHosts) {
    const ent = dockerHostEntity(h);
    const pw = h.password ? `SSHPASS=${sq(h.password)} ` : "";
    const win = os === "windows" && h.winPassword ? `WINPASS=${sq(h.winPassword)} ` : "";
    lines.push(`${pw}${win}gather ${os} ${sq(h.user)} ${sq(h.host)} ${ent} ${sq(h.winUser || "")}`);
  }
  lines.push('echo "Done."');
  lines.push("");
  return lines.join("\n");
}

const THEME_CSS = `@import "/custom-webui/themes/${THEME_NAME}/status-dots.css";
/* mcpstatus theme — GENERATED. */

/* ===========================================================================
   iOS-style left sidebar. OliveTin renders <aside class="sidebar"> >
   <nav class="mainnav"> > <ul class="navigation-links"> as a 60px icon rail
   behind a hamburger. We pin it open at full width with labels, on every page.
   =========================================================================== */
aside.sidebar,
nav.mainnav {
  position: fixed !important;
  top: 0;
  left: 0;
  bottom: 0;
  width: 240px !important;
  min-width: 240px !important;
  box-sizing: border-box;
  margin: 0 !important;
  transform: none !important;
  visibility: visible !important;
  opacity: 1 !important;
  overflow-y: auto;
  background: #f2f2f7 !important;
  border-right: 1px solid #d1d1d6;
  z-index: 1000;
}
/* Clear OliveTin's ~49px top header so the first item (Home) isn't hidden. */
nav.mainnav { padding: 60px .6rem 1rem !important; }
nav.mainnav ul.navigation-links {
  display: flex;
  flex-direction: column;
  gap: .12rem;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}
nav.mainnav li { display: block; width: 100%; margin: 0; }
nav.mainnav a {
  display: flex;
  align-items: center;
  gap: .6rem;
  width: 100%;
  box-sizing: border-box;
  position: relative;          /* anchor for the right-aligned status dot */
  padding: .55rem 1.6rem .55rem .8rem; /* room on the right for the dot */
  border-radius: 12px;
  color: #1c1c1e;
  font-size: 1rem;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
nav.mainnav a svg { width: 20px; height: 20px; flex: 0 0 20px; }
nav.mainnav a:hover { background: rgba(120,120,128,.16); }
nav.mainnav a.active,
nav.mainnav a.selected,
nav.mainnav a[aria-current="page"] { background: #007aff; color: #fff; }
/* Hide the now-redundant hamburger and push content clear of the sidebar. */
#sidebar-toggler-button { display: none !important; }
body:has(nav.mainnav) main { margin-left: 240px !important; }
@media (max-width: 600px) {
  aside.sidebar, nav.mainnav { width: 60px !important; min-width: 60px !important; }
  nav.mainnav { padding: 1rem .3rem !important; }
  nav.mainnav a { justify-content: center; padding: .55rem; }
  body:has(nav.mainnav) main { margin-left: 60px !important; }
}

/* Home landing page — iPad-style icon grid. The display sits in one cell of
   OliveTin's fieldset grid, so span all columns and lay out squircle icons. */
div.display.home { grid-column: 1 / -1 !important; width: 100% !important; display: block !important; }
div.display.home > * { width: 100% !important; }
.project-home {
  display: grid;
  grid-template-columns: repeat(auto-fill, 120px);
  justify-content: center;
  gap: 1.6rem 1.2rem;
  width: 100%;
  padding: 1.5rem 0;
}
.project-home a.project-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: .55rem;
  width: 120px;
  border: none;
  background: none;
  text-decoration: none;
  color: inherit;
}
.project-home a.project-card .ic {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 84px;
  height: 84px;
  font-size: 2.7rem;
  background: #fff;
  border-radius: 22px;
  box-shadow: 0 3px 10px rgba(0,0,0,.18);
  transition: transform .12s;
}
.project-home a.project-card:hover .ic { transform: scale(1.06); }
.project-home a.project-card .nm { font-size: .85rem; font-weight: 500; text-align: center; line-height: 1.2; }

/* Per-app running/stopped Status display colors. */
div.display.status-running {
  color: #0a7d28;
  font-weight: 700;
}
div.display.status-running::before { content: "● "; }

div.display.status-stopped {
  color: #b00020;
  font-weight: 700;
}
div.display.status-stopped::before { content: "○ "; }

/* The hidden poller bootstrap (<img onerror>) — take it out of the layout. */
div.display.dots-injector { display: none !important; }

/* ===========================================================================
   Docker Management host table. Each host is a fieldset "row"; the .dh-status
   marker class (unique to these rows) scopes the layout via :has() — fieldsets
   carry no class of their own. Fixed-px inner columns so rows align like a
   table (a nested grid's tracks only line up across siblings at fixed widths).
   =========================================================================== */
.dashboard-row:has(.dh-status) {
  display: grid;
  grid-template-columns: 200px 1fr;
  align-items: center;
  gap: .6rem;
  margin: 0;
  padding: .2rem .5rem;
  border-bottom: 1px solid #d1d1d6;
}
.dashboard-row:has(.dh-status) > h2 { margin: 0; font-size: .9rem; font-weight: 600; }
.dashboard-row:has(.dh-status) > h2 > span { all: unset; }
.dashboard-row:has(.dh-status) > fieldset {
  display: grid;
  grid-template-columns: 74px 70px 240px 92px 92px 92px;
  align-items: center;
  gap: .4rem;
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  min-height: 0;
}
.dashboard-row:has(.dh-status) .display.dh-status {
  margin: 0;
  padding: 0;
  font-size: .82rem;
  font-weight: 700;
  white-space: nowrap;
}
/* Version + running-images cells (filled by the Refresh details button). */
.dashboard-row:has(.dh-status) .display.dh-ver {
  margin: 0; padding: 0; font-size: .8rem; font-variant-numeric: tabular-nums; white-space: nowrap;
}
.dashboard-row:has(.dh-status) .display.dh-img {
  margin: 0; padding: 0 .3rem 0 0; font-size: .76rem; color: #444;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dashboard-row:has(.dh-status) .action-button { margin: 0; }
/* Smaller, denser buttons inside the table than the big group cards. */
.dashboard-row:has(.dh-status) .action-button button {
  width: 100%;
  min-width: 0;
  padding: .35rem .4rem;
  font-size: .82rem;
}
.dashboard-row:has(.dh-status) .action-button button img,
.dashboard-row:has(.dh-status) .action-button button .icon { display: none; }
/* Header row — bold labels, no status colour/bullet. */
.dashboard-row:has(.dh-head) { border-bottom: 2px solid #b0b0b8; }
.display.dh-head { font-weight: 700; color: #555; font-size: .8rem; }
.display.dh-head.dh-status::before { content: none !important; }
`;

// dots.js — live-paints the sidebar running/stopped dots by polling status.json
// with a cache-buster. This replaces reliance on the @import'd status-dots.css
// (which the browser caches, so dots went stale until a hard refresh and never
// updated on their own). Loaded once per page by the INJECT_HTML bootstrap.
function buildDotsJs() {
  return `/* dots.js — GENERATED by generate-olivetin-config.mjs. Polls status.json and
   paints the left-menu status dots live (no refresh needed, never stale). */
(function () {
  var THEME = "/custom-webui/themes/${THEME_NAME}/";
  var GREEN = "#1db954", RED = "#e0245e";
  function paint(list) {
    var el = document.getElementById("mcp-dot-style");
    if (!el) { el = document.createElement("style"); el.id = "mcp-dot-style"; document.head.appendChild(el); }
    var css = "";
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      css += "nav.mainnav ul.navigation-links li:nth-child(" + o.idx + ") > a::after{" +
             "content:'\\\\25CF';position:absolute;right:.7em;top:50%;" +
             "transform:translateY(-50%);font-size:.8em;color:" +
             (o.state === "running" ? GREEN : RED) + ";}\\n";
    }
    el.textContent = css;
  }
  function tick() {
    fetch(THEME + "status.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(paint)
      .catch(function () {});
  }
  tick();
  setInterval(tick, 4000);
})();
`;
}

// Per-app emoji icons in the sidebar, painted on with CSS so the dashboard
// titles (and therefore the URLs) stay emoji-free. The nav lists dashboards in
// config order first (Home + apps + Chrome), then OliveTin's built-in links
// (Entities/Logs/…), so nth-child maps cleanly to our dashboards.
function buildSidebarIconCss() {
  let css = "\n/* Per-app emoji icons in the sidebar (URLs stay emoji-free). */\n";
  allDashboards.forEach((d, i) => {
    const n = i + 1;
    const sel = `nav.mainnav ul.navigation-links li:nth-child(${n}) > a`;
    css += `${sel} svg { display: none; }\n`;
    css += `${sel}::before { content: "${d.icon}"; font-size: 1.15rem; width: 22px; flex: 0 0 22px; text-align: center; }\n`;
  });
  return css;
}

// Warp launch configuration — opens a tab in the app's dir tailing its log.
function buildWarpConfig(c) {
  return (
    `---\n` +
    `name: ${c.name}\n` +
    `windows:\n` +
    `  - tabs:\n` +
    `      - title: ${JSON.stringify(c.title)}\n` +
    `        layout:\n` +
    `          cwd: ${JSON.stringify(c.dir)}\n` +
    `          commands:\n` +
    `            - exec: tail -n 200 -F ${c.log}\n`
  );
}

function installAssets(olivetinDir) {
  // Warp launch configs -> ~/.warp/launch_configurations/<name>.yaml
  const warpDir = join(process.env.HOME, ".warp", "launch_configurations");
  mkdirSync(warpDir, { recursive: true });
  for (const c of warpConfigs) {
    writeFileSync(join(warpDir, `${c.name}.yaml`), buildWarpConfig(c));
  }

  // 1. Probe script -> build/
  const buildDir = join(REPO_ROOT, "build");
  mkdirSync(buildDir, { recursive: true });
  const probePath = join(buildDir, "status-probe.sh");
  writeFileSync(probePath, buildProbeScript(olivetinDir));
  chmodSync(probePath, 0o755);
  // Docker "Refresh details" gather script (version + running images).
  const dockerDir = join(buildDir, "docker");
  mkdirSync(dockerDir, { recursive: true });
  const refreshPath = join(dockerDir, "docker-refresh.sh");
  writeFileSync(refreshPath, buildDockerRefreshScript(olivetinDir));
  chmodSync(refreshPath, 0o755);

  // 2. Theme css -> custom-webui/themes/<THEME_NAME>/theme.css
  const themeDir = join(olivetinDir, "custom-webui", "themes", THEME_NAME);
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(join(themeDir, "theme.css"), THEME_CSS + buildSidebarIconCss());
  // Seed status-dots.css so the theme's @import resolves before the first probe.
  const dotsPath = join(themeDir, "status-dots.css");
  if (!existsSync(dotsPath)) writeFileSync(dotsPath, "/* status-dots.css — populated by the status probe. */\n");
  // Live dot poller + seed the JSON it reads (probe overwrites it immediately).
  writeFileSync(join(themeDir, "dots.js"), buildDotsJs());
  const statusPath = join(themeDir, "status.json");
  if (!existsSync(statusPath)) writeFileSync(statusPath, "[]\n");

  // 3. Entities dir + seed one probe run so files exist before OliveTin reads them.
  const entDir = join(olivetinDir, "entities");
  mkdirSync(entDir, { recursive: true });
  try {
    execFileSync("bash", [probePath, entDir, themeDir], { stdio: "inherit" });
  } catch {
    // Probe is best-effort; seed empty stopped files if it failed.
    for (const app of apps) {
      const f = join(entDir, `${entityName(app.id)}.json`);
      if (!existsSync(f)) writeFileSync(f, '{"state":"stopped","label":"STOPPED"}\n');
    }
  }
  return { probePath, themeDir, entDir };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const getFlag = (n) => argv.includes(n);
const getOpt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const olivetinDir = getOpt("--dir") || DEFAULT_OLIVETIN_DIR;
const yaml = buildConfig(olivetinDir);

if (getFlag("--install")) {
  const assets = installAssets(olivetinDir);
  const dest = join(olivetinDir, "config.yaml");
  if (existsSync(dest)) {
    copyFileSync(dest, `${dest}.bak`);
    console.error(`Backed up existing config → ${dest}.bak`);
  }
  writeFileSync(dest, yaml);
  console.error(`Installed config → ${dest}`);
  console.error(`Probe   → ${assets.probePath}`);
  console.error(`Theme   → ${assets.themeDir}/theme.css`);
  console.error(`Entities→ ${assets.entDir}`);
  console.error(`Tabs: ${allDashboards.map((d) => d.tab.trim()).join(", ")}`);
  console.error("Restart OliveTin to load the new tabs.");
} else if (getOpt("--out")) {
  writeFileSync(getOpt("--out"), yaml);
  console.error(`Wrote ${getOpt("--out")}`);
} else {
  process.stdout.write(yaml);
}
