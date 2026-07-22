import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type NewPipelineVersion,
  type NewRun,
  type RunStatus,
} from '@autonomy-studio/shared';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { createTrigger } from '../triggers.js';
import {
  admitQueuedRun,
  countActiveRunsForTrigger,
  countQueuedRunsForTrigger,
  createRun,
  deleteRun,
  getRun,
  listRuns,
  nextQueuedRunForTrigger,
  updateRun,
} from '../runs.js';
import { freshDb } from './helpers.js';

function setupPipelineVersion(db: ReturnType<typeof freshDb>['db']) {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const versionInput: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, versionInput);
}

function buildRunInput(pipelineVersionId: string, overrides: Partial<NewRun> = {}): NewRun {
  return {
    ownerId: 'local',
    pipelineVersionId,
    triggerId: null,
    parentRunId: null,
    params: {},
    ...overrides,
  };
}

describe('runs repo', () => {
  it('creates a run defaulting to pending status, with startedAt stamped', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const before = Date.now();
    const created = createRun(db, buildRunInput(version.id));
    expect(created.status).toBe('pending');
    expect(created.startedAt).toBeGreaterThanOrEqual(before);
    expect(created.leaseUntil).toBeNull();
    expect(created.finishedAt).toBeNull();
    expect(getRun(db, created.id)).toEqual(created);
  });

  it('rejects creating a run for a nonexistent pipeline version (FK enforced)', () => {
    const { db } = freshDb();
    expect(() => createRun(db, buildRunInput('pv_does_not_exist'))).toThrow();
  });

  it('creates a child run linked via parentRunId (self-referencing FK)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const parent = createRun(db, buildRunInput(version.id));
    const child = createRun(db, buildRunInput(version.id, { parentRunId: parent.id }));
    expect(child.parentRunId).toBe(parent.id);
  });

  it('rejects a child run pointing at a nonexistent parent (FK enforced)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    expect(() =>
      createRun(db, buildRunInput(version.id, { parentRunId: 'run_does_not_exist' })),
    ).toThrow();
  });

  it('filters listRuns by pipelineVersionId, triggerId, and parentRunId', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const otherVersion = setupPipelineVersion(db);
    const a = createRun(db, buildRunInput(version.id));
    const parent = createRun(db, buildRunInput(version.id));
    const child = createRun(db, buildRunInput(version.id, { parentRunId: parent.id }));
    createRun(db, buildRunInput(otherVersion.id));

    expect(
      listRuns(db, { pipelineVersionId: version.id })
        .map((r) => r.id)
        .sort(),
    ).toEqual([a.id, parent.id, child.id].sort());
    expect(listRuns(db, { parentRunId: parent.id })).toEqual([child]);
    expect(listRuns(db)).toHaveLength(4);
  });

  it('filters listRuns by ownerId, in SQL (never over-fetched then filtered)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const mine = createRun(db, buildRunInput(version.id));
    createRun(db, buildRunInput(version.id, { ownerId: 'someone-else' }));

    expect(listRuns(db, { ownerId: 'local' })).toEqual([mine]);
    expect(listRuns(db)).toHaveLength(2);
  });

  it('updates run lifecycle fields (status/lease/heartbeat/finishedAt)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const created = createRun(db, buildRunInput(version.id));

    const running = updateRun(db, created.id, {
      status: 'running',
      leaseUntil: created.startedAt + 30_000,
      heartbeatAt: created.startedAt + 1_000,
    });
    expect(running!.status).toBe('running');
    expect(running!.leaseUntil).toBe(created.startedAt + 30_000);

    const finished = updateRun(db, created.id, {
      status: 'success',
      finishedAt: created.startedAt + 60_000,
    });
    expect(finished!.status).toBe('success');
    expect(finished!.finishedAt).toBe(created.startedAt + 60_000);
  });

  it('returns null when updating a missing run', () => {
    const { db } = freshDb();
    expect(updateRun(db, 'run_missing', { status: 'running' })).toBeNull();
  });

  it('rejects an updateRun patch touching an immutable-binding field, even bypassing the TS type', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const created = createRun(db, buildRunInput(version.id));

    // `RunLifecyclePatch` has no `pipelineVersionId`/`triggerId`/
    // `parentRunId`/`params`/`startedAt` field, so this is a type error at
    // the call site (the `as never` cast simulates a caller bypassing that
    // compile-time guard) — `RunLifecyclePatchSchema`'s `.strict()` must
    // still reject it at runtime.
    expect(() => updateRun(db, created.id, { pipelineVersionId: 'pv_other' } as never)).toThrow();
    expect(() => updateRun(db, created.id, { params: { changed: true } } as never)).toThrow();
    expect(() => updateRun(db, created.id, { startedAt: 0 } as never)).toThrow();

    // The run is untouched by the rejected patches.
    expect(getRun(db, created.id)).toEqual(created);
  });

  it('deletes a run', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const created = createRun(db, buildRunInput(version.id));
    expect(deleteRun(db, created.id)).toBe(true);
    expect(getRun(db, created.id)).toBeNull();
  });
});

