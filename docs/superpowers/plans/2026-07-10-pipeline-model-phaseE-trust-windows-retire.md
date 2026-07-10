# Phase E — per-trigger trust + run windows + legacy retirement (pipeline+trigger model) Implementation Plan

> **Audience note (engineering record):** this is a build plan for the
> engine's own development loop. It references process vocabulary decoded in
> `.claude/skills/engineering/pipelines.md` (SD-N, prevention-log #N, CP1-3).

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-key the trust ledger per TRIGGER (design spec §6) with a
fail-safe evidence-migration story for pre-Phase-B journal lines, add the
pipeline-level trust rollup, add per-trigger run windows (graceful,
new-starts-only), and DELETE the legacy role-dispatch twins named in
SD-39/SD-40 after porting their unique test coverage onto the live trigger
resolvers.

**Architecture:** All Python behaviour lands in `lib/pipeline.py` (ledger
re-key, additive journal `kind`) and `lib/triggers.py` (rollup, run-window
schema + membership + CLI wiring). The supervisor changes are subtractive
(seven legacy functions deleted) plus two small fail-safe keep-branches for
fire markers outside a run window. The dashboard keeps the role view
(Phase D); its one touch is a truthful tooltip label.

**Tech Stack:** bash 3.2.57 (`bin/supervisor.sh`), Python 3 stdlib only
(`lib/pipeline.py`, `lib/triggers.py`), unittest + sourced-script shell
tests, shellcheck -S warning.

## Global Constraints

- macOS `/bin/bash` 3.2.57 floor: no `mapfile`, no globstar, no `declare -A`,
  no `${var,,}`.
- Python 3 **stdlib only** (`datetime`/`time` are fine; nothing third-party).
- Fail-safe never fail-open: a broken/refused trigger NEVER falls back to
  role dispatch (SD-39); unreadable evidence lands on `watch`; the healthy
  verdict is earned, never the default arm (prevention-log #18).
- Repo-agnostic `bin//lib/`: no target-repo values.
- `bin/safe_merge.sh` and `.github/workflows/**` untouched.
- The dashboard keeps the ROLE view until Phase D — no payload/route change;
  `build_pipeline_view`'s existing `ledger(journal, role, pname)` call keeps
  working unchanged (positional-compatible signature).
- Loops stay PAUSED throughout; nothing here resumes them.
- Every script's executable body stays source-guarded; shellcheck clean
  including `tests/*.sh`.
- Honesty invariant: the validator refuses what the runner can't honour
  (prevention-log #3) — so no `end_of_window: hard` key exists at all in
  Phase E (graceful is the only built behaviour; an unknown key refuses).
- The run-window clock is **UTC**, matching the cron parser
  (`roles.cron_next_fire` is explicitly `timezone.utc`); documented loudly.

## Decisions this plan settles (candidate SD-41, recorded with the build PR)

1. **Ledger keys on the journal `trigger` field.** A line counts for trigger
   T when `line.trigger == T` (post-#374 lines always carry it; shim and
   native alike write `trigger == role == state token name` byte-equal).
2. **Evidence migration = reader-side grandfather clause, journal never
   rewritten.** A line with NO `trigger` field (or empty string — a pre-B
   in-flight run finishing post-B writes `""`) counts for T only when the
   caller says T is a SHIM (`native=False`) and `line.role == T`: the shim's
   name is byte-equal to the role whose assignment the old line described.
   A NATIVE trigger earns from zero (`native=True` skips trigger-less
   lines) — inheriting role-era evidence for a re-authored parameterisation
   would be fail-open. Post-B shim-era lines DO count for a same-name
   native that binds the same pipeline (name+pipeline continuity is the
   designed trust argument, SD-39); the new additive journal `kind` field
   makes that inheritance distinguishable in future without rewriting
   history.
3. **Child runs are never trigger evidence.** Lines with a non-empty
   `parent_run` are skipped by the projection: no trigger fired them, and a
   child's parameterisation belongs to its caller. (Also a no-op for
   today's callers: a child's `role` is the dotted `<parent>.c<slot>.<node>`
   token, which never equals a role/trigger name.)
4. **Rollup = fail-safe floor over ALL valid triggers.** A pipeline reads
   `auto` only when every contributing trigger's tier is `auto`. The rollup
   enumerates with the enabled/lane filter OFF (disabling a trigger must
   not hide its evidence). Refused triggers can't be attributed to a
   pipeline (the file may not parse far enough to name one), so no rollup
   floor can represent them — instead the `trust` CLI prints a
   `REFUSED\t<reason>` row on STDOUT per refusal, making the verdict
   surface itself carry the caveat (CP1 finding 1). Wrapped-role shims
   group under the wrapped doc's name (== role name).
5. **Run windows are a per-trigger schema field, graceful-only,
   new-starts-only.** `run_windows: [{start, end, days?}]`, UTC, start
   inclusive / end exclusive, `end <= start` wraps past midnight with
   `days` naming the window's START day, absent key = always dispatchable,
   empty list refused, ≤ 16 windows. Enforcement lives python-side at the
   four dispatch-facing CLI verbs (`dispatch`/`cron`/`event`/`manual`), so
   NEW run starts are blocked while in-flight tokens (which never pass
   through enumeration) keep advancing — S36's graceful semantics fall out
   structurally. Shims never carry windows (`roles:` has no such key), so
   run windows are a native-trigger feature.
6. **Out-of-window firing semantics:** manual fire markers are KEPT while
   the window is closed (fire when it opens — the disabled-marker
   discipline); queued markers are deferred the same way; a schedule fire
   whose due-minute elapsed while closed fires ONCE at window-open (the
   untouched `last_fire` marker makes `cron-due` report due — bounded
   single catch-up, no storm); event tokens redeliver at window-open (seen
   only advances on STARTED tokens, Phase C semantics). Two conscious
   bounds, both on the established under-fire side (CP1 findings 5+6
   adjudicated as accepted tradeoffs, documented in Task 7): (a) window
   precision is ONE LOOP TICK — a trigger enumerated while open can start
   just past the exclusive `end` (same granularity class as cron's minute
   clock, and graceful S36 semantics already permit in-flight work past
   the boundary; a second gate at `start_run_trigger` would buy sub-tick
   precision nobody asked for); (b) a trigger FIRST SEEN at window-open
   seeds its cron marker / event seen-set without firing — that is the
   engine's existing first-sight-no-fire discipline, unchanged by windows
   (fires begin with the first due/event AFTER the seeded baseline).
7. **Deletion inventory (SD-39/SD-40 mandate):** supervisor
   `resolve_dispatch_roles`, `inflight_roles`, `resolve_cron_due`,
   `resolve_event_wakes`, `_event_enumerate`, plus their legacy-only
   helpers `_roles_enumerate` and `_cron_enumerate`; roles.py legacy-only
   surface (`dispatch_roles` + the enumerate CLI arm, `event_roles` +
   `events` CLI, the `cron` CLI arm). `_event_role_wakes`, `_event_poll`,
   `_event_write_seen`, `_cron_write_marker`, `_role_name_path_safe`,
   `cron_next_fire`, `cron_roles`, `role_settings` all SURVIVE (live
   consumers). Unique legacy-test coverage is PORTED to the live twins
   BEFORE deletion (Task 5 lands green while the legacy functions still
   exist, then Task 6 deletes).
8. **Non-goals (explicitly deferred):** renaming the state-file `role` key
   (the Phase B plan floated it for Phase E, but the dashboard state-file
   glob and role view consume it until Phase D — renaming now would break
   the "dashboard keeps the role view" rail; defer to the phase that
   teaches the dashboard triggers); tier ENFORCEMENT (nothing gates on the
   tier today and nothing new does); folding the loop-global error backoff
   (per-trigger backoff already exists; the fleet PAUSE sentinel and
   account-limit state are global BY DESIGN); pack trigger starters +
   onboard/doctor awareness (#378); the gallery/trust UI (Phase D);
   `end_of_window: hard`.

## Settled decisions + prevention log applied

- **SD-39/SD-40**: the deletion mandate executed here; "a broken trigger
  never falls back to role dispatch" becomes structural (the role path no
  longer exists). SD-12/SD-36 dispatch semantics untouched. SD-25's
  lane-blind cron marker survives on the live twin (same file, same
  semantics). SD-34 shadow resolution untouched. SD-8: no secret surface.
- **Prevention log**: #3/#18 (window membership defaults CLOSED on junk;
  `SHOW_WINDOW` init `closed`, only literal `open` opens; rollup floor);
  #6 (`--now` digits-only argv gate; `HH:MM` charset-explicit; supervisor
  re-validates enumeration fields as today); #12 (ledger stays a total
  reader; `in_run_window` tolerates junk windows by contributing no open
  time); #7/#11 (ported shell checks keep capture-then-case, never
  `producer | grep -q`); #9 (no timing assertions anywhere); #21 (any
  review fix gets the same-class sibling scan). #17 n/a (no `set -e`
  config readers added). #13/#14/#16 n/a (no dashboard render change).

