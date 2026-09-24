import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
  type RunEvent,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import type { Db } from '../../repo/types.js';
import { buildEngine, type DocResolver, type DriveDeps } from '../driver.js';
import { loadEngineEvents } from '../events.js';
import { createRunDrives } from '../drives.js';
import { createRunEventBus } from '../event-bus.js';
import { foldOutOfBand, publishThenDrive } from '../out-of-band.js';
import { makeStubExecutor } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

/**
 * #1021 — the shared out-of-band append. The four callers' own suites cover their
 * guards; this pins the two properties the helper now owns for all of them: the
 * fold lands the events and the row sync together, and the post-commit half
 * REFUSES to publish or drive while a transaction is open.
 */

const NODE: Node = { id: 'a', type: 'test_activity', config: {}, position: { x: 0, y: 0 } };

function seed(db: Db) {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [NODE],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  const pv = createPipelineVersion(db, input);
  const run = createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pv.id,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
  return { pv, run, engine: buildEngine(pv) };
}

function started(runId: string, pipelineVersionId: string): EngineEvent {
  return { type: 'run.started', runId, pipelineVersionId, params: {} };
}

function deps(db: Db, published: RunEvent[]): DriveDeps {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  const bus = createRunEventBus();
  bus.subscribeAll((e) => published.push(e));
  return {
    db,
    resolveDoc,
    executor: makeStubExecutor(),
    alarms: stubAlarms(),
    bus,
    drives: createRunDrives(),
  };
}

describe('#1021 foldOutOfBand', () => {
  it('appends the events in order, syncs the run row, and returns the records', () => {
    const { db } = freshDb();
    const { pv, run, engine } = seed(db);

    const out = db.transaction(() =>
      foldOutOfBand(db, engine, engine.seedState(), [started(run.id, pv.id)]),
    );

    expect(out.records.map((r) => r.type)).toEqual(['run.started']);
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).toEqual(['run.started']);
    expect(out.state.status).toBe('running');
    expect(getRun(db, run.id)?.status).toBe('running');
  });

  it('refuses events that span two runs, before appending any of them', () => {
    const { db } = freshDb();
    const one = seed(db);
    const two = seed(db);

    expect(() =>
      foldOutOfBand(db, one.engine, one.engine.seedState(), [
        started(one.run.id, one.pv.id),
        started(two.run.id, two.pv.id),
      ]),
    ).toThrow(/spans two runs/);
    expect(loadEngineEvents(db, one.run.id)).toEqual([]);
    expect(loadEngineEvents(db, two.run.id)).toEqual([]);
  });
});

describe('#1021 publishThenDrive', () => {
  it('publishes the committed records, then drives the run to its end', async () => {
    const { db } = freshDb();
    const { pv, run, engine } = seed(db);
    const published: RunEvent[] = [];
    const d = deps(db, published);

    const { records } = db.transaction(() =>
      foldOutOfBand(db, engine, engine.seedState(), [started(run.id, pv.id)]),
    );
    const drive = publishThenDrive(d, records);
    // Published synchronously, before the caller even awaits the drive.
    expect(published.map((r) => r.seq)).toEqual([records[0].seq]);

    await drive;
    expect(getRun(db, run.id)?.status).toBe('success');
    expect(published.at(-1)?.type).toBe('run.finished');
  });

  it('REFUSES inside an open transaction — synchronously, publishing nothing, rolling the transaction back', () => {
    const { db } = freshDb();
    const { pv, run, engine } = seed(db);
    const published: RunEvent[] = [];
    const d = deps(db, published);

    expect(() =>
      db.transaction(() => {
        const { records } = foldOutOfBand(db, engine, engine.seedState(), [
          started(run.id, pv.id),
        ]);
        void publishThenDrive(d, records);
      }),
    ).toThrow(/transaction open/);
    expect(published).toEqual([]);
    // The throw was synchronous, so it rolled back the append it sat beside.
    expect(loadEngineEvents(db, run.id)).toEqual([]);
  });

  it('fails CLOSED on a handle that cannot say whether a transaction is open', () => {
    const { db } = freshDb();
    const { pv, run, engine } = seed(db);
    const published: RunEvent[] = [];

    // A drizzle transaction handle carries no `$client` — probed naively, it would
    // read as "no transaction open".
    db.transaction((tx) => {
      const { records } = foldOutOfBand(tx, engine, engine.seedState(), [
        started(run.id, pv.id),
      ]);
      expect(() => publishThenDrive({ ...deps(db, published), db: tx }, records)).toThrow(
        /cannot say/,
      );
    });
    expect(published).toEqual([]);
  });
});
