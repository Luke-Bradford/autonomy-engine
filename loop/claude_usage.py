#!/usr/bin/env python3
"""The build loop's OWN 7-day account-utilization reader (#764).

Prints the account's 7-day Claude subscription utilization as an INTEGER PERCENT
to stdout and exits 0. On EVERY failure it prints NOTHING and exits 1.

    $ python3 claude_usage.py
    13

WHY THIS FILE EXISTS
--------------------
`loop/drive.sh`'s `quota_pct()` is the spend guard: it refuses to fire at or
above `QUOTA_STOP_PCT` so an unattended night cannot spend the operator out of
their own weekly window (it ran to 97% on 2026-07-25 and cost days of access).
The guard has three sources, and cutover step C3 (#410) parks the old bash/python
engine at the repo root -- which takes TWO of them with it:

  1. the engine dashboard on :8787            <- parked by C3
  2. the engine's `lib/claude_usage.py`       <- parked by C3
  3. studio's `GET /api/quota` on :8788       <- survives

That would leave ONE source, and specifically the one that has never yet returned
a number here (`account.claude: null` on every probe; #765). Worse, source 1 is
the only source that rides through an upstream 429, because the dashboard samples
on a background thread and answers from a warm cache -- so C3 removes the
reliability property, not just a redundant path. This module is source 2
relocated into `loop/`, which C3 explicitly keeps, so the guard still has a
second way to reach the figure after the engine is gone.

It is a PARTIAL port of `lib/claude_usage.py` (#764 option (a) allows either).
Be precise about which parts: the TRANSPORT is near-verbatim -- same `security`
argv, same header dict, same status/`getcode` fallback, same swallow-everything
shape -- because that code is already correct and hardened. What is genuinely new
is the extraction (`seven_day_pct`), the single-call entry point and the CLI.

That means the endpoint contract -- URL, Keychain service, `anthropic-beta`
header -- now lives in TWO MAINTAINED implementations that C3 does not reconcile:
this file and `studio/packages/server/src/quota/claude-quota.ts`. (The engine's
copy is a third today but C3 parks it.) An upstream change to any of the three
values needs BOTH updated, or the guard silently loses a source. There is no
mechanism enforcing that; it is a known cost of the relocation.

Deliberately dropped, each because it served the DASHBOARD's needs rather than
the guard's:

  * the 5-hour window                -- `QUOTA_STOP_PCT` is a 7-day threshold.
  * the module cache + lock          -- there is no request thread to protect;
                                        each read is a fresh short-lived process.
  * `refresh_live_quota`/`live_quota` -- that writer/getter split is exactly what
                                        broke the fallback for its whole life
                                        (#766: drive.sh called the WRITER, which
                                        returns None on every path, so source 2
                                        silently never worked and the "two
                                        sources" of the 2026-07-26 blind-fire
                                        incident were always one). One function,
                                        one call, so that class is unrepresentable.
  * the last-good grace/age badge    -- drive.sh already REFUSES an age-badged
                                        value: a stale-but-plausible LOW reading
                                        PERMITS a fire the live figure would have
                                        refused, which is fail-open.
  * the all-or-nothing both-windows
    rule and the `resets_at` parse   -- both exist so the dashboard PANEL never
                                        renders a live+stale mix or a bad
                                        timestamp. Nothing here reads either
                                        field, and vetoing a good 7-day figure
                                        over an unrelated one would cost the
                                        guard availability for no benefit.

UNITS -- the one thing to get right. The upstream endpoint reports `utilization`
as a PERCENT (48.0 == 48%). Both other readers of it divide by 100 to store a
0-1 fraction for their wire format (`lib/claude_usage.py::_map_window`,
`studio/packages/server/src/quota/claude-quota.ts`), and drive.sh's
`quota_read_url` multiplies by 100 to undo that. This module is called directly,
so it does NEITHER: it emits the percent as it arrived. A stray `/100` would
report 0 for any utilization below 150% -- a fail-open reading on the one guard
that must never fail open.

FAIL-SAFE, NEVER FAIL-OPEN. Every unreadable path -- non-darwin, missing or
expired token, non-200 (the endpoint 429s under direct polling; #765/#770),
timeout, malformed payload, non-finite number -- prints nothing. UNREADABLE is a
DISTINCT outcome from 0% and this module never conflates them: 0% means the
window is wide open, empty means blind, and #440 pins that distinction because
reporting 0 for "I don't know" silently disarms the guard.

SECURITY. The OAuth token is read from the Keychain at use, held in memory only,
placed ONLY in the in-process Authorization header -- never on argv, never
logged, never persisted -- and never reaches a return value, stdout or stderr.

Stdlib only, like the rest of the control plane, so CI needs no install step.
"""
import json
import math
import subprocess
import sys
import urllib.request

KEYCHAIN_SERVICE = "Claude Code-credentials"
KEYCHAIN_TIMEOUT = 4.0      # a Keychain prompt/hang must never wedge a fire
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
USAGE_BETA = "oauth-2025-04-20"
HTTP_TIMEOUT = 3.0


