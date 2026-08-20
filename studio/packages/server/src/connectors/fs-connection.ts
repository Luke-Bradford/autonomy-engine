import { isAbsolute } from 'node:path';
import { fsConnectionConfigSchema as sharedFsConnectionConfigSchema } from '@autonomy-studio/shared';
import type { ConnectorErrorKind } from './types.js';

/**
 * #996 M7 slice 2 (#1165) — what an `fs`-backed STORE needs from the `fs`
 * connection, extracted from `fs.ts` so it can be had WITHOUT importing the
 * adapter.
 *
 * THE EXTRACTION IS A CYCLE FIX, not tidying. `delimited-io.ts` must re-validate
 * the connection config at dispatch (§8) and classify its own filesystem
 * errors, and both lived in `fs.ts`. M7 slice 3 gives `fsAdapter` a `copy` arm
 * that imports the reader — so a reader importing `fs.ts` would close an
 * adapter↔module loop, which is the exact shape `copy.ts`'s docblock records the
 * tree refusing ("a module-evaluation cycle between an adapter and the activity
 * it dispatches is a fragile thing to introduce"). Extracting first costs one
 * file and removes the loop before it exists.
 */

/**
 * The Connection-level (non-secret) config for an `fs` connection.
 *
 * #1087 — the SHAPE lives in `shared/catalog/connection-config.ts`, so the
 * Manage › Connections form derives its controls from the same declaration the
 * adapter parses at dispatch. This is the ONE place server and shared diverge,
 * and only by one check: each root MUST be absolute — a relative root would
 * resolve against the server's cwd (ambiguous + a traversal risk) — and that is
 * `node:path`'s platform-aware `isAbsolute`, which cannot live in a
 * browser-safe package.
 *
 * Refining the shared `roots` rather than re-declaring it keeps the `.min(1)`
 * and its message in ONE file (re-typing them here would reintroduce exactly
 * the drift the move exists to kill), and any key added to the shared shape
 * appears here automatically. The refine is invisible to the form: a
 * `.refine()` is a CHECK, not a wrapper, so `deriveConfigFields` still sees a
 * list of strings either way.
 *
 * `superRefine` with an explicit `path` rather than a whole-array `refine`, so
 * the issue still names WHICH root is relative (`roots.<i>`) exactly as the
 * per-element refine it replaces did. A whole-array check would have reported
 * only `roots`, which reads fine with one root and uselessly with several.
 */
export const fsConnectionConfigSchema = sharedFsConnectionConfigSchema.extend({
  roots: sharedFsConnectionConfigSchema.shape.roots.superRefine((roots, ctx) => {
    roots.forEach((root, index) => {
      if (isAbsolute(root)) return;
      ctx.addIssue({
        code: 'custom',
        message: 'every fs root must be an absolute path',
        path: [index],
      });
    });
  }),
});

/**
 * OS errno codes we positively classify as RETRYABLE. Everything else (missing
 * file, no permission, is-a-directory, name-too-long, symlink-refused, …) is
 * `permanent` — the default is fail-safe-permanent, never blind-retried.
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

/** Whether a thrown fs error is an abort (run cancel / shutdown). */
export function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR';
}

/**
 * Classify a thrown filesystem error into the failure `kind` (#1 F0) both the
 * activity path and the store-reader path report.
 *
 * THE ABORT ARM IS PART OF THE CONTRACT, not a caller's afterthought. A handle
 * closed out from under an in-flight read surfaces as `EBADF`, which the
 * fail-safe default would call `permanent` — and §10 turns on the opposite
 * being true: "`cancelled` never retries", so a cancel misreported as
 * `permanent` is a run that retries work the operator stopped. `fs.ts`'s
 * `failFromError` has always checked abort FIRST; making the signal a parameter
 * here is what stops the store reader having to remember to.
 */
export function classifyFsError(
  err: unknown,
  signal: AbortSignal | undefined,
): ConnectorErrorKind {
  if (isAbortError(err, signal)) return 'cancelled';
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  if (code !== undefined && TRANSIENT_ERRNOS.has(code)) return 'transient';
  // Fail-safe: any errno we do not positively recognise as transient — and any
  // non-errno throw (a programming fault) — is permanent.
  return 'permanent';
}
