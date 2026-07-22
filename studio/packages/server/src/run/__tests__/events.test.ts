import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@autonomy-studio/shared';
import {
  appendEngineEvent,
  loadEngineEvents,
  RunLogUnparseableError,
  terminalFactFromLog,
} from '../events.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import { CATALOG_VERSION } from '@autonomy-studio/shared';

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

// ===========================================================================
// The append choke point returns what it PARSED (the F2b build-order fix)
// ===========================================================================

describe('appendEngineEvent — the fold and the log are the same fact', () => {
  /**
   * `appendEngineEvent` APPENDS the parsed event but callers used to REDUCE
   * their own raw input. Wherever the schema applies a `.default()`, those are
   * different values: the log records one thing and the live run folds another,
   * while a REPLAY (which always parses) folds the log's version. Returning the
   * parsed value is what lets every caller fold exactly what was stored — the
   * joint F1b/F2b spec's build order names this as F2b's first task.
   *
   * **Scope, stated honestly:** `kind` is the only `.default()` in the event
   * union today, and both spellings of a missing one — raw `undefined` and the
   * parsed `permanent` — are non-eligible under F2b's `kind !== 'transient'`
   * rule. So this fix is currently INERT for retry, not a live bug being closed:
   * the build order's "the disagreement decides whether a node retries"
   * overstates it. What it removes is the CLASS — the next `.default()` added to
   * a field the reducer reads would be a silent live-vs-replay divergence, and
   * that is not a bug anyone would find twice.
   */
  it('returns the PARSED event, with schema defaults applied', () => {
    const { db } = freshDb();
    // `run_events.runId` is a real FK, so the run must exist — the append path
    // under test is the real one, against a real schema.
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const pv = createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [{ id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv.id,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    // A producer that bypassed the type (a JS caller, or an event rebuilt from
    // JSON) can omit `kind` — exactly the case the parse boundary exists for.
    const raw = {
      type: 'node.failed',
      runId: run.id,
      nodeId: 'a',
      attemptId: 'a#0',
      error: 'boom',
    };

    const { record, event } = appendEngineEvent(db, raw as unknown as EngineEvent);

    expect(event).toMatchObject({ type: 'node.failed', kind: 'permanent' });
    // …and it is the SAME value that became durable — the property every caller
    // now relies on by folding `.event`.
    expect(record.payload).toEqual(event);
    expect(loadEngineEvents(db, run.id)[0]).toEqual(event);
  });
});

describe('#646 — loadEngineEvents types log corruption at the source', () => {
  function seedRunWithEvent(db: ReturnType<typeof freshDb>['db']) {
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const pv = createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [{ id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv.id,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    appendEngineEvent(db, {
      type: 'run.started',
      runId: run.id,
      pipelineVersionId: pv.id,
      params: {},
    });
    return run;
  }

  it('wraps an invalid-JSON payload (SyntaxError class) as RunLogUnparseableError', () => {
    const { db, sqlite } = freshDb();
    const run = seedRunWithEvent(db);
    // The log is APPEND-ONLY (a DB trigger blocks UPDATE), so the honest
    // corruption vector is a poison APPENDED row (the #642 test precedent).
    sqlite
      .prepare(
        'INSERT INTO run_events (id, run_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('evt_poison', run.id, 999, 'x', 'not json', 1_700_000_000_000);

    expect(() => loadEngineEvents(db, run.id)).toThrow(RunLogUnparseableError);
    try {
      loadEngineEvents(db, run.id);
      expect.unreachable('should have thrown');
    } catch (err) {
      // The wrapper preserves the identifying facts a consumer files by.
      expect(err).toBeInstanceOf(RunLogUnparseableError);
      expect((err as RunLogUnparseableError).runId).toBe(run.id);
      expect((err as RunLogUnparseableError).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it('wraps a shape EngineEventSchema rejects (ZodError class) the same way', () => {
    const { db, sqlite } = freshDb();
    const run = seedRunWithEvent(db);
    // Valid JSON, wrong shape — EngineEventSchema rejects it (ZodError).
    sqlite
      .prepare(
        'INSERT INTO run_events (id, run_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('evt_poison', run.id, 999, 'x', '{"type":"no.such.event"}', 1_700_000_000_000);

    expect(() => loadEngineEvents(db, run.id)).toThrow(RunLogUnparseableError);
  });

  it('a healthy log loads unchanged', () => {
    const { db } = freshDb();
    const run = seedRunWithEvent(db);
    expect(loadEngineEvents(db, run.id)).toHaveLength(1);
  });
});
