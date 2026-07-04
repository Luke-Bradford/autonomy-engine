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
import subprocess
import threading
import time
from collections import Counter, deque
from datetime import datetime

import config_parser
import dashboard_control as _dcx  # model-id regex + effort set, single-sourced
import roles as roles_schema

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


def _repo_relative(path, root):
    """Render a tool file_path as repo-relative when it lives under the session
    cwd (root), so the feed shows 'lib/x.py' not '/Users/.../lib/x.py' (#186).
    A path outside the repo is left absolute -- it honestly is not repo-relative,
    and stripping it to a basename would hide where it points. Anchoring on
    root + '/' (not a bare prefix) keeps '/repo' from mis-eating '/repo-alpha'."""
    if not root or not path:
        return path
    root = root.rstrip("/")
    if path == root:
        return "."
    prefix = root + "/"
    if path.startswith(prefix):
        return path[len(prefix):]
    return path


def _summarize_tool(name, inp, root=None):
    """One human-readable line for a tool_use node -- what it's working on."""
    inp = inp or {}
    if "file_path" in inp:
        return _repo_relative(inp["file_path"], root)
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


def _block_label(block, root=None):
    """Short label for the 'current step' readout from a content block."""
    bt = block.get("type")
    if bt == "tool_use":
        return "%s %s" % (block.get("name", "tool"),
                          _summarize_tool(block.get("name"), block.get("input"), root))
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


def ticket_source(mention_counts, mention_last_pos, branch_ticket,
                  board_ticket, branch_name=None):
    """A short, operator-facing reason the card shows THIS ticket (#151 item 3)
    -- mirrors pick_ticket's ladder rung-for-rung so the tooltip can never
    disagree with the pick. Returns None exactly when pick_ticket returns None
    (no ticket -> no source)."""
    picked = pick_ticket(mention_counts, mention_last_pos, branch_ticket,
                         board_ticket)
    if picked is None:
        return None
    if branch_ticket is not None:
        if branch_name:
            return "from the branch this session created (%s)" % branch_name
        return "from the branch this session created"
    if board_ticket is not None:
        return "from a board 'In Progress' status write"
    count = mention_counts.get(picked, 0)
    if count >= 2:
        return "most recently mentioned ticket (mentioned %d×)" % count
    return "only ticket mentioned (once)"


_CODEX_WINDOWS = {300: "five_hour", 10080: "seven_day"}


