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
import health as health_mod      # wedged truth, single-sourced (SD-32 §9)
import roles as roles_schema

_TICKET_RE = re.compile(r"#(\d{1,6})\b")
# in-session branch creation: `git checkout -b|-B <name>` / `git switch -c|-C <name>`
_BRANCH_CREATE_RE = re.compile(r"(?:checkout\s+-[bB]|switch\s+-[cC])\s+['\"]?([^\s'\";&|]+)")
# the engine's own board write: board.sh status <n> "<Status>"
_BOARD_STATUS_RE = re.compile(r"board\.sh['\"]?\s+status\s+(\d{1,6})\s+['\"]?([A-Za-z][A-Za-z ]*)")
# #312 Slice B: run_all.sh's terminal verdict markers, LINE-EXACT (^...$,
# MULTILINE). Line-exactness is one of the two honesty gates: the run PRINTS
# the bare marker on its own line, while quoting the script's source (cat/grep
# in a tool_result) yields `...echo "ALL SUITES PASS"...` -- never a bare line.
_GATE_GREEN_RE = re.compile(r"^ALL SUITES PASS$", re.MULTILINE)
_GATE_RED_RE = re.compile(r"^ONE OR MORE SUITES FAILED$", re.MULTILINE)
# The other honesty gate (CP1): a marker only counts inside the RESULT of a
# command that actually EXECUTED the gate -- run_all.sh in command position
# (bare or under bash/sh), or git push (the pre-push hook runs the gate; its
# output lands in the push's result). Merely MENTIONING run_all.sh is not
# enough (CP2): `grep -o 'ALL SUITES PASS' tests/run_all.sh` emits a bare
# marker line from a run_all-naming command -- so cat/grep/printf shapes
# never earn a gate id.
_GATE_CMD_RE = re.compile(
    # run_all.sh in COMMAND POSITION, bare or under bash/sh (with optional
    # shell flags). Anchoring applies to the bash/sh form too (#313 review
    # BLOCKING round 2): `echo "bash tests/run_all.sh"` names the gate inside
    # a string without executing it and must not earn a gate id.
    r"(?:^|[;&|(]\s*)(?:(?:bash|sh)\s+(?:-\S+\s+)*)?\S*run_all\.sh\b"
    # git push: command-position `git` with `push` as its actual SUBCOMMAND
    # (global options like -C <path> allowed between) -- git+push merely
    # CO-OCCURRING (`git commit -m "push fix"`, `echo git push`) must not
    # earn a gate id (#313 review WARNING).
    r"|(?:^|[;&|(]\s*)git\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*push\b")
# NO re.MULTILINE (#313 review round 3): a per-line `^` let any line of a
# multi-line string (heredoc body, embedded script) forge a gate id without
# executing anything. `^` = start of the WHOLE command only; a legit gate
# call on a later line of a multi-line command is missed and degrades to an
# EMPTY segment -- the fail-safe direction (miss evidence, never lie).

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
    tests_ran = None      # #312: latest gate verdict ("green"/"red") or None
    gate_tool_ids = set()  # tool_use ids whose command invoked the gate
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
                        if _GATE_CMD_RE.search(cmd) and block.get("id"):
                            gate_tool_ids.add(block.get("id"))
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
            elif t == "user":
                # tool_result content: the gate verdict (#312 Slice B), but
                # ONLY for results of a gate-invoking tool_use (gate_tool_ids).
                # The content field is a block list OR a plain string depending
                # on the emitter -- normalise to text, then line-exact-match
                # the run_all.sh terminal markers. Latest marker wins (a red
                # run followed by a green re-run is honestly green).
                blocks = (o.get("message") or {}).get("content")
                if not isinstance(blocks, list):
                    continue
                for block in blocks:
                    if (not isinstance(block, dict)
                            or block.get("type") != "tool_result"
                            or block.get("tool_use_id") not in gate_tool_ids):
                        continue
                    content = block.get("content")
                    if isinstance(content, str):
                        texts = [content]
                    elif isinstance(content, list):
                        texts = [c.get("text") or "" for c in content
                                 if isinstance(c, dict)
                                 and c.get("type") == "text"]
                    else:
                        continue
                    for text in texts:
                        g = None
                        for m in _GATE_GREEN_RE.finditer(text):
                            g = ("green", m.start())
                        for m in _GATE_RED_RE.finditer(text):
                            if g is None or m.start() > g[1]:
                                g = ("red", m.start())
                        if g:
                            tests_ran = g[0]
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
        "tests_ran": tests_ran,
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


def display_status(lifecycle_state, activity, health_state=None):
    """THE single source of truth for a repo's status label (#23).

    Collapses the orthogonal axes -- lifecycle (is the supervisor process
    alive / paused / absent), activity (is the session log fresh), and the
    wedged truth (#81 slice 2, SD-32 §9: lib/health.py's classify state) --
    into the one vocabulary every panel renders:

        working / stopping / idle / paused / stopped / needs-setup / missing /
        error / wedged

    Computed exactly once, server-side; the page must never re-derive it.
    Precedence: a terminal/absent lifecycle wins over stale session activity
    (a dead supervisor with an old log is 'stopped', never 'working'), and
    only a RUNNING lifecycle can be `wedged` -- a paused/dead supervisor is
    reported as such, not as a wedged worker. `wedged` must be EARNED from
    health.classify (prev-log #18): unknown/idle/ok/absent health leaves the
    two-axis label unchanged -- a health hiccup never fabricates an alarm."""
    if lifecycle_state in ("needs-setup", "missing", "error"):
        return lifecycle_state
    if lifecycle_state == "paused":
        # graceful stop requested: still finishing the current session ->
        # "stopping"; session over / gone quiet -> "paused"
        return "stopping" if activity == "working" else "paused"
    if lifecycle_state == "stopped":
        return "stopped"
    if health_state == "wedged":
        return "wedged"
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


