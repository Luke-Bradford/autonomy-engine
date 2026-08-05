/**
 * RS2 — the LIVE rerun-from-failed PRODUCER (`createReseedService`).
 *
 * End-to-end against a REAL db + reducer + driver (stub executor only, the
 * unavoidable I/O): build a genuinely FAILED source run R1, rerun-from-failed it,
 * and assert R2's log is the atomic reseed pair, that R2 resumes BEYOND the
 * frontier (copied successes are NOT re-dispatched), and the eligibility /
 * params-reuse / triggerContext-replay contracts.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Edge,
  type EdgeOn,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
  type Param,
  type RunStatus,
  type TriggerContext,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { DocUnresolvableError, startRun, type DocResolver, type DriveDeps } from '../driver.js';
import { loadEngineEvents } from '../events.js';
import { createRunDrives } from '../drives.js';
import { createRunEventBus, type RunEventBus } from '../event-bus.js';
import { createReseedService, RerunNotEligibleError } from '../reseed.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string): Node {
  seq += 1;
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 } };
}
function edge(from: string, to: string, on: EdgeOn = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}

function seedVersion(db: Db, nodes: Node[], edges: Edge[] = [], params: Param[] = []): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params,
    outputs: [],
    nodes,
    edges,
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function deps(db: Db, executorOpts: StubExecutorOptions = {}, bus?: RunEventBus): DriveDeps {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  return {
    db,
    resolveDoc,
    executor: makeStubExecutor(executorOpts),
    alarms: stubAlarms(),
    bus,
    drives: createRunDrives(),
  };
}

function types(events: EngineEvent[]): string[] {
  return events.map((e) => e.type);
}

/** Build + drive a source run to REST (terminal or hung), returning its id. */
async function seedRun(
  db: Db,
  pvId: string,
  executorOpts: StubExecutorOptions,
  opts: { params?: Record<string, unknown>; triggerContext?: TriggerContext } = {},
): Promise<string> {
  // triggerId stays null (no real trigger row to satisfy the FK); the trigger
  // context rides the LOG (`startRun` appends the `run.triggerContext` EVENT from
  // the passed context), which is the SSOT the producer replays from — never the
  // row's column.
  const run = createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId: null,
    params: opts.params ?? {},
  });
  try {
    await startRun(deps(db, executorOpts), run, opts.triggerContext);
  } catch {
    // A hung node leaves the run `running` — that is the state we want for the
    // "not terminated" eligibility case; startRun does not throw on it, but guard
    // anyway so an unexpected fault does not mask the assertion under test.
  }
  return run.id;
}

