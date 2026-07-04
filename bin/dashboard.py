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
import concurrent.futures
import importlib.util
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ENGINE_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ENGINE_HOME, "lib"))
import dashboard_state as ds  # noqa: E402
import dashboard_control as dcx  # noqa: E402
import config_parser  # noqa: E402
import credentials as creds  # noqa: E402
import accounts as accts  # noqa: E402
import concierge  # noqa: E402
import claude_usage as cu  # noqa: E402

# #166 slice 1: the engine sha THIS dashboard process booted from. Its own thin
# shell (bin/dashboard.py) can't hot-reload -- imports/argv bind at start -- so
# when the engine checkout advances past this sha the page shows an "update
# available -- restart to apply" chip. Captured once, here at import.
DASHBOARD_BOOT_SHA = ds.engine_head_sha(ENGINE_HOME)

# --- logic-module hot-reload (#166) ------------------------------------------
# A merged fix to a lib/*.py logic module is invisible in the running dashboard
# until a restart -- imports bind once at process start -- which looks identical
# to "the fix didn't work". So when a tracked module's source changes on disk
# (the checkout advanced to a merged commit) we rebuild the whole tracked set
# into BRAND-NEW module objects and atomically republish, without a restart.
#
# Why build-fresh + rebind, not in-place importlib.reload(): reload() mutates a
# live module dict while concurrent SSE/sampler/request threads are executing
# its functions -- readers would observe a half-mutated dict, a raising exec
# leaves it partially mutated (no rollback), and names deleted in the new source
# persist. Building a fresh object and rebinding one name is atomic under the
# GIL: a reader that already dereferenced the global runs entirely in its old
# epoch (old object, old module-level locks + caches); a new reader gets the new
# epoch -- never a blend. A failing build discards the new object and rolls back
# sys.modules, so the last-good code stays live (fail-safe, never blank).
#
# Order is leaves-before-dependents so a dependent's top-level `import` binds the
# already-rebuilt leaf. Closed set: dashboard_state -> config_parser, roles;
# accounts -> credentials; the rest are leaves. (roles' two lazy call-time
# imports resolve from sys.modules; the build+publish holds _reload_lock and the
# exposure window is microseconds on a 127.0.0.1 single-operator tool -- benign.)
# The gkey is the dashboard global to rebind, or None (roles has no dashboard
# global -- only dashboard_state imports it, so it republishes to sys.modules
# only).
_HOT_ORDER = (
    ("config_parser", "config_parser"),
    ("roles", None),
    ("credentials", "creds"),
    ("claude_usage", "cu"),
    ("concierge", "concierge"),
    ("dashboard_control", "dcx"),
    ("dashboard_state", "ds"),
    ("accounts", "accts"),
)


