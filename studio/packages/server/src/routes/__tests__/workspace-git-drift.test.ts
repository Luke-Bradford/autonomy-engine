import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  createPipeline,
  createPipelineVersion,
  deletePipeline,
  updatePipeline,
} from '../../repo/index.js';
import { fixtureGit, seedRemote } from '../../git/__tests__/fixtures.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G10 — the advisory DRIFT route against a REAL local bare remote (no git
 * mocks; fixtures shared with the provider/commit tests). Verifies drift is
 * measured by CONTENT FORM against the working-branch tip, so a volatile-only
 * re-mint reads clean while a real add/edit/delete/rename surfaces.
 */
describe('workspace-git drift route', () => {
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
  const drift = () => app.inject({ method: 'POST', url: '/api/workspace/git/drift' });

  function baseVersion(pipelineId: string, prompt = 'hi'): NewPipelineVersion {
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
    const res = await drift();
    expect(res.statusCode).toBe(404);
  });

  it('reports base=null and every DB resource as added against a truly-empty remote', async () => {
    // A bare repo with NO branches — the onboarding state: no collab head, no
    // working branch, so base is null and everything the DB holds is `added`.
    const remote = join(testApp.tmpDir, 'empty-remote.git');
    execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
    await connect(remote);
    const p = createPipeline(app.db, { ownerId: 'local', name: 'My Pipeline' });
    createPipelineVersion(app.db, baseVersion(p.id));

    const { drift: result } = (await drift()).json();
    expect(result.base).toBeNull();
    expect(result.hasUncommittedChanges).toBe(true);
    expect(result.changes).toEqual([
      {
        path: 'pipelines/my-pipeline.json',
        kind: 'pipeline',
        resourceId: p.resourceId,
        name: 'My Pipeline',
        change: 'added',
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('falls back to the collaboration-branch tip when no working branch exists yet', async () => {
    // seedRemote seeds an empty `main` (no managed files). With no studio working
    // branch yet, the base is the collab tip (a real sha) and the DB resource —
    // absent from that branch — is `added`.
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const p = createPipeline(app.db, { ownerId: 'local', name: 'My Pipeline' });
    createPipelineVersion(app.db, baseVersion(p.id));

    const { drift: result } = (await drift()).json();
    expect(result.base).toMatch(/^[0-9a-f]{40}$/);
    expect(result.changes).toEqual([
      {
        path: 'pipelines/my-pipeline.json',
        kind: 'pipeline',
        resourceId: p.resourceId,
        name: 'My Pipeline',
        change: 'added',
      },
    ]);
  });

  it('reports clean (no changes) immediately after a commit', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const p = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(app.db, baseVersion(p.id));
    await commit('author');

    const { drift: result } = (await drift()).json();
    expect(result.base).toMatch(/^[0-9a-f]{40}$/);
    expect(result.hasUncommittedChanges).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it('a volatile-only re-mint (new immutable version, same content) is NOT drift', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const p = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(app.db, baseVersion(p.id));
    await commit('author');

    // Mint a fresh immutable version with IDENTICAL content — new version
    // id/number, but the same nodes/edges. Byte equality would call this drift;
    // content form does not.
    createPipelineVersion(app.db, baseVersion(p.id));

    const { drift: result } = (await drift()).json();
    expect(result.changes).toEqual([]);
    expect(result.hasUncommittedChanges).toBe(false);
  });

  it('reports a real content edit as modified', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const p = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(app.db, baseVersion(p.id));
    await commit('author');

    createPipelineVersion(app.db, baseVersion(p.id, 'a genuinely different prompt'));

    const { drift: result } = (await drift()).json();
    expect(result.changes).toEqual([
      {
        path: 'pipelines/p.json',
        kind: 'pipeline',
        resourceId: p.resourceId,
        name: 'P',
        change: 'modified',
      },
    ]);
    expect(result.hasUncommittedChanges).toBe(true);
  });

  it('reports a rename as renamed (content identical, only the name changed)', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const p = createPipeline(app.db, { ownerId: 'local', name: 'Old Name' });
    createPipelineVersion(app.db, baseVersion(p.id));
    await commit('author');

    updatePipeline(app.db, p.id, { name: 'New Name' });

    const { drift: result } = (await drift()).json();
    expect(result.changes).toEqual([
      {
        path: 'pipelines/new-name.json',
        kind: 'pipeline',
        resourceId: p.resourceId,
        name: 'New Name',
        change: 'renamed',
      },
    ]);
  });

  it('surfaces an unparseable committed managed file as a diagnostic + uncommitted', async () => {
    // A collaborator hand-committed garbage into a managed dir: its content is
    // uncomparable, so it yields NO `change`, but the next Commit's managed-dir
    // reconcile would drop it — so it is a VISIBLE diagnostic AND uncommitted
    // drift, never a silent `clean` (#473/#664 fail-safe).
    const { remote, work } = seedRemote(testApp.tmpDir);
    mkdirSync(join(work, 'pipelines'), { recursive: true });
    writeFileSync(join(work, 'pipelines/broken.json'), 'this is not valid json');
    fixtureGit(work, ['add', '.']);
    fixtureGit(work, ['commit', '-m', 'garbage']);
    fixtureGit(work, ['push', 'origin', 'main']);
    await connect(remote); // DB is empty — the only managed file is the bad commit

    const { drift: result } = (await drift()).json();
    expect(result.changes).toEqual([]);
    expect(result.hasUncommittedChanges).toBe(true);
    expect(result.diagnostics).toEqual([
      { path: 'pipelines/broken.json', code: 'unparseable', message: expect.any(String) },
    ]);
  });

  it('reports a deleted resource as removed', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const p = createPipeline(app.db, { ownerId: 'local', name: 'Doomed' });
    createPipelineVersion(app.db, baseVersion(p.id));
    await commit('author');

    deletePipeline(app.db, p.id);

    const { drift: result } = (await drift()).json();
    expect(result.changes).toEqual([
      {
        path: 'pipelines/doomed.json',
        kind: 'pipeline',
        resourceId: p.resourceId,
        name: 'Doomed',
        change: 'removed',
      },
    ]);
    expect(result.hasUncommittedChanges).toBe(true);
  });
});
