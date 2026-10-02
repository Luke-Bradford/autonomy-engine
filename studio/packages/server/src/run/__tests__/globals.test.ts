import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  CATALOG_VERSION,
  GLOBAL_PARAM_MAX_BYTES,
  type EngineEvent,
  type GlobalParamType,
  type NewPipelineVersion,
  type Node,
} from '@autonomy-studio/shared';
import {
  createGlobalParam,
  deleteGlobalParam,
  updateGlobalParam,
} from '../../repo/global-params.js';
import { globalParams } from '../../db/schema.js';
import { createPipeline } from '../../repo/pipelines.js';
import {
  createPipelineVersion,
  getGlobalReads,
  getPipelineVersion,
  InvalidPipelineDocError,
} from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { listRunDiagnostics } from '../../repo/run-diagnostics.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { startRun, terminalizeInterrupted, type DocResolver, type DriveDeps } from '../driver.js';
import { appendEngineEvent, loadEngineEvents } from '../events.js';
import { createRunDrives } from '../drives.js';
import { createReseedService, RerunNotEligibleError } from '../reseed.js';
import { GlobalStartError, resolveRunGlobals } from '../globals.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';
import { STUB_SAVE_CATALOG } from '../../__tests__/stub-catalog.js';

/**
 * #844 GL3 (global-params spec GL-D3) — a version records the globals it reads
 * when it is saved, a run snapshots exactly those at its start, and a
 * rerun-from-failed copies its source's snapshot.
 */

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'test_activity', config, position: { x: seq, y: 0 } };
}

function global(db: Db, name: string, type: GlobalParamType, value: unknown, ownerId = 'local') {
  return createGlobalParam(db, { ownerId, name, type, value, description: '' });
}

function seedVersion(db: Db, nodes: Node[], ownerId = 'local'): string {
  const pipeline = createPipeline(db, { ownerId, name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input, { catalog: STUB_SAVE_CATALOG }).id;
}

function deps(db: Db, executorOpts: StubExecutorOptions = {}): DriveDeps {
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
    drives: createRunDrives(),
  };
}

