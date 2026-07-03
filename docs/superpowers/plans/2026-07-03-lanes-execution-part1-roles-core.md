# Lanes execution — Part 1: roles.py lane routing core + doctor reporting

Increment of #147 (lanes execution). Design SETTLED:
`docs/superpowers/specs/2026-07-03-lanes-and-board-contract-design.md` (D1–D6,
operator-approved). Settled-decisions 21–25.

## Why sliced

The full #147 increment (schema + role `lane:` + dispatch filter + per-lane
supervisor/plist + doctor overlap + dashboard lane rows + `instances:` removal)
is too large for one unattended PR. Part 1 lands the **pure-Python routing
core** plus **doctor reporting**. Crucially it is *genuinely wired* — see the
unified filter below — so it does NOT ship a dishonest set-but-unwired knob.

## The key design choice (fixes Codex checkpoint-1 High findings)

**Unified lane filter with `lane=None` -> the default lane** (NOT "all roles").
A role "belongs to lane L" iff `lane_of_role(config, name) == L`, where
`lane_of_role` = the role's `lane:` or `default_lane(config)`.

- `default_lane(config)` = first declared `lanes:` key, else `"main"`.
- Enumeration (`dispatch_roles`, `cron_roles`, `event_roles`) gains an optional
  `lane` param; `lane=None` resolves to `default_lane(config)`.

Consequences (all desirable):

1. **Zero regression.** With no `lanes:` block and no role `lane:`,
   `default_lane` = `"main"` and every lane-less role maps to `"main"`, so
   filtering to the default lane returns exactly today's set. Byte-identical.
