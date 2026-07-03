# W1 — Scheduler (cron triggers) — design spec

> Status: **operator-delegated design** (2026-07-03). Authored by the autonomy loop under the
> full-autonomy grant recorded in `2026-07-03-configurable-workflows-design.md` (the operator asked
> for the product flow to be built without gating each increment on them), following the same
> per-increment `spec → plan → PR` precedent that landed the BYO-LLM spec (#78/#91) and the
> configurable-workflows umbrella (#83/#84). This is increment **W1** of that umbrella. Issue: #85.
> Unblocks #14 (PM cron sweep) and #15 (Researcher cron deep-dive).
>
> One decision (cron granularity, §Open questions) is flagged for operator veto; it does not block
> the design, and the recommended default is the fail-safe one.

## Goal

Let a role whose `trigger.type` is `cron` fire on its schedule, reusing the existing headless
dispatch path (`run_session`: resolve account → source adapter → scoped session). After this
increment, `pm` (cron grooming) and `researcher` (cron deep-dive) run on a schedule instead of
being inert config. The engine ships the mechanism; each repo's `.autonomy/config.yaml` supplies
the schedules.

## What already exists (do not rebuild)

The **schema and cron-evaluation layer is already built and tested** in `lib/roles.py`:

- `VALID_TRIGGERS = ("loop", "cron", "event")`; `validate_roles` already requires a non-empty
  `schedule` for a `cron` trigger and rejects unknown trigger types.
- `cron_next_fire(expr, now_epoch)` — a standard 5-field cron evaluator (GitHub-Actions/UTC
  semantics) returning the next fire epoch strictly **after** `now`, `None` on anything
  unparseable. Backed by `_cron_field` (supports `*`, `*/n`, `a`, `a-b`, `a,b,c`).
- `dispatch_roles(config)` returns the **loop** roles the supervisor round-robins, and *deliberately
  excludes* cron/event roles with the comment "cron/event roles belong to increment 4's
  scheduler/event bus." This spec fills exactly that hole.
- `_effective(cfg, defaults)` → `(enabled, trigger_type)` with roster-default merge semantics
  (mirrors `dashboard_state.build_roles`; settled-decision #14).

So W1 adds **enumeration of cron roles + a due-check + a fire path** — not a cron parser, not schema.

## The design fork, and why the code resolves it

Issue #85 names the fork: "how a one-shot cron invocation shares `run_session` + the per-repo lock."

The per-repo lock (`bin/supervisor.sh`, `$VARDIR/autonomy-supervisor.lock`) is a **lifetime-held**
`mkdir` mutex: the supervisor grabs it once before its loop and holds it until it exits
(`trap 'rm -rf "$LOCK"' EXIT INT TERM`). A **separate** scheduler process — the "lean launchd
per-cron-agent" idea from the older agent-org spec — could therefore **never acquire that lock while
the supervisor is running**; the two would deadlock or the scheduler would spin forever. That older
idea predates the lifetime-lock design and is superseded here.

The lock architecture forces the answer: **fold the cron scheduler into the supervisor's existing
loop.** Each loop iteration already holds the lock and runs exactly one session
(settled-decision #12, "one session per loop iteration"). Checking cron roles inside that same
iteration reuses the held lock, the one-session-at-a-time invariant, and `run_session` verbatim —
**zero new launchd, zero new lock, zero new concurrency surface.**

### Approaches considered

- **A. Fold into the supervisor loop (RECOMMENDED).** Each iteration, after enumerating loop roles,
  the supervisor also enumerates cron roles, computes which are due, and fires the due ones via
  `run_session`. Reuses the lock + `run_session`; no new process; degrades safely. Cost: cron
  firing granularity is bounded by loop cadence (see §Open questions).
- **B. Separate launchd scheduler sharing the lock.** Ruled out: the lifetime-held lock makes a
  concurrent second process impossible without re-architecting the lock into a per-session lease —
  a much larger, riskier change that would touch the core dispatch invariant. Not W1.
- **C. Separate launchd scheduler with its own lock.** Ruled out: two agent sessions (loop + cron)
  could then run against the same worktree concurrently — git contention and a broken
  one-session-per-repo safety property. The whole point of the single lifetime lock is to prevent
  this.

## Architecture (Approach A)

```
supervisor loop iteration (holds autonomy-supervisor.lock):
  1. resolve_dispatch_roles      -> loop roles   (existing)
  2. select_role + run_session   -> one loop session (existing, round-robin)
  3. resolve_cron_due            -> NEW: cron roles whose next-fire <= now
  4. for each due cron role: run_session <role>; record last-fire = now   (NEW)
```

Two new units, each small and independently testable:

### 1. `lib/roles.py`: `cron_roles(config)` + a `cron` CLI verb

- `cron_roles(config)` mirrors `dispatch_roles` but selects effectively-enabled roles whose
  effective trigger type is `cron`, returning a list of `(name, schedule)` in the same stable order
  (standard roster first, then custom roles in config order). A cron role with a missing/blank
  schedule is skipped (defense in depth — `validate_roles` already rejects it upstream, but
  enumeration must not emit a scheduleless entry).
- CLI: `roles.py cron <repo>` prints one `NAME<TAB>SCHEDULE` line per cron role — the same
  enumeration-contract style as `roles.py dispatch <repo>` (word-split-safe on the supervisor side;
  schedules never contain a tab). rc 0 with no lines = no cron roles.

### 2. `bin/supervisor.sh`: `resolve_cron_due` + firing

- `resolve_cron_due` enumerates cron roles (via the new verb), and for each computes due-ness:
  a role is **due** when `cron_next_fire(schedule, last_fire) <= now`, where `last_fire` is the
  persisted marker for that role. Delegated to a tiny Python one-liner over `cron_next_fire`
  (no cron logic re-implemented in bash).
- **Last-fire marker (reset-epoch-split analogue).** The supervisor is the **sole writer** of each
  cron role's last-fire epoch, mirroring the `.last_usage_reset` invariant (adapters never persist
  scheduling state). Stored per role at `$VARDIR/cron/<role>.last_fire` (one file per role;
  bash-3.2-friendly; role names are already charset-gated before they reach a path — prevention-log
  #6). A due role fires via `run_session <role>`, then the marker is written to `now`.
- **First-sight semantics:** a cron role with **no** marker yet initialises its marker to `now`
  **without firing** (RECOMMENDED — avoids a thundering fire of every cron role the first time the
  supervisor starts, and avoids "catch-up storms" after downtime). Flagged in §Open questions.

## Fail-safe / invariants

- **Enumeration or due-check failure → skip cron this tick, never crash the loop.** Cron dispatch is
  additive; a `roles.py cron` hiccup or a bad `cron_next_fire` must leave loop-role dispatch
  byte-for-byte unchanged (best-effort, like `board.sh`/`unblock_dependents.sh`).
- **A due cron role that will not resolve refuses its session** — `run_session`'s existing fail-safe
  (account unresolvable / adapter unusable / prompt missing → REFUSE). No new fail-open path.
- **Marker write failure → warn and skip firing** (never fire repeatedly because the marker didn't
  advance). Fail-safe: under-fire, never over-fire.
- **Sole-writer:** only the supervisor writes `$VARDIR/cron/*.last_fire` — the reset-epoch-split
  invariant generalised to scheduling state.
- **One session at a time:** cron firing happens inside the loop iteration under the held lock, so
  the one-session-per-repo property (settled-decision #12) is preserved. If both a loop role and a
  cron role are due in one iteration, they run **sequentially**, never concurrently.
- macOS bash 3.2.57; Python 3 stdlib only; source-guards; `shellcheck -S warning` clean; tests
  source the real scripts and stub only at the `run_session` / `roles.py` seam.

## Testing (the seams)

- `tests/test_roles.py`: `cron_roles` selects only enabled cron roles in stable order; skips
  scheduleless; the `cron` CLI verb emits `NAME<TAB>SCHEDULE`; empty when no cron roles.
- `tests/test_scheduler.sh` (new, sourcing `bin/supervisor.sh`): `resolve_cron_due` with a stubbed
  `roles.py cron` + a fixed `now` fires a role past its next-fire, skips one not yet due, initialises
  a first-sight marker without firing, and leaves loop dispatch untouched when enumeration fails.
  `run_session` stubbed to a capture file (the established seam in `test_headless_dispatch.sh`).

## Out of scope (later increments)

- Event triggers (`trigger.type: event`) — W2 / #86.
- The PM/Researcher **prompt rails** and the default workflow template — W5 / #89. This increment
  only makes an *already-configured* cron role fire; it ships no role prompts and does not modify
  `.autonomy/**` (the self-pack `pm`/`researcher` rails land in W5 under operator review, per the
  guardrail rule).
- A precise, loop-cadence-independent tick (see §Open questions) — only if the operator wants it.

## Open questions (recommended defaults chosen; operator may veto)

1. **Cron granularity.** Folding into the loop means a cron role is checked once per loop iteration;
   a long loop session (many minutes) delays the check, so firing is "roughly at" the schedule, not
   to-the-minute. **Recommendation: accept loop-cadence granularity for W1** — the cron workloads
   (PM grooming, Researcher deep-dive) are not minute-critical. A to-the-minute tick would require
   re-architecting the lifetime lock into a per-session lease (Approach B/C) — a separate, larger
   ticket, only if the operator needs precision.
2. **First-sight / catch-up.** Recommendation: initialise the marker without firing and never
   "catch up" more than one fire after downtime (fire once when due, then reset the marker to now).
   Alternative (fire-on-first-sight) risks a startup storm. Fail-safe = under-fire.
3. **Marker location.** `$VARDIR/cron/<role>.last_fire` (per-role files) vs a single JSON state
   file. Recommendation: per-role files — simplest in bash 3.2, atomic single-value writes, trivial
   to reason about; revisit only if a role count makes it unwieldy.
