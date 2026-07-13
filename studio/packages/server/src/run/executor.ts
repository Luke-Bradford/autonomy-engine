import pLimit from 'p-limit';
import {
  catalog as sharedCatalog,
  type ActivityCatalog,
  type EngineEvent,
  type Node,
} from '@autonomy-studio/shared';
import { getRun } from '../repo/runs.js';
import { getConnection } from '../repo/connections.js';
import { getSecretByRef } from '../repo/secrets.js';
import { decrypt } from '../secrets/secrets.js';
import type { Db } from '../repo/types.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { ActivityContext, ConnectorAdapter } from '../connectors/types.js';
import type { DocResolver, Executor, ExecutorCommand } from './driver.js';

/**
 * P3 — the REAL executor: the connector-facing half of the run engine's impure
 * boundary. The driver sequences reduce↔persist; THIS turns a `dispatchNode`
 * command into an actual activity run via its connector adapter, streaming the
 * durable engine events back. It is the sole place a plaintext secret is
 * resolved (fetched + decrypted just-in-time) and handed to an adapter — never
 * into a persisted event, `preparedInput`, or `ActivityContext`.
 *
 * CRASH-SAFETY (the load-bearing ordering — see the `Executor` doc in
 * `driver.ts`): everything that is a PURE READ (resolve the node from the doc,
 * catalog lookup, resolve the connection, fetch + decrypt the secret, pick the
 * adapter) runs BEFORE `node.dispatched` is yielded, so a pre-flight failure
 * fails the node while it is still `ready` (no idempotent record, cleanly
 * re-dispatchable on resume). `node.dispatched{idempotent}` is yielded — and so
 * folded/durable — ONLY immediately before the adapter's side effect. A crash
 * after that always leaves the node `dispatched` (recovered per the persisted
 * idempotent flag), never `ready`. The executor maps EVERY adapter failure to a
 * terminal `node.failed`; it does not throw for expected errors.
 *
 * CONCURRENCY: one shared `p-limit(concurrency)` caps ADAPTER runs across all
 * concurrently-driven runs (P4's scheduler). It wraps only the side effect —
 * `node.dispatched` is not gated (it is cheap + must be durable first). Within a
 * single run the driver's `pump` is sequential; the cap bites across runs.
 */
export interface ExecutorDeps {
  db: Db;
  /** The secret-encryption master key (for just-in-time secret decrypt). */
  masterKey: Uint8Array;
  /** Resolve a run's immutable pipeline version (for the node's type/connection). */
  resolveDoc: DocResolver;
  /** Connector adapters by Connection kind. */
  adapters: ConnectorRegistry;
  /** Activity catalog (defaults to the shared MVP catalog). */
  catalog?: ActivityCatalog;
  /** Global worker-pool cap on concurrent ADAPTER runs. Default 4. */
  concurrency?: number;
}

