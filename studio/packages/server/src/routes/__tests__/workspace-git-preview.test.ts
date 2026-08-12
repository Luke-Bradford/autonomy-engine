import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  deleteConnection,
} from '../../repo/index.js';
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

  it('#1043 — an uncomparable head is a diagnostic, not a manufactured `create`', async () => {
    // The pipeline is committed to the branch FIRST, so its file is genuinely
    // there; deleting the connection afterwards is what makes the DB side
    // uncomparable. Without the fix the preview 500s; with only the DB side
    // excluded it would report `create` for a pipeline that plainly exists.
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const conn = createConnection(app.db, {
      ownerId: 'local',
      name: 'Doomed',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'Uses Conn' });
    createPipelineVersion(app.db, {
      ...baseVersion(pipeline.id),
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: {},
          connectionId: conn.id,
          position: { x: 0, y: 0 },
        },
      ],
    });
    expect((await commit('author')).json().commit.committed).toBe(true);
    mergeWorkingIntoMain(work);
    deleteConnection(app.db, conn.id);

    const res = await preview();
    expect(res.statusCode).toBe(200);
    const { preview: result } = res.json();
    expect(result.resources.filter((r: { kind: string }) => r.kind === 'pipeline')).toEqual([]);
    expect(result.archive).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        path: 'pipelines/uses-conn.json',
        code: 'unserializable_ref',
        message: expect.stringContaining('n1'),
      },
    ]);
    // The connection's own file is still on the branch and still compared — the
    // blast radius is the one pipeline, not the workspace.
    expect(result.resources.map((r: { kind: string }) => r.kind)).toEqual(['connection']);
  });

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

  it('classifies a pipeline the workspace has authored PAST as superseded, and a DB-only pipeline as a proposed archive', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);

    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'Edited' });
    createPipelineVersion(app.db, {
      ...baseVersion(pipeline.id),
      outputs: [{ name: 'before', type: 'string' }],
    });
    expect((await commit('author v1')).json().commit.committed).toBe(true);
    mergeWorkingIntoMain(work);

    // After the commit: author a NEW version of the committed pipeline — the
    // ordinary "commit, keep working" loop — AND a brand-new pipeline that was
    // never committed.
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
    // #983 — the branch is pinned to v1, which this workspace still holds
    // byte-identically; importing it writes nothing (the apply reports
    // `superseded`). `contentChanged` remains true — the branch DOES differ from
    // the head — but the label no longer promises a write. This route wiring is
    // the only thing that reads the owned versions, so it is the only thing that
    // can tell `superseded` from `update`.
    expect(edited).toMatchObject({ disposition: 'superseded', contentChanged: true });
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

  it('still classifies a version the workspace does NOT hold as an update', async () => {
    // #983 — the other side of the same route wiring: a version authored
    // ELSEWHERE and merged into the collaboration branch is a real incoming
    // change, and must keep saying so. Without this, "report superseded" and
    // "report nothing ever changes" look identical from the superseded test.
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);

    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'Shared' });
    createPipelineVersion(app.db, {
      ...baseVersion(pipeline.id),
      outputs: [{ name: 'ours', type: 'string' }],
    });
    expect((await commit('author v1')).json().commit.committed).toBe(true);
    mergeWorkingIntoMain(work);

    // A collaborator authors a genuinely new version on `main` — a version id
    // this workspace has never held.
    const file = join(work, 'pipelines/shared.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.data.versions[0].resourceId = 'pvr_authored_elsewhere';
    doc.data.versions[0].outputs = [{ name: 'theirs', type: 'string' }];
    writeFileSync(file, JSON.stringify(doc, null, 2));
    fixtureGit(work, ['add', '-A']);
    fixtureGit(work, ['commit', '-m', 'a collaborator edits the pipeline']);
    fixtureGit(work, ['push', 'origin', 'main']);

    const { preview: result } = (await preview()).json();
    expect(
      result.resources.find((r: { resourceId: string }) => r.resourceId === pipeline.resourceId),
    ).toMatchObject({ disposition: 'update', contentChanged: true });
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

  it('#664 — an oversized committed file is a per-file diagnostic, not a whole-preview 502', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);

    // A managed .json larger than the provider's 1 MiB collected-output cap: a
    // `git show` of it overflows, so the reader cannot read it. It must degrade
    // to a per-file `unreadable` diagnostic, never fail the whole preview.
    mkdirSync(join(work, 'pipelines'), { recursive: true });
    writeFileSync(
      join(work, 'pipelines/huge.json'),
      JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }),
    );
    fixtureGit(work, ['add', '.']);
    fixtureGit(work, ['commit', '-m', 'oversized']);
    fixtureGit(work, ['push', 'origin', 'main']);

    const res = await preview();
    expect(res.statusCode).toBe(200);
    const { preview: result } = res.json();
    expect(result.resources).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: 'pipelines/huge.json', code: 'unreadable' }),
    );
  });

  it('returns 404 when previewing before any repo is connected', async () => {
    expect((await preview()).statusCode).toBe(404);
  });
});
