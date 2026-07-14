# Foundation Spec #1 — Domain model + Activity framework

**Status:** proposed — brainstormed + ADF-grounded 2026-07-14; pending Codex + self review.
**Scope:** deepen the pipeline **domain model** to ADF parity and formalize the
**Activity Definition** contract. **Foundation layer — engine/server changes ARE in
scope** (unlike the UI epic, which is presentation-only). The UI epic
(`2026-07-14-adf-grade-ui-design.md`) renders what this spec defines.
**Grounded in ADF docs** (MS Learn: `concepts-parameters-variables`,
`concepts-pipelines-activities#activity-json`, `ActivityPolicy`,
`tutorial-pipeline-failure-error-handling`).

## Decisions (operator, 2026-07-14)

- **Full lifecycle/audit** — audit trail + rerun + rerun-from-failed-activity.
- **Global/factory parameters IN** scope.
- **Formalize the Activity Definition contract** as the SSOT; migrate http/llm/agent onto it.

## ADF grounding (what we're matching)

- **Pipeline object:** `name · description · activities[] · parameters{} · variables{} ·
  concurrency · annotations[] · folder · policy(elapsedTimeMetric)`.
- **Parameters** — defined at pipeline level, **read-only during a run**, typed
  (String/Int/Float/Bool/Array/Object/SecureString), `@pipeline().parameters.x`.
- **Variables** — **mutable during a run** via **Set Variable** / **Append Variable**
  activities, typed String/Bool/Array, `@variables('x')`; **pipeline-scoped, not
  thread-safe** (documented hazard in parallel/foreach).
- **Global parameters** — factory-level, shared across pipelines, overridable at trigger.
- **Activity policy** (execution activities only): `timeout` · `retry` (max attempts,
  default 0) · `retryIntervalInSeconds` (default 30, 30–86400) · `secureInput` /
  `secureOutput` (excluded from monitoring logs).
- **Dependency conditions:** Succeeded / Failed / **Skipped** / Completed. Error
  patterns: Try-Catch (Upon-Failure only), Do-If-Else, Do-If-Skip-Else. **Pipeline
  succeeds iff all leaf activities succeed; a skipped leaf → evaluate its parent.**

## Current engine (accurate, verified)

- `PipelineVersion` = `{ version, params[], outputs[], nodes[], edges[], containers[],
  catalogVersion, createdAt }`. **No** author / change-note.
- `Node` = `{ id, type, config, connectionId?, position, call? }`. **No** policy block.
- `Edge.on` = `success | failure | completion`. **No `skipped`.**
- Engine **already models** `skipped` node status + skip propagation
  (`TERMINAL_NODE = {success, failure, skipped}`), and `run.resumed` resume machinery
  (boot reconciler / P2d). **No** retry/timeout policy handling.
- Connectors carry a failure taxonomy (`transient` | `permanent` | `cancelled`) — the
  retry SIGNAL exists but the reducer doesn't yet act on it.
- Params today: typed, `${params.x}` / `${nodes.id.output}` / `${run.field}`,
  save-time `validateRefs`.

## Design

### D1 — Pipeline object v2

Add to the version doc (back-compat: all new fields optional / default-empty so older
versions still parse — the migration invariant):
`description? · annotations?: string[] · folder?: string · concurrency?: number ·
variables?: VariableDef[]`. Keep `params/outputs/nodes/edges/containers`.

### D2 — Parameters vs Variables

