"""Time each step of a repo's `npm test` and `npm run typecheck`, one at a time.

  python3 -I bench.py <repo> [out.jsonl]

Reads scripts.test and scripts.typecheck from <repo>/package.json, splits them on
' && ' and times each step on its own, so you can see what a sequential run spends
its time on. Prints JSON lines: {"nproc"}, then {"group","name","sec","rc"} per step.
Run `npm ci` first: stale node_modules make steps fail early and look fast.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

repo = Path(sys.argv[1]).expanduser().resolve()
out = open(sys.argv[2], "w") if len(sys.argv) > 2 else sys.stdout
scripts = json.loads((repo / "package.json").read_text()).get("scripts", {})


def emit(d):
    out.write(json.dumps(d) + "\n")
    out.flush()


def name(step):
    m = re.search(r"(?:-w|--workspace)[ =](\S+)", step) or (re.search(r"-p (\S+)", step) if "tsc" in step else None)
    return m.group(1) if m else step.split()[0] if step.split()[0] not in ("npm", "npx") else " ".join(step.split()[:3])


emit({"nproc": os.cpu_count()})
for group in ("test", "typecheck"):
    for step in [s.strip() for s in (scripts.get(group) or "").split("&&") if s.strip()]:
        t = time.monotonic()
        rc = subprocess.run(step, shell=True, cwd=repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
        emit({"group": group, "name": name(step), "sec": round(time.monotonic() - t, 2), "rc": rc})
