#!/usr/bin/env python3
"""Live Claude account utilization (#160) -- the 5h/7d windows the dashboard
quota panel shows, read from the SAME source the Claude Code CLI uses:
`GET https://api.anthropic.com/api/oauth/usage` with the CLI's OAuth token
(macOS Keychain item `Claude Code-credentials`) + the `anthropic-beta:
oauth-2025-04-20` header. This is server-authoritative and always fresh, unlike
the session-log `rate_limit_event` scan (dashboard_state.parse_quota_windows),
which is stale between sessions and sparse for the weekly window.

Architecture: the dashboard's SAMPLER thread owns all I/O via
`refresh_live_quota` (self-throttled to a 60s TTL); the request/`/api/state`
path only calls `live_quota()`, a pure lock-guarded cache read that never does
Keychain or network work. So no request thread ever blocks and there is no
fetch stampede -- only one writer.

Fail-safe, never fail-open: the endpoint is UNDOCUMENTED/internal and may change
or vanish. EVERY failure (non-darwin, missing/expired token, non-200, timeout,
malformed payload) degrades to None so the dashboard falls back to the log-scan
source; the engine loop never reads this and cannot be affected.

Security: the OAuth token is read from the Keychain at use, held in memory only,
put ONLY in the in-process HTTP header (never on argv, never logged, never
persisted), and never appears in a return value or a surfaced error. Stdlib only.
"""
import json
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone

_KEYCHAIN_SERVICE = "Claude Code-credentials"
_KEYCHAIN_TIMEOUT = 4.0            # a Keychain prompt/hang must not stall the sampler
_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
_BETA = "oauth-2025-04-20"
_HTTP_TIMEOUT = 3.0
_TTL = 60.0                        # cache/self-throttle window
# #271: how long a FAILED sample may keep serving the last GOOD live value
# (age-badged via `age_s`) before degrading to the log-scan fallback. Bounds
# the panel flap a transient endpoint/network/token blip caused, while keeping
# the staleness visible and finite — degrade to truth, never silently-stale.
_GRACE = 900.0

# The single account-level cache. Written only by the sampler (via
# refresh_live_quota); read by any request thread (via live_quota). Lock-guarded
# so a read never sees a half-written dict. `good`/`good_ts` remember the last
# successful sample so live_quota can bridge transient failures (#271).
_cache = {"ts": 0.0, "val": None, "seen": False, "good": None, "good_ts": 0.0}
_lock = threading.Lock()


def reset_cache():
    """Test hook: drop the cached value so each test starts cold."""
    with _lock:
        _cache["ts"] = 0.0
        _cache["val"] = None
        _cache["seen"] = False
        _cache["good"] = None
        _cache["good_ts"] = 0.0


def _default_runner():
    """Read the Keychain item's password (the OAuth JSON blob) via `security`.
    The item NAME rides argv; the returned blob does NOT. Hard timeout so a
    Keychain prompt/hang cannot stall the sampler. None on any failure."""
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", _KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, timeout=_KEYCHAIN_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout


def _read_oauth_token(runner=_default_runner, platform=None):
    """The CLI's OAuth access token, or None. INTERNAL seam -- the token it
    returns transits ONLY to `fetch_usage`'s in-process Authorization header
    within `refresh_live_quota`; it is never serialized, logged, put on argv, or
    persisted, and never reaches an outward (dashboard-facing) return value.
    Darwin-only (the Keychain item is macOS). Parses
    `claudeAiOauth.accessToken` from the blob. Any failure -- non-darwin, runner
    error/hang, bad JSON, missing field -- returns None."""
    if platform is None:
        platform = sys.platform
    if platform != "darwin":
        return None
    try:
        blob = runner()
    except Exception:
        return None
    if not blob:
        return None
    try:
        data = json.loads(blob)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    tok = (data.get("claudeAiOauth") or {}).get("accessToken") \
        if isinstance(data.get("claudeAiOauth"), dict) else None
    return tok if isinstance(tok, str) and tok else None


def _close(resp):
    try:
        resp.close()
    except Exception:
        pass


