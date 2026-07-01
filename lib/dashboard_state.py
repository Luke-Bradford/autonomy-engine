#!/usr/bin/env python3
"""Read-only control-room state model for the P1 dashboard.

Turns the engine's *already-emitted* artifacts into the shape the page renders
-- it EXPOSES telemetry, it never invents any:

  - stream-json session logs   var/autonomy-logs/session-*.log
  - the supervisor's own voice  var/autonomy-logs/supervisor.log
  - the lifecycle lock/sentinel var/autonomy-supervisor.lock/pid + autonomy-PAUSE
  - the pack config             .autonomy/config.yaml (via config_parser)

Stdlib only. Pure/parsing functions take explicit inputs; the two
environment-coupled edges (pid liveness, git/gh state) are injected so the
whole module is testable without a process table or the network.
"""
import glob
import json
import os
import re
import threading
import time
from collections import Counter
from datetime import datetime

import config_parser

_TICKET_RE = re.compile(r"#(\d{1,6})\b")
# in-session branch creation: `git checkout -b|-B <name>` / `git switch -c|-C <name>`
_BRANCH_CREATE_RE = re.compile(r"(?:checkout\s+-[bB]|switch\s+-[cC])\s+['\"]?([^\s'\";&|]+)")
# the engine's own board write: board.sh status <n> "<Status>"
_BOARD_STATUS_RE = re.compile(r"board\.sh['\"]?\s+status\s+(\d{1,6})\s+['\"]?([A-Za-z][A-Za-z ]*)")

# Claude Code writes one JSONL per session under here; the account's REAL usage
# (all repos, all surfaces) is aggregatable from these -- the honest 5h/weekly
# signal, vs a single repo's sparse threshold events.
CLAUDE_PROJECTS = os.path.join(
    os.environ.get("CLAUDE_CONFIG_DIR", os.path.expanduser("~/.claude")), "projects")


