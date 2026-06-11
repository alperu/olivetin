# How to Create Pages (Tabs) in OliveTin

This is a practical reference for building the OliveTin UI on this machine. It
explains how OliveTin turns YAML into clickable buttons, how to group those
buttons into **tabs**, and how to add **dividers / section headers** between
them.

> Installed version on this machine: **OliveTin 3000.14.0**.
> Config lives at **`/Users/alper/.local/opt/olivetin/config.yaml`** (see
> [`olivetin.md`](./olivetin.md)). After editing, restart OliveTin to reload.

Sources: [Dashboards](https://docs.olivetin.app/dashboards/intro.html),
[Fieldsets](https://docs.olivetin.app/dashboards/2-fieldsets.html),
[Displays](https://docs.olivetin.app/dashboards/4-displays.html),
[Inline actions](https://docs.olivetin.app/dashboards/inline-actions.html),
[Create your first action](https://docs.olivetin.app/action_execution/create_your_first.html).

---

## 1. The mental model

OliveTin has two layers:

1. **`actions:`** — the actual commands. Each action is a button that runs a
   `shell` command. Without any dashboards, every action shows up on a single
   default "Actions" page.
2. **`dashboards:`** — the *layout*. Each top-level entry under `dashboards:`
   becomes **its own tab** across the top of the WebUI. A dashboard pulls
   actions out of the default view (by matching `title`) and arranges them into
   groups.

Two rules that bite people:

- **Every action title must be globally unique.** Dashboards reference actions
  by their `title`, so two actions can't share one.
- **An action can only appear on one dashboard.** Dashboards *move* the action
  off the default page; they don't copy it.

---

## 2. A single action (a button)

```yaml
actions:
  - title: "Restart Dev Server"      # also the button label; must be unique
    shell: "npm run dev:restart"     # the command that runs
    icon: "restart"                  # optional, a Font Awesome-ish name
    timeout: 60                      # optional, seconds before it's killed
    popupOnStart: execution-dialog   # optional, see below
```

`popupOnStart` controls what the user sees when they click:

| value | behaviour |
| --- | --- |
| *(omitted)* | button just flashes green/red |
| `execution-button` | shows a small "view logs" button |
| `execution-dialog` | opens a dialog with command + status |
| `execution-dialog-stdout-only` | opens a dialog showing only the output |

### Asking the user for input

Add `arguments` and reference them as `{{ name }}` in the `shell`:

```yaml
actions:
  - title: "Ping Host"
    shell: "ping -c {{ count }} {{ host }}"
    arguments:
      - name: host
        title: "Target Host"
        type: ascii_identifier
        default: "example.com"
      - name: count
        title: "Ping Count"
        type: int
        default: 3
```

---

## 3. Dashboards = tabs

Each top-level item under `dashboards:` is a tab. Inside a dashboard, every item
must live in a **fieldset** (a titled group, no folder needed). If you don't
specify one, items fall into a fieldset called `default`.

```yaml
actions:
  - title: "proxy: Start"
    shell: "cd ~/Code/mcp-proxy && bash scripts/start.sh"
  - title: "proxy: Stop"
    shell: "cd ~/Code/mcp-proxy && bash scripts/stop.sh"

dashboards:
  # ── This whole block is ONE tab named "mcp-proxy" ──
  - title: mcp-proxy
    contents:
      - title: Lifecycle          # a fieldset = a visible group box
        type: fieldset
        contents:
          - title: "proxy: Start" # pulls the action defined above, by title
          - title: "proxy: Stop"
```

### Folders (nested groups)

If a fieldset item itself has `contents:`, it renders as a clickable **folder**
the user drills into:

```yaml
      - title: Maintenance
        type: fieldset
        contents:
          - title: Danger Zone
            type: directory      # a folder you click into
            contents:
              - title: "proxy: Wipe cache"
```

---

## 4. Dividers & section headers

OliveTin has no literal `<hr>` element, but a **`type: display`** item gives you
a labelled separator / header inside a fieldset. It renders arbitrary HTML, so
it doubles as a divider between groups of buttons:

```yaml
dashboards:
  - title: court-lens
    contents:
      - title: Service
        type: fieldset
        contents:
          - type: display
            title: "<strong>━━ Lifecycle ━━</strong>"   # acts as a divider
          - title: "court-lens: Start"
          - title: "court-lens: Stop"
          - type: display
            cssClass: "section"
            title: "<strong>━━ Health ━━</strong>"
          - title: "court-lens: Health check"
```

You can attach a `cssClass:` and style it via the custom WebUI CSS
(`~/.local/opt/olivetin/custom-webui/`), e.g. colour-coding a running/stopped
state.

The simplest "give me a divider so I can see each app better" pattern is: one
**tab per app** (clean separation), and within a tab, `type: display` headers
between the lifecycle / status / logs groups.

---

## 5. Inline actions (3000.7.0+)

Since you're on 3000.14.0, you can also define an action *directly* inside a
dashboard instead of in the top-level `actions:` block:

```yaml
dashboards:
  - title: Quick
    contents:
      - inlineAction:
          title: Date
          shell: date
          icon: date
```

This project's generator uses the **classic split** (actions in `actions:`,
referenced by title in `dashboards:`) because it's the most portable and keeps
all commands in one searchable place.

---

## 6. Applying changes

```bash
# Regenerate + install the config from this repo, then restart OliveTin:
node /Users/alper/Code/olivetin/src/generate-olivetin-config.mjs --install
# (restart OliveTin to load it)
```

See [`src/`](../src/) for the generator that produces a tab per app
automatically.

---

## 7. Caveats & gotchas (learned the hard way)

These are real behaviours of OliveTin 3000.14.0 on this setup that cost time —
the generator already works around them, but know them before hand-editing.

> **Emoji in a dashboard title 404s the URL.**
> A dashboard route is `/dashboards/<title>`. If the title contains an emoji
> (e.g. `🌲  Sedona`), a full page load of
> `/dashboards/%F0%9F%8C%B2%20%20Sedona` returns **404 page not found** from
> OliveTin's server. Keep titles **clean** (no emoji) and paint per-app icons
> back on with CSS / on the Home cards. Clean paths like
> `/dashboards/Axon MCP Server` serve the SPA (200).

> **A dot in a title also 404s on full load.**
> `SoundSuite.ai` → `/dashboards/SoundSuite.ai` 404s because the server treats
> `.ai` as a file extension. Clicking still works (client-side nav, below), but
> a hard reload / bookmark of that exact URL 404s. Avoid `.` in titles if you
> need reloadable deep links.

> **`timeout: 0` is NOT "no timeout" — it's the 3-second default.**
> An action with `timeout: 0` (or none) is **SIGKILLed after 3s** — you'll see
> `signal: killed` and `… timed out after 3 seconds`. Anything long-running or
> foreground (a server, the `exec chrome` launcher) must be **detached**
> (`(nohup … &) ; echo launched`) so the action returns instantly, and/or given
> an explicit large `timeout:`. The generator detaches every `Start`/`Run`
> action and sets `timeout: 600` on the rest.

> **Deep links need client-side navigation.**
> OliveTin's nav and the Home cards switch dashboards via the History API. A
> raw `<a href>` that triggers a full load is at the mercy of the 404 rules
> above. The Home cards use an inline `onclick` doing
> `window.history.pushState(...)` + `window.dispatchEvent(new PopStateEvent('popstate'))`.

> **In an inline `onclick`, qualify globals with `window.`**
> Bare `dispatchEvent(...)` in an inline handler binds to **`document`**, but
> OliveTin's router listens for `popstate` on **`window`** — so the event never
> arrives and nothing navigates. Use `window.dispatchEvent(...)` /
> `window.history.pushState(...)`.

> **Sidebar DOM shape (for theming).**
> The nav is `aside.sidebar > nav.mainnav > ul.navigation-links > li > a`
> (each `<a>` has an inline SVG). Your **dashboards are listed first**, then
> OliveTin's built-ins (`Entities`, `Logs`, `Diagnostics`), so
> `li:nth-child(n)` maps cleanly to your dashboard order — that's how the
> generator paints per-app emoji into the sidebar without touching the URLs.

> **A fieldset is a CSS grid; a display occupies one cell.**
> On a dashboard, OliveTin renders the fieldset as `display: grid`, so a
> `type: display` lands in a single ~200px column. To make a full-width display
> (e.g. the Home icon grid) set `grid-column: 1 / -1; width: 100%`.

> **Status colours need entity files, and only rewrite on change.**
> Running/stopped colour uses an entity JSON per app + a `type: display` with
> `cssClass: status-{{ entity.state }}`. OliveTin reloads + re-renders the
> dashboard whenever the entity file's mtime changes, so the status probe must
> **only write when the value actually changes** — otherwise the dashboard
> flickers "Loading dashboard…" on every refresh.

> **Theme CSS caching.**
> Set `themeName:` to enable a theme and `themeCacheDisabled: true` so
> `theme.css` is re-read per request while iterating. Browsers still cache the
> file — hard-refresh (⌘⇧R) to see CSS changes.
