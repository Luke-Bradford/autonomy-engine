import { z } from 'zod';
import { BuildInfoSchema } from './build-info.js';

/**
 * What the update check reports.
 *
 * `latest: null` means the check could NOT be made (offline, rate-limited, no
 * release yet) and is deliberately distinct from `updateAvailable: false`, which
 * is a positive statement that this build is current. Conflating them would make
 * "I could not tell" indistinguishable from "you are up to date" — the same
 * unreadable-is-not-zero rule the loop's spend guard follows.
 */
export const UpdateStatusSchema = z.object({
  current: BuildInfoSchema,
  latest: BuildInfoSchema.nullable(),
  updateAvailable: z.boolean(),
  notes: z.string().nullable(),
});

export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
