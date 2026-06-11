# How to Build a Clickable macOS App (with Icon) using Platypus

This documents how `build/OliveTin.app` is produced — a double-clickable macOS
app that launches OliveTin and opens the WebUI — and how to make it start
automatically on login/restart.

> Tooling on this machine: **Platypus 5.5.0** at
> `/Applications/Platypus.app`. macOS provides `sips` + `iconutil` for icons.

The whole thing is automated by **[`../build/build-app.sh`](../build/build-app.sh)**;
this doc explains each step so you can reuse the recipe for any script.

---

## 1. What Platypus does

Platypus wraps a **script** in a native `.app` bundle so it can be launched
from Finder/Dock. You give it a script + an interface type and it emits the
bundle. Here we use interface type **`None`** (run the script, show no window)
because our script just starts a server and opens a browser.

The launcher script we wrap is **[`../build/olivetin-launch.sh`](../build/olivetin-launch.sh)**:
it starts OliveTin only if it isn't already listening on `:1337` (detached via
`nohup … & disown` so it survives the app quitting), waits for the port, then
`open`s the WebUI.

---

## 2. The CLI (and the two gotchas)

The command-line tool is **not** on `PATH` by default — it lives at:

```
/Applications/Platypus.app/Contents/Resources/platypus_clt
```

Two things bite you if you haven't run Platypus's "Install Command Line Tool":

1. **`ScriptExec` binary missing.** The CLI normally reads the runtime stub
   from `/usr/local/share/platypus/ScriptExec`. If that dir doesn't exist you
   get `Executable binary not found`. The binary ships **base64-encoded** inside
   the app at `Contents/Resources/ScriptExec.b64` — decode it and pass it with
   `-e` (no sudo needed):

   ```bash
   RES="/Applications/Platypus.app/Contents/Resources"
   base64 -d -i "$RES/ScriptExec.b64" > ScriptExec && chmod +x ScriptExec
   ```

2. **Nib file.** Pass the bundled menu nib with `-E "$RES/MainMenu.nib"`.

---

## 3. Make the icon (.icns)

`.app` icons must be `.icns`. Build one from any PNG with `sips` + `iconutil`:

```bash
LOGO="$HOME/.local/opt/olivetin/webui/assets/OliveTinLogo-180px-DBoTqUbn.png"
rm -rf OliveTin.iconset && mkdir OliveTin.iconset
for s in 16 32 128 256 512; do
  sips -z "$s" "$s"         "$LOGO" --out "OliveTin.iconset/icon_${s}x${s}.png"
  sips -z $((s*2)) $((s*2)) "$LOGO" --out "OliveTin.iconset/icon_${s}x${s}@2x.png"
done
iconutil -c icns OliveTin.iconset -o OliveTin.icns
```

> The OliveTin logo source is only 180×180, so larger slots are upscaled —
> fine for a Dock icon. Swap in a bigger source for crisper results.

---

## 4. Build the app

```bash
RES="/Applications/Platypus.app/Contents/Resources"
"$RES/platypus_clt" \
  -y \                                  # overwrite if it exists
  -a "OliveTin" \                       # app name
  -o "None" \                           # interface type: run, no window
  -p "/bin/bash" \                      # interpreter
  -i "OliveTin.icns" \                  # app icon
  -V "1.0" -u "alper" \                 # version + author
  -I "app.olivetin.launcher" \          # bundle identifier
  -R \                                  # quit after the script finishes
  -e "$PWD/ScriptExec" \                # decoded runtime stub (gotcha #1)
  -E "$RES/MainMenu.nib" \              # nib (gotcha #2)
  "olivetin-launch.sh" "OliveTin.app"
```

Useful flags: `-B` background/agent (LSUIElement, no Dock icon),
`-D` accept dropped files, `-f file|file` bundle extra files,
`-A` run as admin. See `man platypus`.

### Ad-hoc sign it

A locally-built app is unsigned; ad-hoc signing avoids Gatekeeper nags:

```bash
codesign --force --deep -s - OliveTin.app
```

Then `open build/OliveTin.app` (or double-click it in Finder). Drag it to
`/Applications` and/or the Dock if you want it handy.

---

## 5. Start automatically on login / restart

Two complementary options — this repo uses **(A)**, the most reliable:

### A. LaunchAgent (recommended) — runs OliveTin headless at login

`~/Library/LaunchAgents/app.olivetin.plist` (already installed) runs the
OliveTin binary itself with `RunAtLoad` + `KeepAlive`, so it comes up on every
login/restart and is restarted if it crashes. Manage it with:

```bash
UID=$(id -u)
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/app.olivetin.plist  # enable
launchctl kickstart -k gui/$UID/app.olivetin                            # restart
launchctl bootout    gui/$UID/app.olivetin                              # disable
```

With the server already auto-running, the `.app` just opens the WebUI (its
launcher detects the running server and skips starting a second copy).

### B. Login Item — auto-launch the .app instead

If you'd rather the **app** open on login (e.g. to also pop the browser):

```bash
osascript -e 'tell application "System Events" to make login item \
  at end with properties {path:"/Users/alper/Code/olivetin/build/OliveTin.app", hidden:false}'
```

Or: System Settings → General → Login Items → **+**.

> Don't enable both A *and* B expecting two servers — the launcher is
> idempotent and won't start OliveTin twice on the same port.

---

## 6. Show it in the Dock

To install the app into `/Applications` and pin it to the Dock (so it appears
as a real, clickable app with the OliveTin icon):

```bash
bash build/install-to-dock.sh
```

This copies the bundle, re-signs it, refreshes Launch Services (so the icon
registers), and adds it to `com.apple.dock`'s `persistent-apps` followed by
`killall Dock`. Clicking the Dock icon runs the launcher, which opens the WebUI
(starting OliveTin first only if it isn't already running).

---

## 7. Rebuild anytime

```bash
bash build/build-app.sh        # rebuild OliveTin.app (icon + launcher)
bash build/install-to-dock.sh  # reinstall to /Applications + Dock
```
