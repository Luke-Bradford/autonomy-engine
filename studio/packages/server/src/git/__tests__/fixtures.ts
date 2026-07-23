import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #3 G2 — shared REAL-git test fixtures (no mocked git): a bare "remote"
 * seeded through a plumbing work clone, exactly the shape the managed
 * checkout sees. Used by the provider tests and the workspace-git route
 * tests. Not a `.test.ts` file (vitest never runs it as a suite) and
 * excluded from `pnpm build` by the `src/**\/__tests__/**` exclude, like
 * `build-test-app.ts`.
 */

/** Runs a real git command for FIXTURE setup (identity pinned inline so the
 * developer's global config is never a dependency). */
export function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/**
 * Seeds `<baseDir>/remote.git` (bare, one commit on `main`) via
 * `<baseDir>/work`; returns both plus the pushed head sha.
 */
export function seedRemote(baseDir: string): { remote: string; work: string; headSha: string } {
  const remote = join(baseDir, 'remote.git');
  const work = join(baseDir, 'work');
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', work], { encoding: 'utf8' });
  writeFileSync(join(work, 'README.md'), 'hello\n');
  fixtureGit(work, ['add', '.']);
  fixtureGit(work, ['commit', '-m', 'first']);
  fixtureGit(work, ['remote', 'add', 'origin', remote]);
  fixtureGit(work, ['push', 'origin', 'main']);
  return { remote, work, headSha: fixtureGit(work, ['rev-parse', 'HEAD']).trim() };
}

/** Commits a new file in the work clone and pushes `branch`; returns the new head sha. */
export function pushNewCommit(work: string, fileName: string, branch = 'main'): string {
  writeFileSync(join(work, fileName), `${fileName}\n`);
  fixtureGit(work, ['add', '.']);
  fixtureGit(work, ['commit', '-m', fileName]);
  fixtureGit(work, ['push', 'origin', branch]);
  return fixtureGit(work, ['rev-parse', 'HEAD']).trim();
}
