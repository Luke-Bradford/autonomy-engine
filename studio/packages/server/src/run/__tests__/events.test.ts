import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@autonomy-studio/shared';
import { terminalFactFromLog } from '../events.js';

/**
 * #443 — `terminalFactFromLog` is the LOG's own answer to "is this run over, and
 * how did it end", read WITHOUT folding. The boot reconciler and the launcher's
 * interrupt-cleanup both key off it, so its edge cases are pinned here directly
 * rather than only through those callers.
 */

const runId = 'r1';
const started: EngineEvent = { type: 'run.started', runId, pipelineVersionId: 'pv1', params: {} };
const dispatched: EngineEvent = {
  type: 'node.dispatched',
  runId,
  nodeId: 'a',
  attemptId: 'a#0',
  idempotent: true,
};
const resumed: EngineEvent = { type: 'run.resumed', runId, reason: 'boot_reconcile' };
const finishedOk: EngineEvent = { type: 'run.finished', runId, outcome: 'success' };
const finishedBad: EngineEvent = {
  type: 'run.finished',
  runId,
  outcome: 'failure',
  reason: 'invalid_event',
};
const interrupted: EngineEvent = { type: 'run.interrupted', runId, reason: 'drive_failed' };

describe('#443 — terminalFactFromLog', () => {
  it('returns null for an empty log', () => {
    expect(terminalFactFromLog([])).toBeNull();
  });

  it('returns null for a live run (no terminal fact recorded)', () => {
    expect(terminalFactFromLog([started, dispatched])).toBeNull();
  });

  it('reads a recorded success/failure/interrupt', () => {
    expect(terminalFactFromLog([started, finishedOk])).toBe('success');
    expect(terminalFactFromLog([started, finishedBad])).toBe('failure');
    expect(terminalFactFromLog([started, interrupted])).toBe('interrupted');
  });

  it('takes the LAST terminal event — a rejected finish then its replacement ⇒ failure', () => {
    // `pump` appends `run.finished` BEFORE folding it, so a finish the reducer
    // REJECTS is durable, followed by the `finishRun{failure, invalid_event}` it
    // returns instead. Reading the FIRST terminal would resync the rejected
    // `success` — fail-OPEN.
    expect(terminalFactFromLog([started, finishedOk, finishedBad])).toBe('failure');
  });

  it('a NON-terminal event after a terminal one cannot erase the terminal fact', () => {
    // Logs written before #443 can hold a `run.resumed` after a terminal — that
    // is exactly what the old projection-based reconciler did. Such a log must
    // still read as finished, or the run is re-driven forever.
    expect(terminalFactFromLog([started, finishedOk, resumed])).toBe('success');
    expect(terminalFactFromLog([started, finishedOk, resumed, dispatched])).toBe('success');
  });

  it('is decided by the log alone — no doc, no reducer, no projection', () => {
    // The whole point: a log whose CURRENT re-fold would disagree still reports
    // the fact it durably recorded.
    expect(terminalFactFromLog([started, dispatched, finishedOk])).toBe('success');
  });
});
