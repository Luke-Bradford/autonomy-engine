# Pipelines — how the engine runs multi-step agent work

A **pipeline** describes a sequence of agent activities as a graph: what
runs, in what order, what happens on success or failure, and what may run
in parallel. The engine executes pipelines against a target repository,
records every run, and renders the graph live in the dashboard.

This is the user/contributor-facing specification of the pipeline system
as it exists in the code today. It assumes no knowledge of how the feature
was built. (Engineering-process records — decision logs, build plans —
live separately; see [README.md](README.md) for the split.)

## The one-paragraph model

Each configured role either **binds a pipeline by name** or runs as a
single-activity pipeline synthesized from its prompt (so there is exactly
one dispatch path). A pipeline is a folder in the target repo:
`.autonomy/pipelines/<name>/` containing `pipeline.json` (the graph) and
one Markdown **brief** per activity (the prompt material). When the role's
trigger fires (continuous loop, cron schedule, event, or manual), the engine walks
the graph: it dispatches one agent session per ready activity, records the
outcome, follows the edges, and finishes the run with a single journal
record.

## The document

`pipeline.json` — plain JSON, parsed with the Python standard library:

```json
{
  "name": "ticket-to-merge",
  "version": 2,
  "trigger_default": {"type": "loop"},
  "caps": {"max_sessions_per_run": 16, "max_parallel": 2},
  "nodes": [
    {"id": "pick", "type": "pick", "brief_ref": "pick.md"},
    {"id": "code", "type": "agent_task", "brief_ref": "code.md",
     "runs_as": {"model": "claude-sonnet-5"}}
  ],
  "edges": [
    {"from": "pick", "to": "code", "on": "success"}
  ],
  "containers": []
}
```

- **Nodes** are activities. Each carries exactly one prompt source
  (`brief_ref`, a sibling file in the same folder — path traversal is
  rejected) and may pin who runs it (`runs_as`: model, effort, account,
  agent).
- **Edges** are typed dependencies: `on: success`, `on: failure`, or
  `on: completion` (fires either way). A failure edge IS the error
  handler: a handled failure does not fail the run; an unhandled one does.
- **Containers** group nodes. A `loop` re-runs its children until an
  agent-judged exit condition is met, under an enforced `max_rounds` cap.
  A `stage` runs its children as a unit with a shared default `runs_as`.
- **Back-edges** (`"back": true, "max_bounces": N`) send work upstream —
  e.g. a failed review returns to the coding loop — with an enforced
  bounce cap. When the cap is exhausted, a normal failure edge (typically
  to a notify/park activity) takes over.
