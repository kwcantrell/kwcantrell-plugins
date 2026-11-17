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
| `base-setup` | Run `/base-setup:setup` once per machine: installs agent-browser (pointed at system Chromium, headed unless you ask for headless) the find-skills skill and codegraph (code-intelligence MCP server) into your user config, and sets a status line (model, dir, git branch, context %, cost). Its `browser-login` skill gets agent-browser past sign-ins that block automated browsers (Google/Microsoft/SSO, CAPTCHAs): you sign in once in a normal Chromium window on a persistent profile, and agent-browser reuses it. Its `/inventory` pane lists every skill, plugin and MCP server grouped by user and project scope (a mod: needs a Claude Code build with mod support). |
| `web` | Frontend work on shadcn/ui: `/web:setup` installs the impeccable and shadcn skills; the plugin adds the shadcn MCP server and a hook that rejects `.jsx`/`.tsx` edits using native `<button>`/`<input>`/`<select>`/... elements, other UI kits or raw Radix/Base UI imports outside `components/ui`. |

`base-setup` needs Node.js (npm/npx), Chromium and Python 3. Its installer is `base-setup/scripts/install.sh [all|agent-browser|find-skills|codegraph|statusline]`; it is idempotent. `web` needs Node.js and Python 3.
