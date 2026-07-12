# Plan — pack trigger starters + onboard/doctor awareness (#378 slices 1+2)

Split off Phase C (`docs/superpowers/plans/2026-07-10-pipeline-model-phaseC-call-events-secrets.md`,
decision 16). This plan covers **slices 1 + 2** of #378. Slice 3 (orphan
child-sidecar sweep) is a different subsystem (litter cleanup, not pack
scaffolding) and stays on #378 as a follow-up.

## Goal

The pack template ships **starter trigger files** (`.autonomy/triggers/*.json`),
one per firing mode, so an operator onboarding a repo gets concrete, editable
examples of the first-class trigger object (Phase B/SD-39 made triggers the
dispatch unit, but the scaffold ships none). `doctor` gains **INFO-only trigger
awareness** (validity, native-vs-shim supersession, mode + bound pipeline,
enabled/disabled) — it reports, never provisions.

## Settled decisions in play

- **SD-3 repo-agnostic**: starters live in `templates/` and bind the shipped
  `ticket-to-merge` starter pipeline — no target-repo specifics. The doctor
  verb + fn read from the `repo` arg; nothing repo-specific lands in `bin/`/`lib/`.
- **SD-6 best-effort periphery**: `doctor` is diagnostic-only, never FAIL.
  `doctor_triggers_report` emits INFO/WARN and returns 0 on every path,
  including config-unreadable (doctor can't report ≠ dispatch fails open —
  dispatch itself refuses; SD-39).
- **SD-39 triggers are the dispatch unit**: a native file supersedes a same-name
  role shim; a present-but-invalid trigger REFUSES (never falls back). The
  report SURFACES supersession + refusal warnings verbatim.
- **SD-42/43/47 trigger schema + firing modes**: every starter must validate
  against the REAL `triggers.validate_trigger` (name==stem, mode vocab,
  concurrency rules, event map). Pinned by test.
- Prevention-log **#22**: starters carry NO brief prose through `substitute()`
  (trigger JSON has no brief_ref); param VALUES avoid literal `${…}` to prevent
  confusion.
- Prevention-log **#6**: trigger names become filenames — already gated by
  `validate_trigger` (name==stem, charset) and `_NAME_RE`.

## Design decisions

1. **All four starters ship `enabled: false`** — inert, illustrative examples the
   operator opts into and edits, mirroring the fully-commented `roles:` block in
   the shipped `config.yaml`. Onboarding must NOT auto-arm a loop. (An enabled
   continuous starter bound to `ticket-to-merge` would start dispatching on a
   fresh onboard — surprising and unsafe.)

