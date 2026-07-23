import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import { createConnection, createPipeline, createPipelineVersion } from '../../repo/index.js';
import { fixtureGit, seedRemote } from '../../git/__tests__/fixtures.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G4/G5b — the import-preview route against a REAL local bare remote. It reads
 * the COLLABORATION branch (`main`) and reports what the parser recognises, each
 * resource carrying its reconcile DISPOSITION vs the DB working copy plus the
 * pipelines a pull would archive (#3 G5b) — the classify reads DB rows but WRITES
 * nothing (the apply is G5c). To seed the collab branch with genuine serialized
 * files, we let studio Commit to its working branch, then merge that into `main`
 * in a work clone (exactly a human merging the studio PR).
 */

describe('workspace-git import-preview route', () => {
  let testApp: TestApp;
  let app: FastifyInstance;

  beforeEach(async () => {
    testApp = await buildTestAppWithContext();
    app = testApp.app;
  });

  afterEach(async () => {
    await app.close();
  });

  const WORKING_BRANCH = 'studio/local/work';

  function connect(repoUrl: string) {
    return app.inject({ method: 'POST', url: '/api/workspace/git', payload: { repoUrl } });
  }
  function commit(message: string) {
    return app.inject({ method: 'POST', url: '/api/workspace/git/commit', payload: { message } });
  }
  function preview() {
    return app.inject({ method: 'POST', url: '/api/workspace/git/import-preview' });
  }

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

  /** Fast-forward the studio working branch into `main` on the remote. */
  function mergeWorkingIntoMain(work: string) {
    fixtureGit(work, ['fetch', 'origin']);
    fixtureGit(work, ['merge', '--no-edit', `origin/${WORKING_BRANCH}`]);
    fixtureGit(work, ['push', 'origin', 'main']);
  }

  it('previews the resources committed on the collaboration branch', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);

    const connection = createConnection(app.db, {
      ownerId: 'local',
      name: 'My Conn',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'My Pipeline' });
    createPipelineVersion(app.db, baseVersion(pipeline.id));

    expect((await commit('author resources')).json().commit.committed).toBe(true);
    mergeWorkingIntoMain(work);

    const res = await preview();
    expect(res.statusCode).toBe(200);
    const { preview: result } = res.json();
    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(result.diagnostics).toEqual([]);

    // The branch holds exactly what the DB serialized, so every resource is
    // UNCHANGED and nothing is proposed for archive.
    expect(result.archive).toEqual([]);
    const byKind = Object.fromEntries(result.resources.map((r: { kind: string }) => [r.kind, r]));
    expect(byKind.pipeline).toMatchObject({
      path: 'pipelines/my-pipeline.json',
      resourceId: pipeline.resourceId,
      name: 'My Pipeline',
      disposition: 'unchanged',
      nameChanged: false,
      contentChanged: false,
    });
    expect(byKind.connection).toMatchObject({
      path: 'connections/my-conn.json',
      resourceId: connection.resourceId,
      name: 'My Conn',
      disposition: 'unchanged',
    });
  });

  it('classifies a locally-edited pipeline as update and a DB-only pipeline as a proposed archive', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);

    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'Edited' });
    createPipelineVersion(app.db, {
      ...baseVersion(pipeline.id),
      outputs: [{ name: 'before', type: 'string' }],
    });
    expect((await commit('author v1')).json().commit.committed).toBe(true);
    mergeWorkingIntoMain(work);

    // After the commit: author a NEW version of the committed pipeline (a real
    // content edit) AND a brand-new pipeline that was never committed.
    createPipelineVersion(app.db, {
      ...baseVersion(pipeline.id),
      outputs: [{ name: 'after', type: 'string' }],
    });
    const local = createPipeline(app.db, { ownerId: 'local', name: 'Local Only' });
    createPipelineVersion(app.db, baseVersion(local.id));

    const { preview: result } = (await preview()).json();
    const edited = result.resources.find(
      (r: { resourceId: string }) => r.resourceId === pipeline.resourceId,
    );
    expect(edited).toMatchObject({ disposition: 'update', contentChanged: true });
    // The DB-only pipeline is not on the branch, so a pull would archive it.
    expect(result.archive).toEqual([
      {
        path: 'pipelines/local-only.json',
        kind: 'pipeline',
        resourceId: local.resourceId,
        name: 'Local Only',
      },
    ]);
  });

  it('returns an empty preview when the collaboration branch does not exist yet', async () => {
    const remote = join(testApp.tmpDir, 'empty.git');
    execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
    await connect(remote);

    const res = await preview();
    expect(res.statusCode).toBe(200);
    expect(res.json().preview).toEqual({ head: null, resources: [], archive: [], diagnostics: [] });
  });

  it('surfaces a malformed committed file as a diagnostic (not dropped, not a throw)', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);

    // A human commits garbage under a managed dir straight onto the collab branch.
    fixtureGit(work, ['rm', '-q', 'README.md']);
    mkdirSync(join(work, 'pipelines'), { recursive: true });
    writeFileSync(join(work, 'pipelines/broken.json'), '{ not valid json');
    fixtureGit(work, ['add', '.']);
    fixtureGit(work, ['commit', '-m', 'garbage']);
    fixtureGit(work, ['push', 'origin', 'main']);

    const { preview: result } = (await preview()).json();
    expect(result.resources).toEqual([]);
    expect(result.diagnostics).toEqual([
      { path: 'pipelines/broken.json', code: 'unparseable', message: expect.any(String) },
    ]);
  });

  it('returns 404 when previewing before any repo is connected', async () => {
    expect((await preview()).statusCode).toBe(404);
  });
});
