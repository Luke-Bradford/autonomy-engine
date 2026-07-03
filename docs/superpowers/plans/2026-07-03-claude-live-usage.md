# #160 — live Claude 5h/7d utilization from api/oauth/usage

## Problem

Dashboard quota bars come from `parse_quota_windows` (lib/dashboard_state.py) —
a scan of session-log `rate_limit_event`s. Server-authoritative at emission but
stale between sessions and sparse for the weekly window (verified 48%/7% real vs
0%/63% shown). The Claude Code CLI reads live utilization from
`GET https://api.anthropic.com/api/oauth/usage` (OAuth token, header
`anthropic-beta: oauth-2025-04-20`) — HTTP 200 with exact five_hour/seven_day
utilization + resets_at. Use it as the primary source; keep the log-scan as a
fail-safe fallback.

## New module: lib/claude_usage.py (stdlib only)

**Architecture: the sampler thread owns ALL I/O; the request path only reads a
cache (never blocks, never stampedes).** This mirrors dashboard.py's existing
"sampler owns the slow work" pattern and resolves Codex's blocking/stampede
finding cleanly — no single-flight lock needed because only one thread writes.

- `read_oauth_token(runner=<security subprocess>)` — darwin-gated (non-darwin →
  None). Reads Keychain item `Claude Code-credentials` via
  `security find-generic-password -s "Claude Code-credentials" -w` (item NAME on
  argv, NOT the token) **with a hard `timeout=` (→ None on TimeoutExpired so a
  Keychain prompt/hang can't stall the sampler)**, parses JSON
  `claudeAiOauth.accessToken`. None on any failure. **Token never on argv,
  never logged, never persisted.** (Matches the Claude Code CLI's own single
  Keychain item; multi-item disambiguation is out of scope.)
- `fetch_usage(token, opener=urllib.request.urlopen, timeout=3.0)` — GET the
  endpoint with `Authorization: Bearer <token>` + the beta header. Returns the
  parsed JSON dict, or None on non-200 / timeout / URLError / bad JSON. Catches
  broadly and returns None — **never re-raises** (so no exception text can carry
  the header). Token only in the in-process header (urllib), never argv.
- `_iso_to_epoch(s)` — ISO-8601 (`...+00:00`) → int epoch via
  `datetime.fromisoformat`; None on parse/type failure.
- `_map_window(w)` — validates: `w` a dict, `utilization` a real number,
  `resets_at` parseable. Returns `{utilization: util/100.0, resets_at: epoch}`
  (endpoint returns PERCENT e.g. 48.0; the page does util*100, so store a 0–1
  FRACTION matching the log-scan shape) + `overage` if present. **None on any
  malformed window** — degrade, never exception-hop.
- `refresh_live_quota(now=None, token_reader=..., fetcher=...)` — the I/O path,
  **called only by the sampler thread**. read→fetch→map. Requires BOTH windows
  present+valid → writes `{"five_hour":.., "seven_day":.., "source":"live"}` to
  the module cache; otherwise writes None (fall back to logs — all-or-nothing
  avoids a confusing live+stale mix). Self-throttles: no-op if the cache was
  written < 60s ago (so the sampler may call it every tick). Lock-guarded write.
- `live_quota(now=None)` — **pure cache read, NO I/O ever**. Returns the last
  cached value (windows dict or None). Lock-guarded read. Staleness is bounded
  to the sampler interval + 60s; a login change self-corrects within that window
  (accepted — account-level data, no token-digest keying needed).

## Wiring

- `bin/dashboard.py`: in the sampler (`_sampler_loop`/`_sample_once`), call
  `cu.refresh_live_quota(now=...)` each tick (self-throttled to 60s) in
  try/except (best-effort, never crashes the sampler). In `_account_usage`, add
  `usage["claude"] = cu.live_quota()` — a pure cache read, so the `/api/state`
  path never does keychain/network I/O and never blocks. try/except → the key is
  simply absent on error.
- `lib/dashboard_page.html renderQuota`: prefer `account.claude` when its
  `source==="live"`; feed its five_hour/seven_day to `qrow`. Else fall back to
  the existing per-repo log-scan max. Add a source tag to the `q-prov` line:
  `live` vs `logs (stale)`. resets already humanized by `dur()`.

## Fail-safe / security (invariant: never fail-open, never break the loop)

- Any failure in the live path → `live_quota` returns None → page falls back to
  log-scan + `logs (stale)` badge. The endpoint is UNDOCUMENTED/internal; a
  break degrades the DISPLAY only, never the engine loop (which never reads it).
- Token: Keychain-read at use, in-memory only, never argv/logs/disk. Requests
  only to `api.anthropic.com` over TLS; read-only. No new inbound surface.
- Repo-agnostic: account/machine-level data (like codex_usage / account_usage),
  no target-repo values.

## TDD (tests/test_claude_usage.py — inject every seam, no real net/keychain)

1. read_oauth_token: valid blob → token; missing accessToken → None; bad JSON →
   None; runner failure → None; runner timeout (TimeoutExpired) → None;
   non-darwin (monkeypatch sys.platform) → None.
2. fetch_usage: 200 body → dict; injected opener raising URLError/timeout → None;
   non-200 (opener returns status!=200) → None; non-JSON → None; assert the
   token substring never appears in the return value or any surfaced error.
3. _iso_to_epoch: known ISO → epoch; garbage/None → None.
4. _map_window: 48.0 → 0.48; resets_at ISO → epoch; malformed shapes → None
   (non-dict, string utilization, out-of-range/None utilization, garbage reset).
5. refresh_live_quota + live_quota: happy path (both windows) → source=live;
   fetch None → cache None; ONE window missing/malformed → cache None
   (all-or-nothing); self-throttle (second refresh within 60s does NOT call the
   fetcher); expiry after 60s (now+61) refetches; live_quota is pure read (no
   fetcher call). Reset module cache between tests.

Browser FE-QA (dashboard skill): fixture repo, assert quota panel renders, source
badge shows (fixture has no live token on CI/non-op machine → `logs (stale)`),
zero console errors, /api/state 200.

## Out of scope

#150 quota-guard consuming this source (separate issue). Codex usage (already
live). Per-model weekly buckets / dollar spend (null on subscription).
