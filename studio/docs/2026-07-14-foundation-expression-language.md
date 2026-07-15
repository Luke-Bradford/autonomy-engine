# Foundation Spec #6 — The `${}` expression language

**Status:** proposed — brainstormed + ADF-grounded 2026-07-14 (answers challenge-round-1 **T1**,
plus parts of **T2/T6**); pending Codex + re-challenge.
**Scope:** define the ONE thing every "config-driven, nothing hardcoded" claim leans on and no spec
yet specifies — the `${}` sublanguage: **grammar, reference namespaces, the closed function catalog,
the interpolation/typing model, and how it stays INERT + replay-safe** in the event-sourced engine.
This is the **SSOT `validateRefs`/`validateDoc` enforce.**
**Build order:** prerequisite alongside #1 F0 — #2 (prompt/structured), #4 (`if`/`switch`/`until`/
`filter`/`set_variable`), and #5 (`${trigger.*}`) are all UNBUILDABLE without it.
**Grounded** in ADF (MS Learn `control-flow-expression-language-functions`, `control-flow-system-variables`).

## Non-negotiable invariants (carried from L0)

- **INERT, single non-rescanning pass.** A `${...}` resolves ONCE; a resolved value that itself
  contains `${...}`/`@...` text is emitted **literally**, never re-evaluated → the no-injection
  guarantee (untrusted data — LLM output, HTTP body, event payload — can never become code).
- **Closed function allowlist. No `eval`, no arbitrary code, no I/O, no host access.**
- **Pure + replay-safe.** No live wall-clock inside the reducer. "Now"-type values resolve from
  **dispatch-stamped FACTS** already in the run's own event log (see §Time), so replay is deterministic.
- **Save-time validated.** Every reference + function call + type is checked at save (`validateRefs`);
  the version stores what it validated against.

## Syntax & interpolation (ADF's two-mode model, our delimiter)

We keep `${ … }` (not ADF's `@`). Inside the braces is an **expression** (refs, function calls,
literals). Two modes, mirroring ADF's `@expr` vs `@{expr}`:

| Form | Meaning | Result |
| --- | --- | --- |
| a field whose value is **exactly** `${ expr }` | whole-value | **type-preserving** — `${params.n}` (n=42) yields the number 42, an array yields an array |
| `${ expr }` **embedded** in surrounding text | string interpolation | always a **string**; multiple allowed: `"file_${params.env}_${run.runId}.json"` |
| `$${` | escape | a literal `${` |

Whitespace inside braces is insignificant. A field is either a literal (no `${}`), one whole-value
expression, or an interpolated string of literals + `${}` segments.

## Reference namespaces

`${ <namespace>.<path> }`. Path supports dot access and **`[]` bracket access** for array indices and
dynamic/dynamic-name sub-fields (ADF parity: `nodes.x.output.rows[params.i].sku`).

