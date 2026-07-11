# State-file `role` deprecated-twin drop

> **Audience: engineering record.** Plan for the post-Phase-D cleanup slice;
> process references (SD-N, prevention-log #N, phase letters) are decoded in
> `.claude/skills/engineering/pipelines.md`.

## Why now

SD-41 (Phase E): "The state-file `role` key SURVIVES until the dashboard
learns triggers (Phase D)." Phase D completed 2026-07-11 (#383 closed,
D1–D3; shadow lifecycle #388). The #383 decisions comment (2026-07-10,
decision 4)
pinned: payload keys on the state's EXISTING `trigger` field; state `role` =
deprecated twin, one more phase. That phase is over — the drop is now legal.

`start_run_trigger` carries the promise in-line: `"role": trigger_name keeps
every existing state consumer … working without a branch; Phase E renames the
key when trust re-keys.` Trust re-keyed in Phase E; the dashboard moved off
the key in Phase D. Nothing load-bearing remains (audit below).

## The rule (one sentence)

Run state files mint NO `role` key — `trigger` is the ONE name field; readers
TOLERATE a `role` key on states minted before the drop (`.get`-total,
ignore-never-require), and journal lines are never touched (SD-41).

## Audit — every reader/writer of state `role` (2026-07-11, main d58cd72)

Writers (all three mint `role` byte-equal to `trigger` — the twin):

| Site | Classification |
| --- | --- |
| `pipeline.start_run` (shim mint) | DROP the key |
| `pipeline.start_run_trigger` (native mint; carries the rename promise) | DROP the key |
| `pipeline.start_child_run` (child mint; CP1 — the earlier draft misnamed it `_start_call_unit`, which is the supervisor-side reservation) | DROP the key |

Readers:

| Site | Classification |
| --- | --- |
| `pipeline._journal_append` — `"role": state.get("role", "")` into the journal line | UNTOUCHED. Already total. A legacy in-flight state (minted pre-drop) finishing after the drop still lands its grandfatherable `role`; a post-drop state lands `role: ""` and always carries `trigger` (Phase B invariant), which is what the ledger keys on (SD-41). The journal writer's schema does not change. |
| `pipeline.ledger` — `rec.get("role")` grandfather | UNTOUCHED (journal reader; SD-41 immutable). |
| `dashboard_state._journal_last_run` — matches journal lines on `rec.get("role") == role` ONLY | RETIRE TO TRIGGER-FIRST: `(rec.get("trigger") or rec.get("role")) == role`. Post-drop journal lines carry `role: ""` — the role-only match would freeze the role-canvas observed lighting at the last pre-drop run. Old lines (role, no trigger) keep matching via the fallback. Same composite `list_runs` already uses for finished rows. |
| `dashboard_state.list_runs` in-flight rows — `state.get("trigger") or state.get("role") or tok["name"]` | RETIRE the `role` leg. Display-identical: every post-Phase-B state has `trigger`; a pre-Phase-B legacy state's `role` byte-equals `tok["name"]` (the filename IS the role), so the tok fallback renders the same string. |
| `dashboard_state.build_pipeline_view` by-token `run.trigger` — same composite | RETIRE the `role` leg (same argument). |
| `dashboard_state.list_runs` finished rows — `rec.get("trigger") or rec.get("role")` | KEEP — journal reader; pre-Phase-B journal lines have only `role` and are immutable. |

Not state-file `role` (out of scope, verified): supervisor.sh reads only
`kind` from state (`state_kind_of`); `dashboard_state._role_last_run` /
`_session_role` read SESSION-LOG sidecars (different subsystem);
`bin/dashboard.py` `role` = query-string selector + cred actions; payload row
field names (`trigger_health[].role`, `build_roles` rows) are page vocabulary,
not the state key; `roles:` config-block accesses everywhere.

Load-bearing finds: NONE. (`_journal_last_run` is the closest, and it is
exactly the retire-to-trigger display class — not a drop-pauser.)

## In-flight compatibility

