"""Every test/check Bash call in Claude Code transcripts, classified.

  python3 -I checks.py [days] > checks.jsonl

One JSON line per call: command, categories (check-change, vitest, npm test, tsc,
npm ci, biome, openspec, audit...), agent type, job number, duration, errors.
"""
import json, re, sys, time
from pathlib import Path
from datetime import datetime

ROOT = Path.home() / ".claude" / "projects"
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 30
since = time.time() - DAYS * 86400

def ms(ts):
    try: return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception: return None

CATS = [
    ("check-change", re.compile(r"check-change\.sh")),
    ("full-tests", re.compile(r"FULL_TESTS=1")),
    ("npm-test", re.compile(r"npm (run )?test(?! *-w)(?!:)|npm t\b")),
    ("ws-test", re.compile(r"npm (run )?test -w|npm run test --workspace")),
    ("vitest", re.compile(r"\bvitest\b")),
    ("typecheck", re.compile(r"npm run typecheck|\btsc\b")),
    ("lint", re.compile(r"\bbiome\b|npm run lint")),
    ("npm-ci", re.compile(r"npm ci\b")),
    ("openspec", re.compile(r"openspec validate")),
    ("audit", re.compile(r"npm audit")),
    ("docs-check", re.compile(r"check-docs-site")),
]
TEST_FILE = re.compile(r"[\w./-]+\.(test|spec)\.[tj]sx?\b|\s-t\s|--testNamePattern|\s[\w./-]+/src/[\w./-]+")
STAGE = re.compile(r"--stage[ =](\w+)|--only[ =]([\w,-]+)")
JOB = re.compile(r"worktrees/(\d{3})|jobs/(\d{3})|factory (?:built|proof|verdict|round) (\d{3})")

def agent_type(path):
    meta = path.with_suffix(".meta.json")
    try: return json.loads(meta.read_text()).get("agentType") or "subagent"
    except Exception: return "subagent"

for path in ROOT.rglob("*.jsonl"):
    try: st = path.stat()
    except OSError: continue
    if st.st_mtime < since: continue
    rel = path.relative_to(ROOT).parts
    if "subagents" in rel and len(rel) >= 4: sid, who = rel[-3], agent_type(path)
    elif len(rel) == 2: sid, who = path.stem, "main"
    else: continue
    pend, resp_end, job_ctx = {}, None, None
    for line in open(path, errors="replace"):
        if '"tool_use"' not in line and '"tool_result"' not in line and '"assistant"' not in line: continue
        try: r = json.loads(line)
        except ValueError: continue
        ts = ms(r.get("timestamp") or "")
        if ts is None: continue
        c = (r.get("message") or {}).get("content")
        if r.get("type") == "assistant": resp_end = ts
        if not isinstance(c, list): continue
        for b in c:
            if not isinstance(b, dict): continue
            if b.get("type") == "tool_use":
                cmd = (b.get("input") or {}).get("command") if b.get("name") == "Bash" else None
                m = JOB.search(json.dumps(b.get("input") or {}))
                if m: job_ctx = next(g for g in m.groups() if g)
                if not cmd: continue
                cats = [n for n, rx in CATS if rx.search(cmd)]
                if not cats: continue
                pend[b["id"]] = {"cmd": cmd, "cats": cats, "who": who, "sid": sid[:8], "cwd": r.get("cwd"),
                                 "job": job_ctx, "bg": bool((b.get("input") or {}).get("run_in_background")),
                                 "timeout": (b.get("input") or {}).get("timeout"),
                                 "targeted": bool(TEST_FILE.search(cmd)),
                                 "stage": ",".join(x for g in STAGE.findall(cmd) for x in g if x) or None}
            elif b.get("type") == "tool_result" and b.get("tool_use_id") in pend:
                p = pend.pop(b["tool_use_id"])
                out = b.get("content")
                out = out if isinstance(out, str) else " ".join(x.get("text", "") for x in out if isinstance(x, dict)) if isinstance(out, list) else ""
                tur = r.get("toolUseResult") if isinstance(r.get("toolUseResult"), dict) else {}
                p.update({"at": resp_end, "ms": ts - (resp_end or ts), "err": bool(b.get("is_error")),
                          "interrupted": bool(tur.get("interrupted")),
                          "timedout": bool(re.search(r"timed out|Command timed out|timeout after", out[-400:], re.I)),
                          "failed_tests": bool(re.search(r"Tests\s+\d+ failed|FAIL\s|✗|error TS\d+|FAIL ", out)),
                          "bg_started": "running in background" in out.lower() or "backgroundTaskId" in json.dumps(tur)[:2000],
                          "out_tail": out[-160:].replace("\n", " | ")})
                p["cmd"] = p["cmd"][:400]
                print(json.dumps(p))