## File structure (what changes where)

- `lib/pipeline.py` — `ledger()` re-key + docstring + usage line; additive
  `kind` in `_journal_append`; `ledger` CLI arm gains `--native`.
- `lib/triggers.py` — `run_windows` schema (validator + defaults +
  `in_run_window`); `_cli_lane` → `_cli_opts` (adds `--now`); window filter
  in `dispatch`/`cron`/`event`/`manual`; `WINDOW=` in `show`;
  `enumerate_triggers(..., dispatchable_only=True)`; `trust_rollup()` +
  `trust` CLI verb; `roles.all_cron_roles` public accessor used by the shim.
- `bin/supervisor.sh` — DELETE 7 legacy functions; `_trigger_show_fields`
  parses `WINDOW=`; window keep-branches in `resolve_manual_fires` +
  `resolve_queued_fires`; stale comment sweep.
- `lib/roles.py` — delete legacy-only surface; fix stale `:56` comment name.
- `lib/dashboard_state.py` — comment-only: `:2117` marker-writer attribution.
- `lib/pipeline_page.html` — tooltip label "per assignment" → "per trigger".
- Tests: `tests/test_pipeline.py`, `tests/test_triggers.py`,
  `tests/test_trigger_dispatch.sh`, `tests/test_event_bus.sh`,
  `tests/test_headless_dispatch.sh`, `tests/test_pipeline_runner.sh`;
  DELETE `tests/test_scheduler.sh` (its unique checks move to
  `test_trigger_dispatch.sh`; shell suites are auto-globbed by
  `run_all.sh`, so no registration edit).
- Docs: `docs/pipelines.md` (product layer — trust section rewrite +
  run-window schema + `trust` CLI), `.claude/skills/engineering/pipelines.md`
  (subsystem map), `docs/superpowers/specs/2026-07-08-sequencer-MASTER.md`
  (shipped-table row), `docs/settled-decisions.md` (SD-41).

---

### Task 1: Ledger re-key + additive journal `kind` (lib/pipeline.py)

**Files:**
- Modify: `lib/pipeline.py:2140-2175` (ledger), `:2109-2130`
  (_journal_append), `:2917-2927` (CLI arm), `:22` (usage line)
- Modify: `lib/pipeline_page.html:476-478` (tooltip text only)
- Test: `tests/test_pipeline.py` (`JournalLedgerTest`)

**Interfaces:**
- Consumes: existing journal line shape (`role`, `trigger`, `parent_run`,
  `pipeline`, `outcome`, `pass`).
- Produces: `ledger(journal_path, trigger, pipeline_name="", native=False)`
  → `{"runs": int, "passes": int, "tier": "watch"|"auto"}` (Task 2's rollup
  calls this exact signature); journal lines additionally carry
  `"kind": "shim"|"native"|""`.

- [ ] **Step 1: Write the failing tests** — extend `JournalLedgerTest` in
  `tests/test_pipeline.py`, reusing the class's existing journal-line
  helper style (the current tests build line dicts and write them to a tmp
  journal; keep that idiom — the code below shows the semantics to pin):

```python
    def _rec(self, **over):
        rec = {"role": "coder", "pipeline": "flow", "outcome": "success",
               "pass": True}
        rec.update(over)
        return rec

    def _journal(self, recs):
        # if the class already has an equivalent tmp-journal writer, reuse
        # it instead of adding this one.
        p = os.path.join(self.tmp, "journal.jsonl")
        with open(p, "w") as fh:
            for r in recs:
                fh.write(json.dumps(r) + "\n")
        return p

    def test_ledger_keys_on_trigger_field(self):
        # trigger field wins over role: a line written by trigger "night"
        # never counts for trigger "coder" even though role says coder.
        j = self._journal([self._rec(trigger="night"),
                           self._rec(trigger="coder")])
        self.assertEqual(pipeline.ledger(j, "coder")["runs"], 1)
        self.assertEqual(pipeline.ledger(j, "night")["runs"], 1)

    def test_ledger_grandfathers_roleonly_lines_for_shim(self):
        # pre-#374 line: no trigger key at all. Counts for the shim
        # (native=False default) whose name is the byte-equal role name.
        j = self._journal([self._rec()])
        self.assertEqual(pipeline.ledger(j, "coder")["runs"], 1)

    def test_ledger_empty_trigger_field_is_grandfathered_too(self):
        # a pre-B in-flight run that FINISHED post-B writes trigger="".
        j = self._journal([self._rec(trigger="")])
        self.assertEqual(pipeline.ledger(j, "coder")["runs"], 1)

    def test_ledger_junk_trigger_value_is_skipped_not_grandfathered(self):
        # ONLY a missing key or "" grandfathers (CP1 finding 4): a corrupt
        # post-B line with a non-string trigger is dropped entirely.
        j = self._journal([self._rec(trigger=0), self._rec(trigger=[]),
                           self._rec(trigger=None)])
        self.assertEqual(pipeline.ledger(j, "coder")["runs"], 0)

    def test_ledger_native_earns_from_zero(self):
        # native=True: trigger-less role-era lines are NOT inherited.
        j = self._journal([self._rec(), self._rec(trigger="")])
        self.assertEqual(pipeline.ledger(j, "coder", native=True)["runs"], 0)
        # but a real post-B line keyed on the trigger still counts.
        j2 = self._journal([self._rec(trigger="coder")])
        self.assertEqual(pipeline.ledger(j2, "coder", native=True)["runs"], 1)

    def test_ledger_excludes_child_runs(self):
        # call_pipeline children (parent_run set) are never trigger evidence.
        j = self._journal([self._rec(trigger="coder", parent_run="r-1"),
                           self._rec(trigger="coder")])
        self.assertEqual(pipeline.ledger(j, "coder")["runs"], 1)

    def test_journal_line_carries_kind(self):
        # additive Phase E field, written from state["kind"].
        # (extend the class's existing _journal_append/_finish round-trip
        # test: a state dict with "kind": "native" produces a line whose
        # json has rec["kind"] == "native"; a kind-less state writes "".)
```

- [ ] **Step 2: Run and see them fail**

Run: `python3 -m unittest tests.test_pipeline.JournalLedgerTest -v`
Expected: FAIL — `ledger() got an unexpected keyword argument 'native'` /
trigger-keyed assertions wrong / no `kind` in journal line.

- [ ] **Step 3: Implement.** Replace `ledger()` (`lib/pipeline.py:2140`):

```python
def ledger(journal_path, trigger, pipeline_name="", native=False):
    """Trust-ledger projection, keyed per TRIGGER (Phase E; design spec
    §6): PURE read over the journal, no stored tier. Total reader
    (prevention-log #12): junk lines are skipped -- they reduce evidence,
    which keeps the tier on the safe side (watch).

    A line counts when its `trigger` field matches. A line with NO trigger
    field (pre-#374 evidence; an empty string counts as absent) is
    grandfathered ONLY for a SHIM (native=False): the shim's name is
    byte-equal to the role whose assignment that line described. A NATIVE
    trigger earns from zero -- inheriting role-era evidence for a
    re-authored parameterisation would be fail-open. Child-run lines
    (parent_run set) never count: no trigger fired them. pipeline_name
    still scopes to the current binding, so rebinding never inherits the
    previous pipeline's record. The pass-rate is computed over the most
    recent TRUST_MIN_RUNS runs (rolling window), so demotion responds to
    recent decay."""
    matched = []
    try:
        fh = open(journal_path)
    except OSError:
        return {"runs": 0, "passes": 0, "tier": "watch"}
    with fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if not isinstance(rec, dict):
                continue
            if rec.get("parent_run"):
                continue
            t = rec.get("trigger", "")
            if not isinstance(t, str):
                continue      # junk trigger value: skip, never grandfather
            if t:
                if t != trigger:
                    continue
            elif native or rec.get("role") != trigger:
                continue
            if pipeline_name and rec.get("pipeline") != pipeline_name:
                continue
            if rec.get("outcome") not in ("success", "failure", "capped"):
                continue
            matched.append(rec.get("pass") is True)
    runs = len(matched)
    passes = sum(1 for p in matched if p)
    window = matched[-TRUST_MIN_RUNS:]
    window_passes = sum(1 for p in window if p)
    tier = ("auto" if runs >= TRUST_MIN_RUNS
            and window_passes >= len(window) * TRUST_PASS_RATE else "watch")
    return {"runs": runs, "passes": passes, "tier": tier}
```

  In `_journal_append`'s `rec` dict, directly after the `parent_run` entry:

