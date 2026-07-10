# Phase D slice D1 — the dashboard learns triggers: read surfaces + marker lifecycle (spec)

> **Audience note (engineering record):** engineering build spec for the
> engine's own development loop. Process vocabulary (SD-N, prevention-log #N,
> CP1-3) decodes via `.claude/skills/engineering/pipelines.md`.

**Provenance:** issue #383 (stays OPEN until D3), operator decisions comment
2026-07-10 (all 9 recorded; direction confirmed). Design spec
`docs/superpowers/specs/2026-07-09-pipeline-trigger-model-design.md` §5/§8.
Mockup v6 `docs/superpowers/mockups/2026-07-08-dag-canvas-mockup.html`.
Underneath: Phases A/B/C/E shipped — triggers are the dispatch unit
(SD-39/40/41); the dashboard still renders the ROLE view.

## 1. What D1 ships

The dashboard learns **triggers** as read surfaces plus the marker-file
lifecycle controls:

- `/pipeline` grows the four view tabs (🗂 gallery · ⚡ triggers · ▶ runs ·
  🎨 canvas) per decision 1. Canvas = the existing P3a–P3c page, unchanged
  behaviour, now tab 4.
- A new **read** payload (`GET /api/triggers?repo=`) built by a new totality
  builder `dashboard_state.build_triggers_view(repo, now=None)`: trigger
  cards, per-trigger trust tiers, pipeline gallery cards, the pipeline
  rollup, REFUSED rows verbatim, and a runs list (in-flight state files +
  journal tail) with child-run nesting and one row per `@slot` (decision 8).
- **Lifecycle controls** through the existing `POST /api/control` (SD-9 —
  never a new write endpoint): three new actions `trigger_fire`,
  `trigger_stop`, `trigger_resume` that write/remove the supervisor's
  existing lane-scoped markers under `var/trigger-ctl/{fire,stop}/`.
- Main dashboard: the fleet rail re-lists **triggers grouped by pipeline**
  (decision 1), the repo card gains the **rollup chip** (decision 5),
  REFUSED triggers also raise into **needs-you** (decision 6), and the
  per-role `⛓` link retires in favour of trigger-row links into `/pipeline`.
- Canvas addressing grows `name=` (open a pipeline by name — gallery cards,
  native triggers have no role) and `token=` (open the canvas lit from a
  specific run's state file — child rows open the CHILD canvas with a parent
  breadcrumb, decision 7).

## 2. Scope lines (conscious, veto-able — recorded on #383 with the PR)

| Item | D1? | Why |
|---|---|---|
| run-now / stop / resume markers | **YES** | the "existing lane-scoped markers" of decision 2. |
| per-trigger **pause** (enable/disable toggle) | **D2** | pause is `enabled:false` **in the trigger file**, not a marker (`bin/supervisor.sh:1032`). Writing trigger files is D2's `trigger_save` (SD-29 discipline over the SD-34 FILE shadow). D1 renders the enabled state read-only with an honest note. A shim's toggle needs native-file materialisation — also D2. |
| run-now **params payload** (decision 3) | **D2** | the fire marker is consumed existence-only today (`resolve_manual_fires` never opens it); the params channel needs a supervisor+`pipeline.py start` consumer AND the typed-params form — the same form machinery D2's create-trigger flow builds. D1 writes the **empty marker** (byte-parity with today's consumer). A manual trigger with required-no-default params gets run-now **disabled** with the reason (firing it would refuse at `resolve_params` and burn a backoff). |
| run-now on non-manual modes | **D2+** | `resolve_manual_fires` WARN-removes a fire marker whose trigger is not manual-mode (`bin/supervisor.sh:1201`); offering the button would be a dead control. D1 enables ▶ only on manual-mode triggers; others get the disabled state + reason. |
| clearing **backoff** on resume | **NO** | `backoff/` + `queued/` are supervisor-OWNED (sole-writer, `bin/supervisor.sh:991-995`; same discipline as the reset-epoch split). Dashboard renders both read-only. Resume removes the `stop/` marker only. |
| trigger create/edit, `trigger_save` | D2 | decision 2 sequencing. |
| pipeline create-from-blank / clone; template/clone provenance | D3 | decision 2; no provenance data exists yet. Gallery renders the buttons dimmed-inert labelled D2/D3. |
| fleet-rail grouping in **multi-lane** repos | lane groups stay OUTER | lane groups carry the per-lane lifecycle clusters (the run-model unit); trigger rows inside them show their pipeline in line 2. Single-lane repos (the common case) group by pipeline. |

