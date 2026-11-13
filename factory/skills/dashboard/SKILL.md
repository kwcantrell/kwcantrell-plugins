---
description: Start the software factory dashboard, a live board of factory jobs moving through intake, build, proof, review and ship. Use when the user asks to see or open the factory dashboard or job status board.
argument-hint: [port]
---

# Factory dashboard

Requested port (optional): $ARGUMENTS

Start the dashboard server in the background with the Bash tool (`run_in_background: true`):

```
factory dashboard --port 8787
```

If `factory` is not on PATH use `${CLAUDE_PLUGIN_ROOT}/bin/factory`. This is the same as running `python3 -m http.server` inside the project's `factory/` directory, bound to localhost.

Then give the user the URL (`http://127.0.0.1:<port>/`) in one line. If the port is taken, pick the next free one. For a quick text view instead, run `factory status`.
