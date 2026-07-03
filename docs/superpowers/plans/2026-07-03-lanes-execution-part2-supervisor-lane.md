# Lanes execution Part 2 — supervisor `--lane` flag (#147)

> Slice of #147 Part 2. Part 1 (PR #162) shipped the entire lane-aware Python
> core: `dispatch_roles(config, lane)`, `cron_roles`, `event_roles`, `_in_lane`,
> `default_lane`, `lane_names`, and the `dispatch/cron/events --lane <name>` CLI
> plus `default-lane`/`lane-report`. `instances:` removal shipped (PR #173).
> This slice adds the ONE missing execution entry point: the supervisor accepting
> and threading `--lane`. Per-lane launchd plists (setup_worktree/control) and
> dashboard lane rows are separate follow-up slices.

## Goal

`supervisor.sh --repo <lane-worktree> --lane <name>` dispatches only the roles
that belong to `<name>` (SD-21: one supervisor per lane). No `--lane` = the
default lane = today's behaviour, byte-identical (zero regression).

## Settled decisions in play

- **SD-21** — one supervisor per lane; default lane keeps the legacy label. This
  slice is the `--lane` half; the plist/label half is a follow-up.
- **SD-25 / D6** — cron/event roles fire in the default lane only unless pinned.
  Already enforced inside `cron_roles`/`event_roles` (lane-less → default lane),
  so threading `--lane` through the cron/events enumerators gets D6 for free.

## Changes

### 1. `lib/roles.py` — `lanes` CLI subcommand (validating source)

Add `_lanes_main(argv)`: `roles.py lanes <target-repo>` runs `_validate_lanes(config)`
FIRST — a malformed `lanes:` block (Codex checkpoint-1 finding) prints the errors
to stderr and returns rc 1, so the supervisor refuses rather than validating a
`--lane` against a broken/fallback roster. On a clean lanes block (or none — the
implicit `main` lane), print `lane_names(config)` one per line, rc 0. Because
`lane_names` only lists names matching `_ROLE_NAME_RE` (`[A-Za-z0-9._-]{1,64}`),
membership in this output is the AUTHORITATIVE `--lane` gate (charset + length +
declared-ness all enforced at once). Wire into `main()`; companion to
`default-lane`.

### 2. `bin/supervisor.sh` — accept + thread `--lane`

- `AUTONOMY_LANE=""` default in the arg-parse init block; `--lane) AUTONOMY_LANE="$2"; shift 2 ;;`
  arm; update both usage strings (header comment + the `usage:` echo).
- **Validate** via a module-level `validate_lane` FUNCTION (Codex checkpoint-1
  finding — inline-in-the-loop can't be unit-tested without launching the
  infinite loop; factor it out so sourced tests call it directly). `validate_lane`:
  rc 0 (silent) when no lane is set; else (a) charset+length pre-check
  (`case *[!A-Za-z0-9._-]*` + `${#lane} -le 64`, defense-in-depth per
  prevention-log #6 before the value reaches argv/grep), (b) `roles.py lanes` —
  a NON-ZERO rc is itself a refusal (fail-safe: a malformed lanes block or read
  error must never pass), (c) membership via `grep -qxF -- "$lane"` (`--` because
  a lane name may legally start with `-`). Any failure → refuse. The main block
  calls `validate_lane || exit 1` — **never silently dispatch nothing** (#147
  item 6: refuse, do not silently clamp).
- Thread the lane into the THREE enumeration seams only, via one shared helper
  `_roles_enumerate <subcommand> <repo>` that appends `--lane "$AUTONOMY_LANE"`
  when set (uses `${AUTONOMY_LANE:-}` so sourcing for tests stays nounset-safe):
  `resolve_dispatch_roles` (dispatch), `_cron_enumerate` (cron), `_event_enumerate`
  (events). The per-role settings call `roles.py dispatch <repo> <role>` (line
  555) is lane-independent and MUST NOT get `--lane` (role+lane together is a CLI
  usage error by design).

### 3. Tests (TDD — genuine, real scripts sourced)

- `tests/test_roles.py`: `roles.py lanes` prints declared lanes in order (with a
  `lanes:` block) and prints `main` with no block.
- `tests/test_headless_dispatch.sh`: a config with two lanes + lane-pinned roles;
  assert `AUTONOMY_LANE=frontend resolve_dispatch_roles` returns only the
  frontend-lane role, `AUTONOMY_LANE=` (default) returns the default-lane roles,
  and an undeclared `--lane` is refused (the validation branch). Real `roles.py`,
  real parser — no mocks.

## Invariants / non-regression

- No `lanes:` block → `_roles_enumerate` takes the bare (no-`--lane`) branch →
  identical argv to today. Verified by the existing dispatch tests staying green.
- Fail-safe: unknown/malformed lane → refuse at startup, never run the wrong
  roster.
- bash 3.2: no arrays/mapfile; `${AUTONOMY_LANE:-}` guard for nounset; `grep -qxF`
  for the declared-lane membership test.

## Out of scope (follow-up slices, noted in PR)

- Per-lane launchd plist + label (`com.autonomy.<slug>.<lane>.supervisor`,
  default lane keeps the legacy label) — setup_worktree.sh / control.sh.
  NOTE: control.sh's per-repo process/dup detection matches `--repo <repo>`; once
  two lanes run for one repo it must also key on `--lane` — lands with that slice.
- Dashboard per-lane session rows.
- Extend `lane_overlaps` to cron/event roles (deferred PR-#162 NITPICK).
