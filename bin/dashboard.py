#!/usr/bin/env python3
"""Autonomy control-room -- P1 read-only page server.

A single self-contained local page. Stdlib only (http.server + SSE), no build
step, no heavy deps -- matches the engine's no-dependency posture. Binds
127.0.0.1 ONLY: this is a single-operator local tool, never exposed. It reads
the engine's already-emitted artifacts (session logs, supervisor.log, git/gh,
config) and renders them; it has NO controls (that is P2, issue #10) and never
writes to any target repo.

Usage:
  bin/dashboard.py --repo <path> [--repo <path> ...] [--port 8787]

Repos may also be listed (one path per line) in $AUTONOMY_DASHBOARD_REPOS or
~/.config/autonomy/repos, so P2 can manage the set without a restart.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ENGINE_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ENGINE_HOME, "lib"))
import dashboard_state as ds  # noqa: E402

PAGE = os.path.join(ENGINE_HOME, "lib", "dashboard_page.html")
REPOS_FILE = os.path.expanduser("~/.config/autonomy/repos")

# gh is network + slow; cache its result per repo so SSE ticks don't hammer it.
_GH_TTL = 15.0
_gh_cache = {}

# Throughput-over-time: a background thread samples each repo's cumulative
# output-token counter on a fixed wall-clock tick, so the page can draw a
# real activity-over-time graph that FLATLINES when the agent is idle (rate =
# delta-tokens / delta-time). This is the honest source -- stream-json carries
# no per-line timestamps, so wall-clock sampling on our side is how "over time"
# becomes real rather than invented.
_SAMPLE_EVERY = 12.0      # seconds between samples
_WINDOW = 3600            # keep last hour
_hist = {}               # repo_path -> list[[epoch, cumulative_output_tokens]]
_hist_lock = threading.Lock()


def _sample_once(repos):
    now = int(time.time())
    for repo in repos:
        tok = 0
        try:
            logdir = os.path.join(repo, "var", "autonomy-logs")
            latest = ds._latest_session(logdir)
            if latest:
                s = ds.parse_session_log(latest)
                tok = (s or {}).get("output_tokens", 0) or 0
        except Exception:
            tok = 0
        with _hist_lock:
            buf = _hist.setdefault(repo, [])
            buf.append([now, tok])
            cutoff = now - _WINDOW
            while buf and buf[0][0] < cutoff:
                buf.pop(0)


def _sampler_loop(repos, stop):
    while not stop.is_set():
        _sample_once(repos)
        stop.wait(_SAMPLE_EVERY)


def _throughput(repo):
    with _hist_lock:
        return list(_hist.get(repo, []))


def _run(args, cwd=None, timeout=12):
    try:
        out = subprocess.run(args, cwd=cwd, timeout=timeout,
                             capture_output=True, text=True)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip()


def git_in_flight(repo):
    """The 'what's in motion' board for one repo: branch/HEAD + open PRs with
    CI + review + mergeable state. Best-effort: any failure -> partial/empty,
    never raises (a gh/git hiccup must not blank the whole page)."""
    now = time.time()
    cached = _gh_cache.get(repo)
    if cached and now - cached[0] < _GH_TTL:
        return cached[1]

    head = _run(["git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])
    sha = _run(["git", "-C", repo, "rev-parse", "--short", "HEAD"])
    if head == "HEAD":  # detached (the supervisor runs detached on origin/main)
        head = "detached@" + (sha or "?")
    dirty = _run(["git", "-C", repo, "status", "--porcelain"])
    repo_url = _run(["gh", "repo", "view", "--json", "url", "--jq", ".url"], cwd=repo, timeout=15) or ""

    prs = []
    raw = _run(["gh", "pr", "list", "--state", "open", "--limit", "20", "--json",
                "number,title,headRefName,isDraft,mergeable,reviewDecision,statusCheckRollup,url,updatedAt",
                "--jq", "sort_by(.updatedAt) | reverse"],
               cwd=repo, timeout=20)
    if raw:
        try:
            for pr in json.loads(raw):
                rollup = pr.get("statusCheckRollup") or []
                states = [c.get("conclusion") or c.get("state") or "" for c in rollup]
                if any(s in ("FAILURE", "ERROR", "CANCELLED") for s in states):
                    ci = "failing"
                elif any(s in ("", "PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED") for s in states):
                    ci = "pending"
                elif states:
                    ci = "passing"
                else:
                    ci = "none"
                prs.append({
                    "number": pr.get("number"),
                    "title": pr.get("title") or "",
                    "branch": pr.get("headRefName") or "",
                    "url": pr.get("url") or "",
                    "draft": bool(pr.get("isDraft")),
                    "mergeable": (pr.get("mergeable") or "").lower(),
                    "review": (pr.get("reviewDecision") or "").lower(),
                    "ci": ci,
                })
        except ValueError:
            pass

    # the "in flight" ticket the focus card highlights = the most-recently-updated open PR
    focus = None
    if prs:
        top = prs[0]
        focus = {"number": top["number"], "title": top["title"], "url": top["url"],
                 "ci": top["ci"], "review": top["review"]}

    # recently completed tickets (merged PRs) -- ref + link, so the operator sees
    # what the loop finished, not just what's open.
    merged = []
    mraw = _run(["gh", "pr", "list", "--state", "merged", "--limit", "6", "--json",
                 "number,title,url,mergedAt", "--jq", "sort_by(.mergedAt) | reverse"],
                cwd=repo, timeout=20)
    if mraw:
        try:
            for pr in json.loads(mraw):
                merged.append({"number": pr.get("number"), "title": pr.get("title") or "",
                               "url": pr.get("url") or "", "at": pr.get("mergedAt") or ""})
        except ValueError:
            pass

    result = {
        "branch": head or "?",
        "sha": sha or "",
        "dirty": bool(dirty),
        "repo_url": repo_url,
        "prs": prs,
        "merged": merged,
        "focus_ticket": focus,
    }
    _gh_cache[repo] = (now, result)
    return result


def discover_repos(cli_repos):
    """CLI --repo wins; else env list; else ~/.config/autonomy/repos."""
    if cli_repos:
        repos = list(cli_repos)
    else:
        env = os.environ.get("AUTONOMY_DASHBOARD_REPOS", "")
        text = env
        if not text and os.path.exists(REPOS_FILE):
            with open(REPOS_FILE) as fh:
                text = fh.read()
        repos = [ln.strip() for ln in text.splitlines() if ln.strip()]
    seen = []
    for r in repos:
        p = os.path.abspath(os.path.expanduser(r))
        if p not in seen:
            seen.append(p)
    return seen


def collect(repos):
    """Full app snapshot the page renders."""
    out = []
    for repo in repos:
        if not os.path.isdir(repo):
            out.append({"name": os.path.basename(repo.rstrip("/")), "path": repo,
                        "lifecycle": {"state": "missing", "pid": None},
                        "current_session": None, "voice": [], "git": {},
                        "config": {}, "reset_epoch": None})
            continue
        try:
            st = ds.build_repo_state(repo, git_in_flight=git_in_flight)
            st["throughput"] = _throughput(repo)
            out.append(st)
        except Exception as exc:  # never let one repo blank the page
            out.append({"name": os.path.basename(repo.rstrip("/")), "path": repo,
                        "lifecycle": {"state": "error", "pid": None},
                        "error": str(exc), "current_session": None, "voice": [],
                        "git": {}, "config": {}, "reset_epoch": None})
    return {"generated_at": int(time.time()), "repos": out}


class Handler(BaseHTTPRequestHandler):
    server_version = "autonomy-dashboard/1.0"
    repos = []

    def log_message(self, *a):  # quiet; the page is the UI, not the console
        pass

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            try:
                with open(PAGE, "rb") as fh:
                    self._send(200, fh.read(), "text/html; charset=utf-8")
            except OSError:
                self._send(500, b"dashboard_page.html missing", "text/plain")
        elif path == "/api/state":
            self._send(200, json.dumps(collect(self.repos)).encode("utf-8"))
        elif path == "/api/stream":
            self._stream()
        else:
            self._send(404, b'{"error":"not found"}')

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                payload = json.dumps(collect(self.repos))
                self.wfile.write(b"data: " + payload.encode("utf-8") + b"\n\n")
                self.wfile.flush()
                time.sleep(2.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return  # client navigated away


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", action="append", default=[], dest="repos")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")  # localhost-only, not overridable to 0.0.0.0 in practice
    args = ap.parse_args(argv)

    repos = discover_repos(args.repos)
    if not repos:
        sys.stderr.write("dashboard: no repos. Pass --repo <path> (repeatable) "
                         "or list them in ~/.config/autonomy/repos\n")
        return 2
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        sys.stderr.write("dashboard: refusing non-localhost host %r (this is a "
                         "local-only tool)\n" % args.host)
        return 2

    Handler.repos = repos
    # seed one sample immediately so the graph isn't empty on first paint, then
    # start the always-on sampler thread (throughput-over-time source).
    _sample_once(repos)
    stop = threading.Event()
    sampler = threading.Thread(target=_sampler_loop, args=(repos, stop), daemon=True)
    sampler.start()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = "http://%s:%d/" % (args.host, args.port)
    sys.stderr.write("autonomy control-room on %s  (%d repo%s)\n"
                     % (url, len(repos), "" if len(repos) == 1 else "s"))
    for r in repos:
        sys.stderr.write("  - %s\n" % r)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