2. **Names are `-example`-suffixed, no `.`** →
   - dodge collision with any future role shim (native supersedes shim → a
     bare `coder` starter would silently override a user's `coder` role);
   - dodge the reserved-sidecar-suffix gate (only fires when the name contains
     a `.`).

3. **Bind `ticket-to-merge`** (the only shipped starter pipeline). It declares
   **no params**, so:
   - continuous / schedule / manual starters bind cleanly and would run if enabled;
   - the **event** starter demonstrates a payload `map` targeting params the
     pipeline does not declare — schema-valid (validate_trigger checks map field
     vocab + charset, NOT param existence: "existence is checked at run start"),
     but not runnable-as-shipped against `ticket-to-merge`. It is disabled and
     the README states the bound pipeline must declare the mapped params. This
     is the honest way to demonstrate the requested "event with a payload map".

4. **`templates/autonomy-pack/triggers/README.md`** carries the guidance JSON
   can't (no comments): what each starter is, that they are inert, how to enable,
   native-vs-shim supersession, the event-map/param caveat, `doctor` + `triggers.py
   show <repo> <name>` to inspect. The `*.json` glob in `_trigger_stems`/
   `enumerate_triggers` ignores `README.md`.

5. **onboard needs NO code change for scaffolding** — the existing recursive
   per-file idempotent scaffold (`find "$TEMPLATE_DIR" -type f -print0`, onboard.sh:32-44)
   already copies everything under `templates/autonomy-pack/`, including the new
   `triggers/` dir. Pinned by an extended `tests/test_onboard.sh` assertion.

## The four starters (all `enabled: false`, `pipeline: ticket-to-merge`)

| file | firing | notes |
|---|---|---|
| `continuous-example.json` | `{mode: continuous}` | today's loop shape; `concurrency {skip,1}` default |
| `nightly-example.json` | `{mode: schedule, schedule: "0 3 * * *"}` | one extra run nightly (UTC — cron parser's clock) |
| `on-pr-sync-example.json` | `{mode: event, event: "pr.synchronize", map: {ticket: item, head_sha: sha}}` | `sha` valid only on `pr.synchronize`; concurrency omitted (queue is refused for event) |
| `manual-example.json` | `{mode: manual}` | run-now on demand from the dashboard |

Each validates against `validate_trigger(<obj>, <stem>)` → `[]`. Verified
mentally against the schema; pinned by test.

## New surface

### `lib/triggers.py` — `report` CLI verb (doctor-facing, ~12 lines)

Mirrors the `fireable`/`trust` tab-row output style. Uses
`enumerate_triggers(repo, lane, dispatchable_only=False)` so **disabled starters
are visible** (the `validate` verb uses `dispatchable_only=True` and would hide
them). One row per trigger + warn lines; the caller prefixes INFO/WARN.

```python
if cmd == "report":
    # doctor-facing INFO surface: dispatchable_only=False so DISABLED
    # starters are visible; never provisions. Tab rows + warn lines; the
    # caller (doctor.sh) prefixes INFO/WARN. rc 0 always on a readable
    # config -- refusals are WARN rows, not a failing report (doctor is
    # diagnostic-only, SD-6).
    try:
        trigs, warns = enumerate_triggers(pos[0], lane, dispatchable_only=False)
    except PipelineError as exc:
        print("triggers report: %s" % exc, file=sys.stderr)
        return 1
    for w in warns:
        print("WARN\t%s" % w)
    for t in sorted(trigs, key=lambda x: x["name"]):
        print("TRIGGER\t%s\t%s\t%s\t%s\t%s" % (
            t["name"], t["firing"]["mode"], t.get("kind", ""),
            "enabled" if t.get("enabled", True) else "disabled",
            t.get("pipeline") or t["name"]))
    return 0
```

### `bin/doctor.sh` — `doctor_triggers_report` (INFO-only, best-effort)

Wired into `doctor_full_report` right after `doctor_pack_skills_check "$repo"`.
Shells `python3 "$DOCTOR_HOME/lib/triggers.py" report "$repo"`; a non-zero exit
(config unreadable) → one INFO line + `return 0` (never FAIL, SD-6). bash-3.2:
no mapfile — `while IFS=$'\t' read -r`, capture-first to dodge the pipefail
`producer | while` SIGPIPE class (prevention-log #7/#11).

```bash
doctor_triggers_report() {
  local repo="$1" _out _tag _name _mode _kind _en _pipe
  _out="$(python3 "$DOCTOR_HOME/lib/triggers.py" report "$repo" 2>/dev/null)" || {
    echo "INFO could not enumerate triggers (config unreadable?) -- skipping trigger report"
    return 0
  }
  if [ -z "$_out" ]; then
    echo "INFO no triggers found (.autonomy/triggers/) and no roles: shims"
    return 0
  fi
  while IFS=$'\t' read -r _tag _name _mode _kind _en _pipe; do
    case "$_tag" in
      TRIGGER) echo "INFO trigger '$_name' ($_mode, $_kind, $_en) -> pipeline '$_pipe'" ;;
      WARN)    echo "WARN trigger issue: $_name" ;;   # _name = the whole warn string (field 2)
    esac
  done <<EOF
$_out
EOF
  return 0
}
```

(Here-doc feed avoids the `printf … | while` SIGPIPE/subshell trap. `WARN`
rows have the message in field 2 onward — the reason strings from
`enumerate_triggers` contain no tabs.)

## TDD order

1. **Failing test first** — extend `tests/test_triggers.py` with a class that
   loads every `templates/autonomy-pack/triggers/*.json`, asserts
   `validate_trigger(obj, stem) == []`, asserts `enabled is False`, asserts the
   bound `pipeline` dir exists in the pack. Plus a `report`-verb test (native +
   disabled trigger appears with `disabled`; a refused file yields a WARN row).
   Run → RED (no starter files / no verb yet).
2. Create the four starters + `triggers/README.md`.
3. Add the `report` verb.
4. Add `doctor_triggers_report` + wire it; extend `tests/test_doctor.sh`
   (source doctor.sh, call the fn against a fixture repo with a starter trigger,
   assert an `INFO trigger '…'` line; a disabled trigger is reported).
5. Extend `tests/test_onboard.sh` — assert the recursive scaffold lands
   `.autonomy/triggers/continuous-example.json` (+ idempotent SKIP on re-run).
6. Docs: `docs/pipelines.md` Triggers section gains a "starter files" note;
   `.claude/skills/engineering/pipelines.md` if the map needs it.

## Out of scope (stays on #378)

Slice 3 — orphan `.pipeline-run-*.outcome.json` sidecar sweep in doctor/worktree_gc.

## Verification

`bash tests/run_all.sh` + `shellcheck -S warning …` clean; the pre-push-checklist
item 4 (template re-validate + `test_onboard.sh`) applies. No dashboard change →
no browser loop.