```python
        # Additive Phase E field: shim/native provenance per line, so
        # future keying refinements can tell role-era shim evidence from
        # native evidence without rewriting the journal.
        "kind": state.get("kind", ""),
```

  CLI arm (`lib/pipeline.py:2917`) — boolean flag popped before
  `_split_opts` (which only handles `--opt value` pairs):

```python
    if cmd == "ledger":
        native = "--native" in rest
        rest = [a for a in rest if a != "--native"]
        opts = {"--pipeline": ""}
        pos = _split_opts(rest, opts)
        if len(pos) != 2:
            print("usage: pipeline.py ledger <journal> <trigger> "
                  "[--pipeline <name>] [--native]", file=sys.stderr)
            return 2
        led = ledger(pos[0], pos[1], pipeline_name=opts["--pipeline"],
                     native=native)
        print("runs=%d passes=%d tier=%s" % (led["runs"], led["passes"],
                                             led["tier"]))
        return 0
```

  Update the module usage doc line (`:22`) to
  `pipeline.py ledger <journal-file> <trigger> [--pipeline <name>] [--native]`.

  `lib/pipeline_page.html` tooltip (`:476-478`): change the phrase
  `trust is earned per assignment` → `trust is earned per trigger` (rest of
  the sentence unchanged). Grep `tests/` for the old phrase first — if any
  test pins the string, update it in the same commit.

- [ ] **Step 4: Existing callers check (no edits expected).**
  `lib/dashboard_state.py:2663` calls `ledger(journal, role, pname)`
  positionally — the renamed second parameter is positional-compatible, and
  `native=False` default preserves today's shim/role behaviour exactly.
  Confirm no keyword call `role=` exists: `grep -rn "ledger(" lib/ bin/ tests/`.

- [ ] **Step 5: Run the suite**

Run: `python3 -m unittest tests.test_pipeline -v` then
`python3 -m unittest tests.test_dashboard_state -v`
Expected: PASS (all pre-existing ledger tests still green — the default
path is behaviour-identical for role-keyed shim queries).

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline.py lib/pipeline_page.html tests/test_pipeline.py
git commit -m "feat(pipeline): ledger keys on trigger; grandfather clause for pre-B lines; child runs excluded; additive journal kind"
```

---

### Task 2: Pipeline-level trust rollup (lib/triggers.py)

**Files:**
- Modify: `lib/triggers.py:279-318` (enumerate_triggers), `:334+` (main)
- Test: `tests/test_triggers.py`

**Interfaces:**
- Consumes: `pipeline.ledger(journal, trigger, pipeline_name=, native=)`
  from Task 1; `enumerate_triggers(repo, lane=None)` existing return
  `(triggers, warnings)`.
- Produces: `enumerate_triggers(repo, lane=None, dispatchable_only=True)`;
  `trust_rollup(repo, journal_path)` →
  `(rows, rollup, warnings)` where rows =
  `[{trigger, pipeline, kind, runs, passes, tier}]` and rollup =
  `{pipeline_name: "watch"|"auto"}`; CLI verb
  `triggers.py trust <repo> <journal>` printing per-trigger lines
  `TRIGGER\t<name>\t<pipeline>\t<kind>\t<runs>\t<passes>\t<tier>`, then
  `REFUSED\t<reason>` lines for every refusal warning, then rollup lines
  `PIPELINE\t<name>\t<tier>` (rows are distinguished by the literal first
  tag AND field count, so a trigger literally named "PIPELINE" cannot be
  misparsed). REFUSED rows go to STDOUT, not just a stderr WARN (CP1
  finding 1): a refused trigger file can't be attributed to a pipeline
  (it may not even parse far enough to name one), so the rollup cannot
  floor a specific pipeline — instead the verdict surface itself carries
  the caveat, and a consumer that shows tiers without showing REFUSED
  rows is the one being dishonest, not the data.

- [ ] **Step 1: Write the failing tests** (`tests/test_triggers.py`, new
  class; build the repo fixture the way the file's existing enumeration
  tests do — a tmp dir with `.autonomy/config.yaml` + `.autonomy/triggers/`):

```python
class TrustRollupTest(unittest.TestCase):
    # repo scaffolding: reuse the module's established tmp-repo builder
    # idiom (.autonomy/config.yaml + one .autonomy/triggers/<name>.json
    # per entry) -- shown inline here so the tests are self-contained.
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        os.makedirs(os.path.join(self.tmp, ".autonomy", "triggers"))

    def _config(self, text="roles: {}\n"):
        with open(os.path.join(self.tmp, ".autonomy", "config.yaml"),
                  "w") as fh:
            fh.write(text)

    def _trigger(self, name, **over):
        trig = {"name": name, "pipeline": "flow",
                "firing": {"mode": "continuous"}}
        trig.update(over)
        p = os.path.join(self.tmp, ".autonomy", "triggers",
                         "%s.json" % name)
        with open(p, "w") as fh:
            json.dump(trig, fh)

    def _journal(self, recs):
        p = os.path.join(self.tmp, "journal.jsonl")
        with open(p, "w") as fh:
            for r in recs:
                fh.write(json.dumps(r) + "\n")
        return p

    def _pass_lines(self, trigger, n, pipeline="flow"):
        return [{"role": trigger, "trigger": trigger, "pipeline": pipeline,
                 "outcome": "success", "pass": True} for _ in range(n)]

    def test_rollup_floor_any_watch_is_watch(self):
        self._config()
        self._trigger("hot")             # 20/20 passes -> auto
        self._trigger("cold")            # 0 runs -> watch
        j = self._journal(self._pass_lines("hot", 20))
        rows, rollup, _ = triggers.trust_rollup(self.tmp, j)
        tiers = dict((r["trigger"], r["tier"]) for r in rows)
        self.assertEqual(tiers["hot"], "auto")
        self.assertEqual(tiers["cold"], "watch")
        self.assertEqual(rollup["flow"], "watch")   # the fail-safe floor

    def test_rollup_all_auto_is_auto(self):
        self._config()
        self._trigger("hot")
        self._trigger("warm")
        j = self._journal(self._pass_lines("hot", 20)
                          + self._pass_lines("warm", 20))
        _, rollup, _ = triggers.trust_rollup(self.tmp, j)
        self.assertEqual(rollup["flow"], "auto")

    def test_disabled_trigger_still_counted(self):
        # a pause must never hide evidence from the rollup.
        self._config()
        self._trigger("hot", enabled=False)
        j = self._journal(self._pass_lines("hot", 20))
        rows, rollup, _ = triggers.trust_rollup(self.tmp, j)
        self.assertEqual([r["trigger"] for r in rows], ["hot"])
        self.assertEqual(rollup["flow"], "auto")

    def test_wrapped_shim_groups_under_role_name(self):
        # unbound loop role: the shim's pipeline binding is empty, so the
        # row groups under the wrapped doc's name (== the role name),
        # matching the journal's pipeline field for wrapped runs.
        self._config("roles:\n  coder:\n    enabled: true\n")
        j = self._journal([])
        rows, rollup, _ = triggers.trust_rollup(self.tmp, j)
        row = [r for r in rows if r["trigger"] == "coder"][0]
        self.assertEqual(row["pipeline"], "coder")
        self.assertEqual(rollup["coder"], "watch")

    def test_native_rows_do_not_inherit_roleonly_lines(self):
        # 20 passing TRIGGER-LESS role lines + a same-name NATIVE trigger:
        # the native row earns from zero (native=True wired through).
        self._config()
        self._trigger("coder")
        j = self._journal([{"role": "coder", "pipeline": "flow",
                            "outcome": "success", "pass": True}
                           for _ in range(20)])
        rows, _, _ = triggers.trust_rollup(self.tmp, j)
        self.assertEqual(rows[0]["runs"], 0)
        self.assertEqual(rows[0]["tier"], "watch")

    def test_trust_cli_output_shape(self):
        # TRIGGER rows carry 7 tab-fields, PIPELINE rollup rows 3; drive
        # triggers.main(["trust", repo, journal]) capturing stdout the way
        # the file's other CLI tests do.
        self._config()
        self._trigger("hot")
        j = self._journal(self._pass_lines("hot", 20))
        out = self._run_main_capture(["trust", self.tmp, j])
        lines = out.strip().split("\n")
        self.assertTrue(lines[0].startswith("TRIGGER\t"))
        self.assertEqual(len(lines[0].split("\t")), 7)
        self.assertEqual(lines[-1].split("\t"),
                         ["PIPELINE", "flow", "auto"])

    def test_trust_cli_surfaces_refused_triggers_on_stdout(self):
        # CP1 finding 1: a corrupt trigger file cannot be attributed to a
        # pipeline, so the verdict SURFACE carries it -- a REFUSED row on
        # stdout, alongside (not instead of) the stderr WARN.
        self._config()
        self._trigger("hot")
        with open(os.path.join(self.tmp, ".autonomy", "triggers",
                               "broken.json"), "w") as fh:
            fh.write("{not json")
        j = self._journal(self._pass_lines("hot", 20))
        out = self._run_main_capture(["trust", self.tmp, j])
        refused = [l for l in out.strip().split("\n")
                   if l.startswith("REFUSED\t")]
        self.assertEqual(len(refused), 1)
        self.assertIn("broken", refused[0])
