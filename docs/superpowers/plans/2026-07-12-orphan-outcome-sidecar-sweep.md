# Orphan run-outcome sidecar sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclaim orphaned `.pipeline-run-*.outcome.json` child-run sidecars
(litter from a hand-deleted parent or a `wait:false` detached child) via a
config-driven, site-toggleable sweep — doctor reports, worktree_gc prunes.

**Architecture:** A pure, policy-free detector in `lib/pipeline.py`
(`orphan_child_sidecars` + an `orphans` CLI verb) finds sidecars no live run
state claims, using a lane-agnostic forward-claim match. The report-vs-prune-vs-off
DECISION is a target-repo config knob (`pipelines.orphan_sidecar_action`) read by
`bin/doctor.sh` and `bin/worktree_gc.sh`, and toggleable from the control room via
the existing `CONFIG_PAGE_KEYS` allowlist. Policy lives in config + `bin/`;
mechanism stays in `lib/` (repo-agnostic).

**Tech Stack:** Python 3 stdlib (`lib/pipeline.py`, `lib/dashboard_control.py`);
`/bin/bash` 3.2 (`bin/doctor.sh`, `bin/worktree_gc.sh`); plain HTML/JS
(`lib/config_page.html`). Tests: `python3 -m unittest` + bash `check` harness.

Spec: `docs/superpowers/specs/2026-07-12-orphan-outcome-sidecar-sweep-design.md`.

## Global Constraints

- **bash 3.2.57 floor** — no `mapfile`/`readarray`, no globstar/`**`, no
  `declare -A`, no `${var,,}`/`${var^^}`. Use here-doc feeds, not `producer|while`.
- **Python 3 stdlib only** — no third-party imports.
- **Repo-agnostic `bin/`/`lib/`** — no target-repo values; `lib/pipeline.py` carries
  NO report/prune policy (the caller decides).
- **Fail-safe never fail-open** — a sidecar a live parent might consume is NEVER
  pruned; ambiguous/junk config value → `report` (never earns `prune`).
- **Best-effort periphery** — `doctor.sh` / `worktree_gc.sh` warn and never
  hard-fail their caller on a sweep hiccup.
- **`shellcheck -S warning` clean** across `bin/*.sh tests/*.sh`.
- Reserved sidecar suffixes come from ONE place: `_RESERVED_SIDECAR_SUFFIXES`
  (`lib/pipeline.py:224`). No new suffix literals.
- Default knob value: `pipelines.orphan_sidecar_action` unset → `prune`; a
  non-empty junk value or unreadable config → `report`.

---

### Task 1: `orphan_child_sidecars` detector + `orphans` CLI verb (`lib/pipeline.py`)

**Files:**
- Modify: `lib/pipeline.py` (add `_reserved_state_suffix`, `orphan_child_sidecars`
  near `_run_outcome_rel`/`_state_base` ~line 1795-1805; add the `orphans` verb in
  `main()` ~line 2892)
- Test: `tests/test_pipeline.py` (new `OrphanSidecarsTest` class)

**Interfaces:**
- Consumes: `_RESERVED_SIDECAR_SUFFIXES` (existing, line 224); `json`, `os`, `sys`
  (already imported).