## 3. Payload design

### 3.1 `build_triggers_view(repo_path, now=None)` (lib/dashboard_state.py)

The route's **totality boundary** (same discipline as `build_pipeline_view`,
prevention-log #21): every external call guarded; errors become payload
fields; a broken repo renders its error, never a healthy fallback. Pure +
fs-only (no network). `now` injected for run-window determinism in tests.

```
{
  "repo": <basename>, "path": <repo_path>,
  "triggers": [ {
     name, kind: "shim"|"native", pipeline,            # pipeline "" = wrapped role → doc name == trigger name
     mode, schedule|None, event|None, map|None,        # from firing (events_csv for shims → event field, csv string)
     enabled, lane, concurrency: {policy, max}, params,
     run_windows, window_open: bool,                   # triggers.in_run_window(t, now) — fail-closed
     tier, runs, passes,                               # per-trigger ledger row (trust_rollup rows)
     stopped: bool,                                    # var/trigger-ctl/stop/<marker> exists
     fire_pending: bool,                               # var/trigger-ctl/fire/<marker> exists
     queued: bool,                                     # var/trigger-ctl/queued/<marker> exists (read-only)
     backoff: {"until": int, "count": int}             # parsed epoch<TAB>count
            | {"error": "unreadable"} | None,          # None = NO marker; a PRESENT-but-corrupt marker degrades to an error chip, never to healthy absence (CP1; prevention-log #18)
     fire_ready: bool, fire_block_reason: str|None,    # manual mode only: a DRY pipeline.resolve_params over the doc's declared params + the trigger's saved params (same resolve start_run_trigger performs, secrets refused); ANY failure → fire_ready False + the reason (CP1: required-no-default is only one refusal class). Non-manual modes: False + mode reason.
  } ],
  "refused": [verbatim warning strings],               # enumerate/trust warnings starting "refused"
  "rollup": {pipeline_name: "auto"|"watch"},           # trust_rollup all-auto floor
  "pipelines": [ {name, version, source: "committed"|"shadow"|"wrapped",
                  valid: bool, errors: [..], nodes: int,
                  triggers: [names], tier: rollup tier} ],
  "runs": [ {token, state: "in-flight"|"finished", trigger, pipeline,
             status|outcome, pass|None, started|None, finished|None,
             sessions|None, run_id|None, parent_run|None,
             slot: int, lane: str, child: bool} ],
  "error": <string>                                    # top-level degrade (config unreadable etc.) — payload still carries what could be read
}
```

- Trigger identity/trust: ONE `triggers.enumerate_triggers(repo,
  dispatchable_only=False)` pass; `triggers.trust_rollup` gains an optional
  `trigs=` kwarg accepting the preloaded rows so the builder never
  double-enumerates (CP1; CLI behaviour byte-identical — kwarg default
  re-enumerates). Disabled/off-lane included — a pause never hides evidence
  (SD-41). `enumerate_triggers` RAISES on unreadable config → caught →
  `error` field + empty lists.
- **Marker filename rule** (must byte-match `_trigger_ctl_path`,
  `bin/supervisor.sh:998`): effective lane `el = trig.lane or
  default_lane(cfg)`; marker basename = `<name>` when `el ==
  default_lane(cfg)` (the default-lane supervisor runs with
  `AUTONOMY_LANE=""` — setup_worktree only passes `--lane` for non-default
  lanes), else `<name>--<el>`. **Read side** scans the repo's own
  `var/trigger-ctl/` (the payload describes the repo it was asked about);
  the **write side** additionally routes to the lane service's worktree —
  §4. Accepted bound: an operator who hand-launches a supervisor with a
  non-conventional `--lane` shifts the convention; documented, same bound
  `find_lane_service` already accepts.
