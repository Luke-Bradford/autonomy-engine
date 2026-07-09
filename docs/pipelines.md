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

The runnable invocation surface — triggers that supply parameter values,
and calling one pipeline from another — is coming with the trigger
system. Until it lands, `${…}` references in activity fields are refused
by the validator (a document that validates must be one the engine can
actually run today); the declarations themselves validate now so a
pipeline's interface can be authored ahead of it.

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

## How a run executes

1. **Trigger fires** (loop iteration, cron, or event) → the engine
   resolves the role's pipeline and starts a run: a state file records
   every unit as `pending`.
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
