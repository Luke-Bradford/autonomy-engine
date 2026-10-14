import { open, link, rename, unlink } from 'node:fs/promises';
import { failed } from './activity-events.js';
import { O_NOFOLLOW } from './confine.js';
import { classifyFsError } from './fs-connection.js';
import type { ActivityContext, ActivityEvent } from './types.js';
import { FS_STREAM_CHUNK_BYTES } from '../limits.js';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/**
 * The write half of the `fs` connector, shared by the `file_*` activities
 * (`fs.ts`) and Copy · Files as-is (`fs-files-copy.ts`, #1600 OR41 C1a), so
 * the two keep one crash-safe write and one error mapping.
 */

/** `atomicReplace`'s answer when `noClobber` found a file already at the target. */
export const TARGET_EXISTS = Symbol('target-exists');

/**
 * Map a thrown fs error to a terminal `failed` event.
 *
 * The classification itself is `classifyFsError` (`fs-connection.ts`), shared
 * with the `delimited` store reader so the two cannot disagree about whether a
 * given errno is retryable. This wrapper adds only the ACTIVITY-shaped part: an
 * abort reports a fixed sentence rather than whatever errno the unwinding
 * syscall happened to raise.
 */
export function failFromError(err: unknown, signal: AbortSignal): ActivityEvent {
  const kind = classifyFsError(err, signal);
  if (kind === 'cancelled') return failed('cancelled', 'file activity aborted');
  return failed(kind, err instanceof Error ? err.message : String(err));
}

/** Close a file handle, swallowing a close error so it never masks the result. */
export async function closeQuietly(
  fh: Awaited<ReturnType<typeof open>> | undefined,
): Promise<void> {
  try {
    await fh?.close();
  } catch {
    // A close failure after the read/write already produced its terminal event
    // is not itself a classifiable activity outcome — never let it escape (and
    // turn a `succeeded` into an unclassified throw).
  }
}

/**
 * A per-dispatch temp-file suffix (filename-safe), unique per (run,node,attempt)
 * so two DIFFERENT runs dispatching the same node/attempt id concurrently against
 * the same fs root cannot collide on a temp name (which `O_EXCL` would otherwise
 * turn into a spurious failure). `runId` is globally unique per run, so
 * `runId.nodeId.attemptId` is unique per write. Shared by `file_write`+`file_copy`.
 */
export function makeTmpSuffix(ctx: ActivityContext): string {
  return `${ctx.runId}.${ctx.nodeId}.${ctx.attemptId}`.replace(/[^\w.-]/g, '_');
}

/**
 * The codes `link` gives on a file system without hard links (FAT, exFAT, some
 * SMB and NFS mounts): a clear permanent refusal, not a raw errno.
 */
export const LINK_UNSUPPORTED: ReadonlySet<string> = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
]);

/** The longest file name, in bytes, that the common file systems accept. */
const NAME_MAX_BYTES = 255;
/** How much of a too-long name its hashed temp keeps: `.<prefix>.<40 hex>.tmp` stays at most 146 bytes. */
const TMP_PREFIX_BYTES = 100;

/**
 * The temp beside `finalPath`: `<name>.tmp.<suffix>`, or, when that name would
 * be too long for the file system (#1685), a hidden name holding the start of
 * the target's name and a hash of the whole long name, which keeps it unique.
 */
export function tmpPathFor(finalPath: string, tmpSuffix: string): string {
  const name = `${basename(finalPath)}.tmp.${tmpSuffix}`;
  if (Buffer.byteLength(name) <= NAME_MAX_BYTES) return `${finalPath}.tmp.${tmpSuffix}`;
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 40);
  // A readable prefix of the name, so a temp a crash leaves behind can still be
  // tied to its target; cut on a character, never inside one.
  let prefix = '';
  for (const ch of basename(finalPath)) {
    if (Buffer.byteLength(prefix + ch) > TMP_PREFIX_BYTES) break;
    prefix += ch;
  }
  return join(dirname(finalPath), `.${prefix}.${digest}.tmp`);
}

