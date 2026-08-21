import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #1175 — a RATCHET against Zod 4's `error.message` returning as a fault string.
 *
 * `error.message` on a Zod 4 failure is a pretty-printed JSON array, not a
 * sentence, so interpolating it puts a multi-line blob into the run log (or an
 * API body) where a one-line fault belongs. `formatZodIssues`
 * (`shared/schemas/zod-issues.ts`) is the one renderer; #1175 converted the last
 * 34 sites to it.
 *
 * Why a source scan rather than only behavioural tests. The seven
 * CONNECTION-config sites are covered behaviourally and exhaustively by
 * `connectors/__tests__/connection-config-fault.test.ts`, and several of the
 * dataset/activity sites are pinned where their fixtures already exist. But the
 * remaining ~26 are activity- and dataset-dispatch paths with no cheap producer,
 * so a per-site behavioural test for all of them is not reachable. This is what
 * actually holds the conversion: a new site fails HERE, at the pattern, on the
 * day it is written.
 *
 * The pattern is `.error.message` LITERALLY, not a general
 * `${…message}` interpolation, because a `.error` property is Zod-result-shaped:
 * measured at `f3425b29`, all 34 occurrences across `server` and `shared` were
 * `safeParse` results, while a looser pattern would trip on ~12 legitimate
 * `err instanceof Error ? err.message : String(err)` sites on CAUGHT errors.
 *
 * Scope is `server` + `shared` source, which both reach ZERO with #1175 — so
 * there is no allowlist to keep in sync, and that is the point: an allowlist is
 * where a ratchet goes to die. `web` is already zero and is not scanned only
 * because nothing there produces a run-log fault. `cli` is deliberately EXCLUDED
 * and has one hit (`licenseAudit.run.ts`): its `result.error` is a `spawnSync`
 * error, a real `Error` whose `.message` IS a sentence — the opposite case, and
 * folding it in would need exactly the allowlist this avoids.
 */
const FORBIDDEN = '.error.message';

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const SCANNED_ROOTS = ['packages/server/src', 'packages/shared/src'];

/**
 * Source files only — a test may legitimately assert ON the pattern.
 *
 * `symlinks` is an out-param, not a curiosity. `Dirent.isDirectory()` is FALSE
 * for a symlink pointing at a directory, so a symlinked subtree would be walked
 * past in silence and the ratchet would narrow without anyone noticing. Neither
 * scanned root contains one today. Rather than FOLLOW them — which needs a
 * realpath cycle guard for a case nothing in the repo has — the walk collects
 * them and the sanity test below refuses them, so the day one appears the
 * ratchet fails LOUDLY instead of quietly covering less.
 */
function sourceFiles(dir: string, symlinks: string[] = []): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      symlinks.push(path);
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      found.push(...sourceFiles(path, symlinks));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

describe('#1175 no Zod fault is rendered through error.message', () => {
  it('scans a non-trivial number of files, and no subtree is skipped (#1175)', () => {
    const symlinks: string[] = [];
    const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(resolve(studioRoot, root), symlinks));
    // A broken path or a bad filter would make the assertion below vacuous.
    expect(files.length).toBeGreaterThan(100);
    // And a symlinked subtree would make it vacuous for whatever it points at.
    expect(symlinks.map((path) => path.slice(studioRoot.length + 1))).toEqual([]);
  });

  it.each(SCANNED_ROOTS)('%s renders every Zod fault through formatZodIssues', (root) => {
    const offenders = sourceFiles(resolve(studioRoot, root))
      .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
      .filter(({ text }) => text.includes(FORBIDDEN))
      .map(({ path }) => path.slice(studioRoot.length + 1));

    expect(offenders).toEqual([]);
  });
});
