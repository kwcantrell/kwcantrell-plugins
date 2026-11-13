"""Find repeated tool-call patterns in Claude Code transcripts: skill candidates.

  python3 -I patterns.py [days] [--top N]        JSON on stdout
  python3 -I patterns.py [days] --id <pattern>   one pattern with up to 12 examples

Three kinds of pattern:
  chain     one Bash command that strings several programs together
            ("cd <dir> && npm ci && npm test"), the same shape in many sessions
  together  a set of meaningful programs (not grep/cat/cd...) used in one Bash command
  sequence  consecutive tool calls in one agent's transcript
            (Read -> Edit -> Bash:npm test), repeated across sessions

Arguments are normalized away (paths, ids, numbers, strings) so the same steps
with different targets count as one pattern. Parsed files are cached by
(mtime, size) when imported by the server.
"""

import hashlib
import json
import math
import re
import shlex
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bash_commands import CONTROL, LEADERS, SKIP, SUBCOMMANDS, WRAPPERS, ASSIGN, short  # noqa: E402

ROOT = Path.home() / ".claude" / "projects"
HOME = str(Path.home())
_cache = {}  # path -> (mtime, size, steps)

SEP = re.compile(r"(\s*(?:&&|\|\||;|\||\n)\s*)")
TRIVIAL = {"grep", "sed", "cat", "ls", "head", "tail", "wc", "awk", "sort", "uniq", "cut", "tr", "find", "echo", "printf",
           "true", "test", "[", "xargs", "tee", "jq", "column", "rg", "stat", "date", "basename", "dirname", "realpath", "diff"}
GENERIC = TRIVIAL | {"cd", "mkdir", "rm", "cp", "mv", "which", "python3", "python", "node", "bash", "sh", "chmod", "touch",
                     "ps", "kill", "pkill", "sleep", "env", "pwd", "whoami", "id", "uname", "file", "less", "more", "tar", "unzip"}
NOISE_TOOLS = {"ToolSearch", "TodoWrite", "TaskStop", "SubagentHandback"}


def ms(ts):
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError):
        return None


def seg_program(part):
    """(program, skeleton) for one shell segment, or None for setup like cd/export."""
    part = part.strip().lstrip("({ ").rstrip(")} ")
    if not part or part.startswith("#"):
        return None
    try:
        words = shlex.split(part, comments=True)
    except ValueError:
        words = part.split()
    if words and words[0] in CONTROL:
        return None
    while words and words[0] in LEADERS:
        words = words[1:]
    while words and (ASSIGN.match(words[0]) or words[0] in WRAPPERS or re.fullmatch(r"\d+(\.\d+)?[smhd]?", words[0])
                     or (words[0].startswith("-") and len(words) > 1)):
        words = words[1:]
    if not words or words[0].startswith("$") or words[0].startswith("-") or words[0] in ("break", "continue", "do", "done"):
        return None
    name = words[0].rsplit("/", 1)[-1]
    if name in SKIP:
        return ("cd", "cd") if name in ("cd", "pushd") else None
    rest = [w for w in words[1:] if not w.startswith("-")]
    if name in SUBCOMMANDS and rest and re.fullmatch(r"[a-z][a-z0-9:_-]*", rest[0]):
        name = f"{name} {rest[0]}"
        if name in ("npm run", "pnpm run", "yarn run") and len(rest) > 1:
            name += " " + rest[1]
    flags = sorted({w.split("=", 1)[0] for w in words[1:] if w.startswith("-") and len(w) < 30})[:4]
    return name, " ".join([name] + flags)


HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def strip_heredocs(cmd):
    """Drop heredoc bodies; keep the line that opens them."""
    out, lines, i = [], cmd.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        ends = [m.group(2) for m in HEREDOC.finditer(line)]
        i += 1
        for end in ends:
            while i < len(lines) and lines[i].strip() != end:
                i += 1
            i += 1
    return "\n".join(out)


