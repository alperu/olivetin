# OliveTin MCP Control Panel

A generator + launcher that turns [OliveTin](https://docs.olivetin.app) into a
one-click control panel for my local MCP servers. Each project gets its own
**tab**, every button is wired to that project's **real** start/stop/status
scripts, and tabs show a live **running/stopped color**. A native macOS app
(built with Platypus) starts and stops the whole thing from the Dock.

![tabs](docs/olivetin.md) <!-- see docs/ for details -->

---

## What you get

- **A Home landing page** (loads first) with a clickable card per project.
- **One tab per app**: mcp-proxy · Fantom MCP Server · Axon MCP Server ·
  SoundSuite.ai · Sedona MCP Server · a **Chrome MCP** tab.
- **Buttons mapped to each repo's actual scripts** (start / stop / restart /
  status / logs / build), grouped under labelled dividers.
- **Running/stopped colors** per tab (● green / ○ red), refreshed on startup,
  every minute, and after every lifecycle button.
- **Sticky nav** so the tab bar stays put while scrolling.
- **A Dock app** (`OliveTin.app`) that runs OliveTin in the foreground, shows
  its live log, opens the WebUI, and **stops OliveTin when you quit it**. Opens
  automatically at login.

The WebUI runs at **http://localhost:1337**.

---

## Layout

```
olivetin/
├── src/
│   ├── apps.mjs                      # single source of truth: apps, tabs, buttons
│   └── generate-olivetin-config.mjs  # emits + installs the OliveTin config
├── build/
│   ├── build-app.sh                  # build OliveTin.app (icon + launcher) via Platypus
│   ├── install-to-dock.sh            # install to /Applications + pin to Dock
│   ├── olivetin-launch.sh            # the script the .app runs
│   └── (generated: OliveTin.app, OliveTin.icns, status-probe.sh, …)
└── docs/
    ├── olivetin.md                       # where OliveTin lives on this machine
    ├── howToCreatePagesOnOliveTin.md     # actions / tabs / fieldsets / dividers
    └── howToCreateAppWithPlatypus.md     # building the .app + Dock + login
```

OliveTin itself runs from `~/.local/opt/olivetin/` (config at
`~/.local/opt/olivetin/config.yaml`). See [`docs/olivetin.md`](docs/olivetin.md).

---

## Usage

### Add or change a tab / button

Edit [`src/apps.mjs`](src/apps.mjs), then regenerate + install:

```bash
node src/generate-olivetin-config.mjs --install
# restart OliveTin: quit & reopen OliveTin.app, or for a manual run:
#   launchctl … (not used) — just relaunch the Dock app
```

`--install` writes `config.yaml` (backing up the old one to `.bak`), generates
the status probe, writes the `mcpstatus` theme (colors + sticky nav + home
cards), seeds the entity files, and runs the probe once. Run with no flags to
print the config, or `--out FILE` to write it somewhere.

Each app's display **title** is independent of its **id** — renaming a tab only
changes `title`. Action titles are namespaced `"<app-id>: <label>"` and must be
globally unique (an OliveTin requirement).

### Build / reinstall the Dock app

```bash
bash build/build-app.sh         # rebuild OliveTin.app (icon + launcher)
bash build/install-to-dock.sh   # copy to /Applications + pin to the Dock
```

### How the running/stopped color works

OliveTin **entities** + a per-tab `type: display` whose `cssClass` is
`status-{{ entity.state }}`, colored by `custom-webui/themes/mcpstatus/theme.css`.
`build/status-probe.sh` marks an app *running* when a `node`/`bash` process has
its working directory inside that app's folder. A hidden `status: Refresh`
action runs it on startup, every minute, and via `triggers` on each button.

---

## The macOS app

`OliveTin.app` (Platypus *Text Window* interface):

| Action | Result |
| --- | --- |
| Open (Dock / login) | starts OliveTin, opens the WebUI, streams its log |
| Quit (Cmd-Q) | **stops** OliveTin |

Auto-start is via a **Login Item** (not a `KeepAlive` LaunchAgent, which would
fight "quit = shutdown"). Full details and the Platypus build recipe — including
the `ScriptExec.b64` gotcha — are in
[`docs/howToCreateAppWithPlatypus.md`](docs/howToCreateAppWithPlatypus.md).
