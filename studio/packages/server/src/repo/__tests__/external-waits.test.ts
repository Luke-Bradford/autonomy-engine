import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import { freshDb } from './helpers.js';
import { createPipeline } from '../pipelines.js';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createRun } from '../runs.js';
import type { Db } from '../types.js';
import {
  getExternalWaitByTokenHash,
  listPendingExternalWaitsByRun,
  markExternalWaitCompleted,
  markExternalWaitExpired,
  recordExternalWait,
} from '../external-waits.js';

/**
 * #4 A13 — the `external_waits` correlation-store repo: idempotent RECORD (the
 * crash-recovery re-arm) and the guarded exactly-once settles (which must never
 * downgrade an already-terminal row — the completed-then-timeout race).
 */

function seedRunId(db: Db): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  const pvId = createPipelineVersion(db, input).id;
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId: null,
    params: {},
  }).id;
}

function record(db: Db, runId: string, attemptId: string, tokenHash: string, expiresAt = 999) {
  return recordExternalWait(db, {
    runId,
    nodeId: 'w',
    attemptId,
    tokenHash,
    expiresAt,
    now: 1,
  });
}

describe('recordExternalWait — idempotent upsert', () => {
  it('a second record for the same (run,node,attempt) reuses the ORIGINAL row', () => {
    const { db } = freshDb();
    const runId = seedRunId(db);
    const first = record(db, runId, 'w#0', 'hash-a', 111);
    // A crash-recovery re-arm: same triple, same deterministic token → same hash.
    const second = record(db, runId, 'w#0', 'hash-a', 222);
    expect(second.id).toBe(first.id);
    expect(second.expiresAt).toBe(111); // ORIGINAL kept, not the re-arm's 222
    expect(listPendingExternalWaitsByRun(db, runId)).toHaveLength(1);
  });

  it('lookup by token hash returns the row; an unknown hash returns null', () => {
    const { db } = freshDb();
    const runId = seedRunId(db);
    record(db, runId, 'w#0', 'hash-a');
    expect(getExternalWaitByTokenHash(db, 'hash-a')!.attemptId).toBe('w#0');
    expect(getExternalWaitByTokenHash(db, 'nope')).toBeNull();
  });

  it('the raw token is never stored — only the hash the caller passes', () => {
    const { db } = freshDb();
    const runId = seedRunId(db);
    const row = record(db, runId, 'w#0', 'sha256-hash-value');
    expect(row.tokenHash).toBe('sha256-hash-value');
  });
});

describe('guarded settles — exactly-once, never downgrade', () => {
  const key = (runId: string) => ({ runId, nodeId: 'w', attemptId: 'w#0' });

  it('markExternalWaitCompleted settles a pending row once, then is a no-op', () => {
    const { db } = freshDb();
    const runId = seedRunId(db);
    record(db, runId, 'w#0', 'hash-a');
    expect(markExternalWaitCompleted(db, key(runId), 5)).toBe(true);
    expect(getExternalWaitByTokenHash(db, 'hash-a')!.status).toBe('completed');
    // A second completion is a no-op (already settled).
    expect(markExternalWaitCompleted(db, key(runId), 6)).toBe(false);
  });

  it('markExternalWaitExpired NEVER downgrades a completed row (completed-then-timeout)', () => {
    const { db } = freshDb();
    const runId = seedRunId(db);
    record(db, runId, 'w#0', 'hash-a');
    expect(markExternalWaitCompleted(db, key(runId), 5)).toBe(true);
    // The late-firing timeout alarm must not flip completed → expired.
    expect(markExternalWaitExpired(db, key(runId), 9)).toBe(false);
    expect(getExternalWaitByTokenHash(db, 'hash-a')!.status).toBe('completed');
  });

  it('markExternalWaitExpired settles a still-pending row (the genuine timeout)', () => {
    const { db } = freshDb();
    const runId = seedRunId(db);
    record(db, runId, 'w#0', 'hash-a');
    expect(markExternalWaitExpired(db, key(runId), 9)).toBe(true);
    expect(getExternalWaitByTokenHash(db, 'hash-a')!.status).toBe('expired');
    // listPending excludes it now.
    expect(listPendingExternalWaitsByRun(db, runId)).toEqual([]);
  });
});
