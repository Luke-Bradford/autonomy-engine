import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type Node } from '@autonomy-studio/shared';
import {
  archivePipeline,
  createPipeline,
  createPipelineVersion,
  createRun,
  createTrigger,
} from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #1397 OR6 — `GET /api/pipelines/:id/dependents`, the read the delete
 * confirmation names its consequences from.
 */
describe('GET /api/pipelines/:id/dependents', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const version = (pipelineId: string, nodes: Node[] = [], debug = false) =>
    createPipelineVersion(
      app.db,
      {
        pipelineId,
        // Declared so a `${params.target}` call ref validates.
        params: [{ name: 'target', type: 'string', required: false }],
        outputs: [],
        nodes,
        edges: [],
        catalogVersion: CATALOG_VERSION,
      },
      debug ? { debug: true } : undefined,
    );

  const callNode = (id: string, pipelineVersionId: string): Node => ({
    id,
    type: 'call_pipeline',
    config: {},
    position: { x: 0, y: 0 },
    call: { pipelineVersionId, params: {} },
  });

  const trigger = (name: string, pipelineVersionId: string, enabled: boolean) =>
    createTrigger(app.db, {
      ownerId: 'local',
      name,
      pipelineVersionId,
      params: {},
      mode: 'schedule',
      schedule: '0 2 * * *',
      webhook: null,
      concurrency: { policy: 'skip_if_running' },
      runWindows: null,
      enabled,
    });

  const read = (id: string) => app.inject({ method: 'GET', url: `/api/pipelines/${id}/dependents` });

  it('names every bound trigger, enabled or not, across all of its versions', async () => {
    const target = createPipeline(app.db, { ownerId: 'local', name: 'Target' });
    const v1 = version(target.id);
    const v2 = version(target.id);
    const nightly = trigger('Nightly', v1.id, true);
    const paused = trigger('Paused', v2.id, false);

    const res = await read(target.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasRuns).toBe(false);
    expect(body.triggers).toEqual(
      expect.arrayContaining([
        { id: nightly.id, name: 'Nightly' },
        { id: paused.id, name: 'Paused' },
      ]),
    );
    expect(body.triggers).toHaveLength(2);
    expect(body.callers).toEqual([]);
    expect(body.dynamicCallers).toEqual([]);
  });

  it('names call_pipeline nodes in other pipelines that call one of its versions, literal and dynamic apart', async () => {
    const target = createPipeline(app.db, { ownerId: 'local', name: 'Child' });
    const v1 = version(target.id);
    const parent = createPipeline(app.db, { ownerId: 'local', name: 'Parent' });
    const parentVersion = version(parent.id, [callNode('callChild', v1.id)]);
    const router = createPipeline(app.db, { ownerId: 'local', name: 'Router' });
    version(router.id, [callNode('callAny', '${params.target}')]);
    // An archived caller cannot run, so it breaks nothing.
    const retired = createPipeline(app.db, { ownerId: 'local', name: 'Retired' });
    version(retired.id, [callNode('callChild', v1.id)]);
    archivePipeline(app.db, retired.id);
    // A self-call dies with the pipeline; it is not a dependant.
    version(target.id, [callNode('recurse', v1.id)]);

    const body = (await read(target.id)).json();
    expect(body.callers).toEqual([
      {
        pipelineId: parent.id,
        pipelineName: 'Parent',
        versionId: parentVersion.id,
        version: parentVersion.version,
        nodeId: 'callChild',
        nodeType: 'call_pipeline',
      },
    ]);
    expect(body.dynamicCallers.map((n: { pipelineName: string }) => n.pipelineName)).toContain(
      'Router',
    );
    expect(body.dynamicCallers.map((n: { pipelineId: string }) => n.pipelineId)).not.toContain(
      target.id,
    );
  });

  it('hasRuns counts a run of a DEBUG version — the FK refusing the delete does not care', async () => {
    const target = createPipeline(app.db, { ownerId: 'local', name: 'DebugOnly' });
    const debugVersion = version(target.id, [], true);
    createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId: debugVersion.id,
      triggerId: null,
      parentRunId: null,
      params: {},
    });

    expect((await read(target.id)).json().hasRuns).toBe(true);
    const del = await app.inject({ method: 'DELETE', url: `/api/pipelines/${target.id}` });
    expect(del.statusCode).toBe(409);
  });

  it('is owner-scoped: another owner’s pipeline is a 404', async () => {
    const theirs = createPipeline(app.db, { ownerId: 'someone-else', name: 'Theirs' });
    expect((await read(theirs.id)).statusCode).toBe(404);
  });
});