| Namespace | Resolves to | Notes |
| --- | --- | --- |
| `params.<name>` | pipeline parameter (read-only in run) | typed; default < trigger < run-now override |
| `vars.<name>` | pipeline variable (mutable) | #1 D2; typed |
| `global.<name>` | workspace global param (read-only) | #1 D3; secure globals resolve ONLY at secret sinks (#1 D8) |
| `nodes.<id>.output[.deep]` | an upstream node's typed outputs | deep `[]`/`.` into a `json`-typed output = `any` (runtime-validated) unless the output declares a schema |
| `nodes.<id>.status` | `success \| failure \| skipped` | **NEW (T6)** — enables the ADF `@activity().Status` fan-in/OR pattern. **SHIPPED at E3**; readable only where the node is *guaranteed settled* — see the E3 block below |
| `run.<field>` | run system vars: `runId`, `startedAt`, `pipelineVersionId`, `triggerId`, `parentRunId` | **NEW (T2/C3)**. **SHIPPED at E3** — `RUN_FIELDS` in `engine/params.ts` is the SSOT; `attempt` is SCOPE-OUT: `NodeRunState.attempts` already exists (incremented by `onRetryRequested`), but it is NODE-scoped while `buildCtx` is RUN-scoped, so exposing it needs a per-node binding decision — #1 D4 |
| `pipeline.<field>` | `name`, `version`, `triggerType`, `triggerName?`, `triggerTime?` | **NEW** — ADF `@pipeline().*` |
| `trigger.<field>` | trigger context per type (schedule: `scheduledTime`,`startTime`; event: `body.*`,`eventData.*`; window: `windowStart`,`windowEnd`) | **NEW (T2)** — from the `run.triggerContext` seed event (#5); **context-validated** |
| `item[.field]` / `item[i]` | current `foreach` element | valid ONLY inside the nearest enclosing `foreach` (#4 A4); save-time scope-checked |

Dominance/visibility rules (a ref must resolve at that node) stay as today's `validateRefs`. Container
child namespaces remain invisible outside the container (#4) — the ONLY cross-boundary handle is the
container's declared projected output (#4 T4).

## The closed function catalog (ADF parity target, allowlisted)

`${ fn(arg, …) }`, nestable: `${ if(greater(nodes.judge.output.score, 7), 'ok', 'redo') }`. Each fn
is typed; `validateRefs` checks arity + arg/return types at save. **v1 catalog (closed):**

- **Logical/comparison:** `and or not equals greater greaterOrEquals less lessOrEquals if`
- **String:** `concat substring replace split trim toLower toUpper startsWith endsWith indexOf
  lastIndexOf` (+ `length empty` via collection). **`guid` REMOVED from v1** (non-deterministic —
  see Round-2 hardening; use `${run.runId}` for uniqueness).
- **Collection:** `length empty contains first last take skip join intersection union createArray
  range` + **array reshape/aggregate (NEW, Round-2 C2):** `filter(array, <${item} predicate>)`
  `map(array, <${item} projection>)` `sum(array) avg(array) count(array, <${item} predicate>)` —
  closed forms binding `${item}`, no lambda syntax, order-preserving.
- **Conversion:** `string int float bool array json coalesce base64 base64ToString
  encodeUriComponent decodeUriComponent`
- **Math:** `add sub mul div mod min max`
- **Date (dispatch-stamped, see §Time):** `utcNow formatDateTime addDays addHours addMinutes
  addSeconds addToTime subtractFromTime convertTimeZone startOfDay startOfHour startOfMonth
  dayOfWeek dayOfMonth ticks`

Extension is a deliberate, allowlisted act (new fn → catalog entry + type sig + validator). No user
code, no regex `eval`, no host functions. (Data-flow/mapping functions are out of scope — not our domain.)

## Time & other dispatch-stamped values (replay-safe)

The reducer is pure, so `utcNow()`, `${run.runId}`, `${pipeline.triggerTime}`, `${trigger.*}` cannot
read a live clock. Resolution: they read **immutable facts already in the run's own log** —
`run.started` / `run.triggerContext` (#5 seed) carry `runId`, `triggerTime`, trigger context; each
`node.dispatched` carries the driver-stamped **dispatch timestamp** that `utcNow()` binds to for that
node. So a value is fixed at first dispatch and **identical on replay** — ADF resolves at dispatch too;
we make it a logged fact so event-sourcing holds. `utcNow()` in two nodes of one run may differ (each
its own dispatch stamp) — documented; use `${run.startedAt}` for a run-stable timestamp.

## Typing & validation (`validateRefs` SSOT)

- Every ref resolves to a declared type (param/var/global/output `OutputSpec`, `run/pipeline/trigger`
  fields, `item` element type). Function signatures are typed; the checker infers the expression's
  result type and checks it against the field's expected type (e.g. an `if`/`switch` condition must be
  `boolean`; a `foreach.items` must be an array).
- **Deep `[]`/`.` into a `json`/`any` output** is `any` — not statically typed; documented as a
  runtime-validated escape hatch (parity with ADF's untyped `@activity().output.x`).
- **Structured diagnostics** (which node/field/token) are the deferred R3/U8b work; v1 emits
  whole-doc plus best-effort node attribution (challenge T14/I10 notes the UI limit).
- **Validation profiles (T2/monitor):** `validateRefs` runs in a *context* — a generic-pipeline
  profile (no `trigger`/`item` unless in scope) vs a trigger-binding profile (a schedule/tumbling/
  event-bound pipeline exposes the matching `${trigger.*}` subset). A pipeline saved standalone is
  valid; binding it to a trigger re-validates the `${trigger.*}` refs against that trigger's type.

## Interactions (how it plugs into the other specs)

- **#1** owns the AST/validator; `${vars}`/`${global}`/`Node.config.outputs` typing live here.
  Predicate typing gates the **unified edge/branch** work (`if`/`switch` conditions are boolean exprs).
- **#2** prompt `messages[]` content + structured `outputSchema` fields are expressions/outputs typed
  by this catalog; `${nodes.classify.output.category}` feeds a downstream `switch` (T8).
- **#4** `if`/`switch` conditions, `filter`/`foreach.items` predicates, `set_variable` values are all
  this language (array-safe forms = whole-expression, this catalog, order-preserving).
- **#5** `${trigger.*}` + expression-valued trigger param bindings + run-now overrides resolve here
  against the `run.triggerContext` seed.

## Ticket decomposition (E-series; each ≈ a fire) — build alongside F0

| # | Ticket |
| --- | --- |
| E1 | Expression grammar + parser (refs, `[]`/`.`, function calls, literals) + AST |
| E2 | Interpolation model (whole-value type-preserving vs string) + `$${` escape + single-pass inert eval |
| E3 | Reference resolver over namespaces (params/vars/global/nodes.output/nodes.status/run/pipeline/item) — **PARTIALLY SHIPPED 2026-07-15**: `run.*` (SSOT fix + `startedAt`) + `nodes.<id>.status` landed. The rest is BLOCKED on unbuilt prerequisites, each with a named owner: `vars.*` → #1 D2, `global.*` → #1 D3, `item` → **PARTIALLY delivered at E4**: the array-form binding (`filter`/`map`/`count`) is LEXICAL and needed no `foreach`, so it shipped with the catalog; the `foreach`-BODY binding remains #4 A4's, `pipeline.*` → needs a doc widening (`PipelineVersionSchema` has no `name`; `EngineDoc` carries only nodes/edges/containers) + #5's seed for `triggerType`/`triggerName`/`triggerTime`, `run.attempt` → #1 D4 (the `attempts` fact exists but is node-scoped; a run-scoped `${run.*}` has no single answer for it). Re-open the remaining surface as each lands. |
| E4 | Function catalog impl + per-fn type signatures (logical/string/collection/conversion/math) — **SHIPPED 2026-07-15**: the closed catalog lives in `engine/functions.ts` (SSOT, one entry per fn) and the CALLING CONVENTION is now DATA (`call: 'eager' \| 'special'`, `lambdaArgs`, `staticSoftArg`) read by BOTH the evaluator and the static checker, so neither special-cases a fn by name. `and`/`or`/`if` short-circuit; `filter`/`map`/`count` bind `${item}` per element; `count` is arity-overloaded. See the E4 block below. |
| E5 | Date fns + dispatch-stamped time — **SPLIT 2026-07-15. E5a SHIPPED:** the 12 date fns that take an EXPLICIT timestamp (`formatDateTime addDays addHours addMinutes addSeconds addToTime subtractFromTime startOfDay startOfHour startOfMonth dayOfWeek dayOfMonth`), all UTC, all pure — `${run.startedAt}` (E3) is the run-stable source. See the E5a block below. **E5b FILED as #450 (`needs-design`):** `utcNow()` binds a `node.dispatched` stamp that DOES NOT EXIST — the reducer resolves node config in `prepInput` at the `pending→ready` transition, strictly BEFORE the executor yields `node.dispatched` (which carries no timestamp field at all), and `onDispatched` never re-preps. Binding it needs a dispatch-handshake change to crash-safety-critical code, so it is an operator-gated call, not an unattended one. `pipeline.*` from seed remains blocked on #5 + the doc widening E3 recorded. |
| E6 | `validateRefs` typing: infer expr type, check against field-expected type; boolean-condition + array-items checks |
| E7 | Deep `[]`/`.` addressing into `json`/`any` outputs (runtime-validated escape hatch) |
| E8 | Validation profiles (generic vs trigger-binding) + `${trigger.*}` context-scoping (with #5) |

## Round-2 hardening (folded from validation)

- **Non-deterministic functions are PROHIBITED unless dispatch-stamped.** `rand`, host entropy, and
  live-clock are non-goals. **`guid()` removed from v1** (no logged fact to bind to → different on
  replay). `utcNow()` is allowed ONLY where a **`node.dispatched` stamp exists** (connector-dispatched
  activity config) and binds to it. It is **NOT available in reducer/control-activity expressions**
  (`if`/`switch`/`filter`/`set_variable` conditions) or trigger-binding expressions — those have no
  dispatch event; use the seeded **`${run.startedAt}`** (run-stable) or `${trigger.scheduledTime}`
  instead. (Rule closes the codex + subagent C1 replay hole.)
- **Numeric variables are FIRST-CLASS (not an extension)** — #1 D2 gains `number`. Together with the
  new `sum/avg/count/filter/map` array forms, the **flagship LLM-judge aggregate flow** is now
  buildable (Round-2 C2). **Predicate/projection args are BARE expressions, NOT nested `${}`** (the
  whole thing is already inside one `${}`):
  `${and(greaterOrEquals(avg(map(nodes.each.output.results, item.score)), 7),
  greaterOrEquals(count(nodes.each.output.results, greaterOrEquals(item.score, 8)), 3))}`.
- **`foreach` aggregate output shape is concrete (Round-3):** `${nodes.<foreach>.output.results}` is
  `Array<T>` where **T = the flattened named outputs object of the loop's designated child** (e.g. the
  `extract` node's `{sku, qty, keep}`), input-order-stable. So `${item.field}` inside a downstream
  `filter`/`map` over `results` binds to that child-output element shape and **type-checks**. (Not the
  raw child-node envelope — the projected outputs object.)
- **Interpolation mode is decided AFTER canonical-trimming the field — on whole-value-REQUIRED
  fields ONLY** (the authoritative list lives in the Spike-hardened block below; do not restate it
  here), so a stray trailing space can't silently flip `${greater(a,b)}` from boolean to the string
  `"true"`. Those fields **reject** an embedded expression outright (it can only ever resolve to a
  string, so the condition is never boolean-true); force string mode with `string(expr)`.
  (Round-2 I1, **scoped at E2** — see the amendment below.)
  - **AMENDED at E2 (2026-07-15, implemented):** the trim is NOT blanket. Trimming *every* field
    was code-validated as a silent data-loss bug: `"${nodes.a.output.text}\n"` — an ordinary
    prompt/file-body template — flips to whole-value mode, **eating the newline** and emitting a
    number/array where a string belongs (`trim()` strips `\n`, not just spaces). Mode is therefore
    classified on the field **as written**; the canonical trim is the *caller's* choice and is
    applied only where an embedded expression is unambiguously a defect.
  - The original "`validateRefs` emits a targeted diagnostic when a lone-expression-plus-whitespace
    would demote a boolean/number to string" is **WITHDRAWN — the shape has no defect left to
    diagnose** once the trim is scoped. It splits cleanly in two, and neither half is a bug:
    - on a **whole-value-required** field, the canonical trim makes ` ${greater(a,b)} ` whole-value,
      so it yields a boolean — nothing demotes;
    - on **any other** field, ` ${greater(a,b)} ` is string interpolation *as written* — the author
      typed the padding, so `" true "` is the correct and intended result. There is no boolean
      expectation to violate, and a diagnostic here would fire on correct code.

    The genuine residual risk — a field that *expects* a boolean/number but is handed an
    interpolated string — is caught by **E6**'s general rule (infer the expression's type, check it
    against the field's expected type), not by a whitespace heuristic. E2 owns the *mode* check;
    E6 owns the *type* check. Nothing is orphaned.
- **`${item}` is valid in a `foreach` body OR inside a `filter`/`map`/`count` array form** — the
  nearest enclosing iteration binds it (Round-2 M1 / round-1 T4). The `filter` activity's output array
  is named **`.items`** (`${nodes.<filter>.output.items}`).
- **Container output projection is concrete:** an `until`/`loop`/`foreach` container declares
  `outputs: OutputSpec[]`, each projected from a named child output of the **last completed round**
  (`draft := nodes.generate.output.text`); `foreach` additionally exposes the order-stable aggregate
  `results: Array<childShape>`. (Closes the codex round-2 remaining gap on #1 the content + data
  pipelines needed.)
- **Rerun-from-failed stamp rule:** copied frontier nodes **retain their ORIGINAL run's**
  dispatch-stamped facts (`utcNow`/`${run.runId}` reflect the source run); re-executed nodes get the
  new run's stamps. "Identical on replay" is a same-run guarantee; a reseeded rerun is a new run
  carrying copied facts (Round-2 I2 — reconcile with T13's copied-vs-executed render).
- **`json()` output is DATA, never rescanned** even if a parsed value is itself the string
  `"${secret}"` — the single-pass no-rescan rule applies to resolved values of every function. There
  is deliberately **no `expr()`** "evaluate string as expression" function.
- **Secret-sink designation** lives in the ActivityDefinition contract (T10 `SecretRef` secure
  fields); `validateRefs` **rejects** a secure `${global.*}`/`SecretRef` used anywhere but a declared
  secret sink (e.g. `concat(global.apiKey, …)` fails at save).
- **Resource limits:** the resolver enforces caps (max resolved-value size, max deep-path depth, max
  array length for `map`/`filter`/aggregate) — inertness prevents injection, but not resource abuse
  from a huge `${nodes.http.output.body}`.
- **Naming:** system-var fields are **camelCase** (`run.runId`, `pipeline.triggerTime`,
  `trigger.scheduledTime`) — SSOT; the challenge/amendment PascalCase (`RunId`) is reconciled to this.

## Spike-hardened (validated in code, 2026-07-14 — throwaway parser+typer+eval, 28 tests green)

Parser, eval, interpolation, and injection-inertness all held. The gaps are in TYPING + the fn model:
- **Static typing of array-forms is "theatre" without an array/element type.** The type vocabulary is
  `string|number|boolean|json` — **no array type, no element shape**. So a `foreach`'s `results` is
  opaque `json`, and `avg(map(results, item.score))` — even a **misspelled `item.badField`** — gets
  **no edit-time error**. DECISION REQUIRED: either **extend the vocabulary with `array<T>` +
  `record<{…}>` element shapes** (so judge-gate refs type-check), or **drop the static-safety claim**
  and state array-forms are runtime-checked only. (`OutputSpec` for a structured LLM output should
  carry the element shape so `${item.field}` in a downstream `filter` types.)
  - **DECIDED at E4 (2026-07-15): runtime-checked only, for now.** `SigType` is
    `string|number|boolean|array|any` — `array` carries NO element type. The element shape belongs to
    a structured output's `OutputSpec` (**#2**) and to **E6**'s inference; minting `array<T>`/
    `record<{…}>` at E4 would front-run both with nothing to consume it. The cost is REAL and owned:
    a misspelled `${item.badField}` throws at RUN time, not at edit time. **The ARG signatures are
    not decorative** — `checkArgTypes` enforces `args` at run time, which is what makes the
    no-implicit-coercion non-goal an actual rule (`${add('2', 3)}` throws). The declared RETURN type
    (`ret`) is the honest exception: nothing reads it today (flattening every `ret` to `'any'` keeps
    the suite green), it is declared FOR **E6**, which consumes the same signature data for
    inference and owns closing the edit-time gap.
- **The function calling-convention needs a redesign.** `map/filter/count` predicates must be
  captured as **unevaluated ASTs re-run per element with `item` bound** (lazy, per-element) — the flat
  `impl(args)` (eager-map-all-args) model can't express it. Spec a per-fn convention: **eager args vs
  a lambda arg**; `item` is legal ONLY inside that lambda arg (top-level `${item.x}` hard-errors).
  - **SHIPPED at E4.** The convention is DATA on the catalog entry, not a name-check:
    `call:'eager'` (args resolved + signature-checked, then `impl`) vs `call:'special'` (the fn gets
    the unevaluated arg ASTs + an injected `EvalIn{eval,soft,withItem}` and controls its own
    evaluation). `lambdaArgs` is read by BOTH the evaluator (to bind `item`) and the static checker
    (to decide where `${item}` is legal), so the two cannot drift. The pre-E4 `default`-by-NAME
    branches in `evalExpr` + `checkExprStatic` are DELETED. A bare `${item}` (no path) is the element
    itself — spec-required for scalar arrays (`filter(nums, greater(item, 5))`).
- **`and`/`or` do NOT short-circuit** as variadic eager fns — `and(false, nodes.missing.output.x)`
  **throws** instead of returning false. DECISION: make `and`/`or` lazy (like `default`) so a cheap
  guard protects an absent second term, OR document eager semantics loudly.
  - **DECIDED at E4: lazy.** `and`/`or` short-circuit, and **`if` joined them** — its branches have
    the identical hazard (an eager `if` evaluates the untaken branch), and a conditional that
    evaluates both arms is not what any author means.
  - **CRITICAL: this is a RUN-TIME property ONLY — the static checker is NOT relaxed to match.**
    `checkExprStatic` still rejects a non-guaranteed output in ANY arg of a short-circuiting fn.
    That false-reject is deliberate: the checker cannot know arg0 is `false`, so treating later args
    as soft would equally accept `${and(true, nodes.a.output.v)}` — a doc that passes save and then
    THROWS at run with **no escape hatch**. Over-refusal is safe; that false-accept is not (the same
    call E3 made for `${nodes.x.status}`). Laziness earns its keep on the **unvalidated** path
    (`validateRefs` is advisory — the server never calls it, #444) and in author-expectation parity.
    The author-facing form for reading a not-guaranteed output stays `default(nodes.a.output.v, '')`.
    **Pinned by test** (`functions.test.ts` — "laziness does NOT relax the static checker").
- **Concrete bugs to fix in the grammar:** add a real **number literal** (shipped `INT_RE=/^-?\d+$/`
  turns `7.5` into a broken ref) + boolean literal; **`count` is arity-overloaded** (`count(arr)` vs
  `count(arr,pred)`) and `avg` is 1-arg-over-array — the flat allowlist needs typed, shape-aware
  signatures. **Nested `${}` inside a predicate is structurally impossible** (the boundary scanner
  closes at the first `}`) — the **bare-predicate rule is normative**, state it.
  - Number/boolean literals shipped at **E1**; `count`'s 1-or-2 arity and `avg`'s array form shipped
    at **E4** (arity is derived from the signature: `variadic ? ∞ : args.length`). The
    bare-predicate rule needed no code — the E1 boundary scanner makes it structural — and is now
    pinned by test.
  - **There is NO `null` literal** (the grammar is `number | boolean | string`), so `coalesce`'s
    null-coalescing is driven by REFS, never a written `null`. `coalesce` (null/undefined only) and
    `default` (also `''`/`false`, and rescues a MISSING output) are deliberately distinct fns.
- **Deviations from the v1 catalog list, recorded (E5a) — three date fns are ABSENT**, each because
  it fails a NON-NEGOTIABLE, not because it was forgotten. Pinned by test in `functions.test.ts`, so
  re-adding one is a deliberate act with a decision behind it:
  - **`utcNow`** → E5b / **#450**. The architecture cannot bind it yet (see the E5 row above). The
    author-facing substitute is `${run.startedAt}` — which is already what the Round-2 rule above
    directs authors to in exactly the places `utcNow()` is prohibited.
  - **`ticks`** → SCOPED OUT. 100ns units since 0001-01-01 is ~6.4e17 today, far above
    `Number.MAX_SAFE_INTEGER` (~9.0e15). The trap is that it would **pass** the `number` signature
    (`Number.isFinite` holds) and then be silently WRONG below the second: `sub(ticks(b), ticks(a))`
    over a 1ms gap yields 9984, not 10000 (day-scale diffs stay exact, so it looks fine in testing).
    A decimal STRING would be exact but would not compose with `add`/`sub`; widening `SigType` with a
    long/bigint type would front-run **E6** exactly as E4 refused to mint `array<T>`. Silent
    wrongness is worse than absence, so it is absent.
  - **`convertTimeZone`** → SCOPED OUT. It needs a tz database. `Intl.DateTimeFormat({timeZone})`
    DOES typecheck under `lib:["ES2023"]` (probed — the availability premise is not the blocker), but
    it reads the HOST's ICU data, which varies by Node build and MUTATES as governments change DST
    rules. Folding one log on two hosts could then diverge, breaking the "pure + replay-safe"
    invariant at line 20 — the one property the whole spec leans on. Same call as the hand-rolled
    base64 below: the pure engine does not reach for host facilities. (Hand-rolling a tzdb is absurd;
    a tz-aware fn needs a durable, version-pinned tz source — a real ticket, not a catalog entry.)
- **Deviations from the v1 catalog list, recorded (E4):** `slug` and `default` are KEPT though the
  spec's line-64-77 list names neither — both are LIVE today and `default` is the only way to read a
  reachable-but-not-guaranteed output; removing a live fn is a bigger break than recording the
  deviation (the precedent this spec set for `pipelineVersionId` at E3). **`base64`/`base64ToString`
  are hand-rolled** (UTF-8 + base64 in-module): `shared` is the pure engine — `lib` is ES2023 with no
  DOM/node types — so `Buffer`/`btoa`/`TextEncoder` would break both the typecheck and the
  no-host-access rule.
- **Resource limits — TWO caps shipped at E4**, because one is not enough:
  - `MAX_ARRAY_ELEMENTS = 10_000` bounds the SHAPE of any ONE array. Applied to the fns that
    **MATERIALISE** (`range`/`createArray`/`split`/`union`/`intersection`) and those that **LOOP**
    (`map`/`filter`/`count`/`sum`/`avg`/`join`/`contains`) — a producer allocates BEFORE any
    consumer's check could fire, so `${range(0, 2000000000)}` would OOM the pure reducer from an
    unvalidated doc. `split`/`union`/`range` bound the result BEFORE allocating (counting is a scan;
    splitting first would materialise the array it means to refuse).
  - `MAX_ARRAY_ELEMENTS_TOTAL = 100_000` bounds the WORK of one FIELD's evaluation. The per-array cap
    is per-ARRAY, so `${length(map(range(0,10000), range(0,10000)))}` passes every individual check
    while allocating 10^8 (a third nesting reaches 10^12). Charged in `evalExpr` — the one node every
    value passes through — so no fn can forget it and a later fn inherits it free.
    **Consumption is charged, not just materialisation:** an array is charged each time it is
    RESOLVED as well as each time it is produced, because scanning an array is as much work as
    building one. Charging only the array-shaped RESULT of a call would let `add(sum(a), add(sum(b),
    …))` — each `sum` scanning a near-cap array and returning a SCALAR — or a re-resolved array
    inside a lambda (`count(a, contains(b, item))` resolves `b` once PER ELEMENT, i.e. quadratic) do
    exactly the work the budget claims to bound while spending nothing. (Review-bot WARNING on PR
    #449; the claim was fixed in the code rather than weakened in the doc.)
  - **Deliberately NOT capped:** `length`/`empty`/`first`/`last`/`take`/`skip` allocate nothing, and
    `take`/`skip` are exactly how an author brings an oversized `${nodes.http.output.body}` back
    UNDER the cap. Capping them made an over-cap array wholly unusable — you could not even ask its
    length to guard against it.
  - Both caps are pure + deterministic, so replay is unaffected. Max resolved-value size and max
    deep-path depth remain OUT (E7/general).
- **E5a date fns — the decisions (2026-07-15, implemented).** These are the first `Date` uses in the
  pure engine (`shared/src` had no non-test `new Date(` before this). `Date` is used ONLY as UTC
  calendar arithmetic over an EXPLICIT instant — never `new Date()`, never `Date.now()`, never a
  local-time getter — which is what keeps the family pure and the absent `utcNow` the ONLY gap.
  - **Parsing is STRICT and hand-rolled, because `new Date(s)` is not.** It reads an offset-less
    `2026-07-15T10:30:00` as **LOCAL** time (host-dependent — verified: `2026-07-14T23:00:00.000Z`
    on a BST host) and accepts implementation-defined free text (`July 4, 2026`). Either would make
    a resolved value depend on the HOST, the replay hazard line 20 forbids. Accepted: ISO-8601
    date-time with an explicit `Z`/`±HH:MM`/`±HHMM` offset, normalised to UTC. **Rejected:**
    offset-less, date-only, free text, and impossible dates (`2026-02-30`). The accept-set can be
    WIDENED back-compatibly later; it could not be narrowed — hence the tight v1.
  - **Milliseconds are PRESERVED; sub-ms is TRUNCATED.** `${run.startedAt}` is stamped via
    `toISOString()` and always carries 3 fractional digits, so normalising to `.000Z` would make
    `addDays(run.startedAt, 0) != run.startedAt`. Conversely RFC3339 allows any number of digits
    (real APIs emit microseconds) and a `Date` is ms-resolution, so REFUSING those would make the
    date fns unusable on an ordinary HTTP output; the loss is the representation's own limit.
  - **Range is years 0001-9999** (.NET `DateTime`'s range), so every value these fns RETURN is
    re-parseable by their own parser: outside it `toISOString()` emits an expanded form
    (`+275760-09-13T…`) that the strict parser would reject, silently breaking composition
    (`addDays(addDays(t, n), 1)`). Out-of-range throws a clean `SubstituteError` — a raw
    `toISOString()` would throw `RangeError: Invalid time value`, surfacing as a baffling
    "function 'addDays' failed".
  - **Fractional intervals are REFUSED.** `addDays(t, 0.5)` reads as "half a day" but would floor to
    zero; `addHours(t, 12)` says it exactly.
  - **`addToTime`/`subtractFromTime` take a CLOSED, case-sensitive unit vocabulary** (ADF's names):
    `Second Minute Hour Day Week Month Year`. Month/Year are CALENDAR units and **CLAMP** to the end
    of a short month (.NET `AddMonths`): `2026-01-31 + 1 Month` → `2026-02-28` (`2028` → `02-29`),
    where naive ms arithmetic would overflow into March and silently skip a month.
  - **`dayOfWeek` is 0=Sunday** — ADF parity, and what `triggers/run-window.ts` already reads via
    `getUTCDay()`. A different numbering would ship two weekday conventions in one product.
  - **`formatDateTime` is a CLOSED token set** — `yyyy MM dd HH mm ss fff` — scanning runs of the
    SAME character (.NET's convention, so `yyyyMMdd` tokenises without separators). An alphabetic run
    must BE a token; everything else passes through literally. Rejecting an unknown token is the same
    call as `float`'s decimal-only regex: emitting an unimplemented `yy` raw would hand the author
    `yy-07-15` and let them believe it worked. **No quoted-literal syntax** (so no literal `'T'`):
    the format arg already sits inside a `${}` string literal, and the ISO shape needs no formatting
    because values ARE ISO — anything richer composes with
    `concat(formatDateTime(t,'yyyy-MM-dd'), ' at ', formatDateTime(t,'HH:mm'))`.
  - **No trailing `format` arg** on `addDays`/`addToTime`/… (ADF has one). `substring` proves optional
    args work under the `minArgs` model, so this is a choice: `formatDateTime(addDays(t,1),'…')`
    composes and keeps ONE formatting path.
  - **A null `${run.startedAt}` THROWS** rather than coercing (`RunState.startedAt` folds to `null`
    for a pre-E3 log). Loud beats a silent epoch-1970. Pinned by test.
  - **No new resource cap.** These return scalars/strings and allocate nothing array-shaped; the
    array caps are irrelevant here and max resolved-value size stays OUT (E7/general).
- **SSOT bug — FIXED at E3 (2026-07-15, implemented).** Was: the spec's example expressions use
  `run.runId`/`run.startedAt`, but the shipped `RUN_FIELDS = [id, pipelineVersionId, triggerId,
  parentRunId]` — `runId` was `id` and `startedAt` didn't exist, so the dynamic-filename expression
  was rejected. Now `RUN_FIELDS = [runId, startedAt, pipelineVersionId, triggerId, parentRunId]`.
  - `run.id` was **renamed, not aliased** — the set is documented CLOSED, so two spellings of one
    field would be the very drift this fixed. No doc/fixture/seed used the old name.
  - `pipelineVersionId`/`triggerId` are kept beyond this spec's namespace table (which listed only
    `runId, startedAt, parentRunId?, attempt`): they already worked, and removing a live field is a
    bigger break than recording the deviation. The table above is amended to match the code.
  - **`startedAt` is a LOGGED FACT, not a clock read:** it rides in the `run.started` PAYLOAD
    (`reduce` folds payloads only — reading the envelope `ts` column would widen the reducer's
    contract and break CP1), stamped by the driver from the run ROW (`runs.started_at`) so one named
    fact never gets two disagreeing durable answers. The field is **optional** for durable
    back-compat: a pre-E3 `run.started` row must still parse and folds to `null`.
  - `triggerId`/`parentRunId` still resolve to `null` for every run — they are not carried in
    `RunState`. Live-but-always-null is a known gap, owned by #5 (trigger context) / P2c (child runs).
- **`if.condition` / `foreach.items` MUST be whole-value mode** (reject embedded interpolation) —
  proven that an embedded boolean silently coerces to the string `"true"`.
  - **E2 (shipped) — the whole-value-required field list is SSOT; extend it HERE:** `exitWhen`
    (#1 loop containers, live today — `until` (#4 A3) is this same field, not a second one),
    `if.condition` + `foreach.items` + `switch` case selectors + `filter` predicates (#4).
    `exitWhen` was ADDED to this list at E2: it is the same shape and the only such field that
    exists yet, and the defect was live — a padded `' ${done} '` resolved to `" true "`, which is
    not `"true"`, so the loop burned every round and reported the misleading reason `capped`.
  - **The rule needs BOTH halves — and they share one core.** `validateDoc`/`validateRefs` are
    **advisory**: their only caller is the canvas badge, which does not block Save, and the server
    never calls them (#444), so a git import or a direct POST reaches the engine unchecked. So a
    whole-value-required field is checked at save AND at run, or the rule is decorative. The two
    halves cannot be one function (one accumulates into `errors[]`, the other must throw), so
    `engine/params.ts` factors the judgement + message set into `defectOf` and exposes it as:
    - `validateWholeValue(where, value, errors, noun)` — save-time, accumulates;
    - `wholeValueDefect(value, noun)` — run-time, returns the message to throw.

    #4 calls these rather than restating the rule. Both stay SILENT on an unterminated `${`: that
    is a *grammar* defect, owned by the grammar scan (`scan` / `substitute`), which reports it
    precisely — owning it in both places double-reports it at save and mislabels it at run.
- **Inertness invariant to PRESERVE when adding array-forms:** `map`/`filter` must eval element ASTs,
  **never re-parse a resolved string** — keeps the no-injection guarantee (verified in the spike).
- **`${nodes.<id>.status}` availability — the `settled` analysis (E3, 2026-07-15, implemented).**
  A status ref asks a DIFFERENT question from an output ref, so it needed its own must-analysis
  (`computeGraph.settled`) rather than reusing `guaranteed`:
  - `guaranteed[R]` = "did X **succeed** on every path to R" (gates `${nodes.X.output.*}`).
  - `settled[R]` = "is X guaranteed **terminal** (success|failure|skipped) on every path to R".
    Weaker, and that gap IS the feature: a status is readable on exactly the failure/completion/
    skipped paths where an output is not, which is what makes the ADF fan-in/OR pattern expressible.
  - **Vocabulary is the TERMINAL set only.** `TerminalNodeStatusSchema` in `engine/types.ts` is the
    SSOT, shared with the reducer's `EndpointOutcome` so they cannot drift. A live status
    (`pending`/`ready`/`dispatched`/`waiting`) is a RACE, not a value → run-time **throw**.
  - **The throw is a plain `SubstituteError`, never `MissingNodeOutputError`** — `default()` catches
    the latter, so routing through it would let `${default(nodes.a.status,'none')}` silently report a
    verdict the run never reached. For the same reason the save-time check **ignores `softOk`**:
    relaxing inside `default()` would accept a doc that still throws at run, with no escape hatch.
  - **Settledness does NOT propagate through an `on:'skipped'` edge.** A node is skipped as soon as
    ONE incoming group is dead, while its OTHER predecessors may still be RUNNING — so a skipped
    predecessor is itself terminal but vouches for nothing upstream. (The same inversion `guaranteed`
    already handles, for a subtler reason.) The skipped node itself stays readable — it IS terminal.
    The edge-wise intersection subsumes this for a fully-TRACKED graph; the inversion is
    **load-bearing** for the case the intersection cannot see — an UNTRACKED predecessor under an
    `all` join, where the untracked group dying skips the node while its tracked siblings are still
    in flight. (Pinned by mutation: dropping the inversion fails that test and nothing else.)
  - **Three conservative refusals**, each a FALSE-ACCEPT if missed — the one direction that is never
    safe here (a doc accepted at save that then throws at run, with no `default()` escape hatch):
    - **`any` join + a container predecessor → `settled = ∅`.** `computeGraph` is node-only, but the
      reducer's readiness graph spans nodes ∪ containers, so a container edge is invisible to the
      analysis and live in the engine. Under `any`, R dispatches the moment the container satisfies
      while a tracked sibling still runs. Under `all` an untracked predecessor only ADDS a
      requirement, so ignoring it stays sound — hence the scoping. **The identical hole existed in
      `guaranteed` and is fixed in the same pass** (proven by test: the pre-fix analysis accepted
      `${nodes.a.output.text}` on that shape), so the two analyses can never disagree about one graph.
    - **A doc that can RE-RUN a node → `settled = ∅` doc-wide.** A re-run returns a settled node to
      `pending` while a node outside the re-run body stays ready and dispatches. The reducer resets
      from **two** places and both must be covered: `fireBackEdges` (a `back:true` edge) **and**
      `resetContainerRound` (a **LOOP container**, which re-rounds off `exitWhen`/`maxRounds` alone
      and carries NO back-edge — so an edge-only test misses it, and `validateRefs` had to be widened
      to take `containers` to see it at all). A `stage` never re-rounds and does NOT disable the
      handle. Both halves are pinned by mutation.
  - **`exitWhen` gets its own scope** (`validateExitWhen`), where every child IS settled by the
    reducer's own precondition (`stepContainers` only evaluates `exitWhen` once all children are
    terminal) — so the doc-wide loop refusal above does not reach it. NB this is AVAILABILITY only:
    a bare `${nodes.check.status}` is still not a usable `exitWhen`, because the field needs a
    BOOLEAN and a status resolves to the string `'success'`. The usable form
    `${equals(nodes.check.status,'success')}` needs `equals` (**E4**), and the
    string-where-boolean-expected rejection is **E6**'s type check — consistent with E2's split
    (E2 owns the MODE check, E6 the TYPE check). Refusing availability here would misattribute a
    type defect to a scope rule.
  - **Known safe false-rejects** (over-refusal is safe; a later ticket may narrow them): a status ref
    in the node config of a doc that can re-run (a back-edge or a loop container), and any
    container's own status (`nodes.<containerId>.status` — node-only analysis, though a container's
    projected *outputs* do resolve at run time).

## Non-goals

- Data-flow/mapping-expression functions (not our domain). No regex/`eval`/`expr()`/user-defined
  functions in v1. No implicit type coercion beyond the explicit conversion fns. No non-deterministic
  functions (`rand`/`guid`/host entropy) in reducer-evaluated expressions.

## Open questions (for Codex / re-challenge)

1. Deep-path into `json` outputs as `any` vs requiring a declared sub-schema — parity (permissive) vs
   safety (typed). Leaning permissive-with-runtime-validation (ADF's stance).
2. `utcNow()` per-node-dispatch stamp vs one run-stable stamp — expose both (`utcNow()` = per-node,
   `${run.startedAt}` = run-stable)? Confirm the semantics users expect.
3. Numeric type: variables are String/Bool/Array parity (#1 D2) but comparisons/scores need number —
   confirm `int/float` conversion + the `number` variable extension cover it.
4. Is a closed catalog (no user fns) enough for real pipelines, or is a documented extension path
   (allowlisted PR) needed day-one?
