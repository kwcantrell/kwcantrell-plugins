"""Where the time goes: model time vs tool time, from Claude Code transcripts.

  python3 -I timing.py [days]      JSON on stdout

Each transcript (main session or subagent) is walked in order:

  model     an `api-request` row (request sent) to the last assistant row of that
            response. Without an api-request row, from the previous user/tool_result row.
  tools     end of the response to the last tool_result of its tool calls (wall clock;
            parallel calls overlap, so per-tool totals can add up to more).
  subagent  the same span when the batch includes an Agent call (main session only;
            the subagent's own model/tool time is reported under "subagents").
  approval  the same span when a call waited for a person's permission decision
            (permissionDecision.source user_*): time spent waiting on you.

Not measured: the main session's wait for background (async) subagents and tasks.
Those return at once and report back later as a new message, so their time shows
under "subagents" instead. turn_duration rows are not used: one can span several
prompts and queued notifications, so they overlap.

Spans over 30 minutes are dropped as idle or broken. Parsed files are cached by
(mtime, size) when imported by the server.
"""

import json
import re
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bash_commands import short  # noqa: E402
from patterns import GENERIC, bash_shape  # noqa: E402

ROOT = Path.home() / ".claude" / "projects"
CAP_MS = 30 * 60 * 1000
_cache = {}


def ms(ts):
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError):
        return None


def label(name, inp):
    if name == "Bash":
        cmd = inp.get("command") or ""
        if re.search(r"\b(until|while)\b[\s\S]*\bsleep\b", cmd):
            return "polling loop"
        if inp.get("run_in_background"):
            return "background: " + (label("Bash", {"command": cmd}) if cmd else "?")
        _, progs = bash_shape(cmd)
        main = list(dict.fromkeys(p for p in progs if p.split(" ")[0] not in GENERIC))
        if main:
            return " + ".join(main[:3]) + (" + …" if len(main) > 3 else "")
        return "script" if any(p in ("python3", "python", "node") for p in progs) else "shell utils"
    if name == "Agent":
        return inp.get("subagent_type") or "general-purpose"
    if name == "Skill":
        return inp.get("skill") or "?"
    return ""


def arg(name, inp):
    if name == "Bash":
        return (inp.get("command") or "")[:200]
    return (inp.get("description") or inp.get("file_path") or inp.get("pattern") or inp.get("url")
            or inp.get("query") or inp.get("skill") or "")[:200]


def parse(path, agent, sid):
    """Spans from one transcript: [{kind, at, ms, ...}]."""
    spans = []
    req_start = None   # last api-request ts
    prev_ts = None     # last user/tool_result ts (fallback request start)
    resp = None        # open response {start, end, tools: {id: {...}}}
    batch = None       # tool calls waiting on results {end, calls, left, last, approval, agent}
    cwd = None

    def close_resp():
        nonlocal resp, batch
        if not resp:
            return
        d = resp["end"] - resp["start"]
        if 0 <= d <= CAP_MS:
            spans.append({"kind": "model", "at": resp["start"], "ms": d, "thinking": resp["thinking"],
                          "toolInput": resp["tin"], "agent": agent, "sid": sid, "project": cwd})
        if resp["tools"]:
            batch = {"end": resp["end"], "calls": resp["tools"], "left": set(resp["tools"]), "last": resp["end"],
                     "approval": False, "hasAgent": any(c["tool"] == "Agent" for c in resp["tools"].values())}
        resp = None

    def close_batch():
        nonlocal batch
        if not batch:
            return
        wall = batch["last"] - batch["end"]
        if 0 <= wall <= CAP_MS and batch["last"] > batch["end"]:
            kind = "approval" if batch["approval"] else "subagent" if (batch["hasAgent"] and agent == "main") else "tools"
            spans.append({"kind": kind, "at": batch["end"], "ms": wall, "agent": agent, "sid": sid, "project": cwd})
        batch = None

    try:
        fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return spans
    with fh:
        for line in fh:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            t = row.get("type")
            ts = ms(row.get("timestamp"))
            if row.get("cwd") and not cwd:
                cwd = short(row["cwd"])
            if ts is None:
                continue
            if t == "api-request":
                close_resp()
                close_batch()
                req_start = ts
                continue
            if t == "assistant":
                msg = row.get("message") or {}
                if resp is None:
                    close_batch()
                    start = req_start if req_start is not None else prev_ts
                    resp = {"start": start if start is not None else ts, "end": ts, "tools": {}, "thinking": 0, "tin": 0}
                    req_start = None
                resp["end"] = max(resp["end"], ts)
                resp["thinking"] += int(row.get("thinkingDurationMs") or 0)
                resp["tin"] += int(row.get("toolInputStreamMs") or 0)
                for b in msg.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        inp = b.get("input") or {}
                        name = b.get("name") or "?"
                        resp["tools"][b.get("id")] = {"tool": name, "label": label(name, inp), "arg": arg(name, inp)}
                continue
            if t == "user":
                close_resp()
                content = (row.get("message") or {}).get("content")
                results = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_result"] if isinstance(content, list) else []
                pd = row.get("permissionDecision") or {}
                asked = str(pd.get("source") or "").startswith("user")
                for b in results:
                    if not batch:
                        break
                    c = batch["calls"].get(b.get("tool_use_id"))
                    if not c:
                        continue
                    d = ts - batch["end"]
                    if 0 <= d <= CAP_MS:
                        spans.append({"kind": "call", "at": batch["end"], "ms": d, "tool": c["tool"], "label": c["label"],
                                      "arg": c["arg"], "asked": asked, "err": bool(b.get("is_error")),
                                      "agent": agent, "sid": sid, "project": cwd})
                    batch["left"].discard(b.get("tool_use_id"))
                    batch["last"] = max(batch["last"], ts)
                    batch["approval"] |= asked
                if batch and not batch["left"]:
                    close_batch()
                prev_ts = ts
        close_resp()
        close_batch()
    return spans


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
            hit = (st.st_mtime, st.st_size, parse(path, agent, sid[:8]))
            _cache[path] = hit
        out.extend(s for s in hit[2] if s["at"] >= since_ms)
    for p in [p for p in _cache if p not in seen]:
        del _cache[p]
    return out


