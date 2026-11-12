#!/bin/sh
# The factory's human gates. Any Bash call that runs `factory merge` or
# `factory approve` is turned into a permission prompt, so no agent can ship a
# job or approve a spec without a person saying yes.
# Reads the PreToolUse payload on stdin; stays silent for everything else.
ask() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$1"
}
case "$(cat)" in
  *'factory merge'*|*'factory\" merge'*|*"factory' merge"*)
    ask "Software Factory merge gate: this merges an agent-built branch into your working branch. Approve only if you have read ship.md." ;;
  *'factory approve'*|*'factory\" approve'*|*"factory' approve"*)
    ask "Software Factory spec gate: this approves a job's task.md as the contract agents will build and be judged against." ;;
esac
exit 0