describe('RS2 producer — end-to-end rerun-from-failed', () => {
  it('appends the atomic reseed pair, copies the frontier, and resumes BEYOND it', async () => {
    const { db } = freshDb();
    // a→b→c, b fails permanently in R1 → a success, b failure, c skipped.
    const pvId = seedVersion(
      db,
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('b', 'c')],
    );
    const r1 = await seedRun(db, pvId, { nodes: { b: { outcome: 'failure' } } });
    expect(getRun(db, r1)!.status).toBe('failure');

    // Rerun with an executor where b now SUCCEEDS. R2 drives in the BACKGROUND —
    // await `drive` to observe its terminal outcome.
    const svc = createReseedService(deps(db, {}));
    const { runId: r2, drive } = await svc.rerunFromFailed(r1);
    await drive;

    const r2Events = loadEngineEvents(db, r2);
    // The reseed pair is the head of R2's log (no triggerContext — a manual R1).
    expect(types(r2Events).slice(0, 2)).toEqual(['run.started', 'run.reseeded']);
    const started = r2Events[0] as Extract<EngineEvent, { type: 'run.started' }>;
    expect(started.rerunOf).toBe(r1);
    const reseeded = r2Events[1] as Extract<EngineEvent, { type: 'run.reseeded' }>;
    expect(reseeded.sourceRunId).toBe(r1);
    expect(reseeded.frontier).toEqual(['a']); // only a succeeded

    // a was COPIED (never re-dispatched); b + c re-ran.
    const dispatched = r2Events
      .filter(
        (e): e is Extract<EngineEvent, { type: 'node.dispatched' }> => e.type === 'node.dispatched',
      )
      .map((e) => e.nodeId);
    expect(dispatched).not.toContain('a');
    expect(dispatched).toEqual(['b', 'c']);

    // R2 succeeded this time; the copied `a` output is present in the projection.
    expect(getRun(db, r2)!.status).toBe('success');
    // RS6 — the durable ROW lineage matches the event-log lineage.
    expect(getRun(db, r2)!.rerunOf).toBe(r1);
  });

  it('commits the reseed pair contiguously and syncs the row off `pending` (end-state)', async () => {
    // An END-STATE check of the atomicity invariant (not a fault-injection test):
    // fault-atomicity rests on the visible `db.transaction` wrapper + the
    // savepoint-nested `appendAndFold`, the shipped `external-wait-service` pattern.
    // Here we assert the observable happy-path property: the row is never left
    // `pending` with a log, and the log carries the reseed pair CONTIGUOUSLY (a
    // `run.started{rerunOf}` is immediately followed by `run.reseeded` — never a
    // lone half-state) even before the background drive is awaited.
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    const r1 = await seedRun(db, pvId, { nodes: { a: { outcome: 'failure' } } });

    const svc = createReseedService(deps(db, {}));
    const { runId: r2, drive } = await svc.rerunFromFailed(r1); // assert BEFORE the drive

    expect(getRun(db, r2)!.status).not.toBe('pending');
    // RS6 — the row's `rerunOf` is written in the SAME tx as the reseed pair, so
    // it is set the moment the row is observable (before the background drive).
    expect(getRun(db, r2)!.rerunOf).toBe(r1);
    const t = types(loadEngineEvents(db, r2));
    const startedIdx = t.indexOf('run.started');
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(t[startedIdx + 1]).toBe('run.reseeded');
    await drive; // let the background drive settle before the test ends
  });

  it('reuses R1 params EXACTLY (no override) and pins the same version', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('a'), node('b')],
      [edge('a', 'b')],
      [{ name: 'p', type: 'string', required: false, default: 'd' }],
    );
    const r1 = await seedRun(
      db,
      pvId,
      { nodes: { b: { outcome: 'failure' } } },
      { params: { p: 'x' } },
    );

    const svc = createReseedService(deps(db, {}));
    const { runId: r2, drive } = await svc.rerunFromFailed(r1);
    await drive;

    const r2Row = getRun(db, r2)!;
    expect(r2Row.params).toEqual({ p: 'x' });
    expect(r2Row.pipelineVersionId).toBe(getRun(db, r1)!.pipelineVersionId);
    expect(r2Row.triggerId).toBeNull();
    expect(r2Row.parentRunId).toBeNull();
    const started = loadEngineEvents(db, r2)[0] as Extract<EngineEvent, { type: 'run.started' }>;
    expect(started.params).toEqual({ p: 'x' });
  });

  it('replays R1 run.triggerContext VERBATIM (swapped runId) so ${trigger.*} reuses R1 facts', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    const triggerContext: TriggerContext = {
      triggerId: 'trg1',
      scheduledTime: '2026-07-24T00:00:00.000Z',
      body: { hello: 'world' },
    };
    const r1 = await seedRun(
      db,
      pvId,
      { nodes: { b: { outcome: 'failure' } } },
      { triggerContext },
    );

    const svc = createReseedService(deps(db, {}));
    const { runId: r2, drive } = await svc.rerunFromFailed(r1);
    await drive;

    const r2Events = loadEngineEvents(db, r2);
    expect(types(r2Events).slice(0, 3)).toEqual([
      'run.triggerContext',
      'run.started',
      'run.reseeded',
    ]);
    const tctx = r2Events[0] as Extract<EngineEvent, { type: 'run.triggerContext' }>;
    expect(tctx.runId).toBe(r2);
    expect(tctx.triggerId).toBe('trg1');
    expect(tctx.scheduledTime).toBe('2026-07-24T00:00:00.000Z');
    expect(tctx.body).toEqual({ hello: 'world' });
  });

  it('publishes the reseed pair to the live-tail bus AFTER commit', async () => {
    const { db } = freshDb();
    const bus = createRunEventBus();
    const seen: string[] = [];
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    const r1 = await seedRun(db, pvId, { nodes: { b: { outcome: 'failure' } } });

    const svc = createReseedService(deps(db, {}, bus));
    // Subscribe to R2 before it exists is impossible; subscribe to ALL.
    const unsub = bus.subscribeAll((e) => {
      if (e.type === 'run.started' || e.type === 'run.reseeded') seen.push(e.type);
    });
    const { drive } = await svc.rerunFromFailed(r1);
    unsub();
    expect(seen).toEqual(['run.started', 'run.reseeded']);
    await drive;
  });
});