def board_transitions(path):
    """Issue numbers with at least one OBSERVED board write, from board.sh's
    append-only transition log (#312 Slice B). Each line is
    `epoch\\tissue\\tstatus`, written only on a CONFIRMED Status mutation, so
    membership here is honest evidence for the phase track's `board` segment.

    Total by construction (feeds the whole-page render): a missing/unreadable
    file is the normal pre-Slice-B state and yields an empty set; a garbled
    line (fs hiccup, partial append) is skipped, never raised. Strict 3-field
    shape -- numeric epoch, numeric issue, non-empty status -- because the
    verdict is EARNED, not defaulted (prevention-log #18): absence of clean
    evidence keeps the segment EMPTY downstream."""
    issues = set()
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                parts = line.rstrip("\n").split("\t")
                if len(parts) != 3 or not parts[2] or not parts[0].isdigit():
                    continue
                try:
                    issues.add(int(parts[1]))
                except ValueError:
                    continue
    except OSError:
        return set()
    return issues


def focus_issue(focus):
    """The ISSUE number behind a focus_ticket, for keying #312 evidence.
    The three variants carry it differently (Codex CP1 catch): the open-PR
    variant's `number` is the PR NUMBER -- its issue ref is parsed from the
    branch name; the completed and issue-only variants' `number` IS the
    issue. None when it can't be honestly derived (evidence then stays
    empty -- a wrong key would light another ticket's milestones). Total:
    any malformed focus -> None."""
    if not isinstance(focus, dict) or not focus:
        return None
    if "ci" in focus or "review" in focus:
        return extract_ticket_ref(str(focus.get("branch") or ""))
    n = focus.get("number")
    return n if isinstance(n, int) else None


def _with_evidence(spine, evidence):
    """Insert the #312 evidence-only milestone segments into a fully-stamped
    gate spine: `board` at position 0, `tests` right after `branch`. Evidence
    marks are done/empty ONLY -- inserting after gate stamping keeps the
    frontier (`current`) logic byte-identical. A malformed (non-dict)
    evidence degrades to the legacy no-evidence track."""
    if not isinstance(evidence, dict):
        return spine
    board = {"step": "board",
             "state": "done" if evidence.get("board") else "empty"}
    verdict = evidence.get("tests")
    if verdict in ("green", "red"):
        tests = {"step": "tests", "state": "done", "verdict": verdict}
    else:
        tests = {"step": "tests", "state": "empty"}
    out = [board]
    for seg in spine:
        out.append(seg)
        if seg.get("step") == "branch":
            out.append(tests)
    return out


def phase_track(focus, gate_chain, evidence=None):
    """The selected-lane center-zone phase track (#187 UI-4): the configured
    gate spine marked by OBSERVED GitHub-flow facts, per ticket.

    #312 Slice B: `evidence` (optional) carries the two SD-32 observed-
    milestone sources, pre-digested by the caller:
        {"board": bool, "tests": "green"|"red"|None}
    With evidence present, a `board` segment (position 0) and a `tests`
    segment (right after `branch`) join the spine as EVIDENCE-ONLY marks:
    `done` when the fact was observed (tests also carry a `verdict`),
    `empty` otherwise -- never `current`, never `outline`, and never
    inferred from ticket state (a completed ticket with no logged board
    write keeps an EMPTY board segment: certainty is earned, prevention-log
    #18). They are inserted AFTER gate stamping (_with_evidence), so the
    Slice A frontier logic is untouched by construction. A malformed
    (non-dict) evidence degrades to the legacy no-evidence track; a falsy
    focus stays [] -- evidence never conjures a phantom spine.

    The spine is a leading `branch` step + `merge_gate_chain(strategy)` (so the
    configured layer -- what a PR must still clear -- is drawn straight from the
    repo's OWN merge_gate, never a template). Each segment is then stamped with
    a `state` derived ONLY from facts the focus_ticket already carries:

        done     observed to have happened      (SOLID)
        current  the single live frontier gate  (the gate now being awaited)
        outline  configured but not yet reached (OUTLINE)

    The acceptance test (settled with the operator) is that the track must NEVER
    imply certainty it lacks. That is enforced by construction: a step is `done`
    only when an observed fact asserts it; unreached gates stay `outline`, never
    guessed; and the three focus_ticket variants map to exactly the facts they
    hold --
        completed (`completed`/`merged_epoch`)  -> every step done
        open PR   (carries live `ci`/`review`)  -> branch+pr done; review done
                                                    iff approved; the next
                                                    unreached gate is `current`
        issue     (session ticket, no PR yet)    -> branch is `current` while a
                                                    session is in progress, else
                                                    `done`; gates ahead outline

    Total by construction: this feeds build_repo_state()/the whole-page render,
    so it must never raise. A falsy focus yields []; a malformed gate_chain
    (non-list, or junk entries) degrades to the one certain fact -- a branch
    exists -- rather than inventing a tail. Segments are COPIED, never mutated
    in place, so the shared merge_gate_chain the caller passes is left clean."""
    # Builder-totality: a falsy OR non-dict focus (a malformed focus_ticket)
    # must yield [] rather than raise on `.get()` -- this feeds the whole-page
    # render inside _collect_one's per-repo try, and a raise would blank the repo.
    if not isinstance(focus, dict) or not focus:
        return []
    # spine = the one universal fact (a branch) + the configured gate tail.
    # Copy each configured segment so stamping `state` never poisons the shared
    # merge_gate_chain list build_repo_state hands us.
    spine = [{"step": "branch"}]
    if isinstance(gate_chain, list):
        for seg in gate_chain:
            if isinstance(seg, dict) and seg.get("step"):
                spine.append(dict(seg))

    # completed: a merged PR closed this ticket -- every configured milestone is
    # observably behind us.
    if focus.get("completed") or focus.get("merged_epoch"):
        for seg in spine:
            seg["state"] = "done"
        return _with_evidence(spine, evidence)

    # open PR: the open-PR focus variant carries live gate state (`ci`/`review`,
    # co-set at the single construction site in bin/dashboard.py from the top
    # open PR) -- neither the completed nor the issue-only variant has them, so
    # their presence is the reliable "an open PR exists" discriminator. branch+pr
    # are observed done; review is done only when actually approved.
    if "ci" in focus or "review" in focus:
        done_steps = {"branch", "pr"}
        if (focus.get("review") or "") == "approved":
            done_steps.add("review")
        marked_current = False
        for seg in spine:
            if seg["step"] in done_steps:
                seg["state"] = "done"
            elif not marked_current:
                seg["state"] = "current"   # the single live frontier gate
                marked_current = True
            else:
                seg["state"] = "outline"
        return _with_evidence(spine, evidence)

    # issue-only (a session ticket with no open PR yet): the branch is the only
    # real milestone. It is the live frontier while a session is in progress,
    # otherwise an observed-past fact; every gate ahead is not yet real.
    for i, seg in enumerate(spine):
        if i == 0:
            seg["state"] = "current" if focus.get("in_progress") else "done"
        else:
            seg["state"] = "outline"
    return _with_evidence(spine, evidence)


