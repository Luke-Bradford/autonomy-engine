# autonomy-studio — target architecture (v1)

_Working name `autonomy-studio` (PROVISIONAL — operator to rename). 2026-07-12.
v1 folds a Codex pass + an independent architect review. `../autonomy-engine` is
the PROTOTYPE and SPEC SOURCE, not code to reuse — its bash/python is thrown
away; its hard-won model semantics are mined here as requirements._

## Vision

An **ADF-style automation harness for AI work.** Plug in your own LLM/AI API keys
or subscriptions as the **workers** (connectors); build **pipelines** (node
graphs of activities) on a canvas; attach **triggers** that decide _when / how /
with which parameters_ a pipeline runs. General-purpose — automate **anything**
agentic, not just coding. A polished app anyone can self-host.

## North star — non-negotiable

1. **Config-driven everything.** Connectors, pipelines, triggers, activities are
   DATA (rows), created/edited in the app. No hardcoded roles, repos, providers,
   or flows.
2. **Open source, zero paid dependencies.** Permissive license; every lib
   permissively licensed; no paid SaaS in the critical path; users bring their
   OWN keys/subscriptions.
3. **Anyone can run it.** Cross-platform, self-hostable, near-zero-config
   (embedded DB). **`docker run` is the guaranteed path**; a single binary is a
   later best-effort spike.
4. **General-purpose.** Coding is ONE pipeline, not the product.
5. **Author + monitor.** Canvas-first authoring; the live "what's running"
   monitor stays as one surface among several.
6. **Local-first & private.** Loopback by default; keys never leave the host; no
   telemetry.

## Stack (locked, v1)

TypeScript end-to-end, **Node runtime for dev AND ship** (no Node/Bun split).

| Layer       | Choice                                                                                                     | Notes                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Canvas UI   | **React + React Flow** (`@xyflow/react`, MIT)                                                              | drag/drop/resize, edges, minimap, pan/zoom, custom nodes + property panel             |
| UI state    | **zustand**                                                                                                | run-overlay store kept SEPARATE from graph structure (never run-state in `node.data`) |
| App shell   | React + Vite + shadcn/Radix (MIT)                                                                          | dropdowns, click-throughs, resizable panels                                           |
| Backend     | **Node + TypeScript, Fastify**                                                                             | complexity lives in the engine, not HTTP; no Nest DI/reflect tax                      |
| Validation  | **Zod**                                                                                                    | one schema → runtime validation + inferred types, shared FE/BE                        |
| ORM / DB    | **Drizzle + better-sqlite3** (WAL, single write-serializing conn); Postgres-optional via a repository seam | no engine sidecar binary; embedded, zero-config                                       |
| Scheduler   | in-process + **`croner`** (MIT, DST-aware); DB-backed durable runs                                         | no Redis/BullMQ (would break zero-infra self-host)                                    |
| Concurrency | **`p-limit`** semaphores (per-trigger + global)                                                            | I/O-bound work — no `worker_threads`                                                  |
| Agent CLIs  | **`execa`** + process-group kill (POSIX `detached`+`kill(-pid)`, Windows `taskkill /T /F`)                 | prefer non-interactive `-p` modes; avoid `node-pty` (native, fights single-binary)    |
| Secrets     | **`libsodium-wrappers`** (WASM, no native addon), XChaCha20-Poly1305                                       | encrypted-file PRIMARY; keychain opportunistic via shell-out                          |
| AI SDKs     | official `@anthropic-ai/sdk`, `openai`, Ollama client                                                      | connectors                                                                            |
| Live        | WebSocket, topic-subscribed (per-run), debounced ~100ms, DB-replayable                                     | monitoring feed                                                                       |
| Dist        | **Docker (primary)**; Bun single-binary spike later                                                        |                                                                                       |

Monorepo (**pnpm workspaces only**): `packages/shared` (Zod schemas + types),
`packages/server` (Fastify + engine + Drizzle + scheduler + workers),
`packages/web` (React app), `packages/cli` (headless run / self-host entry).

## Core data model (config objects, all in SQLite, all app-editable, JSON-portable)

- **Connection** — a named worker binding. `{id, ownerId?, name, kind, config,
secretRef?}`. `kind ∈ {anthropic_api, openai_api, ollama, agent_cli, http}`.
  ADF Linked-Service analog. Secrets referenced, never inlined.
- **Pipeline** — reusable template, **versioned**. `{id, ownerId?, name}` with
  immutable **PipelineVersion** rows `{pipelineId, version, params[], outputs[],
nodes[], edges[], catalogVersion}`. Runs/triggers bind a **specific immutable
  version**, never "latest".
- **Node (activity instance)** — `{id, type, config, connectionId?, position}`;
  `type` from the Activity Catalog; `config` = typed activity settings.
