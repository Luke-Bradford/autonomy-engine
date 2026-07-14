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
| `nodes.<id>.status` | `success \| failure \| skipped` | **NEW (T6)** — enables the ADF `@activity().Status` fan-in/OR pattern |
| `run.<field>` | run system vars: `runId`, `startedAt`, `parentRunId?`, `attempt` | **NEW (T2/C3)** |
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
  lastIndexOf guid` (+ `length empty` via collection)
- **Collection:** `length empty contains first last take skip join intersection union createArray range`
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
| E3 | Reference resolver over namespaces (params/vars/global/nodes.output/nodes.status/run/pipeline/item) |
| E4 | Function catalog impl + per-fn type signatures (logical/string/collection/conversion/math) |
| E5 | Date fns + dispatch-stamped time (`utcNow` binds node.dispatched stamp; `run/pipeline` from seed) |
| E6 | `validateRefs` typing: infer expr type, check against field-expected type; boolean-condition + array-items checks |
| E7 | Deep `[]`/`.` addressing into `json`/`any` outputs (runtime-validated escape hatch) |
| E8 | Validation profiles (generic vs trigger-binding) + `${trigger.*}` context-scoping (with #5) |

## Non-goals

- Data-flow/mapping-expression functions (not our domain). No regex/`eval`/user-defined functions in
  v1. No implicit type coercion beyond the explicit conversion fns.

## Open questions (for Codex / re-challenge)

1. Deep-path into `json` outputs as `any` vs requiring a declared sub-schema — parity (permissive) vs
   safety (typed). Leaning permissive-with-runtime-validation (ADF's stance).
2. `utcNow()` per-node-dispatch stamp vs one run-stable stamp — expose both (`utcNow()` = per-node,
   `${run.startedAt}` = run-stable)? Confirm the semantics users expect.
3. Numeric type: variables are String/Bool/Array parity (#1 D2) but comparisons/scores need number —
   confirm `int/float` conversion + the `number` variable extension cover it.
4. Is a closed catalog (no user fns) enough for real pipelines, or is a documented extension path
   (allowlisted PR) needed day-one?
