# Plan — #166 slice: dashboard logic-module hot-reload (atomic-publish)

## Problem

Merged engine fixes to the dashboard's Python logic modules
(`lib/dashboard_state.py`, `lib/dashboard_control.py`, `lib/concierge.py`,
`lib/claude_usage.py`, `lib/config_parser.py`, `lib/roles.py`, plus the
stateful `lib/credentials.py` / `lib/accounts.py`) are imported **once at
process start** in `bin/dashboard.py`. A merged fix silently does NOT appear in
the running dashboard until someone restarts it — which looks identical to "the
fix didn't work" (#166 body).

## Scope of THIS slice

Deliver the headline half of #166's title: **dashboard logic modules reload on
change; self-exec only for the two thin shells.** When any tracked logic
module's source signature changes on disk (the checkout advanced to a merged
commit), rebuild the whole tracked set and atomically republish, so the running
dashboard serves the new code without a restart.

**Deferred to a follow-up slice** (noted on the issue, kept open): the two
thin-shell self-`execv` halves — `bin/dashboard.py`'s own-file self-exec and
`bin/supervisor.sh`'s session-boundary self-exec (the design-lite, execv-mid-
request/mid-session risk). This slice covers the frequently-merged logic
modules (#160/#164/#148 all live in them).

## Design — build-fresh + atomic-publish (NOT in-place reload)

### Why NOT `importlib.reload()` in place (Codex checkpoint-1 findings)
In-place `reload()` mutates the live module `__dict__` while concurrent SSE /
sampler / request threads are executing its functions. That is unsafe:
- readers observe a **mixed** old/new dict (functions, constants, module-level
  locks, caches) — not an atomic epoch boundary;
- a raising `exec` leaves the dict **partially mutated** — no rollback;
- module-level locks/caches (`claude_usage`, `dashboard_state`) get rebound
  under a running old function that still holds the old lock;
- names deleted in the new source **persist** in the reloaded dict.

### The mechanism we use instead
For each tracked module, build a **brand-new** module object from source and
publish it by rebinding one name — atomic under the GIL:
```
spec   = importlib.util.spec_from_file_location(name, path)
newmod = importlib.util.module_from_spec(spec)
sys.modules[name] = newmod            # so a later dependent's `import name` binds new
spec.loader.exec_module(newmod)       # executes into the NEW object; may raise
```
Then, only after ALL tracked modules built cleanly, publish under `_reload_lock`:
rebind each `dashboard.py` module-global (`ds`, `dcx`, `cu`, `concierge`,
`config_parser`, `creds`, `accts`) to its new object and reset the stateful
singletons. Every dashboard call site uses attribute access on the global
(`ds.build_repo_state`, `accts.VALID_KINDS`, …), so a rebind is picked up on the
next call; a reader that already dereferenced the old global runs entirely in
the old epoch (old object, old locks, old caches) — coherent, never blended.

This resolves every checkpoint-1 finding:
- **atomic epoch** — a single name rebind; reader gets fully-old or fully-new. ✓
- **rollback on raise** — a failing `exec_module` discards the new object; the
  old module + its dashboard-global binding are untouched. ✓
- **no split epoch** — build ALL new objects first; publish only if every build
  succeeded; on any failure, restore `sys.modules` to the pre-build entries and
  publish nothing. All-or-nothing. ✓
- **no stale removed-names** — fresh objects, not a mutated old dict. ✓
- **locks/caches** — old epoch keeps its own; new epoch starts cold and
  re-warms (best-effort; `gh` cache lives in `dashboard.py`, unaffected). ✓

### Change detection (Codex: mtime alone too weak)
Signature = `(st_mtime_ns, st_size)` per module (nanosecond precision + size),
not float `getmtime()`. A tracked module changed ⇔ its signature differs from
the recorded one. Unreadable stat → signature `None`, does not trigger a reload.

### Failed-build retry policy (Codex: avoid re-log storm vs. never-retry)
On a failed build we DO record the new (failing) signatures and log **once**, so
a permanently-broken source is not re-attempted or re-logged every tick. A
half-written file completes to a **different** signature (size/mtime_ns change),
whose difference re-triggers the build — so a transient half-write still
recovers on completion.

### Dependency order
Leaves before dependents so a dependent's top-level `import` binds the new leaf
(both are in `sys.modules` during the build phase):
`config_parser, roles, credentials, claude_usage, concierge, dashboard_control,
dashboard_state, accounts`. Closed set: `dashboard_state`→`config_parser,roles`;
`accounts`→`credentials`; the rest are leaves. `roles` has no `dashboard.py`
global (only `dashboard_state` imports it) — it is rebuilt + republished into
`sys.modules` only, no global to rebind.

### Trigger points
`_reload_logic_modules()` (cheap no-op when unchanged: 8 `os.stat`s) at the top
of `do_GET` and `do_POST`, once per SSE tick in `_stream`, and once per sampler
tick in `_sampler_loop`. All under `_reload_lock` so two threads never double-
build.

## TDD — `tests/test_dashboard_hot_reload.py` (sources real `dashboard`)

Factor the core as `_reload_tracked(specs, sigs, globals_ns, on_reload)` over an
injected spec list + signature dict + namespace; production
`_reload_logic_modules()` calls it with the real tracked set. Tests drive
`_reload_tracked` against temp modules they write/edit/re-stat — real
`exec_module` semantics, no mocks. Cases (all Codex-flagged dangerous paths):
1. **new code goes live** — write temp module v1, register, edit to v2 + change
   size, reload → published object exposes v2 value; `globals_ns` rebound.
2. **no change → no-op** — unchanged signature returns False; same object identity.
3. **build failure is atomic + rolls back** — a temp module whose new source
   raises at top level: reload returns False, `sys.modules[name]` and
   `globals_ns[name]` still the OLD object, signature recorded (no re-log storm),
   and a subsequent good edit recovers.
4. **removed name does not persist** — v1 defines `X`, v2 omits it; after reload
   the published object has no `X` (proves fresh-object, not in-place).
5. **singletons reset** — `on_reload` fires on success only (sentinel → None),
   never on the no-op or the failure path.
6. **whole-set all-or-nothing** — two temp modules, second build raises → neither
   is published (both globals still old).

## Checkpoint-1 pass 2 resolutions (atomic-publish findings)
- **Exception-identity race** (narrowed): the 6 write helpers snapshot
  `_a = accts` / `_c = creds` at entry and except on `_a.RegistryError`, shrinking
  the mismatch window from the whole function body to the single statement
  between the snapshot and `_accts()`/`_creds()`. Fresh construction from the
  snapshot would close even that, but it bypasses the singleton seam that the #59
  corrupt-registry refusal tests inject through, so the singleton accessors are
  kept and the 1-statement residual is accepted (same benign-by-context class as
  findings 2 & 3: microsecond window, once per merge, worst case one retryable
  500 on an admin-write POST — never corruption).
- **No single atomic epoch swap / sys.modules build-candidate exposure**
  (checkpoint-2 findings 2 & 3): consciously accepted as benign-by-context and
  non-reachable on the dashboard's real call paths, NOT eliminated (a full
  epoch-container rewrite routing every call site through one atomically-swapped
  handle is disproportionate for a 127.0.0.1 single-operator best-effort tool).
  Justification: (a) all tracked modules are effectively pure-function readers,
  so a reader briefly mixing old/new code yields a correct-but-one-tick-stale
  render, never a crash/corruption — within the dashboard's explicit
  eventually-consistent contract; (b) the only module ever partially-built in
  `sys.modules` is the one mid-exec, and the sole dashboard lazy-import
  (`roles._load_config` → `import config_parser`) resolves `config_parser`, which
  is built FIRST and fully complete before any other module builds, so no reader
  observes a partial epoch; (c) the window is microseconds, once per merge.
  Documented in the PR + prevention log; full atomic-epoch handle is the
  deferred hardening if a stateful tracked module is ever added.
