import type { ConnectionKind } from '@autonomy-studio/shared';
import type { ConnectorAdapter } from './types.js';
import { httpAdapter } from './http.js';

/** A lookup of connector adapters by Connection kind. */
export type ConnectorRegistry = ReadonlyMap<ConnectionKind, ConnectorAdapter>;

/**
 * Build the connector registry. P3a ships ONLY the `http` adapter; the
 * `anthropic_api` / `openai_api` / `ollama` / `agent_cli` adapters arrive in
 * P3b. A run that dispatches an activity whose Connection kind has no adapter
 * fails that node LOUDLY at the executor ("no adapter for connection kind …"),
 * never a silent hang.
 */
export function createConnectorRegistry(): ConnectorRegistry {
  return new Map<ConnectionKind, ConnectorAdapter>([[httpAdapter.kind, httpAdapter]]);
}
