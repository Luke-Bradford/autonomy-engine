import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  createTrigger,
  getConnectionByResourceId,
  getLatestPipelineVersion,
  getPipelineByResourceId,
  getTriggerByResourceId,
} from '../../repo/index.js';
import { fixtureGit, seedRemote } from '../../git/__tests__/fixtures.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G5c — the `POST /api/workspace/git/import` route against a REAL local bare
 * remote: it reads the collaboration branch (`main`) and APPLIES it into the DB
 * working copy (connections + pipelines + archive + triggers, G5c-2 #670).
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

  /** Commit an oversized (>1 MiB) managed `.json` to `main` — a `git show` of it
   * overflows the provider's collected-output cap, so the reader cannot read it
   * (#664). Not valid JSON content: the read fails BEFORE any parse. */
  function pushOversizedManagedFile(work: string) {
    mkdirSync(join(work, 'pipelines'), { recursive: true });
    writeFileSync(
      join(work, 'pipelines/huge.json'),
      JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }),
    );
    fixtureGit(work, ['add', '.']);
    fixtureGit(work, ['commit', '-m', 'oversized managed file']);
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

  it('#664 — an oversized managed file REFUSES the import as a diagnostic, never a 502', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);
    pushOversizedManagedFile(work);

    const res = await importBranch();
    // Read failure degrades to a per-file diagnostic → fail-closed refuse, not 502.
    expect(res.statusCode).toBe(200);
    const { import: result } = res.json();
    expect(result.refused).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: 'pipelines/huge.json', code: 'unreadable' }),
    );
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

    // #3 G6a — an all-unchanged re-import is a no-op: it appends NO
    // import.applied (only the earlier repo.connected is in the log; Commit is
    // not itself an audit event in G6a).
    const audit = await app.inject({ method: 'GET', url: '/api/workspace/audit' });
    expect(
      (audit.json().items as { payload: { type: string } }[]).map((e) => e.payload.type),
    ).toEqual(['repo.connected']);
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
    const version = createPipelineVersion(app.db, {
      ...baseVersion(pipeline.id),
      nodes: [
        { id: 'n1', type: 'llm_call', config: {}, connectionId: conn.id, position: { x: 0, y: 0 } },
      ],
    });
    // #3 G5c-2 — a trigger too, so the real wiring (fetch → read → apply →
    // scheduler.sync) is exercised for a bound, enabled schedule trigger.
    const trigger = createTrigger(app.db, {
      ownerId: 'local',
      name: 'Shared Nightly',
      pipelineVersionId: version.id,
      params: {},
      mode: 'schedule',
      schedule: '0 2 * * *',
      webhook: null,
      concurrency: { policy: 'skip_if_running' },
      runWindows: null,
      enabled: true,
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
      // connection + pipeline + trigger all created; no resource is deferred.
      expect(result.applied.map((a: { action: string }) => a.action).sort()).toEqual([
        'created',
        'created',
        'created',
      ]);
      expect(result.deferred).toHaveLength(0);

      // The resources landed in app2's DB, preserving their resourceIds, with the
      // node's connection ref remapped to app2's OWN connection row.
      const c2 = getConnectionByResourceId(app2.db, 'local', conn.resourceId);
      const p2 = getPipelineByResourceId(app2.db, 'local', pipeline.resourceId)!;
      expect(c2).not.toBeNull();
      expect(p2).not.toBeNull();
      // The trigger landed too, bound to app2's OWN version row (remapped), enabled.
      const t2 = getTriggerByResourceId(app2.db, 'local', trigger.resourceId)!;
      expect(t2).not.toBeNull();
      const v2 = getLatestPipelineVersion(app2.db, p2.id)!;
      expect(t2.pipelineVersionId).toBe(v2.id);
      expect(t2.enabled).toBe(true);

      // #3 G6a — the effectful import appended ONE import.applied audit event
      // (app2's log: repo.connected then import.applied), carrying the commit
      // provenance + the full write manifest.
      const audit2 = await app2.inject({ method: 'GET', url: '/api/workspace/audit' });
      const events2 = audit2.json().items as { payload: Record<string, unknown> }[];
      expect(events2.map((e) => e.payload['type'])).toEqual(['repo.connected', 'import.applied']);
      const applied = events2[1]!.payload as {
        head: string;
        branch: string;
        applied: unknown[];
        by: string;
      };
      expect(applied.head).toMatch(/^[0-9a-f]{40}$/);
      expect(applied.branch).toBe('main');
      expect(applied.applied).toHaveLength(3);
      expect(applied.by).toBe('local');
    } finally {
      await app2ctx.app.close();
    }
  });
});