- **Params** stay read-only-in-run (already correct). Extend the type set to ADF's
  (add Int/Float/Object/SecureString to today's set); `SecureString` params are
  secret-handled (never logged; see D6 secure).
- **Variables** — NEW. `VariableDef = { name, type: string|number|bool|array, default? }`.
  Mutable in-run; new reducer state `run.variables`. New activities:
  - **`set_variable`** (control activity) — `{ variableName, value:${expr} }`;
    special **pipeline-return-value** mode → child-run output (formalizes `call_pipeline`
    returns).
  - **`append_variable`** — array push.
  - New reference namespace **`${vars.x}`** in the `${}` language (+ `validateRefs`
    extended to validate `vars`/`global` refs). **Thread-safety:** carry ADF's caveat —
    document + lint variables mutated inside a parallel container (warn badge).

### D3 — Global / factory parameters

Workspace-scoped **GlobalParam store** (`{ name, type, value }`), `${global.x}` namespace,
**precedence: `global` < pipeline-param default < trigger override**. Read-only in run.
New table + REST; `validateRefs` resolves `global` names. (A minimal "workspace settings"
surface — the smallest slice that supports global params; broader workspace config later.)

### D4 — Per-activity policy

Add optional `policy` to `Node`:
`{ timeout?: seconds, retry?: int(≥0), retryIntervalSeconds?: int(30–86400),
secureInput?: bool, secureOutput?: bool }`. Engine (reducer + driver):
- On a **`transient`** activity failure with attempts-remaining (`< retry`), schedule a
  retry after `retryIntervalSeconds` (monotonic attempt ids already exist). `permanent`
  never retries. Exhausted retries → node `failure`.
- **`timeout`** bounds the whole activity (driver-enforced; the http connector already
  has a request timeout — the policy generalizes it per node).
- **`secureInput/secureOutput`** → redact that node's input/output from `run_events`
  payloads (a redaction pass keyed by node id).

### D5 — Dependency conditions + error semantics

- Add **`skipped`** to `EdgeOnSchema` → `success | failure | completion | skipped`
  (engine already has skipped node states; this exposes routing). Unlocks Try-Catch /
  Do-If-Else / **Do-If-Skip-Else**.
- Define **pipeline success semantics** explicitly to match ADF: success iff every LEAF
  endpoint succeeds; a skipped leaf evaluates its parent. Reconcile with the current
  `finishRun` endpoint-outcome logic (verify against `reduce.ts` — may already align).

### D6 — Activity Definition contract (the framework SSOT)

One declarative registry entry per activity type — the extensibility seam:

```ts
ActivityDefinition = {
  type: string,                         // 'http_request' | 'llm_call' | 'set_variable' | …
  category: 'general'|'ai'|'control'|'file'|…,
  kind: 'execution'|'control',          // control = no connection/policy (ADF split)
  connectionKinds?: ConnectionKind[],   // which connections it can bind
  configSchema: ZodSchema,              // the node.config shape → drives the properties panel
  inputs: ParamSpec[], outputs: OutputSpec[],   // typed, for ${} + validation
  supportsPolicy: boolean,              // execution activities: true
  secureFields?: string[],              // config paths never logged
  outputHandling?: …,                   // how raw result → typed outputs
  errorMap: (raw) => 'transient'|'permanent'|'cancelled'|'succeeded',
  logHooks?: …,                         // per-activity structured logging
}
```

Migrate `http_request` / `llm_call` / `agent_task` onto it; add `set_variable` /
`append_variable`. The catalog (`@autonomy-studio/shared`) is the SSOT the properties
panel (UI U7), palette (U5), and validation all read.

### D7 — Audit & lifecycle

- **Version audit:** add `author` (principal) + `changeNote?` + keep `createdAt` to
  `PipelineVersion`; a version-history view (immutable chain already exists).
- **Run history:** exists (runs table); add richer query (via UI R2 RunSummary).
- **Rerun / rerun-from-failed:** new. **Rerun** = new run, same version, same/overridden
  params. **Rerun-from-failed** = new run that **replays events up to the last successful
  frontier, then resumes dispatch from failed/downstream nodes** — builds on the existing
  `run.resumed` resume machinery (P2d reconciler). Event-sourcing: a rerun is a NEW run
  with a `rerunOf` link + a starting projection seeded from the source run's successful
  node outputs.

## Data-model changes

- `pipeline_versions`: + `author`, `changeNote`, + doc fields (description/annotations/
  folder/concurrency/variables) — all optional (parse-old-rows invariant).
- `nodes` (in doc): + `policy?`.
- `edges`: `on` enum + `skipped`.
- New `global_params` table (workspace-scoped).
- `runs`: + `rerunOf?`.
- Activity Definition registry in `shared` (code, not DB).

## Engine changes

- Reducer/driver: retry loop (respect `retry`/interval on `transient`), timeout
  enforcement, `skipped` edge routing, variable state + set/append reducer handling,
  secure redaction of events, rerun-from-failed seeding.
- `validateRefs`/`validateDoc`: `${vars}` + `${global}` namespaces; variable/param type
  checks; thread-safety warn for variables mutated in parallel containers.

## Ticket decomposition (F-series, ordered; each ≈ one fire)

| # | Ticket |
|---|--------|
| F1 | `skipped` edge condition + pipeline-success semantics reconcile (+tests) |
| F2 | Per-activity `policy` schema + reducer retry/interval on transient |
| F3 | `policy.timeout` enforcement (generalize http timeout) |
| F4 | `secureInput/secureOutput` redaction of `run_events` |
| F5 | Variables: schema + `run.variables` state + `${vars}` + validateRefs |
| F6 | `set_variable` / `append_variable` activities (+ pipeline-return-value) |
| F7 | Global params: table + REST + `${global}` + precedence |
| F8 | Pipeline props: description/annotations/folder/concurrency (+ concurrency enforcement) |
| F9 | Activity Definition contract in `shared` + migrate http/llm/agent |
| F10 | Version audit: author + changeNote + history query |
| F11 | Rerun (new run, same version) |
| F12 | Rerun-from-failed (resume-frontier seeding on `run.resumed` machinery) |

## Cross-cutting

- **Back-compat is load-bearing:** every schema add is optional/defaulted so
  already-stored versions/runs parse (the P1c migration invariant). Add a migration +
  `foreign_key_check` per change.
- **`${}` language:** two new namespaces (`vars`, `global`) — keep the INERT
  single-pass-substitution + closed-allowlist guarantees (no injection).
- **Concurrency** enforcement lives in the scheduler/launcher (respect per-pipeline
  `concurrency`, queue overflow — mirror ADF).
- TDD per ticket; `studio` CI green; each merges non-breaking.

## Non-goals

- No LLM-activity DEPTH here (prompt slots/modes/tools) — that's Foundation Spec #2.
- No git/publish (Foundation Spec #3), no file/copy activity library (Spec #4).
- No UI (the UI epic renders this).

## Open questions (for Codex)

1. Does the current `finishRun` leaf-outcome logic already match ADF's "all leaves
   succeed; skipped leaf → parent" rule, or does D5 need reducer changes?
2. Retry state: where do attempt-count + next-retry-time live — reducer state vs driver?
   Interaction with the existing monotonic `attemptId` + `run.resumed`.
3. Rerun-from-failed: is replay-to-frontier + reseed sound in a pure event-sourced model,
   or does it need a dedicated `run.reseeded` event? Container/child-run edge cases.
4. Secure redaction: redact at emit-time (never hits the log) vs at read-time. Emit-time
   is safer but irreversible for debugging — which?
5. Variables thread-safety: warn-only, or hard-reject variable mutation inside a
   `parallel` container at save-time?
6. Is F9 (Activity Definition migration) too big for one fire — split by activity?
