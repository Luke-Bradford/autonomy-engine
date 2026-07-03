# #166 slice 1 — mtime-triggered reload of dashboard logic modules

Operator-settled (issue #166 comments): the dashboard is a thin HTTP shell;
~all change-churn lands in the pure-ish logic modules, invoked per request. So
reload THOSE on mtime change — merged `lib/*.py` fixes (#160/#164/#148) go live
on the next poll, no restart, no blip, stdlib only. Rejected: hot-reloading the
whole server. Slice 2 (self-exec for the two thin shells `bin/dashboard.py` /
`bin/supervisor.sh`) is DEFERRED — the supervisor self-exec is delicate to land
unattended on the live self-loop; slice 1 alone removes the operator's stated
pain (dashboard fixes silently not live).

## Scope (slice 1 only)

Files: `bin/dashboard.py`, `lib/dashboard_page.html`, `tests/test_dashboard_server.py`.

### bin/dashboard.py

- Reload set = the operator-named logic modules: `dashboard_state`,
  `dashboard_control`, `concierge`. (NOT `claude_usage`/`config_parser` — rare
  churn, and claude_usage's sampler-thread cache makes a reload race not worth
  it; noted.) The HTTP shell, threads, SSE state, throughput buffer, control
  token all stay put — exactly the state that should survive.
- `reload_stale_modules(modules=_RELOADABLE, stat_fn=_module_mtime,
  reload_fn=importlib.reload)`:
  - for each module, `stat_fn(mod)` its `__file__` mtime; skip if unreadable or
    `<= last-seen`;
  - changed → `reload_fn(mod)`; on success update last-seen mtime and clear that
    module's error;
  - **fail-safe:** reload raising → KEEP the old (working) module, record
    `_reload_errors[name] = <ExcType>`, and still advance last-seen mtime so a
    broken mid-edit file isn't retried every request (retried only on the NEXT
    change / fix);
  - `_reload_lock`-guarded; returns the current `{name: err}` dict.
  - `stat_fn`/`reload_fn` are injected so the decision logic is unit-tested with
    fake module objects (no real importlib needed in the test).
- Last-seen mtimes initialised at import (so the first request doesn't reload
  everything once).
- Call `reload_stale_modules()` at the TOP of `collect()` (single-threaded there,
  before the per-repo pool), so the reloaded `ds`/`dcx`/`concierge` are used for
  this snapshot. Because callers reference `ds.func` (module attribute) and
  `importlib.reload` updates the module object in place, existing `ds`/`dcx`/
  `concierge` names pick up the new code with no rebinding.
- Add `"reload_error"` to the `collect()` payload: a short joined string of any
  lingering per-module failures, else None.

### lib/dashboard_page.html

- A header chip when `s.reload_error` is set: `reload failed: <modules>` (warn
  styling), so a bad reload is visible truth, never a silent stale dashboard.
  `esc()` the message.

## Fail-safe / invariants

- A reload that raises never takes the dashboard down (old module stays live) —
  best-effort, honest chip. Matches the "dashboard hiccup ≠ engine failure" rule.
- No new gh/network; reload is a few `os.stat` calls per snapshot. No new
  endpoint. Repo-agnostic, stdlib only.

## TDD (tests/test_dashboard_server.py)

Inject `stat_fn`/`reload_fn` with fake module objects (SimpleNamespace with
`__name__`/`__file__`):
1. unchanged mtime → reload_fn NOT called.
2. newer mtime → reload_fn called once, mtime advanced, no error.
3. reload_fn raises → error recorded, old module kept (reload attempted once),
   mtime advanced (not retried on an unchanged next call).
4. recovery: after a failure, a further mtime bump with a now-succeeding
   reload_fn clears the error.
5. unreadable stat (stat_fn None) → skipped, no reload, no error.

Browser FE-QA: dashboard renders normally (no chip in the healthy case), zero
console errors, /api/state carries `reload_error: null`.

## Out of scope (slice 2, deferred — note on #166)

Self-exec for `bin/dashboard.py` (kickstart) and `bin/supervisor.sh`
(session-boundary exec). The supervisor one is sensitive on the live self-loop;
file a follow-up rather than land it unattended.
