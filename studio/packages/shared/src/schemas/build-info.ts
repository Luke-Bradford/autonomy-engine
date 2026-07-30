import { z } from 'zod';

/**
 * The identity of a BUILT artifact, written by the release build and read back
 * at runtime. Shared because two consumers must agree on it: the server route
 * that serves it and the web client that renders it — and, from phase 2, the
 * update check that compares a local one against a published one.
 *
 * `commit` is a short sha and `arch` matches `process.arch` (`arm64`/`x64`);
 * `better-sqlite3` is a native addon, so artifacts are architecture-specific and
 * the arch has to travel with the identity rather than be inferred later.
 */
export const BuildInfoSchema = z.object({
  version: z.string().min(1),
  commit: z.string().min(1),
  builtAt: z.string().datetime(),
  arch: z.string().min(1),
});

export type BuildInfo = z.infer<typeof BuildInfoSchema>;
