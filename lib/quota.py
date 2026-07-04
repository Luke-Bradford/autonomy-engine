#!/usr/bin/env python3
"""Single bash-callable account-utilization reader (#150 Slice A).

The engine's rate-limit handling is reactive: the loop runs flat-out until the
account hits the wall, then backs off. The dashboard already knows the 5h/7d
utilization ahead of time -- but that knowledge lives Python-only
(`claude_usage.live_quota` for the account-level live number, #160; and
`dashboard_state.recent_quota_windows` for the log-scan fallback), with no bash
entrypoint. The supervisor is bash. This module is the shared seam so a future
quota guard (Slice B) can read the SAME utilization the dashboard shows without
forking the parse.

Precedence mirrors `dashboard.py::_account_usage` + `dashboard_page.html`:
- The LIVE source is authoritative and ALL-OR-NOTHING. `claude_usage._build`
  only ever yields a dict with BOTH windows valid (or None), so when a live dict
  is present we trust it wholesale and NEVER fall back to the log-scan for a
  single window -- mixing live+log is exactly the divergence the all-or-nothing
  contract avoids.
- The LOG-SCAN is a single-repo degraded fallback, consulted only when live is
  absent. (The dashboard maxes the log-scan across ALL repos to approximate an
  account-level number; a lone supervisor process only knows its own repo's
  logdir, and an account-wide registry does not exist yet -- so live is the
  account-accurate primary, log-scan the best-effort fallback.)

Fail-safe, never fail-open: the reader NEVER fabricates a number. Every
unreadable/stale/malformed path returns None (CLI exit 1). It does NOT decide
whether to pause -- the pause-direction on "unknown" is the guard's (Slice B)
call; this reader stays neutral. Overage (>1) is passed through, not capped: an
overage window legitimately reports >100% and is the strongest pause signal;
capping would silently drop it, and an over-cautious pause is the safe direction
(the reactive wall backoff still protects the account).

Stdlib only. Repo-agnostic. Never writes `.last_usage_reset`.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

_ALIASES = {
    "5h": "five_hour", "five_hour": "five_hour",
    "7d": "seven_day", "seven_day": "seven_day",
}


def _canonical(window):
    """'5h'/'five_hour' -> 'five_hour'; '7d'/'seven_day' -> 'seven_day'; else
    None. Any non-string or unknown token normalizes to None (absent)."""
    if not isinstance(window, str):
        return None
    return _ALIASES.get(window)


def _fraction(win):
    """A window mapping's utilization as a 0-1 (or overage >1) fraction, or None
    if the mapping is missing/malformed. Valid = a non-bool, FINITE int/float
    >= 0; values > 1 (overage) pass through unchanged. NaN/Infinity are rejected
    (json.loads accepts those tokens, so a malformed payload could otherwise make
    the CLI print 'nan'/'inf' and exit 0 -- fabricating usable quota data)."""
    if not isinstance(win, dict):
        return None
    util = win.get("utilization")
    if isinstance(util, bool) or not isinstance(util, (int, float)):
        return None
    if not math.isfinite(util) or util < 0:
        return None
    return float(util)


def _live():
    """Default live seam: the account-level 5h/7d windows dict, or None.

    This process has no dashboard sampler thread, so it does the I/O inline --
    legitimate here: `claude_usage`'s 'sampler-only' rule exists to keep the
    dashboard's request threads non-blocking, and this is a separate short-lived
    process with no request thread to protect. Synchronous and bounded by
    claude_usage's own timeouts (~7s worst case). Every failure -> None."""
    try:
        import claude_usage as cu
        cu.refresh_live_quota()
        return cu.live_quota()
    except Exception:
        return None


def _logscan(logdir):
    """Default log-scan seam: this repo's merged rate-limit windows, or {}.
    Guards `logdir=None` (which would make `os.listdir(None)` raise TypeError --
    NOT the OSError `recent_quota_windows` catches) and contains every other
    error, so a broken source degrades to {} rather than raising."""
    if not logdir:
        return {}
    try:
        import dashboard_state as ds
        return ds.recent_quota_windows(logdir)
    except Exception:
        return {}


def utilization(window, logdir=None, live_reader=_live, logscan_reader=_logscan):
    """Current utilization FRACTION (0-1, or >1 on overage) for `window`
    ('5h'/'five_hour' or '7d'/'seven_day'), or None when no source can supply it.

    Live is authoritative and all-or-nothing: a present live dict is trusted
    wholesale for this window and the log-scan is not consulted (no live+log
    mixing). Only when live is absent (None) do we read the log-scan. Never
    fabricates a number; never raises (source exceptions are contained)."""
    canon = _canonical(window)
    if canon is None:
        return None
    try:
        live = live_reader()
    except Exception:
        live = None
    if isinstance(live, dict):
        # All-or-nothing: live is authoritative. A malformed target window here
        # returns None rather than falling through to the log-scan.
        return _fraction(live.get(canon))
    try:
        scan = logscan_reader(logdir)
    except Exception:
        scan = {}
    if isinstance(scan, dict):
        return _fraction(scan.get(canon))
    return None


def main(argv):
    """`quota.py <window> [logdir]` -- print the fraction + exit 0 when
    available, print nothing + exit 1 when unavailable, usage + exit 2 on bad
    args. Slice B's dispatch gate treats a non-zero exit as 'unknown'."""
    if len(argv) not in (2, 3) or _canonical(argv[1]) is None:
        print("usage: quota.py <5h|7d|five_hour|seven_day> [logdir]",
              file=sys.stderr)
        return 2
    logdir = argv[2] if len(argv) == 3 else None
    val = utilization(argv[1], logdir=logdir,
                      live_reader=_live, logscan_reader=_logscan)
    if val is None:
        return 1
    print("%s" % val)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
