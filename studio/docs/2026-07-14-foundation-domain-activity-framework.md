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
- Connectors classify `auth|rate_limit|transient|permanent|cancelled` (`ConnectorErrorKind`,
  `connectors/types.ts`) — FIVE kinds, not three — but the reducer does NOT act on it.

## Design

### F0 (PREREQUISITE) — structured failure `kind` — **BUILT**

Everything retry-related depends on this. `kind: 'transient'|'permanent'|'cancelled'`
(and optional `code`) on the **`node.failed` event payload**. **Parse default for old
events: `permanent`.** The reducer keys retry/routing off `kind` ONLY, never off `error` text.

**The 3-vs-5 seam (#2's error taxonomy is the SSOT).** The engine's `kind` is the 3-valued
RETRY-DECISION axis; the connectors' 5-kind `ConnectorErrorKind` is PROVIDER-facing. They are
different sets on purpose — a 3-valued engine set keeps the pure reducer from having to answer
a policy question ("is `auth` retryable?") that F2a/F9a own. The adapter set maps DOWN at the
executor seam (`connectors/error-kind.ts::toEngineFailure`), losing nothing: the detail lands
in `code` (`auth` → `{permanent, code:'auth'}`; `rate_limit` → `{transient, code:'rate_limit'}`;
the other three pass through with no code). F0 is therefore a MAPPING ticket — the connectors
do not "already produce" the engine kind, they produce an ADJACENT taxonomy.

`FAILURE_CODES` (`engine/types.ts`) is the single source of truth for engine-minted codes;
the schema keeps `code` an open `z.string()` deliberately (an enum would be a back-compat
trap for a durable event field). `code:'timeout'` is RESERVED there for F3's policy timeout.

### D1 — Pipeline object v2

Add optional (default-empty) doc fields: `description? · annotations?: string[] ·
folder? · concurrency? · variables?: VariableDef[]`. Old versions parse unchanged.

### D2 — Parameters vs Variables

- **Params** stay read-only-in-run. Type set = ADF parity **String/Int/Float/Bool/Array/
  Object**. (`SecureString` — see D8; NOT folded into today's `secret`.)
- **Variables** — NEW, mutable in-run. `VariableDef = { name, type, default? }`. **Types =
  `string | bool | array | number`** — `number` is FIRST-CLASS (Round-2 C2: the LLM-judge aggregate
  flow needs a numeric accumulator; a doc-only "ADF parity" note doesn't block it).
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

### D5 — Dependency conditions + pipeline-success semantics — **F1/F14 BUILT; F1b OPEN**

- **`skipped` is in `EdgeOnSchema`** → `success|failure|completion|skipped` (parse-safe for
  old docs; note: old CLIENTS won't understand it). Unlocks Try-Catch / Do-If-Else /
  Do-If-Skip-Else. **`completion` deliberately does NOT fire on a skip** — ADF's four paths
  are distinct ("Upon Completion … after the current activity completed, regardless if it
  succeeded or not" vs "Upon Skip … if the activity itself didn't run"), so a skip
  propagates until an `on:'skipped'` edge catches it. An `on:'skipped'` edge likewise does
  NOT count as *handling* a failure.
- **The `Edge` union is settled here** (T3): operational `{on: success|failure|completion|
  skipped}` vs business `{on:'branch', branch}`. `EdgeOnSchema` stays OPERATIONAL-ONLY (the
  canvas renders it as a dropdown); `branch` is a separate union member. Branch edges are
  **parse-safe and INERT** until #4 A0/A1/A2 ship the activities that emit a branch outcome
  — nothing can satisfy one before then. `validateDoc` reports one, but that is **advisory,
  not a gate**: its only caller is the canvas, which renders a badge and still permits Save,
  and the server never validates (**#444**). The **reducer's diagnostic is the real
  observability**, which is why F1 put one there rather than trusting the checker.
- **A `skipped` edge inverts its predecessor's guarantees** (`computeGraph`): a node runs on
  a skip precisely because the predecessor's own dependency was NOT met, so NOTHING upstream
  is guaranteed through it. Inheriting the predecessor's `guaranteed` set made `validateRefs`
  ACCEPT a doc that then hard-failed at dispatch (`prepInput` throws → `invalid_event`).
- **Success semantics — characterization tests written; reconcile is F1b.** All five cases D5
  called for are covered (incl. **skipped child inside a stage**, which also pins that a
  skipped child never fails its container and that F14's grouping applies to child readiness).
  Four match the ADF target and are pinned; two DIVERGE and are pinned as-is with the
  divergence named:
  1. **Do-If-Else.** ADF: "When previous activity fails: node Upon Success is skipped and its
     parent node failed; overall pipeline fails." Studio treats ANY failure carrying an
     outgoing `failure`/`completion` edge as handled → **success**.
  2. **Eager short-circuit (the sharper one).** `settle` emits `finishRun{failure}` the moment
     `firstUnhandledFailureTop` finds an unhandled failure, so the rest of the graph never
     settles. ADF lets the walk finish and evaluates leaves only at the end — so ADF's own
     **"Generic error handling"** pattern (UponFailure+UponSkip from the LAST activity to a
     handler, reached by skip-propagation from an EARLIER failure) **cannot work here**: the
     handler stays `pending` forever. F1b must decide whether an unhandled failure ends the
     run eagerly or merely marks it doomed while the walk drains.

### D6 — Activity Definition contract (framework SSOT) — **F9a MINIMAL BUILT 2026-07-15**

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

#### F9a spike-hardened block (BUILT 2026-07-15 — the MINIMAL contract)

The build order splits this ticket: **F9a-minimal = the contract shape** (here); **F9b/c/d =
the migrations**. What landed, and the decisions a later ticket must not re-litigate:

- **The catalog IS the ActivityDefinition.** `ActivityCatalogEntry`
  (`shared/src/catalog/types.ts`) already carried `type`/`title`/`idempotent`/
  `connectionKinds`/`outputs`/`configSchema`; F9a ADDED the two seam fields rather than
  minting a rival type. `export type ActivityDefinition = ActivityCatalogEntry` gives D6's
  noun without a rename churning consumers.
- **`kind: 'execution'|'control'`** — the dispatch discriminant. It is now the executor's
  PRIMARY branch, checked AHEAD of the `connectionKinds.length > 0` proxy — which survives
  (it still separates connector-dispatched from the built-in-runner slot). The proxy alone
  conflated "needs no connection" with "not connector-dispatched".
- **`category` + `ACTIVITY_CATEGORIES`** (ordered SSOT for U5's palette groups). Values are
  taken from THIS spec-set's own headings — spec #4 files `agent_task` under
  **"Execution — AI"** next to `llm_call`, so there is no `agent` category. Ships
  `['general','ai']`; #4 adds `control`/`data` with the first activity that needs them.
  Extending is free — a category is never persisted in a doc. **Why `category` is exempt from
  the "don't declare ahead of the consumer" rule below** (its consumer, U5, is also unbuilt):
  the rule bites where a GUESSED SHAPE would be built against — `ParamSpec` does not exist,
  and `retryableFailureKinds` would encode a retry model D4/#5 have not settled. A category is
  a trivial string enum whose values are read off this spec-set's own headings, carries no
  semantics for anything to build against wrongly, and costs one line to extend.
- **CORRECTION to a tempting premise:** "control activities are impossible before F9a" is
  **FALSE**. `call_pipeline` is already a shipped, engine-evaluated, non-connector activity —
  the reducer routes it structurally on `Node.call` (`reduce.ts:436`) and it never reaches
  the executor's DISPATCH path. It does reach the executor: as a `startChild` command, which
  P3a currently deferral-fails (`executor.ts`; P3b/A9 owns the real child spawn). It is not
  catalogued at all (A9 surfaces it). `connectionKinds: [] ⇒ NO_EXECUTOR` only ever blocked a
  control activity that gets *dispatched*, and control activities are never dispatched.
- **THE OPEN FORK — how does the REDUCER learn a node is control?** No spec settles it, and
  F9a deliberately does NOT decide it. Two live options: (a) read this `kind`, which needs
  the catalog injected into `createEngine(doc)` — it takes no catalog today, has ONE
  production call site (`server/src/run/driver.ts`), and `engine/` imports nothing from
  `catalog/`; or (b) a structural config discriminant, the precedent being `call_pipeline`.
  **#4's A1/A2 owns this call.** Until it lands, `kind` is honest metadata + an executor
  guard: the production behaviour delta of F9a is ZERO (all three entries are `execution`
  with a non-empty `connectionKinds`, so the re-keyed branch evaluates identically).
- **`CONTROL_NOT_DISPATCHABLE` is its own failure code**, not a reuse of `NO_EXECUTOR`:
  a control activity at the executor is an ENGINE-INVARIANT violation (a bug), whereas
  `NO_EXECUTOR` means "this execution activity's runner is not built yet". `executor.ts`'s
  own rule is that every cause carries its own code so an operator never string-matches a
  message; `FAILURE_CODES.TIMEOUT` is the precedent for reserving one ahead of its ticket.
  The `execution` + empty-`connectionKinds` → `NO_EXECUTOR` guard is KEPT, so the "future
  built-in runner" slot still fails cleanly instead of falling into `resolveConnection` with
  an empty allowlist (which would report a confusing connection error).
- **Deliberately NOT declared** (a field whose shape is guessed ahead of its consumer is
  worse than an absent one — every later spec would build against the guess). Each is
  sequencing, NOT an open design question: `inputs` (no consumer; `configSchema` types the
  blob; `ParamSpec` does not exist) · `supportsPolicy`/`retryableFailureKinds`/`timeoutScope`
  (F2a/F2b/F3; D4 below is fully specified — the hold-vs-reopen fork is **#5's**, about the
  reducer's retry state machine, and none of these three shapes depend on it; NB `kind`
  already answers the near-term need, since spec #4 gives control activities no policy) ·
  `errorMap` (F9b/c/d — classification today is per-CONNECTION-KIND in `toEngineFailure`, and
  the adapters deliberately disagree: an `http` 4xx is data, an `llm_call` 4xx is a failure)
  · `secure*Fields` (F4/F15; resolved-question 2 already decided prohibit-first) ·
  `supportsCancel` (the `AbortSignal` is unconditional; nothing would read it).
- **Not wired into `validateDoc`** (an unknown `node.type` stays a run-time, not save-time,
  error) — that is A0/#444 territory.
- **`CATALOG_VERSION` untouched:** adding metadata FIELDS to existing entries breaks no older
  export. #4 adding new activity TYPES will need the bump.

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
| ~~F1~~ | **BUILT** — `skipped` edge condition + the unified `Edge` union (merges #4 A0's schema half) + success-semantics characterization tests |
| F1b | **OPEN — tests DID diverge (2 ways, both pinned): Do-If-Else "handled ⇒ success", and the eager short-circuit that makes ADF's generic-error-handling pattern unreachable.** See D5. |
| F2a | `Node.policy` schema + validation |
| F2b | reducer retry-eligibility decision (keyed off `kind`). **Fix this first:** `driver.ts`'s pump appends the PARSED event (`appendEngineEvent`) but folds the RAW one (`engine.reduce(state, event)`). Inert while nothing reads `kind` — but F2b is exactly the ticket that makes it bite: any event reaching the pump untyped would be stored `kind:'permanent'` (the parse default) while the live reducer saw `undefined`, so live and replay could disagree. Reduce the value `appendEngineEvent` parses, not its input. |
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
| F9a | ActivityDefinition contract type (+ idempotent/cancel/timeoutScope/secure/errorMap) — **MINIMAL SHIPPED 2026-07-15** (build-order item 3: "minimal contract EARLY, migrations later"). The existing `ActivityCatalogEntry` IS the ActivityDefinition; it gained `kind: 'execution'\|'control'` (the dispatch discriminant — now the executor's PRIMARY branch, checked ahead of the retained `connectionKinds.length > 0` proxy, with a distinct `CONTROL_NOT_DISPATCHABLE` code) + `category`/`ACTIVITY_CATEGORIES` (U5's palette groups, values per spec #4's headings — `agent_task` is `ai`, there is no `agent` class) + an `ActivityDefinition` alias. `cancel`/`timeoutScope`/`secure`/`errorMap`/`inputs` are deliberately NOT declared — each is sequencing behind a named owner (F2a/F3/F4/F15/F9b-d), not an open question. **Production delta is ZERO** and the reducer does not read `kind` yet: **whether A1/A2 route control via this `kind` or a structural discriminant (the `call_pipeline` precedent) is an OPEN FORK no spec settles — #4 owns it.** See the F9a spike-hardened block under D6. |
| F9b | migrate `http_request` onto it |
| F9c | migrate `llm_call` |
| F9d | migrate `agent_task` + catalog consumers |
| F10 | version audit: author + changeNote + history |
| F11 | Rerun (simple, same version) |
| RS | **sub-spec:** rerun-from-failed reseed-event + frontier semantics |
| F12a–e | rerun-from-failed (basic / reseed event / frontier algo / containers / call_pipeline) — after RS |
| **F13** | **`Node.config.outputs: OutputSpec[]` (T6)** — node-level typed output override (the home for #2's lowered structured schema + `foreach`/webhook outputs) + validation + canonicalization + `${nodes.x.status}` read. **Prerequisite — #2/#4/#6 depend on it.** |
| ~~**F14**~~ | **BUILT** (with F1) — multi-incoming-edge JOIN semantics (T7): AND across predecessors, OR among conditions on one predecessor (ADF `dependsOn`). The OR is what makes `skipped` usable: `computeReadiness` previously ANDed across every EDGE, so two conditions on one predecessor could never both satisfy and the target always skipped. `join:'any'` is unchanged by the grouping (OR distributes over OR). |
| **F15** | **`SecretRef` config-field sink (T10):** a node-config secure field carries a `SecretRef`, resolved at dispatch, never logged — a secret reaches a non-connection activity (e.g. an `http_request` auth header); `validateRefs` rejects a secure ref anywhere but a declared sink. |

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