- **Joins**: a node with several incoming edges is ready when ALL are
  satisfied (`"join": "all"`, the default) or when ANY is
  (`"join": "any"` — used for fan-ins like "journal after success OR
  park").
- **Caps** are engine-enforced, not advisory: `max_sessions_per_run`
  bounds the whole run; `max_parallel` (1–8) bounds concurrent sessions.

The validator refuses anything the engine cannot actually honor — unknown
keys, unsupported activity types, malformed graphs (cycles without a
declared back-edge, edges into a container's interior). A document that
validates is a document that runs; there is no accept-and-ignore.

### Parameters & outputs

A pipeline may declare a typed interface:

```json
{
  "params": [
    {"name": "repo",  "type": "repo",  "required": true},
    {"name": "model", "type": "model", "default": "claude-sonnet-5"},
    {"name": "mode",  "type": "enum",  "choices": ["fast", "safe"], "default": "safe"}
  ],
  "outputs": [
    {"name": "merged_pr", "type": "number"}
  ]
}
```

- **Param types:** `string`, `number`, `bool`, `enum` (with `choices`),
  `repo`, `agent`, `model`, `account`, `secret`. Declarations are
  validated — a bad type, a duplicate name, an enum without choices, or a
  default that does not match its declared type all refuse the document.
- **Values come from whatever invokes the pipeline** — a trigger or a
  calling pipeline, the same slot. The pipeline's saved default is the
  base; the invoker's override wins. A required parameter with neither
  refuses the run. A `secret` parameter's value is a credential **label**
  (a name in the credential store, not the secret itself); the real value
  resolves only at dispatch, into the session's environment — see
  **Secrets** below.
- **References:** `${params.x}` reads a parameter,
  `${nodes.<id>.output.<name>}` reads a completed upstream activity's
  named output, `${run.<field>}` reads run metadata. A field that is
  exactly one reference keeps the typed value; a reference embedded in
  text interpolates as a string. A small closed set of helper functions
  is allowed inside `${…}` — `default(x, y)`, `concat(a, b, …)`,
  `slug(x)` — and nothing else; the language never evaluates code. A
  literal `${` is written `$${`. One limitation: a string literal inside
  `${…}` may not contain `}` (the expression is refused, never
  mis-parsed).
- **Outputs:** an activity writes named values to a per-run outputs file;
  the pipeline's declared `outputs` project from it by name and type —
  an undeclared value never leaks to a consumer, and a value that does
  not match its declared type refuses rather than passing through.
  Output types are the parameter types minus `enum` (an output
  declaration carries no `choices`, so it could never be checked) and
  `secret` (the outputs file is plaintext on disk — a secret value is
  never invited into it).

`${…}` references are live in activity fields (`runs_as.*`, container
fields) and in brief text: the validator checks every reference
statically (a reference to an undeclared parameter, a non-upstream
activity's output, an unknown run field, or a non-allowlisted function
refuses the document), and the engine resolves them when it prepares
each session. Two places never substitute: `brief_ref` and
`legacy_prompt` are file paths, resolved before substitution exists in
the flow, so a `${…}` there refuses. A resolved value is re-checked
against the concrete rules for its field (a parameter that resolves to
an invalid model name refuses that dispatch rather than running with
it).

**Which activity outputs may a field reference?** Anything strictly
upstream — including the nodes inside an upstream container — plus
**earlier siblings in the same container** (container children run in
order). Later siblings and downstream activities stay refused: their
outputs cannot exist yet. There is one sanctioned way to read a value
"from the future": a node that a **back-edge** re-runs may read the
back-edge source's outputs, but only as the first argument of
`default(…)` — on the first visit the output does not exist and the
fallback compiles; after a bounce the real value does. This is the
findings-return pattern:

```json
"nodes": [
  {"id": "pick", "type": "pick", "brief_ref": "pick.md"},
  {"id": "code", "type": "agent_task", "brief_ref": "code.md"},
  {"id": "qa", "type": "call_pipeline", "pipeline": "qa-sweep",
   "params": {"target": "${nodes.code.output.branch}"}}
],
"containers": [{"id": "st", "kind": "stage", "children": ["code"]}],
"edges": [
  {"from": "pick", "to": "st", "on": "success"},
  {"from": "st", "to": "qa", "on": "success"},
  {"from": "qa", "to": "st", "on": "failure", "back": true, "max_bounces": 3}
]
```

with `code.md` containing
`${default(nodes.qa.output.findings, 'first pass -- no findings yet')}`:
each bounce recompiles the coding brief with the QA child's actual
findings. Only a genuinely missing node output maps to the fallback; a
typo'd parameter inside `default(…)` still refuses.

## Activities

Supported today: `pick`, `agent_task`, `plan`, `gather`, `check`,
`subagent_review`, `summarize`, `notify`, `transform`, `triage`,
`journal`, `housekeep`, `git_ops`, `call_pipeline`. Each type has a
**spec sheet** (required fields, optional fields, what it emits) defined
in one place in the code (`lib/pipeline.py`, `SPEC_SHEETS`) — the
validator, the canvas palette, and the property pane all read the same
table, so they cannot disagree.

Declared but **not yet executable** (the validator refuses them, and the
canvas shows them disabled rather than pretending): `wait_watch`,
`ask_human`, `handoff`, `run_command`, plus `branch` and `for_each`
containers. Merging is never an agent free-for-all in any pipeline:
`git_ops` merge operations always go through the engine's merge gate.

## Calling another pipeline

A `call_pipeline` activity runs another pipeline as a real **child run**:

```json
{"id": "qa", "type": "call_pipeline", "pipeline": "qa-sweep",
 "params": {"target": "${nodes.code.output.branch}"}, "wait": true}
```

- The child is resolved and parameterised exactly like a trigger-started
  run: its saved defaults are the base, the caller's `params` are the
  overrides (values may use `${…}` against the parent's context). It
  executes in the parent's repo and lane, gets its own journal line
  (linked by `parent_run`), and advances tick by tick alongside the
  parent — the parent does not block the loop while waiting.
- **`wait: true`** (the default): the call activity stays open until the
  child finishes. The child's outcome drives the parent's edges (child
  failure fires the parent's `on: failure` path), and the child's
  declared **outputs** become the call activity's outputs —
  `${nodes.qa.output.findings}` downstream reads them. A **failed**
  child's outputs still return: a QA child that found problems is
  exactly the child whose findings the failure path needs.
- **`wait: false`**: fire-and-forget. The call records success
  immediately and the detached child reports independently; referencing
  a detached call's outputs anywhere refuses the document (they never
  return).
- A call node carries no brief and no `runs_as` — the child's own
  document declares who runs it (the caller may override any of that
  through `params`).
- **The run cap counts dispatches.** Starting a child spends one unit of
  the parent's `max_sessions_per_run` immediately, exactly like an agent
  session — so a back-edge that keeps re-calling a child is bounded by
  the same cap as everything else.
- Guard rails: call depth is capped at 3; a pipeline that (transitively)
  calls itself refuses; a missing or invalid child pipeline fails the
  call activity with a named reason — the failure edge handles it, the
  run never crashes.
- One edge case to know: a `call_pipeline` as the **last child of a loop
  container** exits the loop when the child succeeds (a child run has no
  verdict channel; loop-exit verdicts come from agent sessions).

While a run is only waiting on children, the supervisor logs it as
waiting and spends no session on it.

## Triggers

A **trigger** is its own JSON file, `.autonomy/triggers/<name>.json`,
that binds ONE pipeline, supplies its parameter values, and says when it
fires and how overlapping runs behave:

```json
{
  "name": "coder-repoA",
  "pipeline": "ticket-to-merge",
  "params": {"repo": "/abs/path/to/repoA", "m": "claude-opus-4-8"},
  "firing": {"mode": "continuous"},
  "concurrency": {"policy": "skip", "max": 1},
  "run_windows": [{"start": "22:00", "end": "06:00", "days": ["fri"]}],
  "enabled": true
}
```

- **`name`** must equal the filename stem (a rename cannot silently fork
  identity). Many triggers may reference one pipeline — same activities,
  different parameters.
- **`params`** is a flat map of scalar values; each is type-checked
  against the pipeline's declaration when a run starts. A required
  parameter with no value refuses the run before any session is spent.
  A `repo`-typed value must be a checkout registered with the engine and
  an `account`-typed value must exist in the accounts index — an
  unreadable registry refuses a run that needs it (can't verify = don't
  run).
- **`firing.mode`** is `continuous` (fires every loop tick while work
  and capacity exist), `schedule` (5-field cron in `firing.schedule`;
  missed fires while the machine was off are skipped with a warning,
  never replayed as a storm), `manual` (fires only on an operator
  run-now), or `event` (below). A run-now fire — a file named after the
  trigger in `var/trigger-ctl/fire/` — works on **manual, continuous
  and schedule** triggers alike: it starts one run through the ordinary
  dispatch path, capacity-gated by the trigger's own overlap policy.
  The marker is consumed on start and kept (deferred) while the trigger
  is at capacity, disabled, stopped, or outside its run window. On a
  schedule trigger the fire is an **extra** run — the schedule itself
  is untouched, so the next cron fire still happens exactly when it
  would have. An event trigger never fires from a marker (its runs
  start from event deliveries); such a marker is removed with a
  warning.
- **`firing.mode: event`** fires on repository events. `firing.event`
  names one of the four kinds the engine polls — `pr.opened`,
  `issue.created`, `merge.done`, `pr.synchronize` — and an optional
  `firing.map` feeds the event payload into the pipeline's parameters:

  ```json
  "firing": {"mode": "event", "event": "pr.opened",
             "map": {"pr_number": "item"}}
  ```

  Mappable fields: `item` (the PR/issue number), `sha` (the new head —
  `pr.synchronize` only), `event` (the kind itself). A mapped parameter
  may not also be set in `params` (one source per value), and may never
  be `secret`-typed (an event payload is not a credential). Each NEW
  event token starts one fresh run of the pipeline, which then advances
  through the normal loop — so the run's first session lands on the
  following tick, not instantly. Tokens the trigger had no capacity for
  are redelivered next tick; `concurrency: queue` is refused for event
  mode (redelivery already is the queue).
- **`concurrency.policy`** governs overlapping runs of this one trigger:
  `skip` (default, max 1 — an in-flight run advances, a new fire is
  skipped), `queue` (max 1, depth 1 — one scheduled fire waits for the
  current run to end; a second overwrites the first), or `parallel` up
  to `max` (8 ceiling) simultaneous runs. Parallel runs do not claim
  work items for you: the pipeline's pick brief must claim its ticket
  (assign/label at pick time) so two runs never grab the same one.
- **`run_windows`** (optional) restricts when the trigger may START new
  runs: a list of `{start, end, days?}` windows, times as `HH:MM` in
  **UTC** (the same clock as cron schedules), start inclusive, end
  exclusive. `end <= start` wraps past midnight, and a wrapped window's
  `days` list names the day the window STARTS (`22:00`–`06:00` with
  `days: ["fri"]` covers Friday night into Saturday morning). Omit the
  key for always-dispatchable; an explicit empty list is refused. New
  runs only: in-flight runs finish their current activity and keep
  advancing past the boundary. Run-now fire markers and queued fires
  wait for the window to open; a schedule fire that came due while the
  window was closed fires once at window-open (never a replay storm);
  event tokens redeliver at window-open. Two accepted bounds: window
  precision is one loop tick (a run can start just inside the boundary
  the tick observed), and a trigger FIRST seen at window-open seeds its
  schedule/event baseline without firing (the engine's normal
  first-sight behaviour). `triggers.py show` prints
  `WINDOW=open|closed`.
- **`enabled: false`** pauses the trigger: no new fires, in-flight runs
  drain gracefully. Pending run-now and queued fire markers are kept and
  fire on re-enable (a deferred fire is a new start, so it re-checks
  enabled/mode/window before running). A hard stop is the file `var/trigger-ctl/stop/<name>`:
  no new fires AND in-flight runs freeze in place (state preserved;
  remove the file to resume mid-run) — a stop also holds any pending
  run-now fire, which fires on resume. An error backoff does not hold
  an explicit run-now fire (the operator's fire overrides the machine's
  caution). A trigger whose sessions error
  backs off individually (exponential, per trigger) so one broken
  trigger never monopolises the loop's retries. Under a lane supervisor
  every marker name carries the lane suffix — `stop/<name>--<lane>`,
  `fire/<name>--<lane>` — so a same-named trigger in another lane is
  never frozen or fired by mistake.
- **Editing:** the same var-live shadow rule as pipelines — a file at
  `var/autonomy/triggers/<name>.json` beats the committed one; a
  present-but-invalid shadow refuses that trigger (never a silent
  fallback to the committed file).
- **Starter files:** onboarding scaffolds one inert example per firing
  mode into `.autonomy/triggers/` (`continuous-example`, `nightly-example`,
  `on-pr-sync-example`, `manual-example`), each `"enabled": false` so a
  fresh onboard never auto-arms a loop. They exist to be copied and edited;
  see `.autonomy/triggers/README.md`. `bin/doctor.sh <repo>` reports every
  trigger — validity, mode, native-vs-shim, enabled/disabled, bound
  pipeline — as read-only INFO lines (it never provisions).

**Existing `roles:` configs keep working unchanged.** On every tick the
engine synthesises a trigger per enabled loop role (continuous), cron
role (schedule), and event role (event — same wake behaviour as before,
including the `session.done` internal edge, which native event triggers
do not have: it is a loop-internal signal, not a subscribable event). A
trigger FILE with a role's name replaces that role's automatic trigger;
a broken trigger file refuses and its role stays replaced (a broken
replacement never silently resurrects what it replaced). The dashboard
still displays the role view; triggers get their own surface in a later
phase.

## Secrets

A `secret`-typed parameter carries a credential **label** — the name of
an entry in the engine's credential store (the macOS Keychain), never
the secret itself. Labels are ordinary non-secret strings: they may sit
in a trigger file, a saved default, or a run's recorded parameters.

The value has exactly one delivery channel: an activity's `secrets:`
map, which requests it as an environment variable for that activity's
sessions —

```json
{"id": "deploy", "type": "agent_task", "brief_ref": "deploy.md",
 "secrets": {"DEPLOY_TOKEN": "${params.deploy_key}"}}
```

- The value must be **exactly** `${params.<name>}` of a declared
  `secret` parameter — a secret never mixes into a string or function.
- The variable name is upper-case and may not shadow engine or auth
  variables (`PATH`, `HOME`, `ANTHROPIC_*`, … — refused at validation).
- Everywhere else, `${params.<secret>}` refuses the document: briefs,
  `runs_as`, call params — none of them may carry a secret.
- At dispatch the engine resolves each label to its value in the
  credential store and exports it **only into that session's
  environment**. An unresolvable label refuses the session (never runs
  without a declared secret, never runs with an empty one). The value
  never appears in state files, the journal, compiled briefs, or the
  engine's own logs.
- After each session the engine scrubs any occurrence of the value from
  the session log. **Known residual:** if the agent echoes the secret,
  it is visible in the live log until that post-session scrub — the same
  residual as any environment-provided credential. Prefer scoped,
  revocable credentials.

## How a run executes

1. **Trigger fires** (loop iteration, cron, event token, manual marker)
   → the engine resolves the trigger's pipeline, resolves its
   parameters, and starts a run: a state file records every unit as
   `pending`.
2. **Ready set** → units whose incoming edges are satisfied. The engine
   dispatches up to `max_parallel` of them, one agent session each. Each
   session receives a **compiled brief**: the activity's brief plus the
   engine's framing (loop round counters, verdict-file instructions).
   Parallel sessions run in disposable git worktrees so they cannot
   collide on one checkout.
3. **Outcome recorded** → session success/error, optionally refined by a
   **verdict file** the session writes: `{"exit": true}` ends a loop
   container; `{"outcome": "success"|"failure"}` steers branch-style
   edges regardless of the session's own exit.
4. **Edges fire** → downstream units become ready, unreachable ones are
   marked `skipped`, back-edges bounce work upstream (resetting the
   target container's rounds) until their cap.
5. **Run completes** when nothing more can become ready: `success`,
   `failure` (an unhandled failure), or `capped` (a runaway cap hit —
   the run parks for a human).

Interrupted runs resume: the state file survives restarts, and a session
that ends on a usage limit is released back to `pending` rather than
counted.

## The journal and earned autonomy

Every completed run appends one line to
`var/autonomy-logs/journal.jsonl`: outcome, per-activity results (which
edges each traversed, bounce counts, verdicts), sessions used, whether
anything merge-affecting ran, and which trigger started the run (plus
whether that trigger was a real file or a synthesised role trigger).
From this journal the engine projects a **trust tier** per TRIGGER --
the pipeline as parameterised: `watch` until that trigger has ≥20
recorded runs with ≥95% passing over the last 20, then `auto`.

- Runs recorded before the trigger model existed count toward the
  same-name synthesised role trigger. A trigger FILE of the same name is
  a new parameterisation and starts from zero.
- Runs a pipeline starts in another pipeline (`call_pipeline` children)
  never count as trigger evidence: no trigger fired them.
- Lost or corrupt journal evidence always lands on the cautious side
  (`watch`).
- Each pipeline also gets a **rollup** tier: `auto` only when EVERY
  trigger bound to it reads `auto`, else `watch`. Disabled and
  off-lane triggers still contribute (pausing a trigger never hides
  its record).

`python3 lib/triggers.py trust <repo> <journal>` prints one `TRIGGER`
row per trigger (name, pipeline, kind, runs, passes, tier), one
`REFUSED` row per unreadable trigger file (an unreadable trigger cannot
be attributed to a pipeline, so the report itself carries the caveat),
then one `PIPELINE` rollup row per pipeline.

## Seeing it: the pipeline canvas

The dashboard serves **`/pipeline`** — a read-only canvas per role:

- the graph auto-laid-out left-to-right (containers as boxes, parallel
  activities stacked, back-edges as labelled arcs),
- a palette of every activity type (unsupported ones visibly disabled),
- a property pane rendered from each type's spec sheet,
- a **last run** overlay lighting the path the most recent run actually
  took — per-activity ✓/✕, traversed edges, bounce badges — straight from
  the journal,
- live pulse on activities currently running,
- a **search box** to find an activity by id, type, or agent (matches
  highlight, the rest dim, a count shows, and Enter jumps to the first),
  and an **overview map** for wide graphs — a scaled thumbnail with a
  draggable viewport rectangle you drag to pan the canvas.

An invalid pipeline renders its validator errors with the document still
visible — the page shows you what is wrong rather than hiding it.

**Editing from the canvas.** A role bound to a pipeline is editable: drag
activity types from the palette to add nodes, drag a node's handle to another
node to draw a typed edge, click an edge to cycle its type (or shift-click to
delete it), and edit each activity's fields and brief in the property pane —
then **Save**. Edits are written to a **local shadow**
(`var/autonomy/pipelines/<name>/`), leaving the committed pack — the shareable
default — untouched; the shadow is what the engine then runs. A save is
**validated before it lands**: an invalid graph is refused, not stored, and the
errors are shown in place. A live view never overwrites your unsaved edits — a
badge marks unsaved changes until you Save or Revert. Guarded fields (merge
always via the gate, enforced caps) are visible but not editable, and
not-yet-runnable activity types stay disabled. Only a role bound to a pipeline
is editable; an auto-wrapped role is read-only until you bind one. You can still
edit the JSON and briefs directly instead — the validator and canvas tell you
immediately if the result is runnable.

**The trigger views.** `/pipeline` opens on four tabs:

- **🗂 pipelines** — one card per pipeline with its version, activity
  count, trust rollup, the triggers bound to it, and a **provenance
  badge**: `template` is a committed pack (the shareable default);
  `template · local edits` means the canvas has saved a local shadow over
  it; `created blank` and `clone · from <source>@v<N>` are pipelines
  created from this page; a clone that has been edited since shows
  `⚠ diverged`. An invalid pipeline shows its errors on the card.
  **＋ trigger** opens the trigger form pre-bound to that pipeline.
  - **＋ new pipeline / ⧉ clone** create a pipeline in the **local shadow**
    (`var/autonomy/pipelines/<name>/`): blank gives a minimal one-activity
    starter you then edit on the canvas; clone copies an existing
    pipeline — document and briefs — under a new name and records where it
    came from. A name that already exists (committed or local) is
    refused, and an invalid pipeline refuses to clone (fix it first). The
    new pipeline runs once a trigger binds it — creation alone starts
    nothing.
  - **🗑 delete / ⟲ reset** remove a pipeline's local shadow (and its
    provenance record). On a created pipeline that is a full **delete** —
    triggers still bound to it show a missing-pipeline warning until
    rebound or deleted. On a locally-edited template it is a **reset**:
    the committed template becomes live again. Committed templates
    themselves are never deletable from the page — edit or remove them in
    the repo. The page asks first, naming what happens; the delete is
    **refused while the pipeline has a run in flight or a pending fire is
    queued** (let it finish, or stop it), and a refusal changes nothing
    on disk.
- **⚡ triggers** — one card per trigger: firing mode (continuous /
  schedule / manual / event), enabled state, overlap policy, run-window
  state, parameter count, per-trigger trust tier, and any pending markers
  (a queued fire, an error backoff, a stop freeze). The controls:
  - **＋ new trigger / ✎ edit** open the trigger form: pick the pipeline,
    the firing mode (with its cron string or event + payload mapping),
    overlap policy, run windows, and a **typed input per parameter the
    pipeline declares** (booleans offer unset/true/false; enums offer
    their choices; a blank input means "use the pipeline's default").
    Saving **validates first** — an invalid trigger is refused with the
    reasons, and nothing lands. Saves go to a **local shadow**
    (`var/autonomy/triggers/<name>.json`); the committed pack stays the
    shareable default. A save whose pipeline is missing, or whose
    parameters would not currently resolve, still lands — with a warning —
    so you can stage work in progress; such a trigger refuses to start
    until fixed, and its card says why.
  - **the enabled switch** disables/enables a trigger (disable = drain: no
    new runs, in-flight runs finish). Editing or toggling a trigger that
    was synthesised from a legacy `roles:` entry **converts it to a native
    trigger file** — the page asks first, because the role's own
    prompt/model settings stop applying: the pipeline's own configuration
    drives the run from then on.
  - **▶ run now** fires a **manual, continuous or schedule** trigger on
    the supervisor's next pass (or holds while disabled / stopped /
    outside its run window). On a continuous trigger it starts one run
    ahead of the loop's round-robin; on a schedule trigger it starts one
    extra run and leaves the schedule untouched. When the pipeline
    declares parameters and the trigger is a native file, run-now opens
    a form to **override them for this one run** (pipeline default <
    trigger's saved value < your run-now value); the payload is
    validated before anything is written, and secret parameters are
    never accepted here. A trigger synthesised from a legacy `roles:`
    entry fires through the role path and takes no parameters (convert
    it to a native trigger to use them). Event triggers never fire from
    here — their runs start from event deliveries. Run-now is disabled,
    with the reason shown, when firing would be refused.
  - **■ stop / ▶ resume** set and clear the freeze marker (a stopped
    trigger starts nothing and its in-flight runs hold in place).

  - **🗑 delete / ⟲ reset** remove a trigger's local shadow file. On a
    locally-edited trigger that shadows a committed one it is a
    **reset** — the committed trigger resurfaces. On a trigger that was
    converted from a legacy `roles:` entry, deleting the file brings the
    **role's synthesised trigger back** — the conversion runs in reverse,
    and the role's own prompt/model settings apply again; the page's
    confirmation says so. A trigger that exists only as a local file is
    removed for good. Deletes are **refused while the trigger has a run
    in flight or a pending fire/queued marker** (a fire consumed after
    the delete would land on whatever resurfaces), and a refusal changes
    nothing on disk. Committed trigger files are not deletable from the
    page.

  A trigger file the engine refuses to load appears here verbatim, and
  also in the dashboard's "Needs you" queue.
- **▶ runs** — in-flight runs first (one row per parallel slot), then the
  recent history. A run started by `call_pipeline` indents under its
  caller; **💡 canvas** opens that run's own graph lit with its progress,
  and a child's canvas carries a link back to its parent.
- **🎨 canvas** — the editor above, now addressable by pipeline name (from
  a gallery card) or by a single run, not only by role.

The main dashboard page reflects the same model: the repo rail lists
triggers grouped by pipeline (a legacy `roles:` config looks unchanged —
its synthesised triggers carry the same names), the repo card shows the
pipeline trust rollup, and refused triggers raise into "Needs you".

## Configuration reference

```yaml
# .autonomy/config.yaml (target repo)
roles:
  coder:
    pipeline: "ticket-to-merge"   # binds a pipeline by folder name
```

- No `pipeline:` key → the role runs its classic single-prompt session,
  internally wrapped as a one-activity pipeline. Existing configurations
  keep working unchanged.
- Starter pipelines ship in `templates/autonomy-pack/pipelines/` and are
  scaffolded into new target repos by onboarding.
- Onboarding also seeds two optional **starter skills** into the target
  repo's `.claude/skills/` (`working-under-the-loop`,
  `pipeline-sessions`) — trigger-scoped guidance that sessions load when
  relevant. They elaborate the engine's rules; they never replace them
  (everything correctness-critical is compiled into the brief regardless).
  Once scaffolded they belong to your repo: edit freely, onboarding never
  overwrites an existing file.
