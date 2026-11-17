# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A local collection of Claude Code plugins, one per top-level folder. `.claude-plugin/marketplace.json` publishes them as the marketplace `kwcantrell-plugins` (GitHub `kwcantrell/kwcantrell-plugins`, public).

| Folder | Kind | How it is loaded here |
| --- | --- | --- |
| `factory/` | Classic plugin: skills, agents, a command hook, a Python CLI | Marketplace (`factory@kwcantrell-plugins`) |
| `base-setup/` | Skills (`/base-setup:setup` driving an idempotent installer script; model-invocable `browser-login`), plus a mod (TSX hooks module) for the `/inventory` pane | Marketplace (`base-setup@kwcantrell-plugins`) |
| `web/` | One skill (`/web:setup` driving an idempotent installer script); no hooks or MCP servers | Marketplace (`web@kwcantrell-plugins`) |

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
- `skills/browser-login/SKILL.md` is model-invocable: when agent-browser hits a sign-in it can't do (OAuth/SSO providers block automated browsers; Claude must never type credentials), it runs `scripts/browser_login.py login <profile> <url> [--cookie NAME]` in the background. That opens plain, non-automated Chromium on `~/.agent-browser/profiles/<profile>` (`AGENT_BROWSER_PROFILES` overrides the root) for the human, then reports the site's saved cookies; agent-browser reuses the dir with `--profile`. The profile must be created with `--password-store=basic` because agent-browser launches with it; keyring-encrypted (`v11`) cookies are invisible to it, and `status` flags them. Cookies only reach disk on a clean window close (or Chromium's ~30s flush), not SIGTERM. "In use" is read from the profile's `SingletonLock` symlink (`<host>-<pid>`). Keep it generic: no site names in the skill or script.
- Test `browser_login.py` against a local server that sets a `Max-Age` cookie, closing the window with `xdotool ... key ctrl+shift+w`; then `agent-browser --profile <dir> open` it and check the cookie arrives.
- The mod is `hooks/hooks.json` -> `hooks/register.tsx` (imports from `'claude-code'`), its state contract `types/index.d.ts` (named in `plugin.json` `"types"`), and `hooks/inventory.test.tsx` (imports from `'claude-code/testing'`, fakes fs/env/session calls). `.claude-plugin/types/` is regenerated on every load: never edit it. Load the plugin-authoring skill before changing the mod.
- `/inventory` opens a pane grouping skills, plugins and MCP servers into User / Project / Session only. Scope comes from config files (`~/.claude/skills`, `~/.claude/settings.json` `enabledPlugins`, `~/.claude.json` `mcpServers`; `<cwd>/.claude/skills`, `.claude/settings{,.local}.json`, `.mcp.json`, `~/.claude.json` `projects[cwd].mcpServers`). The live `$.session.usage({ breakdown: 'summary' })` listing adds plugin skill counts, `plugin:<plugin>:<server>` MCP servers, claude.ai connectors (User) and anything unconfigured (Session only). It rescans every 60s and on `/inventory`.
- The inventory atom has shape tag `inventory-1`; bump it when `Inventory`'s fields change.

## web

- `scripts/install.sh [all|impeccable|shadcn]` (run by `/web:setup`) installs into the *project root* (`$CLAUDE_PROJECT_DIR`, else `git rev-parse --show-toplevel`, else cwd), unlike base-setup: `npx skills add shadcn/ui -a claude-code -y` (`.claude/skills/shadcn` plus the package's `migrate-radix-to-base`, `skills-lock.json`) and `npx impeccable install --project --providers=claude -y` (`.claude/skills/impeccable`, `.claude/agents/impeccable-*`, its hook in `.claude/settings.local.json`; the engine binary goes to `~/.impeccable/bin`). Both are idempotent.
- The plugin is only `skills/setup` + `scripts/install.sh`. It deliberately ships no hooks and no `.mcp.json`; anything that runs in a project (impeccable's hook, skills) is installed into that project by the script.

## factory

Read `factory/README.md` for the pipeline (intake -> build -> proof -> review -> ship -> done) and its design rationale. Key points when changing it:

- `factory/bin/factory` (single Python file) is the state machine and the only writer of `job.json`. Gates live there, not in prompts: exit 1 = refused, 2 = escalated to a human.
- Station prompts: `skills/run/SKILL.md` (supervisor), `agents/*.md` (builder, verifier, three reviewers). `skills/approve` and `skills/ship` are human-only.
- `scripts/human-gate.sh` (a `PreToolUse` Bash hook) turns `factory merge|approve|rework` into a permission prompt. A new human-only command must be added there too.
- `dashboard/index.html` is one dependency-free file that polls `jobs/*/job.json` through a plain directory-listing server. Fields added to `job.json` need handling there.
- Runtime state goes in the *target* project's `factory/` dir (`jobs/`, `worktrees/`); this repo's `factory/` folder is the plugin source, not runtime state.
- Optional per-project config is `factory.json`; the CLI refuses unknown keys, so new settings must be added to `DEFAULTS` and validation.
