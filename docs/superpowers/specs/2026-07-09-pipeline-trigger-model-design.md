# Pipeline + Trigger model — the ADF re-baseline (design)

> **Status:** design, awaiting operator review. Supersedes the P4 section of the
> v5 sequencer spec (`2026-07-08-agentic-sequencer-design.md` §7 gallery/§9 P4)
> and re-baselines the dispatch model. The P1–P3c walk engine
> (`lib/pipeline.py`, the supervisor dispatch path, the `/pipeline` canvas) is
> the substrate this builds ON — it is reused, not replaced.
>
> **Origin:** operator brainstorming session 2026-07-09 (this doc records the
> decisions reached; each `AskUserQuestion` fork is captured under "Decisions
> settled"). **Loops remain PAUSED fleet-wide** throughout the build.

## 1. The idea, in one paragraph

Make the automation feel like **Azure Data Factory**. A **pipeline** is a
reusable workflow *template* — activities, order, declared typed **parameters**
and **outputs** — that knows nothing about which repo it runs against, which
agent runs a step, or when it fires. A **trigger** is a separate first-class
object that **binds one pipeline, supplies its parameter values, and says when
it fires** (continuous / schedule / event / manual) and how overlapping runs
behave (queue / skip / parallel). "Assigning a pipeline to a workflow" *is*
creating a trigger. A pipeline can **invoke another pipeline** (the ADF
"Execute Pipeline" activity) and consume its typed outputs — so a coder pipeline
calls a QA pipeline, waits for its verdict + findings, and loops the findings
back into the coding round; that same QA pipeline also runs standalone on a
schedule. **Roles dissolve**: "who runs this step" becomes a parameter the
trigger supplies (or a literal the pipeline fixes).

The goal is **operator control over the automation**, ADF-shaped, without losing
the simple path: a one-activity pipeline + a continuous trigger *is* today's
"just let Claude loop" — one click, no ceremony. That is the answer to "is this
worth it vs. just asking Claude to run the loop": you keep the loop, and you
*gain* the ability to structure, parameterise, schedule, compose, and monitor it
when you want to.

## 2. The three concepts

### 2.1 Pipeline — the template

Stays a folder `.autonomy/pipelines/<name>/`: `pipeline.json` + sibling brief
`.md` files (the P1 shape). It gains two declared sections:

```jsonc
{
  "name": "ticket-to-merge",
  "version": 3,
  "params": [
    {"name": "repo",        "type": "repo",   "required": true},
    {"name": "board",       "type": "string", "required": false},
    {"name": "coder_agent", "type": "agent",  "required": true},
    {"name": "coder_model", "type": "model",  "required": false, "default": "claude-sonnet-5"}
  ],
  "outputs": [
    {"name": "merged_pr", "type": "number"},
    {"name": "findings",  "type": "string"}
  ],
  "caps": {"max_sessions_per_run": 16, "max_parallel": 2},
  "nodes": [
    {"id": "pick", "type": "pick",       "brief_ref": "pick.md"},
    {"id": "code", "type": "agent_task", "brief_ref": "code.md",
     "runs_as": {"agent": "${params.coder_agent}", "model": "${params.coder_model}"}},
    {"id": "qa",   "type": "call_pipeline", "pipeline": "qa-sweep",
     "params": {"repo": "${params.repo}", "target": "${nodes.code.output.branch}"},
     "wait": true}
  ],
  "edges": [
    {"from": "pick", "to": "code", "on": "success"},
    {"from": "code", "to": "qa",   "on": "success"},
    {"from": "qa",   "to": "code", "on": "failure", "back": true, "max_bounces": 3}
  ]
}
```

- **Repo-agnostic, agent-agnostic, schedule-agnostic** — none of those live in
  the pipeline. Activities reference `${params.x}` or hardcode a literal.
- Everything the P1–P3c validator/walk engine already enforces still holds
  (typed edges, joins, back-edges, loop/stage containers, caps, verdict files).
- **New activity type `call_pipeline`** — see §4.

### 2.2 Trigger — the binding + parameterisation (its own object)

New first-class object, its own file `.autonomy/triggers/<name>.json`:

```jsonc
{
  "name": "coder-repoA",
  "pipeline": "ticket-to-merge",
  "params": {
    "repo": "/Users/.../repoA",
    "coder_agent": "claude-code",
    "coder_model": "claude-opus-4-8"
  },
  "firing": {"mode": "continuous"},          // or schedule | event | manual
  "concurrency": {"policy": "skip", "max": 1},  // queue | skip | parallel
  "enabled": true
}
```

- **The only place** repo, agent/model/account, schedule, and concurrency bind.
- **Many triggers → one pipeline:** `coder-repoA` (Opus) and `coder-repoB`
  (a different agent) both reference `ticket-to-merge` — *same activities and
  order, different parameters*.
- **Firing modes:** `continuous` (re-fire every loop while work + capacity
  exist), `schedule` (cron), `event` (event-bus, W2/#109; payload maps to
  params), `manual` (operator "run now", prompts for required params).
- **Pause / hard-stop / start / limit-backoff move here** from role-level. A
  continuous trigger is pausable/stoppable exactly like a role loop today.
- **Concurrency policy** governs *overlapping runs of this trigger* (§5).

### 2.3 Roles — dissolved

There is no runtime "role" concept. "Who runs this step" is a parameter the
trigger supplies (`${params.coder_agent}`) or a literal the pipeline fixes
(`"runs_as": {"agent": "reviewer-x"}` for a step that must always use a specific
agent). Existing `roles:` configs are auto-migrated (§7).

## 3. Parameters & outputs (the typed layer)

- **Param types:** `string | number | bool | enum | repo | agent | model |
  account | secret`. `enum` carries `choices`. `repo`/`agent`/`model`/`account`
  are validated against the engine's known sets (parity with the existing
  `valid_model_id` / account registry gates). `secret` resolves from the
  credential store at run time and is **never logged, never in argv** (existing
  secrets discipline).