function newRun(db: Db, pvId: string, ownerId = 'local') {
  return createRun(db, {
    ownerId,
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

function startedOf(db: Db, runId: string) {
  const ev = loadEngineEvents(db, runId).find((e) => e.type === 'run.started');
  return ev as Extract<EngineEvent, { type: 'run.started' }>;
}

describe('the save gate records what a version reads', () => {
  it('stores the reads, sorted and typed, and nothing it does not read', () => {
    const { db } = freshDb();
    global(db, 'zeta', 'string', 'z');
    global(db, 'apiUrl', 'string', 'https://x');
    global(db, 'unused', 'number', 1);
    const pvId = seedVersion(db, [
      node('a', { u: '${global.zeta}/${global.apiUrl}', v: '${global.apiUrl}' }),
    ]);
    expect(getGlobalReads(db, pvId)).toEqual([
      { name: 'apiUrl', type: 'string' },
      { name: 'zeta', type: 'string' },
    ]);
  });

  it('records an empty list for a version that reads none', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    expect(getGlobalReads(db, pvId)).toEqual([]);
    const raw = db.all<{ g: string | null }>(
      sql`select global_reads as g from pipeline_versions where id = ${pvId}`,
    );
    expect(raw[0]?.g).toBe('[]');
  });

  it('refuses a global the owner does not have, and another owner’s is not visible', () => {
    const { db } = freshDb();
    global(db, 'theirs', 'string', 'x', 'someone-else');
    expect(() => seedVersion(db, [node('a', { u: '${global.theirs}' })])).toThrow(
      InvalidPipelineDocError,
    );
    expect(() => seedVersion(db, [node('a', { u: '${global.nope}' })])).toThrow(
      /is not a global parameter of this workspace/,
    );
  });

  it('never offers a stored __proto__ to the gate', () => {
    const { db } = freshDb();
    // Written straight to the table: the create schema now refuses the name.
    db.insert(globalParams)
      .values({
        id: 'gp_x',
        ownerId: 'local',
        name: '__proto__',
        type: 'string',
        value: '"x"',
        description: '',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    expect(() => seedVersion(db, [node('a', { u: '${global.__proto__}' })])).toThrow(
      /is not a global parameter/,
    );
  });

  it('reads a pre-GL3 NULL column as none, and refuses to decode garbage', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    db.run(sql`drop trigger pipeline_versions_no_update`);
    db.run(sql`update pipeline_versions set global_reads = null where id = ${pvId}`);
    expect(getGlobalReads(db, pvId)).toEqual([]);
    db.run(sql`update pipeline_versions set global_reads = '[{"name":1}]' where id = ${pvId}`);
    expect(() => getGlobalReads(db, pvId)).toThrow();
    expect(() => resolveRunGlobals(db, { ownerId: 'local', pipelineVersionId: pvId })).toThrow();
  });

  it('is immutable, like every version column', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    let err: unknown;
    try {
      db.run(sql`update pipeline_versions set global_reads = '[]' where id = ${pvId}`);
    } catch (e) {
      err = e;
    }
    expect(String((err as Error | undefined)?.cause)).toMatch(
      /pipeline_versions are immutable: update is not allowed/,
    );
  });
});

describe('a run snapshots the globals its version reads', () => {
  it('logs exactly the recorded reads on run.started, and folds them', async () => {
    const { db } = freshDb();
    global(db, 'apiUrl', 'string', 'https://x');
    global(db, 'cfg', 'json', { k: [1] });
    global(db, 'other', 'string', 'not read');
    const pvId = seedVersion(db, [node('a', { u: '${global.apiUrl}', c: '${global.cfg.k}' })]);
    const run = newRun(db, pvId);
    const state = await startRun(deps(db), run);
    expect(state.status).toBe('success');
    expect(startedOf(db, run.id).globals).toEqual({ apiUrl: 'https://x', cfg: { k: [1] } });
    expect(state.globals).toEqual({ apiUrl: 'https://x', cfg: { k: [1] } });
  });

  it('logs no globals field for a version that reads none', async () => {
    const { db } = freshDb();
    global(db, 'apiUrl', 'string', 'https://x');
    const run = newRun(db, seedVersion(db, [node('a')]));
    await startRun(deps(db), run);
    expect('globals' in startedOf(db, run.id)).toBe(false);
  });

  it('reads the owner’s globals by the run’s owner', () => {
    const { db } = freshDb();
    global(db, 'apiUrl', 'string', 'mine');
    const pvId = seedVersion(db, [node('a', { u: '${global.apiUrl}' })]);
    expect(resolveRunGlobals(db, { ownerId: 'local', pipelineVersionId: pvId })).toEqual({
      apiUrl: 'mine',
    });
    expect(() => resolveRunGlobals(db, { ownerId: null, pipelineVersionId: pvId })).toThrow(
      GlobalStartError,
    );
  });

  it('refuses a start whose global was deleted, before any append, naming it', async () => {
    const { db } = freshDb();
    const g = global(db, 'apiUrl', 'string', 'https://x');
    const pvId = seedVersion(db, [node('a', { u: '${global.apiUrl}' })]);
    deleteGlobalParam(db, g.id);
    const run = newRun(db, pvId);
    let cause: unknown;
    await startRun(deps(db), run).catch((err: unknown) => {
      cause = err;
    });
    expect(cause).toBeInstanceOf(GlobalStartError);
    expect(loadEngineEvents(db, run.id)).toHaveLength(0);
    terminalizeInterrupted(deps(db), run.id, { cause });
    expect(getRun(db, run.id)?.status).toBe('interrupted');
    expect(listRunDiagnostics(db, run.id).map((d) => d.message)).toEqual([
      expect.stringMatching(/^The run did not start: global parameter "apiUrl" no longer exists/),
    ]);
  });

  // Deleted and created again under the same name with a new type, or under a
  // name differing only in case (a reference matches exactly).
  it('refuses a retyped global, and one recreated in another case', () => {
    const { db } = freshDb();
    const g = global(db, 'apiUrl', 'string', 'x');
    const pvId = seedVersion(db, [node('a', { u: '${global.apiUrl}' })]);
    deleteGlobalParam(db, g.id);
    const again = global(db, 'apiUrl', 'number', 3);
    expect(() => resolveRunGlobals(db, { ownerId: 'local', pipelineVersionId: pvId })).toThrow(
      /is now of type number, but this pipeline version reads it as string/,
    );
    deleteGlobalParam(db, again.id);
    global(db, 'APIURL', 'string', 'x');
    expect(() => resolveRunGlobals(db, { ownerId: 'local', pipelineVersionId: pvId })).toThrow(
      /"apiUrl" no longer exists/,
    );
  });

  it('refuses a version that does not exist, rather than read it as none', () => {
    const { db } = freshDb();
    expect(() => resolveRunGlobals(db, { ownerId: 'local', pipelineVersionId: 'pv_nope' })).toThrow(
      GlobalStartError,
    );
  });

  // The row decoder checks shape only, and `JSON.parse('1e400')` is Infinity,
  // which the log would store as null. It is refused as a START refusal, so
  // the run page and the run-now 400 can say why.
  it('refuses a stored non-finite value as a start refusal', () => {
    const { db } = freshDb();
    const g = global(db, 'n', 'number', 1);
    const pvId = seedVersion(db, [node('a', { u: '${global.n}' })]);
    db.run(sql`update global_params set value = '1e400' where id = ${g.id}`);
    expect(() => resolveRunGlobals(db, { ownerId: 'local', pipelineVersionId: pvId })).toThrow(
      GlobalStartError,
    );
  });

  it('refuses a snapshot over the bound: values can grow after the save', () => {
    const { db } = freshDb();
    const names = ['g1', 'g2', 'g3', 'g4', 'g5'];
    const big = 'x'.repeat(GLOBAL_PARAM_MAX_BYTES - 16);
    for (const n of names) global(db, n, 'string', 'small');
    const pvId = seedVersion(db, [node('a', { u: names.map((n) => `\${global.${n}}`).join('') })]);
    expect(resolveRunGlobals(db, { ownerId: 'local', pipelineVersionId: pvId })).toBeDefined();
    for (const g of db.select().from(globalParams).all()) {
      updateGlobalParam(db, g.id, { value: big });
    }
    expect(() => resolveRunGlobals(db, { ownerId: 'local', pipelineVersionId: pvId })).toThrow(
      /the limit is 262144/,
    );
  });
});

describe('a rerun-from-failed copies its source’s snapshot', () => {
  it('reuses the logged values after the global is edited, and after it is deleted', async () => {
    const { db } = freshDb();
    const g = global(db, 'apiUrl', 'string', 'old');
    const pvId = seedVersion(db, [node('a', { u: '${global.apiUrl}' })]);
    const r1 = newRun(db, pvId);
    await startRun(deps(db, { nodes: { a: { outcome: 'failure' } } }), r1);
    expect(getRun(db, r1.id)?.status).toBe('failure');

    updateGlobalParam(db, g.id, { value: 'new' });
    const svc = createReseedService(deps(db));
    const first = await svc.rerunFromFailed(r1.id);
    await first.drive;
    expect(startedOf(db, first.runId).globals).toEqual({ apiUrl: 'old' });

    // `first` has finished, so r1 may be rerun again; the global is now gone.
    deleteGlobalParam(db, g.id);
    const second = await svc.rerunFromFailed(r1.id);
    await second.drive;
    expect(startedOf(db, second.runId).globals).toEqual({ apiUrl: 'old' });
    expect(getRun(db, second.runId)?.status).toBe('success');
  });

  // CX2: a run cancelled before it started logged no `run.started`, so there is
  // no snapshot to copy and the rerun is a fresh start under the start check.
  it('takes a live snapshot for a source that never started, and refuses a gone global', async () => {
    const { db } = freshDb();
    const g = global(db, 'apiUrl', 'string', 'live');
    const pvId = seedVersion(db, [node('a', { u: '${global.apiUrl}' })]);
    const neverStarted = () => {
      const r = newRun(db, pvId);
      for (const e of [
        { type: 'run.cancelRequested', runId: r.id, source: { kind: 'operator' } },
        { type: 'run.finished', runId: r.id, outcome: 'cancelled', reason: 'cancelled:operator' },
      ] satisfies EngineEvent[]) {
        appendEngineEvent(db, e);
      }
      return r.id;
    };
    const src = neverStarted();
    const { runId, drive } = await createReseedService(deps(db)).rerunFromFailed(src);
    await drive;
    expect(startedOf(db, runId).globals).toEqual({ apiUrl: 'live' });

    deleteGlobalParam(db, g.id);
    await expect(createReseedService(deps(db)).rerunFromFailed(neverStarted())).rejects.toThrow(
      RerunNotEligibleError,
    );
  });
});
