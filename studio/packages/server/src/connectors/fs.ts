import { constants as fsConstants, type Dirent } from 'node:fs';
import { open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { z } from 'zod';
import {
  COPY_ACTIVITY_TYPE,
  FILE_COPY_ACTIVITY_TYPE,
  FILE_DELETE_ACTIVITY_TYPE,
  FILE_LIST_ACTIVITY_TYPE,
  FILE_MOVE_ACTIVITY_TYPE,
  FILE_READ_ACTIVITY_TYPE,
  FILE_WRITE_ACTIVITY_TYPE,
  fileCopyConfigSchema,
  fileDeleteConfigSchema,
  fileListConfigSchema,
  fileMoveConfigSchema,
  fileReadConfigSchema,
  fileWriteConfigSchema,
  formatZodIssues,
} from '@autonomy-studio/shared';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
// #1119 M4 — the confinement guard moved OUT of this file so the `sqlite` store
// connector shares the one hardened implementation rather than mirroring it
// (data-movement spec §8). `fs` is still its primary caller and still layers
// `O_NOFOLLOW` on top at open time.
import { failed } from './activity-events.js';
import { resolveWithinRoots } from './confine.js';
// #1165 M7 slice 2 — the connection schema and the errno classifier moved OUT
// to `fs-connection.ts` so the `delimited` store reader can re-validate and
// classify WITHOUT importing this adapter, which slice 3 makes import IT.
import { classifyFsError, fsConnectionConfigSchema } from './fs-connection.js';
// #1167 M7 slice 3 — `fs` becomes a STORE. The copy arm below pairs this
// adapter's `delimited` reader with sqlite's writer, so the import direction is
// `fs.ts` -> `delimited-io.ts` + `sqlite.ts` -> `copy.ts`. NOT a cycle: `copy.ts`
// imports neither store, which is the property its own docblock protects.
import { runCopyActivity } from './copy.js';
import { DatasetIoError } from './dataset-io-error.js';
import {
  delimitedCoercionFor,
  describeDelimitedDatasetColumns,
  readDelimitedDatasetBatches,
  resolveDelimitedDatasetAddress,
} from './delimited-io.js';
// The SERVER's sqlite connection schema, not the shared one: it adds the
// absolute-root refinement that `node:path` cannot express in a browser-safe
// package, so this arm's sink gate is the SAME check `sqlite.ts`'s own arm makes
// rather than a weaker one that leans on the writer re-parsing.
import { sqliteConnectionConfigSchema, writeSqliteDatasetRows } from './sqlite.js';
import { FS_STREAM_CHUNK_BYTES } from '../limits.js';

/**
 * The `fs` connector adapter (#4 A11 + A12) — the FIRST non-http/LLM connector,
 * and the first to serve MORE THAN ONE activity type through ONE adapter: all six
 * file activities (`file_read`/`file_write` from A11, `file_copy`/`file_move`/
 * `file_delete`/`file_list` from A12) bind an `fs` connection, so `runActivity`
 * selects the operation from `ctx.activityType`.
 *
 * As of #996 M7 slice 3 (#1167) it is ALSO A STORE: it serves a seventh
 * activity, `copy`, as the SOURCE end of a `delimited` -> `sqlite` copy, and it
 * implements `resolveDatasetAddress` so a dispatch can record where it read
 * from. Those two roles share nothing but the connection's `roots`, and the
 * confinement guard below is what makes that sharing safe — a dataset's `path`
 * is confined by exactly the same rule as a `file_read`'s. It is CREDENTIAL-LESS — the
 * `secret` / `secretFields` arguments are always empty (the catalog declares no
 * `secretSinkFields`, and an `fs` connection carries no `secretRef`). EVERY
 * pipeline-supplied path (`path`/`source`/`dest`) runs through the same
 * server-side `resolveWithinRoots` guard below before any I/O touches it.
 *
 * SECURITY MODEL (the ticket's core). Two trust tiers:
 *  - The connection `config.roots` is ADMIN-authored (server-side, never
 *    pipeline-supplied) — the allowlist of base directories every file activity
 *    is confined to. An admin who sets `roots:['/']` has chosen to; the guard
 *    does not defend the machine against its own operator.
 *  - The activity `path` is PIPELINE-supplied — it arrives already
 *    `${}`-substituted (`ctx.input.path`), so it may derive from untrusted run
 *    data. The guard confines it to the roots regardless of what it contains.
 *
 * The path-traversal + symlink guard (`resolveWithinRoots`) is enforced HERE, on
 * the server, so a client cannot bypass it:
 *  1. `..` is collapsed lexically (`path.resolve`), so `root/../etc/passwd`
 *     normalises to `/etc/passwd` and fails containment.
 *  2. The allowed roots AND the target's parent directory are canonicalised with
 *     `realpath`, so an INTERMEDIATE symlink (a link inside a root pointing out)
 *     is resolved before the containment check — it cannot smuggle the target
 *     outside the roots.
 *  3. A symlink AT the target itself (the classic read-exfiltration /
 *     write-through-a-symlink escape) is refused two ways: `lstat` on the final
 *     path rejects a symlink target PORTABLY (independent of `O_NOFOLLOW`, which
 *     is absent on some platforms), and the opens ALSO pass `O_NOFOLLOW` as
 *     defence-in-depth that closes the `lstat`→open TOCTOU where the OS supports
 *     it. The connector never traverses a symlink at the target — it operates
 *     only on real files within the canonical roots.
 *
 * `file_write` is CRASH-SAFE: it writes to a sibling temp file (also inside the
 * canonical parent) and atomically `rename`s it over the target, so a crash or
 * cancel mid-write leaves the target either fully old or fully new, never a
 * half-written file (the write is non-idempotent, so a torn file would be a real
 * integrity risk).
 *
 * OUTCOME MAPPING: a completed read/write is `succeeded`. A denied path or a bad
 * config is `permanent` (a config mistake does not fix itself on retry). OS
 * errors map by errno: a small allowlist of genuinely-retryable conditions
 * (`EAGAIN`/`EBUSY`/`EMFILE`/… — a busy/contended FS) is `transient`; EVERYTHING
 * else is `permanent`. This is deliberately STRICTER than the http adapter's
 * default-transient: an fs failure is usually deterministic (missing file, no
 * permission, is-a-directory), and `file_write` is NON-idempotent, so a
 * blind retry of an unclassified failure could repeat a write — fail-safe is to
 * NOT retry unless we positively recognise the condition as transient.
 */

/** Default read size cap (bytes) — bounds a huge file from OOM-ing a worker. */
const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Default `file_list` entry cap — bounds a pathological directory (millions of
 * entries) from producing an unbounded `entries` output / OOM-ing a worker. The
 * adapter iterates lazily via `opendir` and STOPS at the cap (a `permanent`
 * failure), so it never materialises more than this many dirents.
 */
const DEFAULT_MAX_LIST_ENTRIES = 10_000;

/**
 * `O_NOFOLLOW` refuses to open a symlink at the final path component (→ `ELOOP`).
 * Defined on the target platforms (macOS + Linux); `?? 0` degrades to a harmless
 * no-op on any platform that lacks it rather than producing `NaN` flags.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

// The per-activity input shapes are the SHARED `file*ConfigSchema` (#578): the
// SAME schema the catalog `configSchema` declares (`shared/catalog/fs-activity-
// config.ts`), imported here so the palette metadata and this live-request guard
// can never drift. `input` here is the node's prepared (substituted) value.

/**
 * Map a thrown fs error to a terminal `failed` event.
 *
 * The classification itself is `classifyFsError` (`fs-connection.ts`), shared
 * with the `delimited` store reader so the two cannot disagree about whether a
 * given errno is retryable. This wrapper adds only the ACTIVITY-shaped part: an
 * abort reports a fixed sentence rather than whatever errno the unwinding
 * syscall happened to raise.
 */
function failFromError(err: unknown, signal: AbortSignal): ActivityEvent {
  const kind = classifyFsError(err, signal);
  if (kind === 'cancelled') return failed('cancelled', 'file activity aborted');
  return failed(kind, err instanceof Error ? err.message : String(err));
}

/**
 * What an abort BEFORE any dispatch is called, per activity.
 *
 * The six file activities have always said "file activity aborted". A `copy`
 * dispatched on this connection is not one of them — it is a dataset copy whose
 * source happens to be a file — and reporting it as a file activity would send
 * an operator looking for a `file_*` node that does not exist in their pipeline.
 */
function abortedReason(activityType: string): string {
  return activityType === COPY_ACTIVITY_TYPE ? 'dataset copy aborted' : 'file activity aborted';
}

/** Close a file handle, swallowing a close error so it never masks the result. */
async function closeQuietly(fh: Awaited<ReturnType<typeof open>> | undefined): Promise<void> {
  try {
    await fh?.close();
  } catch {
    // A close failure after the read/write already produced its terminal event
    // is not itself a classifiable activity outcome — never let it escape (and
    // turn a `succeeded` into an unclassified throw).
  }
}

/** The confined canonical path, or the terminal `failed` event to yield instead. */
type Resolved = { ok: true; path: string } | { ok: false; event: ActivityEvent };

/**
 * Confine ONE pipeline-supplied path to the roots, mapping both a policy denial
 * (outside-roots / symlink → `permanent`) and a genuine fs error (`realpath`
 * throwing on a missing parent → errno-classified) to a terminal `failed` event.
 * The SSOT every file activity resolves through, so the guard has one call shape.
 */
async function resolveOrFail(
  cfg: z.infer<typeof fsConnectionConfigSchema>,
  requested: string,
  signal: AbortSignal,
): Promise<Resolved> {
  try {
    const resolved = await resolveWithinRoots(cfg.roots, requested, 'fs');
    if (!resolved.ok) return { ok: false, event: failed('permanent', resolved.error) };
    return { ok: true, path: resolved.path };
  } catch (err) {
    return { ok: false, event: failFromError(err, signal) };
  }
}

/** Confine BOTH ends of a two-path op (`file_copy`/`file_move`), short-circuiting on the first denial. */
async function resolveSourceDest(
  cfg: z.infer<typeof fsConnectionConfigSchema>,
  source: string,
  dest: string,
  signal: AbortSignal,
): Promise<{ ok: true; source: string; dest: string } | { ok: false; event: ActivityEvent }> {
  const s = await resolveOrFail(cfg, source, signal);
  if (!s.ok) return s;
  const d = await resolveOrFail(cfg, dest, signal);
  if (!d.ok) return d;
  return { ok: true, source: s.path, dest: d.path };
}

/**
 * A per-dispatch temp-file suffix (filename-safe), unique per (run,node,attempt)
 * so two DIFFERENT runs dispatching the same node/attempt id concurrently against
 * the same fs root cannot collide on a temp name (which `O_EXCL` would otherwise
 * turn into a spurious failure). `runId` is globally unique per run, so
 * `runId.nodeId.attemptId` is unique per write. Shared by `file_write`+`file_copy`.
 */
function makeTmpSuffix(ctx: ActivityContext): string {
  return `${ctx.runId}.${ctx.nodeId}.${ctx.attemptId}`.replace(/[^\w.-]/g, '_');
}

async function doRead(
  cfg: z.infer<typeof fsConnectionConfigSchema>,
  requested: string,
  signal: AbortSignal,
): Promise<ActivityEvent> {
  const r = await resolveOrFail(cfg, requested, signal);
  if (!r.ok) return r.event;
  const finalPath = r.path;

  const maxBytes = cfg.maxBytes ?? DEFAULT_MAX_READ_BYTES;
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(finalPath, fsConstants.O_RDONLY | O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) {
      return failed('permanent', `'${finalPath}' is not a regular file`);
    }
    if (st.size > maxBytes) {
      return failed('permanent', `file is ${st.size} bytes, over the ${maxBytes}-byte read limit`);
    }
    const content = await fh.readFile({ encoding: 'utf8', signal });
    return { type: 'succeeded', outputs: { content, path: finalPath } };
  } catch (err) {
    return failFromError(err, signal);
  } finally {
    await closeQuietly(fh);
  }
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
async function atomicReplace(
  finalPath: string,
  tmpSuffix: string,
  signal: AbortSignal,
  writeInto: (fh: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<ActivityEvent | undefined> {
  const tmpPath = `${finalPath}.tmp.${tmpSuffix}`;
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    fh = await open(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o644,
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

async function doWrite(
  cfg: z.infer<typeof fsConnectionConfigSchema>,
  input: z.infer<typeof fileWriteConfigSchema>,
  signal: AbortSignal,
  tmpSuffix: string,
): Promise<ActivityEvent> {
  const r = await resolveOrFail(cfg, input.path, signal);
  if (!r.ok) return r.event;
  const finalPath = r.path;

  const failure = await atomicReplace(finalPath, tmpSuffix, signal, async (fh) => {
    await fh.writeFile(input.content, { encoding: 'utf8', signal });
  });
  if (failure) return failure;
  return {
    type: 'succeeded',
    outputs: { bytesWritten: Buffer.byteLength(input.content, 'utf8'), path: finalPath },
  };
}

/** Classify a directory entry by its raw type (a symlink is REPORTED, not followed). */
function direntType(d: Dirent): 'file' | 'directory' | 'symlink' | 'other' {
  if (d.isFile()) return 'file';
  if (d.isDirectory()) return 'directory';
  if (d.isSymbolicLink()) return 'symlink';
  return 'other';
}

async function doCopy(
  cfg: z.infer<typeof fsConnectionConfigSchema>,
  input: z.infer<typeof fileCopyConfigSchema>,
  signal: AbortSignal,
  tmpSuffix: string,
): Promise<ActivityEvent> {
  const resolved = await resolveSourceDest(cfg, input.source, input.dest, signal);
  if (!resolved.ok) return resolved.event;
  const { source: sourcePath, dest: destPath } = resolved;

  // Open the source with `O_NOFOLLOW` (closing the lstat→open symlink TOCTOU
  // where supported) and STREAM it in fixed-size chunks into the atomic temp —
  // so a copy is memory-bounded (no `maxBytes` cap, unlike `file_read`) and
  // never loads a large file whole. `bytesWritten` is the actual copied length.
  let src: Awaited<ReturnType<typeof open>> | undefined;
  let bytesWritten = 0;
  try {
    // Capture the opened handle in a locally-typed const so the closure below
    // keeps its non-null narrowing (TS loses it across the closure boundary);
    // `src` still holds the same handle for `closeQuietly` in `finally`.
    const source = await open(sourcePath, fsConstants.O_RDONLY | O_NOFOLLOW);
    src = source;
    const st = await source.stat();
    if (!st.isFile()) return failed('permanent', `source '${sourcePath}' is not a regular file`);
    const buffer = Buffer.allocUnsafe(FS_STREAM_CHUNK_BYTES);
    const failure = await atomicReplace(destPath, tmpSuffix, signal, async (dst) => {
      for (;;) {
        if (signal.aborted) throw new Error('file copy aborted');
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        // A single `write` may be short (a full/slow FS), so loop until the whole
        // chunk lands — never silently drop the tail or over-count `bytesWritten`.
        let off = 0;
        while (off < bytesRead) {
          const { bytesWritten: w } = await dst.write(buffer, off, bytesRead - off);
          off += w;
        }
        bytesWritten += bytesRead;
      }
    });
    if (failure) return failure;
    return { type: 'succeeded', outputs: { bytesWritten, source: sourcePath, dest: destPath } };
  } catch (err) {
    return failFromError(err, signal);
  } finally {
    await closeQuietly(src);
  }
}

async function doMove(
  cfg: z.infer<typeof fsConnectionConfigSchema>,
  input: z.infer<typeof fileMoveConfigSchema>,
  signal: AbortSignal,
): Promise<ActivityEvent> {
  const resolved = await resolveSourceDest(cfg, input.source, input.dest, signal);
  if (!resolved.ok) return resolved.event;
  const { source: sourcePath, dest: destPath } = resolved;

  // `rename` is atomic and symlink-safe at BOTH ends (it operates on the NAME,
  // never following a link) and — unlike copy — needs no temp. Both ends are
  // root-confined, so no `isFile()` check is needed: a move MAY relocate a whole
  // directory (rename handles that in one op), the deliberate asymmetry with
  // `file_copy` (which is file-only — it has no recursive-copy). It is
  // same-filesystem only: a cross-mount move throws `EXDEV`, which stays
  // `permanent` (the operator composes `file_copy` + `file_delete` for that).
  try {
    await rename(sourcePath, destPath);
    return { type: 'succeeded', outputs: { source: sourcePath, dest: destPath } };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      return failed(
        'permanent',
        `cannot move '${sourcePath}' to '${destPath}' across filesystems (EXDEV); ` +
          `use file_copy + file_delete instead`,
      );
    }
    return failFromError(err, signal);
  }
}

async function doDelete(
  cfg: z.infer<typeof fsConnectionConfigSchema>,
  requested: string,
  signal: AbortSignal,
): Promise<ActivityEvent> {
  const r = await resolveOrFail(cfg, requested, signal);
  if (!r.ok) return r.event;
  const finalPath = r.path;

  // `unlink` a single regular file. A missing target (`ENOENT`) is `permanent`,
  // NOT a benign success — the pipeline expected the file, and surfacing its
  // absence is safer than a silent no-op. A directory target fails naturally
  // (`EISDIR`/`EPERM`, platform-dependent, both `permanent`). The target-symlink
  // guard already refused a symlink AT the path, so we never unlink through one.
  try {
    await unlink(finalPath);
    return { type: 'succeeded', outputs: { path: finalPath } };
  } catch (err) {
    return failFromError(err, signal);
  }
}

async function doList(
  cfg: z.infer<typeof fsConnectionConfigSchema>,
  requested: string,
  signal: AbortSignal,
): Promise<ActivityEvent> {
  const r = await resolveOrFail(cfg, requested, signal);
  if (!r.ok) return r.event;
  const finalPath = r.path;

  // NB: `opendir` has no `O_NOFOLLOW` equivalent, so — unlike read/write/copy,
  // which close the lstat→open symlink TOCTOU with `O_NOFOLLOW` — the target-
  // symlink guard here is `resolveWithinRoots`'s `lstat` ALONE. That residual
  // (a concurrent swap of the final component to a symlink between the lstat and
  // the `opendir`) is OUTSIDE the threat model: the pipeline supplies a path
  // STRING, not a concurrent writer with write access to the admin-owned roots.
  //
  // Iterate lazily via `opendir` (never materialising more than `maxEntries`
  // dirents) and STOP at the cap with a `permanent` failure, so a pathological
  // directory cannot produce an unbounded output. Each entry is reported by its
  // raw dirent type — a symlink entry is listed as `symlink`, never followed.
  const maxEntries = cfg.maxEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  const entries: Array<{ name: string; type: ReturnType<typeof direntType> }> = [];
  let dir: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    dir = await opendir(finalPath);
    for (;;) {
      if (signal.aborted) return failed('cancelled', 'file activity aborted');
      const dirent = await dir.read();
      if (dirent === null) break;
      if (entries.length >= maxEntries) {
        return failed('permanent', `directory has more than the ${maxEntries}-entry list limit`);
      }
      entries.push({ name: dirent.name, type: direntType(dirent) });
    }
    return { type: 'succeeded', outputs: { entries, path: finalPath } };
  } catch (err) {
    return failFromError(err, signal);
  } finally {
    // Manual `read()` loop (not `for await`), so close the handle ourselves on
    // EVERY exit — success, cap-hit `return`, abort, or throw. A close after an
    // already-consumed dir is swallowed.
    try {
      await dir?.close();
    } catch {
      // Already closed / never opened — ignore (never mask the terminal event).
    }
  }
}

export const fsAdapter: ConnectorAdapter = {
  kind: 'fs',
  configSchema: fsConnectionConfigSchema,

  // #1167 — an `fs` connection is now a STORE as well as a file-activity
  // binding, so it owes §2.1's address seam. It is not optional in practice for
  // this adapter: `run/executor.ts` refuses a `copy` whose store cannot say
  // where it lands, rather than dispatching without the record.
  resolveDatasetAddress: resolveDelimitedDatasetAddress,

  async testConnection(config) {
    const cfg = fsConnectionConfigSchema.safeParse(config);
    if (!cfg.success) {
      return {
        ok: false,
        error: `invalid fs connection config: ${formatZodIssues(cfg.error.issues)}`,
      };
    }
    // A credential-less connector — "test" = every declared root exists and is a
    // directory. Report ALL problems, not just the first, so an operator fixes
    // the whole config in one pass.
    const problems: string[] = [];
    for (const root of cfg.data.roots) {
      try {
        const st = await stat(await realpath(root));
        if (!st.isDirectory()) problems.push(`root '${root}' is not a directory`);
      } catch (err) {
        problems.push(
          `root '${root}' is not accessible: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (problems.length > 0) return { ok: false, error: problems.join('; ') };
    return { ok: true };
  },

  async *runActivity(ctx: ActivityContext): AsyncIterable<ActivityEvent> {
    const cfg = fsConnectionConfigSchema.safeParse(ctx.connectionConfig);
    if (!cfg.success) {
      yield failed(
        'permanent',
        `invalid fs connection config: ${formatZodIssues(cfg.error.issues)}`,
      );
      return;
    }
    if (ctx.signal.aborted) {
      yield failed('cancelled', abortedReason(ctx.activityType));
      return;
    }

    // #1167 M7 slice 3 — the `copy` arm: `fs` as the SOURCE store of a
    // heterogeneous copy. Everything store-agnostic (the dispatch schema, the
    // refusal ladder, the counters and the failure mapping) is `copy.ts`'s;
    // this branch supplies only the halves that are the filesystem's.
    //
    // Placed AFTER the connection-config parse and the abort check. That is
    // `sqlite.ts`'s store arm in SPIRIT and not to the line — its copy branch is
    // the first thing `runActivity` tests and it has no pre-dispatch abort check
    // at all, which is a pre-existing gap on that adapter rather than a shape to
    // copy. The ladder-order argument in `copy.ts` is about `refuseSink` — a rung
    // that must not pre-empt the two preconditions above it — and does not
    // extend to the store's own config:
    // a bad `fs` config is this adapter's to report, and an already-cancelled
    // copy should not pay a `realpath` on a wedged mount before anything says
    // so. `cfg.data` is deliberately NOT threaded into the reader below; §8
    // requires it to re-validate at dispatch, and handing it a pre-parsed
    // config would make that re-validation a claim rather than a check.
    if (ctx.activityType === COPY_ACTIVITY_TYPE) {
      yield* runCopyActivity(ctx, {
        // There is no `delimited` WRITER, so an `fs` copy reads a file and
        // writes into a sqlite store. The catalog says so too
        // (`sinkConnectionKinds: ['sqlite']`), and this stays as the ladder's
        // rung for the same reason sqlite's does: it is what a caller bypassing
        // the catalog hits, and an unchecked sink config would reach the writer
        // to be refused as "invalid sqlite connection config" — a true
        // statement about the wrong thing.
        refuseSink: (connection) =>
          connection.kind === 'sqlite'
            ? null
            : `an fs copy reads a delimited file and writes into a sqlite store, but the sink connection is '${connection.kind}'`,
        sourceCoercion: (dataset) => delimitedCoercionFor(dataset.config),
        describeSource: ({ dataset, signal }) =>
          describeDelimitedDatasetColumns({
            connectionConfig: ctx.connectionConfig,
            datasetKind: dataset.kind,
            datasetConfig: dataset.config,
            ...(signal === undefined ? {} : { signal }),
          }),
        readBatches: ({ dataset, signal }) =>
          readDelimitedDatasetBatches({
            connectionConfig: ctx.connectionConfig,
            datasetKind: dataset.kind,
            datasetConfig: dataset.config,
            ...(signal === undefined ? {} : { signal }),
          }),
        writeRows: ({ dataset, connection, columns, mode, onBatch, batches, signal }) => {
          // Parsed from `ctx.sink`, never from this adapter's own connection —
          // and here that is not merely the safer answer, it is the only
          // coherent one: an `fs` config has no database in it at all.
          const parsedSink = sqliteConnectionConfigSchema.safeParse(connection.connectionConfig);
          if (!parsedSink.success) {
            throw new DatasetIoError(
              'permanent',
              `invalid sqlite sink connection config: ${formatZodIssues(parsedSink.error.issues)}`,
            );
          }
          return writeSqliteDatasetRows(
            {
              connectionConfig: parsedSink.data,
              datasetKind: dataset.kind,
              datasetConfig: dataset.config,
              columns,
              mode,
              onBatch,
              ...(signal === undefined ? {} : { signal }),
            },
            batches,
          );
        },
      });
      return;
    }

    if (ctx.activityType === FILE_READ_ACTIVITY_TYPE) {
      const input = fileReadConfigSchema.safeParse(ctx.input);
      if (!input.success) {
        yield failed(
          'permanent',
          `invalid file_read activity config: ${formatZodIssues(input.error.issues)}`,
        );
        return;
      }
      yield await doRead(cfg.data, input.data.path, ctx.signal);
      return;
    }

    if (ctx.activityType === FILE_WRITE_ACTIVITY_TYPE) {
      const input = fileWriteConfigSchema.safeParse(ctx.input);
      if (!input.success) {
        yield failed(
          'permanent',
          `invalid file_write activity config: ${formatZodIssues(input.error.issues)}`,
        );
        return;
      }
      yield await doWrite(cfg.data, input.data, ctx.signal, makeTmpSuffix(ctx));
      return;
    }

    if (ctx.activityType === FILE_COPY_ACTIVITY_TYPE) {
      const input = fileCopyConfigSchema.safeParse(ctx.input);
      if (!input.success) {
        yield failed(
          'permanent',
          `invalid file_copy activity config: ${formatZodIssues(input.error.issues)}`,
        );
        return;
      }
      // Same atomic temp+rename as file_write (copy writes to a `dest`-sibling temp).
      yield await doCopy(cfg.data, input.data, ctx.signal, makeTmpSuffix(ctx));
      return;
    }

    if (ctx.activityType === FILE_MOVE_ACTIVITY_TYPE) {
      const input = fileMoveConfigSchema.safeParse(ctx.input);
      if (!input.success) {
        yield failed(
          'permanent',
          `invalid file_move activity config: ${formatZodIssues(input.error.issues)}`,
        );
        return;
      }
      yield await doMove(cfg.data, input.data, ctx.signal);
      return;
    }

    if (ctx.activityType === FILE_DELETE_ACTIVITY_TYPE) {
      const input = fileDeleteConfigSchema.safeParse(ctx.input);
      if (!input.success) {
        yield failed(
          'permanent',
          `invalid file_delete activity config: ${formatZodIssues(input.error.issues)}`,
        );
        return;
      }
      yield await doDelete(cfg.data, input.data.path, ctx.signal);
      return;
    }

    if (ctx.activityType === FILE_LIST_ACTIVITY_TYPE) {
      const input = fileListConfigSchema.safeParse(ctx.input);
      if (!input.success) {
        yield failed(
          'permanent',
          `invalid file_list activity config: ${formatZodIssues(input.error.issues)}`,
        );
        return;
      }
      yield await doList(cfg.data, input.data.path, ctx.signal);
      return;
    }

    // The registry bound this adapter (by connection kind) but the node's activity
    // type is not one `fs` serves — a catalog/routing defect, never a config
    // mistake. Fail loud rather than silently no-op.
    yield failed('permanent', `the fs connector does not handle activity '${ctx.activityType}'`);
  },
};
