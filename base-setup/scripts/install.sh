#!/usr/bin/env bash
# Usage: install.sh [all|agent-browser|find-skills|codegraph|statusline]...   (default: all)
#
# Idempotent user-level setup. Safe to re-run; each step skips what is already done.
#   agent-browser  npm i -g agent-browser if missing, point ~/.agent-browser/config.json
#                  at system Chromium (CHROMIUM_PATH overrides detection) in headed mode, and install
#                  its skill to ~/.claude/skills via `npx skills`.
#   find-skills    npx skills add vercel-labs/skills --skill find-skills (global, claude-code).
#   codegraph      npm i -g @colbymchenry/codegraph if missing, then `codegraph install
#                  --target=claude --location=global --yes`: MCP server in ~/.claude.json,
#                  mcp__codegraph__* auto-allowed, a CodeGraph section in ~/.claude/CLAUDE.md.
#                  Telemetry is turned off first. Index a project with `codegraph init` in it.
#   statusline     copy statusline.py to ~/.claude/ and set statusLine in ~/.claude/settings.json.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

log() { printf '\033[36m[base-setup]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[base-setup] %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH. $2"; }

# Merge a JSON object (argv[2]) into the JSON file argv[1], creating it if absent.
# A non-empty existing file is backed up to <file>.bak first.
merge_json() {
  python3 -I - "$1" "$2" <<'PY'
import json, os, shutil, sys
path, patch = sys.argv[1], json.loads(sys.argv[2])
data = {}
if os.path.exists(path) and os.path.getsize(path):
    with open(path) as f:
        data = json.load(f)
    if all(data.get(k) == v for k, v in patch.items()):
        sys.exit(0)
    shutil.copy2(path, path + ".bak")
data.update(patch)
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
}

skills_add() {  # skills_add <repo> <skill>
  npx -y skills add "$1" --skill "$2" -g -a claude-code -y
}

find_chromium() {
  if [ -n "${CHROMIUM_PATH:-}" ]; then
    [ -x "$CHROMIUM_PATH" ] || die "CHROMIUM_PATH=$CHROMIUM_PATH is not executable"
    echo "$CHROMIUM_PATH"; return
  fi
  local c
  for c in chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return; fi
  done
  for c in /snap/bin/chromium /Applications/Chromium.app/Contents/MacOS/Chromium; do
    if [ -x "$c" ]; then echo "$c"; return; fi
  done
  die "Chromium not found. Install it (e.g. 'sudo apt install chromium' or 'brew install --cask chromium') or set CHROMIUM_PATH."
}

step_agent_browser() {
  need npm "Install Node.js first."
  if command -v agent-browser >/dev/null 2>&1; then
    log "agent-browser $(agent-browser --version 2>/dev/null | awk '{print $NF}') already installed"
  else
    log "installing agent-browser (npm -g)"
    npm install -g agent-browser
  fi
  local chromium; chromium="$(find_chromium)"
  # Headed by default; `--headed false` or AGENT_BROWSER_HEADED=false runs one call headless.
  merge_json "$HOME/.agent-browser/config.json" "{\"executablePath\": \"$chromium\", \"headed\": true}"
  log "agent-browser uses $chromium, headed by default (~/.agent-browser/config.json)"
  log "installing agent-browser skill"
  skills_add vercel-labs/agent-browser agent-browser
}

step_find_skills() {
  need npx "Install Node.js first."
  log "installing find-skills skill"
  skills_add vercel-labs/skills find-skills
}

step_codegraph() {
  need npm "Install Node.js first."
  if command -v codegraph >/dev/null 2>&1; then
    log "codegraph already installed"
  else
    log "installing codegraph (npm -g @colbymchenry/codegraph)"
    npm install -g @colbymchenry/codegraph
  fi
  # Opt out before anything else runs; persisted in ~/.codegraph/telemetry.json.
  CODEGRAPH_TELEMETRY=0 codegraph telemetry off >/dev/null
  log "codegraph telemetry off"
  log "wiring codegraph into Claude Code (user scope)"
  CODEGRAPH_TELEMETRY=0 codegraph install --target=claude --location=global --yes
  log "index a project with: codegraph init (inside it)"
}

step_statusline() {
  need python3 "The status line script needs Python 3."
  install -m 0755 "$HERE/statusline.py" "$CLAUDE_DIR/statusline.py"
  merge_json "$CLAUDE_DIR/settings.json" \
    "{\"statusLine\": {\"type\": \"command\", \"command\": \"python3 -I $CLAUDE_DIR/statusline.py\", \"padding\": 0}}"
  log "status line installed ($CLAUDE_DIR/statusline.py); a previous settings.json is kept as settings.json.bak if it changed"
}

[ $# -eq 0 ] && set -- all
for step in "$@"; do
  case "$step" in
    all)           step_agent_browser; step_find_skills; step_codegraph; step_statusline ;;
    agent-browser) step_agent_browser ;;
    find-skills)   step_find_skills ;;
    codegraph)     step_codegraph ;;
    statusline)    step_statusline ;;
    *) die "unknown step: $step (expected all|agent-browser|find-skills|codegraph|statusline)" ;;
  esac
done
log "done. Restart Claude Code (or /reload-plugins) to pick up new skills and the status line."