def _keychain_runner(runner=None):
    """The Keychain item's password -- the OAuth JSON blob -- or None.

    The item NAME rides argv; the SECRET comes back only on stdout. Hard timeout
    so a Keychain prompt cannot stall the driver. `runner` is a seam for tests
    (defaults to `subprocess.run`) so this contract is assertable without a
    Keychain."""
    if runner is None:
        runner = subprocess.run
    try:
        out = runner(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, timeout=KEYCHAIN_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout


def read_oauth_token(runner=_keychain_runner, platform=None):
    """The Claude Code CLI's OAuth access token, or None.

    Darwin-only: the credential lives in the macOS Keychain, so on any other
    platform this returns None WITHOUT invoking the runner. Note this is the SAME
    limitation #764 raised against studio's `/api/quota`, so it is emphatically
    NOT redundancy against that failure: post-C3 both surviving sources read one
    Keychain item on one platform and poll one rate-limited endpoint. Three
    common-mode failures, not an independent pair. Said plainly here because the
    word "fallback" invites the opposite assumption.

    Any failure -- non-darwin, runner error or hang, bad JSON, missing or
    wrongly-typed field -- returns None rather than raising."""
    if platform is None:
        platform = sys.platform
    if platform != "darwin":
        return None
    try:
        raw = runner()
    except Exception:
        return None
    if not raw or not str(raw).strip():
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    section = data.get("claudeAiOauth")
    if not isinstance(section, dict):
        return None
    token = section.get("accessToken")
    return token if isinstance(token, str) and token else None


def fetch_usage(token, opener=None, timeout=HTTP_TIMEOUT):
    """GET the usage endpoint with `token` in the Authorization header; the
    parsed JSON object, or None.

    An empty token attempts NO request -- an unauthenticated poll would spend
    from the shared rate-limit budget that all three quota sources draw on, for a
    guaranteed 401. NEVER re-raises, so no exception text can carry the header,
    and never puts the token on argv."""
    if not token:
        return None
    if opener is None:
        opener = urllib.request.urlopen
    req = urllib.request.Request(USAGE_URL, headers={
        "Authorization": "Bearer %s" % token,
        "anthropic-beta": USAGE_BETA,
        "Accept": "application/json",
    })
    try:
        resp = opener(req, timeout=timeout)
    except Exception:
        return None
    try:
        status = getattr(resp, "status", None)
        if status is None and hasattr(resp, "getcode"):
            status = resp.getcode()
        if status != 200:
            return None
        body = resp.read()
    except Exception:
        return None
    finally:
        try:
            resp.close()
        except Exception:
            pass
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def seven_day_pct(data):
    """The 7-day window's utilization as an INTEGER PERCENT, or None.

    Already a percent upstream, so it is returned as-is (see the UNITS note in
    the module docstring -- do NOT scale it). Rounding is `int(round(pct))`,
    chosen to match `quota_read_url`'s `int(round(fraction * 100))` as closely as
    a different input representation allows.

    They are NOT always equal, and the earlier claim that they were was wrong.
    Swept 0-200 in 0.5 steps: they differ at 8 points, all exact half-percents
    (54.5 -> 54 here vs 55 there; 57.5 -> 58 vs 57; also 101.5, 103.5, 122.5,
    124.5, 125.5, 127.5), because `pct/100*100` is not an exact float round-trip
    so a .5 can land either side of round-half-to-even. The bound is +/-1
    percentage point, at exact half-percent readings only, which can change a
    decision only when the true utilization sits within 0.5pp of
    QUOTA_STOP_PCT -- and in that band a 1pp disagreement is immaterial next to
    the documented overshoot of one whole fire. Pinned by a test rather than
    asserted away.

    Validity is a non-bool, FINITE, non-negative number. `bool` is excluded
    because it is an `int` subclass in Python, so `True` would otherwise read as
    1%. Non-finite is excluded because `json.loads` accepts the bare tokens
    `NaN`/`Infinity` (verified), which would otherwise print 'nan' or overflow --
    the same trap `lib/quota.py::_fraction` records.

    Overage (>100%) passes through UNCAPPED: it is the strongest stop signal
    there is, and no reading above the threshold is improved by being made
    smaller."""
    if not isinstance(data, dict):
        return None
    window = data.get("seven_day")
    if not isinstance(window, dict):
        return None
    util = window.get("utilization")
    if isinstance(util, bool) or not isinstance(util, (int, float)):
        return None
    if not math.isfinite(util) or util < 0:
        return None
    return int(round(float(util)))


def read_seven_day_pct(token_reader=read_oauth_token, fetcher=fetch_usage):
    """The whole read, end to end: integer percent, or None. Contains every
    failure -- an unexpected exception anywhere in the chain is an UNREADABLE,
    never a traceback that a caller might mistake for output."""
    try:
        token = token_reader()
        if not token:
            return None
        return seven_day_pct(fetcher(token))
    except Exception:
        return None


def main(argv=None, reader=read_seven_day_pct, out=None, err=None):
    """CLI: print the percent and return 0, or print nothing and return 1.

    stdout carries the VALUE ALONE because drive.sh captures it in a command
    substitution and uses it as the reading -- any diagnostic on stdout would be
    concatenated into the number and land on the fail-open path. Diagnostics go
    to stderr, where the driver ignores them."""
    if out is None:
        out = sys.stdout
    if err is None:
        err = sys.stderr
    try:
        pct = reader()
    except Exception:
        pct = None
    if pct is None:
        # Deliberately no value, not even 0. See the module docstring.
        err.write("claude_usage: 7-day utilization unreadable\n")
        return 1
    out.write("%d\n" % pct)
    return 0


if __name__ == "__main__":
    sys.exit(main())
