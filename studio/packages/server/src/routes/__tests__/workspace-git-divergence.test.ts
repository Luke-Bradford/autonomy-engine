import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureGit, pushNewCommit, seedRemote } from '../../git/__tests__/fixtures.js';
import { buildTestAppWithContext, type TestApp } from '../../__tests__/build-test-app.js';

/**
 * #3 G10 — the PROACTIVE descendant-guard route (`POST /api/workspace/git/divergence`)
 * against a REAL local bare remote (no git mocks; fixtures shared with the
 * provider/drift tests). Verifies the base is the persisted `importedFromCommit`
 * (stamped by an import), NOT collab-HEAD, and that the `merge-base --is-ancestor`
 * walk splits `behind` (collab fast-forwarded past the import base) from
 * `diverged` (collab rewritten). Advisory throughout — never blocks.
 */
describe('workspace-git divergence route', () => {
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
  const importBranch = () => app.inject({ method: 'POST', url: '/api/workspace/git/import' });
  const divergence = () => app.inject({ method: 'POST', url: '/api/workspace/git/divergence' });
  const status = () => app.inject({ method: 'GET', url: '/api/workspace/git' });

  it('404s when the workspace has no git connection', async () => {
    const res = await divergence();
    expect(res.statusCode).toBe(404);
  });

  it('is unknown (base null) before any import — connect alone does not set a base', async () => {
    const { remote } = seedRemote(testApp.tmpDir);
    await connect(remote);

    const { divergence: result } = (await divergence()).json();
    expect(result.state).toBe('unknown');
    expect(result.importBase).toBeNull();
    expect(result.collabHead).toMatch(/^[0-9a-f]{40}$/);
  });

  it('an import stamps importedFromCommit (visible on the status), yielding current', async () => {
    const { remote, headSha } = seedRemote(testApp.tmpDir);
    await connect(remote);
    await importBranch();

    // The status now carries the import base (the collab head the import read
    // from), distinct from observedCollabHead only once collab moves on.
    const { git } = (await status()).json();
    expect(git.importedFromCommit).toBe(headSha);

    const { divergence: result } = (await divergence()).json();
    expect(result.state).toBe('current');
    expect(result.importBase).toBe(headSha);
    expect(result.collabHead).toBe(headSha);
  });

  it('is behind when collab fast-forwards past the import base', async () => {
    const { remote, work, headSha } = seedRemote(testApp.tmpDir);
    await connect(remote);
    await importBranch(); // base = headSha

    // Collab advances with a new commit on main; the base is now a proper ancestor.
    const advancedSha = pushNewCommit(work, 'later.txt', 'main');

    const { divergence: result } = (await divergence()).json();
    expect(result.state).toBe('behind');
    expect(result.importBase).toBe(headSha);
    expect(result.collabHead).toBe(advancedSha);
  });

  it('is diverged when collab is force-pushed to an unrelated history', async () => {
    const { remote, headSha } = seedRemote(testApp.tmpDir);
    await connect(remote);
    await importBranch(); // base = headSha

    // Rewrite main on the remote to an unrelated root history — the new head
    // shares no ancestry with the import base, so a merge would not fast-forward.
    const orphan = join(testApp.tmpDir, 'orphan');
    execFileSync('git', ['init', '-b', 'main', orphan], { encoding: 'utf8' });
    writeFileSync(join(orphan, 'other.txt'), 'other\n');
    fixtureGit(orphan, ['add', '.']);
    fixtureGit(orphan, ['commit', '-m', 'orphan root']);
    fixtureGit(orphan, ['remote', 'add', 'origin', remote]);
    fixtureGit(orphan, ['push', '--force', 'origin', 'main']);
    const rewrittenSha = fixtureGit(orphan, ['rev-parse', 'HEAD']).trim();

    const { divergence: result } = (await divergence()).json();
    expect(result.state).toBe('diverged');
    expect(result.importBase).toBe(headSha);
    expect(result.collabHead).toBe(rewrittenSha);
  });
});
