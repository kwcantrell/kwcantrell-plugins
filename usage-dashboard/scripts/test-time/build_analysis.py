"""Build analysis.json for the Agent Test-Time Analysis dashboard.

  python3 -I build_analysis.py <dir>

Reads <dir>/checks.jsonl (checks.py: every test/check Bash call) and, if present,
<dir>/bench.jsonl (bench.py: each step of npm test / typecheck timed once), plus
timing.py from this plugin (model/tool/you time and polling loops). Writes
<dir>/analysis.json.
"""
import json, re, statistics, sys, collections
from datetime import datetime, timezone
from pathlib import Path

S = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else Path.cwd()
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import timing  # noqa: E402

rows = [json.loads(l) for l in open(S / "checks.jsonl")]
rows = [r for r in rows if 0 <= r["ms"] <= 3600_000]

def kind(r):
    c = r["cats"]
    if "check-change" in c:
        st = r["stage"] or ""
        if "hook" in st and r["ms"] > 10_000: return "check-change.sh --stage hook"
        if not st: return "check-change.sh (all gates)"
        return "check-change.sh file gates only"
    if "full-tests" in c: return "FULL_TESTS=1 (pg + integration)"
    if "npm-test" in c: return "npm test (all workspaces)"
    if "ws-test" in c: return "npm test -w <workspace>"
    if "vitest" in c: return "vitest, named files" if r["targeted"] else "vitest, whole project"
    if "typecheck" in c: return "typecheck / tsc"
    if "npm-ci" in c: return "npm ci"
    if "lint" in c: return "lint (biome)"
    return "other checks (openspec, audit, docs)"

H = lambda ms: round(ms / 3600_000, 2)
kinds = collections.defaultdict(list)
for r in rows: kinds[kind(r)].append(r)
kind_rows = []
for k, v in kinds.items():
    d = sorted(r["ms"] for r in v)
    kind_rows.append({"kind": k, "calls": len(v), "hours": H(sum(d)), "median_s": round(d[len(d) // 2] / 1000, 1),
                      "p90_s": round(d[int(len(d) * .9)] / 1000, 1), "with_failures": sum(r["failed_tests"] for r in v)})
kind_rows.sort(key=lambda r: -r["hours"])

AG = {"factory:builder": "Builder", "factory:verifier": "Verifier", "main": "Main session", "general-purpose": "General-purpose agent",
      "fork": "Forked agent"}
who = collections.defaultdict(lambda: [0, 0])
for r in rows:
    w = AG.get(r["who"], "Reviewers and others")
    who[w][0] += 1; who[w][1] += r["ms"]
who_rows = sorted(({"agent": k, "calls": v[0], "hours": H(v[1])} for k, v in who.items()), key=lambda r: -r["hours"])

jobs = collections.defaultdict(lambda: {"builder_min": 0.0, "builder_hook_runs": 0, "verifier_min": 0.0, "verifier_hook_runs": 0})
for r in rows:
    if r["who"] not in ("factory:builder", "factory:verifier") or not r["job"]: continue
    j = jobs[r["job"]]; p = "builder" if r["who"] == "factory:builder" else "verifier"
    j[f"{p}_min"] += r["ms"] / 60000
    if kind(r) == "check-change.sh --stage hook": j[f"{p}_hook_runs"] += 1
job_rows = [{"job": k, **{a: (round(b, 1) if isinstance(b, float) else b) for a, b in v.items()}} for k, v in sorted(jobs.items())
            if v["builder_min"] + v["verifier_min"] >= 1]
for j in job_rows: j["total_min"] = round(j["builder_min"] + j["verifier_min"], 1)

hook = sorted(r["ms"] / 1000 for r in rows if kind(r) == "check-change.sh --stage hook")
moved = [r for r in rows if 178_000 <= r["ms"] <= 183_000]

sp = timing.collect(30)
summ = timing.summarize(sp, 30)
active_ms = sum(summ[w][k] for w in ("main", "subagents") for k in ("model", "tools", "subagent", "approval"))
def waited(a):
    if re.search(r"check-change|vitest|npm (run )?test|typecheck|tsc|FULL_TESTS|\.output", a): return "Tests and checks"
    if re.search(r"gh (pr|run)|checks", a): return "CI and PR checks"
    if re.search(r"factory|job\.json|proof|verdict", a): return "Factory job state"
    if re.search(r"ssh|curl|docker|compose|deploy|ansible", a): return "Deploys and remote hosts"
    return "Other"
poll = collections.defaultdict(lambda: [0, 0])
for s in sp:
    if s["kind"] == "call" and s["label"] == "polling loop":
        p = poll[waited(s["arg"])]; p[0] += 1; p[1] += s["ms"]
poll_rows = sorted(({"waited_on": k, "loops": v[0], "hours": H(v[1])} for k, v in poll.items()), key=lambda r: -r["hours"])
test_ms = sum(r["ms"] for r in rows)
poll_test = poll["Tests and checks"][1]

bench = []
nproc = None
bench_path = S / "bench.jsonl"
if bench_path.exists():
    for l in open(bench_path):
        b = json.loads(l)
        if "nproc" in b: nproc = b["nproc"]
        if "group" in b: bench.append({"step": {"test": "npm test", "typecheck": "npm run typecheck"}.get(b["group"], b["group"]),
                                       "piece": b["name"], "seconds": b["sec"], "passed": b["rc"] == 0})

doc = {
    "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "summary": [{"range_days": 30, "active_hours": H(active_ms), "test_call_hours": H(test_ms), "test_poll_hours": H(poll_test),
                 "test_hours": H(test_ms + poll_test), "test_share": round((test_ms + poll_test) / active_ms, 3),
                 "test_calls": len(rows), "hook_runs": len(hook), "hook_median_s": round(statistics.median(hook), 0),
                 "moved_to_background": len(moved), "jobs": len(job_rows),
                 "job_median_min": round(statistics.median(j["total_min"] for j in job_rows), 1),
                 "nproc": nproc}],
    "kinds": kind_rows, "who": who_rows, "jobs": job_rows, "polling": poll_rows, "bench": bench,
}
out = S / "analysis.json"
out.write_text(json.dumps(doc, separators=(",", ":")))
print(json.dumps(doc["summary"][0], indent=1), len(bench), "bench rows")
