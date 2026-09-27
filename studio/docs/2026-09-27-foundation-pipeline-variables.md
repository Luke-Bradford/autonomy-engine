# Foundation — pipeline variables (V-series)

**Status:** spec, no code. Owner ticket: #844 item 1 (the variables half; globals stay with spec #1
D3 / F7 and are not covered here). **Supersedes spec #1's D2 "Variables" bullet** (`${vars}`,
`set_variable`/`append_variable`, `RunState.variables`) and its tickets F5a/F5b/F5c/F6 — D2 was
written before the engine had containers, `skipped`, the drain model or rerun-from-failed, and two of
its premises no longer hold (see V-D6 and V-D7). What D2 settled and this spec keeps: variables are
mutable in-run, typed, mutated by events only, read as `${vars.x}`, no self-reference, and a
nondeterministic write is **hard-rejected** with an explicit per-container opt-in (spec #1
resolved-q3).

## Why

A pipeline cannot carry state today. Node outputs are round-local: `resetContainerRound` →
`resetNodes` deletes a loop body's outputs on every re-entry, and a parallel foreach deletes a
finished item's instance outputs. So there is no way to count attempts across `loop` rounds, collect
results over a sequential `foreach`, keep an LLM-judge running total (spec #6 Round-2 C2 — why
`number` is a first-class variable type), or set one `status` on either branch of an `if` and read it
after the join. ADF's answer is pipeline variables, and ours is the same, specified tighter.

## What exists today (measured 2026-09-27)

- `PipelineVersionSchema` (`schemas/pipeline.ts`) has no `variables` field. `pipeline_versions`
  stores each doc field as its **own column** (`params`, `outputs`, `nodes`, `edges`, `containers`),
  so a new doc field needs a new column. That is #473's lesson: a field absent from the table is
  silently dropped on insert.
- `refRoot` (`engine/params.ts`) is the single source of truth for `${}` roots: `item`, `params`,
  `nodes.*.output`/`.status`, `run`, `trigger`, `tool.args`. Nothing reserves `vars`. The runtime
  resolver, save-time `checkRefRoot`, `inferExprType` and the flyout's `refsInScope` all read it.
- The run-time scope is `buildCtx(state)` → `SubstitutionContext` `{params, nodeOutputs,
  nodeStatuses, run, trigger}`.
- Control activities (`kind:'control'` catalog entries) are evaluated inside the pure fixpoint.
  `if`/`switch` compute a value, mark the node `ready`, and emit `evaluateControl`. The driver
  appends `condition.evaluated`/`switch.evaluated`, and `onControlBranchEvaluated` folds it:
  attempt/status guards, node → `success`, record the decision, `settle`.
- `run.reseeded` carries `frontier`, `copiedOutputs`, `copiedContainers`. Both the RS spec's
  built-block and the comment on `run.reseeded` in `engine/types.ts` say `copiedVariables` was
  DROPPED because "there is no separate variables store". That was true when it was written and
  stops being true with this spec (V-D7).
- There is **no `parallel` container** (`ContainerKindSchema = loop | stage | foreach`). Concurrency
  comes from a foreach with `batchCount ≥ 2`, and from DAG branches that are not ordered by an edge.

## Decisions

### V-D1 — Declared on the immutable version doc

`PipelineVersion.variables: VariableDef[]`, where
`VariableDef = { name, type, default, description? }`.

