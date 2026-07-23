import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutDirFor } from '../../git/checkout.js';
import { fixtureGit, pushNewCommit, seedRemote } from '../../git/__tests__/fixtures.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G2 — workspace-git routes against a REAL local bare remote (a path used
 * as the clone remote — exactly the "local repo" connect mode). No git mocks;
 * fixtures shared with the provider tests (`git/__tests__/fixtures.ts`).
 */

describe('workspace-git routes', () => {
  let testApp: TestApp;
  let app: FastifyInstance;

  beforeEach(async () => {
    testApp = await buildTestAppWithContext();
    app = testApp.app;
  });

  afterEach(async () => {
    await app.close();
  });

  function connect(repoUrl: string, collabBranch?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/workspace/git',
      payload: collabBranch === undefined ? { repoUrl } : { repoUrl, collabBranch },
    });
  }

  it('GET before any connect is { git: null }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workspace/git' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ git: null });
  });

  it('connect clones, observes the collab head, and reports ready', async () => {
    const { remote, headSha } = seedRemote(testApp.tmpDir);
    const res = await connect(remote);
    expect(res.statusCode).toBe(201);
    const { git } = res.json();
    expect(git.id).toMatch(/^wsgit_/);
    expect(git.ownerId).toBe('local');
    expect(git.repoUrl).toBe(remote);
    expect(git.collabBranch).toBe('main');
    expect(git.observedCollabHead).toBe(headSha);
    expect(git.state).toBe('ready');
    expect(git.lastFetchError).toBeNull();
    // The managed checkout exists where checkoutDirFor says it does.
    expect(existsSync(join(checkoutDirFor(testApp.workspaceGitRoot, 'local'), '.git'))).toBe(true);
    // And GET now returns the same status.
    const got = await app.inject({ method: 'GET', url: '/api/workspace/git' });
    expect(got.json().git.observedCollabHead).toBe(headSha);
  });

  it('connecting an EMPTY repo succeeds as collab_branch_missing (onboarding state)', async () => {
    const remote = join(testApp.tmpDir, 'empty.git');
    execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
    const res = await connect(remote);
    expect(res.statusCode).toBe(201);
    expect(res.json().git.state).toBe('collab_branch_missing');
    expect(res.json().git.observedCollabHead).toBeNull();
  });

  it('a second connect is a 409 conflict (never a silent re-point)', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const res = await connect(remote);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
  });

  it('an invalid repoUrl is a 400 validation error', async () => {
    const res = await connect('ext::sh -c whoami');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('a nonexistent remote is a 502 git_error and stores NO row', async () => {
    const res = await connect(join(testApp.tmpDir, 'no-such-remote'));
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('git_error');
    const got = await app.inject({ method: 'GET', url: '/api/workspace/git' });
    expect(got.json()).toEqual({ git: null });
  });

  it('fetch observes a new remote commit', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const newSha = pushNewCommit(work, 'second.md');
    const res = await app.inject({ method: 'POST', url: '/api/workspace/git/fetch' });
    expect(res.statusCode).toBe(200);
    expect(res.json().git.observedCollabHead).toBe(newSha);
    expect(res.json().git.state).toBe('ready');
  });

  it('fetch after the remote deleted the collab branch reports collab_branch_missing', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    await connect(remote);
    fixtureGit(work, ['push', 'origin', '--delete', 'main']);
    const res = await app.inject({ method: 'POST', url: '/api/workspace/git/fetch' });
    expect(res.statusCode).toBe(200);
    expect(res.json().git.observedCollabHead).toBeNull();
    expect(res.json().git.state).toBe('collab_branch_missing');
  });

  it('fetch with no connection is a 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/workspace/git/fetch' });
    expect(res.statusCode).toBe(404);
  });

  it('fetch RE-CLONES a wiped managed checkout (derived state, crash recovery)', async () => {
    const { remote, headSha } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const checkout = checkoutDirFor(testApp.workspaceGitRoot, 'local');
    rmSync(checkout, { recursive: true, force: true });
    const res = await app.inject({ method: 'POST', url: '/api/workspace/git/fetch' });
    expect(res.statusCode).toBe(200);
    expect(res.json().git.observedCollabHead).toBe(headSha);
    expect(existsSync(join(checkout, '.git'))).toBe(true);
  });

  it('a fetch FAILURE is recorded on the row (state fetch_error) and surfaced as 502', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    // Remove the remote out from under the checkout — fetch now fails.
    rmSync(remote, { recursive: true, force: true });
    const res = await app.inject({ method: 'POST', url: '/api/workspace/git/fetch' });
    expect(res.statusCode).toBe(502);
    const got = await app.inject({ method: 'GET', url: '/api/workspace/git' });
    expect(got.json().git.state).toBe('fetch_error');
    expect(got.json().git.lastFetchError).not.toBeNull();
    // The prior head survives (it is the last OBSERVED head), but the state
    // reports the error — precedence pinned in deriveWorkspaceGitState.
    expect(got.json().git.observedCollabHead).not.toBeNull();
  });

  it('connect RECOVERS from an orphaned checkout dir (crash-mid-clone leftovers)', async () => {
    const { remote, headSha } = seedRemote(testApp.tmpDir);
    // No row exists, but the checkout path is occupied by junk — a crashed
    // earlier connect. A plain `git clone` would refuse ("destination path
    // already exists"); connect must clear it first (no row ⇒ dir is orphaned
    // by definition).
    const checkout = checkoutDirFor(testApp.workspaceGitRoot, 'local');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'junk.txt'), 'stale');
    const res = await connect(remote);
    expect(res.statusCode).toBe(201);
    expect(res.json().git.observedCollabHead).toBe(headSha);
  });

  it('disconnect deletes the row and the managed checkout', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);
    const checkout = checkoutDirFor(testApp.workspaceGitRoot, 'local');
    expect(existsSync(checkout)).toBe(true);
    const res = await app.inject({ method: 'DELETE', url: '/api/workspace/git' });
    expect(res.statusCode).toBe(204);
    expect(existsSync(checkout)).toBe(false);
    const got = await app.inject({ method: 'GET', url: '/api/workspace/git' });
    expect(got.json()).toEqual({ git: null });
    // And a fresh connect works again after disconnect.
    const reconnect = await connect(remote);
    expect(reconnect.statusCode).toBe(201);
  });

  it('disconnect with no connection is a 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/workspace/git' });
    expect(res.statusCode).toBe(404);
  });

  it('a missing git binary is a 503 git_unavailable and stores NO row', async () => {
    // A REAL provider pointed at a nonexistent binary — no mocks; this is
    // exactly what a host without git looks like to the route.
    const { CliGitProvider } = await import('../../git/provider.js');
    const bare = await buildTestAppWithContext({
      workspaceGitProvider: new CliGitProvider({ gitBinary: '/no/such/git-binary' }),
    });
    try {
      const res = await bare.app.inject({
        method: 'POST',
        url: '/api/workspace/git',
        payload: { repoUrl: '/repos/anything' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('git_unavailable');
      const got = await bare.app.inject({ method: 'GET', url: '/api/workspace/git' });
      expect(got.json()).toEqual({ git: null });
    } finally {
      await bare.app.close();
    }
  });

  it('a non-default collab branch is honoured', async () => {
    const { remote, work } = seedRemote(testApp.tmpDir);
    fixtureGit(work, ['checkout', '-b', 'develop']);
    const devSha = pushNewCommit(work, 'dev.md', 'develop');
    const res = await connect(remote, 'develop');
    expect(res.statusCode).toBe(201);
    expect(res.json().git.collabBranch).toBe('develop');
    expect(res.json().git.observedCollabHead).toBe(devSha);
  });
});
