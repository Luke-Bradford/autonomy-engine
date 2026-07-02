#!/usr/bin/env python3
"""Autonomy control-room -- P1 read-only page server.

A single self-contained local page. Stdlib only (http.server + SSE), no build
step, no heavy deps -- matches the engine's no-dependency posture. Binds
127.0.0.1 ONLY: this is a single-operator local tool, never exposed. It reads
the engine's already-emitted artifacts (session logs, supervisor.log, git/gh,
config) and renders them.

Lifecycle controls (#10) are LIFECYCLE ONLY -- start / graceful-stop (PAUSE
sentinel) / hard-stop (launchctl) / resume -- behind POST /api/control, which
requires a per-process token embedded in the served page (defeats cross-origin/
DNS-rebinding drive-by) and only ever acts on a repo this dashboard manages. It
never touches any target repo's trade/order/position path.

Usage:
  bin/dashboard.py --repo <path> [--repo <path> ...] [--port 8787]

Repos may also be listed (one path per line) in $AUTONOMY_DASHBOARD_REPOS or
~/.config/autonomy/repos, so P2 can manage the set without a restart.
"""
import argparse
import json
import os
import secrets
import stat
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ENGINE_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ENGINE_HOME, "lib"))
import dashboard_state as ds  # noqa: E402
import dashboard_control as dcx  # noqa: E402
import config_parser  # noqa: E402
import credentials as creds  # noqa: E402
import accounts as accts  # noqa: E402

PAGE = os.path.join(ENGINE_HOME, "lib", "dashboard_page.html")
CONFIG_PAGE = os.path.join(ENGINE_HOME, "lib", "config_page.html")
REPOS_FILE = os.path.expanduser("~/.config/autonomy/repos")
LAUNCH_AGENTS = os.path.expanduser("~/Library/LaunchAgents")

# The four standard roles a credential can be assigned to (#51). Custom roles
# in a repo's config still get a credential via config, but the page offers
# the built-ins as assignment targets.
_ASSIGNABLE_ROLES = ("coder", "pm", "qa", "researcher")

# Per-process control token for the lifecycle write endpoint (#10). Embedded in
# the served page (same-origin) and required on every POST /api/control, so a
# cross-origin/DNS-rebinding page in the browser can't drive controls -- it
# can't read our token. Regenerated each launch.
_CONTROL_TOKEN = secrets.token_urlsafe(24)

# gh is network + slow; cache its result per repo so SSE ticks don't hammer it.
# Read/written from per-request SSE threads, so guard it (like _hist).
_GH_TTL = 15.0
_gh_cache = {}
_gh_lock = threading.Lock()

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
# per-repo incremental cursor so we read only bytes appended since last sample,
# never the whole (growing) log again -- O(new bytes)/tick, not O(filesize).
# Touched only by the single sampler thread (via _sample_once), so no lock.
_cursor = {}             # repo_path -> {"path", "offset", "sum"}


def _session_output_tokens(repo):
    """Cumulative streamed output tokens of the repo's newest session, read
    incrementally from the last byte offset. Resets when the session rolls over
    or the file is truncated. Only whole (newline-terminated) lines are counted,
    so a half-written tail line is picked up on the next tick."""
    logdir = os.path.join(repo, "var", "autonomy-logs")
    latest = ds.latest_session(logdir)
    st = _cursor.get(repo)
    if latest is None:
        return st["sum"] if st else 0
    if st is None or st["path"] != latest:
        st = {"path": latest, "offset": 0, "sum": 0}
        _cursor[repo] = st
    try:
        size = os.path.getsize(latest)
    except OSError:
        return st["sum"]
    if size < st["offset"]:            # truncated/rotated -> restart the count
        st["offset"], st["sum"] = 0, 0
    if size == st["offset"]:           # nothing new -> no read at all
        return st["sum"]
    try:
        with open(latest, "rb") as fh:
            fh.seek(st["offset"])
            data = fh.read()
    except OSError:
        return st["sum"]
    nl = data.rfind(b"\n")
    if nl < 0:                          # no complete new line yet
        return st["sum"]
    chunk = data[:nl + 1]
    st["offset"] += len(chunk)
    for raw in chunk.split(b"\n"):
        if b'"output_tokens"' not in raw:
            continue
        try:
            o = json.loads(raw)
        except ValueError:
            continue
        if o.get("type") == "assistant":
            usage = (o.get("message") or {}).get("usage") or {}
            st["sum"] += usage.get("output_tokens") or 0
    return st["sum"]