# The engine-standard workflow label that marks an issue as awaiting a human
# decision -- the untriaged "needs you" queue (#189). Repo-agnostic: `needs-design`
# is scaffolded by `onboard` on every target (settled-decision 24), so it is
# engine vocabulary, NOT a target-repo-specific value. A repo's own extra
# human-decision labels (e.g. this repo's `needs-spec`) are deliberately NOT baked
# in here -- broadening this set, ideally config-driven, is a follow-up that pairs
# with the PM rail (#89) once it emits structured triaged questions. Display-only
# routing signal (#23); the tuple shape keeps that a one-line change.
NEEDS_YOU_LABELS = ("needs-design",)


def parse_needs_you(raw):
    """Parse `gh issue list --json number,title,url,labels,updatedAt` output into
    the untriaged needs-you list, newest first (#189 degraded state). Total: any
    bad input (None / non-JSON / non-list / malformed shape) degrades to [] or a
    skipped entry -- never raises. An entry is KEPT only if it has an int number
    AND at least one NEEDS_YOU_LABELS label, so a broadened/mocked query can never
    surface an unrelated issue as 'needs you' (fail-safe filter, settled 4/6;
    display-only, #23)."""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    wanted = set(NEEDS_YOU_LABELS)
    out = []
    for it in data:
        if not isinstance(it, dict):
            continue
        num = it.get("number")
        # bool is an int subclass -- exclude it explicitly.
        if not isinstance(num, int) or isinstance(num, bool):
            continue
        raw_labels = it.get("labels")
        labels = []
        if isinstance(raw_labels, list):
            for lb in raw_labels:
                if isinstance(lb, dict) and isinstance(lb.get("name"), str):
                    labels.append(lb["name"])
        if not wanted.intersection(labels):
            continue
        title = it.get("title")
        url = it.get("url")
        at = it.get("updatedAt")
        out.append({
            "number": num,
            "title": title if isinstance(title, str) else "",
            "url": url if isinstance(url, str) else "",
            "labels": labels,
            "updated_at": at if isinstance(at, str) else "",
            # #189 triaged escalation: the PM's fenced autonomy-question block,
            # or None when the issue carries no valid one (degrades to the
            # untriaged row). Total -- comments absent/malformed => None.
            "question": parse_autonomy_question(it.get("comments")),
        })
    out.sort(key=lambda i: i["updated_at"], reverse=True)
    return out


# #189 (SD-32 §8): the PM question contract IS the escalation schema. An
# escalating role posts ONE issue comment holding a fenced ```autonomy-question
# JSON block with EXACTLY these six keys. The triaged card renders it; anything
# else (absence/garbage) degrades to the shipped untriaged row (#235). Strict by
# design -- a lenient parser that accepts extra keys or coerces a bad `answers`
# would be fail-open, surfacing a half-formed question as if triaged.
_AUTONOMY_Q_KEYS = frozenset(("question", "recommendation", "reasoning_quote",
                              "effort_sunk", "default_if_ignored", "answers"))
_AUTONOMY_Q_STRINGS = ("question", "recommendation", "reasoning_quote",
                       "effort_sunk", "default_if_ignored")
# Tolerant of a trailing-whitespace info string and CRLF; the block body is the
# lazily-captured group up to the closing fence. re.search returns the FIRST
# block in a comment (deterministic when a comment holds more than one).
_AUTONOMY_Q_FENCE = re.compile(
    r"```[ \t]*autonomy-question[ \t]*\r?\n(.*?)\r?\n?```", re.DOTALL)


def _valid_autonomy_question(obj):
    """The strict schema gate (SD-32 §8): an object with EXACTLY the six keys,
    five strings + `answers` a list of 1..3 strings. Any deviation -> None."""
    if not isinstance(obj, dict) or set(obj.keys()) != set(_AUTONOMY_Q_KEYS):
        return None
    for k in _AUTONOMY_Q_STRINGS:
        if not isinstance(obj.get(k), str):
            return None
    ans = obj.get("answers")
    if not isinstance(ans, list) or not (1 <= len(ans) <= 3):
        return None
    if any(not isinstance(a, str) for a in ans):
        return None
    return obj