def account_usage(projects_dir=None, now=None):
    """Account-wide session + token counts for the rolling 5-hour and 7-day
    windows, from ~/.claude/projects/**/*.jsonl. Dedupes on message.id (Claude
    Code re-emits a message's usage block several times). Stdlib only."""
    if projects_dir is None:
        projects_dir = CLAUDE_PROJECTS
    if now is None:
        now = time.time()
    seen = set()
    win = {
        "five_hour": {"sessions": set(), "tokens": 0, "cutoff": now - 5 * 3600},
        "seven_day": {"sessions": set(), "tokens": 0, "cutoff": now - 7 * 24 * 3600},
    }
    for path in glob.glob(os.path.join(projects_dir, "**", "*.jsonl"), recursive=True):
        sid = os.path.basename(path)[:-len(".jsonl")]
        # history grows forever; a file whose LAST WRITE predates the widest
        # window cannot contain an in-window record -- skip without reading
        # (60s slack for clock/fs jitter). Keeps the scan bounded by activity,
        # not by account age (#31).
        try:
            if os.path.getmtime(path) < win["seven_day"]["cutoff"] - 60:
                continue
            fh = open(path, errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                msg = o.get("message") or {}
                mid = msg.get("id")
                if not mid or mid in seen:
                    continue
                ts = o.get("timestamp")
                if not ts:
                    continue
                try:
                    epoch = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
                except ValueError:
                    continue
                seen.add(mid)
                u = msg.get("usage") or {}
                tot = ((u.get("input_tokens") or 0) + (u.get("output_tokens") or 0)
                       + (u.get("cache_creation_input_tokens") or 0)
                       + (u.get("cache_read_input_tokens") or 0))
                for w in win.values():
                    if epoch >= w["cutoff"]:
                        w["tokens"] += tot
                        w["sessions"].add(sid)
    return {k: {"sessions": len(v["sessions"]), "tokens": v["tokens"]}
            for k, v in win.items()}


# --- session stream-json ----------------------------------------------------

def _normalize_model(model):
    """'claude-opus-4-8[1m]' -> 'claude-opus-4-8' (drop context-window suffix)."""
    if not model:
        return ""
    return model.split("[", 1)[0]


def _started_at_from_name(path):
    """session-YYYYMMDDTHHMMSS.log -> 'YYYY-MM-DDTHH:MM:SSZ'."""
    base = os.path.basename(path)
    stamp = base[len("session-"):-len(".log")] if base.startswith("session-") else ""
    if len(stamp) == 15 and stamp[8] == "T":
        d, t = stamp[:8], stamp[9:]
        return "%s-%s-%sT%s:%s:%sZ" % (d[:4], d[4:6], d[6:8], t[:2], t[2:4], t[4:6])
    return ""


def _summarize_tool(name, inp):
    """One human-readable line for a tool_use node -- what it's working on."""
    inp = inp or {}
    if "file_path" in inp:
        return inp["file_path"]
    if name == "Bash":
        return inp.get("description") or inp.get("command") or "bash"
    if name == "Task":
        sub = inp.get("subagent_type")
        desc = inp.get("description") or "subagent"
        return "%s (%s)" % (desc, sub) if sub else desc
    if "url" in inp:
        return inp["url"]
    if "query" in inp:
        return inp["query"]
    if "target" in inp:
        return inp["target"]
    return name


def _block_label(block):
    """Short label for the 'current step' readout from a content block."""
    bt = block.get("type")
    if bt == "tool_use":
        return "%s %s" % (block.get("name", "tool"),
                          _summarize_tool(block.get("name"), block.get("input")))
    if bt == "text":
        return (block.get("text") or "").strip().splitlines()[0][:120]
    if bt == "thinking":
        return "thinking…"
    return bt or ""


def pick_ticket(mention_counts, mention_last_pos, branch_ticket, board_ticket):
    """The ticket a session is actually working (#26) -- a signal ladder, not
    raw most-mentioned (a board-triage scan out-mentions the picked ticket;
    the live eBull session showed #1015 while working #649):

      1. the branch the session CREATED (feat/<n>-/fix/<n>- convention) --
         the engine's own strongest commitment signal;
      2. the ticket the session marked 'In Progress' via board.sh, unless a
         later board write moved it elsewhere (Blocked/Done supersedes);
      3. the most RECENTLY mentioned ticket among those mentioned more than
         once (repeat mentions = engagement; recency breaks the triage noise);
      4. any mention at all, most recent first.
    """
    if branch_ticket is not None:
        return branch_ticket
    if board_ticket is not None:
        return board_ticket
    if not mention_counts:
        return None
    repeats = [t for t, c in mention_counts.items() if c >= 2]
    pool = repeats or list(mention_counts)
    return max(pool, key=lambda t: mention_last_pos.get(t, 0))


def parse_session_log(path):
    """Parse one session-*.log into the render model. Robust to partial/live
    files (each line guarded; a truncated tail line is skipped)."""
    session_id = ""
    model = ""
    cwd = ""
    nodes = []
    tokens_series = []
    streamed_output = 0
    cumulative = 0
    result = None
    rate_limited = False
    current_step = ""
    # ticket signals (#26): mention counts + last-seen position, the branch the
    # session created, and the last board.sh status write per ticket
    ticket_mentions = Counter()
    mention_last_pos = {}
    branch_ticket = None
    board_last = {}     # ticket -> (position, status-lowercased)
    pos = 0

    def _mention(n):
        ticket_mentions[n] += 1
        mention_last_pos[n] = pos

    try:
        fh = open(path, errors="replace")
    except OSError:
        return None
    with fh:
        for line in fh:
            if '"type"' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            t = o.get("type")
            if t == "system" and o.get("subtype") == "init":
                model = _normalize_model(o.get("model"))
                cwd = o.get("cwd") or ""
                session_id = o.get("session_id") or session_id
            elif t == "assistant":
                msg = o.get("message") or {}
                if not model:
                    model = _normalize_model(msg.get("model"))
                parent = o.get("parent_tool_use_id")
                usage = msg.get("usage") or {}
                out = usage.get("output_tokens") or 0
                streamed_output += out
                cumulative += out
                tokens_series.append(cumulative)
                for block in (msg.get("content") or []):
                    if not isinstance(block, dict):
                        continue
                    pos += 1
                    label = _block_label(block)
                    if label:
                        current_step = label
                    if block.get("type") == "text":
                        for n in _TICKET_RE.findall(block.get("text") or ""):
                            _mention(int(n))
                    if block.get("type") == "tool_use":
                        inp = block.get("input") or {}
                        for field in ("command", "description"):
                            for n in _TICKET_RE.findall(str(inp.get(field) or "")):
                                _mention(int(n))
                        cmd = str(inp.get("command") or "")
                        m = _BRANCH_CREATE_RE.search(cmd)
                        if m:
                            ref = extract_ticket_ref(m.group(1))
                            if ref is not None:
                                branch_ticket = ref   # latest creation wins
                        for bn, bstat in _BOARD_STATUS_RE.findall(cmd):
                            board_last[int(bn)] = (pos, bstat.strip().lower())
                        nodes.append({
                            "id": block.get("id"),
                            "parent": parent,
                            "name": block.get("name"),
                            "summary": _summarize_tool(block.get("name"), block.get("input")),
                            "tokens": out,
                            "is_subagent": block.get("name") == "Task",
                        })
            elif t == "rate_limit_event":
                rli = o.get("rate_limit_info") or {}
                if rli.get("status") == "rejected" and not rli.get("isUsingOverage"):
                    rate_limited = True
            elif t == "result":
                result = o

    if result is not None:
        status = "done-ok" if not result.get("is_error") else "done-error"
        output_tokens = (result.get("usage") or {}).get("output_tokens", streamed_output)
        cost = result.get("total_cost_usd") or 0.0
        result_text = result.get("result") or ""
        num_turns = result.get("num_turns")
    else:
        status = "running"
        output_tokens = streamed_output
        cost = 0.0
        result_text = ""
        num_turns = None

    pos += 1
    for n in _TICKET_RE.findall(result_text):
        _mention(int(n))
    # the ticket the session is working (#26): branch > board 'In Progress'
    # (unsuperseded) > recency-among-repeats > any mention
    board_ticket = None
    in_prog = [(p, t) for t, (p, s) in board_last.items() if s == "in progress"]
    if in_prog:
        board_ticket = max(in_prog)[1]
    ticket = pick_ticket(ticket_mentions, mention_last_pos, branch_ticket, board_ticket)

    # updated_at = last write (liveness); started_epoch = the file's creation time
    # (real epoch, tz-independent -- the session-*.log NAME is LOCAL time, so
    # parsing it as UTC would skew elapsed on a non-UTC machine).
    try:
        stat = os.stat(path)
        updated_at = int(stat.st_mtime)
        started_epoch = int(getattr(stat, "st_birthtime", stat.st_mtime))
    except OSError:
        updated_at = 0
        started_epoch = 0

    return {
        "path": path,
        "session_id": session_id,
        "model": model,
        "cwd": cwd,
        "started_at": _started_at_from_name(path),
        "started_epoch": started_epoch,
        "updated_at": updated_at,
        "status": status,
        "current_step": current_step,
        "nodes": nodes,
        "tokens_series": tokens_series,
        "output_tokens": output_tokens,
        "cost_usd": cost,
        "num_turns": num_turns,
        "result_text": result_text,
        "rate_limited": rate_limited,
        "ticket": ticket,
    }


# parse_session_log re-reads the whole file; the server calls it on every
# state collection (per SSE client per 2s tick), and real session logs run to
# megabytes. Cache by (mtime_ns, size): a live log changes both on every
# write, an idle one hits the cache. Lock guards the eviction scan -- the
# server is a ThreadingHTTPServer, one thread per request/stream (#31).
_parse_cache = {}
_parse_cache_lock = threading.Lock()
_PARSE_CACHE_MAX = 64


def parse_session_log_cached(path):
    """parse_session_log, re-parsing only when the file actually changed."""
    try:
        st = os.stat(path)
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        return None
    with _parse_cache_lock:
        hit = _parse_cache.get(path)
        if hit and hit[0] == key:
            return hit[1]
    result = parse_session_log(path)
    with _parse_cache_lock:
        while len(_parse_cache) >= _PARSE_CACHE_MAX:
            _parse_cache.pop(next(iter(_parse_cache)))
        _parse_cache[path] = (key, result)
    return result


def activity_state(session, now, stale_secs=90):
    """working-right-now vs idle -- derived from the session log's freshness,
    NOT the supervisor lock (a loop sleeping between sessions is alive but
    idle). 'working' = unfinished session whose log was written within
    stale_secs; 'idle' = unfinished but gone quiet; 'done' = terminal result;
    'none' = no session at all."""
    if not session:
        return "none"
    if str(session.get("status", "")).startswith("done"):
        return "done"
    updated = session.get("updated_at") or 0
    if now - updated <= stale_secs:
        return "working"
    return "idle"


def display_status(lifecycle_state, activity):
    """THE single source of truth for a repo's status label (#23).

    Collapses the two orthogonal axes -- lifecycle (is the supervisor process
    alive / paused / absent) and activity (is the session log fresh) -- into
    the one vocabulary every panel renders:

        working / stopping / idle / paused / stopped / needs-setup / missing / error

    Computed exactly once, server-side; the page must never re-derive it.
    Precedence: a terminal/absent lifecycle wins over stale session activity
    (a dead supervisor with an old log is 'stopped', never 'working')."""
    if lifecycle_state in ("needs-setup", "missing", "error"):
        return lifecycle_state
    if lifecycle_state == "paused":
        # graceful stop requested: still finishing the current session ->
        # "stopping"; session over / gone quiet -> "paused"
        return "stopping" if activity == "working" else "paused"
    if lifecycle_state == "stopped":
        return "stopped"
    return "working" if activity == "working" else "idle"


def extract_ticket_ref(branch):
    """The issue number a branch is working, by the engine's feat/<n>- /
    fix/<n>- convention. None if the branch encodes no ticket."""
    if not branch:
        return None
    for prefix in ("feat/", "fix/", "feature/"):
        if branch.startswith(prefix):
            rest = branch[len(prefix):]
            digits = ""
            for ch in rest:
                if ch.isdigit():
                    digits += ch
                else:
                    break
            if digits:
                return int(digits)
    return None


def iso_epoch(ts):
    """ISO-8601 (gh's Zulu style) -> epoch seconds; 0 on anything unparseable."""
    if not ts:
        return 0
    try:
        return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


def completed_ticket(ticket, merged_prs):
    """The merged PR that completed `ticket` (#25), or None. Matched by the
    engine's branch convention first (feat/<n>-/fix/<n>-), then by a #<n> ref
    in the PR title (word-bounded -- #6490 never matches 649)."""
    if not ticket or not merged_prs:
        return None
    for pr in merged_prs:
        if extract_ticket_ref(pr.get("branch") or "") == ticket:
            return pr
    ref = re.compile(r"#%d\b" % ticket)
    for pr in merged_prs:
        if ref.search(pr.get("title") or ""):
            return pr
    return None


def nest(nodes):
    """Flat node list -> forest, nesting each node under the tool_use whose id
    matches its `parent` (Claude Code subagent parentage). Orphans / top-level
    nodes become roots. Order preserved."""
    by_id = {}
    out = []
    for n in nodes:
        node = dict(n)
        node["children"] = []
        by_id[node["id"]] = node
        out.append(node)
    roots = []
    for node in out:
        parent = node.get("parent")
        if parent is not None and parent in by_id:
            by_id[parent]["children"].append(node)
        else:
            roots.append(node)
    return roots


# --- supervisor voice -------------------------------------------------------

def parse_quota_windows(path):
    """Extract the account's real usage from a session log's rate_limit_event
    objects. Anthropic emits `utilization` (0.0-1.0) per window, tagged
    `rateLimitType` five_hour|seven_day -- the authoritative % used (we no
    longer only read resetsAt). For each window we take the most recent one
    (max resetsAt), utilization = max seen at that reset. {} if none."""
    windows = {}
    try:
        fh = open(path, errors="replace")
    except OSError:
        return {}
    with fh:
        for line in fh:
            if '"rate_limit_event"' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("type") != "rate_limit_event":
                continue
            rli = o.get("rate_limit_info") or {}
            wt = rli.get("rateLimitType")
            reset = rli.get("resetsAt")
            if wt not in ("five_hour", "seven_day") or not isinstance(reset, (int, float)):
                continue
            util = rli.get("utilization")
            util = float(util) if isinstance(util, (int, float)) else 0.0
            cur = windows.get(wt)
            if cur is None or reset > cur["resets_at"] or (
                    reset == cur["resets_at"] and util > cur["utilization"]):
                windows[wt] = {
                    "resets_at": int(reset),
                    "utilization": util,
                    "overage": bool(rli.get("isUsingOverage")),
                }
    return windows


# The standard roster the page renders even before the multi-role org is built
# (operator asked to "design for roles now"). Defaults per docs/agent-org-design.md.
_STANDARD_ROLES = [
    ("coder", True, "engine", "loop"),
    ("pm", False, "managed_agents", "cron"),
    ("qa", False, "routine", "event"),
    ("researcher", False, "managed_agents", "cron"),
]


def _as_bool(v):
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("true", "1", "yes", "on")


def build_roles(config_roles, coder_status):
    """The per-repo role roster for the page. The standard four always render
    (Coder live; PM/QA/Researcher as not-configured placeholders unless the
    pack declares them), plus any custom roles the pack adds. `config_roles` is
    the parsed `roles:` mapping (may be empty). `coder_status` is the repo's
    unified display_status (#23) -- the coder row shows the SAME label as the
    repo badge, never a separately-derived one."""
    config_roles = config_roles or {}
    roles = []
    for name, d_enabled, d_sub, d_trig in _STANDARD_ROLES:
        cfg = config_roles.get(name) or {}
        enabled = _as_bool(cfg.get("enabled")) if "enabled" in cfg else d_enabled
        substrate = cfg.get("substrate") or d_sub
        trigger = (cfg.get("trigger") or {}).get("type") or d_trig
        if name == "coder":
            status = coder_status
        elif not cfg:
            status = "not-configured"
        else:
            status = "configured" if enabled else "disabled"
        roles.append({"name": name, "enabled": enabled, "substrate": substrate,
                      "trigger": trigger, "status": status,
                      "configured": bool(cfg)})
    # custom roles declared in the pack but not in the standard set
    for name, cfg in config_roles.items():
        if name in ("coder", "pm", "qa", "researcher"):
            continue
        cfg = cfg or {}
        roles.append({
            "name": name,
            "enabled": _as_bool(cfg.get("enabled")),
            "substrate": cfg.get("substrate") or "engine",
            "trigger": (cfg.get("trigger") or {}).get("type") or "loop",
            "status": "configured" if _as_bool(cfg.get("enabled")) else "disabled",
            "configured": True,
        })
    return roles


def read_model_override(path):
    """A queued one-shot model/effort override (#24), so the page can show
    'next session: ...' honestly. {} when none. Only the keys the supervisor
    honors (model/fallback/effort) are surfaced."""
    out = {}
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                key, sep, val = line.strip().partition("=")
                if sep and key in ("model", "fallback", "effort") and val:
                    out[key] = val
    except OSError:
        return {}
    return out


def read_supervisor_voice(path, limit=40):
    """Last `limit` lines of supervisor.log, oldest-first. Missing log -> []."""
    try:
        with open(path, errors="replace") as fh:
            lines = [ln.rstrip("\n") for ln in fh if ln.strip()]
    except OSError:
        return []
    return lines[-limit:]


# --- lifecycle --------------------------------------------------------------

def _default_pid_is_alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def lifecycle_status(repo_path, pid_is_alive=_default_pid_is_alive):
    """running / paused / stopped / needs-setup, from the lock + PAUSE sentinel."""
    logdir = os.path.join(repo_path, "var", "autonomy-logs")
    if not os.path.exists(os.path.join(repo_path, ".autonomy", "config.yaml")):
        return {"state": "needs-setup", "pid": None}

    pid = None
    pid_path = os.path.join(repo_path, "var", "autonomy-supervisor.lock", "pid")
    try:
        with open(pid_path) as fh:
            pid = int((fh.read() or "").strip())
    except (OSError, ValueError):
        pid = None

    alive = pid is not None and pid_is_alive(pid)
    if not alive:
        return {"state": "stopped", "pid": pid}
    if os.path.exists(os.path.join(logdir, "autonomy-PAUSE")):
        return {"state": "paused", "pid": pid}
    return {"state": "running", "pid": pid}


# --- composition ------------------------------------------------------------

def latest_session(logdir):
    """Path of the newest session-*.log in a logdir, or None. Public: the
    dashboard server's throughput sampler needs it too."""
    try:
        names = [n for n in os.listdir(logdir)
                 if n.startswith("session-") and n.endswith(".log")]
    except OSError:
        return None
    if not names:
        return None
    return os.path.join(logdir, sorted(names)[-1])


def _read_config(repo_path):
    cfg_path = os.path.join(repo_path, ".autonomy", "config.yaml")
    try:
        with open(cfg_path) as fh:
            cfg = config_parser.parse(fh.read())
    except OSError:
        return {"agent": "", "model": "", "merge_gate": ""}
    def g(key):
        try:
            return config_parser.get(cfg, key)
        except KeyError:
            return None
    roles = g("roles")
    return {
        "agent": g("agent.type") or "",
        "model": g("agent.model.primary") or "",
        "fallback": g("agent.model.fallback") or "",
        "effort": g("agent.effort") or "",
        "merge_gate": g("merge_gate.strategy") or "",
        "roles": roles if isinstance(roles, dict) else {},
    }


def build_repo_state(repo_path, pid_is_alive=_default_pid_is_alive, git_in_flight=None, now=None):
    """Compose the full per-repo render model. git/gh state is injected via
    `git_in_flight(repo_path) -> dict` so the page's server owns that edge."""
    if now is None:
        now = time.time()
    repo_path = os.path.abspath(repo_path)
    logdir = os.path.join(repo_path, "var", "autonomy-logs")
    latest = latest_session(logdir)
    session = parse_session_log_cached(latest) if latest else None
    activity = activity_state(session, now)
    config = _read_config(repo_path)
    lifecycle = lifecycle_status(repo_path, pid_is_alive=pid_is_alive)
    status = display_status(lifecycle["state"], activity)
    return {
        "name": os.path.basename(repo_path.rstrip("/")),
        "path": repo_path,
        "lifecycle": lifecycle,
        "current_session": session,
        "activity": activity,
        "display_status": status,
        "roles": build_roles(config.get("roles"), status),
        "voice": read_supervisor_voice(os.path.join(logdir, "supervisor.log")),
        "git": git_in_flight(repo_path) if git_in_flight else {},
        "config": config,
        "override": read_model_override(os.path.join(logdir, "model-override")),
        "quota": parse_quota_windows(latest) if latest else {},
    }