fmt-2 states minted before the drop still carry `role`. Every surviving
reader is `.get`-total and none REQUIRES the key: the walk engine never reads
it, `_journal_append` defaults it to `""`, display readers key `trigger` /
`tok["name"]`. A test pins the tolerance with a role-only (no `trigger`)
legacy state: `list_runs` renders it via the token name, no crash.

## Journal semantics after the drop

- Old lines: untouched, `role` intact, grandfather (SD-41) unchanged.
- New lines from post-drop states: `role: ""`, `trigger` always set — the
  ledger, rollup, and both dashboard journal readers key `trigger` first.
- New lines from legacy in-flight states: `role` preserved (evidence intact).

## Tasks (TDD)

1. **Failing tests, pipeline layer** (`tests/test_pipeline.py`): the three
   mints produce states with NO `role` key (`assertNotIn`); journal-pin
   updates — `rec["role"] == ""` + `rec["trigger"]` carries the name for
   `start_run`-minted runs. The two pins that flip (CP1 — named
   explicitly): `test_done_run_appends_journal_line_with_trust_fields`
   (~:1096) and `test_journal_line_carries_additive_trigger_field`
   (~:2828, whose `# ledger keys stay put` comment becomes actively wrong —
   rewrite it). Plus: a hand-built legacy state (role, no trigger) run
   through `_journal_append` keeps `role == "coder"` (the
   evidence-preservation pin).
2. **Implement**: drop the `role` line from the three mints; rewrite the
   `start_run_trigger` comment (promise fulfilled); note the ONE name field.
3. **Failing tests, dashboard layer** (`tests/test_dashboard_state.py`):
   `_journal_last_run` matches a post-drop line (`trigger` set, `role: ""`)
   AND an old line (role only), AND (CP1 — ordering regression) a NEWER
   post-drop line beats an older role-only line (match-both alone could
   pass while lighting stays stale); `list_runs` in-flight row + by-token
   `run.trigger` for a post-drop state (no `role`) resolve from `trigger`;
   legacy role-only state tolerance INCLUDING a lane-scoped file
   (`.pipeline-run-coder--night.json`, state carries `lane: "night"` →
   `lane_hint` strips the suffix, row renders `coder`). Every engine mint
   since P1 writes `lane`, so a role-only state WITHOUT `lane` is
   hand-damaged; its raw token base rendering (`coder--night`) is the
   honest degraded display — documented bound, not a fallback keeper (CP1).
4. **Implement**: trigger-first composite in `_journal_last_run`; retire the
   two state-`role` fallback legs.
5. **Fixtures + test literals** (CP1 — "full-suite audit" made concrete):
   drop the `role` twin from the three `tests/fixtures/repo-alpha` state
   files (they represent current-format mints); sweep every fmt-2 state
   LITERAL in tests (`grep -n '"role"' tests/test_*.py` + the dict
   literals at e.g. test_dashboard_state ~:1746, ~:4195) — literals
   representing CURRENT mints drop the key, literals exercising legacy
   tolerance keep it behind an explicit `# legacy pre-drop state` label.
6. **Docs**: skill `.claude/skills/engineering/pipelines.md` state-shape
   line; settled-decisions SD-46 (the drop + tolerance + journal-role-""
   semantics); MASTER shipped table small-fix row. `docs/pipelines.md` never
   documented the state key — no product-doc change.
7. **Verify**: run_all + shellcheck; dashboard browser loop (runs tab rows,
   role-canvas observed lighting still lights from the fixture journal,
   temporal pass CLS < 0.01 / rebuilds ≤ 1 on `/pipeline`).

## Risks / consciously accepted

- New journal lines carry `role: ""` rather than omitting the field —
  schema-stable for any external tail-reader; the grandfather clause treats
  `""` and missing identically (SD-41 wording).
- A pre-Phase-B in-flight run that finishes post-drop journals with its
  `role` intact and NO `trigger` — grandfathered for shims exactly as
  Phase E defined; no new path.
- Display for role-only legacy states leans on `tok["name"]` — byte-equal to
  the dropped fallback by filename construction (`.pipeline-run-<role>…`).
