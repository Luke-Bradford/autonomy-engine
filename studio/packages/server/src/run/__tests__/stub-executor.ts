import type { EngineEvent, FailureKind } from '@autonomy-studio/shared';
import type { Executor, ExecutorCommand } from '../driver.js';

/** How the stub should resolve a dispatched node. */
export interface NodePlan {
  outcome?: 'success' | 'failure';
  outputs?: Record<string, unknown>;
  error?: string;
  /** The `node.failed.kind` for a `failure` outcome (#1 F0). Default `permanent`. */
  kind?: FailureKind;
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
 * A deterministic STUB executor for driver/reconciler tests. It STREAMS the
 * events the real P3 executor would produce: a `dispatchNode` yields
 * `node.dispatched` then a terminal `node.succeeded`/`node.failed` (or only
 * `node.dispatched` when the plan says `hang`), and a `startChild` yields a
 * `call.returned` (or nothing when the child hangs). Being an async generator,
 * it honours the crash-safety ordering the driver relies on — `node.dispatched`
 * is yielded (and so folded/durable) before any terminal — the same shape the
 * real executor uses. It performs no real work, so the reduce↔persist loop can
 * be exercised end-to-end against a real DB.
 */
export function makeStubExecutor(opts: StubExecutorOptions = {}): RecordingExecutor {
  const dispatched: string[] = [];
  const startedChildren: string[] = [];

  return {
    dispatched,
    startedChildren,
    async *perform(command: ExecutorCommand, runId: string): AsyncGenerator<EngineEvent> {
      if (command.type === 'dispatchNode') {
        dispatched.push(command.attemptId);
        const plan = opts.nodes?.[command.nodeId] ?? {};
        yield {
          type: 'node.dispatched',
          runId,
          nodeId: command.nodeId,
          attemptId: command.attemptId,
          idempotent: plan.idempotent ?? true,
        };
        if (plan.hang === true) return;
        yield (plan.outcome ?? 'success') === 'success'
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
              // #1 F0: `permanent` mirrors the parse default, so driver/reconcile
              // cases assert the same behaviour they did pre-F0.
              kind: plan.kind ?? 'permanent',
            };
        return;
      }

      // startChild
      startedChildren.push(command.attemptId);
      if (opts.child?.hang === true) return;
      yield {
        type: 'call.returned',
        runId,
        callNodeId: command.callNodeId,
        attemptId: command.attemptId,
        childRunId: command.childRunId,
        childOutcome: opts.child?.childOutcome ?? 'success',
        outputs: opts.child?.outputs ?? {},
      };
    },
  };
}
