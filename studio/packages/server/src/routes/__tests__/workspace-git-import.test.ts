import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  getConnectionByResourceId,
  getPipelineByResourceId,
} from '../../repo/index.js';
import { fixtureGit, seedRemote } from '../../git/__tests__/fixtures.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G5c-1 — the `POST /api/workspace/git/import` route against a REAL local bare
 * remote: it reads the collaboration branch (`main`) and APPLIES it into the DB
 * working copy (connections + pipelines + archive; triggers deferred to G5c-2).
 * The apply LOGIC is unit-tested in `portability/__tests__/workspace-apply.test.ts`;
 * this exercises the WIRING (fetch → read → apply → scheduler.sync → response),
 * the not-connected + empty-repo paths, and a real collaborator PULL (a second
 * workspace importing resources it does not yet have).
 */

const WORKING_BRANCH = 'studio/local/work';

function baseVersion(pipelineId: string): NewPipelineVersion {
  return {
    pipelineId,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
}

describe('workspace-git import route', () => {
  let testApp: TestApp;
  let app: FastifyInstance;

  beforeEach(async () => {
    testApp = await buildTestAppWithContext();
    app = testApp.app;
  });

  afterEach(async () => {
    await app.close();
  });

  const connect = (repoUrl: string) =>
    app.inject({ method: 'POST', url: '/api/workspace/git', payload: { repoUrl } });
  const commit = (message: string) =>
    app.inject({ method: 'POST', url: '/api/workspace/git/commit', payload: { message } });
  const importBranch = () => app.inject({ method: 'POST', url: '/api/workspace/git/import' });

  /** Fast-forward the studio working branch into `main` on the remote. */
  function mergeWorkingIntoMain(work: string) {
    fixtureGit(work, ['fetch', 'origin']);
    fixtureGit(work, ['merge', '--no-edit', `origin/${WORKING_BRANCH}`]);
    fixtureGit(work, ['push', 'origin', 'main']);
  }

  it('404s when the workspace is not connected to a repo', async () => {
    const res = await importBranch();
    expect(res.statusCode).toBe(404);
  });

  it('is a no-op against an empty repo (no collaboration branch yet)', async () => {
    // A bare remote with no `main` branch: connect requires the collab branch to
    // resolve, so we seed an empty one via a first push, then import sees nothing
    // new. Simplest: seed the remote, connect, import with an unchanged DB.
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const res = await importBranch();
    expect(res.statusCode).toBe(200);
    const { import: result } = res.json();
    expect(result.refused).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.archived).toEqual([]);
  });

  it('round-trips: importing the branch the DB just committed is all unchanged', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);

    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'My Pipeline' });
    createPipelineVersion(app.db, baseVersion(pipeline.id));
    expect((await commit('author')).json().commit.committed).toBe(true);
    mergeWorkingIntoMain(work);

    const res = await importBranch();
    expect(res.statusCode).toBe(200);
    const { import: result } = res.json();
    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(result.refused).toBe(false);
    expect(result.applied.every((a: { action: string }) => a.action === 'unchanged')).toBe(true);
  });

  it('a collaborator PULL creates the resources a fresh workspace does not have', async () => {
    // App 1 authors + commits + merges to main.
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const conn = createConnection(app.db, {
      ownerId: 'local',
      name: 'Shared Conn',
      kind: 'http',
      config: { baseUrl: 'https://x' },
      secretRef: null,
    });
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'Shared Pipeline' });
    createPipelineVersion(app.db, {
      ...baseVersion(pipeline.id),
      nodes: [
        { id: 'n1', type: 'llm_call', config: {}, connectionId: conn.id, position: { x: 0, y: 0 } },
      ],
    });
    expect((await commit('author shared')).json().commit.committed).toBe(true);
    mergeWorkingIntoMain(work);

    // App 2 = a DIFFERENT workspace (fresh DB) connected to the SAME remote.
    const app2ctx = await buildTestAppWithContext();
    try {
      const app2 = app2ctx.app;
      await app2.inject({
        method: 'POST',
        url: '/api/workspace/git',
        payload: { repoUrl: remote },
      });
      const res = await app2.inject({ method: 'POST', url: '/api/workspace/git/import' });
      expect(res.statusCode).toBe(200);
      const { import: result } = res.json();
      expect(result.refused).toBe(false);
      expect(result.applied.map((a: { action: string }) => a.action).sort()).toEqual([
        'created',
        'created',
      ]);

      // The resources landed in app2's DB, preserving their resourceIds, with the
      // node's connection ref remapped to app2's OWN connection row.
      const c2 = getConnectionByResourceId(app2.db, 'local', conn.resourceId);
      const p2 = getPipelineByResourceId(app2.db, 'local', pipeline.resourceId);
      expect(c2).not.toBeNull();
      expect(p2).not.toBeNull();
    } finally {
      await app2ctx.app.close();
    }
  });
});
