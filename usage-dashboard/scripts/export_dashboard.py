"""Export the usage-dashboard aggregate as one JSON file for the Claude Code Usage dashboard.

  python3 -I export_dashboard.py <out.json> [days]

Backfills ~/.claude/usage-events from transcripts, runs events.py aggregate, and
reshapes it into flat row tables (daily, models, projects, sessions, tools,
skills, activity, agents). Upload the file to the dashboard's "usage" source.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVENTS = HERE / "events.py"
FOLDER = Path.home() / ".claude" / "usage-events"
HOME = str(Path.home())
DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def run(*args):
    out = subprocess.run([sys.executable, "-I", str(EVENTS), *args], check=True, capture_output=True, text=True)
    return json.loads(out.stdout)


def short(cwd):
    if not cwd:
        return "?"
    if cwd == HOME:
        return "~"
    return "~/" + cwd[len(HOME) + 1:] if cwd.startswith(HOME + "/") else cwd


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if ms else None


def tok(r):
    return {
        "input": r["in"], "output": r["out"], "cache_read": r["cr"], "cache_write": r["cw"],
        "total": r["in"] + r["out"] + r["cr"] + r["cw"],
    }


def build(days=30):
    run("backfill", str(FOLDER), str(days))
    a = run("aggregate", str(FOLDER), str(days))
    h = a["history"]

    daily = [{"date": d["date"], **tok(d), "requests": d["n"], "sessions": d["sessions"]} for d in h["days"]]
    daily_models = [
        {"date": d["date"], "model": m, "tokens": v["tok"], "output": v["out"], "requests": v["n"]}
        for d in h["days"] for m, v in d["models"].items()
    ]
    models = sorted(({"model": m["name"], **tok(m), "requests": m["n"]} for m in h["models"]), key=lambda r: -r["total"])
    projects = sorted(({"project": p["name"], **tok(p), "requests": p["n"]} for p in h["projects"]), key=lambda r: -r["total"])
    sessions = [{
        "session": s["id"][:8], "project": short(s["cwd"]),
        "started": iso(s["startedAt"]), "last_active": iso(s["lastAt"]),
        "prompts": s["turns"], "requests": s["reqs"], "subagent_requests": s["sub"],
        "total_tokens": sum(s["tok"].values()), "output_tokens": s["tok"]["out"],
        "peak_context": s["peakTok"], "tool_calls": s["tools"],
        "models": ", ".join(sorted(s["models"])),
    } for s in a["sessions"]]
    tools = sorted(({"tool": k, "calls": v["n"], "errors": v["err"]} for k, v in a["toolsAll"].items()), key=lambda r: -r["calls"])
    skills = sorted(({"skill": k, "uses": v["n"], "last_used": iso(v["lastAt"])} for k, v in a["skillsAll"].items()), key=lambda r: -r["uses"])
    activity = [{"weekday": DOW[d], "day_index": d, "hour": hr, "requests": h["heat"][d][hr]} for d in range(7) for hr in range(24)]
    agents = [{"agent": "Main session", "tokens": h["main"]}, {"agent": "Subagents", "tokens": h["sub"]}]

    doc = {
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "range_days": days, "since": iso(a["since"]),
        "daily": daily, "daily_models": daily_models, "models": models, "projects": projects,
        "sessions": sessions, "tools": tools, "skills": skills, "activity": activity, "agents": agents,
    }
    return doc


def main():
    out_path = Path(sys.argv[1])
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    doc = build(days)
    sessions = doc["sessions"]
    out_path.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes, {len(sessions)} sessions)")


if __name__ == "__main__":
    main()
