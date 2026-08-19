import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * #1119 M4 — the path-confinement guard, EXTRACTED so more than one connector
 * can share it (data-movement spec §8, in as many words: "EXTRACT and share
 * `fs`'s guard — do not mirror it … a second copy of that logic is a defect by
 * construction").
 *
 * It lived as a module-private function in `connectors/fs.ts` until the `sqlite`
 * store connector needed the identical confinement for its database file. This
 * is a MOVE, not a reimplementation: the body below is the one `fs` has been
 * dispatching through, and `fs.ts` now imports it.
 *
 * WHAT IT GUARANTEES, and — because the two callers differ here — what it does
 * NOT:
 *   - Lexical `..` collapse, `realpath` on the roots AND on the target's
 *     PARENT, and containment compared canonical-against-canonical.
 *   - An `lstat` refusal of a symlink AT the target itself.
 *   - It does NOT close the lstat→open race on its own. `fs.ts` closes it by
 *     passing `O_NOFOLLOW` to its own `open()`; a caller that hands the returned
 *     path to a library which opens the file ITSELF — `better-sqlite3` does —
 *     gets the `lstat` check alone, and therefore a genuine (if narrow) TOCTOU.
 *     `connectors/sqlite.ts` states that residual where it consumes this.
 */
export async function resolveWithinRoots(
  roots: readonly string[],
  requested: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  // Canonicalise the roots (resolve symlinks + trailing separators) so the
  // containment comparison is canonical-vs-canonical. A root that does not
  // resolve (missing/unreadable) is skipped, not fatal — a valid path under a
  // GOOD root still works; only if NONE resolve is it an error.
  const canonicalRoots: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root)) continue; // schema enforces this; defence in depth
    try {
      canonicalRoots.push(await realpath(root));
    } catch {
      // Skip an inaccessible root.
    }
  }
  if (canonicalRoots.length === 0) {
    return { ok: false, error: 'no accessible allowed root directory on the fs connection' };
  }

  // A relative request resolves against the first root; an absolute one is taken
  // as-is. Either way `resolve` collapses any `..` before the containment check.
  const base = isAbsolute(requested) ? requested : join(canonicalRoots[0]!, requested);
  const target = resolve(base);

  // Canonicalise the PARENT (resolves intermediate symlinks); the final component
  // is left unresolved so `O_NOFOLLOW` at open time refuses a target-level symlink.
  const realParent = await realpath(dirname(target));
  const finalPath = join(realParent, basename(target));

  const contained = canonicalRoots.some((root) => {
    if (finalPath === root) return true;
    // Compare against `root + sep` so a sibling whose name merely EXTENDS the
    // root (`/a/bc` under root `/a/b`) is not falsely contained. Guard the
    // filesystem-root case: `realpath('/')` is `'/'`, which already ends in
    // `sep`, so appending another would make `'//'` and reject every path — an
    // admin who sets `roots:['/']` means "anywhere", so use `root` as the prefix
    // when it already ends in the separator.
    const prefix = root.endsWith(sep) ? root : root + sep;
    return finalPath.startsWith(prefix);
  });
  if (!contained) {
    return { ok: false, error: `path '${requested}' resolves outside the allowed roots` };
  }

  // Refuse a symlink AT the target itself, PORTABLY — `lstat` (which does not
  // follow the final link) works everywhere, so the target-symlink guard does
  // not silently disappear on a platform lacking `O_NOFOLLOW`. ENOENT is fine
  // (a `file_write` to a not-yet-existing path); any other error propagates to
  // the caller's errno mapper. The `O_NOFOLLOW` on the subsequent open remains
  // as defence-in-depth against the lstat→open race.
  try {
    if ((await lstat(finalPath)).isSymbolicLink()) {
      return {
        ok: false,
        error: `path '${requested}' is a symlink; the fs connector does not follow symlinks`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { ok: true, path: finalPath };
}