- Produces:
  - `orphan_child_sidecars(repo) -> {"orphans": list[str], "unreadable": int}`
    (basenames of orphan sidecars, sorted; count of unreadable state files).
  - CLI `pipeline.py orphans <repo> [--prune]` → TAB rows `ORPHAN\t<name>` /
    `PRUNED\t<name>` / `UNREADABLE\t<n>`; rc 0 normal, 2 bad args, 1 hard listdir
    error.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_pipeline.py`:

```python
class OrphanSidecarsTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        self.logdir = os.path.join(self.repo, "var", "autonomy-logs")
        os.makedirs(self.logdir)

    def _sidecar(self, child_base, payload=None):
        p = os.path.join(self.logdir, ".pipeline-run-%s.outcome.json" % child_base)
        with open(p, "w") as fh:
            json.dump(payload or {"run_id": child_base, "outcome": "success"}, fh)
        return p

    def _state(self, base, units=None, raw=None):
        p = os.path.join(self.logdir, ".pipeline-run-%s.json" % base)
        with open(p, "w") as fh:
            if raw is not None:
                fh.write(raw)
            else:
                json.dump({"status": "in_progress", "units": units or {}}, fh)
        return p

    def test_missing_logdir_is_empty(self):
        shutil.rmtree(self.logdir)
        self.assertEqual(pipeline.orphan_child_sidecars(self.repo),
                         {"orphans": [], "unreadable": 0})

    def test_orphan_with_no_claim_is_flagged(self):
        self._sidecar("run1.c0.callX")
        res = pipeline.orphan_child_sidecars(self.repo)
        self.assertEqual(res["orphans"], [".pipeline-run-run1.c0.callX.outcome.json"])
        self.assertEqual(res["unreadable"], 0)

    def test_claimed_sidecar_not_flagged_no_lane(self):
        self._sidecar("run1.c0.callX")
        self._state("run1", units={"u1": {"status": "dispatched",
                                          "child": "run1.c0.callX"}})
        self.assertEqual(pipeline.orphan_child_sidecars(self.repo)["orphans"], [])

    def test_claimed_sidecar_not_flagged_with_lane(self):
        # sidecar carries --alpha; parent stores the LANE-LESS child + lane field
        self._sidecar("run1.c0.callX--alpha")
        self._state("run1--alpha", units={"u1": {"status": "dispatched",
                                                 "child": "run1.c0.callX"}})
        self.assertEqual(pipeline.orphan_child_sidecars(self.repo)["orphans"], [])

    def test_claim_survives_torn_lane_field(self):
        # lane field absent on the parent state, but the sidecar has --alpha:
        # lane-agnostic startswith() still claims it (fail-safe, CP1 #1)
        self._sidecar("run1.c0.callX--alpha")
        self._state("run1", units={"u1": {"child": "run1.c0.callX"}})
        self.assertEqual(pipeline.orphan_child_sidecars(self.repo)["orphans"], [])

    def test_child_claim_on_non_dispatched_unit(self):
        self._sidecar("run1.c0.callX")
        self._state("run1", units={"u1": {"status": "success",
                                          "child": "run1.c0.callX"}})
        self.assertEqual(pipeline.orphan_child_sidecars(self.repo)["orphans"], [])

    def test_unreadable_state_counted_no_partial_claim(self):
        self._sidecar("run1.c0.callX")
        self._state("run1", raw="{not json")
        res = pipeline.orphan_child_sidecars(self.repo)
        self.assertEqual(res["unreadable"], 1)
        self.assertEqual(res["orphans"], [".pipeline-run-run1.c0.callX.outcome.json"])

    def test_non_dict_units_is_unreadable(self):
        self._state("run1", raw='{"status":"in_progress","units":[]}')
        self.assertEqual(pipeline.orphan_child_sidecars(self.repo)["unreadable"], 1)

    def test_reserved_suffix_files_ignored(self):
        # a per-node outputs/verdict sidecar is neither a state nor an orphan
        with open(os.path.join(self.logdir,
                  ".pipeline-run-run1.nodeA.outputs.json"), "w") as fh:
            fh.write("{}")
        with open(os.path.join(self.logdir,
                  ".pipeline-run-run1.nodeA.verdict.json"), "w") as fh:
            fh.write("{}")
        self.assertEqual(pipeline.orphan_child_sidecars(self.repo),
                         {"orphans": [], "unreadable": 0})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest tests.test_pipeline.OrphanSidecarsTest -v`
Expected: FAIL — `AttributeError: module 'pipeline' has no attribute 'orphan_child_sidecars'`.

- [ ] **Step 3: Implement the detector**

Add after `_run_outcome_rel` (~line 1805) in `lib/pipeline.py`:

```python
def _reserved_state_suffix(name):
    """True when a .pipeline-run-*.json name is actually a reserved sidecar
    (.outputs/.verdict/.outcome) sharing the state-file glob -- not a run state."""
    stem = name[:-len(".json")]
    return stem.rsplit(".", 1)[-1] in _RESERVED_SIDECAR_SUFFIXES