def parse_autonomy_question(comments):
    """Extract the PM-triaged escalation (#189) from an issue's `comments` list
    (gh dicts with `body`, `createdAt`). The NEWEST comment CONTAINING an
    autonomy-question fence is authoritative: a later prose-only comment does not
    mask an earlier question, and if that newest block is garbage the whole thing
    degrades to None (never falls back to an older valid block). Total: any bad
    input (None / non-list / no fence / bad json / schema mismatch) -> None."""
    if not isinstance(comments, list):
        return None
    candidates = []  # (createdAt, block-text) for each comment holding a fence
    for c in comments:
        if not isinstance(c, dict):
            continue
        body = c.get("body")
        if not isinstance(body, str):
            continue
        m = _AUTONOMY_Q_FENCE.search(body)
        if not m:
            continue
        at = c.get("createdAt")
        candidates.append((at if isinstance(at, str) else "", m.group(1)))
    if not candidates:
        return None
    # ISO-8601 timestamps sort lexically; the newest fence-bearing comment wins.
    candidates.sort(key=lambda x: x[0])
    try:
        obj = json.loads(candidates[-1][1])
    except (ValueError, TypeError):
        return None
    return _valid_autonomy_question(obj)


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


# The sweep's stall-flag marker (#292, board.sh board_stall_flag) -- the oid
# binds the flag to the head it verdicted, so a new push (gate reset) drops it.
_STALL_MARKER_RE = re.compile(r"autonomy-stall-flag\s+([0-9A-Za-z]+)")
_STALL_AGE_RE = re.compile(r"unmerged for (\d+)m")


def parse_stall_flag(comments, head_oid, now):
    """#292 piece 2: the sweep's approved-but-unmerged flag for a PR, or None.

    The dashboard deliberately does NOT re-parse review verdicts -- that
    parity contract (mirror safe_merge's gate bug-for-bug) lives in board.sh
    alone, and a third copy would drift. Instead this renders the detector's
    own output: the latest PR comment whose `autonomy-stall-flag <oid>`
    marker matches the CURRENT head oid. A push moves the head, the marker
    stops matching, the chip drops -- same reset semantics as the gate.

    Returns {"age_min": <int, stalled-for now>, "flagged_epoch": <int>} or
    None. age_min = the age the sweep stated in the flag body plus the time
    since it was posted (falls back to time-since-flag when the body's age is
    absent). Total: any malformed input -> None, never raises."""
    if not head_oid or not isinstance(comments, list):
        return None
    flag = None
    for c in comments:
        if not isinstance(c, dict):
            continue
        body = c.get("body")
        if not isinstance(body, str):
            continue
        m = _STALL_MARKER_RE.search(body)
        if m and m.group(1) == head_oid:
            flag = c
    if flag is None:
        return None
    flagged_epoch = iso_epoch(flag.get("createdAt"))
    if not flagged_epoch:
        return None
    stated = 0
    m = _STALL_AGE_RE.search(flag.get("body") or "")
    if m:
        try:
            stated = int(m.group(1))
        except ValueError:
            stated = 0
    try:
        age_min = stated + max(0, (int(now) - flagged_epoch) // 60)
    except (TypeError, ValueError, OverflowError):
        return None
    return {"age_min": age_min, "flagged_epoch": flagged_epoch}


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


def _role_last_run(sessions, role_name):
    """The most recent session dispatched to `role_name`, as
    {at: started_epoch, outcome}, or None if that role has no session in the
    list (#185 fleet rail's per-role 'last <when> <outcome>' stat). Read off
    recent_sessions -- role sidecar + outcome are already parsed there -- which
    is newest-first, so the first match is the most recent. Pure + total: a
    session missing its epoch degrades to 0 rather than raising."""
    for s in sessions or []:
        if s.get("role") == role_name:
            return {"at": s.get("started_epoch") or 0, "outcome": s.get("outcome") or ""}
    return None


def build_roles(config_roles, coder_status, now=None, sessions=None):
    """The per-repo role roster for the page. The standard four always render
    (Coder live; PM/QA/Researcher as not-configured placeholders unless the
    pack declares them), plus any custom roles the pack adds. `config_roles` is
    the parsed `roles:` mapping (may be empty). `coder_status` is the repo's
    unified display_status (#23) -- the coder row shows the SAME label as the
    repo badge, never a separately-derived one. `now` enables the cron
    next-fire countdown (#18). `sessions` (recent_sessions() output) enriches
    each row with `last_run` -- the newest session dispatched to that role
    (#185); None-safe, so callers without the history just get last_run=None."""
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
                      "next_fire": _role_next_fire(cfg, enabled and bool(cfg), now),
                      "last_run": _role_last_run(sessions, name)})
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
            "last_run": _role_last_run(sessions, name),
        })
    return roles


def planner_agent_info(repo_path):
    """SD-33 pair: the planner subagent's model, read ONLY from the agent
    file's frontmatter (.claude/agents/planner.md) -- never from config
    (per-phase `models:` stays a flagged no-op, SD-26). Total: a missing file
    is not-scaffolded (stated, never invented), garbage/absent frontmatter is
    scaffolded-with-unknown-model; never raises."""
    path = os.path.join(repo_path, ".claude", "agents", "planner.md")
    try:
        with open(path, errors="replace") as fh:
            text = fh.read()
    except OSError:
        return {"scaffolded": False, "model": ""}
    model = ""
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        for ln in lines[1:]:
            s = ln.strip()
            if s == "---":
                break
            if s.startswith("model:"):
                model = s.split(":", 1)[1].strip()
                break
    return {"scaffolded": True, "model": model}


