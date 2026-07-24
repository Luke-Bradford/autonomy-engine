import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, createTrigger } from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G6a — the workspace-audit READ route + the DB-only (no git) audit writers.
 * The git-path writers (repo.connected / import.applied) are covered against a
 * real remote in `workspace-git.test.ts` / `workspace-git-import.test.ts`; this
 * file covers the surfaces that need no git: the empty read (must NOT 404 with
 * no connection) and `pipeline.archived` from the manual archive route.
 */
describe('workspace-audit route (#3 G6a)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const audit = () => app.inject({ method: 'GET', url: '/api/workspace/audit' });
  const archive = (id: string) =>
    app.inject({ method: 'POST', url: `/api/pipelines/${id}/archive` });

  function seedBoundEnabledTrigger(pipelineId: string) {
    const version = createPipelineVersion(app.db, {
      pipelineId,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    return createTrigger(app.db, {
      ownerId: 'local',
      name: 'Nightly',
      pipelineVersionId: version.id,
      params: {},
      mode: 'schedule',
      schedule: '0 2 * * *',
      webhook: null,
      concurrency: { policy: 'skip_if_running' },
      runWindows: null,
      enabled: true,
    });
  }

  it('returns an empty page (never 404) when there is no git connection and no history', async () => {
    const res = await audit();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it('a manual archive appends pipeline.archived — WITHOUT any git connection (DB-only)', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'Db Only' });
    const trigger = seedBoundEnabledTrigger(pipeline.id);
    expect((await archive(pipeline.id)).statusCode).toBe(200);

    const events = audit().then((r) => r.json().items);
    const items = await events;
    expect(items).toHaveLength(1);
    expect(items[0].payload).toEqual({
      type: 'pipeline.archived',
      resourceId: pipeline.resourceId,
      name: 'Db Only',
      disabledTriggerIds: [trigger.id],
      by: 'local',
    });
  });

  it('re-archiving an already-archived pipeline does NOT double-emit (idempotent)', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'Twice' });
    expect((await archive(pipeline.id)).statusCode).toBe(200);
    expect((await archive(pipeline.id)).statusCode).toBe(200);

    const items = (await audit()).json().items as { payload: { type: string } }[];
    expect(items.filter((e) => e.payload.type === 'pipeline.archived')).toHaveLength(1);
  });

  it('paginates the audit log with the shared cursor (?limit + nextCursor)', async () => {
    // Three archives → three pipeline.archived events, in append order.
    const ids = [
      createPipeline(app.db, { ownerId: 'local', name: 'A' }).id,
      createPipeline(app.db, { ownerId: 'local', name: 'B' }).id,
      createPipeline(app.db, { ownerId: 'local', name: 'C' }).id,
    ];
    for (const id of ids) expect((await archive(id)).statusCode).toBe(200);

    const page1 = (await app.inject({ method: 'GET', url: '/api/workspace/audit?limit=2' })).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    // seq is the append order — oldest first.
    expect(page1.items.map((e: { seq: number }) => e.seq)).toEqual([0, 1]);

    const page2 = (
      await app.inject({
        method: 'GET',
        url: `/api/workspace/audit?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      })
    ).json();
    expect(page2.items.map((e: { seq: number }) => e.seq)).toEqual([2]);
    expect(page2.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor as a 400 (fail-closed, never silent first-page)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/audit?cursor=not-a-real-cursor',
    });
    expect(res.statusCode).toBe(400);
  });
});
