"""Central usage event store for the usage-dashboard mod.

One append-only JSONL file per session in the events folder
(default ~/.claude/usage-events/<session-id>.jsonl). Each session writes
only its own file, so concurrent sessions never contend.

  python3 -I events.py emit <dir>              one JSON event on stdin, appended
  python3 -I events.py backfill <dir> <days>   files rebuilt from transcripts
  python3 -I events.py aggregate <dir> <days>  one JSON summary on stdout

Event lines (all carry "v", "t", "sid", "at" in epoch ms):
  start   cwd                                          session began (or mod reloaded)
  turn    agent model ms reason in out cr cw tools toolStats ctxPct ctxTok usd skills skillErrors
  skill   skill path source plugin promptTok          a skill was expanded
  end     reason usd                                   session ended or cleared
Backfilled lines carry "bf": 1 and use:
  prompt                                               a person's prompt
  req     agent model in out cr cw ctx                 one API response
  skill   skill
  tools   stats {name: {n, err}}
"""

import json
import os
import re
import sys
import tempfile
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

SID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
HOME = str(Path.home())


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
    if cwd.startswith(HOME + "/"):
        return "~/" + cwd[len(HOME) + 1 :]
    return cwd


# ---------------------------------------------------------------- emit

def emit(folder):
    ev = json.loads(sys.stdin.read())
    sid = str(ev.get("sid", ""))
    if not SID.match(sid):
        raise SystemExit("bad sid")
    Path(folder).mkdir(parents=True, exist_ok=True)
    line = json.dumps(ev, separators=(",", ":")) + "\n"
    fd = os.open(os.path.join(folder, sid + ".jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, line.encode())
    finally:
        os.close(fd)


# ---------------------------------------------------------------- backfill

def transcript_events(main_file, sub_files):
    """Events for one session from its transcript and its subagents' transcripts."""
    sid = main_file.stem if main_file else sub_files[0].parent.parent.name
    events = []
    seen = set()
    cwd = None
    tools = defaultdict(lambda: {"n": 0, "err": 0})
    names = {}

    def read(path, agent):
        nonlocal cwd
        try:
            fh = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            return
        with fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                at = ms(row.get("timestamp"))
                if at is None:
                    continue
                if cwd is None and row.get("cwd") and agent == "main":
                    cwd = row["cwd"]
                msg = row.get("message") or {}
                kind = row.get("type")
                if kind == "assistant":
                    for b in msg.get("content") or []:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            names[b.get("id")] = b.get("name", "?")
                            tools[b.get("name", "?")]["n"] += 1
                            if b.get("name") == "Skill":
                                skill = (b.get("input") or {}).get("skill")
                                if skill:
                                    events.append({"t": "skill", "at": at, "skill": skill})
                    usage = msg.get("usage")
                    model = msg.get("model") or "?"
                    if not usage or model == "<synthetic>":
                        continue
                    key = (msg.get("id"), row.get("requestId"))
                    if key in seen:
                        continue
                    seen.add(key)
                    t_in = int(usage.get("input_tokens") or 0)
                    t_cr = int(usage.get("cache_read_input_tokens") or 0)
                    t_cw = int(usage.get("cache_creation_input_tokens") or 0)
                    events.append({
                        "t": "req", "at": at, "agent": agent, "model": model,
                        "in": t_in, "out": int(usage.get("output_tokens") or 0), "cr": t_cr, "cw": t_cw,
                        "ctx": t_in + t_cr + t_cw,
                    })
                elif kind == "user":
                    content = msg.get("content")
                    if isinstance(content, list):
                        for b in content:
                            if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                                tools[names.get(b.get("tool_use_id"), "?")]["err"] += 1
                    is_prompt = (
                        agent == "main"
                        and not row.get("isMeta")
                        and not row.get("isSidechain")
                        and (isinstance(content, str) or any(isinstance(b, dict) and b.get("type") == "text" for b in content or []))
                        and not (isinstance(content, str) and content.startswith("<"))
                    )
                    if is_prompt:
                        events.append({"t": "prompt", "at": at})

    if main_file:
        read(main_file, "main")
    for f in sub_files:
        agent = "sub:?"
        meta = f.with_suffix(".meta.json")
        try:
            agent = "sub:" + (json.loads(meta.read_text()).get("agentType") or "?")
        except (OSError, ValueError):
            pass
        read(f, agent)
    if not events:
        return sid, []
    events.sort(key=lambda e: e["at"])
    head = {"t": "start", "at": events[0]["at"], "cwd": cwd or ""}
    tail = {"t": "tools", "at": events[-1]["at"], "stats": dict(tools)}
    out = [head] + events + [tail]
    for e in out:
        e["v"] = 1
        e["sid"] = sid
        e["bf"] = 1
    return sid, out


def is_backfill_only(path):
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"bf":1' not in line:
                    return False
    except OSError:
        return True
    return True


def backfill(folder, days):
    root = Path.home() / ".claude" / "projects"
    since = time.time() - days * 86400
    out_dir = Path(folder)
    out_dir.mkdir(parents=True, exist_ok=True)
    sessions = defaultdict(lambda: {"main": None, "subs": [], "mtime": 0.0})
    for path in root.rglob("*.jsonl"):
        try:
            mt = path.stat().st_mtime
        except OSError:
            continue
        if mt < since:
            continue
        rel = path.relative_to(root).parts
        if "subagents" in rel and len(rel) >= 4:
            key = rel[-3]
            sessions[key]["subs"].append(path)
        elif len(rel) == 2:
            key = path.stem
            sessions[key]["main"] = path
        else:
            continue
        sessions[key]["mtime"] = max(sessions[key]["mtime"], mt)

    written = skipped = 0
    for sid, s in sessions.items():
        if not SID.match(sid):
            continue
        target = out_dir / (sid + ".jsonl")
        if target.exists():
            if not is_backfill_only(target) or target.stat().st_mtime >= s["mtime"]:
                skipped += 1
                continue
        sid, events = transcript_events(s["main"], sorted(s["subs"]))
        if not events:
            continue
        fd, tmp = tempfile.mkstemp(dir=out_dir, prefix=".bf-", suffix=".tmp")
        with os.fdopen(fd, "w") as fh:
            for e in events:
                fh.write(json.dumps(e, separators=(",", ":")) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
        written += 1
    json.dump({"written": written, "skipped": skipped}, sys.stdout)


# ---------------------------------------------------------------- aggregate

def day_of(at):
    return datetime.fromtimestamp(at / 1000).date().isoformat()


def aggregate(folder, days):
    now = time.time()
    since_ms = int((now - days * 86400) * 1000)
    today = datetime.now().date()
    from datetime import timedelta

    day_keys = [(today - timedelta(days=days - 1 - i)).isoformat() for i in range(days)]
    tok0 = lambda: {"in": 0, "out": 0, "cr": 0, "cw": 0}
    hist_days = {k: {**tok0(), "n": 0, "sessions": set(), "models": {}} for k in day_keys}
    models = {}
    projects = {}
    heat = [[0] * 24 for _ in range(7)]
    split = {"main": 0, "sub": 0}
    sessions = {}
    cost_days = defaultdict(float)
    tools_all = {}
    skills_all = {}
    files = 0
    first_at = None

    folder_p = Path(folder)
    paths = sorted(folder_p.glob("*.jsonl")) if folder_p.exists() else []
    for path in paths:
        try:
            if path.stat().st_mtime * 1000 < since_ms:
                continue
        except OSError:
            continue
        files += 1
        sid = path.stem
        s = sessions.setdefault(sid, {
            "id": sid, "cwd": "", "startedAt": None, "lastAt": 0, "usd": 0.0, "turns": 0, "sub": 0, "reqs": 0,
            "tok": tok0(), "models": {}, "tools": 0, "peakCtx": 0, "peakTok": 0, "src": "backfill",
        })
        last_usd = 0.0
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                at = e.get("at") or 0
                t = e.get("t")
                if not e.get("bf"):
                    s["src"] = "live"
                if first_at is None or at < first_at:
                    first_at = at
                if s["startedAt"] is None or at < s["startedAt"]:
                    s["startedAt"] = at
                s["lastAt"] = max(s["lastAt"], at)
                if t == "start":
                    if e.get("cwd") and not s["cwd"]:
                        s["cwd"] = e["cwd"]
                    continue
                if t in ("turn", "end") and isinstance(e.get("usd"), (int, float)):
                    usd = float(e["usd"])
                    if usd > last_usd + 1e-9:
                        if at >= since_ms:
                            cost_days[day_of(at)] += usd - last_usd
                        last_usd = usd
                    s["usd"] = max(s["usd"], usd)
                if t == "prompt":
                    s["turns"] += 1
                    continue
                if t == "skill":
                    name = e.get("skill")
                    if not name:
                        continue
                    k = skills_all.setdefault(name, {
                        "name": name, "source": e.get("source") or "?", "n": 0, "promptTok": 0, "promptN": 0,
                        "turnTok": 0, "out": 0, "ms": 0, "errors": 0, "aborted": 0, "lastAt": 0, "errSamples": [],
                    })
                    k["n"] += 1
                    k["lastAt"] = max(k["lastAt"], at)
                    if e.get("path"):
                        k["path"] = e["path"]
                    if e.get("source"):
                        k["source"] = e["source"]
                    if e.get("plugin"):
                        k["plugin"] = e["plugin"]
                    if e.get("promptTok"):
                        k["promptTok"] += int(e["promptTok"])
                        k["promptN"] += 1
                    continue
                if t == "tools":
                    for name, st in (e.get("stats") or {}).items():
                        a = tools_all.setdefault(name, {"n": 0, "err": 0, "ms": 0, "denied": 0})
                        a["n"] += st.get("n", 0)
                        a["err"] += st.get("err", 0)
                        s["tools"] += st.get("n", 0)
                    continue
                if t not in ("turn", "req"):
                    continue

                agent = e.get("agent") or "main"
                model = e.get("model") or "?"
                tk = {f: int(e.get(f) or 0) for f in ("in", "out", "cr", "cw")}
                total = sum(tk.values())
                for f in tk:
                    s["tok"][f] += tk[f]
                m = s["models"].setdefault(model, {**tok0(), "turns": 0})
                for f in tk:
                    m[f] += tk[f]
                m["turns"] += 1
                if t == "req":
                    s["reqs"] += 1
                    s["peakTok"] = max(s["peakTok"], int(e.get("ctx") or 0))
                    if agent != "main":
                        s["sub"] += 1
                else:
                    if agent == "main":
                        s["turns"] += 1
                    else:
                        s["sub"] += 1
                    s["peakCtx"] = max(s["peakCtx"], int(e.get("ctxPct") or 0))
                    s["peakTok"] = max(s["peakTok"], int(e.get("ctxTok") or 0))
                    s["tools"] += int(e.get("tools") or 0)
                    for name, st in (e.get("toolStats") or {}).items():
                        a = tools_all.setdefault(name, {"n": 0, "err": 0, "ms": 0, "denied": 0})
                        for f in a:
                            a[f] += int(st.get(f, 0))
                    errs = e.get("skillErrors") or []
                    for name in e.get("skills") or []:
                        k = skills_all.get(name)
                        if not k:
                            continue
                        k["turnTok"] += total
                        k["out"] += tk["out"]
                        k["ms"] += int(e.get("ms") or 0)
                        k["errors"] += len(errs)
                        k["aborted"] += 1 if e.get("reason") == "aborted" else 0
                        k["errSamples"] = (list(errs) + k["errSamples"])[:8]

                if at < since_ms:
                    continue
                dk = day_of(at)
                d = hist_days.get(dk)
                if d is None:
                    continue
                for f in tk:
                    d[f] += tk[f]
                d["n"] += 1
                d["sessions"].add(sid)
                dm = d["models"].setdefault(model, {"tok": 0, "out": 0, "n": 0})
                dm["tok"] += total
                dm["out"] += tk["out"]
                dm["n"] += 1
                g = models.setdefault(model, {**tok0(), "n": 0})
                for f in tk:
                    g[f] += tk[f]
                g["n"] += 1
                split["main" if agent == "main" else "sub"] += total
                lt = datetime.fromtimestamp(at / 1000)
                heat[lt.weekday()][lt.hour] += 1
                # project is settled once the session's start is read; fill after the loop
                s.setdefault("_proj", defaultdict(lambda: {**tok0(), "n": 0}))
                p = s["_proj"]["x"]
                for f in tk:
                    p[f] += tk[f]
                p["n"] += 1

    for s in sessions.values():
        proj = s.pop("_proj", None)
        if proj:
            g = projects.setdefault(short(s["cwd"]), {**tok0(), "n": 0})
            for f in ("in", "out", "cr", "cw", "n"):
                g[f] += proj["x"][f]
        s["usd"] = round(s["usd"], 6)
        if s["startedAt"] is None:
            s["startedAt"] = s["lastAt"]

    for k in skills_all.values():
        k["promptTok"] = round(k["promptTok"] / k["promptN"]) if k["promptN"] else 0
        del k["promptN"]

    live = [s for s in sessions.values() if s["lastAt"] >= since_ms and (s["reqs"] or s["turns"] or s["sub"])]
    live.sort(key=lambda s: -s["lastAt"])
    out = {
        "eventsDir": str(folder_p),
        "history": {
            "rangeDays": days,
            "files": files,
            "days": [
                {"date": k, **{f: hist_days[k][f] for f in ("in", "out", "cr", "cw", "n")},
                 "sessions": len(hist_days[k]["sessions"]), "models": hist_days[k]["models"]}
                for k in day_keys
            ],
            "models": [{"name": m, **v} for m, v in models.items()],
            "projects": [{"name": p, **v} for p, v in projects.items()],
            "heat": heat,
            "main": split["main"],
            "sub": split["sub"],
        },
        "sessions": live[:500],
        "costDays": {k: round(v, 6) for k, v in cost_days.items()},
        "toolsAll": tools_all,
        "skillsAll": skills_all,
        "since": first_at or 0,
    }
    json.dump(out, sys.stdout, separators=(",", ":"))


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    cmd, folder = sys.argv[1], sys.argv[2]
    days = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    if cmd == "emit":
        emit(folder)
    elif cmd == "backfill":
        backfill(folder, days)
    elif cmd == "aggregate":
        aggregate(folder, days)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
