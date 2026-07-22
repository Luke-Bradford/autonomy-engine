import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  buildDedupeKey,
  CATALOG_VERSION,
  type EngineEvent,
  type Edge,
  type NewPipelineVersion,
  type Node,
  type RunState,
  type ScheduledWakeup,
  type WakeupRef,
} from '@autonomy-studio/shared';
import { runEvents } from '../../db/schema.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { armWakeup, getWakeupByKey } from '../../repo/scheduled-wakeups.js';
import type { Db } from '../../repo/types.js';
import {
  DocUnresolvableError,
  startRun,
  WAIT_WAKEUP_KIND,
  type DocResolver,
  type DriveDeps,
} from '../../run/driver.js';
import { createRunDrives } from '../../run/drives.js';
import { appendEngineEvent, loadEngineEvents } from '../../run/events.js';
import { makeStubExecutor } from '../../run/__tests__/stub-executor.js';
import {
  containerActiveGuard,
  createDurableAlarmHandler,
  nodeParkedAtAttemptGuard,
  type DurableAlarmConfig,
} from '../durable-alarm-handler.js';
import type { WakeupDelivery } from '../alarms.js';

/**
 * #585 — the shared durable-alarm handler skeleton, tested DIRECTLY. The four real
 * kinds keep their own integration suites ({retry,wait,external-wait,container-
 * timeout}-alarm.test.ts) as the equivalence proof; this pins the seam's own
 * contract, above all the `settleSideEffect` CALL-POINT ASYMMETRY (the single
 * subtlest behavior the extraction had to preserve): it fires on terminal-suppress,
 * on stale (layer-2) suppress, and on fire — but NOT on `run_not_found`,
 * `doc_unresolvable`, or the #642 corrupt-read suppressions
 * (`ref_unparseable`/`run_events_unparseable`/`run_unparseable`).
 */

const NOW = 1_700_000_000_000;

const WaitRef = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
});

let seq = 0;
function waitNode(id: string, seconds: string): Node {
  seq += 1;
  return { id, type: 'wait', config: { seconds }, position: { x: seq, y: 0 } };
}

