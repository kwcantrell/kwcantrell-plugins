# kwcantrell-plugins

My Claude Code plugins, published as one marketplace.

```
/plugin marketplace add kwcantrell/kwcantrell-plugins
/plugin install factory@kwcantrell-plugins
/plugin install base-setup@kwcantrell-plugins   # then run /base-setup:setup
/plugin install web@kwcantrell-plugins          # then run /web:setup
```

| Plugin | What it does |
| --- | --- |
| [`factory`](factory/README.md) | Software Factory: runs a request through intake, an isolated build, independent proof, three reviewers and a human merge gate, with a live dashboard. |
| `base-setup` | Run `/base-setup:setup` once per machine: installs agent-browser (pointed at system Chromium, headed unless you ask for headless) the find-skills skill and codegraph (code-intelligence MCP server) into your user config, sets a status line (model, dir, git branch, context %, cost), and installs a tmux config (`~/.tmux.conf`: `C-a` prefix, mouse, catppuccin via TPM). Its `browser-login` skill gets agent-browser past sign-ins that block automated browsers (Google/Microsoft/SSO, CAPTCHAs): you sign in once in a normal Chromium window on a persistent profile, and agent-browser reuses it. Its `/inventory` pane lists every skill, plugin and MCP server grouped by user and project scope (a mod: needs a Claude Code build with mod support). |
| `web` | Frontend work on shadcn/ui: `/web:setup` installs the shadcn (`npx skills add shadcn/ui`) and impeccable (`npx impeccable install`) skills into the project root. The plugin contains only that skill (no hooks, no MCP servers). |

`base-setup` needs Node.js (npm/npx), Chromium, Python 3, tmux and git. Its installer is `base-setup/scripts/install.sh [all|agent-browser|find-skills|codegraph|statusline|tmux]`; it is idempotent. `web` needs Node.js.
