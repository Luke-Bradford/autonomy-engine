import { constants as fsConstants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { FILE_READ_ACTIVITY_TYPE, FILE_WRITE_ACTIVITY_TYPE } from '@autonomy-studio/shared';
import type {
  ActivityContext,
  ActivityEvent,
  ConnectorAdapter,
  ConnectorErrorKind,
} from './types.js';

/**
 * The `fs` connector adapter (#4 A11) — the FIRST non-http/LLM connector, and the
 * first to serve MORE THAN ONE activity type through ONE adapter: `file_read` and
 * `file_write` both bind an `fs` connection, so `runActivity` selects the
 * operation from `ctx.activityType`. It is CREDENTIAL-LESS — the `secret` /
 * `secretFields` arguments are always empty (the catalog declares no
 * `secretSinkFields`, and an `fs` connection carries no `secretRef`).
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
 *  3. The FINAL path component is opened with `O_NOFOLLOW`, so a symlink AT the
 *     target (the classic write-through-a-symlink escape) is refused (`ELOOP`),
 *     not followed. The connector never traverses a symlink at the target — it
 *     operates only on real files within the canonical roots. This also closes
 *     the final-component TOCTOU window that a check-then-open would leave.
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
 * `O_NOFOLLOW` refuses to open a symlink at the final path component (→ `ELOOP`).
 * Defined on the target platforms (macOS + Linux); `?? 0` degrades to a harmless
 * no-op on any platform that lacks it rather than producing `NaN` flags.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * OS errno codes we positively classify as RETRYABLE. Everything else (missing
 * file, no permission, is-a-directory, name-too-long, symlink-refused, …) is
 * `permanent` — see the class doc for why the default is fail-safe-permanent.
 */
const TRANSIENT_ERRNOS: ReadonlySet<string> = new Set([
  'EAGAIN', // resource temporarily unavailable
  'EBUSY', // device/resource busy
  'EMFILE', // per-process fd limit
  'ENFILE', // system-wide fd limit
  'ETIMEDOUT', // network FS timeout
  'EINTR', // interrupted syscall
  'ENOSPC', // no space (may free up)
  'EDQUOT', // quota exceeded (may free up)
  'EIO', // low-level I/O error (may be a transient device hiccup)
]);

/** The Connection-level (non-secret) config for an `fs` connection. */
const fsConnectionConfigSchema = z.object({
  // Each root MUST be absolute — a relative root would resolve against the
  // server's cwd (ambiguous + a traversal risk), so it is a config error.
  roots: z
    .array(z.string().min(1).refine(isAbsolute, 'every fs root must be an absolute path'))
    .min(1, 'an fs connection needs at least one allowed root'),
  /** Per-read size cap in bytes. Defaults to 10 MiB. */
  maxBytes: z.number().int().positive().optional(),
});

/** The per-activity settings, read from the node's prepared (substituted) `input`. */
const fileReadInputSchema = z.object({ path: z.string().min(1) });
const fileWriteInputSchema = z.object({ path: z.string().min(1), content: z.string() });

/** Build a terminal `failed` event. */
function failed(kind: ConnectorErrorKind, error: string): ActivityEvent {
  return { type: 'failed', kind, error };
}

/** Whether a thrown error is an abort (run cancel / shutdown). */
function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR';
}

/** Map a thrown fs error to a terminal `failed` event (errno → kind). */
function failFromError(err: unknown, signal: AbortSignal): ActivityEvent {
  if (isAbort(err, signal)) return failed('cancelled', 'file activity aborted');
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  if (code !== undefined && TRANSIENT_ERRNOS.has(code)) return failed('transient', message);
  // Fail-safe: any errno we do not positively recognise as transient — and any
  // non-errno throw (a programming fault) — is permanent, never blind-retried.
  return failed('permanent', message);
}

/**
 * Confine a pipeline-supplied `requested` path to the connection's `roots`.
 * Returns the canonical `path` to operate on, or a policy-denial reason. A
 * genuine fs error (e.g. the parent directory does not exist → `realpath`
 * throws) PROPAGATES to the caller's errno mapper rather than being swallowed
 * here, so a missing file reads as `permanent`, not a confusing "outside roots".
 */
async function resolveWithinRoots(
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
  return { ok: true, path: finalPath };
}

async function doRead(
  cfg: z.infer<typeof fsConnectionConfigSchema>,
  requested: string,
  signal: AbortSignal,
): Promise<ActivityEvent> {
  let finalPath: string;
  try {
    const resolved = await resolveWithinRoots(cfg.roots, requested);
    if (!resolved.ok) return failed('permanent', resolved.error);
    finalPath = resolved.path;
  } catch (err) {
    return failFromError(err, signal);
  }

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
    await fh?.close();
  }
}

async function doWrite(
  cfg: z.infer<typeof fsConnectionConfigSchema>,
  input: z.infer<typeof fileWriteInputSchema>,
  signal: AbortSignal,
): Promise<ActivityEvent> {
  let finalPath: string;
  try {
    const resolved = await resolveWithinRoots(cfg.roots, input.path);
    if (!resolved.ok) return failed('permanent', resolved.error);
    finalPath = resolved.path;
  } catch (err) {
    return failFromError(err, signal);
  }

  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Overwrite (truncate) the target. `O_NOFOLLOW` refuses to create/open THROUGH
    // a symlink at the final component (the write-escape B1 case). The parent was
    // already canonicalised + contained; no recursive mkdir in v1 (a missing
    // parent → `ENOENT` → permanent).
    fh = await open(
      finalPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW,
      0o644,
    );
    await fh.writeFile(input.content, { encoding: 'utf8', signal });
    return {
      type: 'succeeded',
      outputs: { bytesWritten: Buffer.byteLength(input.content, 'utf8'), path: finalPath },
    };
  } catch (err) {
    return failFromError(err, signal);
  } finally {
    await fh?.close();
  }
}

export const fsAdapter: ConnectorAdapter = {
  kind: 'fs',
  configSchema: fsConnectionConfigSchema,

  async testConnection(config) {
    const cfg = fsConnectionConfigSchema.safeParse(config);
    if (!cfg.success) {
      return { ok: false, error: `invalid fs connection config: ${cfg.error.message}` };
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
      yield failed('permanent', `invalid fs connection config: ${cfg.error.message}`);
      return;
    }
    if (ctx.signal.aborted) {
      yield failed('cancelled', 'file activity aborted');
      return;
    }

    if (ctx.activityType === FILE_READ_ACTIVITY_TYPE) {
      const input = fileReadInputSchema.safeParse(ctx.input);
      if (!input.success) {
        yield failed('permanent', `invalid file_read activity config: ${input.error.message}`);
        return;
      }
      yield await doRead(cfg.data, input.data.path, ctx.signal);
      return;
    }

    if (ctx.activityType === FILE_WRITE_ACTIVITY_TYPE) {
      const input = fileWriteInputSchema.safeParse(ctx.input);
      if (!input.success) {
        yield failed('permanent', `invalid file_write activity config: ${input.error.message}`);
        return;
      }
      yield await doWrite(cfg.data, input.data, ctx.signal);
      return;
    }

    // The registry bound this adapter (by connection kind) but the node's activity
    // type is not one `fs` serves — a catalog/routing defect, never a config
    // mistake. Fail loud rather than silently no-op.
    yield failed('permanent', `the fs connector does not handle activity '${ctx.activityType}'`);
  },
};
