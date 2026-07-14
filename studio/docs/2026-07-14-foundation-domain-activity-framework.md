# Foundation Spec #1 — Domain model + Activity framework

**Status:** proposed — brainstormed + ADF-grounded + **Codex-reviewed (17 findings) +
self-reviewed**, 2026-07-14. Pending user review gate.
**Scope:** deepen the pipeline **domain model** to ADF parity and formalize the
**Activity Definition** contract. **Foundation layer — engine/server changes ARE in
scope.** The UI epic (`2026-07-14-adf-grade-ui-design.md`) renders what this defines.
**Grounded** in ADF docs (MS Learn) + the actual studio engine (verified).

## Decisions (operator, 2026-07-14)

Full lifecycle/audit (audit + rerun + rerun-from-failed) · Global params IN · Formalize
the Activity Definition contract.

## Non-negotiable engine invariants this spec must preserve

- **`state = fold(the run's OWN events)`.** No out-of-band projection preloads. Every
  state change is an event.
- **Reducer is PURE** — no wall-clock, no timers, no I/O. Timed/side-effecting work is a
  **driver** concern that terminalizes back into the log via events.
- **Back-compat:** already-stored versions/runs/events must still parse. Every schema add
  specifies its parse-boundary default; new events are union additions, never shape changes.
- **`${}` stays INERT** — single non-rescanning substitution pass, closed fn allowlist,
  no injection — across the new `vars`/`global` namespaces.

## Current engine (verified)

- `PipelineVersion = { version, params[], outputs[], nodes[], edges[], containers[],
  catalogVersion, createdAt }`. No author/change-note.
- `Node = { id, type, config, connectionId?, position, call? }`. No policy.
- `Edge.on = success|failure|completion`. No `skipped`.
- Engine models `skipped` node status + propagation (`TERMINAL_NODE={success,failure,
  skipped}`). Events include `node.failed` (**payload carries `error: string`, NOT a
  machine `kind`**) and `node.retryRequested` (**the P2d BOOT-decision retry — NOT policy
  backoff**). `NodeRunState.attempts` exists. `RunStateSchema` has **no `variables`**.
- Catalog registry has **`idempotent`** per activity (false for all MVP activities;
  boot-recovery persists the dispatch-time value).
- Connectors classify `transient|permanent|cancelled` but the reducer does NOT act on it.

## Design

### F0 (PREREQUISITE) — structured failure `kind`

Everything retry-related depends on this. Add `kind: 'transient'|'permanent'|'cancelled'`
(and optional `code`) to the **`node.failed` event payload**; connectors already produce
it — stop string-formatting it into `error`. **Parse default for old events: `permanent`.**
The reducer keys retry/routing off `kind` ONLY, never off `error` text.

### D1 — Pipeline object v2

Add optional (default-empty) doc fields: `description? · annotations?: string[] ·
folder? · concurrency? · variables?: VariableDef[]`. Old versions parse unchanged.

### D2 — Parameters vs Variables