def orphan_child_sidecars(repo):
    """Child-run outcome sidecars (.pipeline-run-<child-base>.outcome.json under
    <repo>/var/autonomy-logs) that NO live run state claims -- litter from a
    parent hand-deleted mid-wait or a wait:false detached child. Forward-claim,
    LANE-AGNOSTIC: a live parent stores the lane-less child in unit["child"]; the
    sidecar appends the lane after "--" (see _sweep_call_units). A sidecar core X
    is claimed iff some claimed lane-less child C has X == C or X.startswith(C+"--")
    -- the only error direction is over-claiming (under-prune), never fail-open.
    TOTAL over on-disk junk (prevention-log #12): a non-dict state/units/unit
    counts toward `unreadable` and contributes NO claims (fail-closed), never
    raises. Missing logdir is provably empty; any other listdir error propagates.
    Returns {"orphans": sorted[basename], "unreadable": int}."""
    logdir = os.path.join(repo, "var", "autonomy-logs")
    try:
        entries = os.listdir(logdir)
    except FileNotFoundError:
        return {"orphans": [], "unreadable": 0}
    claimed = set()
    unreadable = 0
    for name in entries:
        if not (name.startswith(".pipeline-run-") and name.endswith(".json")):
            continue
        if _reserved_state_suffix(name):
            continue
        try:
            with open(os.path.join(logdir, name), encoding="utf-8") as fh:
                state = json.load(fh)
            if not isinstance(state, dict):
                raise ValueError
            units = state.get("units")
            if not isinstance(units, dict):
                raise ValueError
            names = []
            for unit in units.values():
                if not isinstance(unit, dict):
                    raise ValueError
                if unit.get("child"):
                    names.append(unit["child"])
        except (OSError, ValueError):
            unreadable += 1
            continue
        claimed.update(names)
    orphans = []
    for name in entries:
        if not (name.startswith(".pipeline-run-")
                and name.endswith(".outcome.json")):
            continue
        x = name[len(".pipeline-run-"):-len(".outcome.json")]
        if not any(x == c or x.startswith(c + "--") for c in claimed):
            orphans.append(name)
    return {"orphans": sorted(orphans), "unreadable": unreadable}
```

- [ ] **Step 4: Run the detector tests to verify they pass**

Run: `python3 -m unittest tests.test_pipeline.OrphanSidecarsTest -v`
Expected: PASS (all 9).

- [ ] **Step 5: Write the failing CLI test**

Add to `OrphanSidecarsTest` in `tests/test_pipeline.py`:

```python
    def _run_cli(self, *args):
        import io, contextlib
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = pipeline.main(["orphans"] + list(args))
        return rc, out.getvalue()

    def test_cli_reports_without_pruning(self):
        p = self._sidecar("run1.c0.callX")
        rc, out = self._run_cli(self.repo)
        self.assertEqual(rc, 0)
        self.assertIn("ORPHAN\t.pipeline-run-run1.c0.callX.outcome.json", out)
        self.assertTrue(os.path.exists(p))          # report mode never deletes

    def test_cli_prune_removes_orphan_keeps_claimed(self):
        orphan = self._sidecar("run1.c0.callX")
        keep = self._sidecar("run2.c0.callY")
        self._state("run2", units={"u1": {"child": "run2.c0.callY"}})
        rc, out = self._run_cli(self.repo, "--prune")
        self.assertEqual(rc, 0)
        self.assertIn("PRUNED\t.pipeline-run-run1.c0.callX.outcome.json", out)
        self.assertFalse(os.path.exists(orphan))
        self.assertTrue(os.path.exists(keep))

    def test_cli_prune_held_back_when_unreadable(self):
        p = self._sidecar("run1.c0.callX")
        self._state("run1x", raw="{bad")
        rc, out = self._run_cli(self.repo, "--prune")
        self.assertEqual(rc, 0)
        self.assertIn("UNREADABLE\t1", out)
        self.assertIn("ORPHAN\t.pipeline-run-run1.c0.callX.outcome.json", out)
        self.assertTrue(os.path.exists(p))          # fail-closed: not pruned

    def test_cli_bad_args(self):
        rc, _ = self._run_cli()                     # no repo
        self.assertEqual(rc, 2)