def split_ops(cmd):
    """Split on && || ; | and newlines outside quotes and $( ). Returns [seg, op, seg, op, ...]."""
    parts, buf, q, depth, i = [], [], None, 0, 0
    while i < len(cmd):
        ch = cmd[i]
        if ch == "\\" and q != "'":
            buf.append(cmd[i:i + 2]); i += 2; continue
        if q:
            if ch == q:
                q = None
            buf.append(ch); i += 1; continue
        if ch in "'\"":
            q = ch; buf.append(ch); i += 1; continue
        if cmd.startswith("$(", i):
            depth += 1; buf.append("$("); i += 2; continue
        if ch == ")" and depth:
            depth -= 1; buf.append(ch); i += 1; continue
        if depth == 0:
            two = cmd[i:i + 2]
            if two in ("&&", "||"):
                parts += ["".join(buf), two]; buf = []; i += 2; continue
            if ch in ";\n" or (ch == "|" and two != "||"):
                parts += ["".join(buf), "|" if ch == "|" else ";"]; buf = []; i += 1; continue
        buf.append(ch); i += 1
    parts.append("".join(buf))
    return parts


def bash_shape(cmd):
    """Normalized shape of a command: its program skeletons joined by their operators."""
    parts = split_ops(strip_heredocs(cmd.strip()))
    out, progs = [], []
    for i, p in enumerate(parts):
        if i % 2:
            if out and out[-1] not in ("&&", "||", ";", "|"):
                out.append(p)
            continue
        sp = seg_program(p)
        if sp:
            out.append(sp[1])
            progs.append(sp[0])
    while out and out[-1] in ("&&", "||", ";", "|"):
        out.pop()
    return " ".join(out), progs


EXT = re.compile(r"\.([A-Za-z0-9]{1,6})$")


def step_key(name, inp):
    """A short, argument-free label for one tool call."""
    inp = inp or {}
    if name == "Bash":
        _, progs = bash_shape(inp.get("command") or "")
        main = [p for p in progs if p.split(" ")[0] not in GENERIC]
        if main:
            return "Bash:" + main[0]
        if any(p in ("python3", "python", "node") for p in progs):
            return "Bash:script"
        return "Bash:inspect"
    if name in ("Read", "Edit", "Write", "NotebookEdit"):
        fp = inp.get("file_path") or inp.get("notebook_path") or ""
        m = EXT.search(fp)
        tag = "md" if fp.endswith("SKILL.md") else (m.group(1).lower() if m else "file")
        if "/factory/jobs/" in fp:
            tag = "factory-job:" + fp.rsplit("/", 1)[-1]
        return f"{name}:{tag}"
    if name == "Agent":
        return "Agent:" + (inp.get("subagent_type") or "general")
    if name == "Skill":
        return "Skill:" + (inp.get("skill") or "?")
    if name.startswith("mcp__"):
        return name.split("__", 2)[-1] if name.count("__") >= 2 else name
    return name


def parse(path, sid, agent):
    steps, pending = [], {}
    try:
        fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return steps
    with fh:
        for line in fh:
            if '"tool_use"' not in line and '"tool_result"' not in line:
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
                if b.get("type") == "tool_use":
                    name, inp = b.get("name") or "?", b.get("input") or {}
                    if name in NOISE_TOOLS:
                        continue
                    s = {"at": ms(row.get("timestamp")) or 0, "tool": name, "key": step_key(name, inp),
                         "project": short(row.get("cwd")), "sid": sid[:8], "agent": agent, "err": False,
                         "cmd": inp.get("command") if name == "Bash" else None,
                         "arg": (inp.get("file_path") or inp.get("description") or inp.get("skill") or inp.get("pattern") or "")[:160]}
                    steps.append(s)
                    pending[b.get("id")] = s
                elif b.get("type") == "tool_result" and b.get("is_error"):
                    s = pending.get(b.get("tool_use_id"))
                    if s:
                        s["err"] = True
    return steps