def _sample_once(repos):
    now = int(time.time())
    for repo in repos:
        try:
            tok = _session_output_tokens(repo)
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
    # errors="replace": non-UTF8 bytes in git/gh output (e.g. a garbled commit
    # message) must not raise UnicodeDecodeError -- best-effort, never blank the
    # page. text+errors decodes leniently instead.
    try:
        out = subprocess.run(args, cwd=cwd, timeout=timeout,
                             capture_output=True, text=True, errors="replace")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip()


def git_in_flight(repo):
    """The 'what's in motion' board for one repo: branch/HEAD + open PRs with
    CI + review + mergeable state. Best-effort: any failure -> partial/empty,
    never raises (a gh/git hiccup must not blank the whole page)."""
    now = time.time()
    with _gh_lock:
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
                # the QA gate's own verdict (#18) is its own lane chip -- pull
                # it out so it doesn't double-count as third-party CI
                states = []
                qa = "none"
                for c in rollup:
                    nm = c.get("name") or c.get("context") or ""
                    s = c.get("conclusion") or c.get("state") or ""
                    if nm == "qa-gate":
                        qa = {"SUCCESS": "passing", "FAILURE": "failing",
                              "ERROR": "failing", "CANCELLED": "failing",
                              "TIMED_OUT": "failing"}.get(str(s).upper(), "pending")
                        continue
                    states.append(s)
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
                    "qa": qa,
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
                 "number,title,url,mergedAt,headRefName", "--jq", "sort_by(.mergedAt) | reverse"],
                cwd=repo, timeout=20)
    if mraw:
        try:
            for pr in json.loads(mraw):
                at = pr.get("mergedAt") or ""
                merged.append({"number": pr.get("number"), "title": pr.get("title") or "",
                               "url": pr.get("url") or "", "at": at,
                               "merged_epoch": ds.iso_epoch(at),
                               "branch": pr.get("headRefName") or ""})
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
    with _gh_lock:
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


# Bound concurrent SSE streams and give each a send timeout, so a client that
# vanishes without a clean TCP close (laptop sleep, network change) can't leak
# its thread indefinitely -- a stalled write times out and the thread exits.
_SSE_MAX = 12
_SSE_TIMEOUT = 30
_sse_lock = threading.Lock()
_sse_active = [0]

# account_usage scans ~1000 JSONL files -- cache it (it changes slowly).
_ACCT_TTL = 45.0
_acct_cache = [0.0, None]
_acct_lock = threading.Lock()
# (repo, number) -> (epoch, {title,url,state}). Locked like every other cache
# here: collect() runs on a thread per request/SSE stream, and the eviction's
# next(iter(...))/pop must not race concurrent inserts (#31).
_issue_cache = {}
_issue_lock = threading.Lock()


def _account_usage():
    now = time.time()
    with _acct_lock:
        if _acct_cache[1] is not None and now - _acct_cache[0] < _ACCT_TTL:
            return _acct_cache[1]
    try:
        usage = ds.account_usage()
    except Exception:
        usage = {"five_hour": {"sessions": 0, "tokens": 0},
                 "seven_day": {"sessions": 0, "tokens": 0}}
    try:
        usage["codex"] = ds.codex_usage(now=now)   # #49: same TTL cache
    except Exception:
        usage["codex"] = {"available": False}
    with _acct_lock:
        _acct_cache[0], _acct_cache[1] = now, usage
    return usage


_creds_singleton = [None]


def _creds():
    if _creds_singleton[0] is None:
        _creds_singleton[0] = creds.Credentials()
    return _creds_singleton[0]


_accts_singleton = [None]


def _accts():
    if _accts_singleton[0] is None:
        _accts_singleton[0] = accts.Accounts()
    return _accts_singleton[0]


def execute_acct_set(name, kind, credential):
    try:
        _accts().set(name, kind, credential=credential or None)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "account '%s' saved" % name}


def execute_acct_delete(name):
    try:
        _accts().delete(name)
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "account '%s' removed" % name}


