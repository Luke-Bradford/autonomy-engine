import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Edge,
  type NewPipelineVersion,
  type Node,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { buildEngine, startRun, type DocResolver, type DriverDeps } from '../driver.js';
import { makeStubExecutor } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

/**
 * #844 V2 — a run reads `${vars.<name>}` from the STORED version: the column
 * (V1) → `buildEngine` → the reducer's seed. `buildEngine` is the one seam
 * every server path binds an engine through, so it is the one to pin.
 */

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 }, ...extra };
}
function branchEdge(from: string, to: string, branch: string): Edge {
  return { id: `${from}->${to}:${branch}`, from, to, on: 'branch', branch };
}

function seedVersion(db: Db, flag: boolean): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    variables: [{ name: 'flag', type: 'boolean', default: flag }],
    nodes: [
      node('gate', { type: 'if', config: { condition: '${vars.flag}' } }),
      node('yes'),
      node('no'),
    ],
    edges: [branchEdge('gate', 'yes', 'true'), branchEdge('gate', 'no', 'false')],
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function deps(db: Db): DriverDeps {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  return { db, resolveDoc, executor: makeStubExecutor(), alarms: stubAlarms() };
}

describe('driver — ${vars.<name>} (#844 V2)', () => {
  it.each([
    [true, 'yes', 'no'],
    [false, 'no', 'yes'],
  ])('routes an if on a variable default of %s', async (flag, taken, dead) => {
    const { db } = freshDb();
    const pvId = seedVersion(db, flag);
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('success');
    expect(state.variables).toEqual({ flag });
    expect(state.nodes[taken]!.status).toBe('success');
    expect(state.nodes[dead]!.status).toBe('skipped');
  });

  it('buildEngine seeds the stored defaults', () => {
    const { db } = freshDb();
    const engine = buildEngine(getPipelineVersion(db, seedVersion(db, true))!);
    expect(engine.seedState().variables).toEqual({ flag: true });
  });
});
