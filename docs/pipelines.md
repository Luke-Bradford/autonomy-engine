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
- **Values come from whatever invokes the pipeline.** The pipeline's saved
  default is the base; the invoker's override wins. A required parameter
  with neither refuses the run. A `secret` parameter resolves its value
  through the credential store at resolution time — the raw value never
  appears in a document or on a command line.
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
it). Parameter values that supply them come from **triggers** (below);
calling one pipeline from another is coming with the pipeline-call
activity.

One deliberate hole: a `secret`-typed parameter currently has **no
delivery channel**. A reference to one refuses the document, and a
trigger value or saved default that would resolve one refuses the run —
the engine has no sink today that does not land in a file or on a
command line. The environment-variable channel is coming with the
pipeline-call phase; until then secrets are declared-only.

## Activities

Supported today: `pick`, `agent_task`, `plan`, `gather`, `check`,
`subagent_review`, `summarize`, `notify`, `transform`, `triage`,
`journal`, `housekeep`, `git_ops`. Each type has a **spec sheet**
(required fields, optional fields, what it emits) defined in one place in
the code (`lib/pipeline.py`, `SPEC_SHEETS`) — the validator, the canvas
palette, and the property pane all read the same table, so they cannot
disagree.

Declared but **not yet executable** (the validator refuses them, and the
canvas shows them disabled rather than pretending): `wait_watch`,
`ask_human`, `handoff`, `run_command`, plus `branch` and `for_each`
containers. Merging is never an agent free-for-all in any pipeline:
`git_ops` merge operations always go through the engine's merge gate.

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
  never replayed as a storm), or `manual` (fires when the operator drops
  a file named after the trigger into `var/trigger-ctl/fire/`; the
  marker is consumed on start, kept when the trigger is at capacity or
  disabled). `event` mode is coming with the event-trigger phase — a
  trigger declaring it refuses rather than being accepted and ignored,
  and in the meantime event-triggered work stays on the `roles:` config.
- **`concurrency.policy`** governs overlapping runs of this one trigger:
  `skip` (default, max 1 — an in-flight run advances, a new fire is
  skipped), `queue` (max 1, depth 1 — one scheduled fire waits for the
  current run to end; a second overwrites the first), or `parallel` up
  to `max` (8 ceiling) simultaneous runs. Parallel runs do not claim
  work items for you: the pipeline's pick brief must claim its ticket
  (assign/label at pick time) so two runs never grab the same one.
- **`enabled: false`** pauses the trigger: no new fires, in-flight runs
  drain gracefully. A hard stop is the file `var/trigger-ctl/stop/<name>`:
  no new fires AND in-flight runs freeze in place (state preserved;
  remove the file to resume mid-run). A trigger whose sessions error
  backs off individually (exponential, per trigger) so one broken
  trigger never monopolises the loop's retries. Under a lane supervisor
  every marker name carries the lane suffix — `stop/<name>--<lane>`,
  `fire/<name>--<lane>` — so a same-named trigger in another lane is
  never frozen or fired by mistake.
- **Editing:** the same var-live shadow rule as pipelines — a file at
  `var/autonomy/triggers/<name>.json` beats the committed one; a
  present-but-invalid shadow refuses that trigger (never a silent
  fallback to the committed file).

**Existing `roles:` configs keep working unchanged.** On every tick the
engine synthesises a trigger per enabled loop role (continuous) and cron
role (schedule) — same name, same one-run-at-a-time semantics, settings
resolved through the role exactly as before. A trigger FILE with a
role's name replaces that role's automatic trigger; a broken trigger
file refuses and its role stays replaced (a broken replacement never
silently resurrects what it replaced). The dashboard still displays the
role view; triggers get their own surface in a later phase.

## How a run executes

1. **Trigger fires** (loop iteration, cron, manual marker) → the engine
   resolves the trigger's pipeline, resolves its parameters, and starts
   a run: a state file records every unit as `pending`.
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
anything merge-affecting ran. From this journal the engine projects a
**trust tier** per role+pipeline assignment: `watch` until the assignment
has ≥20 recorded runs with ≥95% passing over the last 20, then `auto`.
Lost or corrupt journal evidence always lands on the cautious side
(`watch`).

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
