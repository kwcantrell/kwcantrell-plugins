---
name: setup
description: Install the web plugin's skills (shadcn and impeccable) into the current project. Use when the user asks to set up the web plugin or install impeccable or the shadcn skill.
disable-model-invocation: true
argument-hint: "[all|impeccable|shadcn]"
allowed-tools: Bash(bash ${CLAUDE_PLUGIN_ROOT}/scripts/install.sh:*)
---

# Web setup

Run the installer with the steps the user asked for (default `all`):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" $ARGUMENTS
```

It is idempotent and installs into the **project root** (`$CLAUDE_PROJECT_DIR`, else the git top level,
else the current directory), never the user config:

- `shadcn`: `npx skills add shadcn/ui` puts the `shadcn` skill (and the package's
  `migrate-radix-to-base` skill) in `.claude/skills/` and records them in `skills-lock.json`.
- `impeccable`: `npx impeccable install` puts the `impeccable` skill in `.claude/skills/`, its agents in
  `.claude/agents/`, and its design hook in `.claude/settings.local.json`.

The shadcn MCP server is bundled with the plugin and needs no install. The shadcn-only rule is enforced by the plugin's hook whether or not this has run.

When it finishes, report what was installed and where, say the files can be committed so the whole team
gets them, and say a restart (or `/reload-plugins`) picks up the new skills.