```

- [ ] **Step 6: Run the CLI tests to verify they fail**

Run: `python3 -m unittest tests.test_pipeline.OrphanSidecarsTest -v`
Expected: FAIL — the `orphans` command falls through `main()` (prints usage, rc 2)
or the prune/PRUNED assertions fail.

- [ ] **Step 7: Implement the CLI verb**

In `lib/pipeline.py` `main()`, add a branch (e.g. right after the `wrap` branch,
~line 2905):

```python
    if cmd == "orphans":
        prune = "--prune" in rest
        pos = [a for a in rest if a != "--prune"]
        if len(pos) != 1:
            print("usage: pipeline.py orphans <repo> [--prune]", file=sys.stderr)
            return 2
        repo = pos[0]
        try:
            res = orphan_child_sidecars(repo)
        except OSError as exc:
            print("pipeline orphans: %s" % exc, file=sys.stderr)
            return 1
        if res["unreadable"]:
            print("UNREADABLE\t%d" % res["unreadable"])
        can_prune = prune and res["unreadable"] == 0
        logdir = os.path.join(repo, "var", "autonomy-logs")
        for name in res["orphans"]:
            if can_prune:
                try:
                    os.unlink(os.path.join(logdir, name))
                    print("PRUNED\t%s" % name)
                    continue
                except OSError:
                    pass
            print("ORPHAN\t%s" % name)
        return 0
```

- [ ] **Step 8: Run all Task 1 tests to verify they pass**

Run: `python3 -m unittest tests.test_pipeline.OrphanSidecarsTest -v`
Expected: PASS (all 13).

- [ ] **Step 9: Commit**

```bash
git add lib/pipeline.py tests/test_pipeline.py
git commit -m "feat(#378): orphan_child_sidecars detector + orphans CLI verb"
```

---

### Task 2: Make the knob editable from the config page (`lib/dashboard_control.py`)

**Files:**
- Modify: `lib/dashboard_control.py` (`CONFIG_PAGE_KEYS` dict, ~line 132-142)
- Test: `tests/test_dashboard_control.py`

**Interfaces:**
- Consumes: existing `CONFIG_PAGE_KEYS` / `config_set_plan` machinery.
- Produces: `pipelines.orphan_sidecar_action` accepted by `config_set_plan`
  (returns a `live_set` for off/report/prune; `{"error": …}` for junk).

- [ ] **Step 1: Write the failing test**

Add to the relevant test class in `tests/test_dashboard_control.py` (find the class
that tests `config_set_plan`; mirror its `self.repo` setup):

```python
    def test_orphan_sidecar_action_is_page_editable(self):
        for v in ("off", "report", "prune"):
            r = dashboard_control.config_set_plan(
                self.repo, "pipelines.orphan_sidecar_action", v)
            self.assertEqual(r.get("live_set"),
                             {"pipelines.orphan_sidecar_action": v})
        bad = dashboard_control.config_set_plan(
            self.repo, "pipelines.orphan_sidecar_action", "wipe")
        self.assertIn("error", bad)
```

(If no existing class sets `self.repo`, add a small class:
`self.repo = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, self.repo, True)`.)

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m unittest tests.test_dashboard_control -v -k orphan`
Expected: FAIL — `config_set_plan` returns `{"error": "key ... is not editable"}`.

- [ ] **Step 3: Add the allowlist entry**

In `lib/dashboard_control.py`, inside `CONFIG_PAGE_KEYS` (before the closing `}`):

```python
    # #378: the orphan run-outcome sidecar sweep policy (off/report/prune) --
    # read by doctor.sh + worktree_gc.sh; lands in the var-live shadow.
    "pipelines.orphan_sidecar_action": lambda v: v in ("off", "report", "prune"),
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 -m unittest tests.test_dashboard_control -v -k orphan`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard_control.py tests/test_dashboard_control.py
git commit -m "feat(#378): allow pipelines.orphan_sidecar_action from the config page"
```

---

### Task 3: `doctor.sh` report (`bin/doctor.sh`)

**Files:**
- Modify: `bin/doctor.sh` (add `doctor_orphan_sidecars_report` after
  `doctor_triggers_report` ~line 386; call it in `doctor_full_report` after
  line 449)
- Test: `tests/test_doctor.sh`

**Interfaces:**
- Consumes: `pipeline.py orphans <repo>` (Task 1); `config_parser.py` (shadow-aware);
  `$DOCTOR_HOME`.
- Produces: `doctor_orphan_sidecars_report <repo>` — INFO/WARN lines, always rc 0.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_doctor.sh` (before any final summary):

