# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A local collection of Claude Code plugins, one per top-level folder. `.claude-plugin/marketplace.json` publishes them as the marketplace `kwcantrell-plugins` (GitHub `kwcantrell/kwcantrell-plugins`, public).

| Folder | Kind | How it is loaded here |
| --- | --- | --- |
| `factory/` | Classic plugin: skills, agents, a command hook, a Python CLI | Marketplace (`factory@kwcantrell-plugins`) |
| `base-setup/` | Skill (`/base-setup:setup`) driving an idempotent installer script, plus a mod (TSX hooks module) for the `/inventory` pane | Marketplace (`base-setup@kwcantrell-plugins`) |
| `web/` | Setup skill, bundled shadcn MCP server (`.mcp.json`), SessionStart + PreToolUse hooks | Marketplace (`web@kwcantrell-plugins`) |

A new plugin needs an entry in `marketplace.json` (or a plugin-dir entry) to load at all.

## Commands

```sh
claude plugin validate <plugin-folder>   # manifest, skills, agents, hooks, mod module
claude plugin test base-setup            # runs every *.test.ts(x) under the folder; exits 1 on failure
tsc -p base-setup                        # typecheck the mod (needs .claude-plugin/types/, generated on load)
```

There is no package.json, build step or linter; everything ships as source.

Python scripts are stdlib only and are always run isolated: `python3 -I <script> ...`. Each script's module docstring is its usage line. Notable:

- `factory/bin/factory --help` lists every factory CLI command; `factory status` and `factory stats` are read-only.

## base-setup

- `skills/setup/SKILL.md` is human-invoked only (`disable-model-invocation`) and just runs `scripts/install.sh [all|agent-browser|find-skills|codegraph|statusline]`.
- `install.sh` writes to *user* config only: `~/.agent-browser/config.json` (`executablePath` -> system Chromium, `CHROMIUM_PATH` overrides; `headed: true`, so headless only on `--headed false` / `AGENT_BROWSER_HEADED=false`), skills via `npx skills add ... -g -a claude-code -y`, `codegraph telemetry off` then `codegraph install --target=claude --location=global --yes` (codegraph owns what it writes: `~/.claude.json` MCP entry, permissions, CLAUDE.md section), and `statusLine` in `~/.claude/settings.json`. Every step must stay idempotent; JSON files are merged (never overwritten) and backed up to `.bak` when changed.
- The status line is copied to `~/.claude/statusline.py` rather than referenced in the plugin cache, because the cache path changes on every plugin update. Re-run the `statusline` step after editing `scripts/statusline.py`.
- It deliberately skips `agent-browser install` (which downloads Chrome for Testing).
- The mod is `hooks/hooks.json` -> `hooks/register.tsx` (imports from `'claude-code'`), its state contract `types/index.d.ts` (named in `plugin.json` `"types"`), and `hooks/inventory.test.tsx` (imports from `'claude-code/testing'`, fakes fs/env/session calls). `.claude-plugin/types/` is regenerated on every load: never edit it. Load the plugin-authoring skill before changing the mod.
- `/inventory` opens a pane grouping skills, plugins and MCP servers into User / Project / Session only. Scope comes from config files (`~/.claude/skills`, `~/.claude/settings.json` `enabledPlugins`, `~/.claude.json` `mcpServers`; `<cwd>/.claude/skills`, `.claude/settings{,.local}.json`, `.mcp.json`, `~/.claude.json` `projects[cwd].mcpServers`). The live `$.session.usage({ breakdown: 'summary' })` listing adds plugin skill counts, `plugin:<plugin>:<server>` MCP servers, claude.ai connectors (User) and anything unconfigured (Session only). It rescans every 60s and on `/inventory`.
- The inventory atom has shape tag `inventory-1`; bump it when `Inventory`'s fields change.

## web

- `scripts/install.sh [all|impeccable|shadcn]` (run by `/web:setup`) installs the `impeccable` (pbakaus/impeccable) and `shadcn` (shadcn-ui/ui) skills globally via `npx skills`, same pattern as base-setup.
- `scripts/shadcn_guard.py check` is the enforcement: a `PreToolUse` hook on `Write|Edit|MultiEdit` that denies `.jsx`/`.tsx` edits whose *added* text uses a native element with a shadcn equivalent (`NATIVE` map), imports another UI kit (`OTHER_KITS`), or imports Radix/Base UI primitives (`PRIMITIVES`). Files under the shadcn ui dir (`components.json` `aliases.ui`, default `components/ui`) are exempt. Only added text is checked so legacy code never blocks unrelated edits. There is deliberately no in-file opt-out comment.
- `shadcn_guard.py context` (SessionStart) injects the rule only in React projects (components.json, or react/next in package.json).
- Test the guard by piping a hook payload: `echo '{"tool_name":"Write","cwd":"...","tool_input":{"file_path":"x.tsx","content":"<button/>"}}' | python3 -I web/scripts/shadcn_guard.py check`.

## factory

Read `factory/README.md` for the pipeline (intake -> build -> proof -> review -> ship -> done) and its design rationale. Key points when changing it:

- `factory/bin/factory` (single Python file) is the state machine and the only writer of `job.json`. Gates live there, not in prompts: exit 1 = refused, 2 = escalated to a human.
- Station prompts: `skills/run/SKILL.md` (supervisor), `agents/*.md` (builder, verifier, three reviewers). `skills/approve` and `skills/ship` are human-only.
- `scripts/human-gate.sh` (a `PreToolUse` Bash hook) turns `factory merge|approve|rework` into a permission prompt. A new human-only command must be added there too.
- `dashboard/index.html` is one dependency-free file that polls `jobs/*/job.json` through a plain directory-listing server. Fields added to `job.json` need handling there.
- Runtime state goes in the *target* project's `factory/` dir (`jobs/`, `worktrees/`); this repo's `factory/` folder is the plugin source, not runtime state.
- Optional per-project config is `factory.json`; the CLI refuses unknown keys, so new settings must be added to `DEFAULTS` and validation.
