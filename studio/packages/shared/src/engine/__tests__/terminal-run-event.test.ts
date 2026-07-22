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
      // #5 S12 — the fire-time trigger seed. Non-terminal: it folds into the
      // pre-`run.started` `pending` state and never ends a run.
      { type: 'run.triggerContext', ...run, triggerId: 'trg-1' },
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
      // #5 S3 — the run parked on an external event. NON-terminal: the run
      // resumes to `running` when the event lands, so it must never read as a
      // terminal fact (else `runs.status` would freeze `waiting` forever).
      { type: 'run.waiting', ...run, reason: 'waiting_external' },
      { type: 'node.retryRequested', ...run, nodeId: 'n1', previousAttemptId: 'n1#0', reason: 'r' },
      // F2b/F2c's retry pair. NON-terminal, and §E of the joint spec depends on
      // that being deliberate: its invariant is "no TERMINAL event is appended
      // after an ACCEPTED terminal event", and these two are exactly the
      // non-terminal events it names as free to land later.
      { type: 'node.retryScheduled', ...run, nodeId: 'n1', attemptId: 'n1#0', nextAttemptAt: 1 },
      { type: 'node.retryDue', ...run, nodeId: 'n1', previousAttemptId: 'n1#0' },
      // #4 A0 — an `if`'s branch decision. NON-terminal: it folds the node to
      // `success` + records the branch, but is not itself a run-terminating event.
      { type: 'condition.evaluated', ...run, nodeId: 'n1', attemptId: 'n1#0', branch: 'true' },
      // #4 A2 — a `switch`'s branch decision. NON-terminal for the same reason as
      // `condition.evaluated` (its `if` twin) — folds the node to `success`.
      { type: 'switch.evaluated', ...run, nodeId: 'n1', attemptId: 'n1#0', branch: 'gold' },
      // #4 A5/A6 — the durable-wait timer pair. NON-terminal, same shape as the
      // retry pair: `timer.waitScheduled` parks the node `wait_pending`, `timer.due`
      // folds it to `success` — neither is itself a run-terminating event, and both
      // are free to land after an accepted terminal (§E's invariant).
      { type: 'timer.waitScheduled', ...run, nodeId: 'n1', attemptId: 'n1#0', dueAt: 1 },
      { type: 'timer.due', ...run, nodeId: 'n1', previousAttemptId: 'n1#0' },
      // #4 A13 — the external-wait family. NON-terminal, same shape as the timer
      // pair: `externalWait.created` parks the node `external_wait_pending`,
      // `externalWait.completed` folds it to `success` and `externalWait.expired` to
      // `failure` — each folds a NODE, none is itself a run-terminating event, and
      // all are free to land after an accepted terminal (§E's invariant).
      { type: 'externalWait.created', ...run, nodeId: 'n1', attemptId: 'n1#0', dueAt: 1 },
      { type: 'externalWait.completed', ...run, nodeId: 'n1', previousAttemptId: 'n1#0' },
      { type: 'externalWait.expired', ...run, nodeId: 'n1', previousAttemptId: 'n1#0' },
      // #4 A17 — the container wall-clock timeout pair. NON-terminal: both fold a
      // CONTAINER, not the run — `container.timeoutScheduled` stamps the loop's
      // `timeoutDueAt`, `container.timedOut` fails the loop and lets `settle` decide
      // the run's fate (a handled outer edge can still make the run succeed), so
      // neither is itself a run-terminating event.
      { type: 'container.timeoutScheduled', ...run, containerId: 'lp', dueAt: 1 },
      { type: 'container.timedOut', ...run, containerId: 'lp' },
      // #2 L2 — a per-response metering FACT. NON-terminal: an observability event
      // (like `node.output`) folded inert; it neither terminates the run nor folds
      // a node, and is free to land before the terminal `node.succeeded`.
      {
        type: 'activity.metered',
        ...run,
        nodeId: 'n1',
        attemptId: 'n1#0',
        provider: 'anthropic_api',
        model: 'claude-opus-4-8',
        inputTokens: 10,
        outputTokens: 20,
        meteringStatus: 'metered',
      },
      // #2 L9a — a per-response prompt/completion CAPTURE fact. NON-terminal: an
      // observability event (like `activity.metered`) folded inert; it neither
      // terminates the run nor folds a node, and is free to land before the terminal.
      {
        type: 'activity.captured',
        ...run,
        nodeId: 'n1',
        attemptId: 'n1#0',
        provider: 'anthropic_api',
        model: 'claude-opus-4-8',
        latencyMs: 12,
        request: {
          messageCount: 1,
          messages: [{ role: 'user', chars: 5, contentHash: 'h' }],
        },
      },
      // #2 L11a — an `agent_task` subprocess TELEMETRY fact. NON-terminal: an
      // observability event (like `activity.captured`) folded inert; it neither
      // terminates the run nor folds a node, and is free to land before the terminal.
      {
        type: 'activity.agentTelemetry',
        ...run,
        nodeId: 'n1',
        attemptId: 'n1#0',
        latencyMs: 42,
        exitCode: 0,
        summary: 'completed',
        outputChars: 5,
        outputHash: 'oh',
      },
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

  it('a `run.waiting` is NOT terminal (#5 S3) — a parked run resumes, it does not end', () => {
    // The run-level twin of the node parked-states: `waiting` is a non-terminal
    // sub-state, so neither the log-reader (`terminalStatusOf`) nor the driver's
    // `TERMINAL_RUN` set (asserted in the server suite) may treat it as an end.
    expect(terminalStatusOf({ type: 'run.waiting', ...run, reason: 'waiting_timer' })).toBeNull();
    expect((TERMINAL_RUN_EVENT as ReadonlySet<string>).has('run.waiting')).toBe(false);
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