- **Resolution precedence (per run):** every pipeline declares its **full param
  set with defaults saved in it**. A value resolves as: (1) the pipeline's saved
  **default** (base), overridden by (2) the **invoker** — a **trigger** (a
  standalone run) *or* a **calling pipeline's `call_pipeline.params`** (a composed
  run); trigger and caller are the **same override slot**, interchangeable. A
  required param with no default and no override → **refuse the run** (fail-safe).
  So a called pipeline runs on its own saved defaults unless the caller overrides
  them; `call_pipeline.params` *is* the caller acting as the trigger would.

### 3.1 The dynamic param language — named refs + a closed pure-function set

Stdlib-parseable, **never evaluates arbitrary code** (no `eval`/`exec`). ~90% of
uses are a plain name lookup; the rest is defaults + output-passing.

- **Refs (the simple string-match names):**
  - `${params.<name>}` — a pipeline parameter (resolved by the precedence above)
  - `${nodes.<id>.output.<name>}` — a completed upstream activity's named output
  - `${run.<field>}` — run metadata (`run.id`, `run.pipeline`, `run.trigger`,
    `run.repo`)
- **Two resolution modes:** a field that is *exactly* `${ref}` keeps ref's
  **typed** value (a `repo` stays a repo, a `number` stays a number); a `${ref}`
  embedded in surrounding text is **string interpolation**
  (`"release/${params.version}"`).
- **Closed pure-function escape hatch** (allowlist only, each a real stdlib
  function — no eval): `default(x, y)` · `concat(a, b, …)` · `slug(x)`; extensible
  by allowlist. Used inside `${…}`:
  `${default(params.model, 'claude-sonnet-5')}`,
  `${slug(concat(params.ticket, '-fix'))}`.
