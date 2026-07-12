# Orphan run-outcome sidecar sweep (#378 slice 3)

*Design — 2026-07-12. The last slice of #378 (onboard/doctor trigger awareness
+ pack trigger starters shipped as PR #394 → main `bca260e`). Codex CP1 applied
(7 findings folded — see "CP1 resolutions").*

## Problem

A `call_pipeline` node spawns a CHILD run. Parent↔child signalling is ONE
sidecar `var/autonomy-logs/.pipeline-run-<child-base>.outcome.json`
(`{run_id, outcome, outputs}`), written by the child's `_finish` (only when
`state.parent_run` is set) and consumed + unlinked by the parent's
`_sweep_call_units` (`lib/pipeline.py`).

The sidecar becomes permanent litter — nobody consumes it — in two cases:

1. **Parent gone.** The parent state file is hand-deleted mid-wait (external
   interference); the child finishes, writes its sidecar, and no parent sweep
   ever runs.
2. **Detached child (`wait:false`).** `_start_call_unit` records the call unit
   `success` immediately and never sets `unit["child"]`, but the child is still
   a real run with `parent_run` set, so its `_finish` writes a sidecar the
   parent never intended to read.

Both are BOUNDED litter today, but nothing reclaims them. This slice adds an
offline sweep whose ACTION is **config-driven and toggleable from the control
room** — nothing about report-vs-prune is hardcoded in the engine.

## Design principle: policy in config + `bin/`, mechanism in `lib/`

`lib/pipeline.py` gains a pure, policy-free mechanism: detect orphans, and
delete them when told (`--prune`). The DECISION — report, prune, or skip — is a
target-repo config knob read by the bash callers. This preserves the
repo-agnostic invariant (no behavior baked into `lib/`/`bin/`; everything
repo-specific comes from the target's `.autonomy/config.yaml`) and makes the
behavior toggleable from the site with zero engine edits per repo.

## Config knob: `pipelines.orphan_sidecar_action`

Value ∈ `{off, report, prune}`. Read via `config_parser.py`, which already
resolves the SD-34 var-live shadow (`effective_config_path`) at its CLI
boundary — so a site edit to `var/autonomy/config.yaml` takes effect for
doctor/gc with no new plumbing.

| Value | doctor.sh | worktree_gc.sh |
|-------|-----------|----------------|
| `prune` **(default)** | detect + NAME orphans (WARN) — read-only by nature | delete each orphan (named; fail-closed on unreadable state) |
| `report` | detect + NAME orphans (WARN) | detect + NAME orphans, delete NOTHING |
| `off` | one INFO "sweep disabled" | skip the section |

**Default `prune`** — cleanup is on out of the box (operator direction: gc's job
is to reclaim; the knob dials it *down* to `report`/`off`, it does not opt *in*).
This is safe-by-construction, not a fail-open gamble: detection is
false-negative-only (a sidecar is pruned only when NO live state claims it, and
the match errs toward over-claiming — see Detection), so a prune default can
never delete a sidecar a live parent still needs. **Resolution of an ambiguous
value (prevention-log #6, verified empirically):** `config_parser.py` exits
rc 1 with empty stdout for BOTH an unset key AND an unreadable config — the two
are indistinguishable at the CLI, and both collapse to the `prune` DEFAULT (safe:
the detection is config-independent, so a config problem never causes an
unsafe deletion — only genuine orphans are pruned). Only a PRESENT non-empty
junk value falls to `report` (garbage never *earns* the destructive action).

## Non-negotiables that shape this

- **SD-45** (shadow lifecycle): scan scope is the MANAGED REPO ONLY (a separate
  lane service resolves from its own checkout); `ENOENT` on the logdir =
  provably-empty; unprovable state refuses.
- **SD-6**: `doctor.sh` / `worktree_gc.sh` are best-effort periphery — warn to
  stderr and never hard-fail their caller on a sweep hiccup.
- **SD-5 analogue**: the safe (`report`) value is the default; a misconfig never
  silently upgrades to `prune`.
- **Invariant #1 / fail-safe never fail-open**: a sidecar a live parent might
  still consume must NEVER be pruned. Absence of proof of orphanhood ≠ orphan.
- **prevention-log #6** (config/derived strings re-gated before use — the enum
  check), **#7 / #11** (pipefail capture-first), **#17** (`set -e` total
  readers), **#12** (a projection over on-disk data must be total).