```

  (`_run_main_capture` = the file's existing stdout-capture idiom for
  `triggers.main`; reuse it rather than inventing a new one.)

- [ ] **Step 2: Run and see them fail**

Run: `python3 -m unittest tests.test_triggers.TrustRollupTest -v`
Expected: FAIL — `trust_rollup` not defined / unknown subcommand.

- [ ] **Step 3: Implement.** `enumerate_triggers` gains the kwarg; the
  filter tail (`lib/triggers.py:314-318`) becomes:

```python
    def _in_lane(t):
        tl = t.get("lane") or roles.default_lane(cfg)
        return tl in declared and tl == target_lane
    if not dispatchable_only:
        # trust/inspection callers: every VALID trigger, disabled and
        # off-lane included (a pause must not hide evidence). Refusals
        # stayed refused above -- this widens nothing invalid.
        return out, warnings
    return ([t for t in out if t.get("enabled", True) and _in_lane(t)],
            warnings)
```

  New function (below `enumerate_triggers`):

```python
def trust_rollup(repo, journal_path):
    """Per-trigger trust rows + per-pipeline rollup (design spec §6).
    The rollup is a fail-safe floor: a pipeline reads `auto` only when
    EVERY contributing trigger's tier is `auto` (prevention-log #18 --
    the reassuring verdict is earned, never the default)."""
    trigs, warnings = enumerate_triggers(repo, dispatchable_only=False)
    rows, by_pipeline = [], {}
    for t in trigs:
        pname = t.get("pipeline") or t["name"]  # wrapped role: doc name == role name
        led = pipeline.ledger(journal_path, t["name"], pipeline_name=pname,
                              native=(t.get("kind") == "native"))
        rows.append({"trigger": t["name"], "pipeline": pname,
                     "kind": t.get("kind", ""), "runs": led["runs"],
                     "passes": led["passes"], "tier": led["tier"]})
        by_pipeline.setdefault(pname, []).append(led["tier"])
    rollup = dict((p, "auto" if all(x == "auto" for x in tiers) else "watch")
                  for p, tiers in by_pipeline.items())
    return rows, rollup, warnings