def pct(vals, q):
    if not vals:
        return 0
    vals = sorted(vals)
    return vals[min(len(vals) - 1, int(q * (len(vals) - 1) + 0.5))]


def summarize(spans, days):
    day_keys = []
    today = datetime.now().date()
    from datetime import timedelta
    day_keys = [(today - timedelta(days=days - 1 - i)).isoformat() for i in range(days)]
    blank = lambda: {"model": 0, "thinking": 0, "tools": 0, "subagent": 0, "approval": 0, "turn": 0, "turns": 0}
    who = {"main": blank(), "subagent": blank()}
    daily = {k: blank() for k in day_keys}
    tools = defaultdict(list)
    tool_meta = {}
    slow = []
    for s in spans:
        a = who[s["agent"]]
        k = s["kind"]
        dk = datetime.fromtimestamp(s["at"] / 1000).date().isoformat()
        d = daily.get(dk)
        if k == "model":
            a["model"] += s["ms"]
            a["thinking"] += s["thinking"]
            if d is not None and s["agent"] == "main":
                d["model"] += s["ms"]
        elif k in ("tools", "subagent", "approval"):
            a[k] += s["ms"]
            if d is not None and s["agent"] == "main":
                d[k] += s["ms"]
        elif k == "turn":
            a["turn"] += s["ms"]
            a["turns"] += 1
            if d is not None and s["agent"] == "main":
                d["turn"] += s["ms"]
                d["turns"] += 1
        elif k == "call":
            key = (s["tool"], s["label"] if s["tool"] in ("Bash", "Agent") else "")
            tools[key].append(s["ms"])
            m = tool_meta.setdefault(key, {"asked": 0, "errors": 0, "asked_ms": 0, "sub": 0})
            m["asked"] += s["asked"]
            m["asked_ms"] += s["ms"] if s["asked"] else 0
            m["errors"] += s["err"]
            m["sub"] += s["agent"] == "subagent"
            slow.append(s)
    tool_rows = []
    for (tool, lab), v in tools.items():
        m = tool_meta[(tool, lab)]
        tool_rows.append({"tool": tool, "label": lab, "calls": len(v), "total_ms": sum(v), "p50_ms": pct(v, .5),
                          "p90_ms": pct(v, .9), "max_ms": max(v), "asked": m["asked"], "asked_ms": m["asked_ms"],
                          "errors": m["errors"], "by_subagents": m["sub"]})
    tool_rows.sort(key=lambda r: -r["total_ms"])
    slow.sort(key=lambda s: -s["ms"])
    return {
        "range_days": days,
        "main": who["main"], "subagents": who["subagent"],
        "daily": [{"date": k, **daily[k]} for k in day_keys],
        "tools": tool_rows[:200],
        "slowest": [{k: s[k] for k in ("at", "ms", "tool", "label", "arg", "asked", "err", "agent", "sid", "project")} for s in slow[:50]],
    }


if __name__ == "__main__":
    d = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    json.dump(summarize(collect(d), d), sys.stdout)
