# Backlog — autonomy-studio

Phased build of the ADF-style AI automation harness. Each phase = its own
spec→plan→build→(codex + subagent review)→merge. Source of truth for the
architecture: `docs/2026-07-12-target-architecture.md` (v1).

> **Board note:** no GitHub remote yet. These become GitHub issues once the
> operator confirms repo name + visibility (see "Open operator items"). Until
> then this file IS the board.

## Phases

- **P0 — Scaffold + de-risk spikes**
  - P0a: pnpm monorepo (`shared/server/web/cli`), Fastify hello, Vite React
    hello, Drizzle+SQLite migration runner, Zod shared types, CI
    (typecheck/test/lint), Dockerfile. Runnable skeleton (`pnpm dev` serves both).
  - P0b (spike): `agent_cli` end-to-end — spawn Claude Code `-p`, line-framed
    stdout events, process-group tree-kill, prove "no survive restart".
  - P0c (spike): libsodium-wrappers encrypt/decrypt round-trip + master-key
    resolution (`env → file → generate-warn`).
- **P1 — Data + API + secrets.** Drizzle tables (Connection, Pipeline +
  immutable PipelineVersion, Trigger, Run, run_events; `ownerId` columns) +
  Zod schemas in `shared`; REST CRUD; encrypted-file secret store + keychain
  shell-out; connection test; version-stamped JSON export/import + upgrade path;
  auth middleware → fixed `local` principal.
- **P2 — Run model + engine.** `run_events` event-sourced store; PURE engine
  reducer (param language, walk, edges/join/skip, typed params/outputs) ported
  from the mined semantics; test suite mirroring the prototype's edge cases;
  boot reconciler + per-activity resume policy.
- **P3 — Executor + connectors.** `p-limit` worker pool; `ConnectorAdapter`
  contract; MVP adapters (anthropic_api, openai_api, ollama, agent_cli, http);
  activity catalog MVP (LLM call, agent task, HTTP, branch, sub-pipeline);
  bounded stdout; event streaming.
- **P4 — Scheduler + triggers.** manual fire, `croner` schedule, run-windows,
  concurrency policies (queue1 / skip-if-running / parallel-N), webhooks
  (per-trigger secret + idempotency + replay protection); trust ledger.
- **P5 — Web: authoring.** React Flow editor (nodes/edges/property-panel/
  minimap; zustand; memoized nodes; `onlyRenderVisibleElements`; save-time
  validation badges); versioned save; Connections page; Triggers page.
- **P6 — Web: monitoring.** live run view over WS (per-run topic subscribe,
  debounced, DB-replayable); run history; node output inspection; run-overlay
  store kept separate from graph structure.
- **P7 — Package + OSS.** Docker (primary) + single-binary spike; README /
  vision / quickstart; LICENSE + zero-paid-dep audit; example pipelines;
  contribution guide.

## MVP "usable" bar (subset across P0–P6)

Add a Connection → build a pipeline on the canvas → create a trigger → fire it →
watch it run live. No coding required; coding is just one activity you can add.

## Cross-cutting requirements (apply to every phase)

- Config-driven, no hardcoding; every object app-editable + JSON-portable.
- Open source, zero paid deps; users bring their own keys.
- Fail-safe: ambiguous/garbage → safe side; secrets refused end-to-end, never
  logged/echoed; agent_cli runs don't survive a restart (documented).
- Immutable pipeline-version binding for runs/triggers.

## Open operator items

1. **Repo name** — `autonomy-studio` is provisional. Rename before the GitHub
   remote is created.
2. **GitHub remote + board** — new repo (issues live there) vs. tracking on the
   existing `autonomy-engine` project. Visibility public/private.
3. **License** — MIT vs Apache-2.0.