```bash
# --- orphan sidecar report (#378) ---
orp="$(mktemp -d)"
mkdir -p "$orp/.autonomy" "$orp/var/autonomy-logs"
printf 'engine:\n  default_branch: main\n' > "$orp/.autonomy/config.yaml"
printf '{"run_id":"x","outcome":"success"}' \
  > "$orp/var/autonomy-logs/.pipeline-run-run1.c0.callX.outcome.json"

# default (unset) -> doctor reports the orphan (WARN)
msg="$(doctor_orphan_sidecars_report "$orp" 2>&1 || true)"
check "orphan reported as WARN" "0" \
  "$(printf '%s' "$msg" | grep -q 'WARN orphan run-outcome sidecar' && echo 0 || echo 1)"

# action=off -> disabled INFO, no WARN
printf 'pipelines:\n  orphan_sidecar_action: "off"\n' >> "$orp/.autonomy/config.yaml"
msg="$(doctor_orphan_sidecars_report "$orp" 2>&1 || true)"
check "off -> disabled INFO" "0" \
  "$(printf '%s' "$msg" | grep -q 'sweep disabled' && echo 0 || echo 1)"
check "off -> no WARN" "1" \
  "$(printf '%s' "$msg" | grep -q 'WARN orphan' && echo 0 || echo 1)"
rm -rf "$orp"
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash tests/test_doctor.sh`
Expected: FAIL — `doctor_orphan_sidecars_report: command not found` / check mismatch.

- [ ] **Step 3: Implement the function**

Add after `doctor_triggers_report` (~line 386) in `bin/doctor.sh`:

```bash
# orphan run-outcome sidecars (#378): report-only. doctor is READ-ONLY -- only
# `off` changes behavior; prune/report/unset/junk all just report. Best-effort:
# INFO/WARN, never FAILs the report. Capture-first (pipefail, prevention-log #7).
doctor_orphan_sidecars_report() {
  local repo="$1" _action _out _tag _val
  _action="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" pipelines.orphan_sidecar_action 2>/dev/null || echo prune)"
  case "$_action" in
    off) echo "INFO orphan run-outcome sidecar sweep disabled (pipelines.orphan_sidecar_action=off)"; return 0 ;;
  esac
  _out="$(python3 "$DOCTOR_HOME/lib/pipeline.py" orphans "$repo" 2>/dev/null)" \
    || { echo "INFO could not sweep run-outcome sidecars -- skipping"; return 0; }
  if [ -z "$_out" ]; then
    echo "INFO no orphan run-outcome sidecars"
    return 0
  fi
  while IFS=$'\t' read -r _tag _val; do
    case "$_tag" in
      ORPHAN)     echo "WARN orphan run-outcome sidecar (no parent awaiting it): $_val" ;;
      UNREADABLE) echo "INFO $_val unreadable pipeline state file(s) -- orphan detection is partial" ;;
    esac
  done <<EOF
$_out
EOF
  return 0
}
```

- [ ] **Step 4: Wire it into `doctor_full_report`**

In `bin/doctor.sh`, after line 449 (`doctor_triggers_report "$repo"`), add:

```bash
  doctor_orphan_sidecars_report "$repo"
```

- [ ] **Step 5: Run to verify it passes + shellcheck**

Run: `bash tests/test_doctor.sh && shellcheck -S warning bin/doctor.sh tests/test_doctor.sh`
Expected: all checks pass, shellcheck silent.

- [ ] **Step 6: Commit**

```bash
git add bin/doctor.sh tests/test_doctor.sh
git commit -m "feat(#378): doctor reports orphan run-outcome sidecars (config-gated)"
```

