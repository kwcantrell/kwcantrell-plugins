---
name: setup
description: Set up this machine's user-level Claude Code config - install agent-browser configured for system Chromium, the find-skills skill, codegraph (code-intelligence MCP), and the base-setup status line. Use when the user asks to run base setup, bootstrap their Claude config, install agent-browser or find-skills, or set up the status line.
disable-model-invocation: true
argument-hint: "[all|agent-browser|find-skills|codegraph|statusline]"
allowed-tools: Bash(bash ${CLAUDE_PLUGIN_ROOT}/scripts/install.sh:*)
---

# Base setup

Run the installer with the steps the user asked for (default `all`):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" $ARGUMENTS
```

It is idempotent, so re-running is safe. What each step does:

- `agent-browser`: `npm i -g agent-browser` if missing, sets `executablePath` in `~/.agent-browser/config.json` to the system Chromium (override with `CHROMIUM_PATH=/path/to/chromium`) and `headed: true`, so the browser window always shows unless a call asks for headless (`--headed false` or `AGENT_BROWSER_HEADED=false`), and installs the `agent-browser` skill globally with `npx skills`. It does not run `agent-browser install`, since that downloads Chrome for Testing, which is not needed.
- `find-skills`: `npx skills add vercel-labs/skills --skill find-skills -g -a claude-code -y`.
- `codegraph`: `npm i -g @colbymchenry/codegraph` if missing, `codegraph telemetry off`, then `codegraph install --target=claude --location=global --yes`, which adds the `codegraph` MCP server to `~/.claude.json`, auto-allows `mcp__codegraph__*` and adds a CodeGraph section to the user CLAUDE.md. Tell the user to run `codegraph init` inside each project they want indexed; `codegraph uninstall` reverses it.
- `statusline`: copies `statusline.py` to `~/.claude/statusline.py` and sets `statusLine` in `~/.claude/settings.json` (model, directory, git branch, context %, cost). The previous settings file is kept as `settings.json.bak` when it changes.

If it fails because Chromium is missing, tell the user the install command for their OS rather than installing system packages yourself. When it finishes, report what changed and say a restart (or `/reload-plugins`) picks up the new skills and status line.
