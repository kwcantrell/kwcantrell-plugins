"""Usage: python3 -I browser_login.py {login,status,path} <profile> [url] [--cookie NAME]

Human-in-the-loop sign-in for agent-browser on sites whose login blocks automated
browsers (Google/Microsoft/Apple OAuth, SSO, CAPTCHAs, passkeys).

  login <profile> <url>   Open a plain, NON-automated Chromium window on the persistent
                          profile ~/.agent-browser/profiles/<profile> at <url>. The human
                          signs in and closes the window; the script blocks until then and
                          reports the cookies saved for <url>'s site. --cookie NAME makes a
                          missing or unreadable NAME cookie a failure (exit 1).
  status <profile> <url>  Report the saved cookies for <url>'s site (names, expiry and
                          whether agent-browser can decrypt them; never values). Exit 1 if
                          none, or if --cookie NAME is missing/unreadable.
  path <profile>          Print the profile directory.

agent-browser then reuses the profile:
  agent-browser --session <profile> --profile ~/.agent-browser/profiles/<profile> \\
    --args "--disable-blink-features=AutomationControlled" open <url>

Why the flags: agent-browser launches Chromium with --password-store=basic, so the
profile must be created with it too; otherwise Chromium encrypts cookies with the
desktop keyring ("v11") and agent-browser silently can't read them. Cookies reach
disk only on a clean window close (or Chromium's ~30s flush), never on SIGTERM.
A profile can be open in only one browser at a time.
"""
import argparse
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse

PROFILES = os.path.expanduser(os.environ.get("AGENT_BROWSER_PROFILES", "~/.agent-browser/profiles"))
CONFIG = os.path.expanduser("~/.agent-browser/config.json")
CHROME_EPOCH = 11644473600  # seconds between 1601-01-01 and 1970-01-01


def die(msg, code=1):
    print(f"[browser-login] {msg}", file=sys.stderr)
    sys.exit(code)


def profile_dir(name):
    if not name or "/" in name or name.startswith("."):
        die(f"bad profile name {name!r}: use a short name like 'work-sso'", 2)
    return os.path.join(PROFILES, name)


def chromium():
    path = os.environ.get("CHROMIUM_PATH")
    if not path and os.path.exists(CONFIG):
        try:
            with open(CONFIG) as f:
                path = json.load(f).get("executablePath")
        except (OSError, ValueError):
            pass
    for cand in [path, shutil.which("chromium"), shutil.which("chromium-browser"),
                 "/Applications/Chromium.app/Contents/MacOS/Chromium"]:
        if cand and os.access(cand, os.X_OK):
            return cand
    die("Chromium not found; set CHROMIUM_PATH or run /base-setup:setup agent-browser", 2)


def in_use(pdir):
    """True if a live Chromium holds this profile (SingletonLock -> "<host>-<pid>")."""
    try:
        target = os.readlink(os.path.join(pdir, "SingletonLock"))
    except OSError:
        return False
    host, _, pid = target.rpartition("-")
    if host != socket.gethostname() or not pid.isdigit():
        return True  # another machine, or unknown format: assume busy
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False  # stale lock from a crash
    except PermissionError:
        pass
    return True


def site_matches(host_key, host):
    hk = host_key.lstrip(".")
    return host == hk or host.endswith("." + hk) or hk.endswith("." + host)


def cookies(pdir, url):
    db = os.path.join(pdir, "Default", "Cookies")
    if not os.path.exists(db):
        return []
    host = urlparse(url if "//" in url else "https://" + url).hostname or url
    # Copy so we never contend with a running browser's lock.
    with tempfile.TemporaryDirectory() as tmp:
        copy = os.path.join(tmp, "Cookies")
        shutil.copy2(db, copy)
        rows = sqlite3.connect(copy).execute(
            "select host_key, name, substr(encrypted_value,1,3), length(value), expires_utc from cookies"
        ).fetchall()
    out = []
    for host_key, name, prefix, plain_len, expires in rows:
        if not site_matches(host_key, host):
            continue
        if prefix == b"v10" or (not prefix and plain_len):
            readable = True
        else:
            readable = False  # v11 = keyring-encrypted: agent-browser can't decrypt
        exp = "session" if not expires else time.strftime(
            "%Y-%m-%d", time.gmtime(expires / 1e6 - CHROME_EPOCH))
        out.append({"domain": host_key, "name": name, "expires": exp, "readable": readable})
    return out


def report(pdir, url, want):
    rows = cookies(pdir, url)
    for r in rows:
        flag = "" if r["readable"] else "  UNREADABLE by agent-browser (keyring-encrypted)"
        print(f"  {r['domain']:<28} {r['name']:<32} expires {r['expires']}{flag}")
    if not rows:
        print("  (no cookies saved for this site; if the profile was made outside this script, "
              "Chromium drops keyring-encrypted cookies it can't read: run login again)")
    if want:
        hit = [r for r in rows if r["name"] == want]
        if not hit:
            die(f"cookie {want!r} not saved: sign-in not completed, or the window was killed instead of closed")
        if not all(r["readable"] for r in hit):
            die(f"cookie {want!r} is keyring-encrypted; recreate the profile with this script")
        if any(r["expires"] == "session" for r in hit):
            print(f"[browser-login] note: {want!r} is a session cookie; Chromium won't restore it on relaunch")
    elif not rows:
        sys.exit(1)
    if any(not r["readable"] for r in rows):
        sys.exit(1)


def login(args):
    pdir = profile_dir(args.profile)
    if in_use(pdir):
        die(f"profile {args.profile!r} is open in another browser; close it first "
            f"(agent-browser --session {args.profile} close)")
    os.makedirs(pdir, exist_ok=True)
    for f in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        try:
            os.unlink(os.path.join(pdir, f))
        except FileNotFoundError:
            pass
    print(f"[browser-login] Sign in at {args.url} in the window that opened, "
          "then CLOSE THE WINDOW normally (not Ctrl-C).", flush=True)
    subprocess.run([chromium(), f"--user-data-dir={pdir}", "--password-store=basic",
                    "--no-first-run", "--no-default-browser-check", args.url],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # The wrapper may exit before the browser finishes writing; wait for release.
    for _ in range(30):
        if not in_use(pdir):
            break
        time.sleep(1)
    print(f"[browser-login] window closed; cookies saved in {pdir}:")
    report(pdir, args.url, args.cookie)
    print(f"[browser-login] OK. Use: agent-browser --session {args.profile} --profile {pdir} "
          '--args "--disable-blink-features=AutomationControlled" open ' + args.url)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("cmd", choices=["login", "status", "path"])
    p.add_argument("profile")
    p.add_argument("url", nargs="?")
    p.add_argument("--cookie", help="session cookie name that must be saved and readable")
    args = p.parse_args()
    if args.cmd == "path":
        print(profile_dir(args.profile))
    elif not args.url:
        die(f"{args.cmd} needs a url", 2)
    elif args.cmd == "login":
        login(args)
    else:
        pdir = profile_dir(args.profile)
        if not os.path.isdir(pdir):
            die(f"no profile {args.profile!r} yet; run login first")
        report(pdir, args.url, args.cookie)


if __name__ == "__main__":
    main()
