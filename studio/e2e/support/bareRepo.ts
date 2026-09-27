import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
