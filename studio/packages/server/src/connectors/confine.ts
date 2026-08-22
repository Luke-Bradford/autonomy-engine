import {
  close as closeCb,
  constants as fsConstants,
  fstat as fstatCb,
  open as openCb,
} from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

/**
 * Which connector is asking — it names ITSELF in the refusal messages below.
 *
 * REQUIRED, deliberately: this guard was extracted from `fs.ts` with "fs" baked
 * into its two refusal strings, so a `sqlite` connection whose roots were all
 * inaccessible refused with a message blaming "the fs connection" — a lie that
 * would send an operator to the wrong connection. A DEFAULT of `'fs'` would
 * merely re-arm that trap for the third caller; a required argument makes the
 * misattribution unrepresentable.
 */
export type ConnectorLabel = 'fs' | 'sqlite';

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
 *   - **IT CAN THROW, and a caller must catch it.** `realpath` on the target's
 *     PARENT is deliberately left unguarded, so a missing or unreadable parent
 *     directory raises a raw `ENOENT`/`EACCES` rather than becoming an
 *     `{ ok: false }` result. That is on purpose: the two callers classify a
 *     genuine filesystem error differently from a POLICY refusal (`fs` maps the
 *     errno through `failFromError`, which can call it transient; a policy
 *     refusal is always permanent), and folding the throw into the result here
 *     would flatten that distinction for everyone. `fs.ts` catches it in
 *     `resolveOrFail`, `sqlite.ts` in `confineStorePath`. A third caller owes
 *     the same wrapper — #1119 shipped without it on the sqlite side and an
 *     unclassified error escaped, which is why this bullet exists.
 *   - It does NOT close the lstat→open race on its own. `fs.ts` closes it by
 *     passing `O_NOFOLLOW` to its own `open()`; a caller that hands the returned
 *     path to a library which opens the file ITSELF — `better-sqlite3` does —
 *     gets the `lstat` check alone, and therefore a genuine (if narrow) TOCTOU.
 *     `connectors/sqlite.ts` states that residual where it consumes this.
 */
export async function resolveWithinRoots(
  roots: readonly string[],
  requested: string,
  connector: ConnectorLabel,
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
    return {
      ok: false,
      error: `no accessible allowed root directory on the ${connector} connection`,
    };
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
        error: `path '${requested}' is a symlink; the ${connector} connector does not follow symlinks`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { ok: true, path: finalPath };
}

/**
 * #1215 — the flags a confined READ must open with, in ONE place.
 *
 * `O_NOFOLLOW` is what closes the lstat->open race this module's docblock names
 * as its own residual, and `?? 0` is the load-bearing half of the expression:
 * the constant is absent on platforms that have no such flag, and a bare
 * `fsConstants.O_NOFOLLOW` would then make the whole bitmask `NaN` and every
 * open throw. That idiom was already written out twice (`fs.ts`'s file
 * activities, `delimited-io.ts`'s chunk reader) and a third copy was about to
 * be written for the xlsx reader -- three chances to drop the `?? 0`, on a
 * security control. It lives here instead, beside the guard whose residual it
 * exists to cover.
 */
export const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** `O_RDONLY | O_NOFOLLOW` -- what {@link openConfinedFd} and every confined
 * read open with. */
export const CONFINED_READ_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW;

const openFd = promisify(openCb);
const fstatFd = promisify(fstatCb);
const closeFd = promisify(closeCb);

/**
 * Open an already-confined path for reading and hand back a RAW descriptor.
 *
 * A raw `number` and deliberately not a `FileHandle`, which is the shape every
 * other reader in this tree uses. The consumer is `yauzl`, whose `fromFd` takes
 * ownership and closes the descriptor itself (`xlsx-read.ts`'s `openZip`
 * documents that transfer and measures it). A `FileHandle` also carries a
 * `FinalizationRegistry` that closes on GC, so handing `fh.fd` away would leave
 * two owners of one descriptor -- and because the kernel RECYCLES fd numbers,
 * the late close would land on whatever file had since taken the number. That
 * is the same hazard #1213 hit from the other side, and an inode probe is what
 * proved it real; a raw fd with exactly one owner makes it unrepresentable.
 *
 * The `isFile` check is `delimited-io.ts`'s, for its stated reason: `open`
 * succeeds on a DIRECTORY, and the read that follows either throws a bare
 * `EISDIR` or reports zero bytes -- which is then indistinguishable from an
 * empty file. Refusing here is the same fact said where it can be understood.
 * The descriptor is closed on that refusal, because ownership has not
 * transferred to anyone yet.
 */
export async function openConfinedFd(
  path: string,
): Promise<{ ok: true; fd: number } | { ok: false; error: string }> {
  const fd = await openFd(path, CONFINED_READ_FLAGS);
  try {
    const stats = await fstatFd(fd);
    if (!stats.isFile()) {
      await closeFd(fd);
      return { ok: false, error: `'${path}' is not a regular file` };
    }
  } catch (err) {
    // The fstat failed, so nothing downstream can use this descriptor and
    // nobody else owns it yet. Close it and re-throw for the caller's errno
    // mapper -- swallowing the error here would report the read as succeeding
    // over zero rows.
    await closeFd(fd).catch(() => undefined);
    throw err;
  }
  return { ok: true, fd };
}
