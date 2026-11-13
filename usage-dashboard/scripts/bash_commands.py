"""Bash commands Claude ran, read from Claude Code transcripts.

  python3 -I bash_commands.py [days] [program]     JSON on stdout

collect(days) returns every Bash call in range as
  {at, cmd, desc, project, session, agent, err}
and summarize(calls, program) groups them by program and by exact command.
Parsed files are cached by (mtime, size), so repeat calls only re-read
transcripts that changed.
"""

import json
import re
import shlex
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path.home() / ".claude" / "projects"
HOME = str(Path.home())
_cache = {}  # path -> (mtime, size, [calls])

ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
WRAPPERS = {"sudo", "env", "time", "nohup", "exec", "command", "timeout", "nice", "xargs"}
SUBCOMMANDS = {"git", "npm", "npx", "docker", "gh", "make", "systemctl", "ansible-playbook", "tofu", "openspec",
               "factory", "lxc", "kubectl", "pnpm", "yarn", "pip", "uv", "cargo", "go", "bao", "node"}
SPLIT = re.compile(r"\s*(?:&&|\|\||;|\||\n)\s*")
CONTROL = {"for", "while", "until", "if", "elif", "case", "function"}
LEADERS = {"do", "then", "else", "!", "time"}
SKIP = {"cd", "pushd", "popd", "set", "export", "source", ".", "echo", "printf", "true", "false", "sleep", "done", "fi", "esac", "}", ")", "local", "read", "trap", "wait", "return", "exit"}


def ms(ts):
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError):
        return None


def short(cwd):
    if not cwd:
        return "?"
    if cwd == HOME:
        return "~"
    return "~/" + cwd[len(HOME) + 1:] if cwd.startswith(HOME + "/") else cwd


def program(cmd):
    """The program a command runs, e.g. 'git status', skipping cd/env/sudo prefixes."""
    for part in SPLIT.split(cmd.strip()):
        part = part.lstrip("({ ").rstrip()
        if not part or "=" in part.split(" ", 1)[0] and part.split(" ", 1)[0].endswith(")") or part.endswith("()"):
            continue
        try:
            words = shlex.split(part, comments=True)
        except ValueError:
            words = part.split()
        if words and words[0] in CONTROL:
            continue
        while words and words[0] in LEADERS:
            words = words[1:]
        while words and (ASSIGN.match(words[0]) or words[0] in WRAPPERS or words[0].startswith("-")):
            words = words[1:]
            if words and words[0] in ("-u", "-n", "-s") or (words and re.fullmatch(r"\d+[smh]?", words[0])):
                words = words[1:]
        if not words or words[0] in SKIP or words[0].startswith("$(") or words[0].startswith("#"):
            continue
        name = words[0].rsplit("/", 1)[-1]
        if name in SUBCOMMANDS:
            rest = [w for w in words[1:] if not w.startswith("-")]
            if name in ("npm", "pnpm", "yarn") and rest[:1] == ["run"] and len(rest) > 1:
                return f"{name} run {rest[1]}"
            if rest and re.fullmatch(r"[a-z][a-z0-9:_-]*", rest[0]):
                return f"{name} {rest[0]}"
        return name
    first = cmd.strip().split()
    return first[0] if first else "?"


def parse(path, agent, sid):
    calls, pending = [], {}
    try:
        fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return calls
    with fh:
        for line in fh:
            if '"Bash"' not in line and '"tool_result"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            content = (row.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use" and b.get("name") == "Bash":
                    inp = b.get("input") or {}
                    cmd = inp.get("command")
                    if not isinstance(cmd, str):
                        continue
                    c = {"at": ms(row.get("timestamp")) or 0, "cmd": cmd, "desc": inp.get("description") or "",
                         "project": short(row.get("cwd")), "session": sid[:8], "agent": agent, "err": False,
                         "bg": bool(inp.get("run_in_background"))}
                    calls.append(c)
                    pending[b.get("id")] = c
                elif b.get("type") == "tool_result" and b.get("is_error"):
                    c = pending.get(b.get("tool_use_id"))
                    if c:
                        c["err"] = True
    return calls


def collect(days):
    since_s = time.time() - days * 86400
    since_ms = int(since_s * 1000)
    out, seen = [], set()
    for path in ROOT.rglob("*.jsonl"):
        try:
            st = path.stat()
        except OSError:
            continue
        if st.st_mtime < since_s:
            continue
        seen.add(path)
        hit = _cache.get(path)
        if not hit or hit[0] != st.st_mtime or hit[1] != st.st_size:
            rel = path.relative_to(ROOT).parts
            if "subagents" in rel and len(rel) >= 4:
                sid, agent = rel[-3], "subagent"
            elif len(rel) == 2:
                sid, agent = path.stem, "main"
            else:
                continue
            hit = (st.st_mtime, st.st_size, parse(path, agent, sid))
            _cache[path] = hit
        out.extend(c for c in hit[2] if c["at"] >= since_ms)
    for p in [p for p in _cache if p not in seen]:
        del _cache[p]
    return out


def summarize(calls, prog=None, q=None, limit=500):
    progs = {}
    for c in calls:
        p = program(c["cmd"])
        c["program"] = p
        g = progs.setdefault(p, {"program": p, "calls": 0, "errors": 0, "last": 0})
        g["calls"] += 1
        g["errors"] += c["err"]
        g["last"] = max(g["last"], c["at"])
    ql = (q or "").lower()
    chosen = [c for c in calls if (prog is None or c["program"] == prog) and (not ql or ql in c["cmd"].lower() or ql in c["desc"].lower())]
    cmds = {}
    for c in chosen:
        key = " ".join(c["cmd"].split())
        g = cmds.setdefault(key, {"command": c["cmd"], "program": c["program"], "calls": 0, "errors": 0, "last": 0,
                                  "desc": "", "projects": set(), "subagent": 0})
        g["calls"] += 1
        g["errors"] += c["err"]
        g["subagent"] += c["agent"] == "subagent"
        g["projects"].add(c["project"])
        if c["at"] >= g["last"]:
            g["last"], g["desc"] = c["at"], c["desc"] or g["desc"]
    rows = sorted(cmds.values(), key=lambda g: (-g["calls"], -g["last"]))
    for g in rows:
        g["projects"] = sorted(g["projects"])
    recent = sorted(chosen, key=lambda c: -c["at"])[:200]
    return {
        "total": len(calls), "errors": sum(c["err"] for c in calls),
        "programs": sorted(progs.values(), key=lambda g: -g["calls"]),
        "program": prog, "q": q or "", "matching": len(chosen), "distinct": len(rows), "truncated": len(rows) > limit,
        "commands": rows[:limit],
        "recent": [{k: c[k] for k in ("at", "cmd", "desc", "project", "session", "agent", "err", "bg")} for c in recent],
    }


if __name__ == "__main__":
    d = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    json.dump(summarize(collect(d), sys.argv[2] if len(sys.argv) > 2 else None), sys.stdout)
