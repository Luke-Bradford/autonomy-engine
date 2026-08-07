#!/usr/bin/env python3
"""The engine's single wedged-truth module (#81 / SD-32 §9).

SD-32 settled ONE health implementation, stdlib-only and pure/fixture-testable,
that the dashboard imports and `./start status` consumes via a `python3 -c`
shim -- zero drift (same shape as the #117 lock-path unification). This lands
the "Truth" bullet; the dashboard import + a `wedged` status-vocab token + the
health strip UI + README/skill docs are SEPARATE follow-on slices.

**The wedged rule (verbatim SD-32 §9):** a WORKING session whose newest
session-log/heartbeat write is older than a threshold is wedged; default 15
minutes, configurable (`health.wedged_after`). Engine-owned artifacts only --
no process introspection.

Two fail-safe corrections (Codex CP1) shaped the design:
  - "running loop" != "WORKING session": an alive-but-idle loop legitimately
    sleeps up to EMPTY_IDLE (1800s) in `board-empty` / `pace-wait` /
    `limit-backoff` / ... writing nothing meanwhile. So the rule is GATED on
    the heartbeat PHASE (`session-running`), never on mere liveness -- else
    every healthy idle loop reads wedged at 15m.
  - unreadable liveness storage must NOT read as healthy: an absent/torn
    heartbeat is `unknown` (the caller WARNs), never a silent `ok`. Fail-safe,
    never fail-open.

The `session-running` heartbeat ts is written ONCE at session start
(bin/supervisor.sh), so a long healthy session's freshness lives in its
session-*.log mtime, not the heartbeat ts -- age uses max(both).

stdlib only; macOS; no globstar.
"""
import os
import sys
import time

DEFAULT_WEDGED_AFTER = 900          # 15 minutes (SD-32 §9 default)
WORKING_PHASE_PREFIX = "session-running"
_HEARTBEAT = "heartbeat"
_SESSION_PREFIX = "session-"
_SESSION_SUFFIX = ".log"


def read_heartbeat(logdir):
    """Parse `<logdir>/heartbeat` -- the supervisor's structured liveness line
    (`ts \\t phase \\t until \\t reason`, bin/supervisor.sh heartbeat()) -- into
    {"ts": int, "phase": str, "until": int, "reason": str}, or None when absent
    / torn / unreadable / a non-int ts. Total; dashboard_state.read_heartbeat
    delegates to read_heartbeat_file (SD-32 'one implementation, zero drift')."""
    return read_heartbeat_file(os.path.join(logdir, _HEARTBEAT))


def read_heartbeat_file(path):
    """read_heartbeat by explicit file PATH (the dashboard's historical
    signature) -- reads exactly `path`, never a sibling. Same contract:
    parsed dict or None."""
    try:
        with open(path, errors="replace") as fh:
            line = fh.readline().rstrip("\n")
    except OSError:
        return None
    parts = line.split("\t")
    if len(parts) < 4:
        return None
    ts_s, phase, until_s, reason = parts[0], parts[1], parts[2], parts[3]
    if not phase:
        return None
    try:
        ts = int(ts_s)
    except ValueError:
        return None
    try:
        until = int(until_s) if until_s else 0
    except ValueError:
        until = 0
    return {"ts": ts, "phase": phase, "until": until, "reason": reason}


def newest_session_epoch(logdir):
    """Newest `session-*.log` mtime (int epoch) in `logdir`, or None when the
    dir is absent / holds no session log. Total: any OS error -> None (never
    raises). Engine artifacts only; no globstar (bash-3.2-neighbourly, and pure
    os.listdir)."""
    try:
        names = os.listdir(logdir)
    except OSError:
        return None
    newest = None
    for name in names:
        if not (name.startswith(_SESSION_PREFIX)
                and name.endswith(_SESSION_SUFFIX)):
            continue
        try:
            m = int(os.stat(os.path.join(logdir, name)).st_mtime)
        except OSError:
            continue
        if newest is None or m > newest:
            newest = m
    return newest


def _threshold(wedged_after):
    """Coerce the configured threshold: a misconfig (non-int or <= 0) falls back
    to the default rather than making every session wedged (fail-safe
    direction). bool is rejected (a stray True/False is not a duration)."""
    if isinstance(wedged_after, bool) or not isinstance(wedged_after, int):
        return DEFAULT_WEDGED_AFTER
    return wedged_after if wedged_after > 0 else DEFAULT_WEDGED_AFTER


def classify(heartbeat, newest_session_epoch, now,
             wedged_after=DEFAULT_WEDGED_AFTER):
    """Pure wedged decision. Inputs: the parsed `heartbeat` (dict or None/{}),
    the `newest_session_epoch` (int or None), `now` (epoch), and the threshold.
    Returns {"state", "phase", "age", "wedged_after", "reason"} where state is:

      - "unknown" -- heartbeat unreadable/absent, OR a WORKING phase with no
        usable timestamp: can't substantiate health -> caller WARNs, never
        'healthy' (fail-safe, not fail-open).
      - "idle"    -- phase is not a WORKING session (`session-running*`): a
        legitimately sleeping loop is never wedged.
      - "ok"      -- WORKING session, age <= threshold.
      - "wedged"  -- WORKING session, age > threshold.

    age = now - max(heartbeat ts, newest_session_epoch)."""
    wa = _threshold(wedged_after)
    if not heartbeat:
        return {"state": "unknown", "phase": None, "age": None,
                "wedged_after": wa, "reason": "no readable heartbeat"}
    phase = heartbeat.get("phase") or ""
    if not phase.startswith(WORKING_PHASE_PREFIX):
        return {"state": "idle", "phase": phase, "age": None,
                "wedged_after": wa,
                "reason": "not a working session (phase %r)" % phase}
    stamps = [s for s in (heartbeat.get("ts"), newest_session_epoch)
              if isinstance(s, int) and not isinstance(s, bool)]
    if not stamps:
        return {"state": "unknown", "phase": phase, "age": None,
                "wedged_after": wa,
                "reason": "working session with no liveness timestamp"}
    age = int(now) - max(stamps)
    if age > wa:
        return {"state": "wedged", "phase": phase, "age": age,
                "wedged_after": wa,
                "reason": "working session with no liveness write in %ds "
                          "(threshold %ds)" % (age, wa)}
    return {"state": "ok", "phase": phase, "age": age, "wedged_after": wa,
            "reason": "working session, last write %ds ago" % age}


def loop_health(logdir, now, wedged_after=DEFAULT_WEDGED_AFTER):
    """The wedged truth for one loop's `logdir` -- glues the I/O readers to the
    pure classify(). Total (the readers are total; classify never raises)."""
    return classify(read_heartbeat(logdir), newest_session_epoch(logdir),
                    now, wedged_after)


def _main(argv):
    """CLI for the `./start status` shim: `health.py <logdir> [wedged_after]`.
    Prints `<state>\\t<reason>` and exits 0 (a health probe never fails its
    caller). A `wedged`/`unknown` state is what the caller turns into a WARN."""
    if not argv:
        print("usage: health.py <logdir> [wedged_after_secs]", file=sys.stderr)
        return 2
    logdir = argv[0]
    wa = DEFAULT_WEDGED_AFTER
    if len(argv) > 1:
        try:
            wa = int(argv[1])
        except ValueError:
            wa = DEFAULT_WEDGED_AFTER
    r = loop_health(logdir, now=time.time(), wedged_after=wa)
    print("%s\t%s" % (r["state"], r["reason"]))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
