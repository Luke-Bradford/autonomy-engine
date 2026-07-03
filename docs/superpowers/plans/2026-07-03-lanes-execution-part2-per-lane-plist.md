# Lanes execution Part 2 — per-lane launchd plist (#147)

> Slice of #147 Part 2. The supervisor already accepts `--lane` (PR #178) and the
> whole lane-aware Python core shipped in Part 1 (PR #162). This slice adds the
> provisioning half: `setup_worktree.sh` installs a per-lane worktree + launchd
> plist that threads `--lane <name>` into the supervisor, so one repo can run N
> lanes as N independent launchd services (SD-21: one supervisor per lane).
> Dashboard per-lane rows stay a separate follow-up slice.

## Goal

`setup_worktree.sh <repo> --lane <name>`:

- installs plist `com.autonomy.<slug>.<lane>.supervisor` whose ProgramArguments
  include `--lane <name>`, pointed at a per-lane worktree;
- **default lane keeps the legacy label** `com.autonomy.<slug>.supervisor` and
  emits **no** `--lane` arg (SD-21 back-compat: a default-lane install must be
  byte-identical to today's bare `setup_worktree.sh <repo>`);
- refuses an undeclared/malformed lane (fail-safe: never provision a service
  that would dispatch nothing).

No `--lane` flag ⇒ today's behaviour exactly (zero regression).

## Settled decisions in play

- **SD-21** — one supervisor per lane; **default lane keeps the legacy label**.
- **SD-25 / D6** — cron/event roles fire in the default lane only unless pinned;
  already enforced inside the enumerators, so nothing to do here.
- Repo-agnostic (invariant): no target-repo values baked in; slug/lane/worktree
  all derive from the target repo's own config or CLI.

## Changes

### 1. `bin/setup_worktree.sh` — `--lane` flag + per-lane label/worktree/plist arg

New pure, sourced-testable functions (mirroring `derive_slug` /
`resolve_worktree_path`):

- `lane_label_middle(slug, lane, default_lane)` — the `__LABEL__` **segment**
  only (the template already wraps it as `com.autonomy.__LABEL__.supervisor`):
  `<slug>` when `lane` is empty **or** equals `default_lane` (back-compat); else
  `<slug>.<lane>`. Pure (all args), unit-testable. The full label is built in
  main as `com.autonomy.$(lane_label_middle ...).supervisor`.
- `lane_worktree_default(slug, lane, default_lane)` — the derived worktree
  basename: `.<slug>-autonomy` for the default/empty lane (unchanged), else
  `.<slug>-<lane>-autonomy`. Feeds `resolve_worktree_path`'s derived-default
  branch so a per-lane install never collides with the default worktree.

**No fail-open default-lane read.** `roles.py lanes "$TARGET_REPO"` already
prints `lane_names(config)` one per line and returns non-zero on a malformed
`lanes:` block. When `--lane` is set we capture that output ONCE: a non-zero rc
is a refusal (fail-safe, never guess), the FIRST line is the default lane, and
`grep -qxF --` over the lines is the membership gate. One validated source for
both default-lane detection and membership — no separate `default-lane` call,
no `|| main` fallback that could mislabel a broken declared default.

Main body:

- Parse an optional `--lane <name>` (bash 3.2 `while`/`case`, `${2:-}` guards).
  A positional worktree path stays supported; `--lane` may appear before or
  after it.
- **Validate** the lane when set: charset/length pre-check
  (`*[!A-Za-z0-9._-]*`, `${#lane} -le 64`, defense-in-depth per prevention-log
  #6) **then** the `roles.py lanes` capture above (non-zero rc → refuse;
  membership via `grep -qxF -- "$lane"`). Any failure → `exit 1` with a clear
  message. Skipped entirely when no lane is set (rc 0, today's path — default
  lane resolved as empty, legacy label, no `--lane` arg).
- Compute `LABEL_MIDDLE=$(lane_label_middle ...)`,
  `LABEL="com.autonomy.${LABEL_MIDDLE}.supervisor"`, and thread the lane into the
  worktree derivation via `lane_worktree_default`.
- **`lanes.<lane>.worktree` config override is DEFERRED** (follow-up slice): this
  slice always uses the derived default `.<slug>-<lane>-autonomy`. Reason
  (Codex checkpoint-1): `config_parser.get()` splits the dotted key on every
  dot, so a dotted lane name (`ios.v2`, allowed by `_ROLE_NAME_RE`) would
  mis-address `lanes.ios.v2.worktree`; and `_validate_lanes` currently permits
  `..`/separators in the relative worktree (traversal). The derived default is
  deterministic, dot-safe, and collision-free — the safe subset ships now.
- Emit the plist via a line-by-line shell renderer, NOT multi-line sed (Codex
  checkpoint-1: newline-in-replacement is not portable on BSD sed). See §2.

### 2. `templates/supervisor.plist.tmpl` — unchanged; line-by-line renderer

The template stays **exactly as today** (no lane placeholder) so the default
lane is byte-identical by construction. A new `render_plist(tmpl, engine, repo,
label_middle, lane)` function in setup_worktree reads the template line by line
(`while IFS= read -r line`), substitutes `__ENGINE_HOME__`/`__REPO__`/`__LABEL__`
per line via bash parameter expansion (no sed, so no BSD multi-line hazard), and
— only when `lane` is non-empty — emits two extra lines
(`    <string>--lane</string>` / `    <string><lane></string>`) immediately
after the line carrying the substituted repo (`--repo`'s value). Default lane
(`lane` empty) inserts nothing → identical bytes to today's sed render. Lane
names are `[A-Za-z0-9._-]` only (validated), safe for XML text.

Header comment in the template updated to note the renderer appends `--lane`.

### 3. `bin/control.sh` — NO code change (verify, note in PR)

control.sh keys purely on each plist's `WorkingDirectory` + `Label`
(`ctl_find_plist`, `ctl_loop_state` via `supervisor_lock_pid_file "$repo"`).
Every lane has a distinct worktree (WorkingDirectory) and a distinct plist/Label,
so list/start/stop/pause/resume are already per-lane correct — a second lane is
just another registered repo path, exactly like any other repo. No
`--lane`-aware process matching needed (control never pgreps by repo). **PR note
(operational):** setup_worktree provisions but does not register — the operator
registers each lane worktree with `control.sh register <lane-worktree>` just as
for the default worktree today; per-lane control follows from that. Asserted by
a test: two lane plists for one repo in a temp `LaunchAgents` dir →
`ctl_find_plist` resolves each worktree to its own plist/label.

## Tests (TDD — genuine, real scripts sourced)

`tests/test_setup_worktree_slug.sh` (extend — already sources the real script):

- `lane_label`: empty lane → legacy label segment; lane == default → legacy;
  non-default lane → `<slug>.<lane>`.
- `lane_worktree_default`: default/empty → `.<slug>-autonomy`; non-default →
  `.<slug>-<lane>-autonomy`.
- `default_lane_of`: config with a `lanes:` block → first declared; no block →
  `main` (fallback path).

New `tests/test_setup_worktree_plist.sh` (integration, hermetic — fake
`roles.py`? No: use the REAL `roles.py` against a temp repo with a `lanes:`
block; stub only `git`/`launchctl` are not invoked because we call the pure
functions + a dry plist render, not the guarded main body). Assert the rendered
plist for a non-default lane contains `--lane <name>` + the `<slug>.<lane>`
Label, and the default-lane render contains neither.

`tests/test_control.sh` (if present) or a new focused test: two lane plists in a
temp `LaunchAgents` dir, `ctl_find_plist` returns the matching plist per
worktree.

## Invariants / non-regression

- **Zero regression:** no `--lane` ⇒ identical label, worktree, and plist argv to
  today. Guarded by the existing slug/worktree tests staying green + a
  default-lane render test.
- **Fail-safe:** unknown/malformed lane → refuse at provision time (never install
  a dead service). `roles.py lanes` non-zero rc = refusal.
- **bash 3.2:** no arrays/mapfile/`declare -A`; `${var:-}` nounset guards;
  `grep -qxF --` for declared-lane membership.
- **Repo-agnostic:** slug/lane/worktree from the target repo + CLI only.

## Out of scope (follow-up slices)

- Dashboard per-lane session rows (dashboard_state per-lane logs).
- `quickstart.sh` per-lane guidance (it chains setup_worktree; a `--lane`
  passthrough is a small follow-up once this lands).