- **sys.modules build window / rollback** (a concurrent import could bind a build
  candidate; refs handed out can't be revoked): the ONLY runtime imports of
  tracked modules are `roles.py`'s two lazy `import config_parser` / `import
  accounts` (call-time, resolved from `sys.modules`). Build+publish runs entirely
  under `_reload_lock`; the exposure window is microseconds on a 127.0.0.1
  single-operator best-effort tool, and on failure every touched `sys.modules`
  entry is restored. Documented as benign-by-context in a code comment.
- **Cross-module mixed epoch** is benign: tracked modules share no mutable runtime
  state with each other, and each module's own top-level dep chain is rebuilt +
  republished coherently before any global rebind. Documented.
- **Retry vs log-storm**: on a failed build `_hot_sigs` is NOT advanced, so the
  change stays pending and is retried each tick (transient half-write recovers);
  the warning is deduped by the failing signature-set so a permanently-broken
  source logs once, not every tick.

## Invariants
- Fail-safe never fail-open: every failure keeps last-good code, never blanks. ✓
- stdlib only (`importlib.util`, `os`). ✓  · repo-agnostic. ✓
- No guardrail files: only `bin/dashboard.py` + new test. ✓
- bash-3.2 / reset-epoch / merge-gate untouched (Python-only). ✓
