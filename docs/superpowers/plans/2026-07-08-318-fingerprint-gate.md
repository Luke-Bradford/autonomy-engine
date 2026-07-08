# #318 — deterministic pre-session fingerprint gate + idle backoff

Spec: issue #318. CP1 (spec pass) findings folded in below. Goal: stop paying a
full LLM session every `PACE`s to re-derive a board that has not changed;
skip only on an EARNED, exact match with state a previously COMPLETED session
already examined.

## Direction on Codex's "fail-open" blocking finding

Skipping on an unprovable "unchanged" would hide work — that is the dangerous
side. On ANY fingerprint failure (gh error, page cap, git error) the gate
REFUSES to certify "unchanged" and falls through to the existing dispatch path
(session runs, exactly pre-#318 behaviour). Cost is tokens, never correctness.
This matches Codex's own remedy ("unknown must fall to the existing dispatch
path"); the issue's phrase "fail toward running" and Codex's "never certify
unchanged on failure" are the same rule seen from both sides.

## Design (CP1 findings folded)

- **Per-role, per-lane key** (CP1: repo-level key suppresses sibling roles).
  State file `$LOGDIR/.fingerprint-<role>` (`.fingerprint-<role>--<lane>` when
  `AUTONOMY_LANE` set). `$LOGDIR` lives in the lane's own worktree, so lanes
  are additionally path-isolated. Role/lane names re-validated
  `[A-Za-z0-9._-]` before path embedding (prevention-log #6); invalid → gate
  refuses (session runs).
- **Material, canonicalised** (CP1: deterministic sort, no raw JSON byte
  order):
  - open issues `gh issue list --state open -L 200 --json number,updatedAt`
    projected via `--jq 'sort_by(.number)|map("\(.number) \(.updatedAt)")|.[]'`;
    **count == limit → refuse** (page cap = unfingerprintable, CP1);
  - open PRs `gh pr list --state open -L 100 --json number,headRefOid,updatedAt`
    same treatment, same cap rule;
  - remote main head `git ls-remote origin refs/heads/main` (direct pushes are
    rare behind branch protection but cheap to observe); failure → refuse;
  - the role's resolved contract: raw bytes of EVERY pack file that shapes a
    session — `.autonomy/config.yaml`, `loop_prompt.md`, `hard_rules.md`, all
    `roles/*.md` (sorted file list, then contents) — plus the persistent
    `$LOGDIR/config-overrides` overlay (if present), the CLI override set
    (`$AGENT_TYPE_OVERRIDE|$MODEL_OVERRIDE|$FALLBACK_MODEL_OVERRIDE|`
    `$EFFORT_OVERRIDE`), and role + lane (CP1 pass 2: a prompt/rules edit or a
    restart with different flags must bust the fingerprint);
  - **pending one-shot `$LOGDIR/model-override` → refuse outright** (CP1: a
    queued next-session contract must force a session, never be skipped over).
  - all piped to `shasum -a 256`.
- **Sole writer** (CP1): the fingerprint is computed and the state file
  written ONLY by `bin/supervisor.sh`. No helper writes state.
- **Record only after a clean session** (CP1: crash/limit/refusal must not
  bury unfinished work): the pre-session fingerprint value is held in a local
  and written IFF `run_session` returns 0. rc 2/3/other → nothing recorded →
  next tick re-runs.
- **Placement**: after `select_role`, before the dispatch heartbeat — i.e.
  AFTER `resolve_cron_due` + `resolve_event_wakes` (CP1: cron/event contracts
  fire every active tick regardless of the loop-role fingerprint) and after
  the pause check.
- **Backoff is an in-memory counter only** (CP1: persisted absolute
  "idle-until" is clock-fragile): consecutive-skip counter, schedule
  120 → 300 → 900 → 1800 cap; any session actually run (any rc) resets it;
  supervisor restart trivially resets it. No backoff state file.
  **Cron/event cadence guard** (CP1 pass 2): cron due-checks and event polls
  run at the TOP of each tick, so a long skip sleep would starve them. When
  the repo has any enabled cron or event role (`has_scheduled_roles`, one
  `roles.py` call per skip — same cost class as the tick's own
  `resolve_cron_due`), the effective skip sleep is capped at 300s; the full
  schedule applies only to loop-role-only repos. A skipped tick costs a few
  `gh`/python calls, zero LLM tokens — the cap trades pennies for unchanged
  scheduler latency.
- **Pause-aware idle** (CP1): the skip sleep runs in `PAUSE_POLL` slices and
  breaks early when the pause sentinel appears, so a paused dashboard command
  takes effect within ~30s, not after a 30-min backoff window.
- **Narrated skip** (#177): heartbeat `fingerprint-idle` with the next-check
  epoch; log line states role + skip count + sleep.
- `session_ran` stays 0 on a skip — no fabricated `session.done` edge.

## Tasks (TDD; bash 3.2; shellcheck -S warning incl. the test)

1. `tests/test_fingerprint_gate.sh` — source the real supervisor, stub `gh`/
   `git` as shell functions (established seam). Failing first. Cases:
   - identical material twice → same hash; changed `updatedAt` → different.
   - gh failure / issue-cap 200 / pr-cap 100 / git failure → gate refuses
     (rc 1, no hash) → caller must run.
   - pending model-override file → refuses.
   - config.yaml byte change / config-overrides change / role change / lane
     change → different hash.
   - role or lane with a path metachar → refuses (never a filename).
   - `fingerprint_state_file <role> <lane>` is the ONLY path constructor
     (CP1 pass 2: no hidden lane global in the record call); both compare and
     record go through it; it refuses bad charsets.
   - `record_fingerprint <role> <lane> <fp>` writes atomically; its only call
     site is the outcome-0 arm (grep-asserted, same style as the sole-writer
     reset-epoch tests — belt on top of the behavioural cases).
   - backoff schedule function: 1→120s … cap 1800, reset semantics.
   - pause-aware sleep: sentinel appearing mid-idle breaks the wait early.
2. Implement in `bin/supervisor.sh`: `fingerprint_material`, `role_fingerprint`
   (compute-only), `fingerprint_backoff <n>`, `idle_sleep <secs>` (pause-aware),
   `record_fingerprint <role> <fp>`; wire the run-loop arm.
3. README: short "fingerprint gate" paragraph under the supervisor section.

## CP2 findings folded (post-implementation)

- Pack material is EVERY file under `.autonomy/` PLUS the role's resolved
  `prompt:` file wherever it lives (roles.py allows any repo-relative path,
  any extension) — the resolved dispatch contract (`roles.py dispatch`
  output) joins the material, and its PROMPT path is read into the hash.
- Pack traversal moved INSIDE the python hasher (`os.walk` with
  onerror=raise; every file opened, read errors raise): a suppressed
  find/cat failure can no longer hash partial material — any read error
  exits nonzero and the gate refuses. A missing `.autonomy/` dir refuses
  rather than hashing as "empty".

## CP1 pass-2 rebuttals (recorded, not silently dropped)

- *"Pre-preflight fingerprint may not describe the session's inputs"* — the
  material is remote/board state + pack bytes. If anything drifts between
  compute and session, the recorded value simply fails to match the next
  tick's fresh compute → the session RUNS. Staleness can only cause an extra
  run, never a wrongful skip; the skip requires two identical computes
  bracketing a clean session.
- *"ProjectV2 field moves are invisible to issue updatedAt"* — SD-23: labels
  are the routing contract, Projects v2 is display-only; nothing the engine
  dispatches on lives in project fields, and label edits DO touch `updatedAt`.

## Out of scope

Cron/event-role fingerprinting (they have their own due/wake predicates);
per-account limit state (#3); any change to `EMPTY_IDLE`/board-empty path.