def fetch_usage(token, opener=None, timeout=_HTTP_TIMEOUT):
    """GET the usage endpoint with the OAuth token in the Authorization header.
    Returns the parsed JSON dict, or None on empty token / non-200 / timeout /
    transport error / non-JSON. NEVER re-raises (so no exception text can carry
    the header) and never puts the token on argv."""
    if not token:
        return None
    if opener is None:
        opener = urllib.request.urlopen
    req = urllib.request.Request(_USAGE_URL, headers={
        "Authorization": "Bearer %s" % token,
        "anthropic-beta": _BETA,
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
        _close(resp)
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _iso_to_epoch(s):
    """ISO-8601 (e.g. '2026-07-03T19:10:00+00:00') -> int epoch seconds, or
    None. A naive timestamp is assumed UTC."""
    if not isinstance(s, str):
        return None
    # datetime.fromisoformat rejects a trailing 'Z' before Python 3.11; JSON
    # APIs commonly emit it, so normalize to +00:00 -- otherwise every window
    # would silently map to None and permanently defeat the live source.
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _map_window(w):
    """One endpoint window -> the dashboard's window shape, or None if malformed.
    The endpoint reports utilization as a PERCENT (48.0); the page renders
    util*100, so store a 0-1 FRACTION to match the log-scan shape. A non-dict,
    non-numeric/negative utilization, or unparseable resets_at degrades to None
    (never an exception)."""
    if not isinstance(w, dict):
        return None
    util = w.get("utilization")
    if isinstance(util, bool) or not isinstance(util, (int, float)) or util < 0:
        return None
    epoch = _iso_to_epoch(w.get("resets_at"))
    if epoch is None:
        return None
    out = {"utilization": util / 100.0, "resets_at": epoch}
    if w.get("overage"):
        out["overage"] = True
    return out


def _build(data):
    """Endpoint payload -> {five_hour, seven_day, source:'live'} or None. BOTH
    windows must be present and valid; a partial payload degrades to None
    (all-or-nothing avoids a confusing live+stale mix on the panel)."""
    if not isinstance(data, dict):
        return None
    fh = _map_window(data.get("five_hour"))
    sd = _map_window(data.get("seven_day"))
    if fh is None or sd is None:
        return None
    return {"five_hour": fh, "seven_day": sd, "source": "live"}


def refresh_live_quota(now=None, token_reader=_read_oauth_token,
                       fetcher=fetch_usage, ttl=_TTL):
    """The I/O path -- call ONLY from the sampler thread. Reads the token and
    polls the endpoint, writing the mapped result (or None) to the cache.
    Self-throttled: a no-op if the cache was written < ttl ago, so the sampler
    may call it every tick. Best-effort: the token is read fresh each cycle, so
    a login change self-corrects within one ttl.

    Fail-safe: ANY unexpected error in the read/fetch/map path writes None (not
    a raise), so a failure REPLACES a previously-cached live value with the
    log-scan fallback rather than leaving stale-live data in place (never
    fail-open)."""
    if now is None:
        now = time.time()
    with _lock:
        if _cache["seen"] and (now - _cache["ts"]) < ttl:
            return
    try:
        token = token_reader()
        data = fetcher(token) if token else None
        val = _build(data)
    except Exception:
        val = None
    with _lock:
        _cache["ts"] = now
        _cache["val"] = val
        _cache["seen"] = True
        if val is not None:
            _cache["good"], _cache["good_ts"] = val, now


def live_quota(now=None):
    """Pure, lock-guarded cache read -- NO I/O ever. Returns the last mapped
    windows dict ({five_hour, seven_day, source}), or -- when the LAST sample
    failed but a previous one succeeded within _GRACE (#271) -- a COPY of that
    last-good value with `age_s` set (the page badges it aged), else None
    (cold cache / grace exhausted -> caller falls back to the log-scan
    source). The copy keeps a caller's mutation out of the shared cache."""
    if now is None:
        now = time.time()
    with _lock:
        if _cache["val"] is not None:
            return _cache["val"]
        good, good_ts = _cache["good"], _cache["good_ts"]
    if good is not None and 0 <= (now - good_ts) <= _GRACE:
        out = dict(good)
        out["age_s"] = int(now - good_ts)
        return out
    return None