- **`type` ∈ `string | number | boolean | array`.** The spelling follows `ParamTypeSchema`
  (`boolean`, not D2's `bool`), so the two type lists read as one vocabulary. `array` elements are
  untyped JSON values. **No `secret` type.** A variable's value is written into the run log in clear
  (V-D4), so a secret has nowhere safe to live. `OutputSchema` excludes `secret` for the same reason.
- **`name`** must be unique among the variables and addressable as `${vars.<name>}`. The rule is the
  one `isAddressableOutputName` already states for node outputs, reused rather than restated. Unlike
  the params editor, which only notes an unreferenceable name (#1354), this is a hard save-time
  error: a variable exists only to be read by name, so an unaddressable one is a defect, not a
  choice. Variables and params are separate roots, so `params.x` and `vars.x` may coexist.
- **`default` is REQUIRED and must match `type`.** It is a literal and is never substituted, as
  decided for param defaults (#844 item 3). It is required because an unset variable has no honest
  value, and inventing `''` or `0` at run time is the fail-open shape this codebase refuses
  everywhere else. The editor puts the type's zero value (`''`, `0`, `false`, `[]`) into the doc
  explicitly when a row is added, so the doc always states the starting value and nothing is
  invented on read.

### V-D2 — Persistence and portability

- New `variables` JSON column on `pipeline_versions`, `NOT NULL`. It gets a SQL `DEFAULT '[]'` only
  so the migration can backfill existing rows. **This follows the `containers` / #473 precedent
  exactly:** no Drizzle-level default (so TypeScript refuses an insert that omits the key), and no
  Zod `.default` on the DB read path. The migration test asserts a version written with variables
  reads back with them.
- **Export / git content form: `variables` is OMITTED when empty, and import reads an absent
  `variables` as `[]`.** This is required, not cosmetic. `pipelineVersionContentForm` hashes the
  version doc. Emitting `variables: []` would change the content form of every version that already
  exists. Advisory drift would then report every committed version as uncommitted, and a re-pull
  would mint a duplicate of each one (the hazard `VERSION_VOLATILE`'s comment describes). An export
  with no `variables` key really does mean the version predates variables, so reading it as `[]`
  states a fact. It does not invent one. Tests: an existing version's content form is byte-identical
  before and after V1, and a version with variables survives export → import → export unchanged.

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

The path follows `if`. At the dispatch step the reducer evaluates `value` over the scoped eval state,
so `${item}` works inside a sequential foreach. It then marks the node `ready` and pushes a new
command, `writeVariable { nodeId, attemptId, op: 'set'|'append', name, value }`. The driver appends
`variable.set` or `variable.append` `{ runId, nodeId, attemptId, name, value }`. The new fold,
`onVariableWritten`, applies the same attempt/status guards as `onControlBranchEvaluated`. It then
writes `state.variables[name]` (for append, a new array with the element added), sets the node to
`success`, and calls `settle`. **Replay folds the recorded value and never evaluates the expression
again.**

- **Why the write and the success are one event.** They are one decision. Two events would admit a
  log where the node succeeded and the write is missing.
- **`variable.append` carries the element, not the array**, so the log stays linear across a long
  loop.
- **Typing the value.** `value` goes through `substitute`'s existing modes:
  - A whole-value `${expr}` keeps its native type and must already have the declared type. There is
    no silent conversion: an expression that yields `"5"` for a `number` variable is a type error.
  - A literal (no `${}`) is coerced by the same function that coerces a param of that type (`coerce`),
    so `5` works for a `number` and `true` for a `boolean`. `array` has no param counterpart, so an
    array value must be whole-value (for example `${createArray(...)}`).
  - An embedded template (`a-${x}`) can only produce a string, so it is legal only for a `string`
    variable.

  At save time these rules are enforced by extending the whole-value-required field check. Save also
  refuses a statically known type mismatch (`inferExprType`). At run time the mismatch that save
  could not see fails the node `kind:'permanent'` with a new `FAILURE_CODES.VARIABLE_TYPE_MISMATCH`
  (`'variable_type_mismatch'`), through the existing `failNode` command.
- **Bounded.** After a write, the variable's serialized value must fit `VARIABLE_MAX_BYTES`
  (256 KiB, exported once from `engine/types.ts`). A larger value fails the node
  `kind:'permanent'`, `code:'variable_too_large'`, and **the value is not written**. It is never
  truncated: truncating would silently corrupt the value. The bound exists because RunState is held
  in memory and every later dispatch's scope carries it, so an unbounded append in a long loop is a
  memory hazard.
- **Save-time rules** (added to `validateDoc`): `variable` names a declared variable. `append_variable`
  targets an `array` variable. `value` does not read the variable it writes (D2's settled
  no-self-reference rule, ADF parity; see open question 1). `set`/`append` nodes may not carry
  `policy.secureInput`/`secureOutput`, because a value that lands in `RunState.variables` is readable
  everywhere through `${vars}` and redaction (`secureEventNodeId`) does not cover the new events. A
  secure write would be a leak with a padlock on it.

### V-D5 — Reads: the `${vars.<name>}` root

- `refRoot` gains `vars.<name>`, which makes it available to the resolver, `checkRefRoot`,
  `inferExprType` and the flyout at once. `SubstitutionContext` gains `variables`, filled by
  `buildCtx`.
- Save-time: the name must be declared (worded like the undeclared-param error). `inferExprType`
  returns the declared type.
- `refsInScope` gains `kind:'variable'`, so the `${}` picker lists variables.
- A read is evaluated **at dispatch** against folded state. Replay rebuilds the same folded state, so
  a read is replay-stable with no extra recording.
- **Readable wherever a node, edge or container `${}` is** (node config, `if`/`switch`/`filter`,
  `foreach.items`, `loop.exitWhen`). **Not readable in trigger bindings or tool expressions.** Their
  `allowedRoots` are closed sets (`{trigger}` and `{tool, item}`), so they already exclude `vars`. A
  binding is evaluated before the run exists. V2 adds a test that pins both exclusions so a later
  widening cannot admit `vars` by accident.

### V-D6 — The determinism guard (supersedes D2's "parallel container" wording)

D2 rejected "variable mutation from a node that can run inside a `parallel` container". That
container does not exist, and the rule missed the other source of concurrency, **unordered DAG
branches**: in `A → set v=1` next to `B → set v=2`, the final value depends on whether `A` or `B`
finishes first. The event log still replays such a run exactly. What the rule protects is the
**outcome**, which must not depend on scheduler timing.

**Rule (save-time, `validateDoc`).** For each variable, collect its **accessors**:

- **Writers** are the `set`/`append` nodes that name it.
- **Readers** are every node or container whose `${}` fields reference `vars.<name>`. A container's
  own fields are positioned by their evaluation point: `loop.exitWhen` is after its body, and
  `foreach.items` is before it.

Every pair of accessors that includes a writer must be **ordered** or **exclusive**. Any other pair
is rejected, naming both nodes and the variable.

- **Ordered:** one of the pair is upstream of the other. The source of truth is the container-aware
  `reachable` graph that `validateRefs` already builds for `${nodes.x.output}`. **Do not write a new
  walk.** A node reachable only on a failure or completion branch still counts as ordered: the
  question is whether the two can overlap, not whether both will run.
- **Exclusive:** both sit under **different outcomes of one decision node `n`**. Outcome classes are
  each branch key of an `if`/`switch`, and `success` / `failure` / `skipped` of any node.
  `completion` overlaps all of them and is never exclusive. "`a` sits under `n`'s class-`c` edges"
  means that removing `n`'s class-`c` out-edges makes `a` unreachable from its scope's roots. This
  is what keeps the two canonical patterns legal: set `status` on an `if`'s true and false branches,
  and set it on a node's success and failure edges.
- **Parallel foreach** (`batchCount ≥ 2`): a writer anywhere in its body, at any depth, is rejected,
  even when it is the only writer, because it races with itself across instances. The exception is
  a body whose container sets **`allowNondeterministicVars: true`**. That is resolved-q3's opt-in,
  now a `foreach` container field; save rejects it on any other container kind. A reader in a
  parallel body of a variable written only outside the body follows the ordered/exclusive rule
  against those writers.

**This is conservative on purpose.** A false reject is recoverable: the author adds a dependency
edge, and the error names the two nodes to connect. A false accept is a run whose result depends on
timing. That is the same polarity as `checkRefRoot`'s documented KNOWN RESTRICTION. No run-time
guard is needed, because the log records the order that actually happened.

### V-D7 — Rerun-from-failed carries variables (supersedes the RS built-block's DROP)

`run.reseeded` gains `copiedVariables: Record<string, unknown>`. The value follows the pre-settled RS
rule (operator, 2026-07-23): start from the bound version's defaults (RS reruns the same version),
then apply, in R1's log order, exactly the `variable.set`/`variable.append` events whose `nodeId` is
a **copied frontier node**. It is not a "before the failure" seq cut, which has no single meaning
under the drain model. `onReseeded` sets `state.variables` from `copiedVariables`.

- **Why the reseed event carries a field instead of the fold recomputing.** R2's log must replay on
  its own, the same reason `copiedOutputs` is carried.
- **Old `run.reseeded` events have no `copiedVariables`, and the fold reads that as "no copied
  writes".** For those events this is literally true: they were written before variables existed,
  against versions with none. What stops a NEW reseed from quietly omitting it is the writer's input
  type, where the field is required, plus a test. The schema stays optional only for old logs.
- When V lands, correct the RS doc's DROP bullet and its "`run.variables` as of the last successful
  write before the failure" bullet, and the comment on `run.reseeded` in `engine/types.ts`.

### V-D8 — Security model

- **Variable values are cleartext in the run log and in RunState.** Nothing secret can reach one:
  - there is no `secret` type (V-D1);
  - secret params are already refused in refs (`checkRefRoot`);
  - `secureOutput` node outputs are already refused (F4's prohibit);
  - `set`/`append` nodes cannot be secure (V-D4).
- **When globals land (F7), `${global.<secure>}` must be refused in a `set_variable` value.** A
  variable is not a secret sink. This constraint is recorded here so F7 inherits it.
- **No new authorization surface.** Variables live in the version doc, which is written through the
  existing ownership-checked version routes. Values reach readers only through run events, behind the
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
  node shows the name and the value it wrote, taken from its event. This belongs to the "read the run
  log" core path, not polish: without it, a variable-driven run cannot be debugged.

## Migration / authority posture (#443)

The change is additive only. Old logs contain no `variable.*` events, and old versions backfill to
`variables: []`, so `seedState` gives `{}` and every existing log folds identically. The event union
gains `variable.set`/`variable.append`, the command union gains `writeVariable`, and
`run.reseeded.copiedVariables` is optional for old logs only (V-D7). No existing event changes
shape. The catalog entries are new types, so no existing node changes meaning.

## Ticket table

| # | Ticket | Ships with |
|---|--------|------------|
| **V1** | Declare: `VariableDefSchema` + `PipelineVersion.variables` + migration (`containers` precedent) + export omit-when-empty / import absent→`[]` + content-form byte-identity test + `validateDoc` name/type/default rules. Inert. | — |
| **V2** | Read: the `vars` root in `refRoot`, `SubstitutionContext.variables`, `RunState.variables` seeded from defaults, `checkRefRoot`/`inferExprType`, `refsInScope` `kind:'variable'`, the trigger-binding and tool exclusion test. Reads can only see defaults until V5. | — |
| **V3** | UI: the Variables tab, built by generalising the params row editor (V-D9). The first user-visible slice. | — |
| **V4** | `set_variable`/`append_variable` catalog entries + every V-D4 save-time rule + **the V-D6 guard**, including `allowNondeterministicVars` on `foreach`. They have no fixpoint handler until V5, so one that reaches dispatch in between hits the executor's existing `CONTROL_NOT_DISPATCHABLE` refusal and fails the node visibly. It never writes. | — |
| **V5** | Write: `writeVariable` command, the `variable.set`/`append` events and fold, the type and size failures (`FAILURE_CODES`), **and V-D7's `copiedVariables` reseed**. This is where the fixpoint gains its handler. | **V4 must already be on `main`.** The reseed is **inseparable** from writes: without it, a rerun-from-failed silently starts from defaults, which is a wrong value (the #1150 class). |
| **V6** | UI: the palette and config form for `set`/`append` (V-D9). | after V5 |
| **V7** | Run page: variable values and the `set`/`append` drill-in (V-D9). | after V5 |

Build order V1 → V7. The spec's `return` activity (old F6) is **not** in this series: pipeline-level
outputs are declaration-only today (`child-outputs.ts`), so `return` belongs to whichever ticket makes
pipeline outputs real.

## Open questions (none blocks V1–V7)

1. **Self-reference.** D2 kept ADF's ban, so `count = add(vars.count, 1)` needs a temp variable. In
   this engine the write is atomic inside the pure fold, so the hazard ADF guards against does not
   exist here, and lifting the ban would be a one-rule change in V4. This spec keeps the settled ban.
   Lifting it is the operator's call, not something this series does silently.
2. **`VARIABLE_MAX_BYTES` = 256 KiB** is a judgement, not a measurement. Revisit it if a real
   pipeline hits it.
