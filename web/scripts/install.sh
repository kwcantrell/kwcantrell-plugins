#!/usr/bin/env bash
# Usage: install.sh [all|impeccable|shadcn]...   (default: all)
#
# Idempotent user-level install of the web plugin's skills into ~/.claude/skills via `npx skills`:
#   impeccable  pbakaus/impeccable --skill impeccable   (design, critique, audit, polish)
#   shadcn      shadcn-ui/ui --skill shadcn             (shadcn components, registries, presets)
# The shadcn MCP server ships with the plugin (.mcp.json) and needs no install.
set -euo pipefail

log() { printf '\033[36m[web]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[web] %s\033[0m\n' "$*" >&2; exit 1; }

command -v npx >/dev/null 2>&1 || die "npx is required but not on PATH. Install Node.js first."

skills_add() {  # skills_add <repo> <skill>
  log "installing $2 skill ($1)"
  npx -y skills add "$1" --skill "$2" -g -a claude-code -y
}

[ $# -eq 0 ] && set -- all
for step in "$@"; do
  case "$step" in
    all)        skills_add pbakaus/impeccable impeccable; skills_add shadcn-ui/ui shadcn ;;
    impeccable) skills_add pbakaus/impeccable impeccable ;;
    shadcn)     skills_add shadcn-ui/ui shadcn ;;
    *) die "unknown step: $step (expected all|impeccable|shadcn)" ;;
  esac
done
log "done. Restart Claude Code (or /reload-plugins) to pick up the new skills."