def config_read_model():
    """The config page's read model -- repos + their config + the credential
    LABELS/providers/assignments, plus the account registry (accounts /
    account_kinds / accounts_error: names, kinds, and credential labels
    only). NEVER a secret (creds.list() omits them; a live test asserts the
    secret string is absent from this response)."""
    c = _creds()
    cred_error = None
    try:
        cred_list = c.list()
        assignments = c.assignments()
    except Exception as exc:   # surface a real backend fault, don't fake "empty"
        cred_list, assignments = [], {}
        cred_error = str(exc) or exc.__class__.__name__
    repos = []
    for repo in Handler.repos:
        cfg = {}
        try:
            st = ds.build_repo_state(repo, git_in_flight=lambda r: {})
            cfg = st.get("config", {})
        except Exception:
            cfg = {}
        repos.append({"path": repo, "name": os.path.basename(repo.rstrip("/")),
                      "config": cfg})
    acct_list, acct_error = [], None
    try:
        acct_list = _accts().list()
    except Exception as exc:
        acct_error = str(exc) or exc.__class__.__name__
    return {"repos": repos, "credentials": cred_list,
            "assignments": assignments, "roles": list(_ASSIGNABLE_ROLES),
            "credentials_error": cred_error,
            "accounts": acct_list, "account_kinds": list(accts.VALID_KINDS),
            "accounts_error": acct_error}


def execute_cred_set(label, provider, secret):
    try:
        _creds().set(label, secret, provider=provider)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip() or "keychain write failed"
        return {"ok": False, "error": detail}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "credential '%s' saved" % label}


def execute_cred_delete(label):
    try:
        _creds().delete(label)
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "credential '%s' removed" % label}


def execute_cred_assign(role, label):
    try:
        _creds().assign(role, label)
    except (ValueError, KeyError) as exc:
        return {"ok": False, "error": str(exc)}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "%s → %s" % (role, label)}


def execute_cred_unassign(role):
    try:
        _creds().unassign(role)
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "%s unassigned" % role}


def _issue_focus(repo, number, repo_url):
    """Title/url/state for the ticket a session is working, so it shows with a
    link even before a PR exists. Cached per (repo, number)."""
    key = (repo, number)
    now = time.time()
    with _issue_lock:
        cached = _issue_cache.get(key)
        if cached and now - cached[0] < 60:
            return cached[1]
        while len(_issue_cache) > 256:     # bound it: evict oldest (dict is insertion-ordered), not clear-all
            _issue_cache.pop(next(iter(_issue_cache)))
    raw = _run(["gh", "issue", "view", str(number), "--json", "title,url,state"],
               cwd=repo, timeout=15)
    focus = None
    if raw:
        try:
            d = json.loads(raw)
            focus = {"number": number, "title": d.get("title") or "",
                     "url": d.get("url") or (repo_url + "/issues/%d" % number if repo_url else ""),
                     "state": (d.get("state") or "").lower(), "in_progress": True}
        except ValueError:
            focus = None
    with _issue_lock:
        _issue_cache[key] = (now, focus)
    return focus


