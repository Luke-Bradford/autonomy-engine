import type { ConnectionKind } from '@autonomy-studio/shared';
import type { ConnectorAdapter } from './types.js';
import type { Supervisor } from '../workers/process-supervisor.js';
import { httpAdapter } from './http.js';
import { fsAdapter } from './fs.js';
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';
import { ollamaAdapter } from './ollama.js';
import { createAgentAdapter } from './agent.js';
import { sqliteAdapter } from './sqlite.js';
import { postgresAdapter } from './postgres.js';

/** A lookup of connector adapters by Connection kind. */
export type ConnectorRegistry = ReadonlyMap<ConnectionKind, ConnectorAdapter>;

/** What `createConnectorRegistry` needs injected — the per-app `Supervisor` the
 * `agent_cli` adapter spawns subprocesses through (its `reapAllSupervised()` is
 * wired into the host's graceful shutdown). */
export interface ConnectorRegistryDeps {
  supervisor: Supervisor;
}

/**
 * Build the connector registry with an adapter for every Connection kind
 * (`http`, `anthropic_api`, `openai_api`, `ollama`, `agent_cli`, the #4 A11 local
 * `fs` connector and the two STORE connectors: #1119 M4's `sqlite` and #1189 M10's
 * `postgres`). A run that dispatches an activity whose Connection
 * kind has no adapter still fails that node LOUDLY at the executor ("no adapter
 * for connection kind …"), never a silent hang.
 */
export function createConnectorRegistry(deps: ConnectorRegistryDeps): ConnectorRegistry {
  const adapters: ConnectorAdapter[] = [
    httpAdapter,
    fsAdapter,
    anthropicAdapter,
    openaiAdapter,
    ollamaAdapter,
    createAgentAdapter(deps.supervisor),
    sqliteAdapter,
    postgresAdapter,
  ];
  return new Map<ConnectionKind, ConnectorAdapter>(adapters.map((a) => [a.kind, a]));
}