---

### Task 4: `worktree_gc.sh` prune section + test (`bin/worktree_gc.sh`, `tests/test_worktree_gc.sh`)

**Files:**
- Modify: `bin/worktree_gc.sh` (insert the sweep after `git worktree prune -v`
  ~line 37, BEFORE the fetch/branch block — it is local and must not be gated on
  the network, CP1 #5)
- Create: `tests/test_worktree_gc.sh` (auto-discovered by `run_all.sh`)

**Interfaces:**
- Consumes: `pipeline.py orphans <repo> [--prune]` (Task 1); `config_parser.py`;
  `$ENGINE_HOME` (already set at line 28); `$REPO`.
- Produces: a named prune section honoring `pipelines.orphan_sidecar_action`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_worktree_gc.sh`:

```bash
#!/usr/bin/env bash
# Unit test for worktree_gc.sh's orphan run-outcome sidecar sweep (#378).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GC="$HERE/../bin/worktree_gc.sh"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); \
  echo "FAIL: $1 (want '$2' got '$3')"; fi; }

# A git repo (worktree_gc runs git; a real empty repo keeps it happy). The
# sidecar sweep runs BEFORE the fetch gate, so no origin is needed.
mkrepo() {
  local d; d="$(mktemp -d)"
  ( cd "$d" && git init -q && git commit -q --allow-empty -m init ) >/dev/null 2>&1
  mkdir -p "$d/.autonomy" "$d/var/autonomy-logs"
  printf 'engine:\n  default_branch: main\n' > "$d/.autonomy/config.yaml"
  echo "$d"
}
orphan() { printf '{"run_id":"x","outcome":"success"}' \
  > "$1/var/autonomy-logs/.pipeline-run-$2.outcome.json"; }

# action=prune (default) -> the orphan is named + removed
d="$(mkrepo)"; orphan "$d" "run1.c0.callX"
out="$(bash "$GC" --repo "$d" 2>&1 || true)"
check "prune names the sidecar" "0" \
  "$(printf '%s' "$out" | grep -q 'pruned orphan sidecar: .pipeline-run-run1.c0.callX.outcome.json' && echo 0 || echo 1)"
check "prune actually removes it" "1" \
  "$([ -e "$d/var/autonomy-logs/.pipeline-run-run1.c0.callX.outcome.json" ] && echo 0 || echo 1)"
rm -rf "$d"

# action=report -> named but NOT removed
d="$(mkrepo)"; orphan "$d" "run1.c0.callX"
printf 'pipelines:\n  orphan_sidecar_action: report\n' >> "$d/.autonomy/config.yaml"
out="$(bash "$GC" --repo "$d" 2>&1 || true)"
check "report names it" "0" \
  "$(printf '%s' "$out" | grep -q 'orphan sidecar (report-only)' && echo 0 || echo 1)"
check "report leaves it on disk" "0" \
  "$([ -e "$d/var/autonomy-logs/.pipeline-run-run1.c0.callX.outcome.json" ] && echo 0 || echo 1)"
rm -rf "$d"

# action=off -> section skipped, nothing removed
d="$(mkrepo)"; orphan "$d" "run1.c0.callX"
printf 'pipelines:\n  orphan_sidecar_action: "off"\n' >> "$d/.autonomy/config.yaml"
out="$(bash "$GC" --repo "$d" 2>&1 || true)"
check "off -> disabled line" "0" \
  "$(printf '%s' "$out" | grep -q 'sweep disabled' && echo 0 || echo 1)"
check "off leaves it on disk" "0" \
  "$([ -e "$d/var/autonomy-logs/.pipeline-run-run1.c0.callX.outcome.json" ] && echo 0 || echo 1)"
rm -rf "$d"

# unreadable state holds the prune back
d="$(mkrepo)"; orphan "$d" "run1.c0.callX"
printf '{bad' > "$d/var/autonomy-logs/.pipeline-run-run9.json"
out="$(bash "$GC" --repo "$d" 2>&1 || true)"
check "unreadable -> SKIP not-pruning line" "0" \
  "$(printf '%s' "$out" | grep -q 'not pruning' && echo 0 || echo 1)"