def _org_trigger(cfg, default_kind):
    """(kind, detail) for a role's trigger, rendered honestly: the cron
    schedule / event name verbatim, 'round-robin' for the loop. A malformed
    trigger block degrades to the empty detail (the row's validity is judged
    by roles.validate_roles, not re-derived here)."""
    trig = cfg.get("trigger")
    trig = trig if isinstance(trig, dict) else {}
    kind = str(trig.get("type") or default_kind)
    if kind == "cron":
        return kind, str(trig.get("schedule") or "")
    if kind == "event":
        on = trig.get("on")
        if isinstance(on, list):
            return kind, ", ".join(str(x) for x in on)
        return kind, str(on or "")
    return kind, "round-robin"


def build_org(repo_path):
    """#326 slice 1: the Org & Workflow read model for /config -- the SD-33
    planner/coder pair plus the FULL merged role roster (standard four +
    custom) with honest trigger detail (loop round-robin / cron schedule /
    event name), scope labels, gate, per-role model/effort/account/lane and
    the #157 unwired-knob NOTEs. Validity comes from roles.validate_roles
    (the SSOT) -- a malformed or missing config renders `valid: False` with
    the error text, never blank/default cards (prevention-log 15/18); rows
    are still built best-effort so the page can badge them rather than
    vanish them."""
    cfg_path = os.path.join(repo_path, ".autonomy", "config.yaml")
    error = ""
    config = {}
    try:
        with open(cfg_path) as fh:
            config = config_parser.parse(fh.read())
        if not isinstance(config, dict):
            config, error = {}, "config.yaml did not parse to a mapping"
    except OSError as exc:
        error = "config.yaml unreadable: %s" % exc
    except Exception as exc:   # parser error -- surfaced, never a blank card
        error = "config.yaml parse error: %s" % (exc or exc.__class__.__name__)
    if not error:
        errors = roles_schema.validate_roles(config)
        if errors:
            error = "; ".join(errors)

    # overlay-aware EFFECTIVE coder values. _read_config re-parses the same
    # file and only guards OSError, so a syntax-invalid config would raise
    # through it (CP2) -- build_org must stay TOTAL: fall back to empty
    # effective values; the parse error is already in `error` above.
    try:
        eff = _read_config(repo_path)
    except Exception:
        eff = {}
    pair = {
        "planner": planner_agent_info(repo_path),
        "coder": {"model": eff.get("model", ""),
                  "fallback": eff.get("fallback", ""),
                  "effort": eff.get("effort", "")},
    }

    config_roles = config.get("roles") if isinstance(config.get("roles"), dict) else {}

    def row(name, cfg, configured, enabled, default_kind):
        cfg = cfg if isinstance(cfg, dict) else {}
        kind, detail = _org_trigger(cfg, default_kind)
        scope = cfg.get("scope") if isinstance(cfg.get("scope"), dict) else {}
        labels = scope.get("labels") if isinstance(scope.get("labels"), list) else []
        return {
            "name": name,
            "configured": configured,
            "enabled": enabled,
            "trigger_kind": kind,
            "trigger_detail": detail,
            "scope_labels": [str(x) for x in labels],
            "gate": str(cfg.get("gate") or ""),
            "model": str(cfg.get("model") or ""),
            "effort": str(cfg.get("effort") or ""),
            "account": str(cfg.get("account") or ""),
            "lane": roles_schema.lane_of_role(config, name),
            "notes": roles_schema.unwired_knob_notes(name, cfg) if cfg else [],
        }

    rows = []
    for name, d_enabled, _d_sub, d_trig in _STANDARD_ROLES:
        cfg = config_roles.get(name) or {}
        configured = bool(cfg)
        enabled = _as_bool(cfg.get("enabled")) if "enabled" in cfg else (d_enabled if configured or name == "coder" else False)
        rows.append(row(name, cfg, configured or name == "coder", enabled, d_trig))
    standard = tuple(r[0] for r in _STANDARD_ROLES)
    for name, cfg in config_roles.items():
        if name in standard:
            continue
        cfg = cfg if isinstance(cfg, dict) else {}
        rows.append(row(name, cfg, True, _as_bool(cfg.get("enabled")), "loop"))

    return {"valid": not error, "error": error, "pair": pair, "roles": rows}


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
    the spirit of the writer: a torn or partial file degrades to {}.

    #81 slice 5 (SD-32 'one implementation, zero drift'): the parse itself
    lives in lib/health.py -- this is a thin adapter keeping the historical
    contract: reads exactly `path` (health.read_heartbeat_file), {} on any
    failure (health returns None)."""
    return health_mod.read_heartbeat_file(path) or {}


def read_board_warning(path):
    """#90 item (a): board.sh's board-unresolved marker (EXACTLY 2 lines:
    epoch, one-line message <=512 chars). board.sh writes it when the
    configured Projects board fails to resolve and removes it on success;
    the render shows the message verbatim (detector->marker->chip, no
    re-derivation). TOTAL and STRICT: missing/torn/oversized/extra-lines/
    malformed -> None -- the warning chip is EARNED by a well-formed marker,
    never fabricated from corruption (prevention 12/18; oversize is rejected
    outright, not truncated-and-trusted)."""
    try:
        # Binary read: the <=4096 limit is a BYTE contract; a text-mode
        # read(4097) counts decoded chars and multi-byte UTF-8 could smuggle
        # an oversized file past it (review NITPICK on #311).
        with open(path, "rb") as f:
            raw_bytes = f.read(4097)
    except OSError:
        return None
    if len(raw_bytes) > 4096:
        return None
    raw = raw_bytes.decode("utf-8", errors="replace")
    lines = raw.splitlines()
    if len(lines) != 2:
        return None
    try:
        epoch = int(lines[0].strip())
    except ValueError:
        return None
    message = lines[1].strip()
    if not message or len(message) > 512:
        return None
    return {"epoch": epoch, "message": message}


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


def engine_checkout_behind_origin(engine_home=None):
    """#270: how many commits origin/main has that the serving checkout's HEAD
    does not -- i.e. merged updates the dashboard is not yet serving. `git fetch
    origin main` then `git rev-list --count HEAD..origin/main`. Returns the int
    count (0 == up to date), or None when unknowable.

    Fail-safe, never fail-open: a failed fetch (offline / no origin / detached
    with no remote), a failed rev-list, or any git/OS error returns None so the
    caller contributes NO staleness -- never an invented 'behind' and never a
    raise. Offline stays silent. `origin/main` is the engine's own default branch
    (this reads the engine checkout, not a target repo, so it is not the
    repo-agnostic surface)."""
    home = _engine_home(engine_home)
    try:
        fetched = subprocess.run(
            ["git", "-C", home, "fetch", "--quiet", "origin", "main"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    if fetched.returncode != 0:
        return None
    try:
        out = subprocess.run(
            ["git", "-C", home, "rev-list", "--count", "HEAD..origin/main"],
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
                  behind_reader=engine_commits_behind,
                  checkout_behind_reader=engine_checkout_behind_origin):
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

    # #270: the third axis -- the serving checkout vs origin/main. Orthogonal to
    # the process/supervisor boot-vs-HEAD compares: when merges land but the
    # checkout is un-pulled, boot == HEAD (both "current") while HEAD < origin.
    # None (fetch/rev-list failed / offline) or 0 contributes no staleness.
    co = checkout_behind_reader()
    co_stale = isinstance(co, int) and not isinstance(co, bool) and co > 0
    checkout = {"behind": co if co_stale else None, "stale": co_stale}

    behinds = [s["behind"] for s in supervisors if s["stale"]
               and s["behind"] is not None]
    if dashboard["stale"] and dashboard["behind"] is not None:
        behinds.append(dashboard["behind"])
    stale = (dashboard["stale"] or checkout["stale"]
             or any(s["stale"] for s in supervisors))
    return {
        "current": current,
        "dashboard": dashboard,
        "supervisors": supervisors,
        "checkout": checkout,
        "stale": stale,
        "behind": max(behinds) if behinds else None,
        "chip": engine_update_chip(dashboard, supervisors, checkout),
    }


def engine_update_chip(dashboard, supervisors, checkout=None):
    """The per-component render decision for the #196 update chip, kept here (not
    in the page's JS) so the branch logic that caused the #240 cry-wolf bug is
    exercised by run_all.sh. The chip must answer *which* component is behind and
    *how loud* to be -- the aggregate `stale`/`behind` above cannot, which is the
    whole bug.

    - The DASHBOARD is the shell the operator sees and restarts, so its staleness
      is the loud one: mode 'dashboard', carrying its OWN `dashboard_behind` for a
      'pull + restart' call-to-action. It wins when both are behind.
    - A behind SUPERVISOR while the dashboard is current is informational (mode
      'supervisors'): supervisors hot-reload logic and self-refresh at a session
      boundary, so a restart demand about the (current) dashboard would be the
      cry-wolf (#240 defect 1). `dashboard_behind` stays None -- no aggregate
      count leaks into that message.
    - Each stale supervisor carries its OWN truth: `behind` when known, and
      `known: False` for a pre-tracking sha ("") so the render says 'version
      unknown' rather than borrowing a count (#240 defect 2). Fail-safe: an
      unknown-sha LIVE supervisor is still surfaced, never hidden.
    - #270: the CHECKOUT axis (HEAD vs origin/main) ranks BELOW process-stale
      (a stale process needs pull+restart, which subsumes a pull) but ABOVE the
      informational supervisors note -- an un-pulled checkout is a real action the
      operator can take now. Mode 'checkout' carries its own `checkout_behind` and
      the render calls for a PULL, not a restart (#240: never demand a restart the
      dashboard doesn't need -- it hot-reloads lib/*.html per request).
    """
    checkout = checkout or {}
    stale_sups = [{"repo": s.get("repo", ""),
                   "behind": s.get("behind"),
                   "known": bool(s.get("sha"))}
                  for s in supervisors if s.get("stale")]
    if dashboard.get("stale"):
        mode = "dashboard"
    elif checkout.get("stale"):
        mode = "checkout"
    elif stale_sups:
        mode = "supervisors"
    else:
        mode = "none"
    return {
        "show": mode != "none",
        "mode": mode,
        "dashboard_behind": dashboard.get("behind") if mode == "dashboard"
        else None,
        "checkout_behind": checkout.get("behind") if mode == "checkout"
        else None,
        "supervisors": stale_sups,
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
            "cost": s.get("cost_usd") or 0,
            "ticket": s.get("ticket"),
            "ticket_source": s.get("ticket_source"),
            "model": s.get("model") or "",
        })
    return out


def ticket_effort(sessions, ticket):
    """Total work one ticket has cost (#186 lane detail 'this ticket · N
    sessions · X tok · $Y'): the session count, output tokens, and $ summed
    over every recent session whose worked ticket == `ticket`. Keyed on the
    ISSUE the sessions worked (recent_sessions' `ticket`), not a PR number, so
    it stays honest whether or not a PR is open yet.

    Pure over the recent_sessions() list -- no files, no gh. Returns None when
    there is no active ticket to total, or the list carries no session for it,
    so the page renders the line only when it has a real figure. Total by
    construction: this feeds build_repo_state() (which renders the WHOLE
    dashboard), so every field is coerced defensively -- a torn session dict
    (missing/None/garbage tokens or cost) contributes 0 rather than raising
    (prevention-log #12: a pure projection over cached data must never blow up
    the render)."""
    if ticket is None:
        return None
    matched = [s for s in sessions if s.get("ticket") == ticket]
    if not matched:
        return None
    tokens = 0
    cost = 0.0
    for s in matched:
        try:
            tokens += int(s.get("tokens") or 0)
        except (TypeError, ValueError):
            pass
        try:
            cost += float(s.get("cost") or 0)
        except (TypeError, ValueError):
            pass
    return {"sessions": len(matched), "tokens": tokens, "cost": round(cost, 2)}


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


def attach_quota_forecast(windows, now):
    """Thread each window's burn-rate forecast (#188b) onto the window dict, so
    the quota card -- which renders a SINGLE selected window (the live account
    window or the log-scan max across repos) -- carries the matching forecast by
    construction, closing the source-correspondence trap (the top-level
    `quota_forecast` is keyed by window type, but the DISPLAYED window is chosen
    dynamically at render time). Returns a NEW dict with a shallow copy of each
    dict window -- never mutates the input, because the live windows come from a
    shared usage cache (bin/dashboard.py:_account_usage -> cu.live_quota()).

    Total/best-effort like its `quota_forecast` sibling (prevention-log #12): a
    non-mapping passes through unchanged and a `quota_forecast` raise degrades to
    no forecasts. Degrade-to-truth: a window `quota_forecast` omits (no honest
    forecast) gains NO `forecast` key, and any pre-existing `forecast` on a window
    that is no longer forecast is DROPPED -- never a stale/fabricated projection.
    Non-window keys (e.g. live_quota's `source` string) pass through untouched."""
    if not isinstance(windows, dict):
        return windows
    try:
        fc = quota_forecast(windows, now)
    except Exception:
        fc = {}
    out = {}
    for key, win in windows.items():
        if isinstance(win, dict):
            enriched = dict(win)
            enriched.pop("forecast", None)          # drop any stale forecast...
            if key in fc:
                enriched["forecast"] = fc[key]      # ...replace only when recomputed
            out[key] = enriched
        else:
            out[key] = win
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
        # #147 lane topology: surface the RAW `lanes:` block (verbatim -- None
        # when absent, a scalar when malformed) so roles.py's helpers can both
        # resolve lane names AND validate it. Coercing absent/malformed to the
        # same {} would erase the distinction the validity flag needs (an
        # absent block is healthy; a malformed one is refused by the supervisor).
        "lanes": g("lanes"),
        # #81 slice 2: optional wedged threshold (secs); raw value, sanitized
        # at the point of use (a bad knob degrades to health.py's default).
        "health_wedged_after": g("health.wedged_after"),
        "overrides": overlay,
    }


def lane_status(worktree, now=None):
    """#147 per-lane lifecycle: the coarse display status for a SIBLING lane's
    worktree, from the SAME sources the repo card uses -- supervisor lock pid
    + PAUSE sentinel (lifecycle_status), the heartbeat phase, and lib/health's
    wedged truth. Vocabulary is a subset of display_status's (working / idle /
    paused / stopping / stopped / wedged) so lifecycleCluster maps buttons
    unchanged. Coarser than the card on purpose: the working-vs-idle flavour
    comes from the heartbeat phase (not session-log activity), and needs-setup
    degrades to stopped -- the buttons are identical either way."""
    if now is None:
        now = time.time()
    lc = lifecycle_status(worktree)["state"]
    if lc in ("stopped", "needs-setup"):
        return "stopped"
    logdir = os.path.join(worktree, "var", "autonomy-logs")
    hb = read_heartbeat(os.path.join(logdir, "heartbeat"))
    phase = str(hb.get("phase") or "")
    working = phase.startswith("session-running") or phase.startswith("dispatching")
    if lc == "paused":
        return "stopping" if working else "paused"
    if health_mod.loop_health(logdir, now).get("state") == "wedged":
        return "wedged"
    return "working" if working else "idle"


def lane_services(repo_path, config, launch_agents_dir, now=None):
    """#147: each DECLARED lane's service + coarse status, for the lane rows'
    lifecycle clusters. Returns {lane: {installed, own, status}} or None when
    the topology doesn't apply (single lane, invalid lanes: block) -- callers
    omit the key entirely so older payload consumers see no difference.
    own:True = the registered repo's own service runs this lane; its status
    stays None and the render uses the card's own status (no duplicate read).
    Total: any surprise returns None -- the buttons vanish rather than lie
    (fail-safe direction for a display surface)."""
    try:
        if not roles_schema.lanes_valid(config):
            return None
        names = roles_schema.lane_names(config)
        if len(names) < 2:
            return None
        default = roles_schema.default_lane(config)
        services = {}
        for ln in names:
            svc = _dcx.find_lane_service(repo_path, ln, launch_agents_dir,
                                         default_lane=default)
            if svc is None:
                services[ln] = {"installed": True, "own": True, "status": None}
            elif "error" in svc:
                services[ln] = {"installed": False, "own": False, "status": None}
            else:
                services[ln] = {"installed": True, "own": False,
                                "status": lane_status(svc["repo"], now=now)}
        return services
    except Exception:
        return None


def _with_services(lanes, repo_path, config, launch_agents_dir, now):
    """Attach lanes['services'] only when a launch-agents dir was provided AND
    the topology yields one -- absent otherwise, so every existing caller and
    payload consumer stays byte-identical."""
    if launch_agents_dir:
        services = lane_services(repo_path, config, launch_agents_dir, now=now)
        if services is not None:
            lanes["services"] = services
    return lanes


def build_repo_state(repo_path, pid_is_alive=_default_pid_is_alive, git_in_flight=None, now=None,
                     launch_agents_dir=None):
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
    # #81 slice 2 (SD-32 §9): the wedged truth, from the ONE health module
    # ./start status already consumes. Sanitize the optional knob here -- a
    # malformed health.wedged_after degrades to the module default, never a
    # TypeError inside classify (total: this feeds the whole render).
    try:
        _wa = int(config.get("health_wedged_after") or 0)
    except (TypeError, ValueError):
        _wa = 0
    loop_health = health_mod.loop_health(
        logdir, now, _wa if _wa > 0 else health_mod.DEFAULT_WEDGED_AFTER)
    status = display_status(lifecycle["state"], activity,
                            health_state=loop_health["state"])
    quota = recent_quota_windows(logdir)   # scanned once; forecast reuses it
    sessions = recent_sessions(logdir)     # scanned once; ticket_effort reuses it
    roles = build_roles(config.get("roles"), status, now=now, sessions=sessions)
    health = trigger_health(config, os.path.join(repo_path, "var", "cron"), now)
    # #188c render seam: fold each cron role's missed-fire flag onto its role
    # row, so the fleet rail can surface the swept-state incident (a stalled
    # scheduler that otherwise looks identical to a healthy idle role). A role
    # with no cron schedule / no miss stays False -- never a fabricated alarm.
    missed = set(h["role"] for h in health if h.get("missed"))
    # #147 dashboard slice: tag each role row with the lane it belongs to (its
    # `lane:` or the default lane) so a later render slice can group the repo
    # card by lane. Display only -- lane routing stays a supervisor concern.
    for r in roles:
        r["missed_fire"] = r["name"] in missed
        r["lane"] = roles_schema.lane_of_role(config, r["name"])
    # #258 slice 1: the most-recently-active lane -- the DEFAULT selection for
    # the center zone (the page picks the fleet's newest `active_at` repo and
    # focuses its `active` lane). Sourced from the AUTHORITATIVE newest session
    # (`session`, from latest_session -- NOT the capped recent_sessions), so the
    # client never guesses a timestamp field (Codex CP1 finding 2/3). Fail-safe:
    # `lane_of_role` returns an UNDECLARED lane verbatim (dispatch refuses it by
    # omission) -- active must never surface a lane that isn't declared, or it
    # reads as selectable when it can't run. So an undeclared/absent/malformed
    # lane degrades to the default (Codex CP1 finding 1). Never raises.
    # A malformed `lanes:` block (bad name, non-mapping, unknown key, ...) is
    # `valid: False` -- the supervisor REFUSES to dispatch it. `lane_names`/
    # `default_lane` still echo the raw (possibly-invalid) keys so the render's
    # ⚠ badge can name them, but `active` must NOT select a lane the engine
    # won't run: degrade to the neutral implicit 'main' (Codex CP2 -- fail-safe,
    # not fail-open). `active_at` still reflects the real newest session, since
    # the repo's liveness is truthful even when its lane config is broken.
    lanes_ok = roles_schema.lanes_valid(config)
    lane_names = roles_schema.lane_names(config)
    active_lane = roles_schema.default_lane(config) if lanes_ok else "main"
    active_at = None
    if session:
        sess_role = session.get("role") or ""
        if lanes_ok and sess_role:
            cand = roles_schema.lane_of_role(config, sess_role)
            active_lane = cand if cand in lane_names else active_lane
        active_at = session.get("updated_at") or session.get("started_epoch") or None
    return {
        "name": os.path.basename(repo_path.rstrip("/")),
        "path": repo_path,
        "lifecycle": lifecycle,
        "current_session": session,
        "activity": activity,
        "display_status": status,
        "roles": roles,
        # #147 lane topology: declared lanes in order + the default lane. No
        # `lanes:` block -> the single implicit 'main' lane (zero migration).
        # `valid` is False only for a present-but-malformed block (the same
        # verdict the supervisor's --lane gate reaches) so a render can flag
        # broken config instead of faking a healthy single lane -- fail-safe
        # for the render (never raises), truthful for the operator.
        "lanes": _with_services(
            {"names": lane_names,
             "default": roles_schema.default_lane(config),
             "valid": roles_schema.lanes_valid(config),
             "active": active_lane, "active_at": active_at},
            repo_path, config, launch_agents_dir, now),
        "voice": read_supervisor_voice(os.path.join(logdir, "supervisor.log")),
        "choreography": read_choreography(os.path.join(logdir, "supervisor.log")),
        "heartbeat": read_heartbeat(os.path.join(logdir, "heartbeat")),
        # #90 item (a): board.sh's own board-unresolved verdict (detector ->
        # marker -> chip; the render shows this text verbatim, no re-derivation).
        "board_warning": read_board_warning(os.path.join(logdir, "board-warning")),
        # #81 slice 2: the classify record behind a `wedged` status -- state +
        # human reason, so the render can explain the alarm, not just paint it.
        "health": loop_health,
        "engine_boot": read_engine_boot_sha(logdir),  # #166: supervisor's boot sha
        "git": git_in_flight(repo_path) if git_in_flight else {},
        "config": config,
        # `config["merge_gate"]` is ALREADY the flattened strategy string
        # (_read_config does g("merge_gate.strategy")); NOT the nested block.
        # Reading "merge_gate.strategy" here would return None -> always manual.
        "merge_gate_chain": merge_gate_chain(config.get("merge_gate")),
        "override": read_model_override(os.path.join(logdir, "model-override")),
        # #188b: each displayed window carries its own burn-rate forecast, so the
        # quota card's dynamically-selected window pairs with the right forecast
        # by construction (see attach_quota_forecast). The top-level key below
        # stays for back-compat consumers keyed by window type.
        "quota": attach_quota_forecast(quota, now),
        "sessions": sessions,
        # #186 lane detail: total effort spent on the ticket the focus card
        # shows (the live/most-recent session's worked issue), summed across
        # that ticket's sessions. None when no session is working a ticket.
        "ticket_effort": ticket_effort(
            sessions, session.get("ticket") if session else None),
        "token_timeline": token_timeline(logdir, now),
        "quota_forecast": quota_forecast(quota, now),
        "trigger_health": health,
    }