def _file_sig(path):
    """Change signature for a source file: (st_mtime_ns, st_size). Nanosecond
    precision + size beats a float getmtime() (coarse filesystems + float
    precision loss can miss a same-tick edit). None when unreadable -- a module
    whose file we cannot stat never triggers a reload on its own."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _build_hot_specs():
    """(name, source_path, gkey) per tracked module, in dependency order. Skips
    any module not importable/without a __file__ (defensive -- all are imported
    above, so this is belt-and-suspenders, never expected to skip)."""
    specs = []
    for name, gkey in _HOT_ORDER:
        mod = sys.modules.get(name)
        path = getattr(mod, "__file__", None) if mod else None
        if path:
            specs.append((name, path, gkey))
    return specs


_HOT_SPECS = _build_hot_specs()
_hot_sigs = {name: _file_sig(path) for name, path, _ in _HOT_SPECS}
_reload_lock = threading.Lock()
_hot_fail_sig = [None]   # last failing signature-set we logged (warn dedup)
# Throttle the stat-check so it runs at most once per interval regardless of
# request volume -- a busy dashboard otherwise serialises every concurrent
# request through _reload_lock just to re-stat 8 unchanged files. A change is
# still picked up within the interval (which matches the SSE/sample cadence).
_RELOAD_CHECK_EVERY = 2.0
_last_reload_check = [0.0]


def _reload_tracked(specs, sigs, ns, on_reload, on_error=None):
    """Build-fresh + atomic-publish reloader. `specs` is a list of
    (module_name, source_path, gkey) in dependency order (leaves first); `sigs`
    is a name->signature map of the currently-loaded code; `ns` is the namespace
    whose gkey globals get rebound; `on_reload` runs after a successful publish
    (reset stateful singletons); `on_error(exc)` runs on a build failure.

    Returns True iff a coherent new epoch was published. No change -> False (a
    cheap stat-only no-op). Build failure -> restores every sys.modules entry we
    touched, publishes nothing, leaves `sigs` UNADVANCED (so the pending change
    is retried next tick -- a half-written file recovers when the write
    completes to a new signature), and returns False."""
    current = {name: _file_sig(path) for name, path, _ in specs}
    if all(current[name] == sigs.get(name) for name, _, _ in specs):
        return False
    saved = {}
    built = {}
    try:
        for name, path, _ in specs:
            spec = importlib.util.spec_from_file_location(name, path)
            if spec is None or spec.loader is None:
                raise ImportError("no import spec/loader for %s (%s)" % (name, path))
            newmod = importlib.util.module_from_spec(spec)
            if name not in saved:
                saved[name] = sys.modules.get(name)
            sys.modules[name] = newmod          # a later dependent's import binds new
            # Compile the CURRENT source text directly rather than exec_module,
            # which would happily reuse a stale __pycache__/*.pyc: its validity
            # check is (mtime_SECONDS, size), so a same-second same-size edit
            # (e.g. one digit changed) runs the OLD bytecode. get_source() re-
            # reads the file, so the new epoch always reflects what's on disk.
            src = spec.loader.get_source(name)
            if src is None:                      # source-less loader -> best-effort
                spec.loader.exec_module(newmod)
            else:
                exec(compile(src, path, "exec"), newmod.__dict__)  # may raise -> caught
            built[name] = newmod
    except Exception as exc:                     # noqa: BLE001 -- deliberate boundary
        for name, old in saved.items():          # all-or-nothing: publish nothing
            if old is not None:
                sys.modules[name] = old
            else:
                sys.modules.pop(name, None)
        if on_error is not None:
            on_error(exc)
        return False
    for name, _, gkey in specs:                  # publish: atomic per-name rebind
        if gkey is not None:
            ns[gkey] = built[name]
    sigs.update(current)
    on_reload()
    return True


def _reset_logic_singletons():
    """Reset the stateful singletons after a publish so the next _accts()/
    _creds() reconstructs from the new module (they otherwise pin an instance of
    the pre-reload class, whose methods run old code)."""
    _accts_singleton[0] = None
    _creds_singleton[0] = None


def _on_reload_error(exc):
    # Warn once per distinct failing signature-set: a permanently-broken source
    # logs a single line, not one per SSE/sampler/request tick.
    sig = tuple(_file_sig(p) for _, p, _ in _HOT_SPECS)
    if _hot_fail_sig[0] == sig:
        return
    _hot_fail_sig[0] = sig
    sys.stderr.write("dashboard: logic-module reload failed (%s); serving the "
                     "last-good code\n" % exc)


def _reload_logic_modules():
    """Publish any pending logic-module change; a cheap stat-only no-op when
    nothing changed. Throttled to _RELOAD_CHECK_EVERY (so a burst of concurrent
    requests doesn't serialise on _reload_lock re-statting unchanged files) and
    serialised by _reload_lock so two threads never double-build. Called at the
    top of each request and once per SSE/sampler tick."""
    now = time.time()
    if now - _last_reload_check[0] < _RELOAD_CHECK_EVERY:
        return False               # checked recently -- skip the stat + lock
    _last_reload_check[0] = now    # benign if two threads race this: at worst
    with _reload_lock:             # one extra stat-check, never a double build
        published = _reload_tracked(_HOT_SPECS, _hot_sigs, globals(),
                                    _reset_logic_singletons, _on_reload_error)
    if published:
        _hot_fail_sig[0] = None   # a good publish re-arms failure logging
    return published


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


def _page_bytes(page):
    """Read a served HTML page and fill its build-time placeholders: the
    per-process control token, and the model-picker roster. MODEL_CHOICES is
    single-sourced from accounts.subscription_models("claude_subscription")
    (#134) and injected as JSON, so the page can never drift from the accounts
    curated list. A placeholder absent from a given page (e.g. /config has no
    __MODEL_CHOICES__) is a no-op replace."""
    with open(page, "rb") as fh:
        html = fh.read()
    html = html.replace(b"__CONTROL_TOKEN__", _CONTROL_TOKEN.encode("ascii"))
    models = json.dumps(accts.subscription_models("claude_subscription"))
    html = html.replace(b"__MODEL_CHOICES__", models.encode("ascii"))
    return html


# gh is network + slow; cache its result per repo so SSE ticks don't hammer it.
# Read/written from per-request SSE threads, so guard it (like _hist).
# Serve-stale-while-revalidate (#80): within [_GH_TTL, _GH_MAX_STALE) a request
# gets the cached value INSTANTLY and a single background thread refreshes it, so
# a slow/hung `gh` never blocks the render. Past _GH_MAX_STALE we fall back to a
# blocking refresh so the page can never show data older than the bound (the
# operator never acts on a chip directly -- safe_merge.sh re-verifies CI+review
# at merge time -- but a hard staleness ceiling keeps the view honest anyway).
_GH_TTL = 15.0
_GH_MAX_STALE = 75.0
_GH_JOIN_TIMEOUT = 25.0    # cold/too-stale callers wait at most this for a refresh
_gh_cache = {}
_gh_lock = threading.Lock()

# --- config-page board picker (#170) -----------------------------------------
# Enumerate an owner's Projects v2 boards so the config page's project_title
# becomes a picker instead of raw free-text (a plausible-but-wrong title
# silently skips board sync for the repo's whole life -- what this ticket fixes).
# Best-effort periphery (settled-decision 6): any validation / gh / JSON failure
# yields an empty list + an error string, NEVER an invented board (fail-safe,
# never fail-open -- the field stays free-text so the operator can still type).
# The owner is user-supplied (query param) and flows into gh argv, so it is
# re-validated against the GitHub login grammar first (prevention log 6) --
# rejecting a leading '-' also blocks argv-option injection. Cached briefly per
# owner so a page reload doesn't re-hit slow gh.
_OWNER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")
_BOARD_TTL = 30.0
_BOARD_CACHE_MAX = 32  # bound the dict: distinct owners must not grow it forever
_board_cache = {}      # owner -> (wall_ts, result_dict)
_board_lock = threading.Lock()


def board_list(owner):
    """{"boards": [title, ...], "error": str|None} for the owner's OPEN
    Projects v2 boards. Best-effort: never raises, never invents a board."""
    owner = (owner or "").strip()
    if not _OWNER_RE.match(owner):
        return {"boards": [], "error": "invalid owner"}
    now = time.time()
    with _board_lock:
        hit = _board_cache.get(owner)
        if hit and now - hit[0] < _BOARD_TTL:
            return hit[1]
    raw = _run(["gh", "project", "list", "--owner", owner,
                "--limit", "200", "--format", "json"], timeout=15)
    if raw is None:
        result = {"boards": [], "error": "gh project list unavailable"}
    else:
        try:
            projects = json.loads(raw).get("projects", [])
        except (ValueError, AttributeError):
            projects = None
        if not isinstance(projects, list):
            result = {"boards": [], "error": "unreadable board list"}
        else:
            titles, seen = [], set()
            for p in projects:
                if not isinstance(p, dict) or p.get("closed"):
                    continue
                t = p.get("title")
                # only suggest titles the config-save contract (dcx._valid_text,
                # resolved at call time so hot-reload #166 is picked up) will
                # accept -- never offer a value the save path would reject.
                if not isinstance(t, str) or t in seen or not dcx._valid_text(t):
                    continue
                seen.add(t)
                titles.append(t)
            result = {"boards": titles, "error": None}
    with _board_lock:
        if len(_board_cache) >= _BOARD_CACHE_MAX and owner not in _board_cache:
            # bound the dict: drop TTL-expired entries first, then hard-reset if
            # still at the cap (a small config-page cache, not a hot path).
            for k in [k for k, (ts, _) in _board_cache.items()
                      if now - ts >= _BOARD_TTL]:
                del _board_cache[k]
            if len(_board_cache) >= _BOARD_CACHE_MAX:
                _board_cache.clear()
        _board_cache[owner] = (now, result)
    return result
# repo -> the in-flight refresh Thread (single-flight guard). At most one refresh
# per repo runs, and it is the SOLE writer of _gh_cache; cold/too-stale callers
# join it rather than starting a second compute. Popped in the worker's finally,
# so a refresh that raises can never permanently pin a stale entry.
_gh_refreshing = {}

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
    # Live Claude 5h/7d utilization (#160): the sampler thread OWNS this I/O
    # (self-throttled to a 60s TTL inside claude_usage); the request path only
    # reads the cache. Best-effort -- a failure never crashes the sampler and
    # leaves the dashboard on the log-scan fallback.
    try:
        cu.refresh_live_quota(now=now)
    except Exception:
        pass
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
        _reload_logic_modules()   # so the background sampler runs fresh code too
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
    never raises (a gh/git hiccup must not blank the whole page).

    Cache policy (#80): fresh (< _GH_TTL) is returned as-is; stale-but-bounded
    is returned INSTANTLY while one background thread revalidates, so a slow gh
    never blocks the render; cold or past-_GH_MAX_STALE falls back to a blocking
    synchronous compute so the first paint (and a hard staleness ceiling) still
    yield real data. The snapshot itself is built by _compute_in_flight."""
    now = time.time()
    with _gh_lock:
        cached = _gh_cache.get(repo)
    if cached:
        age = now - cached[0]
        if age < _GH_TTL:
            return cached[1]                       # fresh
        if age < _GH_MAX_STALE:
            _ensure_refresh(repo)                  # serve stale, refresh behind
            return cached[1]
    # cold OR too-stale: block on the single-flight refresh (coalesced -- if one
    # is already running we join THAT, so a cold /api/state + first SSE tick share
    # one compute) and then read the cache the worker just wrote.
    t = _ensure_refresh(repo)
    if t is not None:
        t.join(_GH_JOIN_TIMEOUT)
    with _gh_lock:
        cached = _gh_cache.get(repo)
    return cached[1] if cached else _empty_in_flight()


def _empty_in_flight():
    """The never-blank fallback: if a cold refresh fails/times out there is no
    cached snapshot to serve, so hand back a well-formed empty one rather than
    raising into the request (best-effort, never blank the page)."""
    return {"branch": "?", "sha": "", "dirty": False, "repo_url": "",
            "prs": [], "merged": [], "focus_ticket": None}


def _ensure_refresh(repo):
    """Single-flight: start one background refresh for `repo`, or return the one
    already running. All cache writes funnel through the worker this spawns, so
    there is exactly one writer per repo in flight -- no concurrent/out-of-order
    writes. Returns the Thread, or None if it couldn't be started (best-effort).
    Starts the thread while holding _gh_lock so a concurrent joiner can only ever
    observe an already-started thread (join() on an unstarted thread would raise)."""
    with _gh_lock:
        t = _gh_refreshing.get(repo)
        if t is not None:
            return t
        t = threading.Thread(target=_refresh_worker, args=(repo,),
                             name="gh-refresh:" + repo, daemon=True)
        try:
            t.start()
        except RuntimeError:                       # can't spawn -> serve stale/empty
            return None
        _gh_refreshing[repo] = t
        return t


def _refresh_worker(repo):
    """Recompute one repo's snapshot and update the cache -- the SOLE writer of
    _gh_cache. Swallows every failure (keeps the prior entry -- fail-safe, never
    blank) and clears the single-flight guard in a finally so a raised refresh
    can't pin a stale entry forever."""
    try:
        result = _compute_in_flight(repo)
        with _gh_lock:
            _gh_cache[repo] = (time.time(), result)
    except Exception:
        pass
    finally:
        with _gh_lock:
            _gh_refreshing.pop(repo, None)


def _compute_in_flight(repo):
    """Build one repo's in-flight snapshot. Local git calls are serial (fast);
    the three network `gh` calls run concurrently so a cold build costs ~one
    round-trip, not three. Runs entirely OUTSIDE _gh_lock so a slow gh never
    blocks cache readers."""
    head = _run(["git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])
    sha = _run(["git", "-C", repo, "rev-parse", "--short", "HEAD"])
    if head == "HEAD":  # detached (the supervisor runs detached on origin/main)
        head = "detached@" + (sha or "?")
    dirty = _run(["git", "-C", repo, "status", "--porcelain"])

    def _repo_url():
        return _run(["gh", "repo", "view", "--json", "url", "--jq", ".url"],
                    cwd=repo, timeout=15) or ""

    def _open_raw():
        return _run(["gh", "pr", "list", "--state", "open", "--limit", "20", "--json",
                     "number,title,headRefName,isDraft,mergeable,reviewDecision,statusCheckRollup,url,updatedAt",
                     "--jq", "sort_by(.updatedAt) | reverse"],
                    cwd=repo, timeout=20)

    def _merged_raw():
        return _run(["gh", "pr", "list", "--state", "merged", "--limit", "6", "--json",
                     "number,title,url,mergedAt,headRefName", "--jq", "sort_by(.mergedAt) | reverse"],
                    cwd=repo, timeout=20)

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        f_url = pool.submit(_repo_url)
        f_open = pool.submit(_open_raw)
        f_merged = pool.submit(_merged_raw)
        repo_url = f_url.result()
        raw = f_open.result()
        mraw = f_merged.result()

    prs = []
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
    # what the loop finished, not just what's open. mraw fetched concurrently above.
    merged = []
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
    # Live Claude 5h/7d utilization (#160) -- a pure cache read (the sampler
    # does the I/O), so /api/state never blocks. None => the page falls back to
    # the log-scan windows and shows a 'logs (stale)' source badge.
    try:
        usage["claude"] = cu.live_quota()
    except Exception:
        usage["claude"] = None
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


def _registry_error(inst):
    """The RegistryError class from the module `inst`'s class was defined in,
    derived from the instance itself rather than a re-read of the `accts`/`creds`
    global. This CLOSES (not just narrows) the hot-reload race: a concurrent
    _reload_logic_modules() rebinding the module global mid-call can't desync the
    `except` from what `inst` actually raises, because both come from one source
    of truth -- the instance's own class namespace. We scan the methods defined
    directly on the class for one whose __globals__ carries RegistryError (any
    such method's __globals__ IS that module's dict), so an inherited __init__
    never trips us up; the sys.modules fallback covers the pathological case.
    Keeps the singleton accessors, so the #59 corrupt-registry injection seam
    (which sets the singleton to an instance backed by a corrupt index) works."""
    for member in vars(type(inst)).values():
        g = getattr(member, "__globals__", None)
        if g and "RegistryError" in g:
            return g["RegistryError"]
    return sys.modules[type(inst).__module__].RegistryError


def execute_acct_set(name, kind, credential):
    inst = _accts()
    try:
        inst.set(name, kind, credential=credential or None)
    except (_registry_error(inst), ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "account '%s' saved" % name}


def execute_acct_delete(name):
    inst = _accts()
    try:
        inst.delete(name)
    except (_registry_error(inst), OSError) as exc:
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


def models_read_model():
    """Per-account discovered models for the config picker (#82): each account's
    kind, its discovery SOURCE (accounts.model_source), the model ids that
    source yields (openai_compatible -> live GET /v1/models; a subscription ->
    the curated roster; else none), and an additive `labels` {id: display_name}
    map (#206 -- the live claude roster's human names, else {}). Best-effort +
    fail-safe: Accounts.list_models
    never raises, and any registry-level failure yields accounts=[] + error --
    the partial list is DISCARDED, never a leaked partial and never a 500
    (fail-safe, never fail-open)."""
    accounts, err = [], None
    try:
        inst = _accts()   # bind once -- list() and discover_models() share a snapshot
        for a in inst.list():
            name, kind = a.get("name"), a.get("kind")
            # discover_models is SOURCE-TRUTHFUL (#206): claude_subscription
            # reports "live" only when the live /v1/models roster actually came
            # back, else "curated". bin/ never re-derives the source itself.
            disc = inst.discover_models(name)
            # labels is ADDITIVE (#206): {id: display_name} for the picker to show
            # a human name next to each id; {} unless a live roster carried names.
            accounts.append({"name": name, "kind": kind,
                             "source": disc["source"], "models": disc["models"],
                             "labels": disc.get("labels", {})})
    except Exception as exc:   # discard any partial -- never fail-open
        accounts, err = [], (str(exc) or exc.__class__.__name__)
    return {"accounts": accounts, "error": err}


def execute_cred_set(label, provider, secret):
    inst = _creds()
    try:
        inst.set(label, secret, provider=provider)
    except (_registry_error(inst), ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip() or "keychain write failed"
        return {"ok": False, "error": detail}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "credential '%s' saved" % label}


def execute_cred_delete(label):
    inst = _creds()
    try:
        inst.delete(label)
    except (_registry_error(inst), OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "credential '%s' removed" % label}


def execute_cred_assign(role, label):
    inst = _creds()
    try:
        inst.assign(role, label)
    except (_registry_error(inst), ValueError, KeyError) as exc:
        return {"ok": False, "error": str(exc)}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": "%s → %s" % (role, label)}


def execute_cred_unassign(role):
    inst = _creds()
    try:
        inst.unassign(role)
    except (_registry_error(inst), OSError) as exc:
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


def _collect_one(repo):
    """One repo's card for the snapshot. Never raises -- a per-repo failure
    becomes an error card, so one bad repo can't blank the page."""
    if not os.path.isdir(repo):
        return {"name": os.path.basename(repo.rstrip("/")), "path": repo,
                "lifecycle": {"state": "missing", "pid": None},
                "display_status": "missing",
                "current_session": None, "voice": [], "git": {},
                "config": {}}
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
        return st
    except Exception as exc:  # never let one repo blank the page
        return {"name": os.path.basename(repo.rstrip("/")), "path": repo,
                "lifecycle": {"state": "error", "pid": None},
                "display_status": "error",
                "error": str(exc), "current_session": None, "voice": [],
                "git": {}, "config": {}}


def collect(repos):
    """Full app snapshot the page renders. Per-repo cards are built concurrently
    (#80) so N repos don't serialise on gh -- each _collect_one is independent
    and touches only lock-guarded shared caches. Order is preserved and the list
    is snapshotted first, so a concurrent Handler.repos mutation can't skip/dup a
    repo mid-map."""
    repos = list(repos)
    if len(repos) <= 1:
        out = [_collect_one(r) for r in repos]     # no pool for the common 1-repo case
    else:
        try:
            with concurrent.futures.ThreadPoolExecutor(
                    max_workers=min(8, len(repos))) as pool:
                out = list(pool.map(_collect_one, repos))
        except Exception:
            # executor infra failure (thread exhaustion) must not blank the page:
            # fall back to serial. _collect_one already contains per-repo errors.
            out = [_collect_one(r) for r in repos]
    return {"generated_at": int(time.time()), "repos": out,
            "account": _account_usage(),
            "engine": ds.engine_status(DASHBOARD_BOOT_SHA, out)}


def execute_set_model(repo, model, effort, scope):
    """Carry out a validated set_model plan (#24). Session scope writes the
    one-shot override file the supervisor consumes; default scope rewrites
    ONLY the agent model/effort scalars in .autonomy/config.yaml via
    config_parser.set_scalar (comment-preserving, atomic replace)."""
    plan = dcx.set_model_plan(repo, model, effort, scope)
    if "error" in plan:
        return {"ok": False, "error": plan["error"]}
    try:
        if "overlay" in plan:
            _write_overlay(plan["overlay"], plan["overlay_set"])
        elif "write" in plan:
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


def _write_overlay(path, overlay_set):
    """Persist page-written model/effort keys to the untracked overlay (#202),
    merge-preserving existing keys. Atomic; parent dir created. The overlay
    lives in the gitignored var/autonomy-logs, so 'save default' survives the
    supervisor's preflight stash-recovery that would sweep a tracked
    config.yaml edit."""
    existing = {}
    try:
        with open(path, errors="replace") as fh:
            for raw in fh:
                # Preserve existing keys VERBATIM (split on first '=', strip only
                # the newline). Using line.strip() would normalize a stray-space
                # line like ` model=x` -- which the supervisor ignores -- into an
                # effective `model=x` on the next save, resurrecting an invalid
                # override (fail-safe violation). A dirty key stays dirty here.
                k, sep, v = raw.rstrip("\n").partition("=")
                if sep and k:
                    existing[k] = v
    except OSError:
        pass
    existing.update(overlay_set)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        for k in sorted(existing):
            fh.write("%s=%s\n" % (k, existing[k]))
    os.replace(tmp, path)


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
        if "overlay" in plan:
            _write_overlay(plan["overlay"], plan["overlay_set"])
        else:
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


def _is_benign_disconnect(exc):
    """A client resetting a keep-alive / SSE connection is normal (the browser
    navigated away or closed the stream). The default ThreadingHTTPServer dumps
    a full traceback per reset, which reads as 'the app is crashing' when it is
    healthy. These specific socket errors are benign; anything else is real."""
    return isinstance(exc, (ConnectionResetError, BrokenPipeError,
                            ConnectionAbortedError, TimeoutError))


class _QuietThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that swallows benign client-disconnect tracebacks
    (see _is_benign_disconnect) and surfaces everything else as usual."""
    daemon_threads = True

    def handle_error(self, request, client_address):
        if _is_benign_disconnect(sys.exc_info()[1]):
            return
        super().handle_error(request, client_address)


def _pick_concierge_account(local_names, preferred):
    """Choose which openai_compatible account the concierge answers from (#137).

    `local_names` is the list of registered openai_compatible account names in
    registry order; `preferred` is the AUTONOMY_CONCIERGE_ACCOUNT override
    (None/empty when unset). Rule:
      - preference set + names a registered local account -> use it;
      - preference set + no match -> raise (visible misconfig, NEVER a silent
        fall back to a different endpoint -- fail-safe);
      - preference unset -> the deterministic registry-first default.
    Raises ValueError (operator-facing message) when no local account exists or
    a preference is unmatched; the caller degrades it to {ok:false,error}.
    """
    if not local_names:
        raise ValueError("no local LLM configured -- register an "
                         "openai_compatible account (e.g. Ollama) to use the "
                         "concierge")
    pref = (preferred or "").strip()
    if pref:
        if pref in local_names:
            return pref
        raise ValueError(
            "AUTONOMY_CONCIERGE_ACCOUNT=%r is not a registered "
            "openai_compatible account (have: %s)"
            % (pref, ", ".join(local_names)))
    return local_names[0]


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

    def _chat_reply(self, body):
        """Answer the operator's question about the live system via a LOCAL LLM
        (token-free). Always returns a JSON-able dict -- a missing account or an
        unreachable endpoint degrades to {ok:false,error}, never a 500, so the
        chat box shows a friendly message instead of the dashboard falling over.
        """
        message = str(body.get("message") or "").strip()
        if not message:
            return {"ok": False, "error": "empty message"}
        history = body.get("history")
        history = history if isinstance(history, list) else []
        try:
            acc = accts.Accounts()
            local = [a.get("name") for a in acc.list()
                     if a.get("kind") == "openai_compatible"]
        except Exception as exc:  # registry unreadable/corrupt -- report, don't crash
            return {"ok": False, "error": "account registry error: %s" % exc}
        try:
            name = _pick_concierge_account(
                local, os.environ.get("AUTONOMY_CONCIERGE_ACCOUNT"))
        except ValueError as exc:  # no local account, or an unmatched preference
            return {"ok": False, "error": str(exc)}
        try:
            base_url = acc.resolve(name)["env"]["OPENAI_BASE_URL"]
            models = acc.list_models(name)
        except Exception as exc:
            return {"ok": False,
                    "error": "cannot resolve local endpoint '%s': %s" % (name, exc)}
        model = models[0] if models else "qwen3:14b"
        context = concierge.build_context(collect(self.repos).get("repos") or [])
        try:
            reply = concierge.chat(base_url, model, context, message,
                                   history=history, timeout=120)
        except Exception as exc:  # endpoint down / timeout -- degrade gracefully
            return {"ok": False,
                    "error": "local endpoint '%s' unreachable: %s" % (name, exc)}
        return {"ok": True, "reply": concierge.strip_thinking(reply),
                "model": model, "account": name}

    def do_GET(self):
        _reload_logic_modules()   # pick up merged logic-module fixes (#166)
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/config":
            page = PAGE if path == "/" else CONFIG_PAGE
            try:
                self._send(200, _page_bytes(page),
                           "text/html; charset=utf-8")
            except OSError:
                self._send(500, os.path.basename(page).encode() + b" missing",
                           "text/plain")
        elif path == "/api/state":
            self._send(200, json.dumps(collect(self.repos)).encode("utf-8"))
        elif path == "/api/config":
            self._send(200, json.dumps(config_read_model()).encode("utf-8"))
        elif path == "/api/models":
            # config-page model picker (#82): per-account discovered models,
            # best-effort, always 200 (payload carries any error). No query
            # param -- account names come only from the validated registry.
            self._send(200, json.dumps(models_read_model()).encode("utf-8"))
        elif path == "/api/boards":
            # config-page board picker (#170): best-effort, always 200 (the
            # payload carries any error), owner re-validated inside board_list.
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]
                                       if "?" in self.path else "")
            owner = (qs.get("owner") or [""])[0]
            self._send(200, json.dumps(board_list(owner)).encode("utf-8"))
        elif path == "/api/stream":
            self._stream()
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        _reload_logic_modules()   # pick up merged logic-module fixes (#166)
        path = self.path.split("?", 1)[0]
        if path not in ("/api/control", "/api/chat"):
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
        # Chat carries a message + short history, so it needs a larger cap than
        # the tiny control payloads.
        max_len = 65536 if path == "/api/chat" else 8192
        if length <= 0 or length > max_len:
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
        # Concierge chat (#88/W4): loopback + token-gated like control, but it
        # only READS system state and calls a LOCAL LLM -- no repo mutation.
        if path == "/api/chat":
            self._send(200, json.dumps(self._chat_reply(body)).encode("utf-8"))
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
                _reload_logic_modules()   # long-lived stream picks up fixes too
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

    httpd = _QuietThreadingHTTPServer((args.host, args.port), Handler)
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