def collect(days):
    since_s = time.time() - days * 86400
    since_ms = int(since_s * 1000)
    streams, seen = [], set()
    for path in ROOT.rglob("*.jsonl"):
        try:
            st = path.stat()
        except OSError:
            continue
        if st.st_mtime < since_s:
            continue
        rel = path.relative_to(ROOT).parts
        if "subagents" in rel and len(rel) >= 4:
            sid, agent = rel[-3], "subagent"
        elif len(rel) == 2:
            sid, agent = path.stem, "main"
        else:
            continue
        seen.add(path)
        hit = _cache.get(path)
        if not hit or hit[0] != st.st_mtime or hit[1] != st.st_size:
            hit = (st.st_mtime, st.st_size, parse(path, sid, agent))
            _cache[path] = hit
        steps = [s for s in hit[2] if s["at"] >= since_ms]
        if steps:
            streams.append(steps)
    for p in [p for p in _cache if p not in seen]:
        del _cache[p]
    return streams


GENERIC_STEP = re.compile(r"^(Read:|Grep|Glob|Bash:inspect|Bash:script|Bash:cd|Bash$)")


def pid(kind, key):
    return kind[0] + hashlib.sha1(f"{kind}:{key}".encode()).hexdigest()[:8]


def collapse(keys):
    """Runs of the same step become one ('Read:ts' x3 -> 'Read:ts+')."""
    out = []
    for k in keys:
        if out and (out[-1] == k or out[-1] == k + "+"):
            out[-1] = k + "+"
        else:
            out.append(k)
    return out