- **Params** stay read-only-in-run. Type set = ADF parity **String/Int/Float/Bool/Array/
  Object**. (`SecureString` — see D8; NOT folded into today's `secret`.)
- **Variables** — NEW, mutable in-run. `VariableDef = { name, type, default? }`. **Types =
  ADF parity String/Bool/Array**; `number` is a documented **Studio extension**, not parity.
  - New reducer state `RunState.variables` (**parse default `{}`**).
  - Mutations are events only: **`variable.set` / `variable.append`**. New control
    activities `set_variable` / `append_variable` emit them (engine-evaluated — see D6).
  - New reference namespace **`${vars.x}`** (resolves at dispatch-time; save-time
    `validateRefs` checks the NAME exists). No self-reference in `set_variable.value`
    (ADF constraint — `validateDoc` enforces).
  - **Determinism guard (stronger than ADF's warn):** `validateDoc` **hard-rejects**
    variable mutation from a node that can run inside a `parallel` container (result would
    depend on scheduler timing), unless the pipeline opts into an explicit
    `allowNondeterministicVars` flag on that container.

### D3 — Global / factory parameters

Workspace-scoped store `{ name, type, value }`; **`${global.x}` is its own explicit,
read-only namespace.** It is **NOT** an implicit fallback for same-named `${params}`
(no name-collision injection). Param resolution stays `pipeline default < trigger
override`; globals are referenced explicitly. Secure globals route to the **secret store**
(not plaintext in the table); `${global.secureX}` is refused in substitution except at
approved secret sinks (D8). New table + REST; `validateRefs` resolves global names.

### D4 — Per-activity policy (event-modeled)

Optional `Node.policy = { timeout?, retry?(≥0), retryIntervalSeconds?(30–86400),
secureInput?, secureOutput? }`. Split across the pure/impure boundary:
- **Reducer (pure):** on `node.failed{kind:'transient'}` with `attempts < retry`, decides
  the node is **retry-eligible** and emits a `scheduleRetry{nodeId, failedAttemptId}`
  command. `permanent`/`cancelled` never retry.
- **Driver (clock):** on `scheduleRetry`, waits `retryIntervalSeconds`, then appends a
  durable **`node.retryScheduled{nodeId, nextAttemptAt}`** → **`node.retryDue`** (time
  supplied by the driver, stored in the log — never an ephemeral timer). The reducer folds
  `node.retryDue` → re-dispatch. Distinct from the existing boot-decision `node.retryRequested`.
- **Timeout:** driver-enforced; terminalizes via a normal event
  **`node.failed{kind:'transient', code:'timeout'}`** so boot-recovery distinguishes
  timed-out from crashed. Retry policy then applies uniformly.

### D5 — Dependency conditions + pipeline-success semantics

- Add **`skipped`** to `EdgeOnSchema` → `success|failure|completion|skipped` (parse-safe
  for old docs; note: old CLIENTS won't understand it). Unlocks Try-Catch / Do-If-Else /
  Do-If-Skip-Else.
- **Success semantics — TESTS FIRST, then reconcile.** Current reducer: success when all
  top-level entities terminal + no unhandled top-level failure (a skipped top-level leaf
  can currently yield success). Target (ADF): success iff every leaf succeeds; skipped leaf
  → evaluate parent. Write characterization tests for: skipped final branch after a failed
  condition; skipped child inside a stage; skipped top-level leaf with no parent; failure
  caught by a catch branch that then succeeds; a root skipped by impossible incoming edges.
  Only change `finishRun` logic if the tests show divergence.

### D6 — Activity Definition contract (framework SSOT)

```ts
ActivityDefinition = {
  type, category, kind: 'execution'|'control',
  connectionKinds?: ConnectionKind[],      // execution only
  configSchema: ZodSchema,                  // → properties panel
  inputs: ParamSpec[], outputs: OutputSpec[],
  idempotent: boolean,                      // KEPT — boot-recovery persists dispatch-time value
  supportsCancel: boolean,
  supportsPolicy: boolean,                  // retry/timeout — execution only
  timeoutScope?: 'adapter'|'request'|'child'|'activity',
  retryableFailureKinds?: FailureKind[],
  errorMap: (raw) => { kind, code?, message },   // STRUCTURED, not a string
  // SECURITY IS SEPARATE FROM POLICY (control activities handle values too):
  secureConfigFields?: string[], secureInputFields?: string[], secureOutputFields?: string[],
  logHooks?: …,
}
```
- **Control activities** (`set_variable`/`append_variable`/`return`/if/foreach) are
  **engine-evaluated pure transitions** — no connector adapter, no retry/timeout, but they
  DO carry security metadata. Distinct dispatch path from connector-dispatched execution
  activities.
- Migrate `http_request`/`llm_call`/`agent_task` onto it (keep their `idempotent`). SSOT
  read by the UI palette (U5), properties panel (U7), and validation.

### D7 — Audit & lifecycle

- **Version audit:** add `author`(principal) + `changeNote?` to `PipelineVersion`;
  history view over the existing immutable chain.
- **Rerun (simple):** a NEW run, same version, same/overridden params. `runs.rerunOf?` link.
- **Rerun-from-failed (GATED — needs its own sub-spec before build):** a NEW run whose log
  begins with a durable **`run.reseeded{sourceRunId, frontier, copiedNodeStates,
  copiedOutputs, copiedVariables, copiedContainers, childLinks?}`** event that the reducer
  folds (marking frontier nodes terminal). Log stays self-deriving. **Frontier defined in
  engine terms, not UI terms** — specify: which node/container statuses copy, outputs copy,
  attempts reset-vs-inherit, and `call_pipeline` provenance: a non-frontier call node either
  **spawns a fresh child** OR persists `{callNodeId, sourceChildRunId, copiedOutputs}` as
  provenance (never pretend the new run spawned that child). secureOutput values can't be
  reseeded (D8) — documented limitation.

### D8 — Secure handling

- **Emit-time redaction** (never persist secrets to `run_events`/backups/exports).
  `secureInput` is cheap (prepared input is a command, not a durable event). **`secureOutput`
  is hard:** a redacted output cannot feed downstream `${nodes.x.output}` — either
  **prohibit downstream refs to a secure output** (validateDoc) or store an **opaque secret
  handle** the pure reducer passes without seeing plaintext.
- **`SecureString` params:** do NOT broaden today's `secret` (a credential *label* stripped
  from substitution) into a plaintext run input. Either a separate encrypted-run-param
  concept or **deferred** — decided in review, not silently.

## Data-model + parse-boundary defaults (back-compat)

| Change | Parse default |
|---|---|
| `node.failed.kind` | `permanent` (old events) |
| `RunState.variables` | `{}` |
| new events (`variable.set/append`, `node.retryScheduled/retryDue`, `run.reseeded`) | union additions; old logs never contain them |
| `Edge.on` + `skipped` | parse-safe for old docs; old clients ignore |
| doc fields (desc/annotations/folder/concurrency/variables) | optional/empty |
| `PipelineVersion.author/changeNote`, `runs.rerunOf` | optional |
| `global_params` table | new |

## Ticket decomposition (~28, reordered; each ≈ one fire)

**Order is load-bearing: structured failure → policy schema → retry scheduling → … →
rerun (gated).**

| # | Ticket |
|---|--------|
| **F0** | `node.failed.kind` structured failure field (+ default) — PREREQUISITE |
| F1 | `skipped` edge condition + success-semantics characterization tests |
| F1b | success-semantics reconcile (only if tests diverge) |
| F2a | `Node.policy` schema + validation |
| F2b | reducer retry-eligibility decision (keyed off `kind`) |
| F2c | driver durable retry scheduling (`node.retryScheduled/retryDue`) |
| F3 | `policy.timeout` → `node.failed{code:timeout}` event |
| F4 | `secureInput/secureOutput` emit-time redaction + downstream-ref rule |
| F5a | Variables schema + `RunState.variables` state |
| F5b | `${vars}` substitution namespace + validateRefs |
| F5c | parallel-mutation hard-reject (determinism guard) |
| F6 | `set_variable`/`append_variable`/`return` control activities |
| F7a | global_params table + REST |
| F7b | `${global}` resolver + explicit-namespace validation |
| F7c | secure globals → secret store |
| F8a | pipeline props schema (desc/annotations/folder/concurrency) |
| F8b | per-pipeline concurrency enforcement (scheduler/launcher) |
| F9a | ActivityDefinition contract type (+ idempotent/cancel/timeoutScope/secure/errorMap) |
| F9b | migrate `http_request` onto it |
| F9c | migrate `llm_call` |
| F9d | migrate `agent_task` + catalog consumers |
| F10 | version audit: author + changeNote + history |
| F11 | Rerun (simple, same version) |
| RS | **sub-spec:** rerun-from-failed reseed-event + frontier semantics |
| F12a–e | rerun-from-failed (basic / reseed event / frontier algo / containers / call_pipeline) — after RS |

## Non-goals

- LLM-activity DEPTH → Foundation Spec #2. Git/publish → #3. File/copy activity library → #4.
- No UI (UI epic renders this). No `SecureString` broadening of `secret` (D8, decided in review).

## Resolved open questions (decided 2026-07-14)

1. **`SecureString` params — DEFERRED.** Keep `secret` as the connection credential label
   (unchanged). Secret needs are met by connections today; run-scoped secret *params* are a
   later slice (own ticket) — not folded into `secret`, never plaintext run input.
2. **secureOutput downstream — two-phase.** MVP (F4): `validateDoc` **hard-prohibits** a
   `${nodes.x.output}` ref where `x` has `secureOutput` (simple, safe). TARGET (later): an
   **opaque secret handle** (`secret://run/<node>`) stored encrypted, resolved at
   dispatch-time so secrets can flow activity→activity without ever hitting the log.
   Spec both; build the prohibit first.
3. **Variables in parallel — hard-reject** (current design), with an explicit
   `allowNondeterministicVars` container opt-in. Matches the engine's deterministic posture.
4. **Rerun-from-failed `call_pipeline`** — decided in the RS sub-spec; default lean =
   always spawn a fresh child for any non-frontier call node (provenance-mapping is the
   optimization, only if reuse is needed).
