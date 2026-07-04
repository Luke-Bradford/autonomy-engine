# Plan — #171 slice: doctor warns when a role's scope.label doesn't exist on the repo

## Goal
A typo'd `roles.*.scope.labels` entry today is a silent footgun: the role
subscribes to a label that doesn't exist, so its board query returns nothing and
the role never works — with zero signal. `doctor.sh` should WARN when a
configured scope label is absent from the repo's actual labels (`gh label list`).
Diagnostic-only, best-effort (settled-decision 6): a `gh` hiccup degrades to a
hint, never a false WARN, never blocks.

This is one slice of #171 (GitHub-derived config). The other parts —
`board.owner` default-from-remote, onboarding auto-creating the standard label
set (settled-decision 24), `merge_gate` marker/author verification — stay for
follow-up slices; noted on the issue.

## Design
`lib/roles.py` (the single roles authority; reuse its enumeration + `_scope_labels`):
- `_enabled_label_scopes(config)` — NEW shared helper: `(lane, frozenset(labels))`
  for every ENABLED executable role (loop/cron/event, any lane) that sets a
  non-empty `scope.labels`. `lane_overlaps` is refactored to consume it (removing
  the duplicated enumeration) — so this and `configured_scope_labels` share ONE
  source, not a fork.
- `configured_scope_labels(config)` — sorted de-duplicated union of every label
  from `_enabled_label_scopes` (empty list when none).
- CLI `roles.py scope-labels <repo>` — print each configured label on its own
  line (sorted). No labels / no roles block → nothing, rc 0. Unreadable config →
  the shared `_load_config` rc (2), like the other subcommands.

`bin/doctor.sh` (mirror the #172 pattern: a PURE reporter + an impure gh wrapper):
- `doctor_labels_report <configured_nl> <repo_labels_nl>` — pure. For each
  configured label, scan the repo-labels newline-list with **exact bash string
  equality** (`[ "$line" = "$label" ]`, a `while read` loop — NO `grep`, so a
  label starting with `-` or holding regex metacharacters can neither break the
  test nor false-match; whole-line by construction, so "good first issue"
  compares right). Not present → one WARN naming the label + the fix. No
  configured labels → nothing. All present → nothing (silence = healthy; the
  roles-valid OK line already covers the positive case).
- `doctor_label_scope_check <repo>` — impure best-effort. Gated by the caller to
  `roles_rc==0` (never runs on an invalid/unreadable roles block). `if !
  configured="$(python3 roles.py scope-labels "$repo")"` OR empty → return 0
  (a `scope-labels` extraction failure or no labels means nothing to verify —
  never fabricate WARNs). Else fetch `repo_labels="$(cd "$repo" && gh label list
  --limit 500 2>/dev/null | cut -f1)"`: gh failed → INFO hint, NOT a WARN; **500
  lines returned (saturated) → INFO "too many labels to verify" and SKIP the
  missing-WARNs** (a truncated list would false-WARN a present label — treat as
  unverifiable). Else delegate to `doctor_labels_report`.
- Wire into `doctor_full_report` INSIDE the roles-check `0)` (valid) branch, so a
  roles FAIL/invalid config never yields misleading label WARNs.

## Invariants respected
- **Doctor diagnostic-only:** OK/WARN/INFO only, never FAIL/`hard_fail`, never
  provisions (does NOT create labels — that's the onboarding slice, SD 24).
- **Best-effort / fail-safe (SD 6):** a `gh` failure → INFO hint, never a false
  "label missing" WARN; a genuinely-absent label → WARN (actionable).
- **Whole-line label match** — labels legitimately contain spaces; a substring
  compare would both false-miss and false-hit.
- **Single source:** configured labels come from `roles.py` (reusing
  `_scope_labels` + the `lane_overlaps` enumeration), never re-parsed in bash.
- **Target-repo correctness:** `gh label list` runs in `$repo`.
- **bash 3.2 / Python-3 stdlib / repo-agnostic** (no owner/board/label VALUES
  hardcoded; the STANDARD label set is not referenced here). Source-guards intact.

## Tests
`tests/test_roles.py`:
- `configured_scope_labels`: labels across two roles + a cron role → sorted union
  deduped; a role with no scope → contributes nothing; empty roles block → [].
- `lane_overlaps` still passes (proves the refactor to `_enabled_label_scopes`
  preserved behavior).
- CLI `scope-labels`: prints sorted lines; none → empty; unreadable → rc 2.

`tests/test_doctor.sh` (pure + gh stub, per #172):
- `doctor_labels_report`: configured label missing from repo set → WARN naming
  it; all present → no output; a label starting with `-` and one with spaces both
  match by exact equality (no grep breakage); no configured → no output.
- `doctor_label_scope_check` via a `gh` PATH stub: label present → silent; label
  absent → WARN; `gh label list` fails → INFO (not WARN). The stub RECORDS
  `$PWD` and the test asserts it equals `$repo` (proves `cd "$repo"` targeting).
- when `scope-labels` prints nothing, the stub FAILS if `gh` is called at all —
  proving no needless `gh` round-trip.