- **Edge** — `{from, to, on: success|failure|completion, back?, maxBounces?}`.
- **Trigger** — first-class; binds ONE pipeline version + param VALUES + firing
  mode + concurrency. `{id, ownerId?, name, pipelineVersionId, params, mode,
schedule?, webhook?, concurrency, runWindows?, enabled}`.
  `mode ∈ {manual, schedule, webhook, event, continuous}`. Many triggers → one
  pipeline. "Assign" = create a trigger. Pause/stop/backoff live on the trigger.
  Webhook triggers carry a per-trigger secret + idempotency-key handling +
  replay protection.
- **Run** — one execution (see Run model). `{id, ownerId?, pipelineVersionId,
triggerId?, parentRunId?, params, status, startedAt, finishedAt}`.
- **run_events** — append-only event log per run (the source of truth for run
  state + the monitoring feed). Materialized run/node state derived from it.
- **Secret** — `{id, ref, ciphertext}` (encrypted at rest); never returned to the
  client, never logged, never in argv.

Every config object exports as **version-stamped JSON** (`catalogVersion`,
`schemaVersion`); import runs a validate/upgrade path — a pipeline authored on an
older activity-catalog still loads.

## Run & execution model (the spine — event-sourced)

Purity + durability + live streaming reconcile via an explicit boundary:

- **Engine = pure reducer:** `(runState, event) → (nextState, commands[])`. No
  I/O. Deterministic. Unit-tested against the mined edge cases.
- **Executor** performs `commands` (run node X via its connector), streams
  progress, and feeds **events** back (`node.started`, `node.output`,
  `node.succeeded/failed`, `run.finished`).
- **Events persist** to `run_events` (append-only) BEFORE/with side effects;
  run/node state is a materialized projection. The monitoring WS is just a live
  tail of `run_events`; late-joiners replay from the DB.
- **Durability / recovery:** runs/nodes carry `status + leaseUntil + heartbeat`.
  On boot, reconcile: any `running` row could not have survived a restart →
  apply the per-activity **resume policy**: idempotent activity → re-run;
  non-idempotent (LLM call already billed, agent subprocess) → mark
  `interrupted` / needs-attention. **`agent_cli` runs do NOT survive a server
  bounce — documented contract, not implied resume.**
- **Concurrency:** `p-limit` semaphores per-trigger and global; one dispatch per
  tick fairness (mined). Agent stdout is BOUNDED and streamed to disk — never
  buffered unbounded into the event loop.

## Mined model semantics (carry verbatim — the crown jewels)

Re-implemented in TS, re-tested against the prototype's cases:

- **Parameter language.** `${params.x}`, `${nodes.<id>.output.<name>}`,
  `${run.<field>}` + a CLOSED pure-function allowlist (`default`, `concat`,
  `slug`, …) — NO eval, type-checked, secrets-last. Values are **INERT**: a
  single substitution pass that NEVER rescans replacements (the no-injection
  property). Static ref-validation at save time (declared params only, upstream
  node-output refs only, arity-checked). **Validation errors surface in the UI as
  node badges + property-panel messages.**
- **Precedence.** pipeline default < trigger/caller override (same slot);
  required-unset → refuse.
- **Typed params/outputs.** validated at edit time + run start; unknown keys
  refused.
- **Walk.** typed edges success/failure/completion; `join: all|any`; skip
  propagation; traversal-only back-edges with enforced bounce caps; container
  (loop/stage) outcomes; unhandled failure fails the run.
- **`call_pipeline`** — child run + parent link; typed child outputs flow back;
  depth-bounded; cycle-refused; failed child still returns projected outputs.
- **Trust.** per-trigger ledger → tier (`watch|auto`) from a windowed pass-rate;
  pipeline rollup = floor over its triggers; gates auto-actions.
- **Run windows.** `[{start,end,days?}]` UTC, wrap-past-midnight, fail-CLOSED;
  blocks NEW starts while in-flight runs finish.
- **Fail-safe posture.** ambiguous/garbage config → the SAFE side; unreadable
  state never reads healthy; secrets refused end-to-end, never echoed.

## Connector model (the heart) + adapter contract

A **Connection** is how the app calls a worker; every AI activity binds one (or
inherits a pipeline/trigger default). A connector kind is a **plugin**:

```
interface ConnectorAdapter {
  kind: string;
  configSchema: ZodSchema;                 // non-secret config
  testConnection(cfg, secret): Promise<Result>;
  runActivity(ctx): AsyncIterable<ActivityEvent>;   // streaming, cancellable
}
```

Contract details (mined + review): a `cancel` token aborts in-flight work; a
defined **error taxonomy** (auth / rate-limit / transient / permanent /
cancelled) drives retry vs fail edges; the **secret-resolution boundary** is the
executor (secrets fetched just-in-time, passed to the adapter, never logged, never
in `ctx` that reaches the DB/UI). MVP kinds: `anthropic_api`, `openai_api`,
`ollama`, `agent_cli` (subprocess supervisor), `http`. New provider = new adapter,
no core change.

## Activity catalog (general-purpose, extensible)

`{type, configSchema (Zod), inputs, outputs, run(ctx)}`. MVP set: **LLM call** ·
**Agent task** (spawn an `agent_cli`) · **HTTP request** · **Branch/condition** ·
**Sub-pipeline** (`call_pipeline`). Post-MVP: code/shell (sandboxed, opt-in —
where "coding" lives), transform/map, loop/for-each, wait, notify,
human-in-the-loop, file I/O. The catalog is the extensibility surface.

