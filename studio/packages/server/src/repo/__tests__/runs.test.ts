import { describe, expect, it } from 'vitest';
import {
  computeRunCost,
  CATALOG_VERSION,
  MAX_PAGE_SIZE,
  RunStatusSchema,
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
  findLiveRerunOf,
  getParsedRun,
  getRun,
  LIVE_RUN_STATUSES,
  listParsedRuns,
  listRuns,
  listRunSummariesPage,
  nextQueuedRunForTrigger,
  queuedTriggerCandidatesForPipeline,
  updateRun,
} from '../runs.js';
import { appendRunEvent } from '../run-events.js';
import { decodeCursor, type CursorKey } from '../pagination.js';
import { freshDb } from './helpers.js';
import { runs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

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

  it('defaults rerunOf to null, and persists an explicit rerunOf (RS6 lineage)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const source = createRun(db, buildRunInput(version.id));
    expect(source.rerunOf).toBeNull();

    const rerun = createRun(db, buildRunInput(version.id, { rerunOf: source.id }));
    expect(rerun.rerunOf).toBe(source.id);
    // Round-trips through the DB read path (RunSchema.parse), not just the insert.
    expect(getRun(db, rerun.id)?.rerunOf).toBe(source.id);
  });

  it('rejects a rerun pointing at a nonexistent source run (rerunOf FK enforced)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    expect(() =>
      createRun(db, buildRunInput(version.id, { rerunOf: 'run_does_not_exist' })),
    ).toThrow();
  });

  it('filters listRuns by rerunOf — the rerun-history grouping scan', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const source = createRun(db, buildRunInput(version.id));
    const rerunA = createRun(db, buildRunInput(version.id, { rerunOf: source.id }));
    const rerunB = createRun(db, buildRunInput(version.id, { rerunOf: source.id }));
    createRun(db, buildRunInput(version.id)); // an unrelated original run

    expect(
      listRuns(db, { rerunOf: source.id })
        .map((r) => r.id)
        .sort(),
    ).toEqual([rerunA.id, rerunB.id].sort());
    expect(listRuns(db)).toHaveLength(4);
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

describe('#1041 — getParsedRun (the single-row twin of the lenient scan)', () => {
  it('returns the row when it parses, and reports nothing', () => {
    const { db } = freshDb();
    const run = createRun(db, buildRunInput(setupPipelineVersion(db).id));

    const skipped: string[] = [];
    expect(getParsedRun(db, run.id, (id) => skipped.push(id))?.id).toBe(run.id);
    expect(skipped).toEqual([]);
  });

  it('returns null for an ABSENT row without reporting a skip — absent is not corrupt', () => {
    const { db } = freshDb();

    const skipped: string[] = [];
    expect(getParsedRun(db, 'run_nope', (id) => skipped.push(id))).toBeNull();
    expect(skipped).toEqual([]);
  });

  it('reports a corrupt row via onSkip and returns null', () => {
    const { db, sqlite } = freshDb();
    const run = createRun(db, buildRunInput(setupPipelineVersion(db).id));
    sqlite.prepare('UPDATE runs SET params = ? WHERE id = ?').run('not json', run.id);

    const skipped: string[] = [];
    expect(
      getParsedRun(db, run.id, (id, err) => {
        skipped.push(id);
        expect(err).toBeInstanceOf(SyntaxError);
      }),
    ).toBeNull();
    expect(skipped).toEqual([run.id]);
    // The strict read still throws — leniency is opt-in, per reader.
    expect(() => getRun(db, run.id)).toThrow();
  });

  it('PROPAGATES a live DB fault instead of calling it corruption', () => {
    const { db, sqlite } = freshDb();
    const run = createRun(db, buildRunInput(setupPipelineVersion(db).id));
    // A fault of the transient class: the row is FINE and would parse on the
    // next attempt — it is the connection that is gone. Reporting this as a
    // corrupt row would ask an operator to repair healthy state, and (for the
    // boot reconciler) re-report it under a permanent bucket on every boot.
    sqlite.close();

    const skipped: string[] = [];
    expect(() => getParsedRun(db, run.id, (id) => skipped.push(id))).toThrow();
    expect(skipped).toEqual([]);
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

/**
 * #1083 — the whole owner-scoped list, for the assertions that predate paging
 * and are about the JOIN, the cost fold, the filter axes and the order rather
 * than about the walk. They keep meaning exactly what they meant by asking for
 * one page larger than the fixture; the paging itself is pinned separately in
 * `listRunSummariesPage — keyset paging` below.
 *
 * `MAX_PAGE_SIZE` rather than a literal, so a fixture that grew past a
 * hand-picked number would be a compile-time-visible SSOT change and not a
 * silently truncated assertion.
 */
function summariesOf(
  db: ReturnType<typeof freshDb>['db'],
  filter: Parameters<typeof listRunSummariesPage>[1] = {},
) {
  return listRunSummariesPage(db, filter, { limit: MAX_PAGE_SIZE }).items;
}

describe('listRunSummaries (R2)', () => {
  function setup() {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Nightly report' });
    const version = createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    return { db, pipeline, version };
  }

  function makeTrigger(db: ReturnType<typeof freshDb>['db'], versionId: string, name: string) {
    return createTrigger(db, {
      ownerId: 'local',
      name,
      pipelineVersionId: versionId,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'skip_if_running' },
      runWindows: null,
      enabled: false,
    });
  }

  /**
   * #931 — the ASSEMBLY point, which the standalone `aggregateRunCosts` tests do
   * not reach: the aggregate returns a `Map<runId, RunCost>`, and this is where
   * it is joined back onto the rows. A swapped or misaligned id mapping is
   * invisible with one run — it needs several, with DIFFERENT totals, and one
   * that billed nothing so the `computeRunCost([])` substitution is exercised in
   * the same list as real groups.
   */
  it('attaches each run its OWN cost, and a zeroed one to a run that billed nothing', () => {
    const { db, version } = setup();
    const cheap = createRun(db, buildRunInput(version.id));
    const dear = createRun(db, buildRunInput(version.id));
    const quiet = createRun(db, buildRunInput(version.id));
    const metered = (runId: string, cost: number) => ({
      type: 'activity.metered',
      runId,
      nodeId: 'n1',
      attemptId: 'n1#1',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'metered',
      inputTokens: 10,
      outputTokens: 20,
      inUnitPrice: 5,
      outUnitPrice: 5,
      priceTableVersion: 'v1',
      costEstimate: cost,
    });
    appendRunEvent(db, {
      runId: cheap.id,
      type: 'activity.metered',
      payload: metered(cheap.id, 0.01),
    });
    appendRunEvent(db, {
      runId: dear.id,
      type: 'activity.metered',
      payload: metered(dear.id, 0.5),
    });
    appendRunEvent(db, {
      runId: dear.id,
      type: 'activity.metered',
      payload: metered(dear.id, 0.25),
    });
    /* A non-metered event on the quiet run, so it is not merely a run with an
       empty log — nothing about it should produce a cost. */
    appendRunEvent(db, { runId: quiet.id, type: 'run.started', payload: {} });

    const byId = new Map(summariesOf(db, { ownerId: 'local' }).map((r) => [r.id, r.cost]));
    expect(byId.get(cheap.id)?.totalCostEstimate).toBeCloseTo(0.01, 10);
    expect(byId.get(cheap.id)?.responseCount).toBe(1);
    expect(byId.get(dear.id)?.totalCostEstimate).toBeCloseTo(0.75, 10);
    expect(byId.get(dear.id)?.responseCount).toBe(2);
    /* Zeroed, not absent, and not `null`: nothing was billed, which is a fact —
       distinct from "cost unknown", which is what a null would assert. */
    expect(byId.get(quiet.id)).toEqual(computeRunCost([]));
    expect(byId.get(quiet.id)?.complete).toBe(true);
  });

  it('resolves the pipeline name, version NUMBER and trigger name', () => {
    const { db, version } = setup();
    const trigger = makeTrigger(db, version.id, 'Every morning');
    const run = createRun(db, buildRunInput(version.id, { triggerId: trigger.id }));

    const summaries = summariesOf(db);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.id).toBe(run.id);
    expect(summary?.pipelineName).toBe('Nightly report');
    // The version NUMBER an operator reads as "v1", not the opaque `pv_…` id.
    expect(summary?.pipelineVersion).toBe(version.version);
    expect(summary?.pipelineVersion).not.toBe(version.id);
    expect(summary?.triggerName).toBe('Every morning');
    // Additive over `Run` — every original field survives untouched.
    expect(summary?.status).toBe(run.status);
    expect(summary?.pipelineVersionId).toBe(version.id);
  });

  /**
   * The LEFT-join guard. An INNER join to `triggers` would drop every run that
   * has no trigger — which is not an exotic case: a rerun sets `triggerId=null`
   * deliberately, and so does a child run. Those runs vanishing from the
   * operator's list would be indistinguishable from having none.
   */
  it('KEEPS runs with no trigger, naming them null rather than dropping them', () => {
    const { db, version } = setup();
    const trigger = makeTrigger(db, version.id, 'Every morning');
    const triggered = createRun(db, buildRunInput(version.id, { triggerId: trigger.id }));
    const rerun = createRun(db, buildRunInput(version.id, { triggerId: null }));
    const parent = createRun(db, buildRunInput(version.id, { triggerId: null }));
    const child = createRun(db, buildRunInput(version.id, { parentRunId: parent.id }));

    const summaries = summariesOf(db);
    expect(summaries.map((s) => s.id).sort()).toEqual(
      [triggered.id, rerun.id, parent.id, child.id].sort(),
    );
    const byId = new Map(summaries.map((s) => [s.id, s]));
    expect(byId.get(triggered.id)?.triggerName).toBe('Every morning');
    expect(byId.get(rerun.id)?.triggerName).toBeNull();
    expect(byId.get(child.id)?.triggerName).toBeNull();
  });

  it('orders newest-first, breaking a startedAt tie by a TOTAL, stable key', () => {
    const { db, version } = setup();
    const oldest = createRun(db, buildRunInput(version.id));
    // FIVE tied runs, not two, so an accidental agreement is 1/120 rather than
    // a coin flip.
    const tied = [1, 2, 3, 4, 5].map(() => createRun(db, buildRunInput(version.id)));

    // Stamp the clock directly: `startedAt` is not patchable through the repo
    // (`RunLifecyclePatchSchema` is strict and omits it by design), and runs
    // created in the same millisecond is exactly the tie this order must break.
    db.update(runs).set({ startedAt: 1_000 }).where(eq(runs.id, oldest.id)).run();
    for (const run of tied) {
      db.update(runs).set({ startedAt: 5_000 }).where(eq(runs.id, run.id)).run();
    }

    const ordered = summariesOf(db).map((s) => s.id);
    // #1083 — the tie-break is now `id` DESC, not `rowid`, so the tied block
    // comes back in DESCENDING ID order rather than reverse-insertion order.
    // This test asserted the opposite before, and the reversal is deliberate:
    // `listRunSummariesPage`'s docblock has the argument (an implicit rowid can
    // be renumbered by VACUUM, and this order is now a CURSOR the client
    // replays). Sorting the expectation rather than hard-coding it is what
    // keeps the assertion about the ORDER instead of about the nanoids the
    // fixture happened to mint.
    //
    // What this pins is the property paging actually needs — a TOTAL, stable
    // order — and it fails if the tie-break is dropped to `startedAt` alone:
    // measured by deleting `desc(runs.id)` from `pageOrderDesc`'s call, 5/5 red.
    // That is a stronger guarantee than the version it replaces, which recorded
    // that it could NOT falsify a missing tie-break clause (SQLite's temp-b-tree
    // emitted rowid order anyway). The chronology within one millisecond is the
    // property genuinely given up, and it is given up knowingly.
    expect(ordered).toEqual(
      [...tied]
        .map((r) => r.id)
        .sort()
        .reverse()
        .concat(oldest.id),
    );
  });

  it('owner-scopes the list in SQL', () => {
    const { db, version } = setup();
    const mine = createRun(db, buildRunInput(version.id, { ownerId: 'local' }));
    createRun(db, buildRunInput(version.id, { ownerId: 'someone_else' }));

    const summaries = summariesOf(db, { ownerId: 'local' });
    expect(summaries.map((s) => s.id)).toEqual([mine.id]);
  });

  /**
   * U29 (#1015) — the row carries the pipeline's IDENTITY, not only its name.
   *
   * The cross-run timeline groups runs by pipeline, and `pipelineName` cannot
   * carry that: `pipelines` has a unique index on `(owner_id, resource_id)` and
   * none on `(owner_id, name)`, so two distinct pipelines may share a name.
   * Grouping by the name would merge them into one row of the chart — a chart
   * asserting that one pipeline was busy when two were. This is the consumer the
   * design doc's deferred `pipelineId` row was waiting for.
   */
  it('carries the pipeline id, so two same-named pipelines stay distinguishable', () => {
    const { db, version, pipeline } = setup();
    const twin = createPipeline(db, { ownerId: 'local', name: 'Nightly report' });
    const twinVersion = createPipelineVersion(db, {
      pipelineId: twin.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const mine = createRun(db, buildRunInput(version.id));
    const theirs = createRun(db, buildRunInput(twinVersion.id));

    const byId = new Map(summariesOf(db, { ownerId: 'local' }).map((r) => [r.id, r]));
    expect(byId.get(mine.id)?.pipelineName).toBe(byId.get(theirs.id)?.pipelineName);
    expect(byId.get(mine.id)?.pipelineId).toBe(pipeline.id);
    expect(byId.get(theirs.id)?.pipelineId).toBe(twin.id);
  });
});

/**
 * #1083 — the keyset walk itself. `GET /api/runs` was the last list route with
 * no `limit` and no `cursor`, over the one table with no retention policy.
 */
describe('listRunSummariesPage — keyset paging', () => {
  function setup(count: number) {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Nightly report' });
    const version = createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    // Distinct, DESCENDING-friendly stamps so "newest-first" is unambiguous and
    // the walk order is checkable without relying on a tie-break.
    const created = Array.from({ length: count }, (_, i) => {
      const run = createRun(db, buildRunInput(version.id));
      db.update(runs)
        .set({ startedAt: 1_000 + i * 1_000 })
        .where(eq(runs.id, run.id))
        .run();
      return run.id;
    });
    // Newest first — the order the walk must reproduce across its pages.
    return { db, version, newestFirst: [...created].reverse() };
  }

  /** Follows `nextCursor` to the end, returning every id seen and how many
   * requests it took — the walk a client actually performs. */
  function walk(db: ReturnType<typeof freshDb>['db'], limit: number) {
    const seen: string[] = [];
    let cursor: CursorKey | undefined;
    let pages = 0;
    for (;;) {
      const page = listRunSummariesPage(db, { ownerId: 'local' }, { limit, cursor });
      pages += 1;
      seen.push(...page.items.map((r) => r.id));
      if (page.nextCursor === null) return { seen, pages };
      // Through the real codec, exactly as the route does (`pageArgsFromQuery`):
      // the repo takes a decoded `CursorKey`, and the opaque string is the wire
      // form. Round-tripping it here is what makes this a walk a CLIENT could
      // perform rather than one only the repo's internals could.
      const key = decodeCursor(page.nextCursor);
      expect(key).not.toBeNull();
      cursor = key ?? undefined;
      // A non-advancing cursor would loop forever; fail loudly instead.
      expect(pages).toBeLessThan(20);
    }
  }

  it('returns one page newest-first, and a cursor only when older rows exist', () => {
    const { db, newestFirst } = setup(7);

    const first = listRunSummariesPage(db, { ownerId: 'local' }, { limit: 3 });
    expect(first.items.map((r) => r.id)).toEqual(newestFirst.slice(0, 3));
    expect(first.nextCursor).not.toBeNull();

    // The LAST page fits exactly, which is the fetch-one-extra probe's whole
    // point: a `nextCursor` here would promise an older page that does not
    // exist, and the reader would be offered a Load more that returns nothing.
    const exact = listRunSummariesPage(db, { ownerId: 'local' }, { limit: 7 });
    expect(exact.items).toHaveLength(7);
    expect(exact.nextCursor).toBeNull();
  });

  it('walks every row exactly once across pages, in one total order', () => {
    const { db, newestFirst } = setup(7);
    const { seen, pages } = walk(db, 3);
    // Not just "same set" — the same SEQUENCE, so a boundary that dropped or
    // repeated a row fails rather than being masked by a sort.
    expect(seen).toEqual(newestFirst);
    expect(pages).toBe(3);
  });

  it('neither drops nor duplicates a row when every row ties on startedAt', () => {
    const { db, version } = setup(0);
    const tied = Array.from({ length: 6 }, () => createRun(db, buildRunInput(version.id)));
    for (const run of tied) {
      db.update(runs).set({ startedAt: 5_000 }).where(eq(runs.id, run.id)).run();
    }

    const { seen } = walk(db, 2);
    // The tuple predicate `(started_at < c) OR (started_at = c AND id < i)` is
    // what makes this hold; a bare `started_at <` would return NOTHING after
    // page one, and a bare `id <` would drop rows across a stamp boundary.
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(seen).toEqual([...tied.map((r) => r.id)].sort().reverse());
  });

  it('keeps the owner scope and the filter axes on EVERY page, not just the first', () => {
    const { db, version } = setup(0);
    const mine: string[] = [];
    for (let i = 0; i < 6; i++) {
      const run = createRun(db, buildRunInput(version.id, { status: 'success' }));
      db.update(runs)
        .set({ startedAt: 1_000 + i * 1_000 })
        .where(eq(runs.id, run.id))
        .run();
      mine.push(run.id);
      // Interleaved so a leak would land MID-WALK, on page two — the case a
      // first-page-only assertion cannot see.
      const theirs = createRun(db, buildRunInput(version.id, { ownerId: 'someone_else' }));
      db.update(runs)
        .set({ startedAt: 1_500 + i * 1_000 })
        .where(eq(runs.id, theirs.id))
        .run();
      const failed = createRun(db, buildRunInput(version.id, { status: 'failure' }));
      db.update(runs)
        .set({ startedAt: 1_700 + i * 1_000 })
        .where(eq(runs.id, failed.id))
        .run();
    }

    const seen: string[] = [];
    let cursor: CursorKey | undefined;
    for (;;) {
      const page = listRunSummariesPage(
        db,
        { ownerId: 'local', status: 'success' },
        { limit: 2, cursor },
      );
      seen.push(...page.items.map((r) => r.id));
      if (page.nextCursor === null) break;
      cursor = decodeCursor(page.nextCursor) ?? undefined;
    }
    expect(seen).toEqual([...mine].reverse());
  });

  /**
   * The mutable-ordering-scalar case, pinned rather than argued. `started_at` is
   * re-stamped by `admitQueuedRun`, so unlike every other keyset list here the
   * order column can move under a walk in progress.
   *
   * The claim being fixed is the BOUND, not the absence of an effect: an
   * admission moves the row toward the HEAD, so a walk already past that point
   * MISSES it — and must never see it twice, and must never lose a different
   * row to it.
   */
  it('a run admitted mid-walk is skipped, never duplicated and never displaces another', () => {
    const { db, version } = setup(0);
    const older = Array.from({ length: 4 }, (_, i) => {
      const run = createRun(db, buildRunInput(version.id));
      db.update(runs)
        .set({ startedAt: 1_000 + i * 1_000 })
        .where(eq(runs.id, run.id))
        .run();
      return run.id;
    });
    // A queued run stamped at the OLDEST end, so page one cannot contain it.
    const queued = createRun(db, buildRunInput(version.id, { status: 'queued' }));
    db.update(runs).set({ startedAt: 500 }).where(eq(runs.id, queued.id)).run();

    const first = listRunSummariesPage(db, { ownerId: 'local' }, { limit: 2 });
    expect(first.items.map((r) => r.id)).toEqual([older[3], older[2]]);

    // Admission re-stamps `started_at` to NOW — far newer than the cursor, so
    // the row jumps above the page already read.
    expect(admitQueuedRun(db, queued.id)).not.toBeNull();

    const rest: string[] = [];
    let cursor =
      first.nextCursor === null ? undefined : (decodeCursor(first.nextCursor) ?? undefined);
    while (cursor !== undefined) {
      const page = listRunSummariesPage(db, { ownerId: 'local' }, { limit: 2, cursor });
      rest.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor === null ? undefined : (decodeCursor(page.nextCursor) ?? undefined);
    }

    const seen = [...first.items.map((r) => r.id), ...rest];
    // Skipped by THIS walk...
    expect(seen).not.toContain(queued.id);
    // ...and no row was seen twice or lost to it.
    expect(seen).toEqual(older.slice().reverse());
    // A fresh read finds it at the head, which is where a just-admitted run
    // belongs — the miss is confined to the walk that was already under way.
    const fresh = listRunSummariesPage(db, { ownerId: 'local' }, { limit: 2 });
    expect(fresh.items[0]!.id).toBe(queued.id);
  });
});

/**
 * U26 — the Monitor filter pane's server-side axes.
 *
 * `status` and `triggerId` already existed on `ListRunsFilter`; these tests pin
 * the two NEW ones and, more importantly, pin that every axis is ANDed rather
 * than replacing the owner scope. A filter that widens past `ownerId` is the
 * only way this feature could ever leak, so it is tested directly rather than
 * argued for in a docblock.
 */
describe('listRunSummaries — U26 filter axes', () => {
  function setup() {
    const { db } = freshDb();
    const reports = createPipeline(db, { ownerId: 'local', name: 'Reports' });
    const backups = createPipeline(db, { ownerId: 'local', name: 'Backups' });
    const versionOf = (pipelineId: string) =>
      createPipelineVersion(db, {
        pipelineId,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
    return {
      db,
      reports,
      backups,
      reportsV: versionOf(reports.id),
      backupsV: versionOf(backups.id),
    };
  }

  function at(db: ReturnType<typeof freshDb>['db'], id: string, startedAt: number) {
    db.update(runs).set({ startedAt }).where(eq(runs.id, id)).run();
  }

  it('filters by PIPELINE across every version of it, not by version id', () => {
    const { db, reports, reportsV, backupsV } = setup();
    const second = createPipelineVersion(db, {
      pipelineId: reports.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const v1Run = createRun(db, buildRunInput(reportsV.id));
    const v2Run = createRun(db, buildRunInput(second.id));
    createRun(db, buildRunInput(backupsV.id));

    // Both versions of Reports, and nothing from Backups. Filtering by
    // `pipelineVersionId` could never express this — that is the whole point of
    // the axis.
    expect(
      summariesOf(db, { pipelineId: reports.id })
        .map((s) => s.id)
        .sort(),
    ).toEqual([v1Run.id, v2Run.id].sort());
  });

  it('an unknown pipelineId matches nothing rather than everything', () => {
    const { db, reportsV } = setup();
    createRun(db, buildRunInput(reportsV.id));
    expect(summariesOf(db, { pipelineId: 'pl_does_not_exist' })).toEqual([]);
  });

  it('filters by startedAt lower bound, INCLUSIVE of the bound itself', () => {
    const { db, reportsV } = setup();
    const old = createRun(db, buildRunInput(reportsV.id));
    const onBound = createRun(db, buildRunInput(reportsV.id));
    const recent = createRun(db, buildRunInput(reportsV.id));
    at(db, old.id, 999);
    at(db, onBound.id, 1_000);
    at(db, recent.id, 5_000);

    // Inclusive: a window computed as `now - 1h` must include a run stamped
    // exactly an hour ago, or the boundary run flickers out of "the last hour"
    // on a millisecond.
    expect(
      summariesOf(db, { startedAfter: 1_000 })
        .map((s) => s.id)
        .sort(),
    ).toEqual([onBound.id, recent.id].sort());
  });

  it('ANDs every axis together, and none of them widens past the owner scope', () => {
    const { db, reports, reportsV, backupsV } = setup();
    const trigger = createTrigger(db, {
      ownerId: 'local',
      name: 'Nightly',
      pipelineVersionId: reportsV.id,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'skip_if_running' },
      runWindows: null,
      enabled: false,
    });
    const wanted = createRun(db, buildRunInput(reportsV.id, { triggerId: trigger.id }));
    // One near-miss per axis, so a dropped condition shows up as a specific
    // extra row rather than as a vague count change.
    const wrongStatus = createRun(db, buildRunInput(reportsV.id, { triggerId: trigger.id }));
    const wrongPipeline = createRun(db, buildRunInput(backupsV.id, { triggerId: trigger.id }));
    const noTrigger = createRun(db, buildRunInput(reportsV.id, { triggerId: null }));
    const tooOld = createRun(db, buildRunInput(reportsV.id, { triggerId: trigger.id }));
    // The one that matters: another owner's run that satisfies EVERY other axis.
    const otherOwner = createRun(
      db,
      buildRunInput(reportsV.id, { triggerId: trigger.id, ownerId: 'someone_else' }),
    );

    for (const id of [wanted.id, wrongPipeline.id, noTrigger.id, otherOwner.id]) {
      db.update(runs).set({ status: 'failure', startedAt: 5_000 }).where(eq(runs.id, id)).run();
    }
    db.update(runs)
      .set({ status: 'success', startedAt: 5_000 })
      .where(eq(runs.id, wrongStatus.id))
      .run();
    db.update(runs).set({ status: 'failure', startedAt: 10 }).where(eq(runs.id, tooOld.id)).run();

    expect(
      summariesOf(db, {
        ownerId: 'local',
        status: 'failure',
        pipelineId: reports.id,
        triggerId: trigger.id,
        startedAfter: 1_000,
      }).map((s) => s.id),
    ).toEqual([wanted.id]);
  });
});

/**
 * #896 — the primitive behind the double-rerun refusal. `findLiveRerunOf` answers
 * "does this source run ALREADY have a rerun that has not finished?", which is the
 * only thing standing between a remount-and-click-again and a second LLM bill.
 */
describe('runs repo — findLiveRerunOf (#896)', () => {
  /** Seed a rerun of `sourceId` sitting at `status`. */
  function seedRerun(
    db: ReturnType<typeof freshDb>['db'],
    pipelineVersionId: string,
    sourceId: string,
    status: RunStatus,
  ) {
    return createRun(db, buildRunInput(pipelineVersionId, { rerunOf: sourceId, status }));
  }

  it('finds nothing when the source run has no rerun at all', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const source = createRun(db, buildRunInput(version.id));
    expect(findLiveRerunOf(db, source.id)).toBeNull();
  });

  it.each(LIVE_RUN_STATUSES)('finds a rerun sitting at the LIVE status %s', (status) => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const source = createRun(db, buildRunInput(version.id));
    const rerun = seedRerun(db, version.id, source.id, status);
    expect(findLiveRerunOf(db, source.id)).toEqual({ id: rerun.id, status });
  });

  it.each(['success', 'failure', 'skipped', 'interrupted'] as const)(
    'ignores a rerun that has TERMINATED in %s — the guard bounds concurrency, not lifetime',
    (status) => {
      const { db } = freshDb();
      const version = setupPipelineVersion(db);
      const source = createRun(db, buildRunInput(version.id));
      seedRerun(db, version.id, source.id, status);
      expect(findLiveRerunOf(db, source.id)).toBeNull();
    },
  );

  it('does not confuse a live rerun of a DIFFERENT source run', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const mine = createRun(db, buildRunInput(version.id));
    const theirs = createRun(db, buildRunInput(version.id));
    seedRerun(db, version.id, theirs.id, 'running');
    expect(findLiveRerunOf(db, mine.id)).toBeNull();
  });

  it('picks the OLDEST live rerun deterministically when a pre-guard db holds several', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const source = createRun(db, buildRunInput(version.id));
    const first = seedRerun(db, version.id, source.id, 'running');
    seedRerun(db, version.id, source.id, 'waiting');
    seedRerun(db, version.id, source.id, 'running');
    expect(findLiveRerunOf(db, source.id)?.id).toBe(first.id);
  });

  /**
   * The list is written out rather than derived, because the obvious derivation is
   * WRONG: `TERMINAL_RUN_STATUS` is a set of `RunLifecycleStatus`, which has neither
   * `queued` nor `skipped` in it, so `!TERMINAL_RUN_STATUS.has(s)` answers `false`
   * for `skipped` and would quietly admit a terminal status into the live set. This
   * is the check that actually catches a newly-added `RunStatus`: a new option lands
   * in neither list and the union stops covering `RunStatusSchema`.
   */
  it('LIVE_RUN_STATUSES and the terminal statuses partition RunStatusSchema exactly', () => {
    const terminal: RunStatus[] = ['success', 'failure', 'skipped', 'interrupted'];
    expect([...LIVE_RUN_STATUSES, ...terminal].sort()).toEqual([...RunStatusSchema.options].sort());
  });
});
