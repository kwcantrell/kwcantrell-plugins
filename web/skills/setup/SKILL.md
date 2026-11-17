---
name: setup
description: Install the web plugin's skills (impeccable and shadcn) into the user's Claude Code config. Use when the user asks to set up the web plugin or install impeccable or the shadcn skill.
disable-model-invocation: true
argument-hint: "[all|impeccable|shadcn]"
allowed-tools: Bash(bash ${CLAUDE_PLUGIN_ROOT}/scripts/install.sh:*)
---

# Web setup

Run the installer with the steps the user asked for (default `all`):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" $ARGUMENTS
```

It is idempotent. It installs, globally for Claude Code via `npx skills`:

- `impeccable` from `pbakaus/impeccable`: designing, critiquing, auditing and polishing frontend UI.
- `shadcn` from `shadcn-ui/ui`: adding, searching, composing and styling shadcn components.

The shadcn MCP server is bundled with the plugin and needs no install. The shadcn-only rule is enforced by the plugin's hook whether or not this has run.

When it finishes, report what was installed and say a restart (or `/reload-plugins`) picks up the new skills.
