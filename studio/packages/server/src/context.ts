import type { Db } from './repo/types.js';

/**
 * Ambient `FastifyInstance` augmentation for the two pieces of process-wide
 * state every route needs: the single Drizzle client and the resolved
 * secret-encryption master key. Both are decorated exactly once at boot
 * (`index.ts`'s `buildApp`), so route plugins and tests reach them via
 * `fastify.db` / `fastify.masterKey` instead of threading them through every
 * plugin's registration options.
 */
declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    /** The resolved 32-byte secret-encryption master key. Never log this. */
    masterKey: Uint8Array;
  }
}