/** A terminal `node.failed` for `nodeId`/`attemptId` (before OR after dispatch). */
function nodeFailed(runId: string, nodeId: string, attemptId: string, error: string): EngineEvent {
  return { type: 'node.failed', runId, nodeId, attemptId, error };
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const limit = pLimit(deps.concurrency ?? 4);
  const catalog = deps.catalog ?? sharedCatalog;

  /** Resolve the node object for a dispatch command from the run's doc. */
  function resolveNode(runId: string, nodeId: string): Node | null {
    const run = getRun(deps.db, runId);
    if (run === null) return null;
    const pv = deps.resolveDoc(run.pipelineVersionId);
    return pv.nodes.find((n) => n.id === nodeId) ?? null;
  }

  /**
   * Resolve the adapter + plaintext secret + connection config for a node whose
   * activity requires a connection. Returns an error STRING (→ `node.failed`)
   * or the resolved bundle. All pure reads — safe to run before `node.dispatched`.
   */
  async function resolveConnection(
    node: Node,
    kinds: readonly string[],
    activityType: string,
  ): Promise<
    | { error: string }
    | {
        adapter: ConnectorAdapter;
        secret: string | null;
        connectionConfig: Record<string, unknown>;
      }
  > {
    if (node.connectionId === undefined) {
      return { error: `activity '${activityType}' requires a connection but the node has none` };
    }
    const connection = getConnection(deps.db, node.connectionId);
    if (connection === null) {
      return { error: `connection '${node.connectionId}' not found` };
    }
    if (!kinds.includes(connection.kind)) {
      return {
        error: `connection kind '${connection.kind}' is not valid for activity '${activityType}' (expected: ${kinds.join(', ')})`,
      };
    }
    const adapter = deps.adapters.get(connection.kind);
    if (adapter === undefined) {
      return { error: `no adapter for connection kind '${connection.kind}'` };
    }
    let secret: string | null = null;
    if (connection.secretRef !== null) {
      const secretRow = getSecretByRef(deps.db, connection.secretRef);
      if (secretRow === null) {
        return { error: `secret '${connection.secretRef}' not found` };
      }
      try {
        secret = await decrypt(secretRow.ciphertext, deps.masterKey);
      } catch {
        // NEVER echo the underlying decrypt error (could leak ciphertext/key detail).
        return { error: `secret '${connection.secretRef}' could not be decrypted` };
      }
    }
    return { adapter, secret, connectionConfig: connection.config };
  }

  /**
   * Consume an adapter's `ActivityEvent` stream (INSIDE the worker-pool limit)
   * and map it to the terminal + observability engine events. Any throw, or a
   * stream that ends without a terminal, becomes a `node.failed` — one bad node
   * fails its node, never the whole pump.
   */
  async function runAdapter(
    adapter: ConnectorAdapter,
    ctx: ActivityContext,
    secret: string | null,
    controller: AbortController,
    runId: string,
    nodeId: string,
    attemptId: string,
  ): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    try {
      for await (const ev of adapter.runActivity(ctx, secret)) {
        if (ev.type === 'output') {
          events.push({ type: 'node.output', runId, nodeId, name: ev.name, value: ev.value });
        } else if (ev.type === 'succeeded') {
          events.push({ type: 'node.succeeded', runId, nodeId, attemptId, outputs: ev.outputs });
          return events;
        } else {
          events.push(nodeFailed(runId, nodeId, attemptId, `${ev.kind}: ${ev.error}`));
          return events;
        }
      }
      // Stream ended with no terminal — an adapter contract violation.
      events.push(nodeFailed(runId, nodeId, attemptId, 'adapter produced no terminal event'));
      return events;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      events.push(nodeFailed(runId, nodeId, attemptId, message));
      return events;
    } finally {
      controller.abort();
    }
  }

  async function* performDispatch(
    command: Extract<ExecutorCommand, { type: 'dispatchNode' }>,
    runId: string,
  ): AsyncGenerator<EngineEvent> {
    const { nodeId, attemptId } = command;

    // --- pre-flight (pure reads; node stays `ready` on any failure here) ------
    const node = resolveNode(runId, nodeId);
    if (node === null) {
      yield nodeFailed(runId, nodeId, attemptId, `node '${nodeId}' not found in the run's doc`);
      return;
    }
    const entry = catalog.get(node.type);
    if (entry === undefined) {
      yield nodeFailed(runId, nodeId, attemptId, `unknown activity type '${node.type}'`);
      return;
    }

    let adapter: ConnectorAdapter;
    let secret: string | null;
    let connectionConfig: Record<string, unknown>;
    if (entry.connectionKinds.length > 0) {
      const resolved = await resolveConnection(node, entry.connectionKinds, node.type);
      if ('error' in resolved) {
        yield nodeFailed(runId, nodeId, attemptId, resolved.error);
        return;
      }
      ({ adapter, secret, connectionConfig } = resolved);
    } else {
      // No MVP activity is connection-less; a future built-in runner would go
      // here. Fail loud rather than silently no-op.
      yield nodeFailed(runId, nodeId, attemptId, `activity '${node.type}' has no executor`);
      return;
    }

    // --- the side effect (node.dispatched durable FIRST, then the adapter) ----
    yield {
      type: 'node.dispatched',
      runId,
      nodeId,
      attemptId,
      idempotent: entry.idempotent,
    };

    const controller = new AbortController();
    const ctx: ActivityContext = {
      runId,
      nodeId,
      attemptId,
      input: command.preparedInput,
      connectionConfig,
      signal: controller.signal,
    };
    const events = await limit(() =>
      runAdapter(adapter, ctx, secret, controller, runId, nodeId, attemptId),
    );
    for (const ev of events) yield ev;
  }

  return {
    async *perform(command: ExecutorCommand, runId: string): AsyncGenerator<EngineEvent> {
      if (command.type === 'startChild') {
        // P3a defers `call_pipeline` (sub-pipeline) EXECUTION to P3b. Yield a
        // loud `call.returned{failure}` — NOT a throw and NOT a hang: throwing
        // would leave the node `waiting`, and the boot reconciler re-emits
        // `startChild` for a `waiting` call node, so a throwing executor would
        // make boot reconcile itself throw on every restart. A failure result
        // terminalizes the call node (its unhandled failure fails the run),
        // leaving no `waiting` node behind. `childRunId` is echoed so the
        // reducer's deterministic-child-id identity check passes.
        yield {
          type: 'call.returned',
          runId,
          callNodeId: command.callNodeId,
          attemptId: command.attemptId,
          childRunId: command.childRunId,
          childOutcome: 'failure',
          outputs: {},
        };
        return;
      }
      yield* performDispatch(command, runId);
    },
  };
}
