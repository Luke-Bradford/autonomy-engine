import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, deletePipeline } from '../../repo/index.js';
import { fixtureGit, seedRemote } from '../../git/__tests__/fixtures.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G3a — the Commit route against a REAL local bare remote (no git mocks;
 * fixtures shared with the provider/G2 tests). Verifies the serialized working
 * copy actually lands on `studio/local/work` on the remote.
 */

describe('workspace-git commit route', () => {
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
    return app.inject({
      method: 'POST',
      url: '/api/workspace/git/commit',
      payload: { message },
    });
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

  /** Clone the working branch off the bare remote into a scratch dir to inspect
   * what was actually pushed. */
  function cloneWorkingBranch(remote: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'studio-git-commit-verify-'));
    execFileSync('git', ['clone', '--quiet', '--branch', WORKING_BRANCH, remote, dir], {
      encoding: 'utf8',
    });
    return dir;
  }

  it('serializes the workspace and pushes it to the working branch', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);

    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'My Pipeline' });
    createPipelineVersion(app.db, baseVersion(pipeline.id));

    const res = await commit('author a pipeline');
    expect(res.statusCode).toBe(200);
    const { commit: result } = res.json();
    expect(result.committed).toBe(true);
    expect(result.branch).toBe(WORKING_BRANCH);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.files).toEqual(['pipelines/my-pipeline.json']);

    // The file is really on the pushed branch, with the resourceId preserved.
    const verify = cloneWorkingBranch(remote);
    const contents = readFileSync(join(verify, 'pipelines/my-pipeline.json'), 'utf8');
    const envelope = JSON.parse(contents);
    expect(envelope.kind).toBe('pipeline');
    expect(envelope.data.pipeline.resourceId).toBe(pipeline.resourceId);
    expect(envelope.exportedAt).toBe(0);
  });

  it('a second commit with no changes is a no-op (committed:false)', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(app.db, baseVersion(pipeline.id));

    const first = (await commit('first')).json().commit;
    expect(first.committed).toBe(true);

    const second = (await commit('should be a no-op')).json().commit;
    expect(second.committed).toBe(false);
    expect(second.commitSha).toBeNull();
    expect(second.files).toEqual(['pipelines/p.json']);
  });

  it('a subsequent change fast-forwards the working branch (two commits)', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const a = createPipeline(app.db, { ownerId: 'local', name: 'Alpha' });
    createPipelineVersion(app.db, baseVersion(a.id));
    await commit('add alpha');

    const b = createPipeline(app.db, { ownerId: 'local', name: 'Beta' });
    createPipelineVersion(app.db, baseVersion(b.id));
    const second = (await commit('add beta')).json().commit;
    expect(second.committed).toBe(true);
    expect(second.files.sort()).toEqual(['pipelines/alpha.json', 'pipelines/beta.json']);

    // Both commits are on the branch (fast-forward, not a force-replace).
    const verify = cloneWorkingBranch(remote);
    const log = execFileSync('git', ['-C', verify, 'log', '--oneline'], { encoding: 'utf8' });
    expect(log).toContain('add alpha');
    expect(log).toContain('add beta');
  });

  it('commits to an EMPTY repo (orphan first commit creates the branch)', async () => {
    const remote = join(testApp.tmpDir, 'empty.git');
    execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
    await connect(remote);

    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'First' });
    createPipelineVersion(app.db, baseVersion(pipeline.id));

    const result = (await commit('first ever commit')).json().commit;
    expect(result.committed).toBe(true);

    const verify = cloneWorkingBranch(remote);
    expect(() => readFileSync(join(verify, 'pipelines/first.json'), 'utf8')).not.toThrow();
  });

  it('a removed resource is committed as a deletion', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'Doomed' });
    createPipelineVersion(app.db, baseVersion(pipeline.id));
    await commit('add doomed');

    // Deleting the pipeline row cascades its versions (no runs → no
    // PipelineHasRunsError); the next commit should stage the file's removal.
    deletePipeline(app.db, pipeline.id);

    const result = (await commit('remove doomed')).json().commit;
    expect(result.committed).toBe(true);
    expect(result.files).toEqual([]);

    const verify = cloneWorkingBranch(remote);
    expect(() => readFileSync(join(verify, 'pipelines/doomed.json'), 'utf8')).toThrow();
  });

  it('commits managed files even when the base branch .gitignores a managed dir (add -f)', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    // A base branch that ignores `pipelines/` would make a plain `git add
    // pipelines/x.json` exit non-zero and brick every Commit — `-f` is why it
    // still lands.
    writeFileSync(join(work, '.gitignore'), 'pipelines/\n');
    fixtureGit(work, ['add', '.gitignore']);
    fixtureGit(work, ['commit', '-m', 'ignore pipelines']);
    fixtureGit(work, ['push', 'origin', 'main']);
    await connect(remote);

    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'Ignored' });
    createPipelineVersion(app.db, baseVersion(pipeline.id));

    const result = (await commit('commit despite the ignore')).json().commit;
    expect(result.committed).toBe(true);

    const verify = cloneWorkingBranch(remote);
    expect(() => readFileSync(join(verify, 'pipelines/ignored.json'), 'utf8')).not.toThrow();
  });

  it('absorbs an out-of-band advance of the working branch (rebases onto it, never force-overwrites)', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const a = createPipeline(app.db, { ownerId: 'local', name: 'Alpha' });
    createPipelineVersion(app.db, baseVersion(a.id));
    await commit('add alpha'); // creates origin/studio/local/work

    // Out-of-band: another actor pushes a commit (with a non-managed file)
    // straight onto the working branch.
    fixtureGit(work, ['fetch', 'origin']);
    fixtureGit(work, ['checkout', '-B', WORKING_BRANCH, `origin/${WORKING_BRANCH}`]);
    writeFileSync(join(work, 'external.txt'), 'not studio-managed\n');
    fixtureGit(work, ['add', '.']);
    fixtureGit(work, ['commit', '-m', 'external change']);
    fixtureGit(work, ['push', 'origin', WORKING_BRANCH]);

    // Studio's next Commit re-fetches, bases on the advanced tip, and builds on
    // it — the external commit survives and the push fast-forwards.
    const b = createPipeline(app.db, { ownerId: 'local', name: 'Beta' });
    createPipelineVersion(app.db, baseVersion(b.id));
    const result = (await commit('add beta')).json().commit;
    expect(result.committed).toBe(true);

    const verify = cloneWorkingBranch(remote);
    const log = execFileSync('git', ['-C', verify, 'log', '--oneline'], { encoding: 'utf8' });
    expect(log).toContain('external change'); // not force-overwritten
    expect(log).toContain('add beta');
    // The non-managed file the other actor added is untouched by studio.
    expect(() => readFileSync(join(verify, 'external.txt'), 'utf8')).not.toThrow();
  });

  it('returns 404 when committing before any repo is connected', async () => {
    const res = await commit('nothing connected');
    expect(res.statusCode).toBe(404);
  });

  it('rejects an empty commit message at the boundary (400)', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const res = await commit('   ');
    expect(res.statusCode).toBe(400);
  });
});