- **Where resolved:** at **compile time**, before any session dispatch, in
  (a) brief `.md` text and (b) activity fields that accept it (`runs_as.*`,
  `call_pipeline.params.*`, container fields). An unresolved/unknown ref or a
  non-allowlisted function is a **validator error** (refuse, don't run).
- **Impl/security:** one stdlib resolver — a regex for `${…}` + a small
  recursive-descent parse of the function calls over the **closed allowlist**;
  type-checked against declared param types; **secrets resolved last, never
  logged/argv**; literal `${` in prose escapes as `$${`.

- **Outputs:** each activity may write named values to a per-run outputs file
  (`var/autonomy-logs/.run-<id>-outputs.json`); the pipeline's declared
  `outputs` project from them by name. A `call_pipeline` parent reads the
  child's projected outputs as `${nodes.<id>.output.<name>}`.
- **Cross-activity references within a run:** `${nodes.<id>.output.<name>}`
  (already-completed upstream activity's output) — the walk engine knows
  completion order, so a reference to a not-yet-run activity is a validator
  error.

## 4. `call_pipeline` — Execute-Pipeline (compose pipelines)

- `{ "type": "call_pipeline", "pipeline": "<name>", "params": {…}, "wait": true|false }`.
- A call spawns a **child run** — a real run with its own journal line, linked to
  the parent by a `parent_run` field. The child is resolved + parameterised
  exactly like a trigger-started run: the child's **saved defaults** are the base,
  the caller's `call_pipeline.params` are the overrides (§3.1 precedence — the
  caller occupies the trigger's slot), and the override values may reference the
  parent's `${params.*}` / `${nodes.*.output.*}`. The child's **account/agent are
  just params** — pinned by the child's own default, overridable by the caller.
- **`wait: true` (default):** the parent activity's unit stays `dispatched` until
  the child run reaches a terminal outcome; the parent then reads the child's
  typed **outputs** and the child's outcome drives the parent's edges (a child
  `failure` fires the parent's `on: failure` / back-edge). This is how QA's
  findings loop back into the coding loop: `qa (call, wait) --failure,back-->
  code`, and `code`'s next brief compiles `${nodes.qa.output.findings}`.
- **`wait: false`:** the child run is **detached** (fire-and-forget); the parent
  continues immediately; the child reports independently. Used for
  notify/side-effect pipelines.
- **Parallel siblings** are already supported (parallel ranks + `max_parallel`),
  so a run can `call_pipeline` two children in parallel and join on both.
- **Success rule (operator-stated):** a pipeline declares **success only when
  every activity has completed**; an activity that failed with no retry left to
  clear it **fails the whole pipeline** (existing unhandled-failure semantics).

## 5. Triggering, lifecycle & concurrency

### 5.1 What the supervisor does now

Enumerate enabled **triggers** (not roles). For each **due** trigger, start a
**run** of its pipeline with params bound, then hand off to the existing walk
engine. Round-robin fairness, account-first auth, backoff, and pause/stop
responsiveness are preserved — they now iterate triggers.

- **continuous** — always "due" while the pipeline has work (its first activity,
  e.g. `pick`, finds a ready item) **and** the trigger is under its concurrency
  cap. Each firing starts a **fresh discrete run** that takes one work item end
  to end (one run = one ticket = one journal line = one trust sample). A run
  **claims** its work item (the `pick` + branch state) so parallel runs of the
  same trigger don't collide on one ticket.
- **schedule** — cron. Missed fires while the machine was off: **skip + warn**
  (reuse the missed-cron-fire surface, #188/#231); no silent catch-up storm.
- **event** — the W2 event bus (#109); the event payload maps to declared params
  per a mapping in the trigger.
- **manual** — operator "run now"; prompts for required params without defaults.

### 5.2 Concurrency (two independent layers)

- **Per-trigger** (overlapping runs of *one trigger*): `queue` (ADF
  concurrency=1: hold the next fire until the current run ends, bounded queue
  depth), `skip` (the ADF-never-had option the operator wants: don't start an
  overlapping run, warn), or `parallel` up to `max` concurrent runs.
- **Per-run** (parallel activities *within a run*): the pipeline's
  `caps.max_parallel` (existing SD-36 ephemeral-worktree fan-out).
- **Global fleet cap** bounds total concurrent sessions / account pressure
  (existing account-first auth + usage-limit windows, #3).

## 6. Trust ledger — earned per trigger

Autonomy is earned **per trigger** — the pipeline *as parameterised* (this
pipeline, this repo, this agent). `ticket-to-merge` proven on repo A with Opus
does **not** auto-trust the same pipeline on repo B with a different agent
(matches today's per-assignment caution; fail-safe). The journal keys ledger
projection on the trigger; a **pipeline-level rollup** aggregates the per-trigger
tiers for the gallery view. `watch → auto` threshold unchanged (≥20 runs, ≥95%
over the last 20; lost/corrupt evidence lands on `watch`).

## 7. Migration — auto-shim (nothing breaks the day it ships)

On config load, each existing `roles.<r>` is auto-converted to:
- the pipeline it already binds (`roles.<r>.pipeline`), or a **minimal
  one-activity pipeline** synthesised from its prompt (the existing `wrap_role`),
  **plus**
- a **continuous trigger** carrying the role's old `model` / `account` / `lane`
  / trigger settings as params.

Old `.autonomy/config.yaml` files keep running unchanged; the operator
re-authors into explicit pipelines + triggers at their own pace. The shim is the
one code path that reads the legacy `roles:` schema; everything downstream sees
only triggers.

## 8. UI — Pipelines gallery + Triggers section

Retire the per-role `⛓` link. Two new surfaces (extending the P3a–P3c canvas):

- **Pipelines gallery** — list / **create** / edit / **version** pipelines
  (the P3b editor + P3c navigation, plus create-from-blank and clone). Shows the
  pipeline-level trust rollup. Params/outputs are edited on the canvas
  (declared-params pane; `${…}` references surfaced on activities).
- **Triggers section** — list / **create** / edit / enable / **pause** / **stop**
  / **run-now**. A trigger editor: pick a pipeline, a params form (typed inputs,
  validated), a firing-mode picker (continuous/schedule/event/manual + its
  config), a concurrency-policy picker. This is the "assign a pipeline to a
  workflow" surface.
- **Run monitoring** — runs list per trigger/pipeline (outcome, duration,
  sessions, the observed-lighting path already on the canvas), child-run links
  for `call_pipeline`.

The visual layout of these surfaces needs its own **mockup pass** (as the v5
canvas got) before the UI phase — flagged, not designed here.

## 9. Build plan (model-first, but sequenced + de-risked)

Big-bang on **design** (this doc); the **build** still sequences so each phase is
testable, and the new dispatch is built **behind** the old path and cut over only
when proven. Loops stay PAUSED throughout — there is no live loop to keep up, so
the cutover risk is correctness, not downtime.

- **Phase A — params + outputs + substitution.** `pipeline.json` gains
  `params`/`outputs`; validator; compile-time `${…}` substitution; the run-
  outputs file; `${nodes.*.output.*}` references. No dispatch change yet.
- **Phase B — Triggers as first-class + dispatch inversion + auto-shim.**
  `.autonomy/triggers/*.json`; supervisor enumerates triggers; `roles:` auto-
  migration; pause/stop/backoff/concurrency move to the trigger; continuous /
  schedule / manual firing.
- **Phase C — `call_pipeline` + child runs + outputs mapping + event firing.**
  Execute-Pipeline (wait/async), child-run linkage, findings-return back-edge,
  event→params.
- **Phase D — UI: Pipelines gallery + Triggers section + run monitoring**
  (needs a mockup pass first).
- **Phase E — trust ledger re-key (per trigger) + run windows + polish.**

Each phase is its own spec→plan→PR under the CLAUDE.md workflow (CP1/CP2/CP3,
browser verify for UI, safe_merge).

## 10. Decisions settled (this session)

1. **Three concepts** — pipeline (template) / trigger (binds + parameterises, own
   object) / roles dissolve into params. *(confirmed "yes, that's it")*
2. **Invoke = both**, wait-default (ADF), parallel siblings allowed; waited
   verdict drives a back-edge; success = all activities complete, unretried
   failure fails the run.
3. **Findings return = typed pipeline outputs** (full ADF params/outputs layer).
4. **Trigger is its own object**; many triggers → one pipeline; dynamic params
   (agent/model/repo) belong to the trigger; continuous keeps pause/stop/backoff.
5. **Continuous = one run per ticket** (discrete runs, like the other three
   firing modes); a run claims its work item.
6. **Concurrency per trigger** = queue / **skip-if-running** / parallel; plus
   per-run `caps.max_parallel` + a global fleet cap.
7. **Identity source** = either a trigger param **or** a pipeline literal.
8. **Repo is a trigger parameter** (engine still manages checkouts).
9. **Migration = auto-shim** (roles → pipeline + continuous trigger on load;
   old configs keep working).
10. **Trust keys per trigger** (pipeline as-parameterised); pipeline rollup view.
11. **Build = model-first big-bang**, built behind the old path, cut over when
    proven; loops stay PAUSED.

## 11. Resolved decisions (operator delegated 2026-07-09; recorded here)

- **Param language** — `${params.x}` / `${nodes.id.output.name}` / `${run.field}`
  named refs + a **closed pure-function allowlist** (`default`/`concat`/`slug`,
  no eval), stdlib-resolved, type-checked, secrets-last. Full spec §3.1.
- **Param precedence** — pipeline saved **default** < invoker override (a
  **trigger OR a calling pipeline** — the same slot); required-unset → refuse. §3.
- **Trigger storage** — **files** `.autonomy/triggers/*.json` (composes with the
  SD-34 var-shadow editor, carries per-trigger enable/pause state, mirrors
  pipelines).
- **`repo` param** — type `repo`, **selects among engine-registered checkouts**
  (control-unit #4), validated — never an arbitrary path.
- **Queue depth** — `concurrency: queue` is bounded at **1** (ADF-like; deeper
  queues risk stale runs).
- **Child-run account** — from the child's **own resolved params** (its saved
  default, overridable by the caller): a QA pipeline pins a cheaper agent by
  default, the caller can override.
- **Scheduling clock** — reuse the **existing cron-role parser** (same stdlib
  cron subset already in the engine).

Remaining genuinely-open item (needs a mockup pass, not a decision): the
**visual layout** of the Pipelines gallery + Triggers section (§8).

## 12. Relationship to existing specs

- **Reuses** the P1–P3c substrate wholesale: `lib/pipeline.py` (validator,
  `SPEC_SHEETS`, walk engine, journal/ledger), the supervisor dispatch path
  (SD-12/SD-36 batch), the `/pipeline` canvas (viewer P3a, editor P3b, nav P3c).
- **Supersedes** the v5 spec's P4 framing (§7 "gallery/assignment bar" as a
  role-attached top bar; §9 "P4 gallery/assignment + versioning + run windows").
  The gallery + versioning + run windows survive; the *role-attached* framing is
  replaced by the pipeline+trigger model here.
- **Settled decisions touched** (new SD entries land with each phase PR):
  SD-12/SD-36 (dispatch) generalise from role to trigger; SD-34 (var-shadow)
  extends to trigger files; the role→pipeline binding (P1) is subsumed by the
  auto-shim. No settled decision is *reversed* without an explicit new SD entry.
