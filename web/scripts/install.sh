#!/usr/bin/env bash
# Usage: install.sh [all|impeccable|shadcn]...   (default: all)
#
# Idempotent install of the web plugin's skills into the current project's root (not the user config):
#   shadcn      npx skills add shadcn/ui          -> .claude/skills/shadcn (+ migrate-radix-to-base), skills-lock.json
#   impeccable  npx impeccable install            -> .claude/skills/impeccable, .claude/agents/impeccable-*,
#                                                    its design hook in .claude/settings.local.json
# The project root is $CLAUDE_PROJECT_DIR, else the git top level, else the current directory.
set -euo pipefail

log() { printf '\033[36m[web]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[web] %s\033[0m\n' "$*" >&2; exit 1; }

command -v npx >/dev/null 2>&1 || die "npx is required but not on PATH. Install Node.js first."

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" || die "cannot enter project root: $root"
log "project root: $root"

install_shadcn() {
  log "installing the shadcn skill (npx skills add shadcn/ui)"
  npx -y skills add shadcn/ui -a claude-code -y
}

install_impeccable() {
  log "installing impeccable (npx impeccable install)"
  npx -y impeccable install --project --providers=claude -y
}

[ $# -eq 0 ] && set -- all
for step in "$@"; do
  case "$step" in
    all)        install_shadcn; install_impeccable ;;
    shadcn)     install_shadcn ;;
    impeccable) install_impeccable ;;
    *) die "unknown step: $step (expected all|impeccable|shadcn)" ;;
  esac
done
log "done. Restart Claude Code (or /reload-plugins) to pick up the new skills."