describe('RS2 producer — eligibility guards', () => {
  it('rejects a MISSING source run (no event log)', async () => {
    const { db } = freshDb();
    const svc = createReseedService(deps(db, {}));
    await expect(svc.rerunFromFailed('run_nope')).rejects.toBeInstanceOf(RerunNotEligibleError);
  });

  it('rejects a run that did NOT terminate (still running)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    // `hang` on a leaves the run `running` (dispatched, no terminal event).
    const r1 = await seedRun(db, pvId, { nodes: { a: { hang: true } } });
    expect(getRun(db, r1)!.status).toBe('running');

    const svc = createReseedService(deps(db, {}));
    await expect(svc.rerunFromFailed(r1)).rejects.toThrow(/not terminated/);
  });

  it('rejects a SUCCESSFUL run (nothing to resume from)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    const r1 = await seedRun(db, pvId, {}); // all succeed
    expect(getRun(db, r1)!.status).toBe('success');

    const svc = createReseedService(deps(db, {}));
    await expect(svc.rerunFromFailed(r1)).rejects.toThrow(/succeeded/);
  });

  it('propagates DocUnresolvableError when the pinned version no longer resolves (→ 409)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    const r1 = await seedRun(db, pvId, { nodes: { b: { outcome: 'failure' } } });
    // A deps whose resolveDoc refuses the version (a deleted/unparseable immutable
    // version — the FK RESTRICT blocks actually deleting one under a run, so inject
    // the throw the real `makeDocResolver` would raise).
    const brokenDeps: DriveDeps = {
      ...deps(db, {}),
      resolveDoc: () => {
        throw new DocUnresolvableError(`pipeline version '${pvId}' not found`);
      },
    };
    const svc = createReseedService(brokenDeps);
    await expect(svc.rerunFromFailed(r1)).rejects.toBeInstanceOf(DocUnresolvableError);
  });
});

/**
 * #896 — one live rerun per source run. The client's in-flight flag is component
 * state on a page keyed by run id, so a navigate-away-and-back mid-flight brings
 * the button back live and a second click bills a second rerun. The refusal lives
 * HERE, where a remount, a second tab and a bare `curl` all have to pass it.
 *
 * The existing rerun is SEEDED as a row rather than produced by calling the
 * service twice: R2 drives in the background and settles on its own schedule, so
 * racing it would make the assertion depend on scheduler timing. Seeding pins the
 * one fact under test — the status of a rerun that already exists.
 */
