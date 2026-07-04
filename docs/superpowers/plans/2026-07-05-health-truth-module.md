# Plan — `lib/health.py` wedged-truth module + `./start status` consumer (#81, SD-32 §9)

## Goal
Land the "Truth" bullet of #81's settled health architecture (SD-32 §9): a
single stdlib, pure, fixture-testable `lib/health.py` that decides whether a
loop running a WORKING session is *wedged* (a `session-running` heartbeat phase
whose newest liveness write is stale), and wire its first consumer,
`./start status`, so a stuck session surfaces as a WARN. Dashboard import + a
`wedged` status-vocab token + the health strip UI + README/skill docs are
SEPARATE follow-on slices (SD-32 lists them apart).

## The wedged rule (SD-32 §9)
A WORKING session whose newest session-log/heartbeat write is older than a
threshold is wedged; default **15 minutes**, configurable (`health.wedged_after`).
Engine-owned artifacts only — no process introspection.

## Corrected design (after Codex CP1)
CP1 caught that "running loop" ≠ "WORKING session": an idle-but-alive loop
legitimately sleeps up to `EMPTY_IDLE` (1800s) in `board-empty`/`pace-wait`/
`limit-backoff` and writes no artifact meanwhile — flagging it at 15m is a false
positive. So the rule is **gated on the heartbeat PHASE**, and unreadable
liveness storage must NOT read as healthy (fail-safe, not fail-open).

1. **`lib/health.py`** (stdlib only):
   - `DEFAULT_WEDGED_AFTER = 900`; `WORKING_PHASE_PREFIX = "session-running"`.
   - `read_heartbeat(logdir)` → `{"ts": int, "phase": str, "until": int|None,
     "reason": str}` or `None` (absent / torn / unreadable). Canonical parser of
     the `bin/supervisor.sh heartbeat()` line format (`<ts>\t<phase>\t<until>\t
     <reason>`). Total. (dashboard_state.read_heartbeat parses the same format;
     re-pointing it here is the named dashboard follow-on — SD-32 "zero drift".)
   - `newest_session_epoch(logdir)` → newest `session-*.log` mtime (int) or
     `None`. Total (any OS error → `None`). No globstar — `os.listdir` + prefix.
   - `loop_health(logdir, now, wedged_after=DEFAULT_WEDGED_AFTER)` →
     `{"state", "phase", "age", "wedged_after", "reason"}` where `state` is:
       - `"unknown"` — heartbeat unreadable/absent (can't inspect → caller WARNs,
         never 'healthy'). **Not fail-open.**
       - `"idle"`   — phase is not a WORKING session (`session-running*`); a
         legitimately sleeping loop is never wedged.
       - `"ok"`     — WORKING session, `age <= wedged_after`.
       - `"wedged"` — WORKING session, `age > wedged_after`.
     `age = now - max(heartbeat.ts, newest_session_epoch)` (the session log
     advances during a live session; the `session-running` heartbeat ts is
     written once at session start, so the session-log mtime is the true liveness
     signal). `wedged_after <= 0` or non-int coerces to the default (a misconfig
     must not make everything wedged — fail-safe direction).
2. **`./start status` consumer** — a `start_loop_wedged(repo)` seam (best-effort,
   bounded, tests shadow it): a `python3 -c` shim importing `lib/health.py`
   against the repo's `var/autonomy-logs`, reading that repo's own
   `health.wedged_after` via `config_parser` (default 900), printing the
   `<state>\t<reason>` line. In the per-loop lifecycle branch, OK is printed
   **only** on an explicit healthy verdict (`ok`/`idle`); a `wedged` loop, an
   `unknown` loop, a blank line (the probe itself failed/timed out), or any
   unrecognised state all fall through to a WARN that **replaces** the plain
   `OK loop running` (never both — CP1 finding 4; the fail-safe default that OK
   must be *earned*, not the fallback — Codex CP2).
3. **Config knob doc** — a commented `health:` example in
   `templates/autonomy-pack/config.yaml` (parser reads it if present; absent →
   default). Template-only.
4. **Tests** — `tests/test_health.py` (failing first): heartbeat parse
   (ok/torn/absent), session-epoch discovery, and the full `loop_health` matrix
   incl. **the idle false-positive cases** (live loop in `board-empty`/
   `pace-wait`/`limit-backoff` with a stale write → `idle`, NOT wedged — CP1
   finding 5), unknown on unreadable heartbeat, threshold coercion, OS-error
   totality. Extend the `start` test to shadow `start_loop_wedged` and assert the
   WARN replaces the OK line for wedged/unknown and stays OK for a fresh session.

## Invariants
- **Fail-safe never fail-open:** unreadable heartbeat → `unknown` → WARN (never
  silent 'healthy'); a legit idle loop → `idle` (never a false wedged); best-
  effort `start` seam prints nothing on any failure and never aborts under
  `set -e`.
- **stdlib only; bash 3.2** (no globstar); **repo-agnostic** (logdir + threshold
  are inputs); **no process introspection** (engine artifacts only).
- `start` is shellcheck-gated but NOT in the barred guardrail set.

## Out of scope (named follow-on #81 slices)
Dashboard import of `health.py` + a `wedged` status-vocab token; the health strip
UI; `console.py`-as-blessed-manager README/skill docs; unifying
dashboard_state.read_heartbeat onto health.read_heartbeat.
