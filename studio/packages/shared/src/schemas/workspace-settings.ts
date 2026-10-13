import { z } from 'zod';
import { TIMEOUT_SECONDS_SANITY_CEILING } from './pipeline.js';

/**
 * #1600 OR41 C0f — ADF's activity timeout default: 12 hours.
 * https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities
 */
export const DEFAULT_ACTIVITY_TIMEOUT_SECONDS = 43_200;

/**
 * #1600 OR41 C0f — a workspace's own settings (`GET/PUT /api/workspace/settings`),
 * owner-scoped. Unlike `AppSettings`, which reports facts about the host process,
 * these are the workspace author's choices.
 *
 * `defaultActivityTimeoutSeconds` is the Timeout a NEW execution activity is
 * created with, written into its `policy.timeoutSeconds` as ADF writes
 * `0.12:00:00` into a new activity's JSON. It is not applied at run time: a node
 * with no timeout still runs without one. That keeps catalogue §8's rule that a
 * new default never changes what an existing pipeline does, and it keeps the
 * value visible in the doc (UI standard rule 3). `null` turns the default off,
 * so new activities are created with no timeout, as before C0f.
 *
 * A workspace that never saved its settings reads the documented default; the
 * server reports which with `stored`.
 */
const TimeoutSecondsSchema = z.number().int().positive();

export const WorkspaceSettingsSchema = z.object({
  defaultActivityTimeoutSeconds: TimeoutSecondsSchema.nullable(),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  defaultActivityTimeoutSeconds: DEFAULT_ACTIVITY_TIMEOUT_SECONDS,
};

/** `GET /api/workspace/settings` and the `PUT`'s reply. */
export const WorkspaceSettingsResponseSchema = z.object({
  settings: WorkspaceSettingsSchema,
  /** `false` while the workspace has never saved, so `settings` are the defaults. */
  stored: z.boolean(),
});

export type WorkspaceSettingsResponse = z.infer<typeof WorkspaceSettingsResponseSchema>;

/**
 * `PUT /api/workspace/settings` — the whole document, `.strict()`. The timeout
 * takes the node policy's write-path ceiling, for the same reason: past a year it
 * is a typo, and the value is copied into every new node's policy, where that
 * ceiling would refuse the save anyway.
 */
export const WorkspaceSettingsPutBodySchema = z
  .object({
    defaultActivityTimeoutSeconds: TimeoutSecondsSchema.max(TIMEOUT_SECONDS_SANITY_CEILING, {
      message: `the default activity timeout is at most ${TIMEOUT_SECONDS_SANITY_CEILING} seconds (one year)`,
    }).nullable(),
  })
  .strict();