def collect(repos):
    """Full app snapshot the page renders."""
    out = []
    for repo in repos:
        if not os.path.isdir(repo):
            out.append({"name": os.path.basename(repo.rstrip("/")), "path": repo,
                        "lifecycle": {"state": "missing", "pid": None},
                        "display_status": "missing",
                        "current_session": None, "voice": [], "git": {},
                        "config": {}})
            continue
        try:
            st = ds.build_repo_state(repo, git_in_flight=git_in_flight)
            st["throughput"] = _throughput(repo)
            # if a session is working a ticket but there's no open PR yet, surface
            # the in-progress ticket with its title + link. setdefault returns the
            # dict actually stored on st, so the mutation isn't lost when git=={}.
            git = st.setdefault("git", {})
            sess = st.get("current_session") or {}
            if not git.get("focus_ticket") and sess.get("ticket"):
                # completed beats issue lookup (#25): if the session's ticket
                # already has a merged PR, the honest story is "completed at T",
                # not "last worked". Matched by branch convention/title ref.
                # Never while busy -- a session re-working the ticket (follow-up
                # PR) must keep the live "in progress" story.
                busy = st.get("display_status") in ("working", "stopping")
                done = None if busy else ds.completed_ticket(
                    sess["ticket"], git.get("merged") or [])
                if done:
                    git["focus_ticket"] = {
                        "number": sess["ticket"], "title": done.get("title") or "",
                        "url": done.get("url") or "", "completed": True,
                        "merged_epoch": done.get("merged_epoch") or 0,
                        "pr_number": done.get("number")}
                else:
                    focus = _issue_focus(repo, sess["ticket"], git.get("repo_url", ""))
                    if focus:
                        # honest chip (#23): "in progress" only while the repo is
                        # actually busy; a stopped/idle repo shows its LAST ticket,
                        # never an in-progress claim. Copy -- _issue_focus caches.
                        focus = dict(focus)
                        focus["in_progress"] = busy
                        git["focus_ticket"] = focus
            out.append(st)
        except Exception as exc:  # never let one repo blank the page
            out.append({"name": os.path.basename(repo.rstrip("/")), "path": repo,
                        "lifecycle": {"state": "error", "pid": None},
                        "display_status": "error",
                        "error": str(exc), "current_session": None, "voice": [],
                        "git": {}, "config": {}})
    return {"generated_at": int(time.time()), "repos": out, "account": _account_usage()}


def execute_set_model(repo, model, effort, scope):
    """Carry out a validated set_model plan (#24). Session scope writes the
    one-shot override file the supervisor consumes; default scope rewrites
    ONLY the agent model/effort scalars in .autonomy/config.yaml via
    config_parser.set_scalar (comment-preserving, atomic replace)."""
    plan = dcx.set_model_plan(repo, model, effort, scope)
    if "error" in plan:
        return {"ok": False, "error": plan["error"]}
    try:
        if "write" in plan:
            os.makedirs(os.path.dirname(plan["write"]), exist_ok=True)
            tmp = plan["write"] + ".tmp"
            with open(tmp, "w") as fh:
                fh.write(plan["content"])
            os.replace(tmp, plan["write"])
        else:
            _rewrite_config(plan["config_path"], plan["config_set"])
    except KeyError as exc:
        missing = exc.args[0] if exc.args else exc
        return {"ok": False, "error": "config.yaml has no %s key to update" % missing}
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": plan.get("message", "done")}


def _rewrite_config(config_path, config_set):
    """Comment-preserving, atomic, mode-preserving config.yaml rewrite --
    the one write path for every page-driven config change."""
    with open(config_path) as fh:
        text = fh.read()
    for key, value in sorted(config_set.items()):
        text = config_parser.set_scalar(text, key, value)
    tmp = config_path + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(text)
    os.chmod(tmp, stat.S_IMODE(os.stat(config_path).st_mode))
    os.replace(tmp, config_path)


def execute_config_set(repo, key, value):
    """#47 config page: one whitelisted key per request, validated in the
    plan; same write path as set_model's save-default."""
    plan = dcx.config_set_plan(repo, key, value)
    if "error" in plan:
        return {"ok": False, "error": plan["error"]}
    try:
        _rewrite_config(plan["config_path"], plan["config_set"])
    except KeyError as exc:
        missing = exc.args[0] if exc.args else exc
        return {"ok": False, "error": "config.yaml has no %s key to update" % missing}
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": plan.get("message", "done")}


def _refresh_repos():
    """Re-run discovery after a registry change. Only when the repo set came
    from discovery -- explicit CLI --repo pins the set for this process.
    Never raises: the registry write already succeeded, and this runs outside
    that try block -- a discovery hiccup must degrade to a message, not blow
    up the POST handler (PR #48 review)."""
    if Handler.cli_pinned:
        return ("this dashboard was started with explicit --repo flags, so the "
                "change shows after a restart")
    try:
        # In-place: the SSE loop and the sampler thread hold this same list.
        Handler.repos[:] = discover_repos([])
    except Exception as exc:  # noqa: BLE001 -- deliberate catch-all boundary
        return "saved, but re-discovery failed (%s) -- restart to pick it up" % exc
    return "the repo set updates within a couple of seconds"