- **Runs scanner** `list_runs(logdir)`: glob `.pipeline-run-*.json`, skip
  RESERVED sidecar suffixes (`.outputs/.verdict/.outcome` — the Phase C
  phantom-token lesson, same skip rule as `inflight_tokens`), parse token
  from the filename with the canonical rules (strip `.json`, prefix, then
  `@slot` from the END, then `--<lane>`); read `trigger`/`kind`/`status`/
  `parent_run`/`run_id`/`sessions` from the state JSON (decision 4: key on
  the state's existing `trigger` field; `role` is the deprecated twin —
  fallback display only). Corrupt/odd state → degraded row (`status:
  "unreadable"`), never a crash. Finished runs: bounded journal tail
  (reuse the 64KiB reversed-iteration pattern), newest-first, ~20 rows;
  journal rows keyed `trigger` (fallback `role` for grandfather lines);
  `parent_run` rows are children (never trust evidence — display only).

### 3.2 `build_repo_state` additions (additive keys, nothing removed)

- `triggers`: light rows for the fleet rail — `{name, kind, pipeline, mode,
  enabled, lane, window_open, tier, stopped, missed_fire}`. `trigger_health`
  is GENERALISED to enumeration-derived schedule triggers (CP1: native
  schedule triggers write the same `var/cron/<name>.last_fire` markers via
  `resolve_trigger_cron_due` — the config-cron-roles-only reader would miss
  native stalls); existing signature/behaviour preserved for its current
  call site, natives added additively.
- `trust`: `{"rollup": {pipeline: tier}, "refused": [strings]}` — feeds the
  repo-card chip + the needs-you merge. Guarded: unreadable config →
  `{"error": ...}` shape, rail falls back to the existing `roles` rows
  (degrade-to-truth, badged).

### 3.3 Routes (bin/dashboard.py)

- `GET /api/triggers?repo=` — managed-repo gate (same as `/api/pipeline`),
  returns `build_triggers_view`. READ endpoint — SD-9 forbids per-feature
  *write* endpoints; reads follow `/api/boards`/`/api/ws-prompt` precedent.
- `GET /api/pipeline` grows `name=` (mutually exclusive with `role=`;
  by-name resolution via `effective_pipeline_dir` — no role settings, no
  role-keyed ledger; `ledger: null`, trust comes from `/api/triggers`) and
  `token=` (must parse under the CANONICAL token grammar — strip a trailing
  `@<digits>` slot, then `--<lane>`, remainder charset-valid and not a
  reserved sidecar suffix (CP1: arbitrary `@` placement refused); selects
  state file `.pipeline-run-<token>.json`; the view renders the run's own
  embedded `doc` + unit statuses + `parent_run` for the breadcrumb). Both
  validated server-side; unknown/invalid → the builder's error-field
  discipline (200 + error payload, page renders it).

## 4. Lifecycle control design

