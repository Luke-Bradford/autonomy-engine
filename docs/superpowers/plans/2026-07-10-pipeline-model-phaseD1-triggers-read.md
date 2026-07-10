# Phase D1 — dashboard learns triggers: read + marker lifecycle — Implementation Plan

> **Audience note (engineering record):** build plan for the engine's own
> development loop. Vocabulary decodes via
> `.claude/skills/engineering/pipelines.md` (SD-N, prevention-log #N, CP1-3).

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** the dashboard renders TRIGGERS (cards, trust, runs incl. children +
`@slot`, gallery, REFUSED→needs-you, fleet-rail re-list) and drives the
supervisor's existing lane-scoped `fire`/`stop` markers through
`POST /api/control` — per spec
`docs/superpowers/specs/2026-07-10-pipeline-model-phaseD1-triggers-read.md`
(CP1-hardened; scope lines §2 are veto items recorded on #383).

**Architecture:** one new totality builder `build_triggers_view` +
runs-scanner in `lib/dashboard_state.py`; one new READ route
`GET /api/triggers`; three new `/api/control` actions with a pure planner in
`lib/dashboard_control.py` and `execute_control`-style lane routing in
`bin/dashboard.py`; page work in `lib/pipeline_page.html` (tabs) +
`lib/dashboard_page.html` (rail/chip/needs-you). `bin/supervisor.sh`
UNTOUCHED.

**Tech Stack:** Python 3 stdlib, vanilla JS single-file pages, unittest +
sourced-script shell tests, shellcheck -S warning, chrome-devtools browser
verify.

## Global Constraints

- bash 3.2.57 floor (test files too); Python stdlib only; repo-agnostic
  `bin//lib/`; every shell script source-guarded.
- Fail-safe never fail-open: builder errors render as errors (never healthy
  fallback); refused triggers stay refused; healthy verdicts EARNED
  (prevention-log #18); corrupt supervisor-owned markers degrade to an error
  chip, never to absence.
- `bin/safe_merge.sh`, `.github/workflows/**`, `bin/supervisor.sh` untouched.
- Dashboard security contract (skill): loopback only, one write endpoint,
  token gauntlet, server-side re-validation, hostile render data (esc() +
  delegated `data-*`), no raw tracebacks in HTTP bodies.
- Recurring-tick renders need skip-unchanged guards (prevention-log #13/#14);
  no closing keyword for #383 in any commit/PR text (prevention-log #20).
- Loops stay PAUSED.

---

### Task 1: repo-alpha fixtures + full-suite audit

**Files:**
- Create: `tests/fixtures/repo-alpha/.autonomy/triggers/adhoc-digest.json`,
  `tests/fixtures/repo-alpha/.autonomy/triggers/pr-sweep.json`,
  `tests/fixtures/repo-alpha/var/autonomy-logs/.pipeline-run-adhoc-digest.json`,
  `tests/fixtures/repo-alpha/var/autonomy-logs/.pipeline-run-adhoc-digest.c0.qa.json`,
  `tests/fixtures/repo-alpha/var/autonomy-logs/.pipeline-run-pr-sweep@1.json`
- Modify: `tests/fixtures/repo-alpha/var/autonomy-logs/journal.jsonl` (append 2 lines)

**Interfaces — Produces:** deterministic fixture states every later task's
tests read. No `run_windows`, no `var/trigger-ctl/` markers (spec §7).

- [ ] Step 1: write the trigger files.

```json
// adhoc-digest.json
{"name": "adhoc-digest", "pipeline": "fixture-flow",
 "firing": {"mode": "manual"},
 "concurrency": {"policy": "skip", "max": 1}}
// pr-sweep.json
{"name": "pr-sweep", "pipeline": "fixture-flow", "enabled": false,
 "firing": {"mode": "continuous"},
 "concurrency": {"policy": "parallel", "max": 2}}
```

- [ ] Step 2: state files. Parent (in-flight, embedded doc — copy the shape
  `ChildRunToleranceTest` uses, with Phase B identity fields):

```json
// .pipeline-run-adhoc-digest.json
{"fmt": 2, "run_id": "adhoc-digest-20260709T220000-7001",
 "trigger": "adhoc-digest", "kind": "native", "role": "adhoc-digest",
 "lane": "", "params": {}, "status": "in_progress", "sessions": 1,
 "doc": {"name": "fixture-flow", "nodes": [{"id": "pick", "type": "pick",
         "brief_ref": "pick.md"}]},
 "units": {"pick": {"status": "dispatched"}}}
// .pipeline-run-adhoc-digest.c0.qa.json  (child)
{"fmt": 2, "run_id": "adhoc-digest.c0.qa-7002",
 "trigger": "adhoc-digest.c0.qa", "kind": "native",
 "role": "adhoc-digest.c0.qa", "lane": "",
 "parent_run": "adhoc-digest-20260709T220000-7001", "parent_node": "qa",
 "call_depth": 1, "status": "in_progress", "sessions": 1,
 "doc": {"name": "fixture-flow", "nodes": [{"id": "pick", "type": "pick",
         "brief_ref": "pick.md"}]},
 "units": {"pick": {"status": "dispatched"}}}
// .pipeline-run-pr-sweep@1.json  (slot row)
{"fmt": 2, "run_id": "pr-sweep-20260709T230000-7003",
 "trigger": "pr-sweep", "kind": "native", "role": "pr-sweep", "lane": "",
 "params": {}, "status": "in_progress", "sessions": 2,
 "doc": {"name": "fixture-flow", "nodes": [{"id": "pick", "type": "pick",
         "brief_ref": "pick.md"}]},
 "units": {"pick": {"status": "dispatched"}}}
```

- [ ] Step 3: journal appends (trigger-keyed — role ≠ `coder`, so the
  coder/fixture-flow `_journal_last_run`/ledger pins stay untouched):

```json
{"finished": 1751879100, "started": 1751878200, "lane": "", "nodes": [{"id": "pick", "outcome": "success", "session_log": "session-20260707T080000.log", "type": "pick", "unit": "pick", "via": []}], "outcome": "success", "pass": true, "pipeline": "fixture-flow", "pipeline_version": 2, "role": "adhoc-digest", "trigger": "adhoc-digest", "kind": "native", "run_id": "adhoc-digest-20260707T080000-6001", "sessions": 2, "wrapped": false}
{"finished": 1751879400, "started": 1751879100, "lane": "", "nodes": [{"id": "pick", "outcome": "success", "session_log": "session-20260707T081000.log", "type": "pick", "unit": "pick", "via": []}], "outcome": "success", "pass": true, "pipeline": "fixture-flow", "pipeline_version": 2, "role": "adhoc-digest.c0.qa", "trigger": "adhoc-digest.c0.qa", "kind": "native", "parent_run": "adhoc-digest-20260707T080000-6001", "run_id": "adhoc-digest.c0.qa-6002", "sessions": 1, "wrapped": false}
```

- [ ] Step 4 (AUDIT, spec §7): `bash tests/run_all.sh` — must be `ALL SUITES
  PASS` with ONLY the fixtures added and ZERO pin updates (CP1: fixtures
  must be invisible to every existing assertion; a conflicting pin means
  the fixture moves to a tmp copy in this same commit — existing pins are
  only allowed to change in Task 11 where the rail intentionally changes).
- [ ] Step 5: commit `test(fixtures): repo-alpha native triggers + child/@slot run states (#383 D1)`.

### Task 2: `lib/triggers.py` — `trust_rollup(trigs=)` kwarg + `marker_basename`

**Files:** Modify `lib/triggers.py:448`; Test `tests/test_triggers.py`.

**Interfaces — Produces:**
- `trust_rollup(repo, journal_path, trigs=None)` — `trigs` = the
  `(triggers, warnings)` TUPLE from a prior
  `enumerate_triggers(repo, dispatchable_only=False)` call; `None` (default,
  CLI path) re-enumerates. Return shape unchanged: `(rows, rollup, warnings)`.
- `marker_basename(name, lane_suffix)` — the ONE python twin of
  `_trigger_ctl_path`'s basename rule: `<name>` when `lane_suffix` falsy,
  else `<name>--<lane_suffix>`; raises `PipelineError` on charset-invalid
  name OR lane (prevention-log #6). Lives HERE (trigger domain) so BOTH
  `dashboard_state` (read side) and `dashboard_control` (write side)
  consume one source — no cross-import between the two dashboard modules
  (CP1 ownership finding).

- [ ] Failing tests: preload equals no-kwarg call + counting stub proves no
  second enumeration; junk `trigs` ignored (re-enumerates — total reader);
  `marker_basename` matrix (bare, suffixed, bad charset raises).
- [ ] Implement; `python3 -m unittest tests.test_triggers -v` green; commit.

### Task 3: runs scanner — `_parse_run_token` + `list_runs`

**Files:** Modify `lib/dashboard_state.py` (new helpers near
`_inflight_units`); Test `tests/test_dashboard_state.py`.

**Interfaces — Produces:**
- `_parse_run_token(base)` → `{"token", "name", "lane", "slot", "child": bool,
  "parent": str|None}` or `None` for reserved sidecar suffixes
  (`.outputs/.verdict/.outcome`). Parse ORDER is canonical (matches
  `inflight_tokens` + `_child_token_name`): strip `@<digits>` slot from the
  END, then `--<lane>`; child = name contains `.c<digits>.` (parent = the
  part before it).
- `list_runs(logdir, journal_path, limit=20)` → list of run rows (spec §3.1
  `runs` shape): in-flight rows from `.pipeline-run-*.json` (state fields
  `trigger` (fallback `role`), `kind`, `status`, `run_id`, `sessions`,
  `parent_run`, `doc.name`), then up to `limit` journal rows from a 64KiB
  reversed tail (`_journal_last_run` pattern), newest-first. Corrupt state →
  `{"status": "unreadable", ...}` row. Total: never raises.

- [ ] Failing tests: token parse matrix (`adhoc-digest`, `pr-sweep@1`,
  `x--qa@2` → lane qa slot 2, `p.c0.qa`, `x.outputs` → None, junk `@@` /
  `@x` non-digit slot → treated as plain name chars refused by charset);
  fixture scan finds the 3 repo-alpha states + 2 journal rows w/ child
  linkage; corrupt tmp state degrades.
- [ ] Implement; suite green; commit.

### Task 4: `build_triggers_view(repo_path, now=None)`

**Files:** Modify `lib/dashboard_state.py`; Test `tests/test_dashboard_state.py`.

**Interfaces — Consumes:** `triggers.enumerate_triggers/trust_rollup(trigs=)/
in_run_window/marker_basename`, `pipeline.resolve_params/
effective_pipeline_dir/load_doc/validate_doc`, Task 3. **Produces:** the
spec §3.1 payload dict, plus the PUBLIC fire-readiness helper Task 8 reuses
byte-identically (CP1 read/write-drift finding):

```python
def trigger_fire_ready(repo_path, trig):
    """(ok: bool, reason: str|None). Manual mode only; resolves the
    trigger's pipeline doc (effective_pipeline_dir / wrap-shaped for
    pipeline "" via the same resolution build_triggers_view uses) and dry-
    runs pipeline.resolve_params(declared, trig["params"]). ANY exception
    -> (False, short reason). Total, never raises."""
```

Marker reads per trigger (read side scans the ASKED repo's
`var/trigger-ctl/`): `stopped`/`fire_pending`/`queued` = isfile;
`backoff` = parse `epoch\tcount` → dict; PRESENT-but-unparseable →
`{"error": "unreadable"}` (CP1 — never healthy absence).
`fire_ready`: manual mode only — dry
`pipeline.resolve_params(doc_params, trig["params"])` in try/except
`Exception` → `(False, reason)`; doc unreadable → `(False, "pipeline
unreadable: …")`; non-manual → `(False, "run-now applies to manual-mode
triggers (D2 extends)")`.
Gallery `pipelines`: union of committed+shadow dir stems (reuse the
`_trigger_stems` pattern against `.autonomy/pipelines` + shadow) + wrapped
entries for shim triggers with `pipeline: ""`; each loaded via
`effective_pipeline_dir` → `{name, version, source, valid, errors, nodes,
triggers, tier}`.

- [ ] Failing tests: fixture happy path (3 triggers: coder shim continuous +
  adhoc-digest manual + pr-sweep disabled; rollup fixture-flow watch;
  adhoc-digest `fire_ready` True); EXPLICIT floor assertion: a
  disabled-zero-run trigger (pr-sweep) alone forces its pipeline's rollup to
  `watch` even when every OTHER trigger reads `auto` (tmp journal — CP1:
  the fixture's happy path must not be the only rollup coverage); tmp
  copies for: REFUSED trigger file →
  `refused` + trigger absent; markers (stop/fire/queued/backoff incl.
  corrupt backoff → error chip); `run_windows` + injected `now` →
  `window_open` False; unreadable config → top-level `error`, empty lists;
  every-external-call-guarded (garbage doc dir → pipelines row w/ errors,
  view still returns — prevention-log #21 sibling scan).
- [ ] Implement; suite green; commit.

### Task 5: `build_repo_state` additive keys + `trigger_health` natives

**Files:** Modify `lib/dashboard_state.py:2324` region + `trigger_health`;
Test `tests/test_dashboard_state.py`.

**Interfaces — Produces:** `st["triggers"]` light rows `{name, kind,
pipeline, mode, enabled, lane, window_open, tier, stopped, missed_fire}`;
`st["trust"] = {"rollup": {...}, "refused": [...]}` or `{"error": ...}`.
`trigger_health(config, cron_dir, now, grace_secs=300, schedule_triggers=None)`
— additive kwarg: list of `{name, schedule}` for NATIVE schedule triggers.
Row shape (CP1): existing rows keep the historical `role` key untouched;
EVERY row additionally gains `kind` (`"role"`/`"native"`); dedup by name —
a native superseding a same-name cron role yields ONE row (the enumeration
one; both read the same `var/cron/<name>.last_fire` marker so the verdict
is identical either way). Task 5's fold joins `st["triggers"]` rows by the
`role` key value.

- [ ] Failing tests: fixture rows present + `roles` key untouched; unreadable
  config → `trust.error` + rail fallback contract (`triggers` empty);
  native schedule trigger w/ stale `var/cron/<name>.last_fire` in a tmp repo
  → missed_fire flagged; name-collision not double-reported.
- [ ] Implement; suite green; commit.

### Task 6: `build_pipeline_view` by-`name` / by-`token`

**Files:** Modify `lib/dashboard_state.py:2553`; Test
`tests/test_dashboard_state.py`.

**Interfaces — Produces:** `build_pipeline_view(repo_path, role=None,
name=None, token=None)` — positional back-compat (`role` stays arg 2).
`name=`: resolve via `valid_pipeline_name` gate → `effective_pipeline_dir`
→ load/validate; `source.kind` committed/shadow; `ledger: None`;
`in_flight: None` unless `token=`. `token=`: validate via
`_parse_run_token` (reserved suffix / junk → error field); read
`.pipeline-run-<token>.json`; render the run's EMBEDDED `doc` + units +
`parent_run` + `parent_node` (breadcrumb fields `run: {token, parent_run,
parent_node, trigger, status}`). Exactly one of role/name/token; ambiguous →
error field.

- [ ] Failing tests: by-name fixture-flow (version 2, edges synthesized);
  by-token fixture child (child doc + parent_run surfaced); token grammar
  matrix (CP1): `x--qa@2` accepted, `x@bad`/`x@@` refused, reserved sidecar
  suffixes refused; the fixture's MINIMAL embedded doc (no caps/edges)
  renders as DEGRADED truth — `errors` populated, doc visible, never a
  healthy canvas (CP1: token views must not skip validation); role path
  byte-identical to before (existing 16 tests stay green).
- [ ] Implement; suite green; commit.

### Task 7: `trigger_ctl_plan` planner

**Files:** Modify `lib/dashboard_control.py`; Test
`tests/test_dashboard_control.py`.

**Interfaces — Produces:**

```python
TRIGGER_CTL_ACTIONS = ("trigger_fire", "trigger_stop", "trigger_resume")

def trigger_ctl_plan(marker_repo, action, name, lane_suffix=""):
    """Pure plan for a per-trigger marker write. marker_repo = the VERIFIED
    consuming supervisor's repo (caller resolves lanes via
    find_lane_service, execute_control-style). lane_suffix = "" or the
    non-default lane name. Returns {"touch": path} / {"remove": path} /
    {"error": reason}. Charset gates BOTH name and lane_suffix
    (prevention-log #6); never joins an ungated string."""
```

fire → touch `var/trigger-ctl/fire/<base>`; stop → touch
`.../stop/<base>`; resume → remove `.../stop/<base>`; `<base>` =
`triggers.marker_basename(name, lane_suffix)` (Task 2 — the one shared
rule; its PipelineError becomes the plan's `{"error": …}`). Planner does
NOT check mode/fire_ready — that's the caller's enumeration-derived
validation (Task 8); planner is path mechanics only.

- [ ] Failing tests: plan matrix (paths byte-expected incl. lane suffix),
  charset refusals (`../x`, empty, reserved-suffix name), unknown action.
- [ ] Implement; suite green; commit.

### Task 8: routes + `execute_trigger_ctl` + action whitelist

**Files:** Modify `bin/dashboard.py`; Test `tests/test_dashboard_server.py`.

**Interfaces — Consumes:** Tasks 4/6/7. **Produces:**
- `GET /api/triggers?repo=` — managed-repo gate (mirror `/api/pipeline`
  handler at `dashboard.py:1461`), returns `build_triggers_view(repo)`.
- `/api/pipeline` passes through `name`/`token` query params (server-side
  charset pre-gate, then builder discipline).
- `do_POST` whitelist grows `dcx.TRIGGER_CTL_ACTIONS`; dispatcher calls
  `execute_trigger_ctl(repo, action, name)`:
  1. managed-repo gate (existing).
  2. `enumerate_triggers(repo, dispatchable_only=False)` (in a try —
     unreadable config → `{"ok": False, "error": ...}`); find `name` →
     absent → refuse `"unknown trigger"`.
  3. `el = trig.lane or default_lane(cfg)`; `el` not in declared lanes →
     refuse (spec §4). Routing table (CP1 — `find_lane_service`'s THREE
     returns are distinct):
     - `el == default_lane` → `marker_repo=repo`, `lane_suffix=""` (the
       default supervisor runs with `AUTONOMY_LANE=""`; never call
       find_lane_service).
     - else `svc = dcx.find_lane_service(repo, el, LAUNCH_AGENTS,
       default_lane=dl)`:
       - `None` = the repo's OWN service already runs lane `el` (its plist
         carries `--lane el`) → `marker_repo=repo`, `lane_suffix=el` (the
         suffix STAYS — that supervisor's `AUTONOMY_LANE` is `el`).
       - `{"error": …}` (no service installed / stale plist) → refuse
         verbatim — never guess a worktree.
       - `{"label","plist","repo"}` → `marker_repo=svc["repo"]` (the lane
         worktree), `lane_suffix=el`.
  4. `trigger_fire` extra gates: `firing.mode == "manual"`; then
     `ds.trigger_fire_ready(repo, trig)` — the SAME helper Task 4's payload
     uses (byte-equivalent read/write verdicts by construction) — else
     refuse with its reason.
  5. `plan = dcx.trigger_ctl_plan(...)`; execute: `os.makedirs(dirname,
     exist_ok=True)` + `open(path,"w").close()` / `os.unlink` (missing on
     remove → still ok:True, idempotent). Short structured errors only.

- [ ] Failing tests (Handler-object drive, no socket — existing harness):
  GET /api/triggers happy + unmanaged-repo 400; /api/pipeline?name= /
  ?token= / both → error; POST matrix: fire on adhoc-digest (tmp COPY of
  repo-alpha — never mutate the committed fixture) creates
  `var/trigger-ctl/fire/adhoc-digest`; fire on coder (continuous) refused;
  fire on pr-sweep (continuous) refused; stop/resume roundtrip; unknown
  trigger refused; undeclared-lane trigger refused; bad token 403 (existing
  gauntlet still applies — one test proves ordering). Lane-routing cases
  (CP1 — the wrong-repo write is the one this suite must catch): a
  non-default-lane trigger with a stubbed `find_lane_service` returning a
  worktree dict → marker lands under `svc["repo"]/var/trigger-ctl/` with
  the `--<lane>` basename (NOT under the registered repo); stub returning
  `None` → marker in the registered repo WITH the `--<lane>` basename;
  stub returning `{"error"}` → refused, nothing written anywhere.
- [ ] Implement; suite green; commit.

### Task 9: marker parity shell test

**Files:** Modify `tests/test_trigger_dispatch.sh` (new cases at the
established harness).

Prove a dashboard-minted marker is consumed byte-identically: create the
fire marker via `python3 -c 'import dashboard_control, ...;
plan=trigger_ctl_plan(...)'` + the touch, then drive the SOURCED
`resolve_manual_fires` exactly like the existing hand-touched-marker case
(same stubs) and assert the same dispatch + `rm`. One default-lane case, one
`--lane` case asserting the `<name>--<lane>` basename matches
`_trigger_ctl_path` output (call the real function for the expected path —
parity by construction). Scope note (CP1): this proves BASENAME parity +
consumption; the which-worktree routing is covered by Task 8's stubbed
`find_lane_service` server tests — together they cover the full path.

- [ ] Failing test → implement → `bash tests/test_trigger_dispatch.sh` green
  → `shellcheck -S warning tests/test_trigger_dispatch.sh` clean → commit.

### Task 10: `/pipeline` tabs + list views

**Files:** Modify `lib/pipeline_page.html`; Test: browser verify (step 12) +
`tests/test_dashboard_server.py` placeholder-substitution smoke only.

- Tab strip between `.hdr`(176) and `.layout`(177); sections `#v-gallery`
  `#v-triggers` `#v-runs` wrap NEW markup; `#v-canvas` wraps the EXISTING
  `.layout` unchanged. `?view=` param (default: canvas when `role=`/`name=`
  present, else triggers); tab switch via delegated `data-view` listener
  (NOT the mockup's inline onclick).
- Tick fetches ONLY the active tab's payload: canvas → `/api/pipeline`
  (existing `VIEWSIG`); list tabs → `/api/triggers` behind a new
  `TRIGSIG` raw-bytes guard. Canvas render/minimap run only while visible
  (hidden `getBoundingClientRect` is all-zero — guard in `tick`/`showView`;
  switching to canvas forces one render).
- Trigger cards / runs rows / gallery cards per spec §5.1 + mockup CSS
  classes (`.tchip`, `.trow`, `.runrow`, `.pcard`, `.oc` — port the v6
  mockup's Phase D CSS block, keep the shared token palette). Buttons:
  ▶ run-now (disabled + `title=fire_block_reason` unless `fire_ready`),
  ■ stop / ▶ resume POST via the existing token pattern (`saveNow` shape,
  `action: "trigger_fire"|"trigger_stop"|"trigger_resume"`, then force
  `TRIGSIG=""` re-tick). All payload strings through `esc()`; actions via
  delegated `data-act`/`data-name` listeners. ＋trigger/⧉clone dimmed-inert
  labelled D2/D3.
- Runs rows: child rows rendered indented under their parent (match
  `parent_run` ↔ parent `run_id`; orphan child → top-level w/ `parent_run ↑`
  chip); light-on-canvas → `?view=canvas&token=<token>`; canvas breadcrumb
  chip when `VIEW.run.parent_run` present links back
  `?view=canvas&token=<parent-token>`.

- [ ] Implement; `python3 -m unittest tests.test_dashboard_server -v` green;
  commit (browser verification happens in Task 12 before push).

### Task 11: main dashboard rail + rollup chip + needs-you

**Files:** Modify `lib/dashboard_page.html`; Test: browser verify + existing
`TestFleetRailLifecycleCluster`-style server-render assertions where they
already pin rail HTML.

- `renderRepos` role rows → trigger rows from `r.triggers` (fallback to
  `r.roles` when `triggers` absent — old-payload tolerance; `r.trust.error`
  → ⚠ badge + role rows, degrade-to-truth). Single-lane: pipeline group
  headers (reuse `.lgrp` pattern); multi-lane: lane groups outer, pipeline
  in row line 2. Row line 2: mode chip · tier · stopped/window badges ·
  last-run; row links → `/pipeline?repo=…&view=triggers`. The `⛓` per-role
  link (1183) retires.
- Repo card: rollup chip (worst-of tier + pipeline count) next to the
  existing badges; title lists per-pipeline tiers.
- `renderNeedsYou`: merge `r.trust.refused` rows (verbatim esc()'d, link to
  triggers tab) ahead of gh items; keep `setHTML` guard.

- [ ] Implement; run full python suite (rail-HTML pins may need updating —
  update them to the NEW truth, never delete coverage); commit.

### Task 12: docs + verify + SD entry

**Files:** Modify `docs/pipelines.md`, `.claude/skills/dashboard/SKILL.md`,
`.claude/skills/engineering/pipelines.md`, `docs/settled-decisions.md`
(new entry: D1 scope lines — marker-only lifecycle, pause/params/non-manual
run-now → D2, backoff/queued read-only, lane routing rule).

- [ ] Docs written (product voice in pipelines.md — no SD-N/CP jargon).
- [ ] `bash tests/run_all.sh` + shellcheck sweep + pre-flight-review skill
  against the full branch diff.
- [ ] Browser verify loop (dashboard skill): fixture launch on 8790, all
  four tabs + main page, three states (populated/empty/degraded via tmp
  repos), control POST exercised (fire on adhoc-digest → marker file
  appears; assert 200), console clean, TEMPORAL pass (panel ids for
  /pipeline grow `['v-gallery','v-triggers','v-runs','dag','pane',
  'palette','errbar','edgesvg']`; CLS < 0.01; ≤1 rebuild/panel; dirty-
  control survival on /config).
- [ ] Codex CP2 on `git diff main...HEAD`; fold findings; commit.

## Execution notes

- Commit per task; push once after Task 12 + CP2 (every push resets the
  review gate).
- PR body: self-contained, security model section, scope-line table from
  spec §2 flagged veto-able, "relates to #383" phrasing ONLY (no closing
  keyword — prevention-log #20); pre-merge probe `gh pr view <n> --json
  closingIssuesReferences` must return `[]`.