2. **Honest + wired with NO supervisor.sh change.** The running supervisor
   already calls `roles.py dispatch <repo>` / `cron` / `events` with no lane ->
   `lane=None` -> default lane. The moment an operator sets `lane: frontend` on
   a role, that role is EXCLUDED from the default supervisor's enumeration —
   the routing/partition IS live in Part 1. What Part 1 does NOT add is a way to
   *run* a non-default lane: the supervisor has no `--lane` flag yet and no
   per-lane launchd plist (both Part 2). So a role pinned to a non-default lane
   is correctly routed OUT of the default lane but is **not executable until
   Part 2**. This is honest, not a silent drop: `doctor.sh` prints a loud WARN
   for every non-default lane ("declared with N role(s) — per-lane execution
   lands in Part 2 (#147); these roles do NOT run yet"), and the repo's own
   config declares no lanes so the self-loop is unaffected. Part 1 advertises
   no `--lane` flag it does not implement (Codex checkpoint-1 finding).
3. **D6 falls out for free.** A lane-less cron/event role maps to the default
   lane, so only the default supervisor fires it; a role pinned to a non-default
   lane fires only under that lane's supervisor. Exactly-once, no cross-lane
   coordination.
4. **Fail-safe, never fail-open.** An undeclared-lane ref makes `lane_of_role`
   return a lane string that matches NO real supervisor's target, so the role
   is simply never enumerated (refused-by-omission) — it does NOT fall back into
   the default lane, and it does NOT make `dispatch` exit nonzero (which would
   trigger supervisor's coder-only fallback and fail-open). `validate_roles` /
   doctor surface the misconfig for the human separately.

`role_settings` and `dispatchable_roles` stay **lane-UNAWARE**: they answer "is
this a real enabled role, in any lane?" (the settings-resolution guard the
supervisor uses after picking a role). Settings do not depend on lane, so no
lane param there — avoids a KeyError when a `--lane` supervisor resolves
settings for its own non-default role.

## Scope of Part 1

Production code: `lib/roles.py`, `bin/doctor.sh`. Tests: `tests/test_roles.py`,
`tests/test_doctor.sh`. No supervisor, plist, or dashboard changes; `instances:`
stub stands (removed in Part 2).

### roles.py

1. **`lanes:` block validation** (top-level, sibling of `roles:`). Optional.
   Validated in a `_validate_lanes(config)` helper called from `validate_roles`
   **before** the `if not roles: return` early return (so an invalid `lanes:`
   is caught even with no `roles:` block — Codex Medium). Rules (fail-closed):
   - must be a non-empty mapping of lane-name -> mapping;
   - lane names use `_ROLE_NAME_RE` (`[A-Za-z0-9._-]{1,64}`);
   - each lane value is a mapping; only key recognised is `worktree`; unknown
     keys -> error;
   - `worktree`, when present, must be a non-empty string, NOT absolute
     (`/...`), no newline/control chars (shell-hostile input rejected now so
     Part 2's launchd/worktree inputs are safe);
   - duplicate `worktree` paths across two lanes -> error.

2. **Role `lane:` validation.** If set, must be a non-empty charset-valid string
   naming a *declared* lane. Valid lane set = declared `lanes:` keys, or
   `{"main"}` when no block. Undeclared -> validation error (fail-safe REFUSE).

3. **Pure helpers** (config in, no filesystem): `default_lane`, `lane_names`,
   `lane_of_role`, `lane_overlaps`. `lane_overlaps`: for each pair of *loop*
   roles in DIFFERENT lanes whose `scope.labels` intersect, one deterministic
   "lanes X and Y have overlapping label scopes (label L) — may double-work"
   line. Labels coerced to str, empties/non-str dropped, deduped. Roles with no
   `scope.labels` never overlap (no partition claim — the operator's stated
   risk). Deterministic ordering (sorted lane pair, sorted labels).

4. **`dispatch_roles(config, lane=None)`**, **`cron_roles(config, lane=None)`**,
   **`event_roles(config, lane=None)`** — unified filter above. `lane=None` ->
   `default_lane`. Enumeration DEGRADES on lane misconfig (excludes), never
   raises / never nonzero.

5. **CLI** (explicit disambiguation — Codex Medium):
   - `roles.py dispatch <repo>` -> default-lane loop list;
   - `roles.py dispatch <repo> --lane <name>` -> that lane's loop list;
   - `roles.py dispatch <repo> <role>` -> settings (unchanged);
   - `<role>` + `--lane` together -> usage error (exit 2);
   - `cron` / `events` accept the same optional `--lane`;
   - new `roles.py default-lane <repo>` -> prints default lane name.

### doctor.sh

6. **Lane report** in `doctor_full_report` (diagnostic-only, exit 0, no network):
   when a `lanes:` block exists (or any role sets `lane:`), print
   `OK   lanes: <n> declared (default: <name>)` and, for each NON-default lane
   that has one or more roles, a `WARN` that per-lane execution lands in Part 2
   (#147) and those roles do NOT run yet (never advertise a `--lane` flag that
   Part 1 does not implement). Overlaps -> `WARN <message>`. Sourced from a
   small roles.py CLI (e.g. `roles.py lane-report <repo>`). Absent lanes AND no
   role `lane:` -> no line (zero noise).

## TDD order

1. `_validate_lanes`: valid block, bad charset name, unknown lane key, non-mapping
   lane, absolute/newline worktree, duplicate worktree, invalid `lanes:` with no
   `roles:` block — fail first.
2. role `lane:` validation: valid ref, undeclared ref, bad charset, lane-less ok.
3. helpers: default_lane/lane_names/lane_of_role (with/without block);
   lane_overlaps (disjoint=none, intersect=one warn, no-labels=none, dedupe).
4. dispatch/cron/event lane filter: `lane=None` == today (no-lanes config);
   pinned role excluded from default; included under its lane; undeclared-lane
   role excluded everywhere (never fail-open); D6 cron/event default-only.
5. CLI: default-lane, dispatch/cron/events --lane, `<role>`+`--lane` usage error.
6. doctor: lanes report line + non-default INFO + overlap WARN, exit 0.

## Invariants respected

- Fail-safe never fail-open: undeclared-lane ref refused-by-omission (never
  default fallback, never nonzero dispatch -> no coder fail-open).
- bash 3.2 (doctor.sh). Python stdlib only. Repo-agnostic. `lane=None` on a
  no-lanes config == today (zero dispatch regression).

## Out of scope (Part 2+)

Supervisor `--lane` CLI flag + per-lane launchd plist (setup_worktree/control);
dashboard lane rows; `instances:` schema removal (D1). (D6 cron/event gating is
already correct in Part 1 via the unified default-lane filter.)
