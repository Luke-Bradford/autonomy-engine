import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Container,
  type Edge,
  type Node,
  type NewPipelineVersion,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import {
  listRunDiagnostics,
  recordRunDiagnostics,
  RUN_DIAGNOSTIC_CAP,
} from '../../repo/run-diagnostics.js';
import { runDiagnostics } from '../../db/schema.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { buildEngine, startRun, type DocResolver, type DriverDeps } from '../driver.js';
import { makeStubExecutor } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

/**
 * #497 — the reducer's `diagnostics` reach a durable, readable sink.
 *
 * These drive the REAL driver over the REAL reducer and assert on what is
 * actually in the table afterwards. The point of the ticket is a SEAM (the
 * reducer derived diagnostics correctly; nothing carried them anywhere), so a
 * test that stubbed either side would pass on the broken code.
 *
 * The docs used here are DELIBERATELY malformed. That is not a contrivance: a
 * diagnostic means the bind neutralized something the author wrote, so a
 * well-formed doc emits none at all. #444's write gate refuses these at the
 * door now, which is exactly why they are built through the repo layer (as a
 * pre-gate row would have been) rather than posted.
 */

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string): Node {
  seq += 1;
  // Uncatalogued on purpose — see the same factory in `driver.test.ts`. Keeps
  // the output contract `absent` so a well-formed run's `{}` payload is not
  // failed against a catalog contract F13b/#456 would lower into a known type
  // (which would record a spurious "missing declared output" diagnostic here).
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 } };
}

/**
 * A PRE-#444 row: a malformed doc written straight to the table, under the
 * write gate.
 *
 * Raw SQL, and necessarily so. `createPipelineVersion` now runs `validateDoc`
 * and REFUSES every doc below (#444), and `pipeline_versions` is immutable
 * (0002's `no_update` trigger `RAISE(ABORT)`s), so a valid-then-mutated row is
 * impossible too. That leaves a direct insert — which is exactly what the rows
 * this code path exists for ARE: written before the gate existed, never
 * validated by anything.
 */
function seedRawVersion(
  sqlite: ReturnType<typeof freshDb>['sqlite'],
  nodes: Node[],
  edges: Edge[] = [],
  containers: Container[] = [],
): string {
  const pipeId = `pipe_${++seq}`;
  const pvId = `pv_${seq}`;
  sqlite
    .prepare(
      'INSERT INTO pipelines (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
    )
    .run(pipeId, 'local', 'P');
  sqlite
    .prepare(
      `INSERT INTO pipeline_versions
         (id, pipeline_id, version, params, outputs, nodes, edges, containers, catalog_version, created_at)
       VALUES (?, ?, 1, '[]', '[]', ?, ?, ?, ?, 1)`,
    )
    .run(
      pvId,
      pipeId,
      JSON.stringify(nodes),
      JSON.stringify(edges),
      JSON.stringify(containers),
      CATALOG_VERSION,
    );
  return pvId;
}

/** A WELL-FORMED version, through the real repo layer + its #444 gate. */
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

function deps(db: Db): DriverDeps {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  return { db, resolveDoc, executor: makeStubExecutor(), alarms: stubAlarms() };
}

