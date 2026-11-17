"""Claude Code status line. Usage: python3 -I statusline.py  (session JSON on stdin)

Prints one line: model | dir | git branch (* if dirty) | context used % | session cost.
Fields missing from the input are left out rather than shown as blanks.
"""
import json
import os
import subprocess
import sys

DIM, CYAN, GREEN, YELLOW, RED, RESET = "\033[2m", "\033[36m", "\033[32m", "\033[33m", "\033[31m", "\033[0m"


def git(cwd, *args):
    try:
        out = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=1)
        return out.stdout.strip() if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        data = {}

    parts = []
    model = (data.get("model") or {}).get("display_name")
    if model:
        parts.append(CYAN + model + RESET)

    cwd = (data.get("workspace") or {}).get("current_dir") or data.get("cwd") or os.getcwd()
    home = os.path.expanduser("~")
    parts.append(("~" + cwd[len(home):]) if cwd.startswith(home) else cwd)

    branch = git(cwd, "branch", "--show-current") or git(cwd, "rev-parse", "--short", "HEAD")
    if branch:
        dirty = git(cwd, "status", "--porcelain", "--untracked-files=no")
        parts.append(GREEN + branch + (YELLOW + "*" if dirty else "") + RESET)

    used = (data.get("context_window") or {}).get("used_percentage")
    if isinstance(used, (int, float)):
        color = RED if used >= 80 else YELLOW if used >= 50 else GREEN
        parts.append(f"ctx {color}{used:.0f}%{RESET}")

    cost = (data.get("cost") or {}).get("total_cost_usd")
    if isinstance(cost, (int, float)):
        parts.append(f"${cost:.2f}")

    print((DIM + " | " + RESET).join(parts))


if __name__ == "__main__":
    main()