New `POST /api/control` actions (token gauntlet + managed-repo gate
unchanged; server-side re-validation per SD-9/prevention-log #6):

| action | plan | validation |
|---|---|---|
| `trigger_fire` | create empty `<marker_repo>/var/trigger-ctl/fire/<marker>` | name charset (`pipeline._NAME_RE`); trigger must enumerate (`dispatchable_only=False`); `firing.mode == "manual"`; `fire_ready` (a dry `resolve_params` pass — else refuse with the reason: firing would refuse at start and burn a backoff); lane routable (below) |
| `trigger_stop` | create empty `<marker_repo>/var/trigger-ctl/stop/<marker>` | name charset; trigger must enumerate (any mode, shims included); lane routable |
| `trigger_resume` | remove `<marker_repo>/var/trigger-ctl/stop/<marker>` | name charset; lane routable; idempotent (absent marker → ok) |

- **Lane routing (CP1 BLOCKING trio).** `_trigger_ctl_path` keys off the
  CONSUMING supervisor's `AUTONOMY_LANE` and its `$VARDIR` — for a
  non-default lane that is the LANE SERVICE'S OWN WORKTREE, not the
  registered repo. The write path therefore mirrors `execute_control`'s
  existing per-lane precedent exactly: effective lane `el = trig.lane or
  default_lane(cfg)`; **refuse** when `el` is not a declared lane (an
  undeclared-lane trigger never dispatches — a marker for it would never be
  consumed; writing it anyway is fail-open theatre). `el == default_lane` →
  `marker_repo = repo` (the managed path — the same assumption
  pause/resume's sentinel already makes), marker basename `<name>`.
  Non-default `el` → resolve `dcx.find_lane_service(repo, el, …)`; its
  `repo` field (the lane worktree) is `marker_repo`, basename
  `<name>--<el>`; **no/refusing service → refuse** (same error shape as
  `control_plan`'s no-service arm — never guess a worktree).
- Pure planner `dashboard_control.trigger_ctl_plan(marker_repo, action,
  name, lane_suffix)` returns `{"touch": path}` / `{"remove": path}` /
  `{"error": reason}` — same shape family as `control_plan` (service/lane
  resolution happens in the caller, like `execute_control`); execution
  (mkdir -p the subdir, touch/unlink) stays in `bin/dashboard.py`.
- Dashboard NEVER writes `queued/` or `backoff/` (supervisor-owned).
- Disabled or window-closed manual trigger: `trigger_fire` is ALLOWED — the
  supervisor's own defer semantics keep the marker (`SHOW_ENABLED=false` /
  `WINDOW=closed` branches); the UI labels the pending marker "deferred".

## 5. Page design

### 5.1 `/pipeline` (lib/pipeline_page.html)

- Tab strip between `.hdr` and `.layout`; sections `#v-gallery`,
  `#v-triggers`, `#v-runs`, `#v-canvas` (canvas = the existing markup,
  untouched inside). Tab from `?view=` (default: canvas when `role`/`name`
  given, else triggers). Delegated `data-*` listeners (no inline onclick —
  the mockup's inline handlers are NOT copied; render data is hostile).
- Poll: the 5s tick fetches the ACTIVE tab's payload only (`/api/triggers`
  for the three list tabs, `/api/pipeline` for canvas), each behind its own
  raw-bytes signature guard (`VIEWSIG` pattern) — idle rebuilds 0
  (prevention-log #13). Canvas render/minimap only run while the canvas tab
  is visible (hidden geometry reads are all-zero); switching to canvas
  forces one render.
- Trigger cards per the mockup anatomy: enabled state (read-only D1),
  mode/schedule/event chip, concurrency chip, window chip (open/closed/no
  windows), per-trigger tier, params summary, marker state chips
  (stopped/fire-pending/queued/backoff-until), ▶ run-now (manual mode only;
  disabled+reason otherwise or when `needs_params`), ■ stop / ▶ resume.
  REFUSED cards render the refusal verbatim (esc()'d).
- Runs rows: outcome chip, token, trigger → pipeline, sessions, child rows
  indented under their parent (match `parent_run` ↔ parent `run_id`/token),
  one row per `@slot`, "light on canvas" → canvas tab with `token=`
  (child rows open the child's own doc lit + parent breadcrumb link).
- Gallery cards: name, version, source badge (committed/shadow/wrapped),
  rollup tier, bound-trigger chips, error strip for invalid docs, REFUSED
  strip verbatim; open-canvas → `name=` (or `role=` for wrapped); ＋trigger
  / ⧉clone dimmed-inert (D2/D3).

### 5.2 Main dashboard (lib/dashboard_page.html)

- Fleet rail rows now come from `r.triggers` (fallback: existing `r.roles`
  rows when `triggers` missing/error — old-server tolerance + degrade path).
  Single-lane: pipeline group headers; multi-lane: lane groups stay outer
  (they carry lifecycle clusters), pipeline shown in row line 2. Row: dot,
  name, mode chip, tier, stopped/window badges, last-run; link →
  `/pipeline?repo=…&view=triggers`. The per-role `⛓` (line 1183) retires.
- Repo card: rollup chip — worst-of tier across pipelines + count.
- needs-you: merge `r.trust.refused` rows (REFUSED verbatim, link to the
  triggers tab) with the existing gh-fed items; REFUSED is operator-
  actionable by definition (decision 6).

## 6. Security model

- No new endpoint class: reads are GET JSON (loopback-only server, SD-9);
  the ONLY write stays `POST /api/control` behind Host/Origin/body-size/
  token + server-side re-validation.
- Marker writes are constrained to `var/trigger-ctl/{fire,stop}/` under a
  repo path that is either MANAGED or a `find_lane_service`-verified lane
  worktree (content-verified plist, refuses on mismatch) — the path
  boundary is the verified service worktree + runtime lane convention, not
  config values alone (CP1). Basenames are charset-gated (`_NAME_RE`;
  declared-lane-gated suffix); content is never written (empty files), so
  no injection surface toward the supervisor consumer. Fail-safe: unknown/
  non-enumerable trigger names and unroutable lanes refuse (never mint a
  marker no supervisor will consume).
- Render data is HOSTILE (refusal strings echo file contents; trigger
  names come from disk): full-coverage `esc()`, delegated `data-*`
  listeners, no `innerHTML` of unescaped payload (P3a discipline).
- Trust/needs-you surfaces are fail-safe: rollup floor is `watch` unless
  every tier is `auto`; builder errors render as errors (never healthy).

## 7. Fixtures (tests/fixtures/repo-alpha — committed, deterministic)

- `.autonomy/triggers/adhoc-digest.json` — native manual, binds
  `fixture-flow`, skip/1 (run-now-eligible card).
- `.autonomy/triggers/pr-sweep.json` — native continuous, parallel/2,
  `enabled: false`, binds `fixture-flow` (disabled card whose tier still
  counts; slotted-run owner).
- State files (invisible to the legacy per-role glob — verified:
  `.pipeline-run-coder.json`/`--*` matches none of them):
  `.pipeline-run-adhoc-digest.json` (in-flight parent, embedded doc,
  `trigger`/`kind`/`run_id`), `.pipeline-run-adhoc-digest.c0.qa.json`
  (child, `parent_run` = parent's run_id), `.pipeline-run-pr-sweep@1.json`
  (slot row).
- Journal: two appended lines carrying `trigger`/`kind` (one finished
  adhoc-digest run; one finished CHILD line with `parent_run`) — role
  fields ≠ `coder`, so existing `_journal_last_run`/ledger pins for
  coder/fixture-flow are untouched (verified against the grandfather rule:
  lines WITH a trigger field never grandfather onto coder).
- NO committed run_windows (window_open flips with wall clock —
  nondeterministic browser verify); window and REFUSED coverage live in
  tmp-copy unit tests.
- NO committed `var/trigger-ctl/` markers; marker coverage via tmp copies.
- **Audit step (CP1):** the fixture-addition task runs the FULL suite
  immediately after committing the fixtures — every existing
  `build_repo_state(FIX)` / ledger / pipeline-view pin must stay green
  before any new builder code lands; a conflicting pin moves that coverage
  to a tmp copy in the same commit.

## 8. Tests + verification

- Unit: `test_dashboard_state.py` (list_runs token/lane/slot/child parse,
  reserved-suffix skip, corrupt-state degrade, build_triggers_view shapes,
  marker reads, needs_params, window injection via `now`, error degrades,
  build_repo_state additive keys), `test_dashboard_control.py`
  (trigger_ctl_plan matrix incl. refusals), `test_dashboard_server.py`
  (routes, gauntlet, action whitelist, by-name/by-token pipeline views,
  fire/stop/resume end-to-end against a tmp repo, marker byte-parity with
  `_trigger_ctl_path` incl. the lane suffix).
- Marker parity: a shell test in `tests/test_trigger_dispatch.sh` (or
  sibling) proving a dashboard-minted fire marker is consumed by
  `resolve_manual_fires` byte-identically to a hand-touched one.
- Browser verify loop + temporal pass per `.claude/skills/dashboard/`
  (pipeline page panel ids grow the new sections; dirty-control survival;
  three states populated/empty/degraded).
- Docs in the same PR: `docs/pipelines.md` (product voice: the dashboard's
  trigger surfaces + what run-now/stop do), `.claude/skills/dashboard/
  SKILL.md` (routes/actions/panel ids), `.claude/skills/engineering/
  pipelines.md` (Phase D status line), settled-decisions candidate entry
  (D1 scope lines above).

## 9. Hard rails

`bin/safe_merge.sh` + `.github/workflows/**` untouched. `bin/supervisor.sh`
untouched (D1 adds NO engine behaviour — the markers' consumer exists).
Loops stay PAUSED. No closing keyword for #383 anywhere in the PR
(prevention-log #20; probe `closingIssuesReferences` pre-merge).
