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
| `if` (condition) | If Condition | branch on a `${}` boolean → success/failure edges |
| `switch` | Switch | branch on a `${}` value → N cases |
| `foreach` | ForEach | **container exists** (loop) — formalize item-iteration + parallelism cap |
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
| A1 | `if`/condition control activity (+ boolean `${}` eval) |
| A2 | `switch` control activity (N cases) |
| A3 | `foreach` — formalize item-iteration on the loop container (+ parallel cap, #1 var-reject) |
| A4 | `until` — formalize on the loop container (exitWhen already exists) |
| A5 | `wait` (driver timer → event) |
| A6 | `fail` + `filter` |
| A7 | `execute_pipeline` first-class activity (surface `call_pipeline`) |
| A8 | `fs`/storage connector kind + `file_read`/`file_write` |
| A9 | `file_copy`/`file_move`/`file_delete`/`file_list` |
| A10 | `webhook` (wait-for-callback) |
| A11 | `script`/`shell` (or fold into `agent_task`) |

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
