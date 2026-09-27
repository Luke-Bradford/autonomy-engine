# Foundation — pipeline variables (V-series)

**Status:** spec, no code. Owner ticket: #844 item 1 (the variables half; globals stay with spec #1
D3 / F7 and are not covered here). **Supersedes spec #1's D2 "Variables" bullet** (`${vars}`,
`set_variable`/`append_variable`, `RunState.variables`) and its tickets F5a/F5b/F5c/F6 — D2 was
written before the engine had containers, `skipped`, the drain model or rerun-from-failed, and two of
its premises no longer hold (V-D6, V-D7). What D2 settled and this spec keeps: variables are mutable
in-run, typed, mutated by events only, read as `${vars.x}`, no self-reference, and a nondeterministic
write is **hard-rejected** with an explicit per-container opt-in (spec #1 resolved-q3).

## Why

A pipeline cannot carry state today. Node outputs are round-local: `resetContainerRound` →
`resetNodes` deletes a loop body's outputs on every re-entry, and a parallel foreach deletes a
finished item's instance outputs. So there is no way to count attempts across `loop` rounds, collect
results over a sequential `foreach`, keep an LLM-judge running total (spec #6 Round-2 C2 — why
`number` is a first-class variable type), or set one `status` on either branch of an `if` and read it
after the join. ADF's answer is pipeline variables, and ours is the same, specified tighter.

## What exists today (measured 2026-09-27)

- `PipelineVersionSchema` (`schemas/pipeline.ts`) has no `variables` field. `pipeline_versions`
  stores each doc field as its **own column**, so a new doc field needs a new column (#473: a field
  the table lacks is silently dropped on insert).
- `refRoot` (`engine/params.ts`) is the single source of truth for `${}` roots: `item`, `params`,
  `nodes.*.output`/`.status`, `run`, `trigger`, `tool.args`. Nothing reserves `vars`. The resolver,
  `checkRefRoot`, `inferExprType` and the flyout's `refsInScope` all read it. Trigger bindings and
  tool expressions evaluate under closed `allowedRoots` sets (`{trigger}`, `{tool, item}`).
- The run-time scope is `buildCtx(state)` → `SubstitutionContext` `{params, nodeOutputs,
  nodeStatuses, run, trigger}`.
- Control activities are evaluated inside the pure fixpoint: `if`/`switch` compute a value in
  `tryDispatchNode`, mark the node `ready`, and push `evaluateControl`. The driver appends
  `condition.evaluated`/`switch.evaluated`, and `onControlBranchEvaluated` folds it: attempt/status
  guards, node → `success`, record the decision, `settle`. An evaluation that THROWS goes to
  `prepFailure` and ends the run `invalid_event`. After a crash, `projectRunState` restores state,
  not commands, so each control type has a resume branch that re-emits its command for a `ready`
  node.
- `failNode` carries `{nodeId, attemptId, error}` only. The driver hardcodes `kind:'permanent'` and
  `code:'forced_fail'`.
- `run.reseeded` carries `frontier` (top-level ids), `copiedOutputs` and `copiedContainers` (bodies
  travel in these). `reseedFrontier(sourceState)` is pure over projected STATE, while its caller
  (`server/src/run/reseed.ts`) also holds the source run's events. The RS built-block and the comment
  on `run.reseeded` in `engine/types.ts` say `copiedVariables` was DROPPED because "there is no
  separate variables store". That was true when written and stops being true here (V-D7).
- There is **no `parallel` container** (`ContainerKindSchema = loop | stage | foreach`), and
  containers do not nest. Concurrency comes from a foreach with `batchCount ≥ 2`
  (`isParallelForeach`) and from DAG nodes that nothing forces into an order. Edges carry no `${}`.
- `validateRefs`' `computeGraph` builds four per-node relations. `reachable` is **"may run before it
  on some path"**, which is not an ordering. `settled` is **"guaranteed terminal on every path to
  it"**, which is. For any doc that can re-run nodes (a loop, a foreach or a back-edge), the
  `canReRunNodes` flag empties `settled` doc-wide, and those are exactly the docs variables are for.

## Decisions

### V-D1 — Declared on the immutable version doc

`PipelineVersion.variables: VariableDef[]`, where
`VariableDef = { name, type, default, description? }`.

- **`type` ∈ `string | number | boolean | array`**, a new `VariableTypeSchema`. It is NOT
  `ParamTypeSchema`: that one has `json` and `secret`, and no `array`. `string`/`number`/`boolean` are
  spelled as they are for params. `array` is variable-only, and its elements are untyped JSON values.
  Anything that today takes a `ParamType` and would now take a variable type (`sigOfDeclared`,
  `RefSuggestion.declaredType`) widens explicitly.
- **No `secret` type.** A variable's value is written into the run log in clear (V-D4), so a secret
  has nowhere safe to live. `OutputSchema` excludes `secret` for the same reason.
- **`name`** must be unique among the variables and addressable as `${vars.<name>}`, using the rule
  `isAddressableOutputName` already states for node outputs. Unlike the params editor, which only
  notes an unreferenceable name (#1354), this is a hard save-time error: a variable exists only to be
  read by name, so an unaddressable one is a defect. Variables and params are separate roots, so
  `params.x` and `vars.x` may coexist.
- **`default` is REQUIRED and checked STRICTLY against `type`** with `matchesSig`, with no coercion.
  A doc default of `"5"` for a `number` is an error; the doc stores `5`. The default is a literal and
  is never substituted, as decided for param defaults (#844 item 3). It is required because an unset
  variable has no honest value, and inventing `''` or `0` at run time is the fail-open shape this
  codebase refuses elsewhere. The editor writes the type's zero value (`''`, `0`, `false`, `[]`) into
  the doc when a row is added, so the doc always states the starting value.

### V-D2 — Persistence and portability

- **DB.** A new `variables` JSON column on `pipeline_versions`, `NOT NULL`. A SQL `DEFAULT '[]'`
  exists only to backfill rows that predate the migration. There is no Drizzle-level default, so an
  insert that omits the key does not compile. That column-plus-no-Drizzle-default pair is the #473
  fix; #473's failure was a missing column silently dropping the key on write. A round-trip test
  writes a version with variables and reads them back.
- **Zod.** `PipelineVersionSchema.variables` is `z.array(VariableDefSchema).default([])`, exactly
  like `containers`, because the same schema parses old exports and old git blobs, which have no key.
  `PipelineVersionExportSchema` derives from it. This default is not the #473 hazard. The DB read path
  never sees an absent key, because the column is `NOT NULL`. On the import path, "absent" can only
  mean "no variables".
- **An empty `variables` is OMITTED from both the serialized version file and the content form.**
  The serializer skips the key when the array is empty, and `scrubVersion`
  (`portability/content-form.ts`), the single definition of a version's content shared by
  `pipelineVersionContentForm`, `pipelineContentForm` and `dbVersionForm`, deletes it when empty.
  The reason is byte-identity. Every version that exists today must serialize and hash exactly as it
  did before V1:
  - `sourceBlobSha` records the git blob of the file as it was imported;
  - committed branch files have no `variables` key;
  - drift and the reconcile's `superseded` decision compare content forms.

  A new `variables: []` in either form would make every committed pipeline look changed, and the next
  Commit would rewrite every file for no content change. (`containers` never needed this, because it
  predates git serialization.) With the omission, "absent" and "empty" are the same content.
  Tests: an existing version's serialized file and content form are byte-identical before and after
  V1, and a version with variables survives export → import → export unchanged.

### V-D3 — Run state and lifetime

- `RunState.variables: Record<string, unknown>`. It is seeded in `seedState` and in the
  `run.started` rebuild from the bound version's defaults. This follows the RunState convention
  ("never absent", set explicitly, no `.default`).
- **Scope is the run, as in ADF.** Values persist across `loop` rounds, sequential foreach items and
  back-edge bounces. `resetNodes`/`resetContainerRound` do **not** touch them, which is the whole
  difference from outputs.
- A `call_pipeline` child has its own variables. Nothing crosses the call boundary; values cross it
  through params and outputs, as today.

### V-D4 — Writes are events, evaluated in the pure fixpoint

Two catalog entries, `kind:'control'`, category `control`:

- `set_variable { variable, value }`, which replaces the value;
- `append_variable { variable, value }`, which appends one element to an `array` variable.

The path follows `if`. In `tryDispatchNode`, the reducer evaluates `value` over the scoped eval state,
so `${item}` works inside a sequential foreach. It then runs the checks below. If they pass, it marks
the node `ready` and pushes a new command, `writeVariable { nodeId, attemptId, op: 'set'|'append',
name, value }`. The driver appends `variable.set` or `variable.append`
`{ runId, nodeId, attemptId, name, value }`. The new fold, `onVariableWritten`, applies the same
attempt/status guards as `onControlBranchEvaluated`. It then writes `state.variables[name]` (for
append, a new array with the element added to the **current** array), sets the node to `success`, and
calls `settle`. **The fold trusts the recorded value and never evaluates again.** Replay therefore
cannot diverge, even if a function's behaviour changes later.

- **Why the write and the success are one event.** They are one decision. Two events would admit a
  log where the node succeeded and the write is missing.
- **`variable.append` carries the element, not the array.** An append log grows by one element per
  write. A `set` log grows by the whole value per write. Both are bounded by the writes a run can
  make, and in a loop that bound is `maxRounds`.
- **Typing the value.** `value` goes through `substitute`'s existing modes:
  - A whole-value `${expr}` keeps its native type and must already have the declared type. There is
    no silent conversion: an expression yielding `"5"` for a `number` variable is a mismatch.
  - A literal (no `${}`) is coerced by the param `coerce` function. `coerce` gains a noun argument so
    its errors say "variable", not "param". So `5` works for a `number` and `true` for a `boolean`.
    `array` has no param counterpart, so an array value must be whole-value (`${createArray(...)}`).
  - An embedded template (`a-${x}`) can only produce a string, so it is legal only for a `string`
    variable.

  At save time, the whole-value-required check is extended to these rules, and a statically known
  mismatch is refused through `inferExprType`.
- **Run-time checks, and which way each error goes.**
  - An **evaluation that throws** (unresolvable ref, a function error) follows the existing control
    precedent: `prepFailure` ends the run `invalid_event`. Diverging from `if`/`switch` here would give
    the same expression two failure semantics depending on the node it sits in.
  - A **type mismatch** (checked with `matchesSig`, which already refuses non-finite numbers) fails
    the node `kind:'permanent'` with a new `FAILURE_CODES.VARIABLE_TYPE_MISMATCH`, so failure edges can
    handle it.
  - A value that is **not replay-safe** JSON (`assertJsonReplaySafe`, applied to the set value and to
    the appended element) fails the node `kind:'permanent'`.
  - A value **over the size bound** fails the node `kind:'permanent'`, `code:'variable_too_large'`.

  Node failures go through `failNode`, which gains an optional `code` (default `forced_fail`, so every
  existing emitter is unchanged). Under the V-D6 guard no other write to the same variable can land
  between dispatch and fold, so a check made at dispatch holds at fold. The one exception is an
  `allowNondeterministicVars` body, where appends go to the current array by construction.
- **Bounded.** After a write, the variable's serialized value must fit `VARIABLE_MAX_BYTES`
  (256 KiB, exported once from `engine/types.ts`). A larger value is **not written**; the node fails.
  It is never truncated: truncating would silently corrupt the value. The bound protects RunState,
  which is held in memory and carried into every later dispatch's scope.
- **Crash resume.** `projectRunState`'s resume path gains a branch for a `ready` `set`/`append`
  node. Without it, a crash between the command and its event leaves the node `ready` forever. **It
  must run the SAME evaluation and checks as dispatch**, through one shared function, and route to
  `failNode` or `writeVariable` accordingly. This is unlike the other control types' resume branches,
  whose single evaluation either throws or pushes one command. A blind re-emit would let a value that
  fails the type, size or replay-safety check be durably written, because the fold trusts what it is
  given.
- **Save-time rules** (in `validateDoc`):
  - `variable` names a declared variable.
  - `append_variable` targets an `array` variable.
  - `value` does not read the variable it writes. This is D2's settled no-self-reference rule (ADF
    parity; see open question 1). D2 named only `set_variable`; this spec extends it to
    `append_variable`, where an array appending itself is the same hazard.
  - `set`/`append` nodes may not carry `policy.secureInput`/`secureOutput`. This is one more arm of
    `validateSecurePolicy`, beside its `if`/`switch` arm. A value that lands in `RunState.variables`
    can be read everywhere through `${vars}`, and redaction does not cover these events, so a "secure"
    write would be a leak with a padlock on it.

### V-D5 — Reads: the `${vars.<name>}` root

- `refRoot` gains `vars.<name>`, which makes it available to the resolver, `checkRefRoot`,
  `inferExprType` and the flyout at once. `SubstitutionContext` gains `variables`, filled by
  `buildCtx`.
- Save-time: the name must be declared (worded like the undeclared-param error). `inferExprType`
  returns the declared type. `refsInScope` gains `kind:'variable'`, so the `${}` picker lists
  variables.
- A read is evaluated **at dispatch** against folded state. Replay rebuilds identical folded state,
  so a read is replay-stable without being recorded.
- **Readable in node and container `${}` fields**: node config, `if`/`switch`/`filter`,
  `call.params`, `wait.seconds`, `foreach.items` and `loop.exitWhen`.
- **Not readable in trigger bindings or tool expressions.** Their closed `allowedRoots` sets already
  exclude `vars`, and a binding is evaluated before the run exists. V2 pins both exclusions with a
  test, so a later widening cannot admit `vars` by accident.

### V-D6 — The determinism guard (supersedes D2's "parallel container" wording)

D2 rejected "variable mutation from a node that can run inside a `parallel` container". That
container does not exist, and the rule missed the other source of concurrency, **unordered DAG
nodes**: in `A → set v=1` next to `B → set v=2`, the final value depends on whether `A` or `B`
finishes first. The event log still replays such a run exactly. The guard protects the **outcome**,
which must not depend on scheduler timing.

**Accessors.** For each variable, its accessors are:

- **Writers:** the `set`/`append` nodes that name it.
- **Readers:** every node or container whose `${}` fields reference `vars.<name>`.

Readers are collected as a **side output of the same `validateRefs` scan** that checks every `${}`
site. It is not a second config walker. A site the scan checks but a separate collector missed would
be a false accept.

**Rule (save-time, `validateDoc`).** Every pair of accessors that includes a writer must be
**ordered** or **exclusive**. Any other pair is rejected, and the error names both nodes and the
variable, which is exactly the dependency edge the author needs to add.

- **Scope lifting first.** Containers do not nest. When the two accessors are in different scopes,
  each child is represented by its container's id, and the pair is compared at top level. When both
  are in one container body, they are compared inside that body's graph. A container's own fields are
  placed at their evaluation point: `foreach.items` before its body, `loop.exitWhen` after it.
- **Ordered = must precede, not may precede.** `a` and `b` are ordered iff `a ∈ settled[b]` or
  `b ∈ settled[a]`: every path to one guarantees the other is terminal. Here `settled` is `settledRaw`,
  the relation `computeGraph` computes BEFORE `canReRunNodes` empties it doc-wide. `computeGraph`
  exposes it; there is no new walk.
  - `reachable` is **not** usable. Under an `any`-join, `W → R` plus `P → R` lets R dispatch as soon
    as P succeeds, before W writes.
  - A `skipped` edge fires when its source did NOT run, so a node downstream of it can start while an
    upstream writer is still in flight.

  `settled` already handles both.
- **Re-running bodies.** Loop rounds are sequential and outer accessors see only the container id, so
  loop and foreach bodies need nothing extra. **A bare back-edge body does.** A bounce resets only
  target…source, so a reader outside that body that is "ordered" after it can read round 1's value or
  round 2's, depending on timing. So a writer inside a bare back-edge body is rejected unless every
  accessor of that variable is inside the same body. This is the same conservatism as RS's
  `backEdgeLoopNodes`.
  - *(V4, found in planning)* **The mirror case too.** A bounce fires on its source's outcome while
    that source's forward edges release what lies downstream, so a READER inside a body can run again
    beside a writer ordered after it. "`p` before `q`" therefore holds only if no bare body holds `p`
    without `q`; a writer that finishes before the reader (outside the body) stays legal.
  - *(V4)* **A decision inside a bare body decides again on every bounce**, so it proves two
    accessors exclusive only when both are inside that body. Otherwise round 1 can take `true` and
    round 2 `false`, and the two branch writers both run.
  - A container-targeted back-edge needs none of this: `validateDoc` requires its source inside the
    container, so its body is every child, and lifting orders everything outside the container.
- **Exclusive:** both sit under **different outcomes of one decision node `n`** in the same scope.
  - The atomic outcomes are `success` / `failure` / `skipped` of any node, except that an `if`/`switch`
    has one outcome per branch key (from `declaredBranchesOf`) instead of `success`. **A branching
    node's `success` edge is the union of its branches** *(V4 correction: an `if` terminates `success`
    whichever branch it took, so its `success` edge fires beside every branch edge — treating the two
    as disjoint was a false accept)*. `completion` is success-or-failure and so overlaps both.
  - *(V4: implemented as a must-analysis, which the wording below was a sufficient case of.)* For each
    entity, the analysis computes what its DISPATCH implies about each earlier decision's outcome, over
    the reducer's own readiness rule: an edge that fires implies its source's outcome is one the edge
    accepts, plus everything the source's own dispatch implied; conditions on one predecessor OR
    together; predecessors AND under an `all` join and OR under `any`. Two accessors are exclusive when
    some decision's implied outcome sets are disjoint. This keeps the rule's two halves — every path to
    `a` must pass `n` (an `any`-join path around `n` removes the implication), and a `skipped` edge
    inverts it (`n →(false) F →(skipped) G` runs `G` exactly when `n` took `true`, so a skipped edge
    implies only that its source was skipped) — and additionally accepts an `all`-join writer that
    also takes a data edge from upstream of `n`, which pure reachability would reject.
  - `n` decides once per round, so exclusivity holds within a round, and rounds are sequential.
  - This keeps the two canonical patterns legal: set `status` on an `if`'s true and false branches,
    and set it on a node's success and failure edges.
- **Parallel foreach** (`isParallelForeach`): a writer anywhere in its body is rejected, even when it
  is the only writer, because it races with itself across instances.
  - The exception is a container that sets **`allowNondeterministicVars: true`**. That is
    resolved-q3's opt-in, now a `foreach` container field; save rejects it on any other kind.
  - A reader in a parallel body of a variable written only outside it follows the ordered/exclusive
    rule after scope lifting.

**This is conservative on purpose.** A false reject is recoverable: the error names the two nodes to
connect. A false accept is a run whose result depends on timing. That is the same polarity as
`checkRefRoot`'s documented KNOWN RESTRICTION. No run-time guard is needed, because the log records the
order that actually happened.

### V-D7 — Rerun-from-failed carries variables (supersedes the RS built-block's DROP)

`run.reseeded` gains **`copiedVariableWrites: Array<{ nodeId, op: 'set'|'append', name, value }>`**,
the ordered writes of the copied nodes. It is deliberately a list, not a final map, because a map
cannot be filtered again. `onReseeded` computes `state.variables` as the version defaults with that
list applied in order.

The list is computed by a new pure `copiedVariableWritesOf(sourceEvents, copiedIds)`, called by the
server's reseed caller (`run/reseed.ts`), which already holds R1's events. It is not computed inside
`reseedFrontier`, which only sees state. The rule is the pre-settled RS one (operator, 2026-07-23):
exactly the **copied nodes'** writes, in R1's log order. It is not a "before the failure" seq cut,
which has no single meaning under the drain model.

- **`copiedIds` = `frontier` ∪ the children of every copied container.** Bodies travel in
  `copiedContainers`, not `frontier`. Instance-keyed parallel-foreach writers (`<id>@<i>`) map back
  through `scopeOfStateId`.
- **A rerun of a rerun.** Nodes R1 itself copied never ran in R1, so R1's log has no `variable.*`
  events for them; their writes arrived in R1's own `run.reseeded`. The source sequence is therefore
  R1's `copiedVariableWrites` followed by R1's own `variable.*` events, filtered to R2's `copiedIds`.
  The copied writes logically precede everything R1 ran. A test runs two reruns in a row.
- **Bare back-edge bodies are never partially copied.** `reseedFrontier` already excludes every
  `backEdgeLoopNodes` member from copy-eligibility, so such a body always re-runs whole. That
  composes with V-D6's back-edge rule without extra work here.
- **Why the reseed event carries the list instead of the fold recomputing it.** R2's log must replay
  on its own, the same reason `copiedOutputs` is carried.
- **Old `run.reseeded` events.** They have no `copiedVariableWrites`, and the fold reads that as "no
  copied writes". For those events that is literally true, because they were written against versions
  with no variables. The field is optional in the schema for old logs only. The writer's input type
  requires it, and a test pins that a new reseed always writes it.
- When V5 lands, correct the RS doc's DROP bullet and its "`run.variables` as of the last successful
  write before the failure" bullet, and the comment on `run.reseeded` in `engine/types.ts`.

### V-D8 — Security model

- **Variable values are cleartext in the run log and in RunState.** Nothing secret can reach one:
  - there is no `secret` type (V-D1);
  - secret params are already refused in refs (`checkRefRoot`);
  - `secureOutput` node outputs are already refused, containers with a secure child and `default()`
    included (F4's prohibit);
  - `set`/`append` nodes cannot be secure (V-D4);
  - their catalog entries declare no `secretSinkFields`, so `scanSecretSinks` refuses a `{$secret}`
    marker in `value`.
- **When globals land (F7), `${global.<secure>}` must be refused in a `set`/`append` value.** A
  variable is not a secret sink. This is recorded here so F7 inherits it.
- **Redaction.** `secureEventNodeId` stays total over the event union: the new `variable.*` events
  are listed explicitly as never secure, not left to a default.
- **No new authorization surface.** Variables live in the version doc, written through the existing
  ownership-checked version routes, and values reach readers only through run events behind the
  existing run-read checks. There are no new routes.
- **The size bound (V-D4)** is the denial-of-service guard on in-memory run state.

### V-D9 — Authoring and monitoring UI

- **Variables tab** in the bottom dock's pipeline tabs: Parameters | Variables | Outputs. **Build it
  by generalising the existing params row editor**, not by writing a third editor. The params and
  outputs editors are two already, and the "third copy" rule (2026-08-20) says the third one folds
  them.
- **Palette and config form** for `set`/`append`: a variable picker that lists the declared
  variables (for append, only `array` ones), and a `value` field with the `${}` picker.
- **Run page:** show the run's variable values, both final and live. The drill-in of a `set`/`append`
  node shows the name and value it wrote, taken from its event. This belongs to the "read the run log"
  core path, not polish: without it, a variable-driven run cannot be debugged.

## Migration / authority posture (#443)

The change is additive only. Old logs contain no `variable.*` events, and old versions backfill to
`variables: []`, so `seedState` gives `{}` and every existing log folds identically. The event union
gains `variable.set`/`variable.append`, and the command union gains `writeVariable`. `failNode` gains
an optional `code` that defaults to today's value. `run.reseeded.copiedVariableWrites` is optional
for old logs only. No existing event changes shape. The catalog entries are new types, so no existing
node changes meaning. `CATALOG_VERSION` is bumped in the slice that first accepts the new types (V5).

## Ticket table

| # | Ticket | Ships with |
|---|--------|------------|
| **V1** | Declare: `VariableTypeSchema` + `VariableDefSchema` + `PipelineVersion.variables` + migration + the `scrubVersion` empty-delete + content-form byte-identity and round-trip tests + `validateDoc` name/type/strict-default rules + **the web carry**: `canvasStore` holds `variables` as working state and `toVersionBody`, version restore and copy-pipeline send it. Every one of those builds the write body field by field, so without the carry a canvas Save of a version that declares variables (through the API or a git import) would silently default them to `[]`. Inert. | — |
| **V2** | Read: the `vars` root in `refRoot`, `SubstitutionContext.variables`, `RunState.variables` seeded from defaults, `checkRefRoot`/`inferExprType`, `refsInScope` `kind:'variable'`, and the test pinning the trigger-binding and tool exclusions. Until V5, reads see defaults only. **Built with the web half of the read:** `validateCanvas` and the expression picker are handed `variables`, because a canvas that did not know them would badge a server-valid `${vars.x}` as undeclared and its validate-probe would drop every variable offer. That is the `validateCanvas` half of #1359; making `ValidatedDoc.variables` required stays with V3. An `array` variable may be indexed (`${vars.rows[0].id}`), never field-stepped. | — |
| **V3** | UI: the Variables tab, built by generalising the params row editor (V-D9). The first user-visible slice. | — |
| **V4** | Pure, unwired, unit-tested: the V-D6 guard as a function over a doc (including `settledRaw` exposed from `computeGraph`, reader collection from the validators' own scans (`validateRefs` for nodes, `validateDoc` for a container's `items`/`exitWhen`), scope lifting, the back-edge rule and exclusivity), plus `copiedVariableWritesOf` (V-D7). No doc can contain a `set`/`append` node yet, so nothing is reachable from a save or a run. | — |
| **V5** | **SHIPPED 2026-09-27.** *(Built notes: V-D4 names no code for the replay-safety failure, so it is `FAILURE_CODES.VARIABLE_NOT_REPLAY_SAFE`. `validatePipelineDoc` moved to `engine/validate-pipeline.ts` so the guard can run in it without an import cycle; the guard runs only when both validators return nothing. The no-self-reference rule lives in the guard, because it reads the validators' own reads. The fold also refuses an event whose type, op or variable does not match its node.)* *(V4 notes: the guard's reader list is complete only for a doc both validators accept, so wire it beside them; refuse a `${}` in `config.variable`, which the guard matches literally; add the `allowNondeterministicVars` exemption to the parallel-foreach rule; pin that `copiedVariableWritesOf`, which takes one write per `(nodeId, attemptId)`, equals what the fold applied; derive `VariableWrite` and the `variable.*` / `run.reseeded` shapes from their Zod schemas and drop the structural casts in `copiedVariableWritesOf`; hand the guard the reads from the validators' own pass, never `variableReadsOf` over a refused doc.)* Accept the types, atomically: the `set_variable`/`append_variable` catalog entries + `CATALOG_VERSION` bump + every V-D4 save-time rule + **wiring V4's guard into `validateDoc`** + `allowNondeterministicVars` on `foreach` + the `writeVariable` command, `variable.*` events, fold, resume branch and driver pump branch + `failNode.code` + the new `FAILURE_CODES` + `secureEventNodeId` totality + **the `copiedVariableWrites` reseed**. Tests include a `variable.*` event for a node a loop timeout abandoned (`abandonLiveChildren`), which must fold as a no-op. | **V4 on `main`.** Everything here is **inseparable**. A type the save path accepts but the fixpoint cannot run would fail as an executor "routing bug". Writes without the guard admit timing-dependent runs. Writes without the reseed make a rerun-from-failed silently start from defaults, a silently wrong value, the class of #1150 (which wrote a wrong value into a store). |
| **V6** | **SHIPPED 2026-09-27.** *(Built notes: the palette needed nothing, since the toolbox is derived from the catalog and V5 gave both writers icons. The `variable` field gets a "Declared variable" chooser through `ConfigEditor`'s existing `choicesFor` seam, each option labelled with its type (for `set`, the type decides how a literal `value` is read). `append` is offered only `array` variables, and an empty list says which of its two causes applies. The field is tagged with a new `literalText` presentation fact so the `${}` flyout is not offered on it: the flyout's validate-probe cannot catch this case, because the gate refuses a blank name with the same message as a `${}`. A name made stale by a rename or retype on the Variables tab leaves the chooser on its placeholder, and the node's issue list states the refusal. Known and left as is: the `value` flyout types its offers against the APPLIED `variable`, not an unapplied choice, which holds for every field's flyout.)* UI: the palette and config form for `set`/`append` (V-D9). | after V5 |
| **V7** | **SHIPPED 2026-09-27.** *(Built notes: the run page's Variables section reads `state.variables` from the page's ONE engine projection (`useRunProjection`), so it is live while the run goes and final once it settles, and it can never disagree with the reducer about a dropped stale write, the defaults or a rerun's copied writes. Rows follow the declaration; values are JSON, so a string is quoted and an empty one is not a blank cell. It renders nothing for a pipeline that declares no variables. The drill-in's "Variable write" section comes from the doc-free fold's `NodeActivity.variableWrite` (the node's `variable.*` event, or the last `copiedVariableWrites` entry for a copied writer), and `reconcileNodeActivity` keeps it only where the engine holds the node `success`. Known and left as is: a PARALLEL foreach's body writer (legal only under `allowNondeterministicVars`) has no bare-id engine entry, so its row is not reconciled and folds its items' writes last-one-wins. The Outputs section's cap, disclosure and copy were lifted into `CappedValue`, shared by all three places that show a value.)* Run page: variable values and the `set`/`append` drill-in (V-D9). | after V5 |

Build order V1 → V7. The old F6's `return` activity is **not** in this series: pipeline-level
outputs are declaration-only today (`child-outputs.ts`), so `return` belongs to whichever ticket makes
pipeline outputs real.

## Open questions (none blocks V1–V7)

1. **Self-reference.** D2 kept ADF's ban, so `count = add(vars.count, 1)` needs a temp variable. In
   this engine the write is atomic inside the pure fold, so for ordered writers the hazard ADF guards
   against does not exist, and lifting the ban would be a one-rule change. **If it is lifted, keep the
   ban inside an `allowNondeterministicVars` body**, where a self-referencing `set` is a real
   lost-update race. This spec keeps the settled ban. Lifting it is the operator's call, not something
   this series does silently.
2. **`VARIABLE_MAX_BYTES` = 256 KiB** is a judgement, not a measurement. Revisit it if a real
   pipeline hits it.