```

  CLI arm in `main()` (alongside the other verbs; `trust` takes exactly two
  positionals, so it is NOT added to the shared 1-positional guard):

```python
    if cmd == "trust":
        if len(pos) != 2:
            print("usage: triggers.py trust <repo> <journal>",
                  file=sys.stderr)
            return 2
        try:
            rows, rollup, warns = trust_rollup(pos[0], pos[1])
        except PipelineError as exc:
            print("triggers trust: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w, file=sys.stderr)
        for r in rows:
            print("TRIGGER\t%s\t%s\t%s\t%d\t%d\t%s" % (
                r["trigger"], r["pipeline"], r["kind"], r["runs"],
                r["passes"], r["tier"]))
        # Refusals land on STDOUT too (CP1 finding 1): the trust surface
        # itself must carry "a trigger here is unreadable" -- a refused
        # file can't be attributed to a pipeline, so no rollup floor can
        # represent it. Tabs in the reason are flattened so the row stays
        # 2-field parseable.
        for w in warns:
            if w.startswith("refused"):
                print("REFUSED\t%s" % w.replace("\t", " "))
        for p in sorted(rollup):
            print("PIPELINE\t%s\t%s" % (p, rollup[p]))
        return 0
```

  Update the module docstring's verb list to include `trust`.

- [ ] **Step 4: Run the suite**

Run: `python3 -m unittest tests.test_triggers -v`
Expected: PASS (including all pre-existing enumeration tests — the kwarg
default preserves current behaviour byte-for-byte).

- [ ] **Step 5: Commit**

```bash
git add lib/triggers.py tests/test_triggers.py
git commit -m "feat(triggers): trust_rollup + trust CLI verb -- per-trigger rows, fail-safe per-pipeline floor, disabled triggers still counted"
```

---

### Task 3: Run-window schema + membership (lib/triggers.py)

**Files:**
- Modify: `lib/triggers.py:14-33` (imports + constants), `:58-183`
  (validate_trigger), `:186-191` (_apply_defaults)
- Test: `tests/test_triggers.py`

**Interfaces:**
- Produces: `in_run_window(trig, now_epoch) -> bool` (Task 4 wires it);
  validated optional trigger key
  `run_windows: [{"start": "HH:MM", "end": "HH:MM", "days": ["mon",...]?}]`;
  constants `WINDOW_DAYS`, `MAX_RUN_WINDOWS`.

- [ ] **Step 1: Write the failing tests** (`tests/test_triggers.py`; extend
  `ValidateTriggerTest` with the schema cases, new class for membership):

```python
    # ValidateTriggerTest additions (use the existing _trig(**over) helper):
    def test_run_windows_valid_shapes_pass(self):
        # [{"start":"22:00","end":"06:00"}] and
        # [{"start":"09:00","end":"17:00","days":["mon","fri"]}] -> []

    def test_run_windows_refusals(self):
        # each yields a non-empty error list:
        #  - run_windows: {} / "22:00-06:00" / []           (not a non-empty list)
        #  - 17 windows                                     (> MAX_RUN_WINDOWS)
        #  - {"start":"22:00"}                              (end missing)
        #  - {"start":"2200","end":"06:00"}                 (bad HH:MM)
        #  - {"start":"24:00","end":"06:00"}                (hour 24)
        #  - {"start":"22:60","end":"06:00"}                (minute 60)
        #  - {"start":"22:00","end":"22:00"}                (zero-length)
        #  - {"start":"22:00","end":"06:00","days":[]}      (empty days)
        #  - {"start":"22:00","end":"06:00","days":["Mon"]} (case-exact vocab)
        #  - {"start":"22:00","end":"06:00","tz":"UTC"}     (unknown key)

class RunWindowMembershipTest(unittest.TestCase):
    # Fixed UTC instants (never the live clock -- prevention-log #9 spirit).
    # 2026-07-08 is a WEDNESDAY; values verified empirically:
    # python3 -c "import datetime; print(int(datetime.datetime(2026,7,8,23,0,
    #   tzinfo=datetime.timezone.utc).timestamp()))"
    WED_2300 = 1783551600   # Wed 2026-07-08 23:00:00 UTC
    THU_0300 = 1783566000   # Thu 2026-07-09 03:00:00 UTC
    THU_0700 = 1783580400   # Thu 2026-07-09 07:00:00 UTC

    def _t(self, windows):
        return {"run_windows": windows}

    def test_absent_or_empty_means_always(self):
        self.assertTrue(triggers.in_run_window({}, self.WED_2300))
        self.assertTrue(triggers.in_run_window(self._t([]), self.WED_2300))

    def test_same_day_window(self):
        w = [{"start": "09:00", "end": "17:00"}]
        self.assertFalse(triggers.in_run_window(self._t(w), self.WED_2300))

    def test_wrap_past_midnight(self):
        w = [{"start": "22:00", "end": "06:00"}]
        self.assertTrue(triggers.in_run_window(self._t(w), self.WED_2300))
        self.assertTrue(triggers.in_run_window(self._t(w), self.THU_0300))
        self.assertFalse(triggers.in_run_window(self._t(w), self.THU_0700))

    def test_wrap_days_name_the_start_day(self):
        # window belongs to WED; Thursday 03:00 is inside WED's wrapped tail.
        w = [{"start": "22:00", "end": "06:00", "days": ["wed"]}]
        self.assertTrue(triggers.in_run_window(self._t(w), self.THU_0300))
        # a THU-only window has not started by Thursday 03:00.
        w2 = [{"start": "22:00", "end": "06:00", "days": ["thu"]}]
        self.assertFalse(triggers.in_run_window(self._t(w2), self.THU_0300))

    def test_start_inclusive_end_exclusive(self):
        w = [{"start": "23:00", "end": "23:30"}]
        self.assertTrue(triggers.in_run_window(self._t(w), self.WED_2300))
        w2 = [{"start": "22:00", "end": "23:00"}]
        self.assertFalse(triggers.in_run_window(self._t(w2), self.WED_2300))

    def test_junk_window_contributes_no_open_time(self):
        # defense-in-depth (prevention-log #12/#18, CP1 finding 2): junk
        # on an already-loaded dict opens NOTHING (fail-safe = closed).
        for junk in ([{"start": "junk", "end": "06:00"}],   # bad HH:MM
                     "22:00-06:00",                          # non-list key
                     [{"start": "00:00", "end": "23:59",
                       "days": "wed"}],                      # non-list days
                     [{"start": "00:00", "end": "23:59",
                       "days": []}],                         # empty days
                     [{"start": "00:00", "end": "23:59",
                       "days": ["wed", 3]}]):                # junk member
            self.assertFalse(
                triggers.in_run_window(self._t(junk), self.WED_2300),
                repr(junk))
```

  (The three instants above are already derived and verified; the comment
  in the test preserves the derivation command.)

- [ ] **Step 2: Run and see them fail**

Run: `python3 -m unittest tests.test_triggers -v`
Expected: FAIL — unknown-key refusal fires on `run_windows`;
`in_run_window` not defined.

- [ ] **Step 3: Implement.** Imports: add `import datetime` (top of
  `lib/triggers.py`, stdlib block). Constants after
  `CONCURRENCY_POLICIES`:

```python
_WINDOW_KEYS = frozenset(("start", "end", "days"))
WINDOW_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
MAX_RUN_WINDOWS = 16
```

  Add `"run_windows"` to `_TRIGGER_KEYS`. Helpers (near `_is_scalar`):

```python
def _hhmm(value):
    """'HH:MM' -> minutes-since-midnight, or None when malformed.
    Charset-explicit (prevention-log #6): only ASCII digits."""
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":":
        return None
    hh, mm = value[:2], value[3:]
    if not all(c in "0123456789" for c in hh + mm):
        return None
    h, m = int(hh), int(mm)
    if h > 23 or m > 59:
        return None
    return h * 60 + m

def _validate_window(w, idx):
    errs = []
    if not isinstance(w, dict):
        return ["run_windows[%d] must be an object" % idx]
    for k in w:
        if k not in _WINDOW_KEYS:
            errs.append("run_windows[%d]: unknown key %r" % (idx, k))
    start, end = _hhmm(w.get("start")), _hhmm(w.get("end"))
    if start is None:
        errs.append("run_windows[%d].start must be 'HH:MM' (UTC)" % idx)
    if end is None:
        errs.append("run_windows[%d].end must be 'HH:MM' (UTC)" % idx)
    if start is not None and start == end:
        errs.append("run_windows[%d]: start == end is a zero-length window"
                    " -- omit run_windows for always-on, or widen it" % idx)
    days = w.get("days")
    if days is not None:
        if not isinstance(days, list) or not days:
            errs.append("run_windows[%d].days must be a non-empty list"
                        " of day names" % idx)
        else:
            for d in days:
                if d not in WINDOW_DAYS:
                    errs.append("run_windows[%d].days: unknown day %r"
                                " (mon..sun, lowercase)" % (idx, d))
    return errs

def in_run_window(trig, now_epoch):
    """True when NEW dispatch is allowed at now_epoch. UTC clock -- the
    same clock as the cron parser (roles.cron_next_fire). ONE public rule
    (CP1 finding 3): a MISSING run_windows key means always-dispatchable,
    and the empty list `[]` is its defaults-synthesised twin
    (_apply_defaults writes it; the validator refuses an EXPLICIT [] in an
    authored file as a foot-gun, so a validated file never carries one).
    end <= start wraps past midnight; a wrapped window's `days` list names
    the window's START day. Start inclusive, end exclusive.

    Fail-closed on junk (CP1 finding 2, prevention-log #12/#18): a
    PRESENT-but-malformed run_windows value (non-list) opens nothing, and
    a malformed window entry or days value contributes NO open time --
    the operator wrote a restriction, so an unreadable restriction must
    restrict, never widen. In-flight runs are never gated here: only the
    four dispatch-facing CLI verbs consult this, and in-flight tokens
    never pass through enumeration."""
    windows = trig.get("run_windows")
    if windows is None or windows == []:
        return True
    if not isinstance(windows, list):
        return False
    try:
        dt = datetime.datetime.fromtimestamp(int(now_epoch),
                                             datetime.timezone.utc)
    except (ValueError, OverflowError, OSError):
        return False
    minutes = dt.hour * 60 + dt.minute
    dow = WINDOW_DAYS[dt.weekday()]            # weekday(): mon=0 .. sun=6
    prev = WINDOW_DAYS[(dt.weekday() - 1) % 7]
    for w in windows:
        if not isinstance(w, dict):
            continue
        start, end = _hhmm(w.get("start")), _hhmm(w.get("end"))
        if start is None or end is None:
            continue
        days = w.get("days")
        if days is None:
            days = WINDOW_DAYS
        elif (not isinstance(days, list)
              or not all(isinstance(d, str) and d in WINDOW_DAYS
                         for d in days)
              or not days):
            continue                    # junk days: no open time
        if end > start:
            if dow in days and start <= minutes < end:
                return True
        else:
            if dow in days and minutes >= start:
                return True
            if prev in days and minutes < end:
                return True
    return False
```

  In `validate_trigger`, after the concurrency block (`:176`):

```python
    windows = trig.get("run_windows")
    if windows is not None:
        if not isinstance(windows, list) or not windows:
            errs.append("run_windows must be a non-empty list of window"
                        " objects (omit the key for always-dispatchable)")
        elif len(windows) > MAX_RUN_WINDOWS:
            errs.append("run_windows: at most %d windows" % MAX_RUN_WINDOWS)
        else:
            for i, w in enumerate(windows):
                errs.extend(_validate_window(w, i))
```

  In `_apply_defaults`: `trig.setdefault("run_windows", [])` (shims get `[]`
  = always, preserving today's behaviour for every shimmed role).

- [ ] **Step 4: Run the suite**

Run: `python3 -m unittest tests.test_triggers -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/triggers.py tests/test_triggers.py
git commit -m "feat(triggers): run_windows schema + UTC membership -- wrap-past-midnight, start-day days, junk windows fail closed"
```

---

### Task 4: Wire windows into dispatch + fire-marker deferral

**Files:**
- Modify: `lib/triggers.py:321-331` (_cli_lane → _cli_opts), `:334+`
  (main: now default, four verb filters, show WINDOW field)
- Modify: `bin/supervisor.sh:1149-1166` (_trigger_show_fields),
  `resolve_manual_fires` keep-branch, `resolve_queued_fires` window gate
- Test: `tests/test_triggers.py`, `tests/test_trigger_dispatch.sh`

**Interfaces:**
- Consumes: `in_run_window` from Task 3.
- Produces: every dispatch-facing verb (`dispatch`/`cron`/`event`/`manual`)
  omits out-of-window triggers; `--now <epoch>` test seam on all verbs;
  `show` prints `WINDOW=open|closed`; supervisor keeps manual/queued
  markers while a window is closed (`SHOW_WINDOW` shell var, init
  `closed`, only literal `open` opens).

- [ ] **Step 1: Write the failing python tests** (`tests/test_triggers.py`,
  new class `RunWindowCliTest` — build a tmp repo with one native trigger
  per firing mode carrying `run_windows: [{"start":"22:00","end":"06:00"}]`,
  then drive `triggers.main([...])` with `--now`):

```python
class RunWindowCliTest(unittest.TestCase):
    # same tmp-repo scaffolding as TrustRollupTest (setUp/_config/_trigger/
    # _run_main_capture); the shared night window + verified instants:
    NIGHT = [{"start": "22:00", "end": "06:00"}]
    INSIDE = 1783551600    # Wed 2026-07-08 23:00 UTC (see Task 3)
    OUTSIDE = 1783580400   # Thu 2026-07-09 07:00 UTC

    def _windowed(self, mode, **firing_extra):
        firing = {"mode": mode}
        firing.update(firing_extra)
        self._trigger("night", firing=firing, run_windows=self.NIGHT)

    def test_dispatch_window_filters(self):
        self._config()
        self._windowed("continuous")
        inside = self._run_main_capture(
            ["dispatch", self.tmp, "--now", str(self.INSIDE)])
        outside = self._run_main_capture(
            ["dispatch", self.tmp, "--now", str(self.OUTSIDE)])
        self.assertIn("night", inside)
        self.assertNotIn("night", outside)

    def test_cron_event_manual_window_filter(self):
        self._config()
        self._trigger("night-cron",
                      firing={"mode": "schedule", "schedule": "0 23 * * *"},
                      run_windows=self.NIGHT)
        self._trigger("night-ev",
                      firing={"mode": "event", "event": "pr.opened"},
                      run_windows=self.NIGHT)
        self._trigger("night-man", firing={"mode": "manual"},
                      run_windows=self.NIGHT)
        for verb, name in (("cron", "night-cron"), ("event", "night-ev"),
                           ("manual", "night-man")):
            inside = self._run_main_capture(
                [verb, self.tmp, "--now", str(self.INSIDE)])
            outside = self._run_main_capture(
                [verb, self.tmp, "--now", str(self.OUTSIDE)])
            self.assertIn(name, inside, verb)
            self.assertNotIn(name, outside, verb)

    def test_show_window_field(self):
        self._config()
        self._windowed("manual")
        self.assertIn("WINDOW=closed", self._run_main_capture(
            ["show", self.tmp, "night", "--now", str(self.OUTSIDE)]))
        self.assertIn("WINDOW=open", self._run_main_capture(
            ["show", self.tmp, "night", "--now", str(self.INSIDE)]))
        self._trigger("plain", firing={"mode": "manual"})
        self.assertIn("WINDOW=open", self._run_main_capture(
            ["show", self.tmp, "plain", "--now", str(self.OUTSIDE)]))

    def test_validate_and_trust_are_unfiltered(self):
        # windows never hide a trigger from inspection.
        self._config()
        self._windowed("continuous")
        j = os.path.join(self.tmp, "journal.jsonl")
        open(j, "w").close()
        self.assertIn("OK night", self._run_main_capture(
            ["validate", self.tmp, "--now", str(self.OUTSIDE)]))
        self.assertIn("TRIGGER\tnight", self._run_main_capture(
            ["trust", self.tmp, j, "--now", str(self.OUTSIDE)]))

    def test_now_argv_gate(self):
        # digits-only (prevention-log #6): "12abc" and a missing value
        # both return 2 with a usage error, never a silent live-clock
        # fallback.
        self.assertEqual(triggers.main(
            ["dispatch", self.tmp, "--now", "12abc"]), 2)
        self.assertEqual(triggers.main(["dispatch", self.tmp, "--now"]), 2)
```

- [ ] **Step 2: Run and see them fail**

Run: `python3 -m unittest tests.test_triggers.RunWindowCliTest -v`
Expected: FAIL — `--now` lands in positionals, verbs unfiltered, no
WINDOW line.

- [ ] **Step 3: Implement (python side).** Add `import time` to the stdlib
  imports. Replace `_cli_lane` with:

```python
def _cli_opts(args):
    """Positionals + (--lane, --now). --now is the run-window clock's
    test seam: digits-only epoch (argv-boundary gate, prevention-log #6);
    anything else raises -- a typo'd --now silently meaning 'live clock'
    could open a window that should be closed."""
    lane, now = None, None
    pos, i = [], 0
    while i < len(args):
        if args[i] == "--lane" and i + 1 < len(args):
            lane = args[i + 1]
            i += 2
        elif args[i] == "--now":
            if i + 1 >= len(args):
                raise ValueError("--now needs a digits-only epoch value")
            v = args[i + 1]
            if not v or not all(c in "0123456789" for c in v):
                raise ValueError("--now must be a digits-only epoch")
            now = int(v)
            i += 2
        else:
            pos.append(args[i])
            i += 1
    return pos, lane, now
```

  In `main()`:

```python
    cmd, rest = argv[0], argv[1:]
    try:
        pos, lane, now = _cli_opts(rest)
    except ValueError as exc:
        print("triggers.py: %s" % exc, file=sys.stderr)
        return 2
    if now is None:
        now = int(time.time())
```

  In each of the FOUR dispatch-facing verbs (`dispatch`, `cron`, `event`,
  `manual`), directly after the `for w in warns:` stderr loop:

```python
        trigs = [t for t in trigs if in_run_window(t, now)]
```

  `validate`, `show` (listing), and `trust` stay UNfiltered. In the `show`
  arm, after the `ENABLED=` line:

```python
        print("WINDOW=%s" % ("open" if in_run_window(t, now) else "closed"))
```

- [ ] **Step 4: Implement (supervisor side).** In `_trigger_show_fields`
  (`bin/supervisor.sh:1149`): initialise `SHOW_WINDOW="closed"` alongside
  the other `SHOW_*` resets, and add a parser arm — only the literal
  `open` opens (earned healthy verdict, prevention-log #18):

```bash
      WINDOW)  case "${line#*=}" in open) SHOW_WINDOW="open" ;; esac ;;
