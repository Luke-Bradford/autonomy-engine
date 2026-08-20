import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Temp directories for the connector suites, in ONE place.
 *
 * This is the extraction `sqlite-fixtures.ts` started and could not finish while
 * it was named for one store. Its docblock counted the copies — `sqlite.test.ts`,
 * `confine.test.ts`, and "once as an inline async variant in `fs.test.ts`'s
 * `beforeEach`" — and predicted that "a fourth copy in the sink suite would have
 * been the one that eventually drifted". #1165's `delimited` reader suite was
 * about to be that copy, so the helper moved here instead, and `fs.test.ts`'s
 * inline variant came with it. `sqlite-fixtures.ts` re-exports both names, so
 * its four existing consumers are unchanged.
 *
 * The `realpathSync` is the load-bearing part. On macOS `os.tmpdir()` is itself
 * a symlink (`/var` → `/private/var`), so a root taken straight from `mkdtemp`
 * never canonically contains the paths resolved under it — a confinement test
 * would pass for the wrong reason, or fail for one.
 */

const dirs: string[] = [];

/** A temp dir whose path is REALPATH'd, registered for {@link cleanupTempRoots}. */
export function tempRoot(prefix = 'sqlite-store-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** Remove every root handed out since the last call. */
export function cleanupTempRoots(): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
}
