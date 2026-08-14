import { z } from 'zod';

/**
 * WHERE the master key that encrypts every secret at rest came from, in the
 * order `resolveMasterKey` tries them: an `AUTONOMY_MASTER_KEY` env var, a
 * mode-0600 key file, or a key the server MINTED on first run because it found
 * neither.
 *
 * Shared rather than declared server-side, because the web surface renders a
 * different sentence per source and a fourth source would otherwise be a
 * silently-unhandled string on one half of the wire. The server's
 * `MasterKeyResolution` takes its `source` type from here, so there is one
 * union, not two that can drift.
 */
export const MasterKeySourceSchema = z.enum(['env', 'file', 'generated']);

export type MasterKeySource = z.infer<typeof MasterKeySourceSchema>;

/**
 * The master key's PROVENANCE — deliberately not the key.
 *
 * There is no field here that could carry key material, and that is the whole
 * design of this schema: the status object is built beside `fastify.masterKey`
 * but shares nothing with it, so no future field can pick up the bytes by
 * accident. `settings.test.ts` pins the key set for the same reason.
 *
 * `keyFilePath` is the ABSOLUTE path of the file the key lives in — `null` when
 * and only when the key came from the environment, because then there is no
 * file. That "iff" is enforced below rather than merely written down: a
 * `generated` status with no path would render the back-it-up advisory without
 * naming the file to back up, which is the one thing this surface exists to
 * say.
 */
export const MasterKeyStatusSchema = z
  .object({
    source: MasterKeySourceSchema,
    keyFilePath: z.string().min(1).nullable(),
  })
  .superRefine((status, ctx) => {
    const fileExpected = status.source !== 'env';
    if (fileExpected && status.keyFilePath === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyFilePath'],
        message: `a ${status.source} key lives in a file, so its path must be reported`,
      });
    }
    if (!fileExpected && status.keyFilePath !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyFilePath'],
        message: 'an env-provided key has no file, so no path may be reported',
      });
    }
  });

export type MasterKeyStatus = z.infer<typeof MasterKeyStatusSchema>;

/**
 * `GET /api/settings` — the process-level facts the Settings page reads (U15
 * slice 2).
 *
 * An OBJECT with one member rather than the master-key status bare: settings is
 * an open-ended surface, and the second fact to land here must not have to
 * change the shape of the first one's response.
 */
export const AppSettingsSchema = z.object({
  masterKey: MasterKeyStatusSchema,
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;
