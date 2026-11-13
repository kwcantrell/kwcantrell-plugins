#!/usr/bin/env bash
# Rebuild the Agent Test-Time Analysis data.
#   run.sh <repo> <out-dir> [days] [--no-bench]
# Writes <out-dir>/checks.jsonl, bench.jsonl (unless --no-bench) and analysis.json.
# Upload analysis.json to the dashboard and point its datasets at the new file.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$1; out=$2; days=${3:-30}
mkdir -p "$out"
python3 -I "$here/checks.py" "$days" > "$out/checks.jsonl"
if [[ " $* " != *" --no-bench "* ]]; then
  (cd "$repo" && npm ci --no-audit --no-fund >/dev/null)
  python3 -I "$here/bench.py" "$repo" "$out/bench.jsonl"
fi
python3 -I "$here/build_analysis.py" "$out"