function seedVersion(db: Db, nodes: Node[], edges: Edge[] = []): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges,
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function seedRun(db: Db, pvId: string) {
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

function deps(db: Db, resolveOverride?: DocResolver): DriveDeps {
  const resolveDoc: DocResolver =
    resolveOverride ??
    ((id) => {
      const pv = getPipelineVersion(db, id);
      if (pv === null) throw new DocUnresolvableError(`no pv ${id}`);
      return pv;
    });
  return {
    db,
    resolveDoc,
    executor: makeStubExecutor(),
    alarms: {
      arm: (i) => armWakeup(db, i),
      find: (i) => getWakeupByKey(db, i.kind, buildDedupeKey(i)),
    },
    drives: createRunDrives(),
    now: () => NOW,
  };
}

/** A synthetic config over a real `wait` node so `appendAndFold` + the reducer accept
 * the due event, with a SPY `settleSideEffect` to assert the call-point contract. */
function spyConfig(): {
  config: DurableAlarmConfig<{ runId: string; nodeId: string; attemptId: string }>;
  settle: ReturnType<typeof vi.fn>;
} {
  const settle = vi.fn();
  const config: DurableAlarmConfig<{ runId: string; nodeId: string; attemptId: string }> = {
    kind: WAIT_WAKEUP_KIND,
    refSchema: WaitRef,
    checkFreshness: nodeParkedAtAttemptGuard('wait_pending', 'node_not_parked_at_attempt'),
    buildDueEvent: (ref): EngineEvent => ({
      type: 'timer.due',
      runId: ref.runId,
      nodeId: ref.nodeId,
      previousAttemptId: ref.attemptId,
    }),
    settleSideEffect: (_tx, ref) => settle(ref),
  };
  return { config, settle };
}

function alarmRow(ref: WakeupRef): ScheduledWakeup {
  return {
    id: 'wku_test',
    kind: WAIT_WAKEUP_KIND,
    ref,
    dueAt: NOW,
    dedupeKey: 'test',
    status: 'pending',
    supersededBy: null,
    firedAt: null,
  };
}
const delivery: WakeupDelivery = { scheduledFor: NOW, firedAt: NOW, latenessMs: 0 };

/** Park a single `wait` node at attempt `w#0` and return the run id. */
async function parkedWaitRun(db: Db): Promise<string> {
  const pvId = seedVersion(db, [waitNode('w', '${30}')]);
  const run = seedRun(db, pvId);
  await startRun(deps(db), run);
  return run.id;
}

describe('#585 createDurableAlarmHandler — the shared skeleton', () => {
  it('FIRES: appends the due event, calls settleSideEffect once, returns fired + afterCommit', async () => {
    const { db } = freshDb();
    const runId = await parkedWaitRun(db);
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db), config);

    const ref = { runId, nodeId: 'w', attemptId: 'w#0' };
    const result = handler.fire(alarmRow(ref), delivery, db);

    expect(result.status).toBe('fired');
    expect(result.status === 'fired' && result.events).toHaveLength(1);
    expect(result.status === 'fired' && typeof result.afterCommit).toBe('function');
    expect(loadEngineEvents(db, runId).filter((e) => e.type === 'timer.due')).toHaveLength(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(ref);
  });

  it('SUPPRESSES run_already_terminal AND calls settleSideEffect (the #580 orphan-cleanup point)', async () => {
    const { db } = freshDb();
    const runId = await parkedWaitRun(db);
    appendEngineEvent(db, { type: 'run.interrupted', runId, reason: 'drive_failed' });
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db), config);

    const result = handler.fire(alarmRow({ runId, nodeId: 'w', attemptId: 'w#0' }), delivery, db);

    expect(result).toMatchObject({ status: 'suppressed', reason: 'run_already_terminal' });
    expect(settle).toHaveBeenCalledTimes(1);
    // No due event appended on a suppress.
    expect(loadEngineEvents(db, runId).filter((e) => e.type === 'timer.due')).toHaveLength(0);
  });

  it('SUPPRESSES a stale (wrong-attempt) delivery AND calls settleSideEffect', async () => {
    const { db } = freshDb();
    const runId = await parkedWaitRun(db);
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db), config);

    // Node is parked at w#0; the alarm names a different attempt → stale.
    const result = handler.fire(alarmRow({ runId, nodeId: 'w', attemptId: 'w#99' }), delivery, db);

    expect(result).toMatchObject({ status: 'suppressed', reason: 'node_not_parked_at_attempt' });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(loadEngineEvents(db, runId).filter((e) => e.type === 'timer.due')).toHaveLength(0);
  });

  it('SUPPRESSES run_not_found and does NOT call settleSideEffect (asymmetry, half 1)', () => {
    const { db } = freshDb();
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db), config);

    const result = handler.fire(
      alarmRow({ runId: 'run_ghost', nodeId: 'w', attemptId: 'w#0' }),
      delivery,
      db,
    );

    expect(result).toMatchObject({ status: 'suppressed', reason: 'run_not_found' });
    expect(settle).not.toHaveBeenCalled();
  });

  it('SUPPRESSES doc_unresolvable and does NOT call settleSideEffect (asymmetry, half 2)', async () => {
    const { db } = freshDb();
    const runId = await parkedWaitRun(db);
    const gone: DocResolver = () => {
      throw new DocUnresolvableError('version deleted');
    };
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db, gone), config);

    const result = handler.fire(alarmRow({ runId, nodeId: 'w', attemptId: 'w#0' }), delivery, db);

    expect(result).toMatchObject({ status: 'suppressed', reason: 'doc_unresolvable' });
    expect(settle).not.toHaveBeenCalled();
  });

  // #642 — the poison-pending class (#637's, on the run surface): a PERMANENTLY
  // corrupt stored row (hand-edit/legacy-drift) throws the same way on every
  // tick, so treating it as a transient blip re-fires + error-logs forever.
  // Suppress with a distinct reason; settleSideEffect stays UNCALLED (the
  // run_not_found/doc_unresolvable asymmetry extended to the corrupt reads).
  it('#642 SUPPRESSES run_events_unparseable on a schema-corrupt event payload; no settleSideEffect', async () => {
    const { db } = freshDb();
    const runId = await parkedWaitRun(db);
    // The log is APPEND-ONLY (a DB trigger blocks UPDATE), so the honest
    // hand-edit/legacy-drift vector is a corrupt APPENDED row: valid JSON,
    // wrong shape — EngineEventSchema rejects it (ZodError).
    db.insert(runEvents)
      .values({
        id: 'evt_poison',
        runId,
        seq: 999,
        type: 'not.an.engine.event',
        payload: { type: 'not.an.engine.event' },
        ts: NOW,
      })
      .run();
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db), config);

    const result = handler.fire(alarmRow({ runId, nodeId: 'w', attemptId: 'w#0' }), delivery, db);

    expect(result).toMatchObject({ status: 'suppressed', reason: 'run_events_unparseable' });
    expect(settle).not.toHaveBeenCalled();
  });

  it('#642 SUPPRESSES run_events_unparseable on an invalid-JSON payload cell (SyntaxError, the #515 codec boundary)', async () => {
    const { db } = freshDb();
    const runId = await parkedWaitRun(db);
    // Drizzle's json codec is a bare JSON.parse at row mapping — invalid TEXT
    // throws SyntaxError BEFORE the schema is reached (#515's second half).
    // Raw INSERT (the log's UPDATE is trigger-blocked; append is the vector).
    db.run(
      sql`INSERT INTO run_events (id, run_id, seq, type, payload, ts)
          VALUES ('evt_poison', ${runId}, 999, 'x', 'not json', ${NOW})`,
    );
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db), config);

    const result = handler.fire(alarmRow({ runId, nodeId: 'w', attemptId: 'w#0' }), delivery, db);

    expect(result).toMatchObject({ status: 'suppressed', reason: 'run_events_unparseable' });
    expect(settle).not.toHaveBeenCalled();
  });

  it('#642 SUPPRESSES run_unparseable on a corrupt run row; no settleSideEffect', async () => {
    const { db } = freshDb();
    const runId = await parkedWaitRun(db);
    // `status` carries a SQL CHECK, so corrupt a non-CHECKed column the schema
    // types as number: the table is not STRICT, so SQLite stores the text and
    // RunSchema.parse rejects it (ZodError). Events stay valid — the log read
    // and the layer-1 terminal check pass first, pinning the ORDER of reads.
    db.run(sql`UPDATE runs SET started_at = 'yesterday' WHERE id = ${runId}`);
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db), config);

    const result = handler.fire(alarmRow({ runId, nodeId: 'w', attemptId: 'w#0' }), delivery, db);

    expect(result).toMatchObject({ status: 'suppressed', reason: 'run_unparseable' });
    expect(settle).not.toHaveBeenCalled();
    // No due event appended on a suppress (the log is readable here — pin it).
    expect(loadEngineEvents(db, runId).filter((e) => e.type === 'timer.due')).toHaveLength(0);
  });

  it('#642 SUPPRESSES ref_unparseable on a stored ref that fails the kind schema; no settleSideEffect', async () => {
    const { db } = freshDb();
    const runId = await parkedWaitRun(db);
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db), config);

    // A valid string-record missing the kind's required key (a renamed/legacy
    // ref shape) — survives the clock's scan-time WakeupRefSchema but fails
    // WaitRef here. (Invalid JSON in the ref CELL never reaches this handler:
    // it kills the tick at the scan — named in the module doc, follow-up #646.)
    const result = handler.fire(alarmRow({ runId, nodeId: 'w' }), delivery, db);

    expect(result).toMatchObject({ status: 'suppressed', reason: 'ref_unparseable' });
    expect(settle).not.toHaveBeenCalled();
    // No due event appended on a suppress (the log is readable here — pin it).
    expect(loadEngineEvents(db, runId).filter((e) => e.type === 'timer.due')).toHaveLength(0);
  });

  it('#642 RETHROWS a genuine DB read fault from the log read (transient blip → alarm stays pending)', async () => {
    const { db } = freshDb();
    const runId = await parkedWaitRun(db);
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db), config);
    // A REAL SqliteError through the REAL read path (no stub): drop the table,
    // so `listRunEvents` throws a driver fault — neither ZodError nor
    // SyntaxError — pinning the transient half of the #642 classification at
    // the new catch site (a passing blip must NOT be suppressed as corruption).
    db.run(sql`DROP TABLE run_events`);

    expect(() =>
      handler.fire(alarmRow({ runId, nodeId: 'w', attemptId: 'w#0' }), delivery, db),
    ).toThrow(/no such table/);
    expect(settle).not.toHaveBeenCalled();
  });

  it('RETHROWS a non-DocUnresolvable resolve fault (transient blip → alarm stays pending)', async () => {
    const { db } = freshDb();
    const runId = await parkedWaitRun(db);
    const blip: DocResolver = () => {
      throw new Error('db read timed out');
    };
    const { config, settle } = spyConfig();
    const handler = createDurableAlarmHandler(deps(db, blip), config);

    expect(() =>
      handler.fire(alarmRow({ runId, nodeId: 'w', attemptId: 'w#0' }), delivery, db),
    ).toThrow('db read timed out');
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('#585 guard factories — pure freshness verdicts', () => {
  it('nodeParkedAtAttemptGuard: fresh only when the node exists, matches status AND attempt', () => {
    const guard = nodeParkedAtAttemptGuard('wait_pending', 'node_not_parked_at_attempt');
    const withNode = (status: string, attempt: string): RunState =>
      ({
        nodes: { w: { status, currentAttemptId: attempt } },
        containers: {},
      }) as unknown as RunState;

    expect(guard(withNode('wait_pending', 'w#0'), { nodeId: 'w', attemptId: 'w#0' })).toEqual({
      fresh: true,
    });
    // wrong status
    expect(guard(withNode('success', 'w#0'), { nodeId: 'w', attemptId: 'w#0' })).toEqual({
      fresh: false,
      reason: 'node_not_parked_at_attempt',
    });
    // wrong attempt
    expect(guard(withNode('wait_pending', 'w#1'), { nodeId: 'w', attemptId: 'w#0' })).toEqual({
      fresh: false,
      reason: 'node_not_parked_at_attempt',
    });
    // missing node
    expect(guard(withNode('wait_pending', 'w#0'), { nodeId: 'x', attemptId: 'w#0' })).toEqual({
      fresh: false,
      reason: 'node_not_parked_at_attempt',
    });
  });

  it('containerActiveGuard: fresh only when the container exists and is active', () => {
    const guard = containerActiveGuard('container_not_active');
    const withContainer = (status: string): RunState =>
      ({ nodes: {}, containers: { c: { status } } }) as unknown as RunState;

    expect(guard(withContainer('active'), { containerId: 'c' })).toEqual({ fresh: true });
    expect(guard(withContainer('failure'), { containerId: 'c' })).toEqual({
      fresh: false,
      reason: 'container_not_active',
    });
    expect(guard(withContainer('active'), { containerId: 'missing' })).toEqual({
      fresh: false,
      reason: 'container_not_active',
    });
  });
});