describe('#497 — the reducer diagnostics sink', () => {
  it("records a ghost container child's docDefect (#487) against the run.started fold", async () => {
    const { db, sqlite } = freshDb();
    // `ghost` is not a node in this pipeline — the bind neutralizes it (#487)
    // and reports. Before #497 that report went nowhere.
    const pvId = seedRawVersion(
      sqlite,
      [node('n1')],
      [],
      [{ id: 'c1', kind: 'stage', children: ['n1', 'ghost'] }],
    );
    const run = seedRun(db, pvId);

    await startRun(deps(db), run);

    const found = listRunDiagnostics(db, run.id);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain(
      "container 'c1': child 'ghost' is not a node in this pipeline and is IGNORED",
    );
    // `run.started` is seq 0, and this is a FOLD of it — not a resume.
    expect(found[0]!.seq).toBe(0);
    expect(found[0]!.phase).toBe('fold');
    expect(found[0]!.ordinal).toBe(0);
  });

  it('records nothing for a well-formed run — a diagnostic means something was neutralized', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('a'), node('b')],
      [{ id: 'a->b', from: 'a', to: 'b', on: 'success' }],
    );
    const run = seedRun(db, pvId);

    await startRun(deps(db), run);

    expect(listRunDiagnostics(db, run.id)).toEqual([]);
  });

  it("records #491's stalledEntities — the run says WHICH entities wedged it, not just that it stalled", async () => {
    const { db, sqlite } = freshDb();
    // A forward cycle: nothing can ever become ready, so #491's backstop
    // terminalizes the run as failure{stalled} and names the stuck entities.
    // `validateDoc` refuses this doc, so it is written UNDER the gate — the
    // pre-#444 row this backstop exists for.
    const pvId = seedRawVersion(
      sqlite,
      [node('x'), node('y')],
      [
        { id: 'x->y', from: 'x', to: 'y', on: 'success' },
        { id: 'y->x', from: 'y', to: 'x', on: 'success' },
      ],
    );
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);
    expect(state.status).toBe('failure');

    const messages = listRunDiagnostics(db, run.id).map((d) => d.message);
    const stall = messages.find((m) => m.startsWith('run stalled'));
    expect(stall).toBeDefined();
    // The whole point of the ticket: the ids are now readable, not written to
    // nowhere. `failure{reason:'stalled'}` alone could never say which.
    expect(stall).toContain('never-terminal: {x, y}');
  });

  it('caps per RUN and states the truncation rather than silently dropping the tail', async () => {
    const { db, sqlite } = freshDb();
    // One doc, many defects: `CAP + 50` ghost children, all reported in ONE
    // `run.started` fold. A per-fold cap would bound this list; only a per-run
    // cap bounds the run.
    const ghosts = Array.from({ length: RUN_DIAGNOSTIC_CAP + 50 }, (_, i) => `ghost${i}`);
    const pvId = seedRawVersion(
      sqlite,
      [node('n1')],
      [],
      [{ id: 'c1', kind: 'stage', children: ['n1', ...ghosts] }],
    );
    const run = seedRun(db, pvId);

    await startRun(deps(db), run);

    const found = listRunDiagnostics(db, run.id);
    const real = found.filter((d) => d.phase !== 'cap');
    expect(real).toHaveLength(RUN_DIAGNOSTIC_CAP);

    // Truncation is STATED — an absent fact must never be manufactured as "that
    // was all of them" (the F13a/#473 rule).
    const marker = found.filter((d) => d.phase === 'cap');
    expect(marker).toHaveLength(1);
    expect(marker[0]!.message).toContain(`reached the cap of ${RUN_DIAGNOSTIC_CAP}`);
    // It sorts FIRST, so a reader learns the list is incomplete before reading it.
    expect(found[0]!.phase).toBe('cap');
  });

  it('is idempotent at a log position: re-deriving the same fold does not duplicate', async () => {
    const { db, sqlite } = freshDb();
    const pvId = seedRawVersion(
      sqlite,
      [node('n1')],
      [],
      [{ id: 'c1', kind: 'stage', children: ['n1', 'ghost'] }],
    );
    const run = seedRun(db, pvId);
    await startRun(deps(db), run);
    expect(listRunDiagnostics(db, run.id)).toHaveLength(1);

    // Re-derive the SAME fold at the SAME log position, as a re-boot or an
    // at-least-once alarm redelivery would. The doc is immutable and the reducer
    // pure, so the messages are identical and the UNIQUE key absorbs them.
    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    const re = engine.reduce(engine.seedState(), {
      type: 'run.started',
      runId: run.id,
      pipelineVersionId: pvId,
      startedAt: new Date(run.startedAt).toISOString(),
      params: {},
    });
    recordRunDiagnostics(db, run.id, 0, 'fold', re.diagnostics);

    expect(listRunDiagnostics(db, run.id)).toHaveLength(1);
  });

  it("keys a resume apart from the fold at the same seq — 'phase' is what stops them splicing", () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('n1')]);
    const run = seedRun(db, pvId);

    // The real collision: `retry-alarm.ts` appends `node.retryDue` at seq N and
    // folds it, then its afterCommit drives → `resume()` over a projection whose
    // max seq IS N. Two different derivations, same log position.
    recordRunDiagnostics(db, run.id, 7, 'fold', ['from the fold of seq 7']);
    recordRunDiagnostics(db, run.id, 7, 'resume', ['from the resume as of seq 7']);

    const found = listRunDiagnostics(db, run.id);
    expect(found.map((d) => [d.phase, d.message])).toEqual([
      ['fold', 'from the fold of seq 7'],
      ['resume', 'from the resume as of seq 7'],
    ]);
  });

  it('does not falsely mark truncation when a large batch is re-derived (idempotency vs the cap)', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('n1')]);
    const run = seedRun(db, pvId);

    // A single derivation just under the cap. On the FIRST record, headroom is
    // full, so all are kept and NO marker is written.
    const batch = Array.from({ length: RUN_DIAGNOSTIC_CAP - 100 }, (_, i) => `msg ${i}`);
    recordRunDiagnostics(db, run.id, 3, 'fold', batch);
    expect(listRunDiagnostics(db, run.id).filter((d) => d.phase === 'cap')).toHaveLength(0);

    // Re-derive the SAME batch at the SAME position, as a re-boot would. A naive
    // "count all rows" would see its own 400 rows, compute headroom 100, keep a
    // prefix, and FALSELY stamp a complete list as truncated. Excluding this
    // batch's own rows is what stops that.
    recordRunDiagnostics(db, run.id, 3, 'fold', batch);

    const found = listRunDiagnostics(db, run.id);
    expect(found.filter((d) => d.phase !== 'cap')).toHaveLength(RUN_DIAGNOSTIC_CAP - 100);
    expect(found.filter((d) => d.phase === 'cap')).toHaveLength(0);
  });

  it('never lets a sink failure break the drive it is explaining', async () => {
    const { db, sqlite } = freshDb();
    const pvId = seedRawVersion(
      sqlite,
      [node('n1')],
      [],
      [{ id: 'c1', kind: 'stage', children: ['n1', 'ghost'] }],
    );
    const run = seedRun(db, pvId);

    // Pull the table out from under the recorder mid-drive. A diagnostic is an
    // EXPLANATION of a decision, never the decision — it must not be able to
    // take down the thing it explains.
    sqlite.prepare('DROP TABLE run_diagnostics').run();
    const errors: unknown[] = [];
    const state = await startRun({ ...deps(db), log: { error: (obj) => errors.push(obj) } }, run);

    expect(state.status).toBe('success');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('cascades with its run: an explanation cannot outlive its subject', () => {
    const { db, sqlite } = freshDb();
    const pvId = seedVersion(db, [node('n1')]);
    const run = seedRun(db, pvId);
    recordRunDiagnostics(db, run.id, 0, 'fold', ['something was neutralized']);
    expect(listRunDiagnostics(db, run.id)).toHaveLength(1);

    sqlite.prepare('DELETE FROM runs WHERE id = ?').run(run.id);

    expect(db.select().from(runDiagnostics).all()).toEqual([]);
  });
});