def execute_repo_add(path):
    plan = dcx.repo_add_plan(path, REPOS_FILE)
    if "error" in plan:
        return {"ok": False, "error": plan["error"]}
    if plan.get("noop"):
        return {"ok": True, "message": plan["message"]}
    try:
        os.makedirs(os.path.dirname(plan["append"]), exist_ok=True)
        with open(plan["append"], "a") as fh:
            fh.write(plan["line"] + "\n")
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": plan["message"] + "; " + _refresh_repos()}


def execute_repo_remove(path):
    plan = dcx.repo_remove_plan(path, REPOS_FILE)
    if "error" in plan:
        return {"ok": False, "error": plan["error"]}
    try:
        with open(plan["rewrite"]) as fh:
            lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        kept = [ln for ln in lines if ln.strip().rstrip("/") != plan["drop"]]
        tmp = plan["rewrite"] + ".tmp"
        with open(tmp, "w") as fh:
            for ln in kept:
                fh.write(ln + "\n")
        os.chmod(tmp, stat.S_IMODE(os.stat(plan["rewrite"]).st_mode))
        os.replace(tmp, plan["rewrite"])
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": plan["message"] + "; " + _refresh_repos()}


def execute_control(repo, action):
    """Resolve the lifecycle action to a plan and carry it out. Lifecycle only:
    a sentinel file touch/remove, or an exact launchctl bootout/bootstrap --
    nothing else is reachable. Returns {ok, message} or {ok:False, error}."""
    uid = os.getuid()
    service = dcx.find_service(repo, LAUNCH_AGENTS)
    plan = dcx.control_plan(repo, action, service, uid)
    if "error" in plan:
        return {"ok": False, "error": plan["error"]}
    try:
        if "touch" in plan:
            os.makedirs(os.path.dirname(plan["touch"]), exist_ok=True)
            open(plan["touch"], "a").close()
        elif "remove" in plan:
            if os.path.exists(plan["remove"]):
                os.remove(plan["remove"])
        elif "cmd" in plan:
            out = subprocess.run(plan["cmd"], capture_output=True, text=True,
                                 errors="replace", timeout=20)
            if out.returncode != 0:
                return {"ok": False,
                        "error": "%s failed: %s" % (plan["cmd"][1],
                                                    (out.stderr or "").strip()[:200])}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "%s timed out" % plan["cmd"][1]}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": plan.get("message", "done")}