describe('countActiveRunsForTrigger — #5 S4 slot release', () => {
  it('counts pending + running, but NOT waiting (parked releases its slot) or terminals', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const trigger = createTrigger(db, {
      ownerId: 'local',
      name: 'T',
      pipelineVersionId: version.id,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'skip_if_running' },
      runWindows: null,
      enabled: false,
    });
    const seed = (status: RunStatus): void => {
      const run = createRun(db, buildRunInput(version.id, { triggerId: trigger.id }));
      if (status !== 'pending') updateRun(db, run.id, { status });
    };
    seed('pending');
    seed('running');
    seed('waiting'); // #5 S4 — a parked run RELEASES its concurrency slot.
    seed('success');
    seed('failure');
    seed('skipped');
    seed('interrupted');

    // Only the pending + running rows occupy a slot; waiting + all terminals do not.
    expect(countActiveRunsForTrigger(db, trigger.id)).toBe(2);
  });
});

describe('durable admission queue — #5 S6a', () => {
  function seedTrigger(db: ReturnType<typeof freshDb>['db'], versionId: string) {
    return createTrigger(db, {
      ownerId: 'local',
      name: 'T',
      pipelineVersionId: versionId,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: false,
    });
  }
  function seedQueued(
    db: ReturnType<typeof freshDb>['db'],
    versionId: string,
    triggerId: string,
    queuedAt: number,
  ) {
    return createRun(db, buildRunInput(versionId, { triggerId, status: 'queued', queuedAt }));
  }

  it('a `queued` row does NOT occupy a slot (pre-admission), but IS counted by countQueuedRunsForTrigger', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const trigger = seedTrigger(db, version.id);
    seedQueued(db, version.id, trigger.id, 100);
    seedQueued(db, version.id, trigger.id, 200);

    expect(countActiveRunsForTrigger(db, trigger.id)).toBe(0);
    expect(countQueuedRunsForTrigger(db, trigger.id)).toBe(2);
  });

  it('nextQueuedRunForTrigger returns the OLDEST-queuedAt row, deterministically', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const trigger = seedTrigger(db, version.id);
    // Insert out of order; the FIFO key is queuedAt, not insertion.
    seedQueued(db, version.id, trigger.id, 300);
    const oldest = seedQueued(db, version.id, trigger.id, 100);
    seedQueued(db, version.id, trigger.id, 200);

    expect(nextQueuedRunForTrigger(db, trigger.id)?.id).toBe(oldest.id);
  });

  it('breaks a same-millisecond queuedAt tie by INSERTION order (rowid), not random id', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const trigger = seedTrigger(db, version.id);
    // Three fires with the IDENTICAL queuedAt (a same-ms burst). Strict arrival
    // FIFO must return them in the order they were enqueued — the random nanoid
    // `id` cannot give that; `rowid` (monotonic with INSERT) does.
    const first = seedQueued(db, version.id, trigger.id, 500);
    const second = seedQueued(db, version.id, trigger.id, 500);
    const third = seedQueued(db, version.id, trigger.id, 500);

    // Drain the whole tie group in order, admitting each so the next surfaces.
    const drained: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const next = nextQueuedRunForTrigger(db, trigger.id)!;
      drained.push(next.id);
      admitQueuedRun(db, next.id);
    }
    expect(drained).toEqual([first.id, second.id, third.id]);
  });

  it('nextQueuedRunForTrigger is null when the queue is empty', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const trigger = seedTrigger(db, version.id);
    expect(nextQueuedRunForTrigger(db, trigger.id)).toBeNull();
  });

  it('admitQueuedRun flips queued→pending and RE-STAMPS startedAt to admission time', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const trigger = seedTrigger(db, version.id);
    const run = seedQueued(db, version.id, trigger.id, 100);
    const enqueuedStartedAt = run.startedAt;

    const before = Date.now();
    const admitted = admitQueuedRun(db, run.id);
    expect(admitted).not.toBeNull();
    expect(admitted!.status).toBe('pending');
    expect(admitted!.startedAt).toBeGreaterThanOrEqual(before);
    // startedAt is the ADMISSION time, not the enqueue-time placeholder — so
    // `${run.startedAt}` reflects when the run was admitted (driver contract).
    expect(admitted!.startedAt).toBeGreaterThanOrEqual(enqueuedStartedAt);
    // queuedAt is PRESERVED (the historical enqueue record), not rewritten.
    expect(admitted!.queuedAt).toBe(100);
  });

  it('admitQueuedRun is idempotent: a second admission (or a non-queued row) returns null and changes nothing', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const trigger = seedTrigger(db, version.id);
    const run = seedQueued(db, version.id, trigger.id, 100);

    expect(admitQueuedRun(db, run.id)).not.toBeNull(); // first wins
    expect(admitQueuedRun(db, run.id)).toBeNull(); // row is now `pending`, not `queued`
    expect(getRun(db, run.id)!.status).toBe('pending');
    // A row that was never queued is not admissible either.
    const running = createRun(db, buildRunInput(version.id, { triggerId: trigger.id }));
    expect(admitQueuedRun(db, running.id)).toBeNull();
  });
});
