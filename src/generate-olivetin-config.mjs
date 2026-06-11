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
  return defs.map((a) => ({
    title: actionTitle(appId, a.label),
    shell: `cd ${dir} && ${a.cmd}`,
    icon: a.icon,
    popupOnStart: POPUP[a.popup] ?? POPUP.dialog,
    timeout: 0, // 0 = no timeout; servers are long-running / detached
    arguments: a.arguments,
    // Re-probe status immediately after a lifecycle action runs.
    triggers: withStatusTrigger ? [REFRESH_TITLE] : undefined,
  }));
}

function dashboardFor(appId, title, icon, defs, { entity } = {}) {
  const groups = [];
  const byGroup = new Map();
  for (const a of defs) {
    if (!byGroup.has(a.group)) { byGroup.set(a.group, []); groups.push(a.group); }
    byGroup.get(a.group).push(a);
  }
  return { tab: `${icon}  ${title}`, appId, groups, byGroup, entity };
}

const allActions = [];
const allDashboards = [];

for (const app of apps) {
  allActions.push(...actionsFor(app.id, app.dir, app.actions, { withStatusTrigger: true }));
  allDashboards.push(dashboardFor(app.id, app.title, app.icon, app.actions, { entity: entityName(app.id) }));
}
// Chrome MCP tab — no running-state indicator (it's a launcher, not a service).
allActions.push(...actionsFor("chrome-mcp", chromeMcp.dir, chromeMcp.actions));
allDashboards.push(dashboardFor("chrome-mcp", chromeMcp.title, chromeMcp.icon, chromeMcp.actions));

// Home landing page — FIRST dashboard so OliveTin opens here instead of the
// first project. One clickable card per project, linking to its dashboard.
// A project's dashboard route is /dashboards/<urlencoded tab title>.
function buildHomeDashboard(dashboards) {
  const cards = dashboards.map((d) => {
    const href = `/dashboards/${encodeURIComponent(d.tab)}`;
    const parts = d.tab.trim().split(/\s+/);
    const icon = parts[0];
    const name = parts.slice(1).join(" ");
    return `<a class='project-card' href='${href}'><span class='ic'>${icon}</span><span class='nm'>${name}</span></a>`;
  }).join("");
  const html = `<div class='project-home'>${cards}</div>`;
  return { tab: "🏠  Home", home: true, html };
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
  const { listen, logLevel } = readServerSettings(olivetinDir);
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
    `logLevel: "${logLevel}"\n` +
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
    '  local name="$1" dir="$2" state label',
    '  if cwd_running "$dir"; then state=running; label=RUNNING; else state=stopped; label=STOPPED; fi',
    '  printf \'{"state":"%s","label":"%s"}\\n\' "$state" "$label" > "$ENT_DIR/$name.json"',
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

/* Pin the navigation menu to the top so the tabs stay visible while scrolling. */
nav {
  position: sticky;
  top: 0;
  z-index: 1000;
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
  writeFileSync(join(themeDir, "theme.css"), THEME_CSS);

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
