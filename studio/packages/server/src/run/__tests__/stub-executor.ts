import type { EngineEvent } from '@autonomy-studio/shared';
import type { Executor, ExecutorCommand } from '../driver.js';

/** How the stub should resolve a dispatched node. */
export interface NodePlan {
  outcome?: 'success' | 'failure';
  outputs?: Record<string, unknown>;
  error?: string;
  /** Persisted into `node.dispatched.idempotent` (default `true`). */
  idempotent?: boolean;
  /**
   * Simulate a CRASH mid-dispatch: emit only `node.dispatched` and no terminal
   * event, so the run comes to rest with the node still `dispatched` (exactly
   * the state the boot reconciler must recover). Default `false`.
   */
  hang?: boolean;
}

/** How the stub should resolve a `startChild` (a `call_pipeline` child). */
export interface ChildPlan {
  childOutcome?: 'success' | 'failure';
  outputs?: Record<string, unknown>;
  /** Simulate a crash after `startChild` but before the child returned. */
  hang?: boolean;
}

export interface StubExecutorOptions {
  nodes?: Record<string, NodePlan>;
  child?: ChildPlan;
}

export interface RecordingExecutor extends Executor {
  /** Every `dispatchNode` the driver handed us, as `nodeId#attempt`. */
  readonly dispatched: string[];
  /** Every `startChild` we saw, as `callNodeId#attempt`. */
  readonly startedChildren: string[];
}

/**
 * A synchronous, deterministic STUB executor for P2 tests. It turns a
 * `dispatchNode` into `[node.dispatched, node.succeeded|node.failed]` (or just
 * `[node.dispatched]` when the plan says `hang`), and a `startChild` into
 * `[call.returned]`. It performs no real work — it only fabricates the events
 * the real P3 executor would produce, so the driver's reduce↔persist loop can
 * be exercised end-to-end against a real DB.
 */
export function makeStubExecutor(opts: StubExecutorOptions = {}): RecordingExecutor {
  const dispatched: string[] = [];
  const startedChildren: string[] = [];

  return {
    dispatched,
    startedChildren,
    perform(command: ExecutorCommand, runId: string): EngineEvent[] {
      if (command.type === 'dispatchNode') {
        dispatched.push(command.attemptId);
        const plan = opts.nodes?.[command.nodeId] ?? {};
        const dispatch: EngineEvent = {
          type: 'node.dispatched',
          runId,
          nodeId: command.nodeId,
          attemptId: command.attemptId,
          idempotent: plan.idempotent ?? true,
        };
        if (plan.hang === true) return [dispatch];
        const terminal: EngineEvent =
          (plan.outcome ?? 'success') === 'success'
            ? {
                type: 'node.succeeded',
                runId,
                nodeId: command.nodeId,
                attemptId: command.attemptId,
                outputs: plan.outputs ?? {},
              }
            : {
                type: 'node.failed',
                runId,
                nodeId: command.nodeId,
                attemptId: command.attemptId,
                error: plan.error ?? 'boom',
              };
        return [dispatch, terminal];
      }

      // startChild
      startedChildren.push(command.attemptId);
      if (opts.child?.hang === true) return [];
      return [
        {
          type: 'call.returned',
          runId,
          callNodeId: command.callNodeId,
          attemptId: command.attemptId,
          childRunId: command.childRunId,
          childOutcome: opts.child?.childOutcome ?? 'success',
          outputs: opts.child?.outputs ?? {},
        },
      ];
    },
  };
}