/**
 * Crash-safe atomic replace, shared by `file_write` (writes a string) and
 * `file_copy` (streams a source file): create a FRESH sibling temp, hand it to
 * `writeInto`, `fsync` it, close it, then atomically `rename` it over
 * `finalPath`. A crash/cancel before the rename leaves the target fully OLD,
 * never torn; the temp is unlinked on every non-renamed exit. The temp lives in
 * the SAME canonical, already-contained parent dir, so the rename is a
 * same-filesystem atomic op (no EXDEV) and never crosses the root boundary.
 * `tmpSuffix` is unique per dispatch attempt; `O_EXCL` refuses to reuse a stale
 * temp, and `O_NOFOLLOW` keeps the temp create symlink-safe.
 *
 * Returns `undefined` on success (the caller builds the `succeeded` event with
 * its own outputs), or a terminal `failed` event mapping the error.
 */
export function atomicReplace(
  finalPath: string,
  tmpSuffix: string,
  signal: AbortSignal,
  writeInto: (fh: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<ActivityEvent | undefined>;
export function atomicReplace(
  finalPath: string,
  tmpSuffix: string,
  signal: AbortSignal,
  writeInto: (fh: Awaited<ReturnType<typeof open>>) => Promise<void>,
  opts: { noClobber?: boolean; mode?: number },
): Promise<ActivityEvent | undefined | typeof TARGET_EXISTS>;
export async function atomicReplace(
  finalPath: string,
  tmpSuffix: string,
  signal: AbortSignal,
  writeInto: (fh: Awaited<ReturnType<typeof open>>) => Promise<void>,
  opts: { noClobber?: boolean; mode?: number } = {},
): Promise<ActivityEvent | undefined | typeof TARGET_EXISTS> {
  const tmpPath = tmpPathFor(finalPath, tmpSuffix);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    fh = await open(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      opts.mode ?? 0o644,
    );
    await writeInto(fh);
    // `fsync` the temp BEFORE the rename so the bytes are durable on disk first —
    // otherwise a power-loss crash right after the rename could expose the new
    // dir entry pointing at unflushed (zero-length) data on a filesystem without
    // ordered metadata journaling. This is also where a deferred-allocation
    // ENOSPC surfaces. (Residual, accepted: the parent directory is NOT fsync'd,
    // so the rename itself is not guaranteed durable across a crash — worst case
    // the target keeps its OLD content, never a torn/partial file.)
    await fh.sync();
    // Close BEFORE the rename — and let a close error PROPAGATE (unlike the
    // read/cleanup path's quiet close): a delayed-write failure surfacing only at
    // `close()` (a known POSIX/NFS mode) means the temp is INCOMPLETE, so the
    // write must fail and NOT rename a corrupt file over the target. The
    // `finally` still runs (temp unlinked), and `fh` stays set so `closeQuietly`
    // there is a safe best-effort second close.
    await fh.close();
    fh = undefined;
    if (opts.noClobber === true) {
      // #1600 C1a — `link` refuses an existing target with EEXIST where
      // `rename` would silently replace it, so a Skip or Fail copy can never
      // overwrite a file that appeared after it looked. The temp is unlinked in
      // `finally` either way: on success the target is the link's other name.
      try {
        await link(tmpPath, finalPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return TARGET_EXISTS;
        if (code !== undefined && LINK_UNSUPPORTED.has(code)) {
          return failed(
            'permanent',
            `the file system at '${finalPath}' does not support hard links, which writing without replacing needs; set If file exists to Overwrite`,
          );
        }
        throw err;
      }
      return undefined;
    }
    await rename(tmpPath, finalPath);
    renamed = true;
    return undefined;
  } catch (err) {
    return failFromError(err, signal);
  } finally {
    await closeQuietly(fh);
    // Best-effort cleanup: if we created the temp but never renamed it away
    // (error/cancel), remove it so a failed write leaves no orphan behind.
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
        // Nothing to clean up (temp never created) or already gone — ignore.
      }
    }
  }
}

/**
 * Stream `source` into `dest` in fixed-size chunks, looping on a short write so
 * the tail is never dropped. Memory-bounded whatever the file size. Returns the
 * bytes copied. Throws on abort, which `failFromError` maps to `cancelled`.
 */
export async function streamInto(
  source: Awaited<ReturnType<typeof open>>,
  dest: Awaited<ReturnType<typeof open>>,
  signal: AbortSignal,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(FS_STREAM_CHUNK_BYTES);
  let total = 0;
  for (;;) {
    if (signal.aborted) throw new Error('file copy aborted');
    const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    let off = 0;
    while (off < bytesRead) {
      const { bytesWritten: w } = await dest.write(buffer, off, bytesRead - off);
      off += w;
    }
    total += bytesRead;
  }
  return total;
}
