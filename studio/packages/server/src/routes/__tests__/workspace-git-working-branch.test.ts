import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, createWorkspaceGit } from '../../repo/index.js';
import { seedRemote } from '../../git/__tests__/fixtures.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G9a — feature-branch SELECTION (the persisted working_branch route) and the
 * GUIDED-MANUAL pull-request route, against a REAL local bare remote (no git
 * mocks; fixtures shared with the provider/G2 tests). Proves the commit route
 * reads the PERSISTED working branch (not the old per-commit `studio/local/work`
 * derivation) and that a PR compare URL is produced for a GitHub remote.
 */

describe('workspace-git working-branch + pull-request routes', () => {
  let testApp: TestApp;
  let app: FastifyInstance;

  beforeEach(async () => {
    testApp = await buildTestAppWithContext();
    app = testApp.app;
  });

  afterEach(async () => {
    await app.close();
  });

  function connect(repoUrl: string) {
    return app.inject({ method: 'POST', url: '/api/workspace/git', payload: { repoUrl } });
  }

  function setWorkingBranch(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/workspace/git/working-branch', payload });
  }

  function openPullRequest() {
    return app.inject({ method: 'POST', url: '/api/workspace/git/pull-request', payload: {} });
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

  describe('working-branch route', () => {
    it('connect seeds the default working branch studio/<owner>/work', async () => {
      const { remote } = seedRemote(testApp.tmpDir);
      const res = await connect(remote);
      expect(res.json().git.workingBranch).toBe('studio/local/work');
    });

    it('sets the working branch (feature-branch selection); GET reflects it', async () => {
      const { remote } = seedRemote(testApp.tmpDir);
      await connect(remote);

      const set = await setWorkingBranch({ workingBranch: 'studio/luke/feature-x' });
      expect(set.statusCode).toBe(200);
      expect(set.json().git.workingBranch).toBe('studio/luke/feature-x');

      const got = await app.inject({ method: 'GET', url: '/api/workspace/git' });
      expect(got.json().git.workingBranch).toBe('studio/luke/feature-x');
    });

    it('rejects a check-ref-format-invalid branch at the boundary (400)', async () => {
      const { remote } = seedRemote(testApp.tmpDir);
      await connect(remote);
      const res = await setWorkingBranch({ workingBranch: 'has space' });
      expect(res.statusCode).toBe(400);
    });

    it('is strict — an unknown key is a 400', async () => {
      const { remote } = seedRemote(testApp.tmpDir);
      await connect(remote);
      const res = await setWorkingBranch({ workingBranch: 'studio/luke/x', ownerId: 'evil' });
      expect(res.statusCode).toBe(400);
    });

    it('404s when no repo is connected', async () => {
      const res = await setWorkingBranch({ workingBranch: 'studio/luke/x' });
      expect(res.statusCode).toBe(404);
    });

    it('the commit route lands on the SELECTED (persisted) branch, not the default', async () => {
      const { remote } = seedRemote(testApp.tmpDir);
      await connect(remote);
      await setWorkingBranch({ workingBranch: 'studio/luke/feature-x' });

      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'My Pipeline' });
      createPipelineVersion(app.db, baseVersion(pipeline.id));

      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/git/commit',
        payload: { message: 'author on a feature branch' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().commit.committed).toBe(true);
      expect(res.json().commit.branch).toBe('studio/luke/feature-x');

      // The selected branch exists on the remote; the old default does NOT.
      const refs = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' });
      expect(refs).toContain('refs/heads/studio/luke/feature-x');
      expect(refs).not.toContain('refs/heads/studio/local/work');
    });
  });

  describe('pull-request route (guided-manual)', () => {
    it('builds a GitHub compare URL for a GitHub remote', async () => {
      // repoUrl is fixed at connect and a github.com URL is not clonable in a
      // test, so seed the row directly (the pattern the publish/trigger route
      // tests use) — this exercises the route's github wiring; the URL-building
      // itself is covered exhaustively in the shared unit tests.
      createWorkspaceGit(app.db, {
        ownerId: 'local',
        repoUrl: 'https://github.com/acme/widgets.git',
        collabBranch: 'main',
        workingBranch: 'studio/local/work',
        observedCollabHead: 'deadbeef',
        lastFetchAt: Date.now(),
        lastFetchError: null,
      });
      const res = await openPullRequest();
      expect(res.statusCode).toBe(200);
      const { pullRequest } = res.json();
      expect(pullRequest.mode).toBe('guided_manual');
      expect(pullRequest.provider).toBe('github');
      expect(pullRequest.url).toBe(
        'https://github.com/acme/widgets/compare/main...studio/local/work?expand=1',
      );
      expect(pullRequest.workingBranch).toBe('studio/local/work');
      expect(pullRequest.collabBranch).toBe('main');
    });

    it('a local remote → provider:unknown, url:null (guided by the branch pair)', async () => {
      const { remote } = seedRemote(testApp.tmpDir);
      await connect(remote);
      await setWorkingBranch({ workingBranch: 'studio/luke/feature-x' });
      const res = await openPullRequest();
      const { pullRequest } = res.json();
      expect(pullRequest.provider).toBe('unknown');
      expect(pullRequest.url).toBeNull();
      expect(pullRequest.workingBranch).toBe('studio/luke/feature-x');
      expect(pullRequest.collabBranch).toBe('main');
    });

    it('404s when no repo is connected', async () => {
      const res = await openPullRequest();
      expect(res.statusCode).toBe(404);
    });
  });
});
