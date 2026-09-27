import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';

/**
 * A scratch `git init --bare` repo for a workspace-git spec to connect to.
 *
 * NOT under `data/e2e`: `reset-state.mjs` wipes that tree, and putting
 * spec-authored content inside it invites a future widening of that delete. The
 * caller removes it in its own teardown.
 */
export function makeBareRepo(prefix = 'studio-git-e2e-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '--bare', '--initial-branch=main', dir], { stdio: 'ignore' });
  return dir;
}

/**
 * Take the workspace out of git mode, for a spec's teardown.
 *
 * Git mode is workspace-wide and the database is shared with every later spec
 * file, so a disconnect that silently fails leaves them all running in a mode
 * they did not ask for. A 404 is the one acceptable failure: the workspace was
 * never connected (the test failed first) or the test already disconnected.
 */
export async function disconnectWorkspaceGit(request: APIRequestContext): Promise<void> {
  const res = await request.delete('/api/workspace/git');
  expect(
    res.ok() || res.status() === 404,
    `disconnecting the workspace: ${String(res.status())} ${await res.text()}`,
  ).toBe(true);
}
