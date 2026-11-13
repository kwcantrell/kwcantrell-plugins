"""Live Claude Code usage dashboard, served on localhost.

  python3 -I serve_dashboard.py [port]        default port 8788

GET /              the dashboard page (web/index.html)
GET /api/usage     the export_dashboard.build() JSON; ?days=1..90 (default 30)
GET /api/bash      Bash commands by program; ?days=, ?program=, ?q=
GET /api/patterns  skill candidates (patterns.py); ?days=, ?id= for one with all examples

Each API call backfills ~/.claude/usage-events from transcripts and re-aggregates
(about 0.2 s), cached for 3 s so several open tabs share one run.
"""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bash_commands  # noqa: E402
import export_dashboard  # noqa: E402
import patterns  # noqa: E402

PAGE = HERE.parent / "web" / "index.html"
TTL = 3.0
_lock = threading.Lock()
_cache = {}


_bash_lock = threading.Lock()


def bash(days, program, q):
    with _bash_lock:  # bash_commands keeps a per-file parse cache; one scan at a time
        out = bash_commands.summarize(bash_commands.collect(days), program or None, q or None)
    return json.dumps(out, separators=(",", ":")).encode()


_pat_lock = threading.Lock()
_pat_cache = {}
PAT_TTL = 30.0


def pattern_list(days, pid):
    with _pat_lock:  # mining takes a few seconds; share one result per range for PAT_TTL
        hit = _pat_cache.get(days)
        if not hit or time.monotonic() - hit[0] > PAT_TTL:
            hit = (time.monotonic(), patterns.mine(patterns.collect(days), top=10_000))
            _pat_cache[days] = hit
        res = hit[1]
    if pid:
        one = next((r for r in res["patterns"] if r["id"] == pid), None)
        return json.dumps(one or {"error": f"no pattern {pid}"}, separators=(",", ":")).encode()
    head = {k: v for k, v in res.items() if k != "patterns"}
    rows = [{**r, "examples": r["examples"][:3]} for r in res["patterns"][:80]]
    return json.dumps({**head, "patterns": rows}, separators=(",", ":")).encode()


def usage(days):
    with _lock:
        hit = _cache.get(days)
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1]
        body = json.dumps(export_dashboard.build(days), separators=(",", ":")).encode()
        _cache[days] = (time.monotonic(), body)
        return body


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path in ("/", "/index.html"):
            return self.send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
        if url.path in ("/api/usage", "/api/bash", "/api/patterns"):
            qs = parse_qs(url.query)
            try:
                days = int(qs.get("days", ["30"])[0])
            except ValueError:
                days = 30
            days = max(1, min(90, days))
            try:
                if url.path == "/api/patterns":
                    return self.send(200, pattern_list(days, qs.get("id", [""])[0][:20]), "application/json")
                if url.path == "/api/bash":
                    return self.send(200, bash(days, qs.get("program", [""])[0], qs.get("q", [""])[0][:200]), "application/json")
                return self.send(200, usage(days), "application/json")
            except Exception as e:  # report, keep serving
                return self.send(500, json.dumps({"error": str(e)}).encode(), "application/json")
        self.send(404, b"not found", "text/plain")

    def log_message(self, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"usage dashboard: http://127.0.0.1:{port}/", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
