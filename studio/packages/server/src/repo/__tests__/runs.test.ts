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
  countActiveRunsForPipeline,
  countActiveRunsForTrigger,
  countQueuedRunsForTrigger,
  createRun,
  deleteRun,
  getRun,
  listParsedRuns,
  listRuns,
  nextQueuedRunForTrigger,
  queuedTriggerCandidatesForPipeline,
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

describe('per-pipeline admission — #5 S6b', () => {
  function seedPipelineWithVersions(db: ReturnType<typeof freshDb>['db']) {
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const versionInput: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
    const v1 = createPipelineVersion(db, versionInput);
    const v2 = createPipelineVersion(db, versionInput);
    return { pipeline, v1, v2 };
  }
  function seedTriggerOn(db: ReturnType<typeof freshDb>['db'], versionId: string, name: string) {
    return createTrigger(db, {
      ownerId: 'local',
      name,
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

  it('countActiveRunsForPipeline spans ALL versions + triggers of the pipeline; excludes queued/waiting/terminals and other pipelines', () => {
    const { db } = freshDb();
    const { pipeline, v1, v2 } = seedPipelineWithVersions(db);
    const t1 = seedTriggerOn(db, v1.id, 'T1');
    const t2 = seedTriggerOn(db, v2.id, 'T2');
    // Active: one pending on v1/t1, one running on v2/t2 — DIFFERENT versions of
    // the same pipeline both count (the cap is "across all its triggers").
    createRun(db, buildRunInput(v1.id, { triggerId: t1.id }));
    const running = createRun(db, buildRunInput(v2.id, { triggerId: t2.id }));
    updateRun(db, running.id, { status: 'running' });
    // A trigger-less (future call_pipeline child) run of this pipeline counts too.
    createRun(db, buildRunInput(v1.id));
    // Non-occupying rows: queued (pre-admission), waiting (parked), terminal.
    createRun(db, buildRunInput(v1.id, { triggerId: t1.id, status: 'queued', queuedAt: 1 }));
    const parked = createRun(db, buildRunInput(v1.id, { triggerId: t1.id }));
    updateRun(db, parked.id, { status: 'waiting' });
    const done = createRun(db, buildRunInput(v2.id, { triggerId: t2.id }));
    updateRun(db, done.id, { status: 'success' });
    // A run of a DIFFERENT pipeline never counts.
    const other = setupPipelineVersion(db);
    createRun(db, buildRunInput(other.id));

    expect(countActiveRunsForPipeline(db, pipeline.id)).toBe(3);
  });

  it('queuedTriggerCandidatesForPipeline groups queued rows by trigger with oldestQueuedAt + lastAdmittedAt, ordered least-recently-admitted first', () => {
    const { db, sqlite } = freshDb();
    const { pipeline, v1, v2 } = seedPipelineWithVersions(db);
    const t1 = seedTriggerOn(db, v1.id, 'T1');
    const t2 = seedTriggerOn(db, v2.id, 'T2');
    const t3 = seedTriggerOn(db, v1.id, 'T3');

    // T1 was ADMITTED recently (a non-queued row with a fresh startedAt);
    // T2 was admitted longer ago; T3 has never been served (no non-queued rows).
    const t1Served = createRun(db, buildRunInput(v1.id, { triggerId: t1.id }));
    updateRun(db, t1Served.id, { status: 'success' });
    const t2Served = createRun(db, buildRunInput(v2.id, { triggerId: t2.id }));
    updateRun(db, t2Served.id, { status: 'success' });
    // Force a strict service-time order: t2 served BEFORE t1. Raw SQL because
    // startedAt is deliberately NOT lifecycle-patchable (see updateRun).
    sqlite.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(1000, t2Served.id);
    sqlite.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(2000, t1Served.id);

    // Queued rows: T1 has the OLDEST queuedAt overall; T2 and T3 newer.
    createRun(db, buildRunInput(v1.id, { triggerId: t1.id, status: 'queued', queuedAt: 10 }));
    createRun(db, buildRunInput(v1.id, { triggerId: t1.id, status: 'queued', queuedAt: 40 }));
    createRun(db, buildRunInput(v2.id, { triggerId: t2.id, status: 'queued', queuedAt: 20 }));
    createRun(db, buildRunInput(v1.id, { triggerId: t3.id, status: 'queued', queuedAt: 30 }));

    const candidates = queuedTriggerCandidatesForPipeline(db, pipeline.id);
    // Least-recently-ADMITTED first: never-served T3, then T2 (1000), then T1
    // (2000) — despite T1 holding the oldest queued row. Within a trigger the
    // oldest queuedAt is reported.
    expect(candidates).toEqual([
      { triggerId: t3.id, oldestQueuedAt: 30, lastAdmittedAt: null },
      { triggerId: t2.id, oldestQueuedAt: 20, lastAdmittedAt: 1000 },
      { triggerId: t1.id, oldestQueuedAt: 10, lastAdmittedAt: 2000 },
    ]);
  });

  it('queuedTriggerCandidatesForPipeline: never-served ties break by oldestQueuedAt, then triggerId; other pipelines and non-queued rows excluded', () => {
    const { db } = freshDb();
    const { pipeline, v1 } = seedPipelineWithVersions(db);
    const tA = seedTriggerOn(db, v1.id, 'A');
    const tB = seedTriggerOn(db, v1.id, 'B');
    createRun(db, buildRunInput(v1.id, { triggerId: tB.id, status: 'queued', queuedAt: 5 }));
    createRun(db, buildRunInput(v1.id, { triggerId: tA.id, status: 'queued', queuedAt: 7 }));
    // A queued row on a DIFFERENT pipeline must not appear.
    const other = setupPipelineVersion(db);
    const tOther = seedTriggerOn(db, other.id, 'X');
    createRun(db, buildRunInput(other.id, { triggerId: tOther.id, status: 'queued', queuedAt: 1 }));

    const candidates = queuedTriggerCandidatesForPipeline(db, pipeline.id);
    expect(candidates).toEqual([
      { triggerId: tB.id, oldestQueuedAt: 5, lastAdmittedAt: null },
      { triggerId: tA.id, oldestQueuedAt: 7, lastAdmittedAt: null },
    ]);
    expect(queuedTriggerCandidatesForPipeline(db, 'pipe_nonexistent')).toEqual([]);
  });

  it('a REBOUND trigger: candidates + oldest pick + service record are all PIPELINE-scoped, never trigger-global', () => {
    // A queued run row freezes the version it enqueued under, while the
    // trigger's binding is mutable — so ONE trigger can hold queued rows on TWO
    // pipelines. Every drain read must scope to the drained pipeline, or
    // pipeline A's drain would admit (and gate-check) a pipeline-B row.
    const { db, sqlite } = freshDb();
    const { pipeline: pipeA, v1: vA } = seedPipelineWithVersions(db);
    const { v1: vB } = seedPipelineWithVersions(db);
    const t = seedTriggerOn(db, vA.id, 'T');

    // T's GLOBALLY-oldest queued row is on pipeline B; its pipeline-A row is newer.
    createRun(db, buildRunInput(vB.id, { triggerId: t.id, status: 'queued', queuedAt: 10 }));
    createRun(db, buildRunInput(vA.id, { triggerId: t.id, status: 'queued', queuedAt: 20 }));
    // T's most recent SERVICE was on pipeline B; its pipeline-A service is older.
    const servedA = createRun(db, buildRunInput(vA.id, { triggerId: t.id }));
    updateRun(db, servedA.id, { status: 'success' });
    const servedB = createRun(db, buildRunInput(vB.id, { triggerId: t.id }));
    updateRun(db, servedB.id, { status: 'success' });
    sqlite.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(1000, servedA.id);
    sqlite.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(2000, servedB.id);

    // Pipeline A's candidates report A's oldest row + A's service record only.
    expect(queuedTriggerCandidatesForPipeline(db, pipeA.id)).toEqual([
      { triggerId: t.id, oldestQueuedAt: 20, lastAdmittedAt: 1000 },
    ]);
    // The pipeline-scoped pick returns A's row, NOT the globally-older B row.
    const picked = nextQueuedRunForTrigger(db, t.id, pipeA.id);
    expect(picked?.pipelineVersionId).toBe(vA.id);
    expect(picked?.queuedAt).toBe(20);
    // The unscoped pick (per-trigger FIFO, S6a behaviour) still sees the global oldest.
    expect(nextQueuedRunForTrigger(db, t.id)?.queuedAt).toBe(10);
  });
});

describe('#646 — listParsedRuns (lenient per-row scan)', () => {
  it('skips a corrupt row, reports it via onSkip, and still returns the healthy siblings', () => {
    const { db, sqlite } = freshDb();
    const version = setupPipelineVersion(db);
    const good = createRun(db, buildRunInput(version.id));
    const bad = createRun(db, buildRunInput(version.id));
    updateRun(db, good.id, { status: 'running' });
    updateRun(db, bad.id, { status: 'running' });
    // The hand-edit/legacy-drift vector: invalid stored JSON in a codec column.
    // Empirically (see listParsedRuns' doc) this throws SyntaxError out of the
    // strict list's `.all()` itself, killing the WHOLE scan — the failure mode
    // that aborted server boot.
    sqlite.prepare('UPDATE runs SET params = ? WHERE id = ?').run('not json', bad.id);

    // The strict list still throws (routes keep their 500-on-poison contract)…
    expect(() => listRuns(db, { status: 'running' })).toThrow();

    // …the lenient scan isolates the poison row and reports it.
    const skipped: string[] = [];
    const rows = listParsedRuns(db, { status: 'running' }, (id, err) => {
      skipped.push(id);
      expect(err).toBeInstanceOf(SyntaxError);
    });
    expect(rows.map((r) => r.id)).toEqual([good.id]);
    expect(skipped).toEqual([bad.id]);
  });

  it('a shape RunSchema rejects (ZodError class) is skipped the same way', () => {
    const { db, sqlite } = freshDb();
    const version = setupPipelineVersion(db);
    const bad = createRun(db, buildRunInput(version.id));
    updateRun(db, bad.id, { status: 'running' });
    // Well-formed JSON, wrong shape: params must be an object, not an array.
    sqlite.prepare('UPDATE runs SET params = ? WHERE id = ?').run('[1,2,3]', bad.id);

    const skipped: string[] = [];
    const rows = listParsedRuns(db, { status: 'running' }, (id) => skipped.push(id));
    expect(rows).toEqual([]);
    expect(skipped).toEqual([bad.id]);
  });
});

describe('#646 — nextQueuedRunForTrigger picks PAST a corrupt FIFO head', () => {
  function seedQueueTrigger(db: ReturnType<typeof freshDb>['db'], versionId: string) {
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

  it('skips the corrupt head (reported), returns the next healthy queued row', () => {
    const { db, sqlite } = freshDb();
    const version = setupPipelineVersion(db);
    const trigger = seedQueueTrigger(db, version.id);
    const bad = createRun(db, buildRunInput(version.id, { triggerId: trigger.id }));
    const good = createRun(db, buildRunInput(version.id, { triggerId: trigger.id }));
    sqlite.prepare("UPDATE runs SET status = 'queued', queued_at = ? WHERE id = ?").run(10, bad.id);
    sqlite
      .prepare("UPDATE runs SET status = 'queued', queued_at = ? WHERE id = ?")
      .run(20, good.id);
    // Corrupt the OLDER row — the FIFO head the old strict `.get()` mapped
    // (and threw on) before returning anything.
    sqlite.prepare('UPDATE runs SET params = ? WHERE id = ?').run('not json', bad.id);

    const skipped: string[] = [];
    const next = nextQueuedRunForTrigger(db, trigger.id, undefined, (id, err) => {
      skipped.push(id);
      expect(err).toBeInstanceOf(SyntaxError);
    });
    expect(next?.id).toBe(good.id);
    expect(skipped).toEqual([bad.id]);
  });

  it('a corrupt-only queue yields null (skipped, not thrown)', () => {
    const { db, sqlite } = freshDb();
    const version = setupPipelineVersion(db);
    const trigger = seedQueueTrigger(db, version.id);
    const bad = createRun(db, buildRunInput(version.id, { triggerId: trigger.id }));
    sqlite
      .prepare(
        "UPDATE runs SET status = 'queued', queued_at = 10, params = 'not json' WHERE id = ?",
      )
      .run(bad.id);

    const skipped: string[] = [];
    expect(nextQueuedRunForTrigger(db, trigger.id, undefined, (id) => skipped.push(id))).toBeNull();
    expect(skipped).toEqual([bad.id]);
  });
});
