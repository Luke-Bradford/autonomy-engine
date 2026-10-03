import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  archivePipelineRow,
  createPipeline,
  createPipelineVersion,
  getWorkspaceGit,
  updateWorkspaceGitSync,
} from '../../repo/index.js';
import { checkoutDirFor } from '../../git/checkout.js';
import { pushNewCommit, seedRemote } from '../../git/__tests__/fixtures.js';
import {
  buildTestAppWithContext,
  type TestApp,
} from '../../__tests__/build-test-app.js';

/**
 * #1476 OR28 — `POST /api/workspace/git/sync`, the editor badge's git read,
 * against a REAL local bare remote. What it adds over `/drift` + `/divergence`
 * is the refresh policy (fetch only when the last one is older than
 * `gitFetchMaxAgeMs`, or the checkout is gone) and the per-pipeline map, so
 * those are what these pin.
 */
describe('workspace-git sync route', () => {
  let testApp: TestApp;
  let app: FastifyInstance;

  async function boot(gitFetchMaxAgeMs: number) {
    testApp = await buildTestAppWithContext({ gitFetchMaxAgeMs });
    app = testApp.app;
  }

  afterEach(async () => {
    await app.close();
  });

  const connect = (repoUrl: string) =>
    app.inject({ method: 'POST', url: '/api/workspace/git', payload: { repoUrl } });
  const commit = (message: string) =>
    app.inject({ method: 'POST', url: '/api/workspace/git/commit', payload: { message } });
  const importBranch = () => app.inject({ method: 'POST', url: '/api/workspace/git/import' });
  const sync = async () => {
    const res = await app.inject({ method: 'POST', url: '/api/workspace/git/sync' });
    expect(res.statusCode).toBe(200);
    return res.json().sync;
  };

  function version(pipelineId: string, prompt = 'hi'): NewPipelineVersion {
    return {
      pipelineId,
      params: [],
      outputs: [],
      nodes: [{ id: 'n1', type: 'llm_call', config: { prompt }, position: { x: 0, y: 0 } }],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
  }

  it('404s when the workspace has no git connection', async () => {
    await boot(60_000);
    const res = await app.inject({ method: 'POST', url: '/api/workspace/git/sync' });
    expect(res.statusCode).toBe(404);
  });

  it('names a changed pipeline by its row id, at once, without fetching inside the window', async () => {
    await boot(60_000);
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const p = createPipeline(app.db, { ownerId: 'local', name: 'Orders' });
    createPipelineVersion(app.db, version(p.id));

    // Connect cloned, so the copy is fresh: no fetch, and the new pipeline is
    // reported against the row id the editor knows it by, not its resourceId.
    const first = await sync();
    expect(first.fetched).toBe(false);
    expect(first.pipelines).toEqual([{ pipelineId: p.id, change: 'added' }]);
    expect(first.hasUncommittedChanges).toBe(true);

    expect((await commit('add orders')).statusCode).toBe(200);
    const clean = await sync();
    expect(clean.pipelines).toEqual([]);
    expect(clean.hasUncommittedChanges).toBe(false);

    // A save is local: it shows as uncommitted on the next read, fetch or not.
    createPipelineVersion(app.db, version(p.id, 'changed'));
    const saved = await sync();
    expect(saved.fetched).toBe(false);
    expect(saved.pipelines).toEqual([{ pipelineId: p.id, change: 'modified' }]);
  });

  it('does not fetch inside the window, so a push to main is not seen yet', async () => {
    await boot(60_000);
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);
    await importBranch();
    const before = getWorkspaceGit(app.db, 'local')!.lastFetchAt;

    pushNewCommit(work, 'later.md');
    const s = await sync();
    expect(s.fetched).toBe(false);
    expect(s.divergence.state).toBe('current');
    expect(s.fetchedAt).toBe(before);
    expect(getWorkspaceGit(app.db, 'local')!.lastFetchAt).toBe(before);
  });

  it('fetches once the copy is older than the window, and then sees main has moved', async () => {
    await boot(0);
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);
    await importBranch();

    pushNewCommit(work, 'later.md');
    const s = await sync();
    expect(s.fetched).toBe(true);
    expect(s.divergence.state).toBe('behind');
    expect(s.fetchedAt).toBe(getWorkspaceGit(app.db, 'local')!.lastFetchAt);
  });

  it('re-clones a wiped checkout even inside the window', async () => {
    await boot(60_000);
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    rmSync(checkoutDirFor(join(testApp.tmpDir, 'git'), 'local'), { recursive: true, force: true });

    const s = await sync();
    expect(s.fetched).toBe(true);
    expect(s.divergence.state).toBe('unknown');
  });

  it('answers null when the fetch fails, and records why on the row', async () => {
    await boot(0);
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    renameSync(remote, `${remote}.gone`);

    expect(await sync()).toBeNull();
    expect(getWorkspaceGit(app.db, 'local')!.lastFetchError).not.toBeNull();
  });

  it('answers null inside the window when the last fetch failed, without fetching again', async () => {
    await boot(60_000);
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const row = getWorkspaceGit(app.db, 'local')!;
    const failedAt = Date.now();
    updateWorkspaceGitSync(app.db, 'local', {
      observedCollabHead: row.observedCollabHead,
      lastFetchAt: failedAt,
      lastFetchError: 'boom',
    });

    expect(await sync()).toBeNull();
    const after = getWorkspaceGit(app.db, 'local')!;
    expect(after.lastFetchAt).toBe(failedAt);
    expect(after.lastFetchError).toBe('boom');
  });

  it('reports an archived pipeline still on the branch as removed, against its row id', async () => {
    await boot(60_000);
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const p = createPipeline(app.db, { ownerId: 'local', name: 'Old' });
    createPipelineVersion(app.db, version(p.id));
    await commit('add old');
    archivePipelineRow(app.db, p.id);

    expect((await sync()).pipelines).toEqual([{ pipelineId: p.id, change: 'removed' }]);
  });

  it('agrees with /drift and /divergence', async () => {
    await boot(0);
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);
    await importBranch();
    const p = createPipeline(app.db, { ownerId: 'local', name: 'Orders' });
    createPipelineVersion(app.db, version(p.id));
    pushNewCommit(work, 'later.md');

    const s = await sync();
    const { drift } = (
      await app.inject({ method: 'POST', url: '/api/workspace/git/drift' })
    ).json();
    const { divergence } = (
      await app.inject({ method: 'POST', url: '/api/workspace/git/divergence' })
    ).json();
    expect(s.base).toBe(drift.base);
    expect(s.hasUncommittedChanges).toBe(drift.hasUncommittedChanges);
    expect(s.divergence).toEqual(divergence);
    expect(s.divergence.state).toBe('behind');
    expect(s.workingBranch).toBe(getWorkspaceGit(app.db, 'local')!.workingBranch);
  });
});