```

  In `resolve_manual_fires`, the not-in-manual-list branch keeps the marker
  for a window-closed manual trigger exactly like the disabled case:

```bash
      _trigger_show_fields "$name"
      if [ "$SHOW_MODE" = "manual" ] && [ "$SHOW_ENABLED" = "false" ]; then
        log "NOTE trigger '$name' is disabled -- fire marker kept until enabled"
      elif [ "$SHOW_MODE" = "manual" ] && [ "$SHOW_WINDOW" = "closed" ]; then
        log "NOTE trigger '$name' is outside its run window -- fire marker kept"
      else
        log "WARN trigger-ctl: '$name' is not a dispatchable manual trigger -- removing its fire marker"
        rm -f "$f" 2>>"$SUPLOG" || true
      fi
```

  In `resolve_queued_fires`, after the kind validation and before
  `run_session` (a queued fire is a NEW run start; the window was open when
  the fire was minted but may have closed before capacity freed):

```bash
    _trigger_show_fields "$name"
    if [ "$SHOW_WINDOW" = "closed" ]; then
      log "NOTE trigger '$name': outside its run window -- queued fire deferred (marker kept)"
      continue
    fi
```

  Note the fail-safe consequence and accept it: a queued marker whose
  trigger FILE has vanished now defers forever with a NOTE (previously it
  retried `run_session` forever with a WARN) — both are visible loops, and
  under-fire is the safe side. Queued markers are native-only today (a
  shim has no trigger file, so `trigger_show_policy` reads `skip` and
  never queues) — `SHOW_WINDOW` on a failed `show` therefore never wedges
  a shim.

- [ ] **Step 5: Write the failing shell tests**
  (`tests/test_trigger_dispatch.sh` — the established stub seams:
  `_trigger_show_fields` for branch logic, real marker dirs):

```bash
# --- run-window fire-marker deferral (Phase E) -------------------------------
# manual: window-closed keeps the marker (the disabled-marker discipline).
reset_rs
mkdir -p "$(trigger_ctl_dir fire)"
: >"$VARDIR/trigger-ctl/fire/night-push"
_triggers_enumerate() { printf ''; }   # window-filtered list omits it
_trigger_show_fields() {
  SHOW_MODE="manual"; SHOW_ENABLED="true"; SHOW_POLICY="skip"
  SHOW_MAX=1; SHOW_WINDOW="closed"
}
resolve_manual_fires
check "window-closed manual marker kept" "0" \
  "$([ -f "$VARDIR/trigger-ctl/fire/night-push" ] && echo 0 || echo 1)"
check "window-closed manual did not run" "" "$(rs_calls)"

# queued: window-closed defers the drain, marker kept.
reset_rs
mkdir -p "$(trigger_ctl_dir queued)"
printf 'native\n' >"$VARDIR/trigger-ctl/queued/night-push"
resolve_queued_fires
check "window-closed queued marker kept" "0" \
  "$([ -f "$VARDIR/trigger-ctl/queued/night-push" ] && echo 0 || echo 1)"
check "window-closed queued did not run" "" "$(rs_calls)"

# window OPEN drains the queued marker (the gate opens, not just closes).
_trigger_show_fields() {
  SHOW_MODE="manual"; SHOW_ENABLED="true"; SHOW_POLICY="skip"
  SHOW_MAX=1; SHOW_WINDOW="open"
}
resolve_queued_fires
check "window-open queued fire ran" " night-push:native" "$(rs_calls)"
```

  (Adapt `reset_rs`/`rs_calls` to the file's existing manual/queued harness
  names; restore the real `_trigger_show_fields`/`_triggers_enumerate`
  definitions afterwards the way the file's other stub blocks do — re-source
  or save/restore per the established pattern in that file.)

- [ ] **Step 6: Run everything**

Run: `python3 -m unittest tests.test_triggers -v && bash tests/test_trigger_dispatch.sh`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/triggers.py bin/supervisor.sh tests/test_triggers.py tests/test_trigger_dispatch.sh
git commit -m "feat(triggers): run windows gate NEW dispatch at the four dispatch-facing verbs; show WINDOW=; manual/queued markers defer while closed"
```