## Architecture

```
web (React + React Flow + zustand)  ──HTTP/WS──►  server (Fastify)
                                                    ├─ auth middleware → principal (single 'local' owner in MVP)
                                                    ├─ REST (CRUD: connections/pipelines/triggers/runs)
                                                    ├─ engine (PURE reducer: state,event→state,commands)
                                                    ├─ executor (runs commands, streams, emits events)
                                                    ├─ scheduler (croner + run-windows + continuous) + trigger dispatch
                                                    ├─ p-limit worker pool (activity exec, caps, cancellation)
                                                    ├─ connector adapters (anthropic/openai/ollama/agent_cli/http)
                                                    ├─ run_events (append log) ──WS tail──► monitoring
                                                    └─ Drizzle → SQLite (WAL, single writer) | Postgres seam
                                                 secrets ──► encrypted file (libsodium WASM) | keychain shell-out
```

## Security

- **Secrets: encrypted-file PRIMARY** (XChaCha20-Poly1305 via `libsodium-wrappers`).
  Master-key resolution: `AUTONOMY_MASTER_KEY` env → mounted key file (0600) →
  generate-with-loud-warning (backup/rotation documented). **Threat model stated
  explicitly:** encryption protects the volume at rest, NOT against host
  compromise. No silent plaintext fallback. Keychain (macOS `security`, Linux
  `secret-tool`, Windows cred manager) is an opportunistic shell-out, never a
  native addon.
- Secrets never in DB plaintext / client responses / logs / argv; refused through
  the param language end-to-end (mined).
- Loopback by default; network exposure is an explicit authenticated opt-in.
- `code/shell` activity is sandboxed + opt-in (highest-risk).
- **Auth seam from day one:** one auth middleware yields a `principal`; nullable
  `ownerId` on Connection/Pipeline/Trigger/Run. MVP = a fixed `local` owner;
  multi-user later = middleware swap + WHERE-clause enforcement, not a migration.

## Resolved decisions (was "open")

1. Backend: **Fastify**. 2. ORM: **Drizzle + better-sqlite3** (Postgres via repo
   seam). 3. Scheduler: **in-process + `croner`, DB-durable runs + boot reconciler**
   (no Redis). 4. Agent CLIs: **`execa` process-supervisor** (line-framed events,
   stdin-close, hard timeout, cancellation, tree-kill; avoid PTY). 5. Secrets:
   **encrypted-file primary (libsodium WASM) + master-key env/file/generate**;
   keychain opportunistic. 6. Monorepo: **pnpm workspaces only**. 7. Auth:
   **principal middleware + `ownerId` columns from day one**, single local owner in
   MVP.

## Phased build (→ tickets)

- **P0 — Scaffold + de-risk spikes.** pnpm monorepo (`shared/server/web/cli`),
  Fastify hello, Vite React hello, Drizzle+SQLite migration runner, Zod-shared
  types, CI (typecheck+test+lint), Dockerfile. **Two spikes that de-risk the
  hardest bets:** (a) an `agent_cli` end-to-end (spawn Claude Code `-p`,
  line-framed events, tree-kill, prove "no survive restart"); (b) libsodium
  encrypt/decrypt round-trip + master-key resolution.
- **P1 — Data + API + secrets.** Zod schemas + Drizzle tables (Connection/
  Pipeline+Version/Trigger/Run/run_events, `ownerId` columns); REST CRUD;
  secrets store (encrypted-file + keychain shell-out); connection test;
  version-stamped JSON export/import + upgrade path.
- **P2 — Run model + engine.** `run_events` event-sourced store; the PURE engine
  reducer (param language + walk + edges/join/skip + typed params/outputs) ported
  from the mined semantics with a test suite mirroring the prototype's edge
  cases; boot reconciler + resume policy.
- **P3 — Executor + connectors.** worker pool (`p-limit`) + adapter contract +
  MVP adapters (anthropic/openai/ollama/agent_cli/http); activity catalog MVP;
  event streaming; bounded stdout.
- **P4 — Scheduler + triggers.** manual fire, `croner` schedule, run-windows,
  concurrency policies, webhooks (secret + idempotency); trust ledger.
- **P5 — Web: authoring.** React Flow editor (nodes/edges/property-panel/minimap,
  zustand, memoized nodes, `onlyRenderVisibleElements`, validation badges),
  versioned save; Connections page; Triggers page.
- **P6 — Web: monitoring.** live run view over WS (topic-subscribed, DB-replay);
  run history; node output inspection; run-overlay store separate from graph.
- **P7 — Package + OSS.** Docker (primary) + single-binary spike; README/vision/
  quickstart; LICENSE (MIT/Apache-2.0) + zero-paid-dep audit; example pipelines;
  contribution guide.

Each phase = spec→plan→build→(codex + subagent review)→merge, review gate
delegated per operator instruction.
