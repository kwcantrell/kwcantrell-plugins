---
name: browser-login
description: Get agent-browser past a sign-in it cannot complete itself - "Sign in with Google/Microsoft/Apple", SSO, CAPTCHA, passkey or 2FA pages, "This browser or app may not be secure", or a saved session that stopped working. The human signs in once in a plain (non-automated) Chromium window on a persistent profile, and agent-browser reuses that profile afterwards. Use whenever an agent-browser task hits a login wall, or the user asks to log agent-browser into a site.
argument-hint: "<profile-name> <login-url> [--cookie <session-cookie-name>]"
allowed-tools: Bash(python3 -I ${CLAUDE_PLUGIN_ROOT}/scripts/browser_login.py:*)
---

# Browser login handoff for agent-browser

Identity providers (Google, Microsoft, Apple, most SSO) refuse sign-in from automation-controlled browsers, and you must never type the user's password, 2FA codes or other credentials yourself. So the human signs in once, outside automation, into a persistent Chromium profile that agent-browser then opens.

The helper is `python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/browser_login.py"` (below: `browser_login.py`). Profiles live at `~/.agent-browser/profiles/<profile>`.

## 1. Pick the names

- **profile**: a short name per site or account, e.g. `acme-admin`. Reuse it on later visits.
- **login URL**: the page that starts sign-in. Prefer the app's own "sign in" link target (for OAuth often `/auth/<provider>/start` or similar; read it with `agent-browser get attr <ref> href`) over the provider's URL, so the app sets its session cookie when the provider redirects back.
- **session cookie** (optional but recommended): the app cookie that marks a session. Find it after a login with `browser_login.py status <profile> <url>`, then pass `--cookie <name>` on later runs so a failed login is detected.

Check first whether a profile already works: `browser_login.py status <profile> <url>` (exit 0 = readable cookies saved), then open the site with the profile (step 3) and look for the sign-in UI.

## 2. Have the human sign in

Close any agent-browser session using the profile (`agent-browser --session <profile> close`); a profile can be open in only one browser. Then run, **in the background** (it blocks until the window closes):

```bash
python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/browser_login.py" login <profile> <login-url> [--cookie <name>]
```

Tell the user plainly: a Chromium window opened; sign in there, and once the app has loaded, **close the window normally** (not Ctrl-C or kill, which loses the cookies). Then end your turn and wait for the background task to finish. Do not poll. On exit 0 it lists the saved cookies; exit 1 means the login did not stick (not finished, or the window was killed), so offer to run it again.

## 3. Use the profile

Run every agent-browser command for that site with the profile:

```bash
agent-browser --session <profile> --profile ~/.agent-browser/profiles/<profile> \
  --args "--disable-blink-features=AutomationControlled" open <app-url>
```

Keep the same `--session <profile>` on later commands. `--disable-blink-features=AutomationControlled` hides `navigator.webdriver`, so a later "Sign in with <provider>" click usually completes from the stored provider session (account chooser) without the human. If the app logs out again, repeat step 2.

Verify the login the way the app shows it: a profile/"me" API returning the user, the signed-in UI, or the absence of the sign-in button. Report what you checked.

## Pitfalls (already handled by the helper; know them when debugging)

- agent-browser launches Chromium with `--password-store=basic`. A profile created without that flag encrypts cookies with the desktop keyring (`v11`), and agent-browser silently sees no cookies. `status` flags these as UNREADABLE; recreate the profile with `login`.
- Copying the user's everyday Chrome/Chromium profile has the same keyring problem, and newer Chrome refuses remote debugging on its default profile. Use a dedicated profile.
- Session cookies (no expiry) are not restored on relaunch; only persistent ones survive. A site whose login is a session cookie needs the alternative below.
- `--state <file>.json` snapshots (cookies + storage) work too but go stale when the server rotates or ends the session; the profile keeps the provider login, so it can recover.

## Alternative: attach to a human-started browser

When the site needs the human present throughout (session cookies, frequent re-auth, hardware keys), start Chromium yourself with a debugging port on the profile and attach instead of launching:

```bash
chromium --user-data-dir="$HOME/.agent-browser/profiles/<profile>" --password-store=basic \
  --no-first-run --remote-debugging-port=9333 <login-url> &
agent-browser --session <profile> connect 9333
```

The human signs in in that window while agent-browser is attached; `navigator.webdriver` stays false.