def codex_usage(codex_home=None, now=None):
    """Codex account usage, read from the codex CLI's own session rollouts
    (~/.codex/sessions/**/rollout-*.jsonl) -- shapes verified empirically
    against codex-cli 0.136.0. The newest file's LAST token_count snapshot
    provides rate_limits (primary=5h, secondary=weekly, mapped by
    window_minutes; plan_type; credits -- credits stay null on a ChatGPT
    subscription and populate under API billing, so surfacing them covers
    the API-counts case with no further change). Token totals sum the last
    cumulative total_token_usage per file across a 7-day mtime window.
    {"available": False} when nothing is found -- honest empty state."""
    if codex_home is None:
        codex_home = os.path.expanduser("~/.codex")
    if now is None:
        now = time.time()
    root = os.path.join(codex_home, "sessions")
    cutoff = now - 7 * 86400
    files = []
    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            if not (name.startswith("rollout-") and name.endswith(".jsonl")):
                continue
            p = os.path.join(dirpath, name)
            try:
                mtime = os.stat(p).st_mtime
            except OSError:
                continue
            if mtime >= cutoff:
                files.append((mtime, p))
    if not files:
        return {"available": False}
    files.sort(reverse=True)

    latest_limits = None
    tokens_in = tokens_out = 0
    counted = 0
    for _mtime, p in files:
        last_snapshot = None
        last_totals = None
        try:
            fh = open(p, errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"token_count"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                payload = o.get("payload") if isinstance(o.get("payload"), dict) else o
                if payload.get("type") != "token_count":
                    continue
                if isinstance(payload.get("rate_limits"), dict):
                    last_snapshot = payload["rate_limits"]
                info = payload.get("info") or {}
                if isinstance(info.get("total_token_usage"), dict):
                    last_totals = info["total_token_usage"]
        if last_totals is not None:
            tokens_in += last_totals.get("input_tokens") or 0
            tokens_out += ((last_totals.get("output_tokens") or 0)
                           + (last_totals.get("reasoning_output_tokens") or 0))
            counted += 1
        if latest_limits is None and last_snapshot is not None:
            latest_limits = last_snapshot

    if latest_limits is None and counted == 0:
        return {"available": False}

    out = {"available": True, "plan": "", "credits": None,
           "five_hour": {}, "seven_day": {},
           "tokens_7d": {"input": tokens_in, "output": tokens_out},
           "sessions_7d": counted}
    if latest_limits is not None:
        out["plan"] = latest_limits.get("plan_type") or ""
        out["credits"] = latest_limits.get("credits")
        for key in ("primary", "secondary"):
            win = latest_limits.get(key)
            if not isinstance(win, dict):
                continue
            slot = _CODEX_WINDOWS.get(win.get("window_minutes"))
            if slot is None:  # unknown window size: fall back positionally
                slot = "five_hour" if key == "primary" else "seven_day"
            out[slot] = {"pct": win.get("used_percent"),
                         "resets_at": win.get("resets_at")}
    return out


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
    branch_name = None   # the created branch string, for the #151 attribution hint
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
                    label = _block_label(block, cwd)
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
                                branch_name = m.group(1).strip()
                        for bn, bstat in _BOARD_STATUS_RE.findall(cmd):
                            board_last[int(bn)] = (pos, bstat.strip().lower())
                        nodes.append({
                            "id": block.get("id"),
                            "parent": parent,
                            "name": block.get("name"),
                            "summary": _summarize_tool(block.get("name"), block.get("input"), cwd),
                            "tokens": out,
                            "is_subagent": block.get("name") == "Task",
                        })
            elif t == "rate_limit_event":
                rli = o.get("rate_limit_info") or {}
                if rli.get("status") == "rejected" and not rli.get("isUsingOverage"):
                    rate_limited = True
            elif t == "result":
                result = o
            # --- codex adapter sessions (`codex exec --json`, #49) ---------
            elif t == "thread.started":
                session_id = o.get("thread_id") or session_id
            elif t == "item.completed":
                item = o.get("item") or {}
                if item.get("type") == "agent_message":
                    pos += 1
                    text = item.get("text") or ""
                    label = _block_label({"type": "text", "text": text}, cwd)
                    if label:
                        current_step = label
                    for n in _TICKET_RE.findall(text):
                        _mention(int(n))
            elif t == "turn.completed":
                usage = o.get("usage") or {}
                out = ((usage.get("output_tokens") or 0)
                       + (usage.get("reasoning_output_tokens") or 0))
                streamed_output += out
                cumulative += out
                tokens_series.append(cumulative)
                # claude-shaped result so the status/token logic below applies
                result = {"is_error": False,
                          "usage": {"output_tokens": streamed_output}}
            elif t in ("turn.failed", "stream_error"):
                result = {"is_error": True}

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
    ticket_src = ticket_source(ticket_mentions, mention_last_pos, branch_ticket,
                               board_ticket, branch_name)

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
        "ticket_source": ticket_src,
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


def merge_gate_chain(strategy):
    """The configured merge-gate tail for the #187 phase track's OUTLINE layer:
    what gate chain a PR must still clear, derived from the repo's OWN
    `merge_gate.strategy`. This is a READ-ONLY display derivation -- it draws
    the gate, it never gates a merge (safe_merge.sh remains the sole enforcer).

    The four strategies mirror safe_merge.sh exactly (an empty/unset strategy
    defaults to `manual`, matching its `${STRATEGY:-manual}`):
        manual      pr -> 👤        (operator reviews + merges by hand)
        ci_only     pr -> merge     (CI green auto-merges, no review)
        bot_comment pr -> review(bot) -> merge
        gh_review   pr -> review(human) -> merge
    Returns an ordered list of {step[, actor]} segments; `actor` is present
    only on a `review` step. An UNRECOGNISED strategy degrades to `[pr]` -- the
    one certain fact (a PR was opened) -- rather than guessing a tail, per the
    spec's 'degrade to truth, never guess'. The QA/custom-role dimension (the
    other axis of the #156 gating matrix) is a documented follow-up; this is
    the universal layer only.

    NOTE: the strategy names are necessarily re-enumerated here (Python) from
    safe_merge.sh (bash) -- config_parser is the only shared lib across that
    boundary. Keep this mapping in sync with safe_merge.sh's strategy branches.

    Total by construction: this feeds build_repo_state(), which renders the
    WHOLE dashboard, so it must never raise. `_read_config` hands us the
    flattened strategy STRING (`merge_gate.strategy`), but we defend the seam
    anyway -- a non-string shape degrades to `[pr]` rather than crashing the
    render. `None`/`""` (unset) still default to `manual`."""
    if strategy is None:
        s = "manual"
    elif isinstance(strategy, str):
        s = strategy.strip().lower() or "manual"
    else:
        # malformed (non-string) strategy -- degrade to the one certain fact
        # rather than blow up the dashboard render on a `.strip()`
        return [{"step": "pr"}]
    if s == "manual":
        return [{"step": "pr"}, {"step": "review", "actor": "human"}]
    if s == "ci_only":
        return [{"step": "pr"}, {"step": "merge"}]
    if s == "bot_comment":
        return [{"step": "pr"}, {"step": "review", "actor": "bot"}, {"step": "merge"}]
    if s == "gh_review":
        return [{"step": "pr"}, {"step": "review", "actor": "human"}, {"step": "merge"}]
    return [{"step": "pr"}]


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
# (operator asked to "design for roles now"). Single source: lib/roles.py (#12).
_STANDARD_ROLES = roles_schema.DEFAULT_ROLES


_as_bool = roles_schema.as_bool


def _role_next_fire(cfg, enabled, now):
    """Next-fire epoch for an ENABLED cron role (#18); None otherwise (or on
    a garbled schedule -- render nothing rather than a wrong countdown)."""
    if not enabled or now is None:
        return None
    trigger = cfg.get("trigger") or {}
    if trigger.get("type") != "cron":
        return None
    return roles_schema.cron_next_fire(trigger.get("schedule"), now)


def build_roles(config_roles, coder_status, now=None):
    """The per-repo role roster for the page. The standard four always render
    (Coder live; PM/QA/Researcher as not-configured placeholders unless the
    pack declares them), plus any custom roles the pack adds. `config_roles` is
    the parsed `roles:` mapping (may be empty). `coder_status` is the repo's
    unified display_status (#23) -- the coder row shows the SAME label as the
    repo badge, never a separately-derived one. `now` enables the cron
    next-fire countdown (#18)."""
    config_roles = config_roles or {}
    roles = []
    for name, d_enabled, _d_sub, d_trig in _STANDARD_ROLES:
        cfg = config_roles.get(name) or {}
        enabled = _as_bool(cfg.get("enabled")) if "enabled" in cfg else d_enabled
        # #164: the legacy DEFAULT_ROLES substrate (pm->managed_agents, qa->routine)
        # is a display lie now -- W1/W2 execute every enabled role on the local
        # engine. So: coder is the local loop role and ALWAYS shows "engine" (even
        # if a config typos an override); for the others an explicit substrate: is
        # respected, any configured role shows "engine", and a not-configured
        # placeholder claims nothing (None -> the page drops the badge). #149.
        if name == "coder":
            substrate = "engine"
        else:
            substrate = cfg.get("substrate") or ("engine" if cfg else None)
        trigger = (cfg.get("trigger") or {}).get("type") or d_trig
        if name == "coder":
            status = coder_status
        elif not cfg:
            status = "not-configured"
        else:
            status = "configured" if enabled else "disabled"
        roles.append({"name": name, "enabled": enabled, "substrate": substrate,
                      "trigger": trigger, "status": status,
                      "configured": bool(cfg),
                      "next_fire": _role_next_fire(cfg, enabled and bool(cfg), now)})
    # custom roles declared in the pack but not in the standard set
    standard = tuple(r[0] for r in _STANDARD_ROLES)
    for name, cfg in config_roles.items():
        if name in standard:
            continue
        cfg = cfg or {}
        enabled = _as_bool(cfg.get("enabled"))
        roles.append({
            "name": name,
            "enabled": enabled,
            "substrate": cfg.get("substrate") or "engine",
            "trigger": (cfg.get("trigger") or {}).get("type") or "loop",
            "status": "configured" if enabled else "disabled",
            "configured": True,
            "next_fire": _role_next_fire(cfg, enabled, now),
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


def read_heartbeat(path):
    """The supervisor's structured liveness line (#177): ONE tab-separated
    record `ts \\t phase \\t until_epoch \\t reason` rewritten each loop phase,
    so the page can render 'what is happening and why now' instead of a bare
    IDLE. {} when absent / empty / malformed (fewer than the four fields, or a
    non-integer ts). `ts`/`until` are ints (epoch seconds); `until` is 0 when
    the phase has no deadline (active/instantaneous) -- the page shows a
    client-side countdown only when until > now. Read-only + best-effort, in
    the spirit of the writer: a torn or partial file degrades to {}."""
    try:
        with open(path, errors="replace") as fh:
            line = fh.readline().rstrip("\n")
    except OSError:
        return {}
    parts = line.split("\t")
    if len(parts) < 4:
        return {}
    ts_s, phase, until_s, reason = parts[0], parts[1], parts[2], parts[3]
    if not phase:
        return {}
    try:
        ts = int(ts_s)
    except ValueError:
        return {}
    try:
        until = int(until_s) if until_s else 0
    except ValueError:
        until = 0
    return {"ts": ts, "phase": phase, "until": until, "reason": reason}


# --- choreography feed (#177 piece 3) ---------------------------------------
# The supervisor already LOGS the org's handoffs -- cron fires and event wakes --
# to supervisor.log; slice-1's heartbeat is the *current* state, this is the
# rolling *history*. read_choreography lifts the handoff subset out of the log and
# structures it so the page can render first-class role-chipped feed lines instead
# of burying them in the flat supervisor-voice text.
#
# COUPLING: these regexes track the exact strings bin/supervisor.sh emits at
#   :511  log "cron: role '<r>' due (schedule '<s>') -- firing"
#   :564  log "event: role '<r>' woken by session.done"
#   :591  log "event: role '<r>' woken by <event> (<tokens>)"
# and the v1 event token shapes from _event_poll (:533) -- numeric issue/PR
# numbers, or NUMBER:SHA for pr.synchronize. If those emit strings change, the
# tests in TestChoreography break rather than the feed silently blanking.
#
# Read-only + best-effort, in the spirit of read_heartbeat: a missing/torn/huge
# log degrades to []. Fail-safe parsing: a line that does not match a known
# choreography shape -- or whose refs fail their event's token shape -- is skipped,
# never guessed into a garbage handoff.
_CHOREO_EVENTS = ("pr.opened", "issue.created", "merge.done", "pr.synchronize")
_CHOREO_CRON = re.compile(r"cron: role '([^']+)' due \(schedule '.*'\) -- firing$")
_CHOREO_DONE = re.compile(r"event: role '([^']+)' woken by session\.done$")
_CHOREO_EVENT = re.compile(
    r"event: role '([^']+)' woken by "
    r"(pr\.opened|issue\.created|merge\.done|pr\.synchronize) \(([^)]*)\)$")
_CHOREO_NUM = re.compile(r"^\d+$")
# pr.synchronize emits NUMBER:headRefOid; headRefOid is a full 40-char git OID
# (gh never abbreviates it), so require exactly 40 hex -- a truncated/corrupt
# token like `42:a` is not a real handoff and is dropped (fail-safe).
_CHOREO_SYNC = re.compile(r"^\d+:[0-9a-fA-F]{40}$")


def _choreo_refs_ok(event, refs):
    """Every ref token must match its event's v1 shape (fail-safe: any bad token
    drops the whole line). pr.synchronize -> NUMBER:40-hex-SHA; the rest -> a
    number."""
    if not refs:
        return False
    pat = _CHOREO_SYNC if event == "pr.synchronize" else _CHOREO_NUM
    return all(pat.match(t) for t in refs)


def read_choreography(path, scan=400, keep=12):
    """The supervisor's handoff feed (#177 piece 3): cron fires, event wakes and
    session-done handoffs parsed from supervisor.log into structured entries
    `{ts, at, kind, role, event, refs}`, oldest-first, at most `keep`. `kind` is
    "cron" or "event"; `event` is the wake kind ("session.done" or a v1 event) or
    None for cron; `refs` is the (validated) item tokens or []. `ts` is epoch
    seconds (0 if the log line's leading timestamp is unparseable -- never raises);
    `at` is the raw leading token for display. [] when the log is absent/unreadable
    or holds no handoffs. Streamed read (deque tail) so a multi-MB log never loads
    whole. See the COUPLING note above for the emit-string contract."""
    try:
        with open(path, errors="replace") as fh:
            lines = deque(fh, maxlen=scan)
    except OSError:
        return []
    out = []
    for raw in lines:
        parts = raw.rstrip("\n").split(None, 1)
        if len(parts) < 2:
            continue  # no body after the leading timestamp
        at, rest = parts[0], parts[1]
        ts = iso_epoch(at)
        # re.search (not ^-anchored): any leading lane-label prefix log() injected
        # -- including a label containing ']' -- is skipped over, never mis-parsed.
        m = _CHOREO_CRON.search(rest)
        if m:
            out.append({"ts": ts, "at": at, "kind": "cron",
                        "role": m.group(1), "event": None, "refs": []})
            continue
        m = _CHOREO_DONE.search(rest)
        if m:
            out.append({"ts": ts, "at": at, "kind": "event",
                        "role": m.group(1), "event": "session.done", "refs": []})
            continue
        m = _CHOREO_EVENT.search(rest)
        if m:
            event = m.group(2)
            refs = m.group(3).split()
            if not _choreo_refs_ok(event, refs):
                continue  # fail-safe: empty / malformed refs -> not a real handoff
            out.append({"ts": ts, "at": at, "kind": "event",
                        "role": m.group(1), "event": event, "refs": refs})
    return out[-keep:]


# --- engine version truth (#166 slice 1) ------------------------------------
# The two thin shells (bin/supervisor.sh, bin/dashboard.py) freeze their own
# code at process start (bash function bodies / Python imports), so a merged fix
# to a shell is silently NOT live until a restart -- which looks identical to
# "the fix didn't work". Slice 1 is truth only: each service records the engine
# sha it booted from; the dashboard compares against the engine checkout's
# current HEAD and shows a chip when they diverge. Fail-safe throughout: a
# corrupt/unreadable sha never manufactures a false stale, and an unreadable
# current HEAD reports nothing stale (never cry wolf). Slice 2 (safe
# self-refresh) is out of scope.

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def _engine_home(engine_home=None):
    """The engine checkout: an explicit arg wins, else the exported
    AUTONOMY_ENGINE_HOME (the one contract bin/supervisor.sh sets), else the
    path this file lives under (lib/ -> engine root)."""
    if engine_home:
        return engine_home
    return os.environ.get("AUTONOMY_ENGINE_HOME") or os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))


def engine_head_sha(engine_home=None):
    """The engine checkout's current HEAD sha, or "" on ANY failure (missing
    git, not a repo, timeout). Read fresh each request -- it advances as merges
    land and the checkout is updated."""
    try:
        out = subprocess.run(
            ["git", "-C", _engine_home(engine_home), "rev-parse", "HEAD"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ""
    if out.returncode != 0:
        return ""
    sha = out.stdout.decode("ascii", "replace").strip()
    return sha if _SHA_RE.match(sha) else ""


def read_engine_boot_sha(logdir):
    """The sha a supervisor recorded at boot (bin/supervisor.sh writes
    <logdir>/engine_sha once). Returns "" unless the value is a full 40-char
    lowercase hex sha -- a torn / corrupt / manual file is treated as absent so
    it can never manufacture a false stale (fail-safe)."""
    try:
        with open(os.path.join(logdir, "engine_sha"), errors="replace") as fh:
            val = fh.readline().strip()
    except OSError:
        return ""
    return val if _SHA_RE.match(val) else ""


def engine_commits_behind(running, current, engine_home=None):
    """How many commits `current` has that `running` does not
    (`git rev-list --count running..current`). None when unknowable (either sha
    empty, git fails). Valid even for divergent shas -- it's "new commits the
    running process is missing"; staleness itself is decided by the string
    compare in engine_status, this is display sugar only. Never raises."""
    if not running or not current:
        return None
    try:
        out = subprocess.run(
            ["git", "-C", _engine_home(engine_home), "rev-list", "--count",
             "%s..%s" % (running, current)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    try:
        return int(out.stdout.decode("ascii", "replace").strip())
    except ValueError:
        return None


def engine_status(dashboard_boot, repos, head_reader=engine_head_sha,
                  behind_reader=engine_commits_behind):
    """Compose the engine 'update available' truth block for collect()'s
    payload. `dashboard_boot` is the sha bin/dashboard.py captured at import;
    `repos` is the per-repo state list (each carries `engine_boot` +
    `lifecycle`). Readers are injectable for tests. A service is stale when the
    current HEAD is readable, its boot sha is known, and they differ. A
    supervisor contributes when its lifecycle state is running OR paused (a
    paused loop still runs old code); a LIVE supervisor whose boot sha is
    unknowable is flagged stale too (hiding an unknown is fail-open). `behind`
    per service is the commit count, computed only when a known sha differs
    (display sugar; None for unknown-sha). Top-level `behind` = max across
    stale services. When current HEAD is unreadable, nothing is stale."""
    current = head_reader() or ""

    def _service(boot):
        stale = bool(current and boot and boot != current)
        behind = behind_reader(boot, current) if stale else None
        return stale, behind

    d_stale, d_behind = _service(dashboard_boot)
    dashboard = {"sha": dashboard_boot, "behind": d_behind, "stale": d_stale}

    supervisors = []
    for r in repos:
        # Only a LIVE loop (running OR paused -- a paused loop still runs old
        # code) matters. Gate on lifecycle STATE, not a raw pid: a stopped
        # supervisor keeps its stale lock pid, which would otherwise fake a
        # restart chip for a process that isn't running (Codex CP2).
        if (r.get("lifecycle") or {}).get("state") not in ("running", "paused"):
            continue
        boot = r.get("engine_boot") or ""
        valid = bool(_SHA_RE.match(boot))
        if not current:
            s_stale, s_behind = False, None          # no reference -> never cry wolf
        elif not valid:
            # Live loop whose boot sha is unknowable (pre-feature supervisor that
            # never wrote the file, or a torn write): we can't prove it's current,
            # so flag it -- hiding an unknown is fail-OPEN against #166's truth
            # goal (Codex CP2). Fail-safe direction = surface the restart hint.
            s_stale, s_behind = True, None
        else:
            s_stale, s_behind = _service(boot)
        supervisors.append({"repo": r.get("name", ""),
                            "sha": boot if valid else "",
                            "behind": s_behind, "stale": s_stale})

    behinds = [s["behind"] for s in supervisors if s["stale"]
               and s["behind"] is not None]
    if dashboard["stale"] and dashboard["behind"] is not None:
        behinds.append(dashboard["behind"])
    stale = dashboard["stale"] or any(s["stale"] for s in supervisors)
    return {
        "current": current,
        "dashboard": dashboard,
        "supervisors": supervisors,
        "stale": stale,
        "behind": max(behinds) if behinds else None,
    }


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


def _session_role(logpath):
    """The dispatched role for a session log, read from the `session-<ts>.role`
    sidecar the supervisor writes at dispatch (#148). '' when the marker is
    absent/unreadable -- older logs predate it and the loop is fail-safe, so the
    card just falls back to its default badge rather than guessing from prose."""
    if not logpath:
        return ""
    marker = logpath[:-4] + ".role" if logpath.endswith(".log") else logpath + ".role"
    try:
        with open(marker, encoding="utf-8", errors="replace") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def recent_sessions(logdir, limit=10):
    """Summaries of the most recent session logs (newest first, up to `limit`)
    for the history panel (#148 part 2). Each entry: the log filename, the
    dispatched `role` (from the `session-<ts>.role` sidecar part 1 writes),
    started_at/started_epoch, duration (s), outcome
    (clean|error|rate-limited|running), output tokens, and the worked ticket
    (pick_ticket heuristic, reused from the full parse). Derives entirely from
    files already on disk -- NO gh in the state path (#80). Idle past logs hit
    the mtime parse cache, so this stays cheap after warm-up. [] when empty."""
    try:
        names = sorted(n for n in os.listdir(logdir)
                       if n.startswith("session-") and n.endswith(".log"))
    except OSError:
        return []
    out = []
    for name in reversed(names[-limit:]):
        path = os.path.join(logdir, name)
        # best-effort PER artifact (#148): one corrupt older log/sidecar must
        # degrade its own row, never break the whole /api/state response.
        try:
            s = parse_session_log_cached(path)
        except Exception:
            s = None
        if not s:
            continue
        started = s.get("started_epoch") or 0
        updated = s.get("updated_at") or 0
        duration = updated - started if (started and updated >= started) else 0
        status = str(s.get("status") or "")
        if s.get("rate_limited"):
            outcome = "rate-limited"
        elif status == "done-error":
            outcome = "error"
        elif status == "done-ok":
            outcome = "clean"
        else:
            outcome = "running"
        out.append({
            "log": name,
            "role": _session_role(path),
            "started_at": s.get("started_at") or "",
            "started_epoch": started,
            "duration": duration,
            "outcome": outcome,
            "tokens": s.get("output_tokens") or 0,
            "ticket": s.get("ticket"),
            "ticket_source": s.get("ticket_source"),
            "model": s.get("model") or "",
        })
    return out


def recent_quota_windows(logdir, limit=60):
    """Account rate-limit windows merged across recent session logs, scanned
    NEWEST-FIRST with an early stop. Per window type keep the CURRENT window
    (max resets_at) and, within it, the PEAK utilization.

    Why scan many, newest-first, and stop early:
    - Anthropic emits five_hour and seven_day events INTERMITTENTLY, and at very
      different rates: five_hour lands in ~every session log, but seven_day is
      SPARSE -- observed ~18 logs back. A small fixed window (the old 12) reaches
      five_hour but never the weekly, blanking it on the header. So walk
      newest-first up to `limit` and stop as soon as BOTH windows are populated
      (usually well before the cap); the cap only bounds the work when seven_day
      is genuinely absent from recent history.
    - within a window, utilization only climbs until a reset; a later spurious
      LOW reading at the same resets_at (a rejected event in a session that just
      hit the limit) must NOT override the real peak, or the bar reads 0% right
      after the account maxed out. Keeping the max utilization at a given
      resets_at fixes that. Because seven_day is the limiting (sparse) window,
      the five_hour peak is captured across all the logs walked before we reach
      it. {} when none found."""
    try:
        names = sorted(n for n in os.listdir(logdir)
                       if n.startswith("session-") and n.endswith(".log"))
    except OSError:
        return {}
    merged = {}
    for name in reversed(names[-limit:]):   # newest first -> early stop when both found
        for wt, win in parse_quota_windows(os.path.join(logdir, name)).items():
            cur = merged.get(wt)
            # .get(..., 0) keeps the merge degrading gracefully rather than
            # KeyError-ing if a producer ever hands back a partial window dict.
            w_reset, w_util = win.get("resets_at", 0), win.get("utilization", 0)
            if cur is None:
                merged[wt] = win
                continue
            c_reset, c_util = cur.get("resets_at", 0), cur.get("utilization", 0)
            if w_reset > c_reset or (w_reset == c_reset and w_util > c_util):
                merged[wt] = win
        if "five_hour" in merged and "seven_day" in merged:
            break                           # both windows found; older logs only staler
    return merged


def token_timeline(logdir, now, window_secs=86400, bucket_secs=900):
    """Backfilled tokens-over-time series (#188a) for the tokens chart, replacing
    the instantaneous 0-tok/min readout. Output tokens are summed into fixed
    `bucket_secs` buckets (default 15 min) across the trailing `window_secs`
    window ending at `now`; buckets are zero-filled and returned oldest-first so
    the chart draws a continuous axis, each `{"bucket": <epoch-start>, "tokens":
    <int>}`.

    Backfilled ENTIRELY from the session-*.log totals already on disk -- NO gh
    (state stays off the network, #80), and NO live sampler: a session carries a
    per-session TOTAL, not intra-session throughput, so it becomes ONE point at
    its accrual bucket rather than a curve spread across the buckets it spanned.
    Spreading it would fabricate a shape we never measured -- degrade to truth,
    never guess. The accrual instant is the log's MTIME (a tz-safe real epoch,
    unlike the LOCAL-time filename): the last write, i.e. session end for a
    finished log and ~now for a live one (both the honest 'when these tokens
    landed'). Best-effort per artifact like recent_sessions/recent_quota_windows:
    a missing/unreadable dir -> [], one corrupt log or un-stattable file degrades
    only its own contribution. [] on a non-positive window/bucket (no series to
    draw)."""
    try:
        now = int(now)
        window_secs = int(window_secs)
        bucket_secs = int(bucket_secs)
    except (TypeError, ValueError):
        return []
    if bucket_secs <= 0 or window_secs <= 0:
        return []
    last_bucket = (now // bucket_secs) * bucket_secs
    n_buckets = window_secs // bucket_secs
    if n_buckets <= 0:
        return []
    first_bucket = last_bucket - (n_buckets - 1) * bucket_secs
    try:
        names = [n for n in os.listdir(logdir)
                 if n.startswith("session-") and n.endswith(".log")]
    except OSError:
        return []
    sums = {}
    for name in names:
        path = os.path.join(logdir, name)
        try:
            mtime = int(os.stat(path).st_mtime)
        except OSError:
            continue                        # un-stattable file: skip, never raise
        if mtime < first_bucket or mtime > last_bucket + bucket_secs - 1:
            continue                        # outside the window -> not on this chart
        try:
            s = parse_session_log_cached(path)
        except Exception:
            continue                        # one corrupt log degrades only itself
        if not s:
            continue
        tok = s.get("output_tokens") or 0
        if tok <= 0:
            continue
        b = (mtime // bucket_secs) * bucket_secs
        sums[b] = sums.get(b, 0) + tok
    out = []
    b = first_bucket
    while b <= last_bucket:
        out.append({"bucket": b, "tokens": sums.get(b, 0)})
        b += bucket_secs
    return out


# The rate-limit window lengths Anthropic buckets utilization into -- the span
# between a window opening and its resets_at. Used to place the observed
# utilization on a burn timeline (there is no absolute token limit in the event,
# only the fraction). Keyed by parse_quota_windows' canonical types.
_QUOTA_WINDOW_SECS = {"five_hour": 5 * 3600, "seven_day": 7 * 24 * 3600}


def quota_forecast(windows, now):
    """Burn-rate exhaustion forecast per quota window (#188b) for the quota
    card's 'projected exhaustion + safe-to-keep-running' indicator. Pure
    extrapolation from the SAME utilization the dashboard already shows
    (recent_quota_windows / parse_quota_windows): no new data source, no gh, no
    token counts (the rate-limit event carries only the fraction).

    The forecast works in UTILIZATION space: a window opened at
    `resets_at - length`, so `elapsed = now - window_start` and the observed
    average burn is `utilization / elapsed` (fraction/sec). Extrapolating it
    linearly, utilization reaches 1.0 in `(1 - utilization) / burn` seconds. A
    real session is bursty, but the observed-average line never asserts a number
    we can't defend and is clearly a *forecast* -- the same degrade-to-truth
    discipline as token_timeline. Per window type it yields:
      projected_exhaust_epoch : when utilization would hit 1.0 at that rate
      exhausts_before_reset   : True iff that lands BEFORE resets_at (keep going
                                and you hit the wall before the window refills)
      resets_at               : passthrough for the countdown

    A window is OMITTED (no honest forecast) when its length is unknown, when
    `elapsed <= 0` (a resets_at further out than the window length -- clock skew
    / a stale event), or when `utilization <= 0` (no burn to extrapolate). A
    window already at/over the limit (`utilization >= 1`) is reported as
    exhausted now. {} for a non-mapping input -- best-effort like its siblings."""
    if not isinstance(windows, dict):
        return {}
    try:
        now = int(now)
    except (TypeError, ValueError):
        return {}
    out = {}
    for wt, win in windows.items():
        length = _QUOTA_WINDOW_SECS.get(wt)
        if length is None or not isinstance(win, dict):
            continue
        resets_at = win.get("resets_at")
        util = win.get("utilization")
        if not isinstance(resets_at, (int, float)) or not isinstance(util, (int, float)):
            continue
        resets_at = int(resets_at)
        util = float(util)
        if util >= 1.0:                                 # already exhausted / overage
            out[wt] = {"projected_exhaust_epoch": now,
                       "exhausts_before_reset": resets_at > now,
                       "resets_at": resets_at}
            continue
        if util <= 0.0:                                 # no burn to extrapolate
            continue
        elapsed = now - (resets_at - length)
        if elapsed <= 0:                                # window_start in the future
            continue
        # burn = util/elapsed; time to 1.0 = (1-util)/burn = (1-util)/util*elapsed
        secs_to_full = (1.0 - util) / util * elapsed
        projected = now + int(secs_to_full)
        out[wt] = {"projected_exhaust_epoch": projected,
                   "exhausts_before_reset": projected < resets_at,
                   "resets_at": resets_at}
    return out


def trigger_health(config, cron_dir, now, grace_secs=300):
    """Missed cron-fire detection (#188c) for the control room's trigger-health
    signal -- the 2026-07-03 swept-state incident named the real gap: a
    stalled/backed-off scheduler renders identically to a healthy idle one.

    Compares each cron role's persisted last_fire marker
    ($VARDIR/cron/<role>.last_fire, a raw epoch int -- see
    bin/supervisor.sh:resolve_cron_due, the sole writer) against the SAME
    schedule math the supervisor itself uses (roles.cron_next_fire), so this
    reader can never drift from what actually fires (the single-source-of-
    truth discipline #117 established for the lock path). lane=None (the
    default lane) mirrors roles.cron_roles' own default and the scheduler's
    enumeration for a repo with no `lanes:` block (zero behaviour change);
    dashboards have no lane context yet (#147's still-open dashboard slice).

    A role's next expected fire strictly after its marker is
    `roles.cron_next_fire(schedule, last_fire)`. If that epoch is more than
    `grace_secs` in the past, the supervisor should have advanced the marker
    (fired, or re-armed on a corrupt/missing one) by now and did not --
    `missed` is True.

    Returns one entry per cron role, stable order:
      {"role", "schedule", "last_fire" (epoch or None), "expected_next"
       (epoch or None), "missed" (bool)}
    A role with no marker yet (never armed -- e.g. freshly configured, or the
    cron dir doesn't exist) reports last_fire=None, missed=False: degrade to
    'unknown', never assert a miss with no baseline to compare against
    (fail-safe -- never fabricate an alarm from absence of data). Same
    degrade for a corrupt/unreadable marker (mirrors the supervisor's own
    reinitialise-without-firing recovery) and for an unparseable schedule
    (expected_next is None, so nothing to compare -- never missed). {} input
    or a read failure degrades to [] like its #188 siblings."""
    if not isinstance(config, dict):
        return []
    try:
        now = int(now)
        grace_secs = int(grace_secs)
    except (TypeError, ValueError):
        return []
    try:
        cron = roles_schema.cron_roles(config, None)
    except Exception:
        return []
    out = []
    for name, schedule in cron:
        last_fire = None
        try:
            with open(os.path.join(cron_dir, "%s.last_fire" % name)) as fh:
                raw = fh.read().strip()
        except OSError:
            raw = ""
        if raw.isdigit():
            last_fire = int(raw)
        expected_next = None
        missed = False
        if last_fire is not None:
            try:
                expected_next = roles_schema.cron_next_fire(schedule, last_fire)
            except Exception:
                expected_next = None
            if expected_next is not None and expected_next < now - grace_secs:
                missed = True
        out.append({"role": name, "schedule": schedule, "last_fire": last_fire,
                    "expected_next": expected_next, "missed": missed})
    return out


def read_config_overlay(path):
    """The PERSISTENT operator overrides (#202) the dashboard displays. Unlike
    the one-shot read_model_override, this RE-VALIDATES each value with the
    same rules the supervisor applies (dashboard_control.MODEL_RE /
    VALID_EFFORTS), so a corrupt overlay is rejected identically on both
    surfaces -- the card can never show a value the supervisor silently
    ignores. Returns {} on any error / absent file (fail-safe)."""
    out = {}
    try:
        with open(path, errors="replace") as fh:
            for raw in fh:
                # Parse EXACTLY as the supervisor's bash read_config_overlay does
                # (`${line%%=*}` / `${line#*=}` after `read -r`): split on the
                # first '=', strip ONLY the newline -- never the whole line. A
                # stray-space line (` model=x` / `model=x `) then fails the key
                # match / MODEL_RE just as it fails valid_model_id in bash, so
                # the dashboard can't display a value the supervisor ignores.
                key, sep, val = raw.rstrip("\n").partition("=")
                if not sep or not val:
                    continue
                if key in ("model", "fallback") and _dcx.MODEL_RE.match(val):
                    out[key] = val
                elif key == "effort" and val in _dcx.VALID_EFFORTS:
                    out[key] = val
                # #211: board identity overrides re-validate with the SAME
                # _valid_text the writer applies, so the card can never show a
                # value the config-page writer would have rejected.
                elif (key in ("board_owner", "board_project_title")
                      and _dcx._valid_text(val)):
                    out[key] = val
    except OSError:
        return {}
    return out


def _read_config(repo_path):
    cfg_path = os.path.join(repo_path, ".autonomy", "config.yaml")
    try:
        with open(cfg_path) as fh:
            cfg = config_parser.parse(fh.read())
    except OSError:
        return {"agent": "", "model": "", "merge_gate": "",
                "board_owner": "", "board_title": "", "overrides": {}}
    def g(key):
        try:
            return config_parser.get(cfg, key)
        except KeyError:
            return None
    roles = g("roles")
    # The overlay shadows committed config.yaml for model/effort so the page
    # shows the EFFECTIVE value the supervisor will use; `overrides` flags which
    # keys came from the overlay so the UI can label them "local override".
    overlay = read_config_overlay(os.path.join(
        repo_path, "var", "autonomy-logs", "config-overrides"))
    return {
        "agent": g("agent.type") or "",
        "model": overlay.get("model") or (g("agent.model.primary") or ""),
        "fallback": overlay.get("fallback") or (g("agent.model.fallback") or ""),
        "effort": overlay.get("effort") or (g("agent.effort") or ""),
        "merge_gate": g("merge_gate.strategy") or "",
        "board_owner": overlay.get("board_owner") or (g("board.owner") or ""),
        "board_title": (overlay.get("board_project_title")
                        or (g("board.project_title") or "")),
        "roles": roles if isinstance(roles, dict) else {},
        "overrides": overlay,
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
    if session is not None:
        # Attribute the live session to its role (#148). Copy first -- the parsed
        # dict is shared from an mtime cache; mutating it would poison the cache.
        session = dict(session)
        session["role"] = _session_role(latest)
    activity = activity_state(session, now)
    config = _read_config(repo_path)
    lifecycle = lifecycle_status(repo_path, pid_is_alive=pid_is_alive)
    status = display_status(lifecycle["state"], activity)
    quota = recent_quota_windows(logdir)   # scanned once; forecast reuses it
    return {
        "name": os.path.basename(repo_path.rstrip("/")),
        "path": repo_path,
        "lifecycle": lifecycle,
        "current_session": session,
        "activity": activity,
        "display_status": status,
        "roles": build_roles(config.get("roles"), status, now=now),
        "voice": read_supervisor_voice(os.path.join(logdir, "supervisor.log")),
        "choreography": read_choreography(os.path.join(logdir, "supervisor.log")),
        "heartbeat": read_heartbeat(os.path.join(logdir, "heartbeat")),
        "engine_boot": read_engine_boot_sha(logdir),  # #166: supervisor's boot sha
        "git": git_in_flight(repo_path) if git_in_flight else {},
        "config": config,
        # `config["merge_gate"]` is ALREADY the flattened strategy string
        # (_read_config does g("merge_gate.strategy")); NOT the nested block.
        # Reading "merge_gate.strategy" here would return None -> always manual.
        "merge_gate_chain": merge_gate_chain(config.get("merge_gate")),
        "override": read_model_override(os.path.join(logdir, "model-override")),
        "quota": quota,
        "sessions": recent_sessions(logdir),
        "token_timeline": token_timeline(logdir, now),
        "quota_forecast": quota_forecast(quota, now),
        "trigger_health": trigger_health(config, os.path.join(repo_path, "var", "cron"), now),
    }