def mine(streams, top=60):
    chains = defaultdict(lambda: {"n": 0, "sessions": set(), "projects": Counter(), "err": 0, "examples": [], "last": 0})
    sets = defaultdict(lambda: {"n": 0, "sessions": set(), "projects": Counter(), "err": 0, "examples": [], "last": 0})
    bash_total = 0
    seqs = defaultdict(lambda: {"n": 0, "sessions": set(), "projects": Counter(), "err": 0, "examples": [], "last": 0})

    for steps in streams:
        for s in steps:
            if s["tool"] != "Bash" or not s["cmd"]:
                continue
            bash_total += 1
            shape, progs = bash_shape(s["cmd"])
            real = [p for p in progs if p != "cd"]
            meaningful = sorted(set(p for p in real if p.split(" ")[0] not in GENERIC))
            if 2 <= len(meaningful) <= 6:
                k = " + ".join(meaningful)
                c = sets[k]
                c["n"] += 1
                c["sessions"].add(s["sid"])
                c["projects"][s["project"]] += 1
                c["err"] += s["err"]
                c["last"] = max(c["last"], s["at"])
                c["members"] = meaningful
                if len(c["examples"]) < 12 and s["cmd"] not in (e["cmd"] for e in c["examples"]):
                    c["examples"].append(s)
            if len(real) >= 2 and meaningful:
                c = chains[shape]
                c["n"] += 1
                c["sessions"].add(s["sid"])
                c["projects"][s["project"]] += 1
                c["err"] += s["err"]
                c["last"] = max(c["last"], s["at"])
                if len(c["examples"]) < 12 and s["cmd"] not in (e["cmd"] for e in c["examples"]):
                    c["examples"].append(s)

        keys = collapse([s["key"] for s in steps])
        # map collapsed index back to a representative step for examples
        idx, j = [], 0
        for k in keys:
            idx.append(j)
            base = k.rstrip("+")
            while j < len(steps) and steps[j]["key"] == base:
                j += 1
        for n in (3, 4, 5, 6):
            for i in range(len(keys) - n + 1):
                gram = keys[i:i + n]
                if len(set(g.rstrip("+") for g in gram)) < 2:
                    continue
                if len(set(g.rstrip("+") for g in gram if not GENERIC_STEP.match(g))) < 2:
                    continue
                k = " → ".join(gram)
                q = seqs[k]
                q["n"] += 1
                q["sessions"].add(steps[idx[i]]["sid"])
                q["projects"][steps[idx[i]]["project"]] += 1
                window = steps[idx[i]: idx[i + n - 1] + 1 if i + n - 1 < len(idx) else len(steps)]
                q["err"] += any(w["err"] for w in window)
                q["last"] = max(q["last"], steps[idx[i]]["at"])
                if len(q["examples"]) < 12:
                    q["examples"].append(window[:12])

    def finish(kind, key, v, steps_desc, examples):
        sess = len(v["sessions"])
        return {
            "id": pid(kind, key), "kind": kind, "pattern": key, "steps": steps_desc,
            "count": v["n"], "sessions": sess, "projects": [p for p, _ in v["projects"].most_common(4)],
            "errors": v["err"], "last": v["last"],
            "score": round(sess * math.log2(1 + v["n"]) * (1 + 0.25 * (len(steps_desc) - 2)) * (0.7 if kind == "together" else 1), 2),
            "examples": examples,
        }

    out = []
    for shape, v in chains.items():
        if len(v["sessions"]) < 2 or v["n"] < 3:
            continue
        steps_desc = [t for t in re.split(r"\s+(?:&&|\|\||;|\|)\s+", shape)]
        if len({t.split(" ")[0] for t in steps_desc} - GENERIC) == 0:
            continue
        ex = [{"cmd": e["cmd"], "project": e["project"], "sid": e["sid"], "at": e["at"], "err": e["err"]} for e in v["examples"]]
        out.append(finish("chain", shape, v, steps_desc, ex))

    for k, v in sets.items():
        if len(v["sessions"]) < 2 or v["n"] < 3:
            continue
        ex = [{"cmd": e["cmd"], "project": e["project"], "sid": e["sid"], "at": e["at"], "err": e["err"]} for e in v["examples"]]
        out.append(finish("together", k, v, v["members"], ex))

    seq_rows = []
    for k, v in seqs.items():
        if len(v["sessions"]) < 3 or v["n"] < 4:
            continue
        ex = [[{"tool": w["tool"], "key": w["key"], "cmd": w["cmd"], "arg": w["arg"], "err": w["err"]} for w in win]
              for win in v["examples"][:12]]
        r = finish("sequence", k, v, k.split(" → "), ex)
        r["project_list"] = None
        r["_ex_meta"] = [{"sid": win[0]["sid"], "project": win[0]["project"], "at": win[0]["at"]} for win in v["examples"][:12]]
        seq_rows.append(r)
    # drop sequences contained in a longer one that covers nearly all of their occurrences
    seq_rows.sort(key=lambda r: -len(r["steps"]))
    kept = []
    for r in seq_rows:
        if any(r["pattern"] in k["pattern"] and k["count"] >= 0.8 * r["count"] for k in kept):
            continue
        kept.append(r)
    for r in kept:
        r["examples"] = [{"steps": e, **m} for e, m in zip(r["examples"], r.pop("_ex_meta"))]
        r.pop("project_list", None)
    out.extend(kept)

    out.sort(key=lambda r: -r["score"])
    return {"bash_calls": bash_total, "tool_calls": sum(len(s) for s in streams), "streams": len(streams),
            "total": len(out), "patterns": out[:top]}


def brief(res, examples=3):
    for r in res["patterns"]:
        r["examples"] = r["examples"][:examples]
    return res


if __name__ == "__main__":
    args = sys.argv[1:]
    days = int(args[0]) if args and args[0].isdigit() else 30
    top = int(args[args.index("--top") + 1]) if "--top" in args else 40
    res = mine(collect(days), top=10_000 if "--id" in args else top)
    if "--id" in args:
        want = args[args.index("--id") + 1]
        hit = next((r for r in res["patterns"] if r["id"] == want), None)
        json.dump(hit or {"error": f"no pattern {want} in the last {days} days"}, sys.stdout, indent=1)
    else:
        json.dump(brief(res), sys.stdout)
