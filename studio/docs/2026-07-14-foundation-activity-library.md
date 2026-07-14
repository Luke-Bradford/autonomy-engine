# Foundation Spec #4 — Activity library roadmap + Monitoring depth

**Status:** proposed — brainstormed + ADF-grounded 2026-07-14; pending Codex + self review.
**Scope:** the **target activity catalog** (breadth) + a prioritized build order, all riding the
Foundation Spec #1 **Activity Definition contract**; plus the **monitoring depth** items (rerun
actions, filter pane) the operator raised. This is a **roadmap/taxonomy** spec — mechanism lives
in #1 (contract/policy/secure), #2 (AI activities); this says WHAT activities exist and WHY.
**Non-goal:** re-deriving the contract; no UI (UI epic renders the palette + monitor).

## Two activity classes (from #1 D6)

- **Control activities** — **engine-evaluated pure transitions** (no connector, no I/O, no
  retry/timeout policy; DO carry security metadata). Reducer handles them natively.
- **Execution activities** — **connector-dispatched** (I/O via a connection; support policy
  retry/timeout/secure; `idempotent` flag). Driver dispatches to a connector adapter.

## Target catalog (ADF-parity + general automation + AI)

### Control (engine-evaluated)

| type | ADF analog | Notes / status |
| --- | --- | --- |
| `set_variable` / `append_variable` | Set/Append Variable | Spec #1 F6 |
| `return` | Set-pipeline-return-value | Spec #1 F6; child→parent output |
| `if` (condition) | If Condition | branch on a `${}` boolean → **`true`/`false` business-branch edges** (NOT success/failure) |
| `switch` | Switch | branch on a `${}` value → N cases |
| `foreach` | ForEach | **NEW item-based container kind** (A4/T4) — NOT the round-based `loop`; item-iteration + aggregate output + parallelism cap |
| `until` | Until | **container exists** (loop + exitWhen) |
| `wait` | Wait | pause N seconds (driver timer → event; like retry timer in #1) |
| `fail` | Fail | force-fail with a message (error-path testing) |
| `filter` | Filter | array → filtered array via `${}` predicate |
| `execute_pipeline` | Execute Pipeline | **`call_pipeline` exists** — surface as a first-class activity |

### Execution — general / IO

| type | ADF analog | Connector | Priority |
| --- | --- | --- | --- |
| `http_request` | Web | http | **shipped** |
| `webhook` | Webhook | http (wait-for-callback) | med |
| `file_read` / `file_write` / `file_copy` / `file_move` / `file_delete` / `file_list` | (Copy, GetMetadata) | a new **`fs`/`storage` connector** (local FS first; S3/blob later via connector kinds) | **high** (the operator's "file activity, copy steps") |
| `script` / `shell` | Custom/Batch | agent-ish subprocess | med (overlaps `agent_task`) |

### Execution — AI (Spec #2)

`llm_call` (generate/extract/classify/judge/advisor) · `agent_task` (external CLI agent) ·
later: `embed`, `retrieve`/RAG (a vector connector), `classify`/`judge` as palette recipes.

### Data (heavier — later)

`copy` (source→sink datasets), `lookup`, `transform` — ADF's data-movement core. **Deferred**:
needs a dataset/linked-service abstraction we don't have; general automation + AI come first.

## Prioritized build order (A-series — activities)

Rationale: **control-flow completeness** first (real pipelines need branching/iteration), then
**file activities** (the operator's explicit ask), then breadth.

| # | Ticket |
| --- | --- |
| **A0** | **Branch/outcome model** (PREREQUISITE): named branches for condition nodes — edges gain `on:'branch', branch:'<name>'`; `if`→`true`/`false`, `switch`→named case/default. Keeps `success/failure/skipped/completion` for *operational* outcome, not business routing. **The unified `Edge` discriminated union is OWNED BY #1 (T3); A0 only IMPLEMENTS `if`/`switch` against that final schema.** |
| A1 | `if` control activity → `true`/`false` branches (`condition.evaluated` event) |
| A2 | `switch` control activity → named case/default branches (`switch.evaluated` event) |
| A3 | `until` on the existing `loop` container — document do-while semantics (expr after each round, cap-failure reason, output projection, zero-iteration) |
| A4 | **`foreach` = a NEW container kind** (item-based): `items`, `${item}` context, `batchCount`/parallel cap, deterministic per-item output aggregation + namespacing, variable rules. **Amends #1 container model.** |
| A5 | **Shared durable-wait scheduler primitive** (generalizes #1's retry timer): `timer.waitScheduled`/`timer.due` |
| A6 | `wait` (on A5) |
| A7 | `fail` (+ optional `assert`) → `node.failed` |
| A8 | `filter` — array-safe `${}` predicate (whole-expression, closed-fn, order-preserving) → `node.succeeded` outputs |
| A9 | `execute_pipeline` first-class (surface `call_pipeline`) |
| A10 | **Connection secret-model split** (public vs secret config) — prerequisite for credentialed connectors |
| A11 | local `fs` connector (non-secret config + server-side **allowlisted roots + path-traversal guard**) + `file_read`/`file_write` |
| A12 | `file_copy`/`file_move`/`file_delete`/`file_list` |
| A13 | `webhook` = **external-wait** (`externalWait.created`/`completed`/`expired`; run parks `waiting` until an inbound correlated+authed route appends completion; timeout/default path) |
| A14 | cloud storage connector kinds (S3/blob, secret-backed via A10) — later |
| A15 | `script`/`shell` (or fold into `agent_task`) |
| **A16** | **`webhook` typed-output + callback contract (Round-3, HITL):** inject a `callBackUri` + correlation token into the outbound trigger; the inbound authed/replay-protected payload is validated against a declared **`outputSchema`** → lowered to `config.outputs` so `${nodes.webhook.output.decision}` type-checks (ADF `reportStatusOnCallBack`). Unblocks human-approval + any callback-driven external system. |
| **A17** | **`until`/loop wall-clock `timeout`** (ADF parity) — a duration bound alongside the bounce-cap count, so a long human/external loop is time-bounded (consumes the #5 S1 alarm). |

Data activities (`copy`/`lookup`/`transform`) get their own spec if/when a dataset abstraction is
justified — not in this foundation set.

## Monitoring depth (the operator's monitor asks)

These extend UI-epic Monitor (U10–U12) + #1 audit; listed here so they're not lost:

- **Rerun actions** — rerun (same version) + **rerun-from-failed** (Spec #1 F11/F12 + RS
  sub-spec) exposed as Monitor buttons; "may incur cost" warning for billed activities (#2).
- **Filter pane** — ADF-style: by pipeline, status, time range, trigger, annotations/tags
  (#1 pipeline props); saved views. (UI-epic U10 tabs → concrete filters.)
- **Activity-level drill-in** — per-node input/output/error/usage/cost (#2 metering), retry
  history (#1 attempts + `node.retryScheduled` events), duration (gantt U12a).
- **Run-cost surfacing** — the #2 run-cost projection shown per run + pipeline rollup.
- **Alerts (later)** — ADF's elapsed-time metric analog (#1 pipeline `policy`); a run-exceeds-
  duration or run-failed notification. Deferred to a monitoring/alerting spec.

## How it hangs together

- Every activity here is an entry in the **#1 ActivityDefinition contract** (control vs execution
  path). The palette (UI U5) + properties panel (UI U7) read the contract; no per-activity UI code.
- Control activities lean on existing engine machinery (containers for foreach/until, `call_pipeline`
  for execute_pipeline, the #1 timer pattern for wait).
- File/storage introduces a **new connector kind** (`fs`/`storage`) — the first non-http/LLM
  connector, exercising the #1 "connection config non-secret for every kind" revisit (deferred req
  from P3) for credentialed storage (S3 keys etc.).

## Codex-hardened CORE (folded)

- **Branch model is a prerequisite (A0); the unified `Edge` union is OWNED BY #1 (T3), A0 only
  implements `if`/`switch` against it.** `if`/`switch` must NOT overload
  `success/failure` for business routing (poisons success-semantics + monitoring). Add named
  **branch** edges (`on:'branch', branch:'<name>'`); `if`→`true`/`false`, `switch`→case/default.
  Operational `success/failure/skipped/completion` stay for activity outcome. This extends #1's
  `EdgeOnSchema` — do A0 before F1's skipped work settles, and reconcile pipeline-success semantics.
- **`foreach` is a NEW container kind, not the loop.** The existing `loop` container is round-based
  over the same children (clears outputs each round, `exitWhen`) — that's `until`. `foreach` is
  **item-based**: `items` array, `${item}` context, parallel `batchCount`, deterministic per-item
  output aggregation + per-item namespacing, and #1's parallel-variable-mutation reject applies.
- **`webhook` is external-wait, NOT a timer.** `wait` = a scheduled `timer.due`. `webhook` **parks
  the run `waiting`** until an inbound, **correlated + authed + replay-protected** HTTP route
  appends `externalWait.completed` (or `expired` on timeout). Distinct suspend/resume source; both
  reuse the shared durable-wait primitive (A5) but with different event families.
- **Control activities are engine-evaluated but STILL emit durable events** — no silent projection
  mutation in `settle`. `condition.evaluated`, `switch.evaluated`, `variable.set`, `node.failed`
  (fail), `node.succeeded`+outputs (filter): the decision/output is a fact in the log before the
  downstream walk depends on it (state = fold(events)).
- **Array `${}` (filter/foreach.items) stays within the INERT model:** whole-expression predicates
  only, closed-fn allowlist, no rescanning / side-effects / wall-clock, stable ordering;
  `${item}` with save-time validation; `filter` preserves input order.
- **Storage exposes the connection-secret model immediately** — so the secret-config split (A10)
  lands **before** any credentialed connector. Local `fs` is allowed earlier only if scoped to
  non-secret config + **server-side allowlisted roots + path-traversal guard**.

## Non-goals

- No dataset/linked-service data-movement abstraction (defer `copy`/`lookup`/`transform`).
- No alerting/notification system here (own spec). No UI.

## Open questions (for Codex / review)

1. `foreach`/`until` — extend the existing loop **container**, or add distinct control activities?
   (Leaning: formalize on the container — reuse the proven walk.)
2. `wait`/`webhook` timers — reuse the #1 driver-timer→event pattern (same as retry) — confirm one
   mechanism, not three.
3. File/storage connector: local-FS-only in v1 (self-host) with S3/blob as later connector kinds,
   or design the storage abstraction up-front?
4. `script`/`shell` vs `agent_task` — one subprocess activity or two?