check "unreadable -> orphan survives" "0" \
  "$([ -e "$d/var/autonomy-logs/.pipeline-run-run1.c0.callX.outcome.json" ] && echo 0 || echo 1)"
rm -rf "$d"

echo "worktree_gc orphan sweep: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash tests/test_worktree_gc.sh`
Expected: FAIL — no sweep output yet (grep misses; prune checks fail).

- [ ] **Step 3: Implement the sweep section**

In `bin/worktree_gc.sh`, immediately after `git worktree prune -v` (line 37) and
before the `echo "== delete local branches ..."` block, insert:

```bash
# orphan run-outcome sidecar sweep (#378): LOCAL, so it runs BEFORE the fetch
# gate below (which exit 0s on a network failure). Config-driven + fail-closed;
# `off`+junk never prune (prevention-log #6); reader total under set -e (#17).
_action="$(python3 "$ENGINE_HOME/lib/config_parser.py" "$REPO/.autonomy/config.yaml" pipelines.orphan_sidecar_action 2>/dev/null || echo report)"
case "$_action" in off|report|prune) ;; "") _action=prune ;; *) _action=report ;; esac
if [ "$_action" = "off" ]; then
  echo "== orphaned pipeline run-outcome sidecars: sweep disabled (pipelines.orphan_sidecar_action=off) =="
else
  echo "== orphaned pipeline run-outcome sidecars (pipelines.orphan_sidecar_action=$_action) =="
  _oflag=""; [ "$_action" = "prune" ] && _oflag="--prune"
  if ! _osweep="$(python3 "$ENGINE_HOME/lib/pipeline.py" orphans "$PWD" $_oflag 2>/dev/null)"; then
    echo "  SKIP: could not sweep run-outcome sidecars (logdir unreadable) -- nothing pruned"
  else
    _opruned=0
    while IFS=$'\t' read -r _otag _oval; do
      case "$_otag" in
        PRUNED)     echo "  pruned orphan sidecar: $_oval"; _opruned=$((_opruned + 1)) ;;
        ORPHAN)     echo "  orphan sidecar (report-only): $_oval" ;;
        UNREADABLE) echo "  SKIP: $_oval unreadable state file(s) -- not pruning (a corrupt live parent may still own a sidecar)" ;;
      esac
    done <<EOF
$_osweep
EOF
    [ "$_action" = "prune" ] && echo "  ($_opruned orphan sidecar(s) removed)"
  fi
fi
```

(`$PWD` is the repo — the script `cd "$REPO"` at line 34, above this insertion.
Passing `"$PWD"` keeps the python path correct if `$REPO` was relative.)

- [ ] **Step 4: Run to verify it passes + shellcheck**

Run: `bash tests/test_worktree_gc.sh && shellcheck -S warning bin/worktree_gc.sh tests/test_worktree_gc.sh`
Expected: `4 ... passed, 0 failed` (8 checks), shellcheck silent.