describe('RS2 producer — the double-rerun guard (#896)', () => {
  /** A failed R1 plus a rerun of it parked at `status`. */
  async function failedRunWithRerunAt(db: Db, status: RunStatus) {
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    const r1 = await seedRun(db, pvId, { nodes: { b: { outcome: 'failure' } } });
    const r2 = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: {},
      rerunOf: r1,
      status,
    });
    return { pvId, r1, r2 };
  }

  it('refuses a second rerun while the first is still RUNNING, and names it', async () => {
    const { db } = freshDb();
    const { r1, r2 } = await failedRunWithRerunAt(db, 'running');

    const svc = createReseedService(deps(db, {}));
    await expect(svc.rerunFromFailed(r1)).rejects.toBeInstanceOf(RerunNotEligibleError);
    await expect(svc.rerunFromFailed(r1)).rejects.toThrow(
      new RegExp(`already in progress \\('${r2.id}', running\\)`),
    );
  });

  /**
   * The case that discriminates this guard's status set from `ACTIVE_RUN_STATUSES`
   * (`repo/runs.ts`), which deliberately excludes `waiting` because a PARKED run
   * does not occupy a trigger's concurrency slot. It is still unfinished, and its
   * remaining nodes are still unbilled — so reusing that set here would let exactly
   * the double-spend this guard exists to stop through.
   */
  it('refuses while the first rerun is parked WAITING on an external event', async () => {
    const { db } = freshDb();
    const { r1 } = await failedRunWithRerunAt(db, 'waiting');

    const svc = createReseedService(deps(db, {}));
    await expect(svc.rerunFromFailed(r1)).rejects.toThrow(/already in progress/);
  });

  it('ALLOWS a second rerun once the first has terminated — this bounds concurrency, not lifetime', async () => {
    const { db } = freshDb();
    const { r1 } = await failedRunWithRerunAt(db, 'failure');

    const svc = createReseedService(deps(db, {}));
    const { runId, drive } = await svc.rerunFromFailed(r1);
    await drive;
    expect(getRun(db, runId)!.rerunOf).toBe(r1);
  });

  it('is scoped to ONE source run — a live rerun of a different run does not block', async () => {
    const { db } = freshDb();
    const { pvId } = await failedRunWithRerunAt(db, 'running');
    const mine = await seedRun(db, pvId, { nodes: { b: { outcome: 'failure' } } });

    const svc = createReseedService(deps(db, {}));
    const { runId, drive } = await svc.rerunFromFailed(mine);
    await drive;
    expect(getRun(db, runId)!.rerunOf).toBe(mine);
  });

  /**
   * The guard sits BEFORE the transaction, on the argument that nothing in
   * `rerunFromFailed` awaits between the check and `createRun` — so two calls
   * cannot interleave and an early check is as atomic as an in-tx one. That is an
   * argument about the code's shape, and this is the test that makes it falsifiable
   * rather than a comment: fire two reruns of the same source with no scheduling
   * gap between them and require that exactly ONE is created. If a suspension point
   * is ever introduced into that path, both calls will pass the check and this goes
   * red — which is precisely when someone needs to be told.
   */
  it('admits exactly one of two rerun calls issued with no gap between them', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    const r1 = await seedRun(db, pvId, { nodes: { b: { outcome: 'failure' } } });

    const svc = createReseedService(deps(db, {}));
    const settled = await Promise.allSettled([svc.rerunFromFailed(r1), svc.rerunFromFailed(r1)]);

    const won = settled.filter((s) => s.status === 'fulfilled');
    const lost = settled.filter((s) => s.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(RerunNotEligibleError);
    await (won[0] as PromiseFulfilledResult<{ runId: string; drive: Promise<void> }>).value.drive;
  });

  /**
   * Ordering matters: the duplicate is the ACTIONABLE message ("your rerun is
   * already running"), so it must win over a resolve failure of the pinned version,
   * which tells the operator nothing they can act on while a rerun is in flight.
   */
  it('reports the duplicate BEFORE a version-resolution failure', async () => {
    const { db } = freshDb();
    const { r1 } = await failedRunWithRerunAt(db, 'running');
    const brokenDeps: DriveDeps = {
      ...deps(db, {}),
      resolveDoc: () => {
        throw new DocUnresolvableError('pipeline version not found');
      },
    };
    const svc = createReseedService(brokenDeps);
    await expect(svc.rerunFromFailed(r1)).rejects.toBeInstanceOf(RerunNotEligibleError);
  });
});
