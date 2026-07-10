# Pipeline+Trigger model — Phase B: triggers as first-class objects + dispatch inversion + auto-shim

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The supervisor stops enumerating roles and starts enumerating
**triggers** — first-class `.autonomy/triggers/<name>.json` objects that each
bind ONE pipeline, supply its parameter values, and say when it fires
(continuous / schedule / manual) and how overlapping runs behave (queue-1 /
skip / parallel-N). Existing `roles:` configs keep running unchanged through an
**auto-shim** (role → pipeline + continuous trigger, synthesised on load). The
Phase A `${…}` resolver (`resolve_params` / `substitute` / `substitute_doc`) is
wired into the live compile/dispatch path, and the validator flips to ACCEPT
`${…}` in activity fields **in the same change** that wires substitution.

**Architecture:** A new `lib/triggers.py` (stdlib, imports `pipeline` for the
shared error type and gates) owns the trigger object: schema validation, the
SD-34 var-shadow resolution for trigger FILES, the roles→triggers auto-shim,
and enumeration (+ CLI for the supervisor). `lib/pipeline.py` gains the static
`${…}` reference checker, trigger-started runs (`start_run_trigger`), and the
prepare-time substitution. `bin/supervisor.sh` gains a trigger enumeration path
built BEHIND the existing role path — same seams, parallel functions — and cuts
over only in the final task, after parity is proven by test. Event firing and
`call_pipeline` stay Phase C; UI stays Phase D; trust re-key stays Phase E.

**Tech Stack:** Python 3 stdlib only (`json`, `os`, `re`, `sys`, `time`);
bash 3.2.57 (`bin/supervisor.sh`); `unittest` (`tests/test_triggers.py`,
`tests/test_pipeline.py`) + the repo's bash test harness
(`tests/test_supervisor.sh`).

> **Codex CP1: 7 findings folded** (each marked "Codex CP1" inline):
> event-role name collision refuses the native trigger (double-dispatch);
> enumeration-failure coder fallback retired (fail-open) — explicit SD
> supersession; secret pipeline DEFAULTS refuse too, `secret_lookup` seam
> removed from `start_run_trigger`; lane+slot state-file parse order pinned
> (slot first, then lane); `accounts.Registry.list()` returns dict rows —
> project names totally; manual-fire `show` parsing is exact KEY=VALUE
> lines, not substring; the Task 2 lane fixture now uses the real
> dict-keyed `lanes:` schema (and event fixtures use `on:`, not `events:`).

## Global Constraints

Carried verbatim from every prior sequencer plan — every task includes these:

- **macOS `/bin/bash` 3.2.57 floor**: NO `mapfile`/`readarray`, NO globstar,
  NO `declare -A`, NO `${var,,}`. `find … -print0` + `while IFS= read -r -d ''`
  where needed. **`shellcheck -S warning` clean** across
  `start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh`.
- **Python 3 stdlib only**; NO `eval`/`exec` anywhere (the `${…}` language stays
  the Phase A hand tokenizer over a closed allowlist).
- **Fail-safe, never fail-open** (SD-4): a malformed trigger file, an
  unresolvable ref, a required param with no value, a substituted value that
  fails its concrete check → **refuse that trigger/run/dispatch with a named
  reason**. A refused trigger NEVER falls back to legacy role dispatch — a
  broken shim-shadowing trigger that silently resurrected the role path would
  run something the operator explicitly replaced.
- **Repo-agnostic** (SD-3): nothing target-specific in `bin/`/`lib/`.
- **Honesty invariant** (prevention-log #3): the validator refuses what the
  engine cannot honor. Firing mode `event` and node type `call_pipeline` are
  refused with a phase-naming reason (Phase C), not accepted-and-ignored.
- **Secrets discipline** (SD-8): secrets never cross argv or logs. Phase B has
  **no safe sink** for a secret-typed param (briefs and runs_as land in files /
  argv), so Phase B refuses secret params end-to-end (Task 6) — that refusal IS
  the log-redaction boundary Phase A deferred, enforced by construction.
- **Tests are genuine**: `source` the real scripts, `import` the real modules;
  mock only `gh` and the injectable seams (`secret_lookup`, `known_repos`,
  `known_accounts`, `_triggers_enumerate`).

## Settled decisions + prevention-log entries binding this plan

- **SD-12 / SD-36 (dispatch shape)** — GENERALISED role→trigger: still one
  DISPATCH per loop iteration, round-robin, re-enumeration every tick,
  fan-out to `caps.max_parallel` inside a run, ephemeral worktrees for
  batches. ONE deliberate supersession (Codex CP1): SD-12's
  enumeration-failure→coder-only fallback is RETIRED at the inversion —
  post-cutover an enumeration failure idles the tick (running coder past a
  config/trigger failure would be fail-open). The new SD entry recording
  the generalisation + this supersession lands with this phase's build PR
  (spec §12: no settled decision is reversed without an explicit new SD
  entry).
- **SD-34 / SD-37 (var-shadow)** — EXTENDED to trigger files:
  `var/autonomy/triggers/<name>.json` beats committed
  `.autonomy/triggers/<name>.json`; a present-but-invalid shadow REFUSES that
  trigger, never falls back to committed (prevention-log #3); a symlinked
  shadow is ignored (not a sanctioned shadow).
- **SD-16 / SD-7** — usage-limit state stays ONE marker per supervisor
  (account-keyed); the supervisor remains the sole writer of scheduling
  state (cron last-fire markers, and now the trigger control markers).
- **SD-15** — session log filename pattern `session-<ts>.log` untouched.
- **SD-33** — planner/coder pair untouched (rides the shim's role path and the
  adapter layer, not this diff).
- **Prevention-log #3** (no silent widening fallback), **#6** (charset-gate
  every config/disk-sourced string before argv/filenames — trigger names come
  from FILENAMES), **#15** (never treat echoed-invalid config as usable — a
  refused trigger is displayed/loggable but never dispatchable), **#20** (PR
  body closing-reference probe before merge), **#21** (same-class scan on every
  review fix).
- **Spec contract:** `docs/superpowers/specs/2026-07-09-pipeline-trigger-model-design.md`
  §2.2 (trigger object), §3/§3.1 (params + where resolution wires in), §5
  (firing/lifecycle/concurrency), §7 (auto-shim), §11 (resolved decisions:
  files as storage, queue depth 1, repo param validated against registered
  checkouts, existing cron parser reused).

## Carried arguments (cite these in the PR, do not re-derive)

- **Param values are inert by construction.** `substitute()` replaces refs in
  a SINGLE `re.sub` pass and never rescans replacement text, so a param VALUE
  containing `${…}` is data, not a reference — there is no injection channel
  from trigger params into the resolver (Phase A, PR #372; test
  `test_interpolation_is_string` family).
