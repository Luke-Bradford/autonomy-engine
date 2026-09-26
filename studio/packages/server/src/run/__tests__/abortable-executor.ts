import type { EngineEvent } from '@autonomy-studio/shared';
import type { Executor, ExecutorCommand } from '../driver.js';

export interface AbortableExecutor extends Executor {
  /** Node ids whose attempt reached the executor, in order. */
  readonly dispatched: string[];
  /** Run ids `abortRun` was called for, in order. */
  readonly aborts: string[];
  abortRun(runId: string): void;
  /** Resolves once `n` hanging attempts (in total) are blocked. */
  hanging(n: number): Promise<void>;
  /** Let a hanging leaf of `runId` SUCCEED — work that runs on. */
  complete(runId: string, nodeId: string): void;
}

/**
 * A `dispatchNode`-only executor whose `hang` nodes block until `abortRun` (they
 * then fail `cancelled`, as a real aborted adapter does) or `complete` (they
 * then succeed — work that must NOT be cancelled runs on). Every other node
 * succeeds at once. Shared by the run-cancel tests (CX2, CX3).
 */
export function abortableExecutor(hang: ReadonlySet<string>): AbortableExecutor {
  const live = new Map<string, Map<string, (how: 'aborted' | 'completed') => void>>();
  const dispatched: string[] = [];
  const aborts: string[] = [];
  let blocked = 0;
  const waiters: { n: number; resolve: () => void }[] = [];
  const notify = (): void => {
    for (const w of waiters.filter((x) => blocked >= x.n)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  };
  return {
    dispatched,
    aborts,
    hanging: (n) =>
      new Promise((resolve) => {
        waiters.push({ n, resolve });
        notify();
      }),
    abortRun(runId) {
      aborts.push(runId);
      for (const release of live.get(runId)?.values() ?? []) release('aborted');
    },
    complete(runId, nodeId) {
      const release = live.get(runId)?.get(nodeId);
      if (release === undefined) throw new Error(`${runId}:${nodeId} is not hanging`);
      release('completed');
    },
    async *perform(command: ExecutorCommand, runId: string): AsyncGenerator<EngineEvent> {
      if (command.type !== 'dispatchNode') throw new Error('abortableExecutor: dispatchNode only');
      const { nodeId, attemptId } = command;
      dispatched.push(nodeId);
      yield { type: 'node.dispatched', runId, nodeId, attemptId, idempotent: false };
      if (hang.has(nodeId)) {
        const how = await new Promise<'aborted' | 'completed'>((resolve) => {
          let byNode = live.get(runId);
          if (byNode === undefined) live.set(runId, (byNode = new Map()));
          byNode.set(nodeId, resolve);
          blocked += 1;
          notify();
        });
        live.get(runId)?.delete(nodeId);
        if (how === 'aborted') {
          yield {
            type: 'node.failed',
            runId,
            nodeId,
            attemptId,
            error: 'aborted',
            kind: 'cancelled',
          };
          return;
        }
      }
      yield { type: 'node.succeeded', runId, nodeId, attemptId, outputs: {} };
    },
  };
}
