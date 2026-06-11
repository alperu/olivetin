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

const DEFAULT_OLIVETIN_DIR = `${process.env.HOME}/.local/opt/olivetin`;
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const THEME_NAME = "mcpstatus";
const REFRESH_TITLE = "status: Refresh";
// Dashboard titles are kept CLEAN (no emoji/double-space): OliveTin's server
// 404s on emoji routes like /dashboards/%E2%9A%96%EF%B8%8F... but serves the
// SPA fine for clean paths. Per-app emoji live on the Home cards instead.
const HOME_TAB = "Home";

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
    const detach = /^(Start|Run)\b/.test(a.label);
    const shell = detach
      ? `cd ${dir} && (nohup ${a.cmd} >/tmp/olivetin-${appId}.log 2>&1 &) ; echo "Launched in background — log: /tmp/olivetin-${appId}.log"`
      : `cd ${dir} && ${a.cmd}`;
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

for (const app of apps) {
  // "Open in IntelliJ" added to every project so you can jump into the code.
  const defs = [
    ...app.actions,
    { group: "Develop", label: "Open in IntelliJ", icon: "🧠", cmd: 'open -a "IntelliJ IDEA" .', popup: "output" },
  ];
  allActions.push(...actionsFor(app.id, app.dir, defs, { withStatusTrigger: true }));
  allDashboards.push(dashboardFor(app.id, app.title, app.icon, defs, { entity: entityName(app.id) }));
}
// Chrome MCP tab — no running-state indicator (it's a launcher, not a service).
allActions.push(...actionsFor("chrome-mcp", chromeMcp.dir, chromeMcp.actions));
allDashboards.push(dashboardFor("chrome-mcp", chromeMcp.title, chromeMcp.icon, chromeMcp.actions));

// Home landing page — FIRST dashboard so OliveTin opens here instead of the
// first project. One clickable card per project, linking to its dashboard.
// A project's dashboard route is /dashboards/<urlencoded tab title>.
function buildHomeDashboard(dashboards) {
  // Client-side nav (pushState+popstate) for an instant switch; the clean href
  // is the fallback (a full load of a clean /dashboards/<name> path serves the
  // SPA, which then routes to the dashboard).
  const onclick = "event.preventDefault();history.pushState({},'',this.getAttribute('href'));dispatchEvent(new PopStateEvent('popstate'));";
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
  for (const app of apps) {
    const name = entityName(app.id);
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
    shell: `bash ${join(REPO_ROOT, "build", "status-probe.sh")} ${join(olivetinDir, "entities")}`,
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
    "# Detection (best-effort, macOS): an app is RUNNING if a node/bash/npm",
    "# process has its current working directory within the app's directory.",
    "# Note: mcpfantom and axon-mcp-server both default to port 3847 and so are",
    "# mutually exclusive; cwd-based detection keeps them distinguishable.",
    "",
    `ENT_DIR="\${1:-${join(olivetinDir, "entities")}}"`,
    'mkdir -p "$ENT_DIR"',
    "",
    "cwd_running() {",
    '  local dir="$1"',
    "  lsof -a -c node -c bash -c npm -c tsx -d cwd -Fn 2>/dev/null | grep -q \"^n${dir}\"",
    "}",
    "",
    "emit() { # entityName appDir",
    '  local name="$1" dir="$2" state label new old f',
    '  if cwd_running "$dir"; then state=running; label=RUNNING; else state=stopped; label=STOPPED; fi',
    '  f="$ENT_DIR/$name.json"',
    '  new=$(printf \'{"state":"%s","label":"%s"}\' "$state" "$label")',
    '  old=$(cat "$f" 2>/dev/null)',
    "  # Only rewrite when the status actually changed — otherwise OliveTin",
    "  # reloads the entity file and re-renders the dashboard every minute.",
    '  if [ "$new" != "$old" ]; then printf \'%s\\n\' "$new" > "$f"; fi',
    "}",
    "",
  ];
  for (const app of apps) {
    lines.push(`emit ${entityName(app.id)} "${app.dir}"`);
  }
  lines.push("");
  return lines.join("\n");
}

const THEME_CSS = `/* mcpstatus theme — GENERATED. */

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
  padding: .55rem .8rem;
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

/* Home landing page — grid of clickable project cards. */
div.display.home { width: 100%; }
.project-home {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: center;
  padding: 1rem 0;
}
.project-home a.project-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 170px;
  height: 130px;
  gap: .5rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: .7em;
  text-decoration: none;
  color: inherit;
  background: var(--bg, #f8f9fa);
  transition: transform .12s, box-shadow .12s;
}
.project-home a.project-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 4px 14px rgba(0,0,0,.15);
}
.project-home a.project-card .ic { font-size: 2.4rem; line-height: 1; }
.project-home a.project-card .nm { font-weight: 600; text-align: center; }

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
`;

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

function installAssets(olivetinDir) {
  // 1. Probe script -> build/
  const buildDir = join(REPO_ROOT, "build");
  mkdirSync(buildDir, { recursive: true });
  const probePath = join(buildDir, "status-probe.sh");
  writeFileSync(probePath, buildProbeScript(olivetinDir));
  chmodSync(probePath, 0o755);

  // 2. Theme css -> custom-webui/themes/<THEME_NAME>/theme.css
  const themeDir = join(olivetinDir, "custom-webui", "themes", THEME_NAME);
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(join(themeDir, "theme.css"), THEME_CSS + buildSidebarIconCss());

  // 3. Entities dir + seed one probe run so files exist before OliveTin reads them.
  const entDir = join(olivetinDir, "entities");
  mkdirSync(entDir, { recursive: true });
  try {
    execFileSync("bash", [probePath, entDir], { stdio: "inherit" });
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
