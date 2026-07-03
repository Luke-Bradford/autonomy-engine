# W1 Scheduler (cron triggers) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or
> superpowers:executing-plans) to implement task-by-task. **Codex checkpoint 1 on this plan before
> execution** (settled-decision #19). Steps use checkbox (`- [ ]`) tracking.

**Goal:** Fire `trigger.type: cron` roles on their schedule by folding a cron check into the
supervisor's existing loop iteration, reusing `run_session` and the lifetime-held per-repo lock. No
new launchd, no new lock. Unblocks #14 (PM cron) and #15 (Researcher cron).

**Spec:** `docs/superpowers/specs/2026-07-03-scheduler-cron-design.md`. Issue: #85.
Branch: `feat/85-scheduler-cron`.

**Architecture (from the spec):** `roles.py cron <repo>` enumerates cron roles + schedules; the
supervisor computes due-ness via the existing `cron_next_fire` against a supervisor-owned per-role
last-fire marker, and fires due roles through `run_session` inside the loop iteration (under the
held lock, one session at a time).

## Global constraints (CI-enforced)

- macOS `/bin/bash` 3.2.57: NO `mapfile`/`readarray`, NO globstar, NO `declare -A`, NO `${var,,}`.
- Python 3 **stdlib only**; config parsing only via `lib/config_parser.py`.
- `shellcheck -S warning` clean: `start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh`.
- Tests source the real scripts / import the real modules; stub only at the `run_session` /
  `roles.py cron` seam (the seams already used by `test_headless_dispatch.sh`).
- **Fail-safe never fail-open:** enumeration/due-check failure skips cron and leaves loop dispatch
  byte-for-byte unchanged; a marker-write failure skips firing (under-fire, never over-fire).
- **Sole-writer invariant:** only the supervisor writes `$VARDIR/cron/*.last_fire` (reset-epoch
  split, generalised — prevention/settled-decision: adapters never persist scheduling state).
- **Config-sourced strings re-validated at point of use** (prevention-log #6): a cron role name
  reaches a filesystem path (`$VARDIR/cron/<role>.last_fire`) — charset-gate it exactly as
  `ROLE_AGENT`/`ROLE_MODEL` are gated in `run_session`.
- No regression: with no cron roles, the loop behaves byte-for-byte as today.

## File map

- Modify: `lib/roles.py` — add `cron_roles(config)`; add a `cron` verb to `_dispatch_main`
  (or the CLI dispatcher) emitting `NAME<TAB>SCHEDULE`.
- Modify: `bin/supervisor.sh` — add `resolve_cron_due` (enumerate + due-check + marker read),
  fire due roles via `run_session`, write the marker; call it once per loop iteration.
- Create: `tests/test_scheduler.sh` — sources `bin/supervisor.sh`, stubs `run_session` +
  `roles.py cron`.
- Test: `tests/test_roles.py` — extend for `cron_roles` + the `cron` verb.

---

### Task 1: `cron_roles(config)` + `roles.py cron` verb

**Files:** Modify `lib/roles.py`; Test `tests/test_roles.py`.

**Interfaces:**
- Consumes: `_effective`, `DEFAULT_ROLES`, `_ROLE_NAME_RE`, the roster-merge semantics used by
  `dispatch_roles`.
- Produces: `cron_roles(config) -> list[(name, schedule)]` (stable order: standard roster first,
  then custom roles in config order; enabled AND effective trigger type `cron` AND non-blank
  schedule). CLI `roles.py cron <repo>` prints `NAME\tSCHEDULE` per line. **Also add the
  `roles.py cron-due <schedule> <last> <now>` verb here** (prints `due`/`not-due` via
  `cron_next_fire`; keeps all cron logic in Python — Task 2 consumes it).

- [ ] **Step 1: Failing tests** in `tests/test_roles.py`:
  - a role `enabled: true, trigger: {type: cron, schedule: "0 3 * * *"}` appears as
    `("pm", "0 3 * * *")` (use `pm`, a roster cron role, and a custom cron role).
  - a cron role with a **blank/missing** schedule is skipped.
  - a `loop` role and a disabled cron role do NOT appear.
  - the `cron` CLI verb over a temp repo emits the `NAME\tSCHEDULE` lines; empty when none.
  - `cron-due "*/5 * * * *" <last> <now>` prints `due` when a 5-min slot elapsed since `<last>`,
    `not-due` otherwise; unparseable schedule → `not-due` (fail-safe).
- [ ] **Step 2:** run — expect FAIL (`cron_roles` undefined / no `cron`/`cron-due` verb).
- [ ] **Step 3: Implement.** `cron_roles` mirrors `dispatch_roles` (swap `ttype == "loop"` for
  `ttype == "cron"`, read the schedule from `cfg["trigger"]["schedule"]`, skip blank). Add a `cron`
  branch to the CLI that loads the repo config (`_load_config`) and prints `"%s\t%s" % (name, sched)`.
- [ ] **Step 4:** run `python3 -m unittest tests.test_roles -v` — expect PASS (all).
- [ ] **Step 5: Commit** — `feat: roles.py cron enumeration (cron_roles + cron CLI verb) (#85 task 1)`.

---

### Task 2: supervisor due-check + fire + marker

**Files:** Modify `bin/supervisor.sh`; Create `tests/test_scheduler.sh`.

**Interfaces:**
- Consumes: Task 1's `roles.py cron`; existing `run_session`, `$VARDIR`, `cron_next_fire` (via a
  Python one-liner), the `log` helper, the role-name charset gate idiom.
- Produces: `resolve_cron_due` fires each due cron role via `run_session` and advances its marker;
  first-sight initialises the marker without firing; failures skip cron without touching loop
  dispatch.

- [ ] **Step 1: Failing test** in `tests/test_scheduler.sh` (source `bin/supervisor.sh`; set
  `VARDIR` to a temp dir; stub `run_session` to append the role to a capture file; stub the
  `roles.py cron` call via the enumeration seam — factor enumeration behind a function the test can
  override, e.g. `_cron_enumerate`):
  - a role whose marker is old enough that `cron_next_fire(schedule, marker) <= now` **fires**
    (capture contains it) and its marker is rewritten to `now`.
  - a role not yet due does **not** fire.
  - a **first-sight** role (no marker) does **not** fire but a marker file is created.
  - `_cron_enumerate` failing (rc!=0) → `resolve_cron_due` returns without firing and without error
    (loop unaffected).
  - a cron role name with invalid path chars is ignored with a WARN (prevention-log #6).
- [ ] **Step 2:** run `bash tests/test_scheduler.sh` — expect FAIL.
- [ ] **Step 3: Implement `resolve_cron_due`** in `bin/supervisor.sh`:
  - enumerate via `_cron_enumerate` (wraps `python3 lib/roles.py cron "$AUTONOMY_TARGET_REPO"`;
    rc!=0 → return 0 silently, best-effort).
  - `mkdir -p "$VARDIR/cron"` once. For each `name<TAB>schedule`:
    - charset-gate `name` (`*[!A-Za-z0-9_-]* ) log WARN; continue`).
    - `marker="$VARDIR/cron/$name.last_fire"`; if absent → write `now` (via `date +%s`) and
      `continue` (first-sight, no fire).
    - `last="$(cat "$marker")"`; ask Python whether the role is due — keep ALL cron logic in
      `roles.py` (no fragile inline `import roles`; the supervisor invokes `roles.py` by path, so an
      inline `-c` import would need an explicit `PYTHONPATH`). **Add a `cron-due <schedule> <last>
      <now>` verb** to `roles.py` that prints `due`/`not-due` (rc 0) using `cron_next_fire` — the
      supervisor just tests the string. If `due`: `run_session "$name"`; then write `now` to the
      marker (guard the write — on failure `log WARN` and do not loop-fire). A `cron-due` rc!=0 or
      unexpected output → treat as not-due (fail-safe: under-fire).
  - Call `resolve_cron_due` once per loop iteration in `main` (after the loop-role dispatch block,
    still inside the held lock). It must never `exit` non-zero.
- [ ] **Step 4:** run `bash tests/test_scheduler.sh && bash tests/test_headless_dispatch.sh` —
  expect PASS + no regression to loop dispatch.
- [ ] **Step 5: shellcheck** `bin/supervisor.sh tests/test_scheduler.sh` — expect no output.
- [ ] **Step 6: Commit** — `feat: supervisor fires due cron roles via run_session (sole-writer last-fire marker) (#85 task 2)`.

---

### Task 3: wire-through smoke + docs note

**Files:** Modify `bin/supervisor.sh` (the `main` call site if not already in Task 2); update the
README/`docs` "Agent adapters"/roles section to note cron roles now fire (loop-cadence granularity).

- [ ] **Step 1:** add `tests/run_all.sh` entry for `test_scheduler.sh` (if the harness enumerates
  explicitly).
- [ ] **Step 2:** `bash tests/run_all.sh` green; `shellcheck` clean across the enforced set.
- [ ] **Step 3: Commit** — `docs: note cron roles fire on schedule (loop-cadence granularity) (#85 task 3)`.

---

## Self-review notes

- Spec coverage: enumeration → Task 1; due-check + fire + marker → Task 2; wire-through/docs →
  Task 3. `cron_next_fire` (existing) is reused, not reimplemented.
- Invariants: sole-writer marker (Task 2) = reset-epoch split generalised; one-session-per-iteration
  preserved (cron fires under the held lock, sequential with loop dispatch); fail-safe (enumeration
  failure and marker-write failure both skip firing, never crash the loop or over-fire); charset
  re-validation at the marker path (prevention-log #6).
- No-regression: Task 2 keeps `test_headless_dispatch.sh` green (loop dispatch untouched when no
  cron roles / when enumeration fails).
- **Guardrail note:** this plan touches only `lib/roles.py`, `bin/supervisor.sh`, `tests/`, `docs/` —
  NOT `.autonomy/**`, `bin/safe_merge.sh`, or `.github/workflows/**`. The self-pack `pm`/`researcher`
  cron rails (which DO touch `.autonomy/**`) are W5 and land under operator review.