- **Trust stays keyed per-assignment (role+pipeline) until Phase E.** The shim
  therefore makes the trigger name BYTE-EQUAL to the role name and the journal
  `role` field keeps carrying it, so ledger evidence accumulated before Phase B
  keeps counting after cutover. The journal line gains an additive `trigger`
  field now (evidence for Phase E's re-key starts accumulating), but
  `ledger()` does not read it yet.
- **Pause / stop / backoff move to the trigger** (spec §2.2): per-trigger
  `enabled` (no new fires; in-flight advances), per-trigger stop sentinel (no
  new fires AND no advance), per-trigger error backoff markers (one erroring
  trigger no longer monopolises the loop's retry cadence). The fleet-wide
  PAUSE sentinel and the account-level limit backoff SURVIVE unchanged — they
  are supervisor/account concerns, not trigger concerns.

## The dataflow after Phase B (orientation)

```text
.autonomy/triggers/*.json ──┐ (var/autonomy/triggers/*.json shadow beats committed)
roles: (config.yaml) ──shim─┴─> triggers.py enumerate ──> supervisor round-robin
                                                            │  one dispatch/tick
                                                            v
                     pipeline.py start --kind native|shim (state file per run slot)
                       native: load_trigger -> resolve_pipeline_doc -> resolve_params
                              (required-unset refuses; repo/account existence checks)
                       shim:   resolve_pipeline(repo, role)  (byte-identical to P1..P3)
                                                            │
                                                            v
                     pipeline.py ready ──> _prepare_step: ctx {params, nodes, run}
                       substitute node fields + compiled brief text (Phase A resolver)
                       post-substitution CONCRETE re-validation (refuse, never drop)
                                                            │
                                                            v
                     supervisor run_single_session / dispatch_batch (unchanged)
```

## File Structure

- **Create:** `lib/triggers.py` — the trigger object: schema constants,
  `validate_trigger`, `effective_trigger_path`, `load_trigger`,
  `shim_triggers`, `enumerate_triggers`, CLI (`dispatch`/`cron`/`show`/
  `validate`). Imports `pipeline` (shared `PipelineError`, `_NAME_RE`,
  `valid_pipeline_name`) and `roles` (config load, role enumeration,
  `cron_next_fire`, `lane_of_role`) via the established
  `sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))` pattern.
- **Create:** `tests/test_triggers.py` — one `unittest.TestCase` per Task 1–3.
- **Modify:** `lib/pipeline.py` — `check_refs` (new, after
  `_refuse_refs_in_activity_fields` `:697`), validator flip inside
  `validate_doc` `:723` and `_validate_runs_as` `:612` (Task 5, one commit),
  substitution wiring in `_prepare_step` `:1521` + `compile_brief` `:996`
  consumers, `resolve_pipeline_doc` extracted from `resolve_pipeline` `:1060`,
  `start_run_trigger` beside `start_run` `:1148`, outputs-sidecar helpers
  beside `_verdict_rel` `:1364`, CLI `start --kind` in `main` `:1777`.
- **Modify:** `tests/test_pipeline.py` — new classes per Task 4–6.
- **Modify:** `bin/supervisor.sh` — `_triggers_enumerate` seam beside
  `_roles_enumerate` `:769`, `resolve_dispatch_triggers` beside
  `resolve_dispatch_roles` `:812`, token-aware `pipeline_state_file` `:1125` /
  `inflight_roles` `:1161`, kind-split `run_session` `:1417`, trigger control
  markers + concurrency gate (new section), cron generalisation in
  `resolve_cron_due` `:859`, main-loop cutover `:1898–1931`.
- **Modify:** `tests/test_supervisor.sh` — new checks per Task 7–9.
- **Modify (docs, Task 10):** `docs/pipelines.md`, `docs/settled-decisions.md`
  (new SD entry), `.claude/skills/engineering/pipelines.md`,
  `templates/autonomy-pack/README.md` (parallel-claim discipline note).
- **NOT touched:** `bin/agents/*.sh` (adapters), `lib/dashboard_*.py` /
  `lib/*.html` (the dashboard keeps rendering the ROLE view until Phase D —
  stated honestly in docs), `bin/safe_merge.sh`, `.github/workflows/**`
  (guardrail-barred), `resolve_event_wakes` + the event bus (Phase C).

## Interfaces (Phase B deltas)

`lib/triggers.py` (all new):

- `FIRING_MODES = ("continuous", "schedule", "manual")`;
  `DEFERRED_FIRING_MODES = {"event": "the event-bus payload mapping (Phase C)"}`
- `CONCURRENCY_POLICIES = ("queue", "skip", "parallel")`;
  `MAX_TRIGGER_PARALLEL = 8` (mirrors `pipeline.MAX_PARALLEL_CEIL`)
- `effective_trigger_path(repo, name) -> str` — SD-34 for a FILE asset.
- `validate_trigger(trig, stem) -> list[str]` — `[]` = valid.
- `load_trigger(repo, name) -> dict` — raises `pipeline.PipelineError`.
- `shim_triggers(config) -> list[dict]` — synthesized trigger dicts,
  `kind="shim"`, name == role name.
- `enumerate_triggers(repo, lane=None) -> (list[dict], list[str])` —
  (triggers with `kind` tags, warning strings for every refused trigger).
- CLI: `dispatch <repo> [--lane <l>]` → `name<TAB>kind<TAB>policy<TAB>max`
  lines; `cron <repo> [--lane <l>]` → `name<TAB>schedule<TAB>kind` lines;
  `show <repo> <name>` → `KEY=VALUE` lines; `validate <repo>` → report, rc 1
  on any refused trigger.

`lib/pipeline.py`:

- `check_refs(doc, errors)` — static `${…}` validation (parse-only; no
  resolution), called from `validate_doc` after the flip.
- `resolve_pipeline_doc(repo, name) -> (doc, meta)` — the by-name half of
  `resolve_pipeline`, extracted; `resolve_pipeline(repo, role)` keeps its
  exact signature and behaviour (shim path).
- `start_run_trigger(repo, trigger_name, state_path, lane="", *,
  known_repos=None, known_accounts=None) -> state` — deliberately NO
  `secret_lookup` seam: Phase B refuses any secret that would resolve.
- `_node_outputs_rel(state_path, node_id) -> str` and
  `_collect_node_outputs(state_path, state) -> {node_id: {name: value}}`
- `_OUTPUTS_FOOTER` — brief footer instructing an agent to write its outputs
  file when a downstream `${nodes.<id>.output.*}` ref targets it.
- CLI `start` gains `--kind shim|native` (default `shim` — every existing
  caller unchanged).

`bin/supervisor.sh`:

- `_triggers_enumerate()` seam (mirrors `_roles_enumerate`),
  `resolve_dispatch_triggers()`, `resolve_trigger_cron_due()`.
- Dispatch tokens: `name` (slot 0, filename unchanged) or `name@<slot>`
  (parallel slots 1..max-1). `pipeline_state_file` gains an optional slot
  arg; `inflight_roles` → `inflight_tokens` (emits tokens, slot-aware).
- `run_session <token> <kind>` — `shim` = today's body byte-identical;
  `native` = no `resolve_role_dispatch`, empty scope, node `runs_as` +
  global defaults only.
- Trigger control markers under `$VARDIR/trigger-ctl/{fire,queued,stop,backoff}/<name>`
  (`VARDIR="$AUTONOMY_TARGET_REPO/var"`, supervisor.sh:1776; names
  charset-gated at every read — prevention-log #6).

## Cutover proof obligations (parity invariants — Task 9 tests each one)

1. **Name equality:** a shimmed trigger's name is byte-equal to its role name.
2. **Filename equality:** for skip/queue (max 1) the state file is exactly
   `.pipeline-run-<name>[--<lane>].json` — an in-flight run started BEFORE
   cutover resumes identically after (same brief/verdict derivations).
3. **Enumeration parity:** a roles-only config (no `.autonomy/triggers/`)
   enumerates exactly `roles.dispatch_roles(config, lane)` in the same order,
   every entry `kind=shim`.
4. **Journal parity:** the journal `role` field carries the trigger name
   (== role name for shims); `ledger(journal, role, pipeline)` output is
   unchanged; the new `trigger` field is additive.
5. **Fingerprint parity:** fingerprint state files keep their per-role names.
6. **Event path untouched:** `resolve_event_wakes` still dispatches event
   ROLES through the legacy role path; event roles are never shimmed.
7. **Sequential shim dispatch** runs `run_single_session` byte-identically
   (same argv, same auth precedence, same scope composition).

---

### Task 1: the trigger object — schema validation + SD-34 shadow resolution

**Files:**
- Create: `lib/triggers.py`
- Create: `tests/test_triggers.py`

**Interfaces:**
- Produces: `validate_trigger(trig, stem)`, `effective_trigger_path(repo,
  name)`, `load_trigger(repo, name)`, the schema constants — consumed by
  Tasks 2/3/6.

- [ ] **Step 1: Write the failing tests** — new file `tests/test_triggers.py`:

```python
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "lib"))
import triggers                                            # noqa: E402
import pipeline                                            # noqa: E402


def _trig(**over):
    t = {"name": "coder-a", "pipeline": "ticket-to-merge",
         "params": {"repo": "/tmp/r", "coder_model": "claude-sonnet-5"},
         "firing": {"mode": "continuous"},
         "concurrency": {"policy": "skip", "max": 1},
         "enabled": True}
    t.update(over)
    return t


class ValidateTriggerTest(unittest.TestCase):
    def test_valid_trigger_accepted(self):
        self.assertEqual(triggers.validate_trigger(_trig(), "coder-a"), [])

    def test_not_a_dict_refused(self):
        self.assertTrue(triggers.validate_trigger([], "x"))

    def test_unknown_key_refused(self):
        errs = triggers.validate_trigger(_trig(schedule="* * * * *"), "coder-a")
        self.assertTrue(any("unknown key" in e for e in errs))

    def test_name_must_match_filename_stem(self):
        errs = triggers.validate_trigger(_trig(), "other-name")
        self.assertTrue(any("stem" in e for e in errs))

    def test_name_charset_gated(self):
        errs = triggers.validate_trigger(_trig(name="../x"), "../x")
        self.assertTrue(errs)

    def test_pipeline_required_and_charset_gated(self):
        self.assertTrue(triggers.validate_trigger(_trig(pipeline=""), "coder-a"))
        self.assertTrue(triggers.validate_trigger(_trig(pipeline="a/b"), "coder-a"))

    def test_params_must_be_flat_scalar_map(self):
        self.assertTrue(triggers.validate_trigger(_trig(params=[]), "coder-a"))
        self.assertTrue(triggers.validate_trigger(
            _trig(params={"x": {"nested": 1}}), "coder-a"))
        self.assertEqual(triggers.validate_trigger(
            _trig(params={"n": 3, "b": True, "s": "x"}), "coder-a"), [])

    def test_firing_required_mode_closed_set(self):
        self.assertTrue(triggers.validate_trigger(_trig(firing=None), "coder-a"))
        self.assertTrue(triggers.validate_trigger(
            _trig(firing={"mode": "sometimes"}), "coder-a"))

    def test_event_mode_deferred_refusal_names_phase(self):
        errs = triggers.validate_trigger(
            _trig(firing={"mode": "event"}), "coder-a")
        self.assertTrue(any("Phase C" in e for e in errs))

    def test_schedule_mode_requires_valid_cron(self):
        errs = triggers.validate_trigger(
            _trig(firing={"mode": "schedule"}), "coder-a")
        self.assertTrue(any("schedule" in e for e in errs))
        errs = triggers.validate_trigger(
            _trig(firing={"mode": "schedule", "schedule": "not cron"}), "coder-a")
        self.assertTrue(any("cron" in e for e in errs))
        self.assertEqual(triggers.validate_trigger(
            _trig(firing={"mode": "schedule", "schedule": "0 6 * * *"}),
            "coder-a"), [])

    def test_schedule_key_refused_outside_schedule_mode(self):
        errs = triggers.validate_trigger(
            _trig(firing={"mode": "continuous", "schedule": "0 6 * * *"}),
            "coder-a")
        self.assertTrue(errs)      # accepted-and-ignored knob = fail-open

    def test_concurrency_policy_closed_set_and_bounds(self):
        self.assertTrue(triggers.validate_trigger(
            _trig(concurrency={"policy": "pile-up", "max": 1}), "coder-a"))
        self.assertTrue(triggers.validate_trigger(
            _trig(concurrency={"policy": "parallel", "max": 0}), "coder-a"))
        self.assertTrue(triggers.validate_trigger(
            _trig(concurrency={"policy": "parallel",
                               "max": triggers.MAX_TRIGGER_PARALLEL + 1}),
            "coder-a"))

    def test_queue_depth_bounded_at_one(self):
        # Spec S11: queue is ADF-like concurrency=1; deeper queues risk stale runs.
        errs = triggers.validate_trigger(
            _trig(concurrency={"policy": "queue", "max": 2}), "coder-a")
        self.assertTrue(any("queue" in e for e in errs))

    def test_concurrency_absent_defaults_skip_one(self):
        t = _trig()
        del t["concurrency"]
        self.assertEqual(triggers.validate_trigger(t, "coder-a"), [])

    def test_enabled_must_be_bool_when_present(self):
        self.assertTrue(triggers.validate_trigger(_trig(enabled="yes"), "coder-a"))

    def test_lane_optional_charset_gated(self):
        self.assertEqual(triggers.validate_trigger(_trig(lane="qa"), "coder-a"), [])
        self.assertTrue(triggers.validate_trigger(_trig(lane="a b"), "coder-a"))


class EffectiveTriggerPathTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.committed = os.path.join(self.repo, ".autonomy", "triggers")
        self.shadow = os.path.join(self.repo, "var", "autonomy", "triggers")
        os.makedirs(self.committed)
        os.makedirs(self.shadow)

    def test_committed_when_no_shadow(self):
        self.assertEqual(triggers.effective_trigger_path(self.repo, "t"),
                         os.path.join(self.committed, "t.json"))

    def test_shadow_file_wins(self):
        p = os.path.join(self.shadow, "t.json")
        with open(p, "w") as fh:
            fh.write("{}")
        self.assertEqual(triggers.effective_trigger_path(self.repo, "t"), p)

    def test_symlinked_shadow_ignored(self):
        target = os.path.join(self.repo, "outside.json")
        with open(target, "w") as fh:
            fh.write("{}")
        os.symlink(target, os.path.join(self.shadow, "t.json"))
        self.assertEqual(triggers.effective_trigger_path(self.repo, "t"),
                         os.path.join(self.committed, "t.json"))


class LoadTriggerTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        os.makedirs(os.path.join(self.repo, ".autonomy", "triggers"))

    def _write(self, name, obj, where=".autonomy"):
        d = os.path.join(self.repo, where, "triggers")
        if not os.path.isdir(d):
            os.makedirs(d)
        with open(os.path.join(d, "%s.json" % name), "w") as fh:
            json.dump(obj, fh)

    def test_load_valid(self):
        self._write("coder-a", _trig())
        t = triggers.load_trigger(self.repo, "coder-a")
        self.assertEqual(t["pipeline"], "ticket-to-merge")
        self.assertEqual(t["concurrency"], {"policy": "skip", "max": 1})

    def test_bad_name_refused_before_any_path_build(self):
        with self.assertRaises(pipeline.PipelineError):
            triggers.load_trigger(self.repo, "../escape")

    def test_missing_refused(self):
        with self.assertRaises(pipeline.PipelineError):
            triggers.load_trigger(self.repo, "ghost")

    def test_corrupt_json_refused(self):
        d = os.path.join(self.repo, ".autonomy", "triggers")
        with open(os.path.join(d, "bad.json"), "w") as fh:
            fh.write("{ not json")
        with self.assertRaises(pipeline.PipelineError):
            triggers.load_trigger(self.repo, "bad")

    def test_invalid_shadow_refuses_never_falls_back(self):
        # The committed file is VALID; the shadow is INVALID. SD-34 discipline:
        # present-but-invalid shadow REFUSES -- a silent fallback to committed
        # would run a config the operator's edit replaced (prevention-log #3).
        self._write("coder-a", _trig())
        self._write("coder-a", {"name": "coder-a"}, where="var/autonomy")
        with self.assertRaises(pipeline.PipelineError):
            triggers.load_trigger(self.repo, "coder-a")

    def test_defaults_applied_on_load(self):
        t = _trig()
        del t["concurrency"]
        del t["enabled"]
        self._write("coder-a", t)
        got = triggers.load_trigger(self.repo, "coder-a")
        self.assertEqual(got["concurrency"], {"policy": "skip", "max": 1})
        self.assertIs(got["enabled"], True)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run, see fail** — `python3 -m unittest tests.test_triggers -v`
  → FAIL (`No module named 'triggers'`).

- [ ] **Step 3: Implement** — create `lib/triggers.py`:

```python
#!/usr/bin/env python3
"""Trigger objects (pipeline+trigger model Phase B, spec S2.2/S5/S7).

A trigger is a first-class JSON file `.autonomy/triggers/<name>.json` that
binds ONE pipeline, supplies its parameter values, and says when it fires
(continuous/schedule/manual) and how overlapping runs behave (queue/skip/
parallel). Legacy `roles:` configs are auto-shimmed into synthetic triggers
(shim_triggers) so nothing breaks the day this ships. Stdlib only.

Fail-safe: a malformed trigger REFUSES (named reason) and NEVER falls back
to legacy role dispatch -- a broken trigger that shadows a role name must
not silently resurrect the role path the operator replaced.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline                                             # noqa: E402
from pipeline import PipelineError                          # noqa: E402

_TRIGGER_KEYS = frozenset(("name", "pipeline", "params", "firing",
                           "concurrency", "enabled", "lane"))
_FIRING_KEYS = frozenset(("mode", "schedule"))
_CONCURRENCY_KEYS = frozenset(("policy", "max"))
FIRING_MODES = ("continuous", "schedule", "manual")
DEFERRED_FIRING_MODES = {"event": "the event-bus payload mapping (Phase C)"}
CONCURRENCY_POLICIES = ("queue", "skip", "parallel")
MAX_TRIGGER_PARALLEL = 8          # mirrors pipeline.MAX_PARALLEL_CEIL


def _is_scalar(v):
    return isinstance(v, (str, int, float, bool)) or v is None


def effective_trigger_path(repo, name):
    """SD-34 applied to trigger FILES: the var-live shadow
    <repo>/var/autonomy/triggers/<name>.json wins when it exists, else the
    committed <repo>/.autonomy/triggers/<name>.json. A SYMLINKED shadow is
    ignored (not a sanctioned shadow -- the resolver can never be redirected
    out of var/). A present-but-INVALID shadow is NOT a fallback case: the
    file exists, so this returns it and load_trigger refuses it (fail-safe,
    prevention-log #3). Pure fs check; PRECONDITION: name is charset-valid."""
    committed = os.path.join(repo, ".autonomy", "triggers", "%s.json" % name)
    try:
        shadow = os.path.join(repo, "var", "autonomy", "triggers",
                              "%s.json" % name)
        if os.path.isfile(shadow) and not os.path.islink(shadow):
            return shadow
    except (OSError, TypeError):
        pass
    return committed


def validate_trigger(trig, stem):
    """Schema validation for one trigger object. [] = valid. `stem` is the
    filename stem -- name==stem is enforced so a rename can't silently fork
    identity (mirrors the pipeline name==folder gate, SD-37)."""
    if not isinstance(trig, dict):
        return ["trigger must be a JSON object"]
    errors = []
    for k in trig:
        if k not in _TRIGGER_KEYS:
            errors.append("unknown key %r -- not consumed in Phase B, "
                          "remove it (accepted-and-ignored would be the "
                          "fail-open prevention-log #3 forbids)" % k)
    nm = trig.get("name")
    if not (isinstance(nm, str) and pipeline._NAME_RE.match(nm or "")):
        errors.append("name: required, charset [A-Za-z0-9._-]{1,64}")
    elif nm != stem:
        errors.append("name %r != filename stem %r" % (nm, stem))
    if not pipeline.valid_pipeline_name(trig.get("pipeline")):
        errors.append("pipeline: required, charset [A-Za-z0-9._-]{1,64} "
                      "(existence is checked at run start)")
    params = trig.get("params")
    if params is not None:
        if not isinstance(params, dict):
            errors.append("params: must be a mapping of name -> scalar")
        else:
            for k, v in params.items():
                if not (isinstance(k, str) and pipeline._NAME_RE.match(k)):
                    errors.append("params: key %r invalid charset" % (k,))
                if not _is_scalar(v):
                    errors.append("params.%s: must be a scalar (typed "
                                  "checking happens in resolve_params)" % k)
    firing = trig.get("firing")
    if not isinstance(firing, dict):
        errors.append("firing: required, {mode: continuous|schedule|manual}")
    else:
        for k in firing:
            if k not in _FIRING_KEYS:
                errors.append("firing: unknown key %r" % k)
        mode = firing.get("mode")
        if mode in DEFERRED_FIRING_MODES:
            errors.append("firing.mode %r needs engine machinery Phase B "
                          "does not have -- lands with %s"
                          % (mode, DEFERRED_FIRING_MODES[mode]))
        elif mode not in FIRING_MODES:
            errors.append("firing.mode: must be one of %s"
                          % ", ".join(FIRING_MODES))
        if mode == "schedule":
            sched = firing.get("schedule")
            if not (isinstance(sched, str) and sched.strip()):
                errors.append("firing.schedule: required for mode=schedule")
            else:
                import roles           # lazy, path set at module top
                if roles.cron_next_fire(sched.strip(), 0) is None:
                    errors.append("firing.schedule: not a parseable 5-field "
                                  "cron expression")
        elif "schedule" in firing:
            errors.append("firing.schedule: only valid with mode=schedule "
                          "(an ignored schedule would be a silent no-op)")
    conc = trig.get("concurrency")
    if conc is not None:
        if not isinstance(conc, dict):
            errors.append("concurrency: must be {policy, max}")
        else:
            for k in conc:
                if k not in _CONCURRENCY_KEYS:
                    errors.append("concurrency: unknown key %r" % k)
            pol = conc.get("policy")
            if pol not in CONCURRENCY_POLICIES:
                errors.append("concurrency.policy: must be one of %s"
                              % ", ".join(CONCURRENCY_POLICIES))
            mx = conc.get("max")
            if not isinstance(mx, int) or isinstance(mx, bool) or not (
                    1 <= mx <= MAX_TRIGGER_PARALLEL):
                errors.append("concurrency.max: must be 1..%d"
                              % MAX_TRIGGER_PARALLEL)
            elif pol == "queue" and mx != 1:
                errors.append("concurrency: queue is bounded at max 1 "
                              "(spec S11 -- deeper queues risk stale runs)")
    if "enabled" in trig and not isinstance(trig["enabled"], bool):
        errors.append("enabled: must be a bool")
    lane = trig.get("lane")
    if lane is not None and not (isinstance(lane, str)
                                 and pipeline._NAME_RE.match(lane)):
        errors.append("lane: charset [A-Za-z0-9._-]{1,64}")
    return errors


def _apply_defaults(trig):
    out = dict(trig)
    out.setdefault("params", {})
    out.setdefault("concurrency", {"policy": "skip", "max": 1})
    out.setdefault("enabled", True)
    return out


def load_trigger(repo, name):
    """Load + validate one trigger by name (shadow-aware). Raises
    PipelineError on any failure -- charset first (the name may come from a
    filename or CLI argv: prevention-log #6), then unreadable/corrupt/
    invalid. Never falls back."""
    if not (isinstance(name, str) and pipeline._NAME_RE.match(name)):
        raise PipelineError("trigger name %r has invalid charset" % (name,))
    path = effective_trigger_path(repo, name)
    try:
        with open(path, encoding="utf-8") as fh:
            trig = json.load(fh)
    except OSError as exc:
        raise PipelineError("trigger %r unreadable: %s" % (name, exc))
    except ValueError as exc:
        raise PipelineError("trigger %r corrupt JSON (%s): %s"
                            % (name, path, exc))
    errs = validate_trigger(trig, name)
    if errs:
        raise PipelineError("trigger %r invalid: %s" % (name, "; ".join(errs)))
    return _apply_defaults(trig)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))          # main() lands in Task 3
```

  For Task 1, stub `main` so the entry guard imports cleanly:

```python
def main(argv):
    print("triggers.py: CLI lands in a later task", file=sys.stderr)
    return 2
```

- [ ] **Step 4: Run, see pass** — `python3 -m unittest tests.test_triggers -v`
  green; `python3 -m unittest tests.test_pipeline -v` still green.

- [ ] **Step 5: Commit**

```bash
git add lib/triggers.py tests/test_triggers.py
git commit -m "feat(#<ISSUE>): trigger object -- schema validation + SD-34 file shadow (pipeline+trigger model Phase B)"
```

---

### Task 2: the auto-shim — `roles:` → synthetic triggers

**Files:**
- Modify: `lib/triggers.py`
- Test: `tests/test_triggers.py`

**Interfaces:**
- Consumes: `roles.dispatch_roles` / `roles.all_cron_roles` semantics via the
  private enumerators (`roles._all_loop_roles`, `roles._all_cron_roles`,
  `roles.lane_of_role` — same module, same package, the established pattern:
  `pipeline.resolve_pipeline` already calls `roles._load_config`).
- Produces: `shim_triggers(config) -> list[dict]` — consumed by Task 3's
  enumeration.

**Shim contract (the migration heart — spec §7):**
- One shim per **enabled loop role** (`firing.mode=continuous`) and per
  **enabled cron role with a schedule** (`firing.mode=schedule`). **Event
  roles are NOT shimmed** — the event bus keeps firing them through the
  legacy role path until Phase C (dispatching them twice would be the bug).
- `name` == role name **byte-equal** (parity invariant 1 — ledger/fingerprint/
  state-file continuity).
- `params` = `{}` and `pipeline` = the role's binding or `""`: a shim run
  still resolves through `resolve_pipeline(repo, role)` (wrap + role settings
  + scope + accounts, byte-identical). The shim carries only the FIRING
  identity; the legacy settings ride the role path they always rode.
- `concurrency` = `{"policy": "skip", "max": 1}` — today's exact semantics
  (one run per role; an in-flight run advances, a new fire is skipped).
- `lane` = `roles.lane_of_role(config, name)` — the lane filter keeps working.

- [ ] **Step 1: Write the failing tests** — append to `tests/test_triggers.py`:

```python
class ShimTriggersTest(unittest.TestCase):
    def _config(self):
        return {"roles": {
            "coder": {"enabled": True},
            "pm": {"enabled": True,
                   "trigger": {"type": "cron", "schedule": "0 6 * * *"}},
            "qa": {"enabled": True, "trigger": {"type": "event",
                                                "on": ["pr.opened"]}},
            "researcher": {"enabled": False}}}

    def test_loop_role_becomes_continuous_shim(self):
        shims = triggers.shim_triggers(self._config())
        coder = [t for t in shims if t["name"] == "coder"][0]
        self.assertEqual(coder["firing"], {"mode": "continuous"})
        self.assertEqual(coder["concurrency"], {"policy": "skip", "max": 1})
        self.assertEqual(coder["kind"], "shim")
        self.assertEqual(coder["params"], {})
        self.assertIs(coder["enabled"], True)

    def test_cron_role_becomes_schedule_shim(self):
        shims = triggers.shim_triggers(self._config())
        pm = [t for t in shims if t["name"] == "pm"][0]
        self.assertEqual(pm["firing"],
                         {"mode": "schedule", "schedule": "0 6 * * *"})

    def test_event_role_not_shimmed(self):
        # The event bus stays on the legacy role path until Phase C --
        # shimming would dispatch qa twice (once per path).
        names = [t["name"] for t in triggers.shim_triggers(self._config())]
        self.assertNotIn("qa", names)

    def test_disabled_role_not_shimmed(self):
        names = [t["name"] for t in triggers.shim_triggers(self._config())]
        self.assertNotIn("researcher", names)

    def test_shim_order_matches_dispatch_roles_order(self):
        # Parity invariant 3 depends on this ordering.
        import roles
        cfg = self._config()
        loop_shims = [t["name"] for t in triggers.shim_triggers(cfg)
                      if t["firing"]["mode"] == "continuous"]
        self.assertEqual(loop_shims, roles._all_loop_roles(cfg))

    def test_shim_carries_pipeline_binding_when_bound(self):
        cfg = {"roles": {"coder": {"enabled": True,
                                   "pipeline": "ticket-to-merge"}}}
        coder = triggers.shim_triggers(cfg)[0]
        self.assertEqual(coder["pipeline"], "ticket-to-merge")

    def test_shim_carries_lane(self):
        # lanes: is a dict KEYED BY LANE NAME, first key = default lane
        # (roles._declared_lane_names/default_lane, lib/roles.py:110-122).
        cfg = {"lanes": {"main": {}, "qa-lane": {}},
               "roles": {"coder": {"enabled": True, "lane": "qa-lane"}}}
        coder = [t for t in triggers.shim_triggers(cfg)
                 if t["name"] == "coder"][0]
        self.assertEqual(coder["lane"], "qa-lane")

    def test_degenerate_config_yields_defaults_not_crash(self):
        # dispatch must degrade, never crash (roles.py convention).
        self.assertIsInstance(triggers.shim_triggers({}), list)
        self.assertIsInstance(triggers.shim_triggers({"roles": []}), list)
```

  NOTE (Codex CP1): the `lanes:` fixture above uses the REAL schema (a dict
  keyed by lane name, `lib/roles.py:110`); cross-check it against a passing
  `tests/test_roles.py` lane case before committing anyway — a wrong fixture
  here would mask lane-filter regressions.

- [ ] **Step 2: Run, see fail** (`shim_triggers` undefined).

- [ ] **Step 3: Implement** — append to `lib/triggers.py`:

```python
def shim_triggers(config):
    """Auto-shim (spec S7): every enabled loop role -> a synthetic continuous
    trigger; every enabled cron role -> a synthetic schedule trigger. Event
    roles are NOT shimmed -- the event bus fires them through the legacy role
    path until Phase C wires event triggers (a shim would double-dispatch).

    The shim carries FIRING identity only: name==role (byte-equal -- ledger/
    fingerprint/state-file continuity, the Phase E trust argument), params={},
    and the role's pipeline binding verbatim ('' = wrapped role). A shim run
    resolves settings through resolve_pipeline(repo, role) exactly as before
    -- prompts, scope, accounts, model precedence all ride the role path."""
    import roles
    out = []
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    if not isinstance(roles_blk, dict):
        roles_blk = {}

    def _binding(name):
        cfg = roles_blk.get(name)
        b = cfg.get("pipeline") if isinstance(cfg, dict) else None
        return b.strip() if isinstance(b, str) else ""

    def _shim(name, firing):
        return {"name": name, "pipeline": _binding(name), "params": {},
                "firing": firing,
                "concurrency": {"policy": "skip", "max": 1},
                "enabled": True, "lane": roles.lane_of_role(config, name),
                "kind": "shim"}

    for name in roles._all_loop_roles(config):
        out.append(_shim(name, {"mode": "continuous"}))
    for name, sched in roles._all_cron_roles(config):
        out.append(_shim(name, {"mode": "schedule", "schedule": sched}))
    return out
```

- [ ] **Step 4: Run, see pass; full `tests.test_triggers` + `tests.test_roles`
  still green.**

- [ ] **Step 5: Commit** `feat(#<ISSUE>): auto-shim -- roles become synthetic
  continuous/schedule triggers (event roles stay on the legacy bus until C)`.

---

### Task 3: enumeration + the triggers CLI

**Files:**
- Modify: `lib/triggers.py`
- Test: `tests/test_triggers.py`

**Interfaces:**
- Consumes: `load_trigger`/`validate_trigger` (Task 1), `shim_triggers`
  (Task 2).
- Produces: `enumerate_triggers(repo, lane=None) -> (triggers, warnings)` and
  the CLI the supervisor calls (Task 7):
  `dispatch <repo> [--lane <l>]` → `name<TAB>kind<TAB>policy<TAB>max` (one per
  continuous/manual enabled trigger; manual only listed by Task 8's marker
  logic — see below); `cron <repo> [--lane <l>]` →
  `name<TAB>schedule<TAB>kind`; `show <repo> <name>` → `KEY=VALUE` lines;
  `validate <repo>` → human report, rc 1 if anything refused.

**Semantics to lock:**
- File triggers are `kind="native"`. A file trigger whose name equals a
  LOOP/CRON role name **supersedes** that role's shim (explicit config beats
  synthesized config — the per-role migration path), with a warning line
  naming the supersession so it is never silent.
- **Event-role name collision is REFUSED** (Codex CP1): event roles are not
  shimmed (Task 2) and `resolve_event_wakes` keeps firing them through the
  legacy role path (Task 9) — a native trigger named like an enabled event
  role would DOUBLE-DISPATCH that name across the cutover. Until Phase C
  wires event triggers, a native trigger whose name equals an enabled event
  role (`roles._all_event_roles`) is refused with a warning naming the
  collision and the phase. Test:
  `test_native_trigger_colliding_with_event_role_refused`.
- An INVALID file trigger is **refused**: excluded from the enumeration,
  reported in `warnings`. **If it shadows a role name, the shim stays
  suppressed anyway** — a broken trigger must never resurrect legacy role
  dispatch (Global Constraints; the operator replaced that path on purpose;
  fail-safe is "nothing runs", never "the old thing quietly runs").
- Lane filter: a trigger belongs to `trig.get("lane") or default lane`; the
  enumeration returns only the requested lane's triggers (mirrors
  `roles._in_lane`: an undeclared lane matches no target).
- Config unreadable/unparseable → the shim source is unavailable → the
  function raises / CLI exits non-zero. The supervisor's conservative
  fallback is Task 7's concern.
- Enumeration lists **enabled** triggers only for `dispatch`/`cron`;
  `validate` reports everything including disabled + refused.

- [ ] **Step 1: Write the failing tests** — append to `tests/test_triggers.py`:

```python
class EnumerateTriggersTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        os.makedirs(os.path.join(self.repo, ".autonomy", "triggers"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n")

    def _write(self, name, obj, where=".autonomy"):
        d = os.path.join(self.repo, where, "triggers")
        if not os.path.isdir(d):
            os.makedirs(d)
        with open(os.path.join(d, "%s.json" % name), "w") as fh:
            json.dump(obj, fh)

    def test_roles_only_config_enumerates_shims(self):
        trigs, warns = triggers.enumerate_triggers(self.repo)
        self.assertEqual([(t["name"], t["kind"]) for t in trigs],
                         [("coder", "shim")])
        self.assertEqual(warns, [])

    def test_native_trigger_included(self):
        self._write("qa-nightly", _trig(name="qa-nightly",
                                        firing={"mode": "continuous"}))
        trigs, _ = triggers.enumerate_triggers(self.repo)
        names = {t["name"]: t["kind"] for t in trigs}
        self.assertEqual(names["qa-nightly"], "native")

    def test_native_supersedes_same_name_shim_with_warning(self):
        self._write("coder", _trig(name="coder"))
        trigs, warns = triggers.enumerate_triggers(self.repo)
        kinds = [t["kind"] for t in trigs if t["name"] == "coder"]
        self.assertEqual(kinds, ["native"])          # exactly one, the file
        self.assertTrue(any("supersedes" in w for w in warns))

    def test_invalid_file_trigger_refused_and_never_falls_back_to_shim(self):
        # THE carried argument: a broken trigger shadowing a role must not
        # resurrect role dispatch. coder must NOT appear at all.
        self._write("coder", {"name": "coder", "firing": {"mode": "wat"}})
        trigs, warns = triggers.enumerate_triggers(self.repo)
        self.assertEqual([t for t in trigs if t["name"] == "coder"], [])
        self.assertTrue(any("coder" in w for w in warns))

    def test_disabled_trigger_excluded_from_dispatch_enumeration(self):
        self._write("qa-nightly", _trig(name="qa-nightly", enabled=False))
        trigs, _ = triggers.enumerate_triggers(self.repo)
        self.assertNotIn("qa-nightly", [t["name"] for t in trigs])

    def test_native_trigger_colliding_with_event_role_refused(self):
        # Event roles stay on the legacy bus until Phase C; a same-name
        # native trigger would double-dispatch that name (Codex CP1).
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w") as fh:
            fh.write("roles:\n  qa:\n    enabled: true\n"
                     "    trigger:\n      type: event\n"
                     "      on: [pr.opened]\n")
        self._write("qa", _trig(name="qa"))
        trigs, warns = triggers.enumerate_triggers(self.repo)
        self.assertNotIn("qa", [t["name"] for t in trigs])
        self.assertTrue(any("event" in w and "qa" in w for w in warns))

    def test_bad_filename_stem_refused_with_warning(self):
        d = os.path.join(self.repo, ".autonomy", "triggers")
        with open(os.path.join(d, "has space.json"), "w") as fh:
            fh.write("{}")
        trigs, warns = triggers.enumerate_triggers(self.repo)
        self.assertTrue(any("has space" in w for w in warns))

    def test_shadow_only_trigger_enumerates(self):
        self._write("hotfix", _trig(name="hotfix"), where="var/autonomy")
        trigs, _ = triggers.enumerate_triggers(self.repo)
        self.assertIn("hotfix", [t["name"] for t in trigs])

    def test_config_unreadable_raises(self):
        os.remove(os.path.join(self.repo, ".autonomy", "config.yaml"))
        with self.assertRaises(pipeline.PipelineError):
            triggers.enumerate_triggers(self.repo)
```

- [ ] **Step 2: Run, see fail.**

- [ ] **Step 3: Implement** — append to `lib/triggers.py` (and replace the
  Task 1 `main` stub):

```python
def _trigger_stems(repo):
    """Union of committed + shadow trigger filename stems. Filenames are DISK
    INPUT: stems that fail the charset gate are returned in the second slot
    so the caller can warn (never silently dropped, never path-joined)."""
    stems, bad = [], []
    for d in (os.path.join(repo, ".autonomy", "triggers"),
              os.path.join(repo, "var", "autonomy", "triggers")):
        try:
            entries = sorted(os.listdir(d))
        except OSError:
            continue
        for fn in entries:
            if not fn.endswith(".json"):
                continue
            stem = fn[:-len(".json")]
            if not pipeline._NAME_RE.match(stem):
                bad.append(stem)
            elif stem not in stems:
                stems.append(stem)
    return stems, bad


def enumerate_triggers(repo, lane=None):
    """(triggers, warnings) for one lane. Native file triggers (validated,
    kind='native') + shims for roles no file supersedes (kind='shim').
    Every refusal becomes a warning string -- a refused trigger is OUT of
    the dispatchable list AND its same-name shim stays suppressed (never
    fall back to role dispatch for a broken/shadowing trigger). Raises
    PipelineError when the config (the shim source) is unreadable."""
    import roles
    cfg, rc = roles._load_config(repo)
    if rc != 0 or cfg is None:
        raise PipelineError("config unreadable/unparseable for %s (rc %d) "
                            "-- cannot enumerate triggers" % (repo, rc))
    target_lane = lane if lane is not None else roles.default_lane(cfg)
    declared = roles.lane_names(cfg)
    warnings, out, native_stems = [], [], set()
    event_names = set(n for (n, _ev) in roles.all_event_roles(cfg))
    stems, bad = _trigger_stems(repo)
    for stem in bad:
        warnings.append("refused trigger file %r: invalid name charset"
                        % stem)
    for stem in stems:
        native_stems.add(stem)      # even a BROKEN file suppresses the shim
        if stem in event_names:
            # Event roles stay on the legacy bus until Phase C; a same-name
            # native trigger would DOUBLE-DISPATCH this name (Codex CP1).
            warnings.append("refused trigger %r: collides with an enabled "
                            "event role -- event triggers land in Phase C"
                            % stem)
            continue
        try:
            trig = load_trigger(repo, stem)
        except PipelineError as exc:
            warnings.append("refused trigger %r: %s" % (stem, exc))
            continue
        trig["kind"] = "native"
        out.append(trig)
    shims = shim_triggers(cfg)
    for t in shims:
        if t["name"] in native_stems:
            warnings.append("trigger %r supersedes the role shim of the "
                            "same name" % t["name"])
            continue
        out.append(t)
    def _in_lane(t):
        tl = t.get("lane") or roles.default_lane(cfg)
        return tl in declared and tl == target_lane
    return ([t for t in out if t.get("enabled", True) and _in_lane(t)],
            warnings)


def _cli_lane(args):
    opts = {"--lane": None}
    pos, i = [], 0
    while i < len(args):
        if args[i] == "--lane" and i + 1 < len(args):
            opts["--lane"] = args[i + 1]
            i += 2
        else:
            pos.append(args[i])
            i += 1
    return pos, opts["--lane"]


def main(argv):
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    pos, lane = _cli_lane(rest)
    if cmd in ("dispatch", "cron", "validate") and len(pos) != 1:
        print("usage: triggers.py %s <repo> [--lane <l>]" % cmd,
              file=sys.stderr)
        return 2
    if cmd == "dispatch":
        try:
            trigs, warns = enumerate_triggers(pos[0], lane)
        except PipelineError as exc:
            print("triggers dispatch: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w, file=sys.stderr)
        for t in trigs:
            if t["firing"]["mode"] == "continuous":
                c = t["concurrency"]
                print("%s\t%s\t%s\t%d" % (t["name"], t["kind"],
                                          c["policy"], c["max"]))
        return 0
    if cmd == "cron":
        try:
            trigs, warns = enumerate_triggers(pos[0], lane)
        except PipelineError as exc:
            print("triggers cron: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w, file=sys.stderr)
        for t in trigs:
            if t["firing"]["mode"] == "schedule":
                print("%s\t%s\t%s" % (t["name"], t["firing"]["schedule"],
                                      t["kind"]))
        return 0
    if cmd == "show":
        if len(pos) != 2:
            print("usage: triggers.py show <repo> <name>", file=sys.stderr)
            return 2
        try:
            t = load_trigger(pos[0], pos[1])
        except PipelineError as exc:
            print("triggers show: %s" % exc, file=sys.stderr)
            return 1
        c = t["concurrency"]
        print("NAME=%s" % t["name"])
        print("PIPELINE=%s" % t["pipeline"])
        print("MODE=%s" % t["firing"]["mode"])
        print("POLICY=%s" % c["policy"])
        print("MAX=%d" % c["max"])
        print("ENABLED=%s" % ("true" if t.get("enabled", True) else "false"))
        return 0
    if cmd == "validate":
        try:
            trigs, warns = enumerate_triggers(pos[0], lane)
        except PipelineError as exc:
            print("triggers validate: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w)
        for t in trigs:
            print("OK %s (%s, %s)" % (t["name"], t["kind"],
                                      t["firing"]["mode"]))
        # Only REFUSALS fail the report -- a supersession note is
        # informational (the 'refused ' prefix is the contract; a test pins
        # that a superseding-but-valid native trigger exits 0).
        return 1 if any(w.startswith("refused") for w in warns) else 0
    print("unknown subcommand %r" % cmd, file=sys.stderr)
    return 2
```

  Also add `CliTest` cases to `tests/test_triggers.py` driving `main` with
  a tmp repo (capture stdout via `contextlib.redirect_stdout`): `dispatch`
  emits the TAB line for a continuous shim; `cron` emits the schedule shim;
  `show` round-trips a written trigger; `validate` returns rc 1 when a
  refused trigger exists.

- [ ] **Step 4: Run, see pass; full suite green.**

- [ ] **Step 5: Commit** `feat(#<ISSUE>): trigger enumeration + CLI -- natives
  supersede shims, refusals never fall back to role dispatch`.

---

### Task 4: the static `${…}` reference checker (`check_refs`)

**Files:**
- Modify: `lib/pipeline.py` (new function after
  `_refuse_refs_in_activity_fields` `:697`; NOT yet called — the flip is
  Task 5's single commit)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `_REF_RE` `:217`, `_CALL_RE`/`_ALLOWED_FUNCS`/`_split_args`
  (Phase A, `:387-424`), `effective_edges` `:338`.
- Produces: `check_refs(doc, errors)` — called by `validate_doc` in Task 5.

**Semantics (spec §3.1 "unresolved/unknown ref … is a validator error"):**
- Every `${…}` body in node/container **string fields** must parse as either
  a dotted ref or an allowlisted function call (arity-checked statically).
- `${params.x}` → `x` must be DECLARED in `doc["params"]`; a ref to a
  **secret-typed** param is refused (Phase B has no safe sink — the value
  would land in a brief file or argv; SD-8).
- `${nodes.<id>.output.<n>}` → `<id>` must be an existing node that is a
  **strict ancestor** of the referencing unit over `effective_edges(doc)`
  (walk the reversed edge relation from the referencing unit's top-level
  unit; container children resolve to their container for ancestry). A ref
  to self, a sibling, or a downstream node is a validator error — the walk
  engine cannot have its outputs yet. The output NAME is not statically
  checkable (agent-written at run time); a missing name refuses at prepare
  time instead.
- `${run.<f>}` → `f` in `("id", "pipeline", "trigger", "repo")`.
- `brief_ref` and `legacy_prompt` values must stay `${}`-FREE (they are file
  PATHS resolved before substitution exists in the flow — a ref there would
  dispatch a garbage path).
- Function calls: name in `_ALLOWED_FUNCS`, arity within bounds, arguments
  recursively checked (a ref argument is checked as a ref).

- [ ] **Step 1: Write the failing tests** — append to `tests/test_pipeline.py`:

```python
class CheckRefsTest(unittest.TestCase):
    def _doc(self, nodes=None, edges=None, params=None):
        d = {"name": "flow", "version": 1,
             "caps": {"max_sessions_per_run": 16},
             "params": params if params is not None else
                 [{"name": "m", "type": "model", "default": "claude-sonnet-5"},
                  {"name": "tok", "type": "secret"}],
             "nodes": nodes or
                 [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                  {"id": "b", "type": "agent_task", "brief_ref": "b.md"}],
             "edges": edges if edges is not None else
                 [{"from": "a", "to": "b", "on": "success"}]}
        return d

    def _errs(self, doc):
        errors = []
        pipeline.check_refs(doc, errors)
        return errors

    def test_declared_param_ref_ok(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${params.m}"}
        self.assertEqual(self._errs(d), [])

    def test_undeclared_param_ref_refused(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${params.ghost}"}
        self.assertTrue(any("ghost" in e for e in self._errs(d)))

    def test_secret_param_ref_refused_everywhere(self):
        # Phase B has no safe sink for a secret (briefs/argv are files) --
        # SD-8. The env channel lands with Phase C.
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"account": "${params.tok}"}
        self.assertTrue(any("secret" in e for e in self._errs(d)))

    def test_upstream_node_output_ref_ok(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${nodes.a.output.model}"}
        self.assertEqual(self._errs(d), [])

    def test_downstream_or_sibling_node_ref_refused(self):
        d = self._doc()
        d["nodes"][0]["runs_as"] = {"model": "${nodes.b.output.x}"}   # downstream
        self.assertTrue(self._errs(d))
        d2 = self._doc(edges=[])                                       # siblings
        d2["nodes"][0]["runs_as"] = {"model": "${nodes.b.output.x}"}
        self.assertTrue(self._errs(d2))

    def test_self_ref_refused(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${nodes.b.output.x}"}
        self.assertTrue(self._errs(d))

    def test_unknown_node_ref_refused(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${nodes.ghost.output.x}"}
        self.assertTrue(self._errs(d))

    def test_run_fields_closed_set(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${run.id}"}
        self.assertEqual(self._errs(d), [])
        d["nodes"][1]["runs_as"] = {"model": "${run.hostname}"}
        self.assertTrue(self._errs(d))

    def test_function_allowlist_and_arity_static(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${default(params.m, 'x')}"}
        self.assertEqual(self._errs(d), [])
        d["nodes"][1]["runs_as"] = {"model": "${danger(params.m)}"}
        self.assertTrue(self._errs(d))
        d["nodes"][1]["runs_as"] = {"model": "${slug()}"}
        self.assertTrue(self._errs(d))

    def test_brief_ref_and_legacy_prompt_stay_ref_free(self):
        d = self._doc(nodes=[{"id": "a", "type": "pick",
                              "brief_ref": "${params.m}.md"}], edges=[])
        self.assertTrue(self._errs(d))
        d2 = self._doc(nodes=[{"id": "a", "type": "agent_task",
                               "legacy_prompt": "${params.m}"}], edges=[])
        self.assertTrue(self._errs(d2))

    def test_malformed_body_refused(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${params.m"}      # unterminated
        self.assertTrue(self._errs(d))

    def test_escaped_literal_ignored(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "$${params.m}"}
        # An escaped literal is prose, not a ref -- but runs_as.model with a
        # literal '${' still fails the CONCRETE model check at prepare time;
        # statically it is not a reference error.
        self.assertEqual([e for e in self._errs(d) if "reference" in e], [])
```

- [ ] **Step 2: Run, see fail** (`check_refs` undefined).

- [ ] **Step 3: Implement** — add after `_refuse_refs_in_activity_fields`
  (`lib/pipeline.py:721`):

```python
_RUN_FIELDS = ("id", "pipeline", "trigger", "repo")
# Fields that are file PATHS resolved before substitution runs -- a ${} here
# would dispatch a garbage path, so they stay ref-free forever.
_REF_FREE_FIELDS = ("brief_ref", "legacy_prompt")


def _ancestors(doc, uid):
    """Strict ancestor UNIT ids of top-level unit `uid` over
    effective_edges (traversal edges only -- back-edges excluded: an output
    'from the future' via a back-edge is not statically guaranteed).
    TOTAL over garbage doc shapes: check_refs runs inside validate_doc
    BEFORE the node/edge shape checks, so a malformed edges list must
    degrade to 'no ancestors' (which REFUSES node-output refs -- the safe
    side) rather than crash the validator."""
    parents = {}
    try:
        edges = effective_edges(doc)
    except Exception:
        return set()
    for e in edges:
        if not isinstance(e, dict) or e.get("back"):
            continue
        parents.setdefault(e.get("to"), set()).add(e.get("from"))
    seen, stack = set(), list(parents.get(uid, ()))
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(parents.get(cur, ()))
    return seen


def _check_expr_static(expr, declared_params, allowed_nodes, errors, where):
    """Parse ONE ${...} body without resolving anything. Mirrors
    _resolve_expr's grammar exactly -- if this accepts, resolution can only
    fail on run-time-only facts (a node that wrote no outputs)."""
    expr = expr.strip()
    m = _CALL_RE.match(expr)
    if m:
        fn, raw = m.group(1), m.group(2)
        spec = _ALLOWED_FUNCS.get(fn)
        if spec is None:
            errors.append("%s: unknown function %r (allowed: %s)"
                          % (where, fn, ", ".join(sorted(_ALLOWED_FUNCS))))
            return
        _impl, lo, hi = spec
        try:
            args = _split_args(raw)
        except PipelineError as exc:
            errors.append("%s: %s" % (where, exc))
            return
        if len(args) < lo or (hi is not None and len(args) > hi):
            errors.append("%s: function %r arity: expected %s, got %d"
                          % (where, fn, lo if hi == lo else "%s+" % lo,
                             len(args)))
        for a in args:
            a = a.strip()
            if len(a) >= 2 and a[0] == a[-1] and a[0] in "'\"":
                continue                              # string literal
            if re.match(r"^-?\d+$", a):
                continue                              # int literal
            _check_expr_static(a, declared_params, allowed_nodes, errors,
                               where)
        return
    parts = expr.split(".")
    if parts[0] == "params" and len(parts) == 2:
        decl = declared_params.get(parts[1])
        if decl is None:
            errors.append("%s: ${params.%s} is not a declared param"
                          % (where, parts[1]))
        elif decl.get("type") == "secret":
            errors.append("%s: ${params.%s} is secret-typed -- secrets have "
                          "no safe substitution sink in Phase B (briefs and "
                          "runs_as land in files/argv; the env channel is "
                          "Phase C)" % (where, parts[1]))
        return
    if parts[0] == "nodes" and len(parts) == 4 and parts[2] == "output":
        if parts[1] not in allowed_nodes:
            errors.append("%s: ${nodes.%s.output.%s} does not name a strict "
                          "upstream node -- its outputs cannot exist yet"
                          % (where, parts[1], parts[3]))
        return
    if parts[0] == "run" and len(parts) == 2:
        if parts[1] not in _RUN_FIELDS:
            errors.append("%s: ${run.%s} unknown (fields: %s)"
                          % (where, parts[1], ", ".join(_RUN_FIELDS)))
        return
    errors.append("%s: unresolvable reference ${%s}" % (where, expr))


def check_refs(doc, errors):
    """Static validation of every ${...} in activity string fields (spec
    S3.1: an unresolved/unknown ref or non-allowlisted function is a
    VALIDATOR error -- refuse, don't run). Field-blind scan like
    _refuse_refs_in_activity_fields was, except brief_ref/legacy_prompt
    which must stay ref-free (they are paths, resolved before substitution).
    Also refuses an unterminated '${' (substitute would raise at prepare
    time -- catching it at validate time keeps 'validating == runnable')."""
    declared = {p.get("name"): p for p in (doc.get("params") or [])
                if isinstance(p, dict)}
    con_of = {}
    for con in (doc.get("containers") or []):
        if isinstance(con, dict):
            for ch in (con.get("children") or []):
                con_of[ch] = con.get("id")

    def scan(where, v, unit):
        if isinstance(v, str):
            if "${" in v.replace("$${", ""):
                allowed = _ancestors(doc, unit) if unit else set()
                # container children may also reference EARLIER SIBLINGS in
                # the same container -- the walk runs them in order.
                protected = v.replace("$${", _ESC)
                bodies = _REF_RE.findall(protected)
                stripped = _REF_RE.sub("", protected)
                if "${" in stripped:
                    errors.append("%s: unterminated ${ reference" % where)
                for b in bodies:
                    _check_expr_static(b, declared, allowed, errors, where)
        elif isinstance(v, dict):
            for k, x in v.items():
                scan("%s.%s" % (where, k), x, unit)
        elif isinstance(v, list):
            for j, x in enumerate(v):
                scan("%s[%d]" % (where, j), x, unit)

    for i, node in enumerate(doc.get("nodes") or []):
        if not isinstance(node, dict):
            continue
        where = "nodes[%d]" % i
        for f in _REF_FREE_FIELDS:
            val = node.get(f)
            if isinstance(val, str) and "${" in val:
                errors.append("%s.%s: is a file path -- ${...} is never "
                              "substituted in paths" % (where, f))
        unit = con_of.get(node.get("id"), node.get("id"))
        clean = {k: v for k, v in node.items() if k not in _REF_FREE_FIELDS}
        scan(where, clean, unit)
    for i, con in enumerate(doc.get("containers") or []):
        if isinstance(con, dict):
            scan("containers[%d]" % i, con, con.get("id"))
```

  **Container-children ancestry note (implement exactly):** a node inside a
  container resolves ancestry from its CONTAINER's unit id (`con_of`). Phase
  B does NOT statically allow same-container earlier-sibling refs — the
  container is one unit to the walk; add that refinement only if a starter
  pipeline needs it (YAGNI; refusing is the safe side).

- [ ] **Step 4: Run, see pass** — `python3 -m unittest
  tests.test_pipeline.CheckRefsTest -v`; full suite green (`check_refs` is
  not yet wired into `validate_doc`, so nothing else changes).

- [ ] **Step 5: Commit** `feat(#<ISSUE>): static \${} reference checker --
  declared params (secret refs refused), upstream-only node outputs, closed
  run fields, static function arity`.

---

### Task 5: the validator flip + substitution wired into prepare (ONE commit)

**Files:**
- Modify: `lib/pipeline.py` — `validate_doc` `:723` (swap
  `_refuse_refs_in_activity_fields` for `check_refs`; DELETE
  `_refuse_refs_in_activity_fields` `:697-720`), `_validate_runs_as` `:612`,
  `_prepare_step` `:1521`, new helpers beside `_verdict_rel` `:1364`.
- Test: `tests/test_pipeline.py` (update
  `test_reference_in_field_still_refused_in_phase_a` — its Phase A premise
  ends here — plus new classes below).

**This task is the operator's "same change" requirement:** the validator
STOPS refusing `${…}` in activity fields in the very commit that makes those
references resolve at prepare time. Do not split.

**Interfaces:**
- Consumes: `check_refs` (Task 4), `substitute`/`substitute_doc`/`_ESC`
  (Phase A), `compile_brief` `:996`, `_effective_runs_as` `:1355`,
  `read_outputs` `:563`.
- Produces: prepare-time context building + post-substitution concrete
  validation; `_node_outputs_rel`, `_collect_node_outputs`,
  `_OUTPUTS_FOOTER` — consumed by Task 6 (run ctx) and by agents at run time.

- [ ] **Step 1: Write the failing tests** — append to `tests/test_pipeline.py`
  (a fixture run driven through the REAL state machine, the established
  pattern in this file — reuse the existing tmp-pipeline-dir helpers):

```python
class SubstitutionWiringTest(unittest.TestCase):
    """Drives ready_set over a hand-built fmt-2 state with ${} fields.
    start_run_trigger lands in Task 6; state['params']/'run' default to {}
    when absent, so every pre-existing state fixture keeps passing."""
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.pdir = os.path.join(self.repo, ".autonomy", "pipelines", "flow")
        os.makedirs(self.pdir)
        self.logdir = os.path.join(self.repo, "var", "autonomy-logs")
        os.makedirs(self.logdir)
        self.state = os.path.join(self.logdir, ".pipeline-run-t1.json")

    def _doc(self, nodes, edges, params=None):
        return {"name": "flow", "version": 1,
                "params": params or [
                    {"name": "m", "type": "model",
                     "default": "claude-sonnet-5"},
                    {"name": "ticket", "type": "string", "default": "AE-1"},
                    {"name": "eff", "type": "string", "default": "high"}],
                "caps": {"max_sessions_per_run": 8},
                "nodes": nodes, "edges": edges}

    def _write(self, doc, briefs, state_params=None, done=None, units=None):
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        for name, text in briefs.items():
            with open(os.path.join(self.pdir, name), "w") as fh:
                fh.write(text)
        d = dict(doc)
        d["edges"] = pipeline.effective_edges(d)
        st = {"fmt": 2, "run_id": "t1-x-1", "role": "t1", "lane": "",
              "doc": d,
              "meta": {"pipeline_dir": self.pdir, "wrapped": False,
                       "from": "flow", "from_version": 1},
              "trigger": "t1", "kind": "native",
              "params": state_params if state_params is not None else
                  {"m": "claude-sonnet-5", "ticket": "AE-1", "eff": "high"},
              "run": {"id": "t1-x-1", "pipeline": "flow", "trigger": "t1",
                      "repo": self.repo},
              "started": 0, "sessions": 0,
              "units": units or dict((u, {"status": "pending"})
                                     for u in pipeline._top_units(d)),
              "container_pos": {}, "rounds": {}, "bounces": {},
              "nodes_done": done or [], "status": "in_progress"}
        with open(self.state, "w") as fh:
            json.dump(st, fh)

    def _one_node(self, brief_text, runs_as=None):
        node = {"id": "a", "type": "pick", "brief_ref": "a.md"}
        if runs_as:
            node["runs_as"] = runs_as
        self._write(self._doc([node], []), {"a.md": brief_text})

    def test_validator_accepts_refs_in_activity_fields_now(self):
        d = self._doc([{"id": "a", "type": "pick", "brief_ref": "a.md"},
                       {"id": "b", "type": "agent_task", "brief_ref": "b.md",
                        "runs_as": {"model": "${params.m}",
                                    "effort": "${params.eff}"}}],
                      [{"from": "a", "to": "b", "on": "success"}])
        self.assertEqual(pipeline.validate_doc(d, None), [])

    def test_brief_text_interpolates_params(self):
        self._one_node("Work ${params.ticket} now")
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        with open(steps[0]["prompt"]) as fh:
            self.assertIn("Work AE-1 now", fh.read())

    def test_runs_as_whole_value_substitution_is_typed(self):
        self._one_node("plain", runs_as={"model": "${params.m}"})
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        self.assertEqual(steps[0]["runs_as"]["model"], "claude-sonnet-5")

    def test_bad_resolved_effort_refuses_and_leaves_unit_pending(self):
        self._one_node("plain", runs_as={"effort": "${params.eff}"})
        # overwrite state params with a non-effort value
        with open(self.state) as fh:
            st = json.load(fh)
        st["params"]["eff"] = "not-an-effort"
        with open(self.state, "w") as fh:
            json.dump(st, fh)
        with self.assertRaises(pipeline.PipelineError):
            pipeline.ready_set(self.state, self.logdir, 1)
        with open(self.state) as fh:
            after = json.load(fh)
        self.assertEqual(after["units"]["a"]["status"], "pending")

    def test_upstream_output_ref_resolves_from_sidecar(self):
        nodes = [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                 {"id": "b", "type": "agent_task", "brief_ref": "b.md"}]
        edges = [{"from": "a", "to": "b", "on": "success"}]
        self._write(self._doc(nodes, edges),
                    {"a.md": "pick", "b.md": "work on ${nodes.a.output.branch}"},
                    done=[{"id": "a", "outcome": "success", "unit": "a"}],
                    units={"a": {"status": "success"},
                           "b": {"status": "pending"}})
        sidecar = os.path.join(self.logdir, ".pipeline-run-t1.a.outputs.json")
        pipeline.write_output(sidecar, "branch", "feat/x")
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        with open(steps[0]["prompt"]) as fh:
            self.assertIn("work on feat/x", fh.read())

    def test_missing_upstream_output_refuses(self):
        nodes = [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                 {"id": "b", "type": "agent_task", "brief_ref": "b.md"}]
        edges = [{"from": "a", "to": "b", "on": "success"}]
        self._write(self._doc(nodes, edges),
                    {"a.md": "pick", "b.md": "on ${nodes.a.output.branch}"},
                    done=[{"id": "a", "outcome": "success", "unit": "a"}],
                    units={"a": {"status": "success"},
                           "b": {"status": "pending"}})
        with self.assertRaises(pipeline.PipelineError):
            pipeline.ready_set(self.state, self.logdir, 1)

    def test_stray_unknown_ref_in_brief_refuses(self):
        # validate_doc never reads brief BODIES, so a stray ref surfaces at
        # prepare -- refuse the dispatch, never send a template to an agent.
        self._one_node("do ${ghost.thing}")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.ready_set(self.state, self.logdir, 1)

    def test_escaped_literal_in_brief_passes_through(self):
        self._one_node("cost is $${params.ticket} literally")
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        with open(steps[0]["prompt"]) as fh:
            self.assertIn("cost is ${params.ticket} literally", fh.read())

    def test_outputs_footer_only_when_downstream_consumer_exists(self):
        nodes = [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                 {"id": "b", "type": "agent_task", "brief_ref": "b.md"}]
        edges = [{"from": "a", "to": "b", "on": "success"}]
        self._write(self._doc(nodes, edges),
                    {"a.md": "pick", "b.md": "on ${nodes.a.output.branch}"})
        steps = pipeline.ready_set(self.state, self.logdir, 1)   # node a
        with open(steps[0]["prompt"]) as fh:
            text = fh.read()
        self.assertIn("pipeline:outputs", text)
        self.assertIn(".pipeline-run-t1.a.outputs.json", text)

    def test_no_footer_without_consumer(self):
        self._one_node("plain work")
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        with open(steps[0]["prompt"]) as fh:
            self.assertNotIn("pipeline:outputs", fh.read())
```

  Also UPDATE `ParamsOutputsValidationTest.
  test_reference_in_field_still_refused_in_phase_a`: rename to
  `test_reference_in_activity_field_now_accepted`, assert `validate_doc`
  returns `[]` for the `${params.coder_agent}` doc **when the param is
  declared**, non-empty when it is not. Keep the `"bad agent!"` concrete
  refusal assertion — concrete garbage still refuses.

- [ ] **Step 2: Run, see fail.**

- [ ] **Step 3: Implement** — all in one commit:

  **(a) Validator flip.** In `validate_doc` (`:752-753`) replace:

```python
    _validate_params_outputs(doc, errors)
    _refuse_refs_in_activity_fields(doc, errors)
```

  with:

```python
    _validate_params_outputs(doc, errors)
    # Phase B: substitution IS wired into prepare now, so ${...} in activity
    # fields is validated statically (check_refs) instead of refused
    # wholesale. The Phase A gate (_refuse_refs_in_activity_fields) is
    # DELETED in this same commit -- a validating doc is still a runnable
    # doc, the honesty invariant just moved from "refuse" to "check".
    check_refs(doc, errors)
```

  DELETE `_refuse_refs_in_activity_fields` entirely (`:697-720`).

  **(b) `_validate_runs_as` `${}`-aware.** A field that CONTAINS `${` after
  un-escaping defers its concrete check to prepare time:

```python
def _has_ref(v):
    return isinstance(v, str) and "${" in v.replace("$${", "")


def _validate_runs_as(where, runs_as, errors):
    if runs_as is None:
        return
    if not isinstance(runs_as, dict):
        errors.append("%s: runs_as must be a mapping" % where)
        return
    for key in runs_as:
        if key not in ("model", "effort", "account", "agent"):
            errors.append("%s: runs_as.%s is not a known field" % (where, key))
    # A ${...}-bearing field defers to the POST-SUBSTITUTION concrete check
    # in _prepare_step (refuse-not-drop) -- check_refs has already validated
    # the reference statically. A ref-free field keeps the P1 checks.
    if "model" in runs_as and not _has_ref(runs_as["model"]) \
            and not _is_str(runs_as["model"]):
        errors.append("%s: runs_as.model must be a non-empty string" % where)
    if "account" in runs_as and not _has_ref(runs_as["account"]) \
            and not (_is_str(runs_as["account"])
                     and _NAME_RE.match(runs_as["account"])):
        errors.append("%s: runs_as.account must be an account name "
                      "(charset [A-Za-z0-9._-]{1,64})" % where)
    if "effort" in runs_as and not _has_ref(runs_as["effort"]) \
            and runs_as["effort"] not in VALID_EFFORTS:
        errors.append("%s: runs_as.effort %r invalid (valid: %s)"
                      % (where, runs_as.get("effort"), ", ".join(VALID_EFFORTS)))
    if "agent" in runs_as and not _has_ref(runs_as["agent"]) \
            and not (_is_str(runs_as["agent"])
                     and _AGENT_RE.match(runs_as["agent"])):
        errors.append("%s: runs_as.agent has invalid chars" % where)
```

  **(c) Outputs sidecars + footer** (beside `_verdict_rel` `:1364`):

```python
def _node_outputs_rel(state_path, node_id):
    """Per-NODE outputs sidecar, derived exactly like the verdict file --
    one naming rule both sides, lane/slot-safe for free."""
    base = os.path.basename(state_path)
    if base.endswith(".json"):
        base = base[:-len(".json")]
    return "var/autonomy-logs/%s.%s.outputs.json" % (base, node_id)


def _collect_node_outputs(state_path, state):
    """{node_id: {name: value}} for every recorded-successful node, read
    TOTALLY from the sidecars (read_outputs: missing/corrupt -> {}). A node
    that wrote nothing simply has no entry -- a ref to it refuses at
    substitute time with the Phase A 'unknown node output' error."""
    logdir = os.path.dirname(state_path)
    out = {}
    for entry in state.get("nodes_done", []):
        if entry.get("outcome") != "success":
            continue
        nid = entry.get("id")
        rel = _node_outputs_rel(state_path, nid)
        vals = read_outputs(os.path.join(logdir, os.path.basename(rel)))
        if vals:
            out[nid] = vals
    return out


_OUTPUTS_FOOTER = """<!-- pipeline:outputs -->
A later activity reads this activity's named outputs. Before you finish,
write a JSON object of them to %(outputs_file)s (relative to the repo
root), e.g. {"branch": "feat/x-123"}. Downstream references
(${nodes.%(node_id)s.output.<name>}) refuse to run if the name they need
is missing -- write every output you produced."""
```

  **(d) Substitution in `_prepare_step`** (`:1521`) — replace the body with:

```python
def _substitution_ctx(state_path, state):
    return {"params": state.get("params") or {},
            "nodes": _collect_node_outputs(state_path, state),
            "run": state.get("run") or {}}


def _concrete_runs_as_check(node_id, runs_as):
    """The SAME concrete gates _validate_runs_as applies to ref-free fields,
    re-run on POST-substitution values. REFUSES (raises) -- never the
    wrap_role warn-and-drop: dropping a trigger's chosen model would
    silently change what the operator parameterised (prevention-log #3/#15;
    the supervisor's bash-side re-validation stays as defense in depth,
    prevention-log #6)."""
    errs = []
    _validate_runs_as("node %r (resolved)" % node_id, runs_as, errs)
    for k, v in (runs_as or {}).items():
        if _has_ref(v):
            errs.append("node %r: runs_as.%s still carries ${ after "
                        "substitution" % (node_id, k))
    if errs:
        raise PipelineError("; ".join(errs))


def _prepare_step(state_path, state, uid, brief_path):
    doc = state["doc"]
    node = _node_by_id(doc, _expected_node(doc, state, uid))
    verdict_rel = _verdict_rel(state_path, node["id"])
    ctx = _substitution_ctx(state_path, state)
    # Resolve the node's OWN ${...} fields (runs_as etc.) before anything
    # derived from them is emitted. substitute_doc deep-copies; the stored
    # doc keeps its template form so a later bounce re-resolves fresh.
    resolved_node = substitute_doc(node, ctx)
    if node.get("legacy_prompt"):
        kind, prompt = "legacy", node["legacy_prompt"]
    else:
        pdir = (state.get("meta") or {}).get("pipeline_dir")
        verdict_ctx = None
        if _con_by_id(doc, uid) is None and any(
                e.get("from") == uid and e.get("on") == "failure"
                for e in doc.get("edges", [])):
            verdict_ctx = {"verdict_file": verdict_rel}
        text = compile_brief(pdir, doc, node["id"],
                             _loop_ctx(state, node, state_path),
                             verdict_ctx=verdict_ctx)
        # Downstream consumers of THIS node's outputs? Tell the agent where
        # to write them (same contract as the verdict footer).
        consumers = "${nodes.%s.output." % node["id"]
        if consumers in json.dumps(doc) or _doc_briefs_reference(
                pdir, doc, consumers):
            text += "\n\n" + _OUTPUTS_FOOTER % {
                "outputs_file": _node_outputs_rel(state_path, node["id"]),
                "node_id": node["id"]}
        # Brief TEXT substitution: string interpolation over the composed
        # brief (body + footers). A stray unknown ref RAISES here -- refuse
        # the dispatch, never send a template to an agent. Prose ${ must be
        # escaped $${ (documented in docs/pipelines.md).
        text = substitute(text, ctx)
        with open(brief_path, "w") as fh:
            fh.write(text)
        kind, prompt = "compiled", brief_path
    merged = dict(_effective_runs_as(doc, node))
    merged.update(resolved_node.get("runs_as") or {})
    merged = {k: substitute(v, ctx) for k, v in merged.items()}
    _concrete_runs_as_check(node["id"], merged)
    return {"status": "node", "unit": uid, "node": node["id"], "kind": kind,
            "prompt": prompt, "verdict": verdict_rel, "runs_as": merged}


def _doc_briefs_reference(pdir, doc, needle):
    """True when any sibling brief file mentions `needle` -- total reader
    (an unreadable brief refuses later at ITS compile; here absence of
    evidence just means no footer)."""
    if not pdir:
        return False
    for n in doc.get("nodes", []):
        ref = n.get("brief_ref")
        if not ref:
            continue
        try:
            with open(os.path.join(pdir, ref)) as fh:
                if needle in fh.read():
                    return True
        except OSError:
            continue
    return False
```

  **Ordering constraint (do not reorder):** the refusal path
  (`_concrete_runs_as_check`, an unresolvable brief ref) must fire BEFORE
  `_pick` marks the unit `dispatched` and writes state. `_pick` calls
  `_prepare_step` before flipping the status (`:1577-1580`) — keep it that
  way; a substitution refusal propagates as `PipelineError` out of
  `ready`/`next` with the state UNTOUCHED.

- [ ] **Step 4: Run, see pass, FULL suite** — every Phase A test, every walk
  test, and the new classes. Expected churn: only the renamed Phase A
  honesty test.

- [ ] **Step 5: Commit** (one commit — the flip and the wiring together):

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#<ISSUE>): wire \${} substitution into prepare + flip validator to accept refs in activity fields (same change -- a validating doc stays a runnable doc); \${} in effort; outputs sidecars + footer"
```

---

### Task 6: trigger-started runs — `start_run_trigger`, existence checks, the secrets boundary

**Files:**
- Modify: `lib/pipeline.py` (`resolve_pipeline` `:1060` refactor,
  `start_run` `:1148` sibling, `resolve_params` `:512` message audit,
  `_journal_append` `:1409`, CLI `start` `:1777`)
- Test: `tests/test_pipeline.py`

**Interfaces:**
- Consumes: `triggers.load_trigger` (Task 1), `resolve_params` (Phase A),
  `check_refs` via `validate_doc` (Task 5).
- Produces: `resolve_pipeline_doc(repo, name)`, `start_run_trigger(repo,
  trigger_name, state_path, lane="", *, known_repos=None,
  known_accounts=None, secret_lookup=None)`, state keys
  `trigger`/`params`/`run`/`kind`, journal field `trigger`, CLI
  `start --kind shim|native`.

**Semantics to lock:**
- `resolve_pipeline_doc(repo, name)` = the existing bound-name body of
  `resolve_pipeline` (`:1085-1104`) extracted verbatim;
  `resolve_pipeline(repo, role)` now calls it for the bound branch — role
  path byte-identical (parity invariant 7).
- `start_run_trigger`: `load_trigger` → `resolve_pipeline_doc(repo,
  trig["pipeline"])` (a shim with `pipeline: ""` NEVER reaches this
  function — shims start through `start_run(repo, role)`; assert and
  refuse) → `resolve_params(doc.get("params") or [], trig["params"], …)` —
  **required-unset refuses HERE, before any session is burned** — →
  existence checks → state.
- **Existence checks at dispatch (spec §11):** after `resolve_params`, every
  resolved value whose declared type is `repo` must be a **registered
  checkout** (the control-unit registry `~/.config/autonomy/repos`, one
  absolute path per line — `bin/control.sh:ctl_registry_file`); every
  `account`-typed value must be a name in the accounts index
  (`lib/accounts.py` `Registry(...).list()`). Injectable seams
  (`known_repos`, `known_accounts` — callables returning a set) default to
  real readers; **an unreadable registry/index REFUSES a run that uses that
  type** (can't verify = don't run; fail-safe), while a run with no
  repo/account params never touches them.
- **Secrets end-to-end refusal:** `check_refs` already refuses
  `${params.<secret>}` (Task 4). Here: any secret-typed param that WOULD
  RESOLVE — a trigger-supplied value OR a pipeline-saved default (Codex
  CP1: a default flows through `secret_lookup` into `state["params"]` on
  disk) — refuses the run ("no dispatch sink until Phase C"; accepting-and-
  ignoring would be prevention-log #3's fail-open). `start_run_trigger`
  deliberately has NO `secret_lookup` seam. A declared-but-valueless
  secret param is inert. Combined with the message audit below, **no
  secret value can enter the Phase B dataflow at all — that is the
  log-redaction boundary Phase A deferred, enforced by construction.**
  Say exactly this in the PR.
- **Message audit (the redaction belt):** `resolve_params`/`_coerce` error
  strings embed `%r` of the VALUE (`"param %r: %r is not a number"`). For a
  secret-typed param the value must NEVER appear in an exception (they flow
  to supervisor.log via stderr). Add a `typ == "secret"` early path in the
  loop so no secret value reaches `_coerce`'s messages, and a regression
  test asserting the exception text for a failing secret param contains the
  NAME but not the VALUE.
- State additions: `"trigger": <name>`, `"kind": "native"`, `"params":
  <resolved non-secret map>`, `"run": {"id": run_id, "pipeline": doc name,
  "trigger": name, "repo": repo}`. The shim path (`start_run`) sets
  `"trigger": role`, `"kind": "shim"`, `"params": {}`, and the same `run`
  dict — ONE state shape (walk code never branches on kind).
- Journal: `_journal_append` writes the new `trigger` field from state
  (additive); `ledger()` unchanged (trust argument).
- CLI: `start <repo> <name> <state> [--lane <l>] [--kind shim|native]` —
  default `shim` calls `start_run` (every existing caller/test unchanged);
  `native` calls `start_run_trigger`.

- [ ] **Step 1: Write the failing tests** — append to `tests/test_pipeline.py`:

```python
class StartRunTriggerTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.pdir = os.path.join(self.repo, ".autonomy", "pipelines", "flow")
        self.tdir = os.path.join(self.repo, ".autonomy", "triggers")
        self.logdir = os.path.join(self.repo, "var", "autonomy-logs")
        for d in (self.pdir, self.tdir, self.logdir):
            os.makedirs(d)
        self.state = os.path.join(self.logdir, ".pipeline-run-t1.json")
        doc = {"name": "flow", "version": 1,
               "params": [
                   {"name": "repo", "type": "repo", "required": True},
                   {"name": "m", "type": "model",
                    "default": "claude-sonnet-5"},
                   {"name": "tok", "type": "secret"}],
               "caps": {"max_sessions_per_run": 4},
               "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"}],
               "edges": []}
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(self.pdir, "a.md"), "w") as fh:
            fh.write("pick work in ${params.repo}")

    def _trigger(self, **params):
        t = {"name": "t1", "pipeline": "flow",
             "params": dict({"repo": "/reg/checkout"}, **params),
             "firing": {"mode": "continuous"}}
        with open(os.path.join(self.tdir, "t1.json"), "w") as fh:
            json.dump(t, fh)

    def _start(self, **kw):
        kw.setdefault("known_repos", lambda: {"/reg/checkout"})
        kw.setdefault("known_accounts", lambda: {"acct-a"})
        return pipeline.start_run_trigger(self.repo, "t1", self.state, **kw)

    def test_start_resolves_params_into_state(self):
        self._trigger()
        st = self._start()
        self.assertEqual(st["trigger"], "t1")
        self.assertEqual(st["kind"], "native")
        self.assertEqual(st["params"]["m"], "claude-sonnet-5")
        self.assertEqual(st["run"]["pipeline"], "flow")
        self.assertEqual(st["run"]["trigger"], "t1")
        self.assertEqual(st["run"]["repo"], self.repo)

    def test_required_unset_refuses_before_any_state_write(self):
        t = {"name": "t1", "pipeline": "flow", "params": {},
             "firing": {"mode": "continuous"}}
        with open(os.path.join(self.tdir, "t1.json"), "w") as fh:
            json.dump(t, fh)
        with self.assertRaises(pipeline.PipelineError):
            self._start()
        self.assertFalse(os.path.exists(self.state))

    def test_unregistered_repo_param_refuses(self):
        self._trigger()
        with self.assertRaises(pipeline.PipelineError):
            self._start(known_repos=lambda: {"/other"})

    def test_unreadable_registry_refuses_runs_that_use_repo_type(self):
        self._trigger()
        def broken():
            raise OSError("no registry")
        with self.assertRaises(pipeline.PipelineError):
            self._start(known_repos=broken)

    def test_unknown_account_param_refuses(self):
        # swap the doc's param decl to account-typed via a fresh pipeline
        doc = json.load(open(os.path.join(self.pdir, "pipeline.json")))
        doc["params"] = [{"name": "acct", "type": "account",
                          "required": True}]
        json.dump(doc, open(os.path.join(self.pdir, "pipeline.json"), "w"))
        with open(os.path.join(self.pdir, "a.md"), "w") as fh:
            fh.write("no refs")
        t = {"name": "t1", "pipeline": "flow",
             "params": {"acct": "ghost"},
             "firing": {"mode": "continuous"}}
        with open(os.path.join(self.tdir, "t1.json"), "w") as fh:
            json.dump(t, fh)
        with self.assertRaises(pipeline.PipelineError):
            self._start()

    def test_secret_value_supplied_refuses_and_never_echoes_value(self):
        self._trigger(tok="hunter2-value")
        with self.assertRaises(pipeline.PipelineError) as cm:
            self._start()
        self.assertNotIn("hunter2-value", str(cm.exception))
        self.assertIn("tok", str(cm.exception))

    def test_secret_with_pipeline_default_refuses_too(self):
        # Codex CP1: a saved default would resolve through secret_lookup
        # into state['params'] on disk -- the same refusal must cover it.
        doc = json.load(open(os.path.join(self.pdir, "pipeline.json")))
        doc["params"] = [p if p["name"] != "tok" else
                         {"name": "tok", "type": "secret", "default": "KEY"}
                         for p in doc["params"]]
        json.dump(doc, open(os.path.join(self.pdir, "pipeline.json"), "w"))
        self._trigger()
        with self.assertRaises(pipeline.PipelineError) as cm:
            self._start()
        self.assertIn("tok", str(cm.exception))

    def test_declared_valueless_secret_is_inert(self):
        self._trigger()          # 'tok' declared, no default, no value
        st = self._start()
        self.assertNotIn("tok", st["params"])

    def test_missing_pipeline_refuses(self):
        t = {"name": "t1", "pipeline": "ghost", "params": {},
             "firing": {"mode": "continuous"}}
        with open(os.path.join(self.tdir, "t1.json"), "w") as fh:
            json.dump(t, fh)
        with self.assertRaises(pipeline.PipelineError):
            self._start()

    def test_shim_state_shape_matches(self):
        # start_run gains trigger/kind/params/run too -- ONE state shape.
        os.makedirs(os.path.join(self.repo, ".autonomy"), exist_ok=True)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n")
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"),
                  "w") as fh:
            fh.write("loop")
        st = pipeline.start_run(self.repo, "coder",
                                os.path.join(self.logdir,
                                             ".pipeline-run-coder.json"))
        self.assertEqual(st["trigger"], "coder")
        self.assertEqual(st["kind"], "shim")
        self.assertEqual(st["params"], {})
        self.assertEqual(st["run"]["trigger"], "coder")
```

  Plus a `SecretMessageAuditTest`: `resolve_params` with a secret param and
  a failing condition asserts the value never appears in the raised text.
  Plus a `JournalTriggerFieldTest`: drive one run to `_finish` (existing
  fixture pattern) and assert the journal line carries `"trigger"`.

- [ ] **Step 2: Run, see fail.**

- [ ] **Step 3: Implement.**

  **(a) Extract `resolve_pipeline_doc`** — move `:1085-1104`'s bound-name
  body into:

```python
def resolve_pipeline_doc(repo, name):
    """By-NAME pipeline resolution (trigger-started runs). Shadow-aware
    (SD-34/SD-37), validates, checks legacy prompts. Raises on anything
    broken -- fail-safe, never a fallback."""
    if not valid_pipeline_name(name):
        raise PipelineError("pipeline name %r has invalid charset" % (name,))
    pdir = effective_pipeline_dir(repo, name)
    doc = load_doc(os.path.join(pdir, "pipeline.json"))
    errs = validate_doc(doc, pdir)
    if errs:
        raise PipelineError("pipeline %r invalid: %s"
                            % (name, "; ".join(errs)))
    _check_legacy_prompts(repo, doc, "pipeline %r" % name)
    return doc, {"pipeline_dir": pdir, "wrapped": False,
                 "from": name, "from_version": doc.get("version", 0)}
```

  `resolve_pipeline(repo, role)`'s bound branch becomes
  `return resolve_pipeline_doc(repo, binding)` — diff-check the branch is
  byte-equivalent in behaviour.

  **(b) Registry/index readers + existence check:**

```python
def _registered_repos():
    """The control-unit registry (bin/control.sh, one absolute path per
    line). Raises OSError when unreadable -- the CALLER decides whether the
    run needed it (a run with no repo-typed params never asks)."""
    path = os.path.expanduser("~/.config/autonomy/repos")
    with open(path, encoding="utf-8") as fh:
        return set(ln.strip() for ln in fh if ln.strip())


def _known_accounts():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import accounts
    # Registry.list() returns dict ROWS (lib/accounts.py:384) -- set() over
    # them raises TypeError (Codex CP1). Project NAMES totally: drop any
    # row that isn't readable as one (prevention-log #12); verify the exact
    # row shape against the accounts tests before committing.
    out = set()
    for row in accounts.Registry().list():
        name = row.get("name") if isinstance(row, dict) else row
        if isinstance(name, str) and name:
            out.add(name)
    return out


def check_param_existence(declared, resolved, *, known_repos, known_accounts):
    """repo/account-typed params must name REGISTERED entities (spec S11:
    'selects among engine-registered checkouts, validated -- never an
    arbitrary path'). Reader failure REFUSES a run that uses the type
    (can't verify = don't run); types not used never read the registry."""
    types = {p["name"]: p.get("type") for p in declared
             if isinstance(p, dict) and _is_str(p.get("name"))}
    for name, value in resolved.items():
        typ = types.get(name)
        if typ == "repo":
            try:
                reg = known_repos()
            except Exception as exc:
                raise PipelineError("param %r: cannot read the repo "
                                    "registry (%s) -- refusing" % (name, exc))
            if value not in reg:
                raise PipelineError("param %r: %r is not a registered "
                                    "checkout" % (name, value))
        elif typ == "account":
            try:
                known = known_accounts()
            except Exception as exc:
                raise PipelineError("param %r: cannot read the accounts "
                                    "index (%s) -- refusing" % (name, exc))
            if value not in known:
                raise PipelineError("param %r: %r is not a known account"
                                    % (name, value))
```

  **(c) `start_run_trigger`:**

```python
def start_run_trigger(repo, trigger_name, state_path, lane="", *,
                      known_repos=None, known_accounts=None):
    """Start a run for a NATIVE trigger: load+validate the trigger, resolve
    the pipeline BY NAME, resolve params (required-unset refuses HERE,
    before a session is burned), run the repo/account existence checks,
    write fmt-2 state. Secrets: Phase B refuses any secret param that
    would RESOLVE -- trigger-supplied OR pipeline default (no dispatch
    sink exists; check_refs already refuses secret REFS at validate time)
    -- so no secret value can enter this dataflow, which IS the Phase
    A-deferred log-redaction boundary, by construction."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import triggers as triggers_mod
    trig = triggers_mod.load_trigger(repo, trigger_name)
    doc, meta = resolve_pipeline_doc(repo, trig["pipeline"])
    declared = doc.get("params") or []
    # A secret param that WOULD RESOLVE -- supplied by the trigger OR
    # carrying a pipeline-saved default -- is refused outright (Codex CP1:
    # a default would flow through secret_lookup into state['params'] on
    # disk). Declared-but-valueless secrets are inert. Phase B therefore
    # never passes a secret_lookup at all: no secret value can enter this
    # dataflow, which IS the Phase A-deferred redaction boundary.
    resolving_secrets = sorted(
        p["name"] for p in declared
        if isinstance(p, dict) and p.get("type") == "secret"
        and ("default" in p or p.get("name") in trig["params"]))
    if resolving_secrets:
        raise PipelineError(
            "secret param(s) %s would resolve (trigger value or pipeline "
            "default) but Phase B has no dispatch sink for secrets (env "
            "channel lands in Phase C) -- refusing rather than "
            "accept-and-ignore" % ", ".join(resolving_secrets))
    params = resolve_params(declared, trig["params"], secret_lookup=None)
    check_param_existence(
        declared, params,
        known_repos=known_repos or _registered_repos,
        known_accounts=known_accounts or _known_accounts)
    doc = dict(doc)
    doc["edges"] = effective_edges(doc)
    ident = "%s--%s" % (trigger_name, lane) if lane else trigger_name
    run_id = "%s-%s-%d" % (ident, time.strftime("%Y%m%dT%H%M%S"),
                           os.getpid())
    state = {"fmt": 2, "run_id": run_id,
             "role": trigger_name, "lane": lane, "doc": doc, "meta": meta,
             "trigger": trigger_name, "kind": "native", "params": params,
             "run": {"id": run_id, "pipeline": doc["name"],
                     "trigger": trigger_name, "repo": repo},
             "started": int(time.time()), "sessions": 0,
             "units": dict((u, {"status": "pending"}) for u in _top_units(doc)),
             "container_pos": {}, "rounds": {}, "bounces": {},
             "nodes_done": [], "status": "in_progress"}
    _atomic_write_json(state_path, state)
    return state
```

  (`"role": trigger_name` keeps every existing state consumer — journal,
  dashboard state-file glob, ledger — working without a branch; Phase E
  renames the key when trust re-keys.)

  **(d) `start_run` (shim) additions** — inside `:1159-1166` add the same
  four keys: `"trigger": role`, `"kind": "shim"`, `"params": {}`,
  `"run": {"id": <run_id>, "pipeline": doc["name"], "trigger": role,
  "repo": repo}` (build `run_id` before the dict as `start_run_trigger`
  does).

  **(e) `resolve_params` secret message audit** — in the loop (`:707-726`),
  move the `typ == "secret"` branch BEFORE any `_coerce` call and make every
  raise in that branch name-only (they already are; add the regression
  test). In `_coerce`, no change — secrets never reach it after (e).

  **(f) `_journal_append`** — add `"trigger": state.get("trigger", "")` to
  the run line it writes (inspect the function at `:1409` and add the field
  beside `role`).

  **(g) CLI** — in `main`'s `start` branch (`:1777`):

```python
    if cmd == "start":
        # start <repo> <name> <state-file> [--lane <l>] [--kind shim|native]
        opts = {"--lane": "", "--kind": "shim"}
        pos = _split_opts(rest, opts)
        if opts["--kind"] not in ("shim", "native"):
            print("pipeline start: --kind must be shim|native",
                  file=sys.stderr)
            return 2
        try:
            if opts["--kind"] == "native":
                state = start_run_trigger(pos[0], pos[1], pos[2],
                                          lane=opts["--lane"])
            else:
                state = start_run(pos[0], pos[1], pos[2],
                                  lane=opts["--lane"])
        except (IndexError, PipelineError) as exc:
            print("pipeline start: %s" % exc, file=sys.stderr)
            return 1
        print("RUN=%s" % state["run_id"])
        return 0
```

- [ ] **Step 4: Run, see pass, FULL python suite green.**

- [ ] **Step 5: Commit** `feat(#<ISSUE>): start_run_trigger -- native
  trigger runs (params at start, repo/account existence checks, secrets
  refused end-to-end = the redaction boundary by construction); journal
  gains additive trigger field`.

---

### Task 7: supervisor — trigger enumeration + kind-split dispatch, BEHIND the old path

**Files:**
- Modify: `bin/supervisor.sh`
- Test: `tests/test_supervisor.sh`

**Interfaces:**
- Consumes: `triggers.py dispatch/cron/show` (Task 3), `pipeline.py start
  --kind` (Task 6).
- Produces: `_triggers_enumerate`, `resolve_dispatch_triggers`,
  `trigger_kind_of`, token helpers (`token_name`/`token_slot`),
  slot-aware `pipeline_state_file`, `inflight_tokens`, kind-split
  `run_session` — consumed by Task 8 (firing/concurrency) and Task 9
  (cutover). **The main loop is NOT edited in this task** — everything is
  new functions + an extended `run_session` whose default arguments keep
  today's call sites byte-compatible.

- [ ] **Step 1: Write the failing tests** — append to
  `tests/test_supervisor.sh` (source-the-real-script pattern the file
  already uses):

```bash
# --- Phase B: trigger dispatch plumbing (built behind the old path) ---------
# token helpers: 'name' and 'name@slot' split cleanly; bad tokens refuse
check "token_name plain"        "coder"   "$(token_name 'coder')"
check "token_name slotted"      "qa"      "$(token_name 'qa@2')"
check "token_slot plain is 0"   "0"       "$(token_slot 'coder')"
check "token_slot slotted"      "2"       "$(token_slot 'qa@2')"
check "token bad charset rc"    "1"       "$(token_name 'x;y' >/dev/null 2>&1; echo $?)"

# pipeline_state_file: slot 0 keeps the LEGACY filename (parity invariant 2)
AUTONOMY_LANE="" LOGDIR="/tmp/ll"
check "state file slot0 legacy" "/tmp/ll/.pipeline-run-coder.json" \
  "$(pipeline_state_file coder 0)"
check "state file slot2"        "/tmp/ll/.pipeline-run-coder@2.json" \
  "$(pipeline_state_file coder 2)"
AUTONOMY_LANE="qa"
check "state file lane+slot"    "/tmp/ll/.pipeline-run-coder--qa@2.json" \
  "$(pipeline_state_file coder 2)"
AUTONOMY_LANE=""

# inflight_tokens: emits slot-aware tokens, charset-gates disk input
mkdir -p /tmp/ll && : > /tmp/ll/.pipeline-run-coder.json \
  && : > /tmp/ll/.pipeline-run-qa@1.json \
  && : > "/tmp/ll/.pipeline-run-ev;l.json"
out="$(inflight_tokens | sort | tr '\n' ' ')"
check "inflight tokens"         "coder qa@1 " "$out"

# resolve_dispatch_triggers goes through the _triggers_enumerate seam
_triggers_enumerate() { printf 'coder\tshim\tskip\t1\nqa-x\tnative\tparallel\t2\n'; }
out="$(resolve_dispatch_triggers | tr '\n' ' ')"
check "dispatch trigger names"  "coder qa-x " "$out"
check "trigger_kind_of shim"    "shim"    "$(trigger_kind_of coder)"
check "trigger_kind_of native"  "native"  "$(trigger_kind_of qa-x)"
check "trigger_policy_of"       "parallel" "$(trigger_policy_of qa-x)"
check "trigger_max_of"          "2"        "$(trigger_max_of qa-x)"
unset -f _triggers_enumerate
```

  (Adjust helper names/paths to the file's actual harness conventions —
  `check` is the established assert; keep the here-string / no-pipeline
  disciplines, prevention-log #7/#11.)

- [ ] **Step 2: Run, see fail** — `bash tests/test_supervisor.sh` → the new
  checks fail (functions undefined).

- [ ] **Step 3: Implement** — add a new section after `resolve_dispatch_roles`
  (`:814`):

```bash
# --- trigger dispatch (pipeline+trigger model Phase B) ------------------------
# The supervisor enumerates TRIGGERS (native .autonomy/triggers/*.json files
# + auto-shimmed roles) instead of roles. Built BEHIND the role path: these
# functions exist alongside resolve_dispatch_roles and the main loop swaps
# over only in the cutover commit, after the parity tests pass.
#
# Dispatch tokens are 'name' (run slot 0 -- filename identical to the legacy
# per-role state file, so pre-cutover in-flight runs resume) or 'name@<slot>'
# (parallel policy, slots 1..max-1). '@' is outside the name charset, so the
# split is unambiguous; every token from disk or enumeration is charset-gated
# before it reaches a filename or argv (prevention-log #6).
token_name() {
  local t="$1" n="${1%%@*}"
  case "$n" in *[!A-Za-z0-9._-]*|"") return 1 ;; esac
  case "$t" in
    "$n") ;;
    "$n"@*) case "${t#"$n"@}" in *[!0-9]*|"") return 1 ;; esac ;;
    *) return 1 ;;
  esac
  printf '%s' "$n"
}

token_slot() {
  local t="$1"
  case "$t" in
    *@*) printf '%s' "${t##*@}" ;;
    *)   printf '0' ;;
  esac
}

_triggers_enumerate() {
  if [ -n "${AUTONOMY_LANE:-}" ]; then
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" --lane "$AUTONOMY_LANE" 2>>"$SUPLOG"
  else
    python3 "$ENGINE_HOME/lib/triggers.py" "$@" 2>>"$SUPLOG"
  fi
}

# TRIG_* parallel arrays (bash 3.2), refreshed each tick by
# resolve_dispatch_triggers: names + kind/policy/max per index.
resolve_dispatch_triggers() {
  local out line name kind policy max i=0
  TRIG_NAME=(); TRIG_KIND=(); TRIG_POLICY=(); TRIG_MAX=()
  out="$(_triggers_enumerate dispatch "$AUTONOMY_TARGET_REPO")" || return 1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="${line%%	*}"; line="${line#*	}"
    kind="${line%%	*}"; line="${line#*	}"
    policy="${line%%	*}"; max="${line#*	}"
    case "$name" in *[!A-Za-z0-9._-]*|"") continue ;; esac
    case "$kind" in shim|native) ;; *) continue ;; esac
    case "$policy" in queue|skip|parallel) ;; *) continue ;; esac
    case "$max" in *[!0-9]*|"") continue ;; esac
    TRIG_NAME[i]="$name"; TRIG_KIND[i]="$kind"
    TRIG_POLICY[i]="$policy"; TRIG_MAX[i]="$max"
    printf '%s\n' "$name"
    i=$((i + 1))
  done <<<"$out"
}

trigger_kind_of()   { _trig_field_of "$1" KIND; }
trigger_policy_of() { _trig_field_of "$1" POLICY; }
trigger_max_of()    { _trig_field_of "$1" MAX; }

_trig_field_of() {
  local name="$1" field="$2" i=0
  while [ "$i" -lt "${#TRIG_NAME[@]}" ]; do
    if [ "${TRIG_NAME[i]}" = "$name" ]; then
      case "$field" in
        KIND)   printf '%s' "${TRIG_KIND[i]}" ;;
        POLICY) printf '%s' "${TRIG_POLICY[i]}" ;;
        MAX)    printf '%s' "${TRIG_MAX[i]}" ;;
      esac
      return 0
    fi
    i=$((i + 1))
  done
  # Not in this tick's enumeration: an in-flight token for a trigger that
  # was disabled/removed mid-run. Advance-only defaults -- kind falls back
  # to shim ONLY for state files that predate the cutover; refusing here
  # would strand a live run (Task 9 pins this with a test).
  case "$field" in KIND) printf 'shim' ;; POLICY) printf 'skip' ;; MAX) printf '1' ;; esac
}
```

  Extend `pipeline_state_file` (`:1125`) with an optional slot:

```bash
pipeline_state_file() {
  local role="$1" slot="${2:-0}" lane="${AUTONOMY_LANE:-}" suffix=""
  [ "$slot" != "0" ] && suffix="@$slot"
  if [ -n "$lane" ]; then
    printf '%s/.pipeline-run-%s--%s%s.json' "$LOGDIR" "$role" "$lane" "$suffix"
  else
    printf '%s/.pipeline-run-%s%s.json' "$LOGDIR" "$role" "$suffix"
  fi
}
```

  Add `inflight_tokens` beside `inflight_roles` (`:1161`) — same body, with
  the parse order PINNED (Codex CP1): the state basename is
  `<name>[--<lane>][@<slot>]`, so strip the `@<digits>` SLOT suffix FIRST,
  then apply the existing `--$lane` suffix strip, then charset-gate the
  remaining name; print `name` or `name@<slot>`. (The old order — lane
  first — never matches `--qa@2` and silently ignores a lane's slotted
  in-flight run.) Concretely, before the existing lane `case`:

```bash
    slot=""
    case "$base" in
      *@*)
        slot="${base##*@}"
        case "$slot" in *[!0-9]*|"") log "WARN pipeline: ignoring state file with invalid slot: $f"; continue ;; esac
        base="${base%@*}" ;;
    esac
    # ...existing lane strip + charset gate on $base...
    if [ -n "$slot" ]; then printf '%s@%s\n' "$base" "$slot"; else printf '%s\n' "$base"; fi
```

  Add a lane+slot test: `AUTONOMY_LANE=qa` with
  `.pipeline-run-coder--qa@2.json` on disk → `inflight_tokens` emits
  `coder@2`; with no lane set the same file is ANOTHER supervisor's
  business (not emitted). `inflight_roles` stays until the Task 9 cutover
  deletes it (shellcheck: it still has callers until then).

  Extend `resolve_pipeline_ready` (`:1189`) signature to
  `resolve_pipeline_ready <name> <max> [<slot>] [<kind>]` — `state="$(
  pipeline_state_file "$role" "$slot")"` and the `start` invocation gains
  `--kind "$kind"` (default `shim`). Existing callers pass two args →
  byte-identical behaviour.

  Extend `run_session` (`:1417`) to `run_session <token> [<kind>]`:

```bash
run_session() {
  local token="${1:-${ROLE:-coder}}" kind="${2:-shim}" role slot
  role="$(token_name "$token")" || { log "dispatch: bad token '$token' -- REFUSING"; return 2; }
  slot="$(token_slot "$token")"
  preflight || return $?
  materialize_planner

  if [ "$kind" = "shim" ]; then
    if ! resolve_role_dispatch "$role"; then
      log "dispatch: cannot resolve settings for role '$role' -- REFUSING session (fail-safe; see supervisor.log)"
      return 2
    fi
  else
    # NATIVE trigger: roles are dissolved -- no role settings, no scope
    # directive. Model/effort/account/agent come from the pipeline's own
    # (substituted) runs_as via the ready blocks; the rules file is the
    # pack's hard_rules alone (compose_session_rules passes it through
    # verbatim when the scope line is empty). This is configured behaviour
    # for a NEW surface, not a silent widening of an existing one.
    ROLE_PROMPT=""; ROLE_SCOPE=""; ROLE_MODEL=""; ROLE_EFFORT=""
    ROLE_ACCOUNT=""; ROLE_AGENT=""
  fi

  if ! resolve_pipeline_ready "$role" 8 "$slot" "$kind"; then
    ...            # unchanged body from here on, except:
```

  Every use of `"$role"` for STATE/VERDICT derivation inside the body flows
  through the already-updated helpers; the remainder of `run_session`
  (adapter sourcing, auth, `run_single_session`/`dispatch_batch`) is
  UNTOUCHED — diff it to prove parity invariant 7. One exception: guard
  `log_knob_notes "$AUTONOMY_TARGET_REPO" "$role"` (`:1516`) with
  `[ "$kind" = "shim" ] &&` — knob notes are keyed to a `roles:` entry a
  native trigger does not have (a spurious roles.py error in the log every
  tick would be noise, not truth).

- [ ] **Step 4: Run, see pass** — `bash tests/test_supervisor.sh` green,
  `bash tests/run_all.sh` green, `shellcheck -S warning start bin/*.sh
  bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh` clean.

- [ ] **Step 5: Commit** `feat(#<ISSUE>): supervisor trigger plumbing behind
  the role path -- tokens, slot state files, kind-split run_session`.

---

### Task 8: firing modes + per-trigger concurrency & lifecycle markers

**Files:**
- Modify: `bin/supervisor.sh`
- Test: `tests/test_supervisor.sh`

**Interfaces:**
- Consumes: Task 7's plumbing.
- Produces: `trigger_ctl_dir`, `trigger_stopped`, `trigger_backoff_until`,
  `trigger_record_error_backoff`, `trigger_clear_backoff`,
  `trigger_free_slot`, `trigger_inflight_count`, `trigger_start_candidates`,
  `resolve_trigger_cron_due`, `resolve_manual_fires` — consumed by Task 9's
  cutover.

**Marker layout** (all under `$VARDIR/trigger-ctl/`, `VARDIR` set at `:1776`;
every `<name>` charset-gated at read — the supervisor is the SOLE writer of
`queued`/`backoff`, generalising the SD-7 discipline; `fire` and `stop` are
operator-written, supervisor-consumed):

```text
$VARDIR/trigger-ctl/fire/<name>      operator 'run now' for a manual trigger (empty file; consumed at start)
$VARDIR/trigger-ctl/queued/<name>    ONE deferred schedule fire (policy queue at capacity; depth 1 -- a second fire overwrites + WARN)
$VARDIR/trigger-ctl/stop/<name>      per-trigger hard stop: no new fires AND in-flight runs not advanced (state preserved; remove to resume)
$VARDIR/trigger-ctl/backoff/<name>   'next-eligible-epoch<TAB>consecutive-errors' -- per-trigger error backoff
```

**Semantics to lock:**
- **Pause vs stop:** `enabled: false` in the trigger file (or var-shadow) =
  PAUSE — excluded from enumeration → no new fires, but in-flight tokens
  still advance (graceful drain, today's PAUSE-sentinel manner). The `stop/`
  sentinel = HARD STOP — new fires refused AND in-flight tokens filtered out
  of dispatch (run state preserved on disk; removing the sentinel resumes
  mid-run). The FLEET pause sentinel (`:1851`) is untouched and checked
  first.
- **Per-trigger error backoff:** when a session for trigger T ends in the
  error arm (`:2006`), write T's backoff marker (exponential:
  `ERR_BACKOFF_START * 2^(n-1)` capped at `ERR_BACKOFF_MAX`, reusing the
  existing knobs). Enumeration-side, a trigger before its next-eligible
  epoch is skipped for BOTH new fires and advance. Any successful session
  for T clears the marker. The loop-global error sleep at `:2006-2009`
  REMAINS (it paces the loop when every trigger is backing off; with other
  triggers eligible the per-trigger marker is what stops T from monopolising
  retries).
- **Concurrency (start-gating only — advance is never gated by policy):**
  - `skip`: in-flight count ≥ max (always 1) → no new start; log NOTE.
  - `queue` (schedule mode): a cron fire at capacity writes `queued/<name>`
    (overwrite + WARN = depth 1); the main loop starts a queued fire the
    first tick a slot is free, then removes the marker.
  - `parallel`: start in the lowest free slot while count < max. **The
    work-item claim discipline is the pick brief's concern** (assign/label
    at pick time), documented in `templates/autonomy-pack/README.md` in this
    task — the SD-36 precedent (branch races are the briefs' concern),
    never silently absorbed by the engine.
- **Schedule firing** reuses the cron machinery byte-for-byte:
  `resolve_trigger_cron_due` is `resolve_cron_due` (`:859`) with
  `_cron_enumerate` swapped for `_triggers_enumerate cron` (name + schedule
  + kind per line) and `run_session "$name"` swapped for the
  capacity-gated start (`run_session "$(trigger_start_token "$name")"
  "$kind"`); the `$VARDIR/cron/<name>.last_fire` marker convention,
  first-sight-no-fire, and skip+warn missed fires (#188/#231 surface) are
  IDENTICAL. Task 9 swaps the call site; both functions exist during this
  task.
- **Manual firing:** `resolve_manual_fires` scans `fire/` markers; each
  marker whose name maps to an enabled manual trigger (via
  `_triggers_enumerate dispatch`? NO — manual triggers are not in the
  dispatch list; use `triggers.py show` on the marker name and check
  `MODE=manual`) starts a run (capacity-gated like any fire) and removes
  the marker; an unknown/invalid marker name is WARN-removed (a squatting
  bad filename must not wedge the scan — charset-gate before unlink,
  prevention-log #6).

- [ ] **Step 1: Write the failing tests** — `tests/test_supervisor.sh`,
  in the Task 7 style (every helper gets a positive and a refusal case):

```bash
# --- Phase B: per-trigger lifecycle markers + concurrency gating -------------
VARDIR="$(mktemp -d)"; LOGDIR="$(mktemp -d)"; AUTONOMY_LANE=""
ERR_BACKOFF_START=60; ERR_BACKOFF_MAX=3600

# backoff: record -> future epoch; clear -> 0; junk marker reads as 0
trigger_record_error_backoff coder
now="$(date -u +%s)"
until_e="$(trigger_backoff_until coder)"
check "backoff records future epoch" "0" "$([ "$until_e" -gt "$now" ] && echo 0 || echo 1)"
trigger_clear_backoff coder
check "backoff cleared"             "0" "$(trigger_backoff_until coder)"
mkdir -p "$VARDIR/trigger-ctl/backoff" && printf 'junk\n' >"$VARDIR/trigger-ctl/backoff/coder"
check "junk backoff reads 0 (safe)" "0" "$(trigger_backoff_until coder)"
check "bad name refused"            "1" "$(trigger_backoff_until 'a;b' >/dev/null 2>&1; echo $?)"

# stop sentinel
mkdir -p "$VARDIR/trigger-ctl/stop" && : >"$VARDIR/trigger-ctl/stop/coder"
check "stop sentinel detected"      "0" "$(trigger_stopped coder && echo 0 || echo 1)"
rm -f "$VARDIR/trigger-ctl/stop/coder"
check "stop sentinel gone"          "1" "$(trigger_stopped coder && echo 0 || echo 1)"

# slots: first hole wins; full -> rc 1; slot 0 keeps the legacy filename
: >"$LOGDIR/.pipeline-run-qa.json"
check "free slot skips slot 0"      "1" "$(trigger_free_slot qa 3)"
: >"$LOGDIR/.pipeline-run-qa@1.json" && : >"$LOGDIR/.pipeline-run-qa@2.json"
check "no free slot rc"             "1" "$(trigger_free_slot qa 3 >/dev/null; echo $?)"
check "inflight count"              "3" "$(trigger_inflight_count qa)"

# start token: policy skip clamps to max 1
_triggers_enumerate() { printf 'qa\tnative\tskip\t1\nfleet\tnative\tparallel\t3\n'; }
resolve_dispatch_triggers >/dev/null
check "skip at capacity rc"         "1" "$(trigger_start_token qa >/dev/null; echo $?)"
: >"$LOGDIR/.pipeline-run-fleet.json"
check "parallel next slot token"    "fleet@1" "$(trigger_start_token fleet)"
unset -f _triggers_enumerate
```

  Plus (same file, stubbing `run_session() { RS_CALLS="$RS_CALLS $1:$2"; }`
  and a `python3` shim for `triggers.py show`): `resolve_manual_fires`
  starts once for a valid `MODE=manual ENABLED=true` marker and removes it;
  an invalid-charset marker is WARN-removed without a `show` call; a
  non-manual marker is WARN-removed; `resolve_queued_fires` consumes a
  queued marker exactly once and passes the KIND stored in the marker body.

- [ ] **Step 2: Run, see fail.**

- [ ] **Step 3: Implement** — new section after the Task 7 block:

```bash
# --- per-trigger lifecycle + concurrency (Phase B) ---------------------------
# Markers under $VARDIR/trigger-ctl/: fire/ + stop/ are OPERATOR-written and
# supervisor-consumed; queued/ + backoff/ are supervisor-owned (SD-7's
# sole-writer discipline generalised). Every name from disk is charset-gated
# before any path join (prevention-log #6). All readers tolerate a missing
# dir; all writers are best-effort (a marker hiccup never crashes the loop).
trigger_ctl_dir() { printf '%s/trigger-ctl/%s' "$VARDIR" "$1"; }

_trigger_ctl_path() {   # $1=kind $2=name; rc 1 on a bad name
  case "$2" in *[!A-Za-z0-9._-]*|"") return 1 ;; esac
  printf '%s/%s' "$(trigger_ctl_dir "$1")" "$2"
}

trigger_stopped() {
  local p
  p="$(_trigger_ctl_path stop "$1")" || return 1
  [ -f "$p" ]
}

trigger_backoff_until() {   # prints next-eligible epoch; 0 = eligible now
  local p epoch
  p="$(_trigger_ctl_path backoff "$1")" || return 1
  if [ ! -f "$p" ]; then printf '0'; return 0; fi
  IFS='	' read -r epoch _ <"$p" 2>/dev/null || epoch=""
  case "$epoch" in *[!0-9]*|"") printf '0' ;; *) printf '%s' "$epoch" ;; esac
}

trigger_record_error_backoff() {
  local p count=0 wait i=1
  p="$(_trigger_ctl_path backoff "$1")" || return 0
  mkdir -p "$(trigger_ctl_dir backoff)" 2>>"$SUPLOG" || return 0
  if [ -f "$p" ]; then IFS='	' read -r _ count <"$p" 2>/dev/null || count=0; fi
  case "$count" in *[!0-9]*|"") count=0 ;; esac
  count=$((count + 1))
  wait=$ERR_BACKOFF_START
  while [ "$i" -lt "$count" ] && [ "$wait" -lt "$ERR_BACKOFF_MAX" ]; do
    wait=$((wait * 2)); i=$((i + 1))
  done
  [ "$wait" -gt "$ERR_BACKOFF_MAX" ] && wait=$ERR_BACKOFF_MAX
  printf '%s\t%s\n' "$(( $(date -u +%s) + wait ))" "$count" >"$p" 2>>"$SUPLOG" || true
}

trigger_clear_backoff() {
  local p
  p="$(_trigger_ctl_path backoff "$1")" || return 0
  rm -f "$p" 2>>"$SUPLOG" || true
}

trigger_inflight_count() {
  local name="$1" tok n=0 tn
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    tn="$(token_name "$tok")" || continue
    [ "$tn" = "$name" ] && n=$((n + 1))
  done <<<"$(inflight_tokens)"
  printf '%s' "$n"
}

trigger_free_slot() {   # $1=name $2=max; prints the first free slot, rc 1 = full
  local name="$1" max="$2" slot=0
  while [ "$slot" -lt "$max" ]; do
    if [ ! -f "$(pipeline_state_file "$name" "$slot")" ]; then
      printf '%s' "$slot"; return 0
    fi
    slot=$((slot + 1))
  done
  return 1
}

# Capacity-aware start token for THIS tick's enumeration (TRIG_* arrays).
# Policy skip/queue clamp to one run; parallel opens slots up to max.
# rc 1 = at capacity (skip logs the NOTE; queue's marker write is the cron
# resolver's job -- it knows the fire actually happened).
trigger_start_token() {
  local name="$1" policy max slot
  policy="$(trigger_policy_of "$name")"; max="$(trigger_max_of "$name")"
  [ "$policy" = "parallel" ] || max=1
  slot="$(trigger_free_slot "$name" "$max")" || return 1
  if [ "$slot" = "0" ]; then printf '%s' "$name"; else printf '%s@%s' "$name" "$slot"; fi
}

# Operator 'run now' markers for MANUAL triggers. Marker name = trigger
# name. triggers.py show is the identity check (MODE/ENABLED/POLICY/MAX come
# from the file, not from the dispatch arrays -- manual triggers are not in
# the continuous enumeration). Capture-then-case, never producer|grep
# (prevention-log #7/#11).
resolve_manual_fires() {
  local d f name out line mode enabled policy max slot tok
  d="$(trigger_ctl_dir fire)"
  [ -d "$d" ] || return 0
  for f in "$d"/*; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    case "$name" in
      *[!A-Za-z0-9._-]*|"")
        log "WARN trigger-ctl: fire marker with invalid name -- removing"
        rm -f "$f" 2>>"$SUPLOG" || true; continue ;;
    esac
    out="$(python3 "$ENGINE_HOME/lib/triggers.py" show "$AUTONOMY_TARGET_REPO" "$name" 2>>"$SUPLOG" || true)"
    # Exact KEY=VALUE line parse (Codex CP1: substring matching on the
    # whole blob could match inside another value once fields grow; this
    # gate stands between an operator marker and a dispatch). Requires the
    # '=' separator per line -- prevention-log #1's parser rule.
    mode=""; enabled=""; policy=""; max=""
    while IFS= read -r line; do
      case "$line" in *=*) ;; *) continue ;; esac
      case "${line%%=*}" in
        MODE)    mode="${line#*=}" ;;
        ENABLED) enabled="${line#*=}" ;;
        POLICY)  policy="${line#*=}" ;;
        MAX)     max="${line#*=}" ;;
      esac
    done <<<"$out"
    if [ "$mode" != "manual" ]; then
      log "WARN trigger-ctl: '$name' is not a valid manual trigger -- removing its fire marker"
      rm -f "$f" 2>>"$SUPLOG" || true; continue
    fi
    if [ "$enabled" != "true" ]; then
      log "NOTE trigger '$name' is disabled -- fire marker kept until enabled"
      continue
    fi
    [ "$policy" = "parallel" ] || max=1
    case "$max" in *[!0-9]*|"") max=1 ;; esac
    if ! slot="$(trigger_free_slot "$name" "$max")"; then
      log "NOTE trigger '$name': at capacity -- manual fire deferred (marker kept)"
      continue
    fi
    if [ "$slot" = "0" ]; then tok="$name"; else tok="$name@$slot"; fi
    if run_session "$tok" native; then
      rm -f "$f" 2>>"$SUPLOG" || true
    else
      log "WARN manual fire for '$name' rc=$? -- marker kept for retry"
    fi
  done
  return 0
}

# Deferred schedule fires (policy queue, depth 1). The marker BODY holds the
# trigger's kind (written by resolve_trigger_cron_due at fire time -- queued
# triggers are not in the continuous dispatch arrays, so the kind must
# travel with the marker).
resolve_queued_fires() {
  local d f name kind tok
  d="$(trigger_ctl_dir queued)"
  [ -d "$d" ] || return 0
  for f in "$d"/*; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    case "$name" in *[!A-Za-z0-9._-]*|"")
      rm -f "$f" 2>>"$SUPLOG" || true; continue ;; esac
    tok="$(trigger_free_slot "$name" 1 >/dev/null && printf '%s' "$name")" || continue
    IFS= read -r kind <"$f" 2>/dev/null || kind=""
    case "$kind" in shim|native) ;; *) kind="shim" ;; esac
    if run_session "$tok" "$kind"; then
      rm -f "$f" 2>>"$SUPLOG" || true
    fi
  done
  return 0
}
```

  **`resolve_trigger_cron_due`** — derive it mechanically from
  `resolve_cron_due` (`:859-911`): swap `_cron_enumerate` for
  `_triggers_enumerate cron "$AUTONOMY_TARGET_REPO"` (now three TAB fields:
  name, schedule, kind), keep the `$VARDIR/cron/<name>.last_fire` marker
  discipline, first-sight-no-fire, and skip+warn on missed fires IDENTICAL,
  and replace the fire call `run_session "$name"` with:

```bash
      if tok="$(trigger_start_token_for "$name" "$kind")"; then
        run_session "$tok" "$kind" || log "cron: trigger '$name' session rc=$? (see supervisor.log)"
      else
        case "$(trigger_show_policy "$name" "$kind")" in
          queue)
            mkdir -p "$(trigger_ctl_dir queued)" 2>>"$SUPLOG" || true
            [ -f "$(trigger_ctl_dir queued)/$name" ] && \
              log "WARN trigger '$name': queued fire overwritten (queue depth is 1)"
            printf '%s\n' "$kind" >"$(trigger_ctl_dir queued)/$name" 2>>"$SUPLOG" || true ;;
          *)
            log "NOTE trigger '$name': at capacity -- scheduled fire skipped (policy skip)" ;;
        esac
      fi
```

  where `trigger_start_token_for`/`trigger_show_policy` are the
  `trigger_start_token` logic backed by a `triggers.py show` read instead
  of the dispatch arrays (schedule triggers are not in the continuous
  enumeration either — same reason as manual; implement them as thin
  wrappers that parse `POLICY=`/`MAX=` from `show`, defaulting to
  `skip`/`1` on any read failure — the safe direction).

- [ ] **Step 4: Run, see pass; run_all + shellcheck clean.**

- [ ] **Step 5: Commit** `feat(#<ISSUE>): per-trigger firing + concurrency +
  lifecycle -- queue/skip/parallel start gating, stop sentinel, per-trigger
  error backoff, manual fire markers, schedule via the cron machinery`.

---

### Task 9: the cutover — main loop enumerates triggers; parity proven

**Files:**
- Modify: `bin/supervisor.sh` (main loop `:1868-1962`, `resolve_cron_due`
  call site `:1877`)
- Test: `tests/test_supervisor.sh`

**The switch (kept to a minimal, reviewable diff):**

- [ ] **Step 1: Write the failing parity tests FIRST** — the seven
  **Cutover proof obligations** from the header, as `tests/test_supervisor.sh`
  checks (stub `_triggers_enumerate` + `python3` seams the way the file
  stubs `gh`):
  1. roles-only fixture → `resolve_dispatch_triggers` output ==
     `resolve_dispatch_roles` output, in order (drive both against the real
     `lib/` CLIs over a tmp fixture repo, not stubs, for THIS check);
  2. a pre-existing `.pipeline-run-coder.json` (no `@`, no lane) appears in
     `inflight_tokens` as `coder` and `pipeline_state_file coder 0`
     round-trips to the same path;
  3. the dispatch-list assembly in the new loop yields in-flight-only on an
     empty board (mirror the existing empty-board test with tokens);
  4. `trigger_kind_of` for a token absent from enumeration returns `shim`
     (the pre-cutover in-flight compat rule);
  5. an event-role fixture: `resolve_event_wakes` still resolves and
     dispatches through the ROLE path (existing event tests keep passing
     UNCHANGED — that is the assertion);
  6. stopped trigger's token filtered; backoff-marked trigger's token
     filtered;
  7. the fingerprint gate call still receives the bare NAME (grep-level
     test on the loop body is acceptable here: `fingerprint_gate "$name"`).

- [ ] **Step 2: Run, see the NEW list-assembly checks fail** (old loop code).

- [ ] **Step 3: Implement the swap** in the main loop:
  - `:1877` `resolve_cron_due` → `resolve_trigger_cron_due` (shim cron roles
    arrive through the trigger enumeration — same markers, same semantics).
    Insert `resolve_manual_fires` after it.
  - `:1898` `inflight_list="$(inflight_roles | tr '\n' ' ')"` →
    `inflight_list="$(inflight_tokens | tr '\n' ' ')"` filtered through the
    stop-sentinel + backoff helpers.
  - `:1913` `resolve_dispatch_roles` → `resolve_dispatch_triggers`;
    **enumeration failure = idle this tick** (WARN + `heartbeat
    "enumeration-failed"` + `sleep "$ERR_BACKOFF_START"`; in-flight tokens
    still advance — they need no enumeration). SD-12's old coder-only
    fallback is RETIRED at the inversion (Codex CP1): triggers are now the
    authority on what may run, and a failed enumeration can mean the config
    or trigger set is unreadable — running `coder` anyway would resurrect
    legacy dispatch past an operator-visible failure (fail-open). The
    Task 10 SD entry records this supersession explicitly.
    Start-candidate assembly: for each enumerated continuous trigger, add
    `"$(trigger_start_token "$name")"` when its policy admits a new start
    (Task 8 helper); in-flight tokens merge in as today (`:1917-1922`).
  - `:1931` `role="$(select_role …)"` operates on tokens unchanged
    (`select_role` is order-math only); then
    `name="$(token_name "$role")"`, `kind="$(trigger_kind_of "$name")"`.
  - `:1944` fingerprint gate + `pipeline_inflight` use `$name` (+ slot-0
    state check extended to any-slot: `trigger_inflight_count "$name" -gt 0`).
    Verify `role_fingerprint` (`:451`) is name-agnostic for a native
    trigger; if any sub-probe reads role config and fails, the gate's own
    contract ("any doubt falls through to dispatch") already lands on the
    safe side — pin that with one test rather than adding a kind branch.
  - `:1962` `run_session "$role"` → `run_session "$role" "$kind"`; the
    outcome case arms gain `trigger_record_error_backoff "$name"` in the
    error arm and `trigger_clear_backoff "$name"` in the clean arm.
  - DELETE `inflight_roles` and `resolve_dispatch_roles` ONLY IF nothing
    else sources them (grep first — `tests/` may; if so they stay with a
    `# legacy, tests only` comment and a tech-debt note in the PR).
- [ ] **Step 4: Run EVERYTHING** — `bash tests/run_all.sh`, shellcheck sweep,
  and a manual smoke: a throwaway `/tmp` fixture repo (roles-only config),
  `bin/supervisor.sh --repo <fixture>` with a stubbed adapter, one tick,
  assert the session log + state file names are byte-identical to a
  pre-branch run of the same fixture (capture both, `diff` the LOGDIR
  listings).
- [ ] **Step 5: Commit** `feat(#<ISSUE>): CUTOVER -- the supervisor
  enumerates triggers (auto-shimmed roles + native files); roles-only
  configs dispatch byte-identically (parity suite)`.

---

### Task 10: gates, docs, settled-decision entry, PR

- [ ] **Gates:** `bash tests/run_all.sh` green · `shellcheck -S warning start
  bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh` clean ·
  **pre-flight-review** over the full diff · **Codex checkpoint 2** before
  the first push. No dashboard verify loop (no page changed — the dashboard
  intentionally keeps the role view until Phase D).
- [ ] **Product doc** (`docs/pipelines.md`, house rule — present tense,
  supported/not-yet, zero process refs): a new "Triggers" section — the
  file format with a full example, firing modes (continuous/schedule/manual;
  event "coming with the event-trigger phase"), concurrency policies
  (queue-1/skip/parallel + the pick-claim note), enabled/pause vs the stop
  sentinel, the var-shadow edit home, the roles auto-shim ("existing
  `roles:` configs keep working; a trigger file with a role's name replaces
  that role's automatic trigger"), `${…}` now live in briefs and activity
  fields (+ the `$${` escape), what refuses and why (required-unset,
  unregistered repo/account, secrets). State honestly: the dashboard still
  displays roles; triggers get their own surface in a later phase.
- [ ] **Skill** (`.claude/skills/engineering/pipelines.md`): update the
  "not yet wired into dispatch" paragraph — substitution IS wired at
  prepare; validator accepts `${…}` (statically checked via `check_refs`);
  triggers/`lib/triggers.py` join the subsystem map; the dispatch-path
  description swaps roles→triggers; note the state keys
  `trigger`/`kind`/`params`/`run` and the slot filename form.
- [ ] **Settled decisions** (`docs/settled-decisions.md`): ONE new entry —
  triggers are the dispatch unit (SD-12/SD-36 generalise role→trigger
  verbatim otherwise, EXCEPT SD-12's enumeration-failure→coder-only
  fallback, which is explicitly RETIRED: enumeration failure now idles the
  tick — running coder past a config/trigger failure would be fail-open);
  SD-34 extends to trigger files; the shim name-equality contract
  (trigger==role byte-equal until Phase E re-keys trust); a native trigger
  file supersedes its same-name loop/cron shim and REFUSES on an
  event-role name collision until Phase C; a refused trigger never falls
  back to role dispatch. Cite the design spec + this plan + the PR.
- [ ] **Template README** (`templates/autonomy-pack/README.md`): the
  parallel-claim discipline paragraph (Task 8) if not already added there.
- [ ] **PR** per `pr-authoring.md`. **Security model (mandatory section):**
  trigger names are DISK/CLI input — charset-gated before every path/argv
  use (`_NAME_RE` python-side, `case` gates bash-side); trigger files parse
  with stdlib `json` only; the `${…}` language remains eval-free and param
  values are INERT BY CONSTRUCTION (single-pass `re.sub`, replacements never
  rescanned — cite Phase A PR #372); secrets have NO Phase B sink and are
  refused end-to-end (ref refusal at validate + supplied-value refusal at
  start + name-only error messages) — this IS the deferred log-redaction
  boundary, enforced by construction; repo/account params verify against
  the registries with refuse-on-unreadable; the dashboard write surface is
  untouched; `bin/safe_merge.sh` and workflows untouched. **Tradeoffs
  stated:** event roles stay on the legacy bus (Phase C); manual firing has
  no param-override channel yet (Phase D prompts); the dashboard renders
  roles until Phase D; queue depth is 1 by design.
- [ ] Before merge: `gh pr view <n> --json closingIssuesReferences` — closes
  ONLY the Phase B issue (prevention-log #20). Every review comment to a
  terminal state (`review-resolution.md`); CP3 before any rebuttal-only
  merge; merge via `safe_merge`; loops stay PAUSED after merge (operator
  directive — do NOT resume anything).

---

## Out of scope (later phases — do NOT build here)

- **Phase C:** `call_pipeline` + child runs + outputs mapping across runs;
  **event-mode triggers** (the bus keeps firing event ROLES via the legacy
  path); the secret **env channel** (the first legitimate secret sink —
  un-refuse secrets then, WITH the live redaction that phase needs);
  same-container earlier-sibling output refs if a real pipeline wants them.
- **Phase D:** Pipelines gallery + Triggers UI (create/edit/enable/pause/
  run-now with param prompts), run monitoring, dashboard trigger view, the
  trigger var-shadow WRITER (`pipeline_save`-style control action — Phase B
  only READS shadows), manual-fire param overrides.
- **Phase E:** trust ledger re-key (per trigger) + run windows + retiring
  the state `role` key + folding the loop-global error backoff fully into
  per-trigger state.
- **Not this repo's phase at all:** onboard/doctor trigger awareness
  (scaffold a starter trigger, report trigger validity) — a follow-on slice
  after Phase B proves the shape; `templates/autonomy-pack/triggers/`
  starters wait for it (an enabled example trigger scaffolded today would
  double-dispatch against the shim).