---

### Task 5: Port unique legacy-test coverage onto the live twins (tests only)

This task lands GREEN while the legacy functions still exist — it adds/moves
coverage, deleting only checks whose subject is the legacy function itself.
Every port keeps capture-then-case / here-string discipline
(prevention-log #7/#11).

**Files:**
- Modify: `tests/test_trigger_dispatch.sh` (absorb test_scheduler's unique
  checks; rewrite parity1)
- Delete: `tests/test_scheduler.sh` (after absorption)
- Modify: `tests/test_event_bus.sh` (port first-half unique checks onto the
  shim lane; drop the legacy half)
- Modify: `tests/test_headless_dispatch.sh` (retarget two enumeration
  checks)
- Modify: `tests/test_pipeline_runner.sh` (drop scenario 9)

**Interfaces:**
- Consumes: live resolvers `resolve_trigger_cron_due`,
  `resolve_trigger_event_wakes` (shim lane), `resolve_dispatch_triggers`,
  `inflight_tokens`; seams `_triggers_enumerate`, `_event_poll`,
  `run_session`.

- [ ] **Step 1: Absorb `test_scheduler.sh` into
  `test_trigger_dispatch.sh`'s cron block.** The twin already covers:
  first-sight-no-fire, due-fires, at-cap-queues, hostile-kind-drop. Port
  the UNIQUE checks (stub seam becomes `_triggers_enumerate` printing
  `NAME\tSCHEDULE\tkind` lines; `run_session` capture as in the existing
  cron block):

  | test_scheduler.sh check | ported assertion (on `resolve_trigger_cron_due`) |
  |---|---|
  | `:60-61` marker advanced + recent epoch | after the existing "cron due fires native" check: marker != seeded value AND > seeded+60 |
  | `:69` not-due role did not fire | enum line with a never-due schedule (`0 0 29 2 *` style far-fire) + fresh-but-old marker: no `rs_calls` |
  | `:82-83` enumeration failure rc 0 + fired nothing | `_triggers_enumerate() { return 1; }` → rc 0, no fire |
  | `:93-95` corrupt marker reinitialised without firing | marker `garbage` → no fire, marker now numeric |
  | `:110-112` marker-write failure fires nothing, rc 0, marker unadvanced | chmod-guarded block as in the original |
  | `:122` dotted cron name fires | `pm.v2` enum line fires |
  | `:129` invalid-name dropped | `bad/name` enum line: no fire |
  | `:136-142` `_role_name_path_safe` unit checks | port verbatim (helper survives; give it a small labelled section) |

- [ ] **Step 2: Delete `tests/test_scheduler.sh`.** Shell suites are
  auto-globbed by `tests/run_all.sh` — no registration edit.

- [ ] **Step 3: `tests/test_event_bus.sh`.** The shim lane already covers:
  fired-once, session.done ran/quiet, failed-dispatch-redeliver. Port the
  UNIQUE first-half checks into the live second half (drive
  `resolve_trigger_event_wakes` with the existing `_triggers_enumerate`
  event stub + `_event_poll` seam):

  | first-half check | ported assertion (shim lane) |
  |---|---|
  | `:70` no new token did not fire | seen == polled page → no fire |
  | `:77-78` first-sight seeds seen-set, no fire | fresh seen file created, no fire (native first-sight exists at `:231-232`; add the SHIM twin) |
  | `:97-99` poll failure rc 0 / nothing / seen untouched | `_event_poll() { return 1; }` |
  | `:124` dotted shim name fires | `qa.v2` shim line |
  | `:131` invalid shim name dropped | `bad/name` shim line: no fire |

  Then DELETE the legacy first half (`:38-132`: the `_event_enumerate` stub
  seam, the `resolve_event_wakes` checks, the `:53` type check) and the
  `:275-276` "legacy event resolver uncalled" grep pair (its double-dispatch
  meaning is retained by the surviving `:278` "trigger event resolver wired
  in the loop" single-wiring grep). Update the file's header comment to
  describe the trigger resolver as the subject.

- [ ] **Step 4: `tests/test_headless_dispatch.sh`.** Retarget the two
  enumeration checks from `resolve_dispatch_roles` to
  `resolve_dispatch_triggers` (real `triggers.py` against the real fixture
  config — shims mirror loop roles byte-for-byte, so expected values are
  unchanged):

```bash
check "enumerates enabled loop roles" "coder qa" \
  "$(resolve_dispatch_triggers | tr '\n' ' ' | sed 's/ $//')"
```

  Same substitution at `:439`/`:442` (the lane-pinned pair — shim lanes come
  from `roles.lane_of_role`, so expectations are unchanged). Update the
  section comments naming the old function.

- [ ] **Step 5: `tests/test_pipeline_runner.sh`.** Delete scenario 9
  (`:213-223`, the `inflight_roles` block) — lane filtering + charset
  gating of in-flight state files is covered on `inflight_tokens` in
  `test_trigger_dispatch.sh:57-71`.

- [ ] **Step 6: Rewrite parity1 in `test_trigger_dispatch.sh:296-320`** as
  a direct assertion (no legacy comparator): against the same fixture,
  `resolve_dispatch_triggers` emits exactly the fixture's enabled loop
  roles, in `roles:` order, every entry `kind=shim` (keep the existing
  TRIG_KIND loop). Keep parity2/6/7 unchanged (no legacy references).
  Leave the Task-9 header comment but reword "seven cutover parity
  invariants" to note parity1's comparator was retired with the legacy
  enumerator (the ordering pin survives python-side in
  `tests/test_triggers.py::test_shim_order_matches_dispatch_roles_order`).

- [ ] **Step 7: Run the full suite (legacy still present)**

Run: `bash tests/run_all.sh`
Expected: ALL SUITES PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/
git rm tests/test_scheduler.sh
git commit -m "test: port unique legacy-twin coverage onto the live trigger resolvers (pre-deletion)"
```

---

### Task 6: DELETE the legacy twins + stale-comment sweep

**Files:**
- Modify: `bin/supervisor.sh`, `lib/roles.py`, `lib/triggers.py` (one-line
  accessor swap), `lib/dashboard_state.py` (comment), `tests/test_roles.py`

**Interfaces:**
- Consumes: Task 5's ported coverage (must already be on main-line green).
- Produces: the legacy role-dispatch path no longer exists; SD-39's "never
  falls back to role dispatch" becomes structural.

- [ ] **Step 1: Delete from `bin/supervisor.sh`** (each WITH its LEGACY
  header comment; ranges are pre-edit orientation, delete by name):
  - `_roles_enumerate` (`:832-845`)
  - `resolve_dispatch_roles` (`:880-887`)
  - `_cron_enumerate` (`:1268-1278`, including its section comment's
    enumeration paragraph — keep the "cron scheduler (W1)" section title
    with `resolve_trigger_cron_due` below it)
  - `resolve_cron_due` (`:1314-1369`)
  - `_event_enumerate` (`:1438-1447`)
  - `resolve_event_wakes` (`:1522-1556`)
  - `inflight_roles` (`:1813-1842`)

  KEEP: `_event_role_wakes`, `_event_poll`, `_event_write_seen`,
  `_cron_write_marker`, `_role_name_path_safe` (all consumed by the live
  resolvers).

- [ ] **Step 2: Stale-comment sweep (same commit).**
  - `bin/supervisor.sh:143` — reword the `resolve_event_wakes` mention to
    `resolve_trigger_event_wakes` (the session.done consumer).
  - `bin/supervisor.sh:~892` — the `resolve_dispatch_triggers` header's
    "alongside resolve_dispatch_roles / the main loop swaps" sentence: now
    simply states it IS the enumerator (cutover complete, twins deleted).
  - `tests/test_trigger_dispatch.sh` / `tests/test_event_bus.sh` /
    `tests/test_headless_dispatch.sh` — any remaining prose naming the
    deleted functions (grep, step 5 verifies).
  - `lib/roles.py:56` — the seen-set invariant comment: name
    `_event_role_wakes` (the live assumer) instead of
    `resolve_event_wakes`.
  - `lib/dashboard_state.py:2117` — marker sole-writer attribution:
    `resolve_cron_due` → `resolve_trigger_cron_due` (comment only; the
    marker path and math are unchanged).

- [ ] **Step 3: Delete the roles.py legacy-only surface.**
  - `dispatch_roles` (`lib/roles.py:663-671`) and the ENUMERATE arm of the
    `dispatch` CLI (`_dispatch_main :974` — the one-positional form). KEEP
    the `dispatch <repo> <role>` settings form (live:
    `resolve_role_dispatch`, `pipeline.py:1450`, dashboard).
  - `event_roles` (`:766-772`) + the `events` CLI arm (`_events_main
    :1045`). KEEP `all_event_roles` (live: triggers shim).
  - The `cron` CLI arm (`_cron_main :1006`). KEEP `cron_roles` (live:
    dashboard `trigger_health`), `_all_cron_roles`, `cron_next_fire`, and
    the `cron-due` CLI (live: both the supervisor and validation).
  - Update `roles.py`'s module usage docstring to drop the deleted verbs.
  - In `lib/triggers.py:249` switch `roles._all_cron_roles(config)` →
    `roles.all_cron_roles(config)` (same return shape — the public
    accessor is a passthrough): the public wrapper gains its live consumer
    and stays symmetric with `all_event_roles`.
  - `tests/test_roles.py`: delete the tests whose SUBJECT is a deleted
    function/verb (`grep -n "dispatch_roles\|event_roles\|_cron_main\|_events_main\|\"cron\"\|'cron'" tests/test_roles.py`
    and prune judiciously — `cron-due` and `cron_next_fire` tests stay).

- [ ] **Step 4: shellcheck + full suite**

Run: `bash tests/run_all.sh && shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh`
Expected: ALL SUITES PASS; zero shellcheck output. (Deleting functions can
strand a `# shellcheck disable` or a variable only they read — fix any
fallout in this commit.)

- [ ] **Step 5: Rename the stale-named python test** —
  `tests/test_triggers.py::test_shim_order_matches_dispatch_roles_order`
  survives (it pins shim order against `roles._all_loop_roles`, not the
  deleted enumerator) but its NAME references the deleted function: rename
  to `test_shim_order_matches_loop_roles_order` and update its
  "Parity invariant 3" comment to name `resolve_dispatch_triggers`.

- [ ] **Step 6: Resurrection grep (verification, not a test):**

```bash
grep -rnw "resolve_dispatch_roles\|inflight_roles\|resolve_cron_due\|resolve_event_wakes\|_event_enumerate\|_roles_enumerate\|_cron_enumerate\|dispatch_roles\|event_roles" bin/ lib/ tests/
```

Expected: zero hits (`-w` word-matches, and `_` is a word constituent, so
the surviving `all_event_roles`, `all_cron_roles`,
`resolve_trigger_cron_due`, `resolve_trigger_event_wakes`,
`_event_role_wakes` and `inflight_tokens` do NOT match). `docs/` is
excluded on purpose — plans and specs are history and keep their
references.

- [ ] **Step 7: Commit**

```bash
git add -u
git commit -m "feat(supervisor,roles): delete the legacy role-dispatch twins (SD-39/SD-40 Phase E mandate) + stale-attribution sweep"
```

---

### Task 7: Docs (product layer + subsystem map + SD-41)

**Files:**
- Modify: `docs/pipelines.md`, `.claude/skills/engineering/pipelines.md`,
  `docs/superpowers/specs/2026-07-08-sequencer-MASTER.md`,
  `docs/settled-decisions.md`

- [ ] **Step 1: `docs/pipelines.md`** (production functional spec — present
  tense, no process jargon):
  - "The journal and earned autonomy" (`:369-379`): trust tier is **per
    trigger** (the pipeline as parameterised); lines carry
    `trigger`/`kind`; runs started before the trigger model count toward
    the same-name shimmed trigger (a native trigger of the same name
    starts from zero); child runs never count; lost/corrupt evidence still
    lands on `watch`; the per-pipeline rollup reads `auto` only when every
    trigger on that pipeline is `auto`; CLI:
    `triggers.py trust <repo> <journal>`.
  - Triggers section (`:224-307`): `run_windows` in the schema example +
    a bullet: UTC times, `HH:MM`, wrap-past-midnight, optional `days`
    (start-day for wrapped windows), new runs only (in-flight runs finish
    their current activity and keep advancing), manual/queued fires wait
    for the window, a schedule fire that came due while closed fires once
    at window-open, events redeliver at window-open. `show` prints
    `WINDOW=open|closed`. Also state the two bounds from decision 6:
    window precision is one loop tick, and a trigger first seen at
    window-open seeds its baseline without firing (first-sight
    discipline).
- [ ] **Step 2: `.claude/skills/engineering/pipelines.md`** (subsystem
  map): ledger keying sentence (per-trigger + grandfather + child
  exclusion + `kind` field), `trust` CLI verb + rollup, `run_windows` +
  where the gate lives (the four dispatch-facing verbs; `--now` seam),
  DELETE the two "LEGACY … deletion = Phase E" sentences (`:75-76`,
  `:86-87` byte-equal-until-re-key note becomes "re-keyed in Phase E").
- [ ] **Step 3: MASTER spec shipped table** — append the Phase E row
  (per-trigger trust + rollup + run windows + legacy twins deleted).
- [ ] **Step 4: `docs/settled-decisions.md`** — add SD-41 (one paragraph):
  trust keys per trigger with the reader-side grandfather clause (natives
  earn from zero; child runs excluded; journal never rewritten; additive
  `kind`); rollup = all-auto floor over ALL valid triggers; run windows
  are per-trigger, UTC, graceful-only, new-starts-only, enforced at the
  dispatch-facing enumeration (markers defer, schedule catch-up is one
  fire, events redeliver); the SD-39/SD-40 legacy twins are DELETED (the
  role-dispatch fallback is now structurally impossible); the state-file
  `role` key survives until the dashboard learns triggers (supersedes the
  Phase B plan's rename note).
- [ ] **Step 5: Commit**

```bash
git add docs/pipelines.md .claude/skills/engineering/pipelines.md docs/superpowers/specs/2026-07-08-sequencer-MASTER.md docs/settled-decisions.md
git commit -m "docs: per-trigger trust + run windows + legacy retirement (product spec, subsystem map, SD-41)"
```

---

## Codex CP1 (run 2026-07-10; all findings adjudicated)

Seven findings; five FOLDED, two REBUTTED-with-documentation:

1. **FOLDED** — rollup dropped refused triggers silently: the `trust` CLI
   now prints `REFUSED\t<reason>` rows on STDOUT (attribution to a
   pipeline is impossible for an unparseable file, so the surface carries
   the caveat instead of a fabricated floor).
2. **FOLDED** — `in_run_window` opened on malformed present data
   (non-list `run_windows`, string/empty/junk `days`): now fail-closed;
   junk contributes no open time; the membership test enumerates the junk
   shapes.
3. **FOLDED** — `[]` contract stated once: missing key = always, `[]` is
   its defaults-synthesised twin, an EXPLICIT `[]` in an authored file
   still refuses at validation.
4. **FOLDED** — the grandfather clause accepted falsy junk `trigger`
   values (`0`, `[]`, `null`): only a MISSING key or `""` grandfathers;
   non-string values skip the line entirely (evidence-reducing).
5. **REBUTTED (documented, decision 6a)** — "window enforced at
   enumeration, a start can land just past `end`": one-loop-tick
   precision, the same granularity class as cron's minute clock; graceful
   S36 semantics already permit in-flight work past the boundary. No
   second gate at `start_run_trigger`.
6. **REBUTTED (documented, decision 6b)** — "first-sight at window-open
   under-fires": that is the engine's existing first-sight-no-fire
   discipline (deliberate, fail-safe under-fire), unchanged by windows.
7. **FOLDED** — the two comment-bodied CLI tests are now fully coded.

## Self-review notes (already applied)

- **Spec coverage:** §6 re-key → Task 1; §6 rollup → Task 2; §9-E run
  windows → Tasks 3-4 (old-spec S36 graceful semantics, structurally);
  SD-39/40 deletion mandate → Tasks 5-6; product-doc rule → Task 7.
- **Type consistency:** `ledger(journal, trigger, pipeline_name=, native=)`
  is the one signature Tasks 1/2 share; `in_run_window(trig, now_epoch)`
  is the one membership predicate Tasks 3/4 share; `SHOW_WINDOW` values
  are exactly `open`/`closed`.
- **Ordering constraint:** Task 5 MUST land before Task 6 (coverage ports
  prove green against the live twins while the legacy functions still
  exist; deletion then changes no assertions).
- **Dashboard rail:** the only dashboard-adjacent edits are a tooltip
  label and a comment — `build_pipeline_view`'s ledger call is untouched
  by construction (positional-compatible signature, behaviour-identical
  default path for role-keyed queries).
