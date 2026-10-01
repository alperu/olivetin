#!/usr/bin/env bash
# jevbridge-ctl.sh — OliveTin control for the Jevbridge MCP server.
#
# Jevbridge is a STDIO MCP server: there is no daemon and no port. Claude Code
# spawns one `node .../Jevbridge/src/cli.ts mcp` per session and it exits with
# the session. So "on/off" here means "registered with Claude Code or not":
#
#   start   register it (user scope) -> available in every NEW Claude session
#   stop    unregister it AND kill any copies live sessions are running
#   status  registered? + how many sessions have it loaded right now
#   check   silent; exit 0 iff registered (used by status-probe.sh for the dot)
#   test    run the repo's own offline test suite
#   update  git pull --ff-only
#
# The TypeSafe key is NOT written into ~/.claude.json: the registered command
# sources ~/.zshrc at spawn time, same pattern as the jev-browser entry.

# OliveTin runs actions with a bare PATH; `claude` lives in ~/.local/bin.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

NAME="jevbridge"
JEV_DIR="${JEV_DIR:-$HOME/Code/Jevbridge}"
CLAUDE_CFG="$HOME/.claude.json"

registered() {
  [ -f "$CLAUDE_CFG" ] && node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(c.mcpServers && c.mcpServers[process.argv[2]] ? 0 : 1);
  ' "$CLAUDE_CFG" "$NAME" 2>/dev/null
}

# PIDs of live Jevbridge MCP node processes (not the zsh wrapper around them).
live_pids() {
  pgrep -f "node --experimental-strip-types $JEV_DIR/src/cli.ts mcp" 2>/dev/null
}

case "${1:-status}" in
  start)
    [ -f "$JEV_DIR/src/cli.ts" ] || { echo "Jevbridge not found at $JEV_DIR"; exit 1; }
    if registered; then
      echo "Already registered with Claude Code (user scope)."
    else
      claude mcp add "$NAME" -s user -- zsh -lc \
        "source ~/.zshrc; exec node --experimental-strip-types $JEV_DIR/src/cli.ts mcp" \
        || exit 1
      echo "Registered. Open a NEW Claude Code session to get jev_decide / jev_gate / jev_computer_use / jev_recipe."
    fi
    ;;
  stop)
    if registered; then
      claude mcp remove "$NAME" -s user || exit 1
      echo "Unregistered from Claude Code."
    else
      echo "Not registered."
    fi
    pids=$(live_pids)
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null
      echo "Stopped $(echo $pids | wc -w | tr -d ' ') running copy(ies): $(echo $pids)"
    else
      echo "No running copies."
    fi
    ;;
  restart)
    "$0" stop && "$0" start
    ;;
  status)
    if registered; then echo "Registered:  yes (user scope)"; else echo "Registered:  no"; fi
    pids=$(live_pids)
    echo "Running:     $(echo $pids | wc -w | tr -d ' ') session copy(ies) ${pids:+($(echo $pids))}"
    if [ -d "$JEV_DIR/.git" ]; then
      echo "Version:     $(git -C "$JEV_DIR" log -1 --format='%h %s (%cr)')"
    fi
    if zsh -lc 'source ~/.zshrc >/dev/null 2>&1; [ -n "$TYPESAFE_API_KEY" ]'; then
      echo "Backend:     native Jev (TYPESAFE_API_KEY set in ~/.zshrc)"
    else
      echo "Backend:     no TYPESAFE_API_KEY -> LLM or heuristic fallback"
    fi
    ;;
  check)
    registered
    ;;
  test)
    cd "$JEV_DIR" && npm test
    ;;
  update)
    git -C "$JEV_DIR" pull --ff-only
    ;;
  *)
    echo "usage: $0 start|stop|restart|status|check|test|update"; exit 2
    ;;
esac