class Handler(BaseHTTPRequestHandler):
    server_version = "autonomy-dashboard/1.0"
    repos = []
    cli_pinned = False     # True when --repo flags fixed the set (no live reload)
    allowed_hosts = set()  # set in main() to the loopback host:port we bind

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
        if path == "/" or path == "/config":
            page = PAGE if path == "/" else CONFIG_PAGE
            try:
                with open(page, "rb") as fh:
                    html = fh.read()
                html = html.replace(b"__CONTROL_TOKEN__", _CONTROL_TOKEN.encode("ascii"))
                self._send(200, html, "text/html; charset=utf-8")
            except OSError:
                self._send(500, os.path.basename(page).encode() + b" missing",
                           "text/plain")
        elif path == "/api/state":
            self._send(200, json.dumps(collect(self.repos)).encode("utf-8"))
        elif path == "/api/config":
            self._send(200, json.dumps(config_read_model()).encode("utf-8"))
        elif path == "/api/stream":
            self._stream()
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/control":
            self._send(404, b'{"error":"not found"}')
            return
        # Anti-DNS-rebinding: the Host must be exactly the loopback host:port we
        # bind. After a rebind the browser still sends Host: evil.com, which is
        # not in the allowlist -> rejected before the token is even checked.
        # These early rejects happen BEFORE we read the request body, so close
        # the connection with the response -- otherwise unread body bytes would
        # desync parsing of the next request on a keep-alive socket.
        host = self.headers.get("Host", "")
        if host not in self.allowed_hosts:
            self.close_connection = True
            self._send(421, b'{"error":"bad host"}')
            return
        # And if an Origin is present (cross-site POSTs always carry one) it must
        # be a loopback origin too.
        origin = self.headers.get("Origin")
        if origin and origin.split("://", 1)[-1] not in self.allowed_hosts:
            self.close_connection = True
            self._send(403, b'{"error":"cross-origin refused"}')
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 8192:
            self.close_connection = True
            self._send(400, b'{"error":"bad request"}')
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._send(400, b'{"error":"bad json"}')
            return
        if not secrets.compare_digest(str(body.get("token") or ""), _CONTROL_TOKEN):
            self._send(403, b'{"error":"bad or missing control token"}')
            return
        action = body.get("action")
        _cred_actions = ("cred_set", "cred_delete", "cred_assign", "cred_unassign")
        _acct_actions = ("acct_set", "acct_delete")
        if (action not in ("set_model", "config_set", "repo_add", "repo_remove")
                and action not in _cred_actions
                and action not in _acct_actions
                and not dcx.is_valid_action(action)):
            self._send(400, b'{"error":"invalid action"}')
            return
        # Credential actions (#51) manage the account-level credential store,
        # not a managed repo -- validation lives in credentials.py.
        if action in _cred_actions:
            if action == "cred_set":
                result = execute_cred_set(str(body.get("label") or ""),
                                          str(body.get("provider") or ""),
                                          str(body.get("secret") or ""))
            elif action == "cred_delete":
                result = execute_cred_delete(str(body.get("label") or ""))
            elif action == "cred_assign":
                result = execute_cred_assign(str(body.get("role") or ""),
                                             str(body.get("label") or ""))
            else:
                result = execute_cred_unassign(str(body.get("role") or ""))
            self._send(200 if result.get("ok") else 409,
                       json.dumps(result).encode("utf-8"))
            return
        if action in _acct_actions:
            if action == "acct_set":
                result = execute_acct_set(str(body.get("name") or ""),
                                          str(body.get("kind") or ""),
                                          str(body.get("credential") or ""))
            else:
                result = execute_acct_delete(str(body.get("name") or ""))
            self._send(200 if result.get("ok") else 409,
                       json.dumps(result).encode("utf-8"))
            return
        # Registry actions (#47) manage the repo SET itself, so they take a
        # path, not a managed repo -- validation lives in their plans.
        if action in ("repo_add", "repo_remove"):
            path = str(body.get("path") or "")
            result = (execute_repo_add(path) if action == "repo_add"
                      else execute_repo_remove(path))
            self._send(200 if result.get("ok") else 409,
                       json.dumps(result).encode("utf-8"))
            return
        repo = os.path.abspath(os.path.expanduser(str(body.get("repo") or "")))
        if repo not in self.repos:            # only ever act on a managed repo
            self._send(400, b'{"error":"repo is not managed by this dashboard"}')
            return
        if action == "set_model":
            result = execute_set_model(repo, str(body.get("model") or ""),
                                       str(body.get("effort") or ""),
                                       str(body.get("scope") or ""))
        elif action == "config_set":
            result = execute_config_set(repo, str(body.get("key") or ""),
                                        str(body.get("value") or ""))
        else:
            result = execute_control(repo, action)
        self._send(200 if result.get("ok") else 409, json.dumps(result).encode("utf-8"))

    def _stream(self):
        with _sse_lock:
            if _sse_active[0] >= _SSE_MAX:
                self._send(503, b'{"error":"too many streams"}')
                return
            _sse_active[0] += 1
        try:
            # a stalled write to a vanished client raises within the timeout
            # (socket.timeout is an OSError subclass) rather than hanging.
            try:
                self.connection.settimeout(_SSE_TIMEOUT)
            except OSError:
                pass
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            while True:
                payload = json.dumps(collect(self.repos))
                self.wfile.write(b"data: " + payload.encode("utf-8") + b"\n\n")
                self.wfile.flush()
                time.sleep(2.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return  # client navigated away / dropped / timed out
        finally:
            with _sse_lock:
                _sse_active[0] -= 1


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
    # IPv4 only: ThreadingHTTPServer is AF_INET, so an IPv6 literal (::1) would
    # raise at bind. Restrict to the two loopback names that actually bind here.
    if args.host not in ("127.0.0.1", "localhost"):
        sys.stderr.write("dashboard: refusing non-localhost host %r (this is a "
                         "local-only tool; use 127.0.0.1 or localhost)\n" % args.host)
        return 2

    Handler.repos = repos
    Handler.cli_pinned = bool(args.repos)
    Handler.allowed_hosts = {"%s:%d" % (h, args.port) for h in ("127.0.0.1", "localhost")}
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
