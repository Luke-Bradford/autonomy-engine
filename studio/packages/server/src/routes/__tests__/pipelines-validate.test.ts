import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, ISSUE_LIST_CAP, type Node } from '@autonomy-studio/shared';
import { pipelineVersions } from '../../db/schema.js';
import { archivePipelineRow, createPipeline, createPipelineVersion } from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #1476 OR28 — `POST /api/pipelines/:id/validate`, the editor's Validate: the
 * save gate as a dry run. It must answer with what a SAVE would be refused
 * with, and write nothing.
 */
describe('POST /api/pipelines/:id/validate', () => {
  let app: FastifyInstance;

  function draft(nodes: Node[] = []) {
    return { params: [], outputs: [], nodes, edges: [], catalogVersion: CATALOG_VERSION };
  }

  const wait: Node = {
    id: 'a',
    type: 'wait',
    config: { seconds: '${1}' },
    position: { x: 0, y: 0 },
  };

  function newPipeline(ownerId = 'local') {
    return createPipeline(app.db, { ownerId, name: `Validate me ${ownerId}` }).id;
  }

  function validate(pipelineId: string, payload: unknown) {
    return app.inject({
      method: 'POST',
      url: `/api/pipelines/${pipelineId}/validate`,
      payload: payload as Record<string, unknown>,
    });
  }

  function versionRows(pipelineId: string) {
    return app.db
      .select({ id: pipelineVersions.id })
      .from(pipelineVersions)
      .where(eq(pipelineVersions.pipelineId, pipelineId))
      .all();
  }

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers no issues for a doc a save would accept, and writes no version', async () => {
    const pipelineId = newPipeline();
    const res = await validate(pipelineId, draft([wait]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issues: [], totalIssues: 0 });
    expect(versionRows(pipelineId)).toHaveLength(0);
  });

  it('answers with exactly the issues the save is refused with', async () => {
    const pipelineId = newPipeline();
    const doc = draft([{ ...wait, config: { seconds: '${params.nope}' } }]);
    const res = await validate(pipelineId, doc);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ issues: string[]; totalIssues: number }>();
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.totalIssues).toBe(body.issues.length);

    const save = await app.inject({
      method: 'POST',
      url: `/api/pipelines/${pipelineId}/versions`,
      payload: { ...doc, basedOnVersionId: null },
    });
    expect(save.statusCode).toBe(400);
    expect(save.json<{ issues: { message: string }[] }>().issues.map((i) => i.message)).toEqual(
      body.issues,
    );
    expect(versionRows(pipelineId)).toHaveLength(0);
  });

  it('reports what only the server can see: a call to a debug version', async () => {
    const pipelineId = newPipeline();
    const callee = newPipeline();
    const debugCallee = createPipelineVersion(
      app.db,
      { pipelineId: callee, ...draft() },
      {
        debug: true,
      },
    );
    const res = await validate(
      pipelineId,
      draft([
        {
          id: 'call',
          type: 'call_pipeline',
          config: {},
          position: { x: 0, y: 0 },
          call: { pipelineVersionId: debugCallee.id, params: {} },
        },
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<{ issues: string[] }>().issues).toEqual([
      expect.stringContaining(`cannot call debug version '${debugCallee.id}'`),
    ]);
    expect(versionRows(pipelineId)).toHaveLength(0);
  });

  it('caps the list and states the true total', async () => {
    const pipelineId = newPipeline();
    const nodes: Node[] = Array.from({ length: ISSUE_LIST_CAP + 5 }, (_, i) => ({
      ...wait,
      id: `n${String(i)}`,
      config: { seconds: `\${params.nope${String(i)}}` },
    }));
    const res = await validate(pipelineId, draft(nodes));
    expect(res.statusCode).toBe(200);
    const body = res.json<{ issues: string[]; totalIssues: number }>();
    expect(body.issues).toHaveLength(ISSUE_LIST_CAP);
    expect(body.totalIssues).toBe(ISSUE_LIST_CAP + 5);
  });

  it('checks an archived pipeline too: a dry run changes nothing', async () => {
    const pipelineId = newPipeline();
    archivePipelineRow(app.db, pipelineId);
    expect((await validate(pipelineId, draft([wait]))).statusCode).toBe(200);
    expect(versionRows(pipelineId)).toHaveLength(0);
  });

  it('400s a body that is not a pipeline doc', async () => {
    const pipelineId = newPipeline();
    expect((await validate(pipelineId, { nodes: 'nope' })).statusCode).toBe(400);
  });

  it('404s another owner’s pipeline', async () => {
    const pipelineId = newPipeline('someone-else');
    expect((await validate(pipelineId, draft())).statusCode).toBe(404);
  });
});
