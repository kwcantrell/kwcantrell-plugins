---
name: usage-live
description: Start the live Claude Code usage dashboard (tokens, sessions, projects, tools, Bash commands) on localhost. Use when the user asks to open, start or see the live usage dashboard or usage server.
argument-hint: [port]
disable-model-invocation: false
---

# Live usage dashboard

Requested port (optional): $ARGUMENTS. Default 8788.

1. Check whether it is already running on that port:
   `curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:<port>/api/usage?days=1`
   A `200` means it is up: give the URL and stop.
2. Otherwise start it with the Bash tool and `run_in_background: true`:
   `python3 -I ${CLAUDE_PLUGIN_ROOT}/scripts/serve_dashboard.py <port>`
   If the port is taken by something else (the server exits with "Address already in use"), try the next port up.
3. Confirm with the same curl once it is up, then give the user `http://127.0.0.1:<port>/` in one line. Mention `#bash` opens the Bash commands view.

It binds to 127.0.0.1 only and runs as a background task of this session, so it stops when the session ends.
