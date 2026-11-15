# kwcantrell-plugins

My Claude Code plugins, published as one marketplace.

```
/plugin marketplace add kwcantrell/kwcantrell-plugins
/plugin install factory@kwcantrell-plugins
```

| Plugin | What it does |
| --- | --- |
| [`factory`](factory/README.md) | Software Factory: runs a request through intake, an isolated build, independent proof, three reviewers and a human merge gate, with a live dashboard. |
| `usage-dashboard` | A usage pane in the terminal, a live localhost dashboard (tokens, sessions, tools, Bash commands, where the time goes) and skill candidates mined from repeated tool calls. |
| `context-explorer` | A pane to browse everything loaded into the context: CLAUDE.md and MEMORY.md files, system prompt sections, skills and tools. |

`usage-dashboard` and `context-explorer` are mods (TSX hooks modules) and need a Claude Code build that supports them. The Python scripts need Python 3.8+ and use only the standard library.