- Reserved sidecar suffixes live in ONE place — `_RESERVED_SIDECAR_SUFFIXES`
  (`lib/pipeline.py:224`, `frozenset({"outputs","verdict","outcome"})`). The
  sweep reuses it; no new suffix literals (CP1 #7).
- bash 3.2 floor; python 3 stdlib only; repo-agnostic `bin/` + `lib/`.

## Why the sweep is race-safe (offline placement is organizational, not a lock)

The mechanism is safe to run **even while a supervisor is dispatching**, because
it only ever deletes a sidecar that NO live state file claims, and an unclaimed
sidecar has no live parent that could consume it:

- A running child has NO sidecar yet (written only at `_finish`); by the time a
  sidecar exists the child is done. Pruning never races a live child.
- A `wait:true` parent still waiting keeps its call unit's `child` set → the
  sidecar is CLAIMED → never pruned. When the parent records the outcome it
  unlinks the sidecar itself; the sweep never needs to.
- A restart (`_sweep_call_units` "vanished child → restart") mints a NEW child
  name and a NEW sidecar; an old orphan sidecar can never be re-claimed by a
  future run. No TOCTOU between scan and unlink.

So the sweep lives in the offline diagnostic (`doctor`) and explicit prune
(`worktree_gc`) tools because it is a MAINTENANCE concern that belongs there —
NOT because a lock or an idle loop is required. (Supervisor in-loop self-heal is
still declined: it adds dispatch-path complexity for a job the periphery tools
already cover; CP1 #3 corrected the earlier, overstated "no dispatch in flight"
justification.)

## Detection — `lib/pipeline.py` (pure mechanism, lane-agnostic)

**Forward-claim**, never reverse-parse. Reconstructing parent identity from a
child name (`<parent>.c<slot>.<node>[--lane]`) is ambiguous — `_NAME_RE` allows
`.` and `-`. Instead, ask the live state files who they are waiting on, and
match **without parsing lane at all** (CP1 #1).

The parent stores the LANE-LESS child name in `unit["child"]`; the child's
sidecar filename appends the lane after `--` (exactly `_sweep_call_units:2552`:
`child_base = child + "--" + lane if lane else child`). So a sidecar's core `X`
is claimed iff some claimed lane-less child `C` satisfies `X == C` **or**
`X.startswith(C + "--")`. This needs no lane knowledge and is fail-SAFE by
direction: the only error it can make is treating a lane-mismatched sidecar as
claimed (a false NEGATIVE → under-prune → leftover litter), never pruning a
claimed one (a false positive → fail-open).

```
_reserved_state_suffix(name):        # name minus ".json", last dotted token
    return name[:-len(".json")].rsplit(".", 1)[-1] in _RESERVED_SIDECAR_SUFFIXES

orphan_child_sidecars(repo) -> {"orphans": [basename, ...], "unreadable": int}

  logdir = os.path.join(repo, "var/autonomy-logs")
  try: entries = os.listdir(logdir)
  except FileNotFoundError: return {"orphans": [], "unreadable": 0}   # provably empty
  # any other OSError propagates -> CLI rc 1 -> callers skip (no partial prune)

  claimed = set()      # LANE-LESS child names a live parent is awaiting
  unreadable = 0
  for name in entries:
     if not (name.startswith(".pipeline-run-") and name.endswith(".json")):
        continue
     if _reserved_state_suffix(name):        # a sidecar, not a state file
        continue
     try:
        with open(os.path.join(logdir, name), encoding="utf-8") as fh:
           state = json.load(fh)
        if not isinstance(state, dict): raise ValueError
        units = state.get("units")
        if not isinstance(units, dict): raise ValueError       # CP1 #2: all-or-nothing
        names = []
        for unit in units.values():
           if not isinstance(unit, dict): raise ValueError     # no partial claims
           child = unit.get("child")
           if child:
              if not isinstance(child, str): raise ValueError  # non-str -> unreadable (no TypeError at match)
              names.append(child)
     except (OSError, ValueError):
        unreadable += 1                        # fail-closed: this state's claims are unknown
        continue
     claimed.update(names)

  orphans = []
  for name in entries:
     if not (name.startswith(".pipeline-run-") and name.endswith(".outcome.json")):
        continue
     x = name[len(".pipeline-run-") : -len(".outcome.json")]   # child-base (may carry --lane)
     if not any(x == c or x.startswith(c + "--") for c in claimed):
        orphans.append(name)

  return {"orphans": sorted(orphans), "unreadable": unreadable}
```

### Totality contract

`orphan_child_sidecars` is TOTAL over on-disk junk (prevention-log #12): any
non-dict state, non-dict `units`, non-dict unit, or missing key makes THAT state
`unreadable` (fail-closed — no partial claims, so a corrupt live parent can
never have a claim silently dropped and its sidecar mis-pruned). Only a
non-`FileNotFoundError` `listdir` failure escapes, and the CLI turns it into
rc 1 so callers skip — no partial prune on an unreadable directory.

## CLI verb — `pipeline.py orphans <repo> [--prune]`

TAB-delimited rows on stdout (mirrors the `triggers.py report` convention so a
bash caller parses one rule):

| Row | Meaning |
|-----|---------|
| `ORPHAN\t<basename>` | detected, NOT removed |
| `PRUNED\t<basename>` | removed (only under `--prune` AND `unreadable == 0`) |
| `UNREADABLE\t<n>` | n unreadable state files present (n > 0 only) |

- Report mode (no `--prune`): one `ORPHAN` row per orphan; `UNREADABLE` row if
  any.
- Prune mode (`--prune`):
  - `unreadable == 0`: unlink each orphan; `PRUNED` on success, `ORPHAN` if the
    unlink itself failed (report what could not be removed).
  - `unreadable > 0`: **prune nothing** (fail-closed — a corrupt live parent may
    still own a sidecar); emit `ORPHAN` per orphan + the `UNREADABLE` row.
- rc: 0 normal, 2 on missing/extra args, 1 on a hard logdir listing error
  (non-ENOENT).
- Writes nothing but the sidecar unlinks; leaves state files untouched.
- The verb carries NO policy — `off`/`report`/`prune` is entirely the caller's
  decision (report = run without `--prune`; prune = run with it; off = don't
  call). `lib/` stays repo-agnostic.

## `bin/doctor.sh` — `doctor_orphan_sidecars_report <repo>` (report only)

Beside `doctor_triggers_report`, called from `doctor_full_report` immediately
after it. Reads the knob (shadow-aware, enum-gated), best-effort, INFO/WARN,
NEVER sets `hard_fail`:

```sh
# rc1/empty (unset OR unreadable) -> "" -> reports (doctor never prunes). `|| true`.
_action="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" pipelines.orphan_sidecar_action 2>/dev/null || true)"
# doctor is READ-ONLY: only `off` changes its behavior; every other value
# (prune default, report, unset, junk) reports identically. No prune here.
case "$_action" in
  off) echo "INFO orphan run-outcome sidecar sweep disabled (pipelines.orphan_sidecar_action=off)"; return 0 ;;
esac
_out="$(python3 "$DOCTOR_HOME/lib/pipeline.py" orphans "$repo" 2>/dev/null)" \
  || { echo "INFO could not sweep run-outcome sidecars -- skipping"; return 0; }
[ -z "$_out" ] && { echo "INFO no orphan run-outcome sidecars"; return 0; }
while IFS=$'\t' read -r _tag _val; do
  case "$_tag" in
    ORPHAN)     echo "WARN orphan run-outcome sidecar (no parent awaiting it): $_val" ;;
    UNREADABLE) echo "INFO $_val unreadable pipeline state file(s) -- orphan detection is partial" ;;
  esac
done <<EOF
$_out
EOF
return 0
```

doctor NEVER prunes (read-only diagnostic); `prune` only tells doctor to keep
reporting. Message is cause-neutral ("no parent awaiting it") — covers both the
hand-deleted-parent and detached-child causes.

## `bin/worktree_gc.sh` — config-driven prune section (named), BEFORE the fetch gate

Placed right after `git worktree prune -v` and **before** the `git fetch` /
branch-deletion block, because the current script `exit 0`s early when
fetch/origin resolution fails (CP1 #5) and the sidecar sweep is purely LOCAL —
it must not be gated on the network. The script runs `set -euo pipefail` and has
already `cd "$REPO"`; read the knob (total under `set -e`, prevention-log #17),
enum-gate it (prevention-log #6), and pass `"$PWD"` (absolute, post-cd) to
python:

```sh
# rc1/empty (unset OR unreadable, indistinguishable) -> the prune default; a
# PRESENT junk value -> report (never earns prune). `|| true` (total under set -e).
# $PWD (post-cd, absolute) so a relative --repo still resolves the config.
_action="$(python3 "$ENGINE_HOME/lib/config_parser.py" "$PWD/.autonomy/config.yaml" pipelines.orphan_sidecar_action 2>/dev/null || true)"
case "$_action" in off|report|prune) ;; "") _action=prune ;; *) _action=report ;; esac
if [ "$_action" = "off" ]; then
  echo "== orphaned pipeline run-outcome sidecars: sweep disabled (pipelines.orphan_sidecar_action=off) =="
else
  echo "== orphaned pipeline run-outcome sidecars (pipelines.orphan_sidecar_action=$_action) =="
  _flag=""; [ "$_action" = "prune" ] && _flag="--prune"
  if ! _sweep="$(python3 "$ENGINE_HOME/lib/pipeline.py" orphans "$PWD" $_flag 2>/dev/null)"; then
    echo "  SKIP: could not sweep run-outcome sidecars (logdir unreadable) -- nothing pruned"   # CP1 #6: never mask rc 1
  else
    _pruned=0
    while IFS=$'\t' read -r _tag _val; do
      case "$_tag" in
        PRUNED)     echo "  pruned orphan sidecar: $_val"; _pruned=$((_pruned + 1)) ;;
        ORPHAN)     echo "  orphan sidecar (report-only): $_val" ;;
        UNREADABLE) echo "  SKIP: $_val unreadable state file(s) -- not pruning (a corrupt live parent may still own a sidecar)" ;;
      esac
    done <<EOF
$_sweep
EOF
    [ "$_action" = "prune" ] && echo "  ($_pruned orphan sidecar(s) removed)"
  fi
fi
```

gc names every sidecar it deletes, satisfying "never auto-deletes silently"; it
is the explicit prune tool and already names every branch it removes.

## Site toggle — `CONFIG_PAGE_KEYS` + one `config_page.html` select

- `lib/dashboard_control.py`:
  `CONFIG_PAGE_KEYS["pipelines.orphan_sidecar_action"] = lambda v: v in ("off","report","prune")`.
  The generic `config_set` executor already lands whitelisted keys in the
  var-live shadow (`live_set`), so no new control action.
- `lib/config_page.html`: one `<select data-key="pipelines.orphan_sidecar_action">`
  (options off / report / prune) beside the operational knobs, wired to the
  existing save path (like `agent.effort`). Current value seeded from the config
  payload; unset shows the `prune` default.

Dashboard edit → browser-verify loop (dashboard skill: kill the 8787 dashboard
pid so the watchdog relaunches with new code; temporal + interaction pass).

## Testing (TDD — real functions sourced, no assertions-on-mocks)

**Python (`lib/pipeline.py` tests):**
- orphan detected: a `.outcome.json` with no claiming state → `ORPHAN`.
- claimed NOT flagged: a live state with a call unit `{child: C}` → the sidecar
  for `C` (both lane `C--L.outcome.json` and no-lane `C.outcome.json` variants)
  absent from output — proves the lane-agnostic match (CP1 #1).
- detached-child sidecar (no claiming unit) → flagged (documents case 2).
- unreadable state (bad JSON; non-dict `units`; a non-dict unit) → `UNREADABLE`
  bumped, no partial claims; `--prune` emits `ORPHAN` (held back), sidecar still
  on disk after (CP1 #2).
- `--prune` with clean states removes the orphan (`PRUNED`), leaves a claimed
  sidecar on disk.
- missing logdir → empty output, rc 0.
- reserved-suffix files: a `.outputs.json` / `.verdict.json` is neither counted
  as a state nor reported as an orphan sidecar (via `_RESERVED_SIDECAR_SUFFIXES`).
- `unit["child"]` on a NON-dispatched unit still claims (conservative).

**`lib/dashboard_control.py` tests:** the new `CONFIG_PAGE_KEYS` validator
accepts off/report/prune and rejects junk; `config_set_plan` returns a
`live_set` for the key (rides the existing var-live path).

**`tests/test_doctor.sh`:** planted orphan → WARN line under `action=report`;
`action=off` → the disabled INFO, no sweep; junk value → treated as report
(pipefail capture-first, prevention-log #11).

**`tests/test_worktree_gc.sh`:** `action=prune` names + removes an orphan and an
unreadable state holds the prune back with the SKIP line; `action=report` names
but removes nothing; `action=off` skips the section; the sweep runs even when
`git fetch` would fail (placed before the fetch gate, CP1 #5). Mock `gh`/`git`
only where a network/VCS call is unavoidable, per the genuine-tests rule.

**Browser (dashboard skill):** the new select renders, current value reflects
the knob, changing it saves to the var-live shadow and shows the local-override
badge; temporal pass (no per-tick churn).

## CP1 resolutions (Codex, 2026-07-12)

1. Lane fail-open → dropped lane parsing; lane-agnostic `== / startswith(C+"--")`
   match (false-negative-only).
2. `units` totality → all-or-nothing per state; any non-dict → `unreadable`.
3. Overstated "offline" safety → mechanism is race-safe by construction;
   justification corrected, no lock added.
4. GC `off`→`report` collapse → explicit 3-way `case` with early `off` skip.
5. GC early `exit 0` skips local sweep → sweep relocated before the fetch gate.
6. `|| true` masks rc 1 → `if ! _sweep=…` with a named SKIP.
7. Duplicated suffix literals → reuse `_RESERVED_SIDECAR_SUFFIXES`.

Plan CP1 (second pass, against the implementation plan), all folded:

8. `config_parser.py` exits rc1/empty for an unset key AND an unreadable config
   (verified) → `|| echo report` mis-resolved unset to `report`; fixed to
   `|| true` + `case ""→prune`; unreadable collapses to the safe prune default.
9. GC read `"$REPO/.autonomy/config.yaml"` AFTER `cd "$REPO"` → relative-`--repo`
   break; use `"$PWD/..."`.
10. Non-string `unit["child"]` → `TypeError` at `c + "--"` (escapes totality) →
    `raise ValueError` (counts unreadable).
11. GC test `git commit` fails with no configured identity → `git init` only
    (`git worktree prune` needs no commit).

## Out of scope (deliberate)

- **Done-marker child state files** (`.pipeline-run-<child>.json` left when
  `_finish` could not unlink): a DIFFERENT failure with its own loud refusal
  (`_guard_in_progress`); not `.outcome.json` litter.
- **Supervisor in-loop self-heal**: declined (see "Why race-safe").
- **`.outputs` / `.verdict` per-node sidecars**: bounded per-run, cleaned on the
  normal walk; no orphan class reported today.
- **Per-tool separate knobs** (a distinct doctor vs gc policy): one tri-state is
  intuitive and sufficient; a second knob is YAGNI until asked for.
```
