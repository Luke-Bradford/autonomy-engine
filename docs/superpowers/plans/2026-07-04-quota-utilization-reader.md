# Plan — #150 Slice A: shared utilization reader (bash-callable)

## Goal
Give the bash supervisor (Slice B, later) a way to read account utilization from
the SAME sources the dashboard uses, as a single `utilization(window) ->
float|None` plus a thin CLI. No core-loop change in this slice; pure +
unit-testable; ships alone.

## Why a new seam
`dashboard_state.py` (`recent_quota_windows`, log-scan) and `claude_usage.py`
(`live_quota`, #160) are Python-only and have no bash entrypoint. The supervisor
is bash. We must NOT fork the parse — the reader reuses both existing sources and
combines them with the dashboard's own precedence (live over log-scan).

Fidelity caveat (Codex CP1): the dashboard's *log-scan* fallback maxes windows
across ALL repos' logs in the frontend to approximate an account-level number; a
single supervisor process only knows its own repo's logdir, and an account-wide
registry (#4) does not exist yet. So the **live source is the account-accurate
primary** (it is already account-level — one shared cache in `claude_usage`), and
the log-scan is a **single-repo degraded fallback**. Documented as such; not
claimed to be byte-identical to the dashboard's cross-repo max.

## Design
New module `lib/quota.py` (stdlib only):

- `utilization(window, logdir=None, live_reader=_live, logscan_reader=_logscan)`
  - Normalize `window`: `5h`/`five_hour` → `five_hour`; `7d`/`seven_day` →
    `seven_day`; anything else → `None`.
  - **Live precedence is all-or-nothing** (matches `claude_usage._build`, which
    only ever returns a dict with BOTH windows valid, and
    `dashboard_page.html`, which replaces both windows when `source==live`):
    - `live = live_reader()` → the live windows dict or None. If it is a dict,
      LIVE IS AUTHORITATIVE — return this window's fraction from it and do NOT
      fall through to the log-scan (never mix live+log). If the specific window
      is somehow absent/malformed in a present live dict, return None (still no
      mixing).
    - Only when `live is None` do we consult the log-scan:
      `logscan_reader(logdir)` → `recent_quota_windows(logdir)` (or `{}`), read
      this window's fraction, else None.
  - Default seams contain ALL exceptions → None/`{}` (fail-safe):
    - `_live()`: `claude_usage.refresh_live_quota()` then `.live_quota()`, whole
      thing wrapped `except Exception: return None`. This process has no sampler
      thread, so it does the I/O inline — legitimate: there is no request thread
      to block (that "sampler-only" rule is the dashboard's threading model, a
      different process). Synchronous, ≤~7s worst case (keychain 4s + HTTP 3s
      timeouts); fine for the low-frequency supervisor gate, not a hot path.
    - `_logscan(logdir)`: `{}` if `logdir` is falsy (guards the `os.listdir(None)
      → TypeError` that `recent_quota_windows`' `except OSError` would NOT
      catch), else `recent_quota_windows(logdir)`, wrapped `except Exception:
      return {}`.
  - A "valid" fraction = a non-bool int/float ≥ 0. **Values > 1 are passed
    through**, not capped: an overage window legitimately reports >100%
    (`claude_usage._map_window` sets an `overage` flag and keeps util ≥ 0 with
    no upper cap), and that is precisely the strongest pause signal. Capping at 1
    would silently drop the overage case. A spuriously-high reading only causes
    an over-cautious pause (the reactive wall backoff still protects the
    account); a spuriously-low one would remove protection — so pass-through of
    ≥0 is the fail-safe direction. Malformed (bool/str/negative/None) → absent.
- `main(argv)` CLI: `quota.py <window> [logdir]`
  - available → print the fraction to stdout, exit 0
  - unavailable (None) → print nothing, exit 1
  - bad usage → stderr usage, exit 2
- `__main__` guard: `if __name__ == "__main__": sys.exit(main(sys.argv))`

## Invariants respected
- **Fail-safe never fail-open (Slice A's actual invariant):** the reader never
  fabricates a number. Every unreadable/stale/malformed/non-finite path returns
  None (CLI exit 1); it never invents a low value that would remove protection
  nor a high one that would pause. That is the whole of Slice A's fail-safe
  obligation — it is a *reader*, not a decider.
  - The pause-direction on "unknown" is **not Slice A's concern and not a
    fail-open on account protection**. It is Slice B's, and the ticket fixes it
    explicitly: unknown → do NOT pause. This does not fail open, because the
    guard is an *opt-in early* pause layered ON TOP of the existing reactive
    wall backoff — that backoff (which triggers at the real limit, independent
    of this reader) remains the true account protection whether or not the guard
    can read a number. So "no early pause on unknown" only forgoes an
    optimization; it never runs an unprotected account. Slice A stays neutral;
    Slice B carries that (operator-mandated) semantics and its own tests.
- **Don't fork the parse:** reuse `recent_quota_windows` + `claude_usage`.
- **Stdlib only.** **Repo-agnostic** (no owner/board/issue values). **bash 3.2**
  untouched (this slice is Python + one CLI; no supervisor edit yet).
- **Reset-epoch split** untouched (this reader never writes `.last_usage_reset`).

## Tests (TDD, `tests/test_quota.py`, real module sourced, seams injected)
1. window normalization: `5h`/`five_hour`/`7d`/`seven_day` map correctly; junk → None.
2. live present → returns the live fraction; log-scan IGNORED even if present
   (all-or-nothing: no mixing).
3. live None → falls back to the log-scan fraction.
4. both None / window absent in both → None.
5. live present but this window malformed → None (no fall-through to log-scan).
6. overage: live util 1.05 → returns 1.05 (not capped).
7. malformed values (bool/str/negative/None) in each source → absent.
8. exception containment: `live_reader` raises → contained → falls to log-scan;
   `logscan_reader` raises → contained → None; `logdir=None` → `{}` → None.
9. CLI: available → stdout fraction + exit 0; None → empty stdout + exit 1;
   bad args → exit 2.
Add `tests/test_quota.py` to `tests/run_all.sh`.

## Out of scope (later slices)
- Slice B: `engine.quota_guard` schema + supervisor dispatch gate.
- Slice C: dashboard `paused: quota guard` state + panel coloring.