Note: the unquoted `$_oflag` is intentional (empty must vanish, not become an empty
arg). If shellcheck flags SC2086 on that line, add
`# shellcheck disable=SC2086` with a one-line "intentional empty-flag expansion"
justification directly above it (prevention-log #19: annotate at write time).

- [ ] **Step 5: Commit**

```bash
git add bin/worktree_gc.sh tests/test_worktree_gc.sh
git commit -m "feat(#378): worktree_gc prunes orphan run-outcome sidecars (config-gated)"
```

---

### Task 5: Config-page toggle UI (`lib/config_page.html`) + browser verify

**Files:**
- Modify: `lib/config_page.html` (add a `<select>` for the knob beside the
  operational knobs; ensure its current value is surfaced from the config payload)
- Possibly modify: the config payload builder in `lib/dashboard_state.py` or
  `lib/dashboard_control.py` IF the knob's current value is not already in the
  payload the page reads.

**Interfaces:**
- Consumes: the `config_set` save path (Task 2 made the key writable); the config
  payload the page already renders.
- Produces: an off/report/prune dropdown that persists to the var-live shadow.

**REQUIRED SUB-SKILL:** Use the `dashboard` skill (control-room architecture +
chrome-devtools browser verify loop) for this whole task.

- [ ] **Step 1: Read the operational-knob section**

Read `lib/config_page.html` around the `agent.effort` / `merge_gate.strategy`
selects (grep `data-key=` and `modelSelectOptions`). Identify (a) the markup
pattern for a `<select class="cfgin" data-key="...">`, (b) how the current value
is read from the config payload (e.g. `co.effort`), (c) the save handler the
select's `onchange`/save button calls (the generic `config_set` POST).

- [ ] **Step 2: Confirm the payload carries the current value**

Grep the payload builder for how `merge_gate.strategy` / `agent.effort` reach the
page. If there is a generic config projection, confirm `pipelines.orphan_sidecar_action`
is included; if the projection is an explicit allowlist, add the key there
(defaulting to `prune` when unset) and add a `dashboard_state`/`dashboard_control`
unit test asserting the value is surfaced. If it is already generic, no code
change — note that in the commit.

- [ ] **Step 3: Add the select**

Beside the operational knobs, mirroring the `agent.effort` select, add (adapt the
enclosing markup to the section you found in Step 1):

```html
<label class="cfgrow">orphan sidecar sweep
  <select class="cfgin" data-key="pipelines.orphan_sidecar_action"
          onchange="saveCfgKey(this)">
    <option value="prune">prune (default — reclaim litter)</option>
    <option value="report">report only</option>
    <option value="off">off</option>
  </select>
</label>
```

Seed the selected option from the payload's current value (unset → `prune`), using
the same `selected` pattern the sibling selects use (`${v===cur?" selected":""}`).
Use the real save function name found in Step 1 (shown here as `saveCfgKey`).

- [ ] **Step 4: Browser verify (dashboard skill loop)**

Per the dashboard skill: kill the port-8787 dashboard pid so the console watchdog
relaunches with the new code (never start a competing server — operator-console-runner
note). Then, with chrome-devtools:
- The select renders with the current knob value selected.
- Change it to `report`; confirm the POST hits `/api/control` and the
  "local override" badge appears; reload → the new value persists (read from
  `var/autonomy/config.yaml`).
- Temporal pass: idle the panel; assert no per-tick `innerHTML` churn on the
  config panel (prevention-log #13/#14) and `steadyStateCLS < 0.01`.

- [ ] **Step 5: Commit**

```bash
git add lib/config_page.html   # + any payload-builder file touched in Step 2
git commit -m "feat(#378): config-page toggle for the orphan sidecar sweep policy"
```

---

## Final verification (before the PR — pre-push-checklist)

- [ ] `bash tests/run_all.sh` — the whole suite green (includes the new
  `test_worktree_gc.sh`, auto-discovered).
- [ ] `shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh` — clean.
- [ ] `python3 -m unittest tests.test_pipeline tests.test_dashboard_control -v` — green.
- [ ] pre-flight-review skill self-review; **Codex CP2** on the full branch diff
  (before the first push).
- [ ] Dashboard browser verify loop complete (Task 5).
- [ ] PR per pr-authoring (security model section: the sweep only unlinks
  provably-unclaimed sidecars; config value re-gated; no argv/log secret exposure;
  #378 STAYS OPEN if this is the last slice → verify `closingIssuesReferences`).

## Self-review (plan vs spec)

- **Spec coverage:** knob + resolution (Task 3/4 case gates) · detector
  lane-agnostic match (Task 1) · totality/unreadable (Task 1) · CLI TAB contract
  (Task 1) · doctor report + off (Task 3) · gc prune before fetch gate + off +
  rc-1 SKIP (Task 4) · site allowlist (Task 2) + select (Task 5) · reserved-suffix
  reuse (Task 1) — all mapped.
- **Type consistency:** `orphan_child_sidecars(repo) -> {"orphans","unreadable"}`
  and the `ORPHAN/PRUNED/UNREADABLE` TAB tags are identical across Tasks 1/3/4.
- **Placeholders:** none — every code step carries real code; Task 5's
  save-function name is explicitly "use the name found in Step 1" because it is
  read from live HTML, not invented.
```
