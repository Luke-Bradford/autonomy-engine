import { describe, it, expect } from 'vitest';
import {
  EngineEventSchema,
  TERMINAL_RUN_EVENT,
  terminalStatusOf,
  type EngineEvent,
} from '../types.js';

/**
 * #443 — the SSOT for "is this event a durable TERMINAL run fact, and what
 * lifecycle status does it record".
 *
 * The set/mapping was hard-coded in four places; three now route through this SSOT
 * (`reduce.ts`'s already-terminal early-return, the WS stream's close check, the
 * web run-detail page's log derivation). The reducer's own `run.finished`/
 * `run.interrupted` TRANSITIONS still name them directly, deliberately — those are
 * semantics (guarded by an impossibility check), not fact-reading.
 *
 * #443's rule — the LOG is authoritative over the projection for terminality —
 * makes this mapping load-bearing for a run's `runs.status`, so a copy that
 * silently drifts is exactly the hazard the ticket is about.
 *
 * These tests guard the SSOT itself, so every consumer inherits one answer. The
 * count assertion below is the ONLY guard on the fail-open drift direction (a new
 * terminal variant added to `EngineEventSchema` but forgotten in
 * `TERMINAL_RUN_EVENT_TYPES` reads as non-terminal, and does NOT fail typecheck).
 */

const run = { runId: 'r1' } as const;

describe('#443 — terminalStatusOf', () => {
  it('maps `run.finished{success}` to the `success` lifecycle status', () => {
    expect(terminalStatusOf({ type: 'run.finished', ...run, outcome: 'success' })).toBe('success');
  });

  it('maps `run.finished{failure}` to the `failure` lifecycle status', () => {
    expect(terminalStatusOf({ type: 'run.finished', ...run, outcome: 'failure' })).toBe('failure');
  });

  it('maps `run.finished{failure, reason}` by OUTCOME — `capped`/`invalid_event` are still failure', () => {
    // `reason` is observability only; the outcome is the fact. (`capped` is
    // `failure{reason:"capped"}` per `RunOutcomeSchema`'s doc.)
    expect(
      terminalStatusOf({ type: 'run.finished', ...run, outcome: 'failure', reason: 'capped' }),
    ).toBe('failure');
    expect(
      terminalStatusOf({
        type: 'run.finished',
        ...run,
        outcome: 'failure',
        reason: 'invalid_event',
      }),
    ).toBe('failure');
  });

  it('maps `run.interrupted` to the `interrupted` lifecycle status', () => {
    expect(terminalStatusOf({ type: 'run.interrupted', ...run, reason: 'drive_failed' })).toBe(
      'interrupted',
    );
  });

  it('returns null for EVERY non-terminal event in the union (no false terminals)', () => {
    // Exhaustive over the event union rather than a hand-picked sample: a new
    // event type added without a decision here shows up as a test gap, not as a
    // silently non-terminal event.
    const nonTerminal: EngineEvent[] = [
      { type: 'run.started', ...run, pipelineVersionId: 'pv1', params: {} },
      { type: 'node.dispatched', ...run, nodeId: 'n1', attemptId: 'n1#0', idempotent: true },
      { type: 'node.succeeded', ...run, nodeId: 'n1', attemptId: 'n1#0', outputs: {} },
      EngineEventSchema.parse({
        type: 'node.failed',
        ...run,
        nodeId: 'n1',
        attemptId: 'n1#0',
        error: 'boom',
        kind: 'transient',
      }),
      {
        type: 'call.returned',
        ...run,
        callNodeId: 'c1',
        attemptId: 'c1#0',
        childRunId: 'r2',
        childOutcome: 'failure',
        outputs: {},
      },
      { type: 'node.output', ...run, nodeId: 'n1', name: 'chunk', value: 'x' },
      { type: 'run.resumed', ...run, reason: 'boot_reconcile' },
      { type: 'node.retryRequested', ...run, nodeId: 'n1', previousAttemptId: 'n1#0', reason: 'r' },
    ];
    for (const event of nonTerminal) {
      expect(terminalStatusOf(event), `${event.type} must not be terminal`).toBeNull();
    }
    // The union is exactly the terminal set + the list above — so if a variant is
    // added and classified nowhere, this count fails and forces the decision.
    expect(nonTerminal.length + TERMINAL_RUN_EVENT.size).toBe(EngineEventSchema.options.length);
  });

  it('a `run.resumed` is NOT terminal — it is what the reconciler appends to RE-drive a run', () => {
    // Load-bearing for #443: `terminalFactFromLog` must not read a resumed run as
    // terminal, and must not let a resume ERASE an earlier terminal fact either.
    expect(terminalStatusOf({ type: 'run.resumed', ...run, reason: 'boot_reconcile' })).toBeNull();
  });
});

describe('#443 — TERMINAL_RUN_EVENT', () => {
  it('is exactly {run.finished, run.interrupted}', () => {
    expect([...TERMINAL_RUN_EVENT].sort()).toEqual(['run.finished', 'run.interrupted']);
  });

  it('agrees with `terminalStatusOf` on every event variant (the set and the map cannot drift)', () => {
    // The two exports are derived from ONE list; this pins that they stay in step
    // even if a later fire re-implements either.
    for (const option of EngineEventSchema.options) {
      const type = option.shape.type.value;
      const inSet = (TERMINAL_RUN_EVENT as ReadonlySet<string>).has(type);
      const sample =
        type === 'run.finished'
          ? ({ type, ...run, outcome: 'success' } as EngineEvent)
          : type === 'run.interrupted'
            ? ({ type, ...run, reason: 'x' } as EngineEvent)
            : null;
      if (sample !== null) expect(terminalStatusOf(sample)).not.toBeNull();
      expect(inSet).toBe(sample !== null);
    }
  });
});
