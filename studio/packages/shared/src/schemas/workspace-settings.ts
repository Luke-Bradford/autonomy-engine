import { z } from 'zod';
import { LOOKUP_ROW_CAP, LOOKUP_ROW_CEILING_MAX } from '../catalog/lookup-config.js';
import { TIMEOUT_SECONDS_SANITY_CEILING } from './pipeline.js';
import { DISPATCH_INPUT_MAX_CHARS } from '../engine/dispatch-input.js';

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
 * #1600 OR41 C7d — `lookupMaxRows` is the opposite kind of setting: a ceiling
 * applied at RUN time to every Lookup, existing pipelines included (a node's own
 * Max rows can only ask for less). Its default is the 1000-row cap every Lookup
 * already had, so an unchanged workspace runs exactly as before (§8); lowering
 * it truncates or fails Lookups that work today, which is the author's change
 * to make. It is read when the Lookup is dispatched, as a connection's limits
 * are, so a retry after a change uses the new value.
 *
 * A workspace that never saved its settings reads the documented default; the
 * server reports which with `stored`. This is the SHAPE; the write rule (the
 * bounds) is `WorkspaceSettingsPutBodySchema`, so a row written under an older
 * rule still reads.
 */
const TimeoutSecondsSchema = z.number().int().positive();
const LookupMaxRowsSchema = z.number().int().positive();

/**
 * #1567 OR36 A4 — how much of a run the log keeps, applied at RUN time to
 * every pipeline, like `lookupMaxRows`:
 * - `level` — `full` also records every `llm_call`'s prompt and completion
 *   unless the node sets its own `capture`;
 * - `inputMaxChars` — each JSON record on a dispatch (input, parameters,
 *   expressions, a control activity's evaluation, a call's parameters);
 * - `outputMaxBytes` — each output field an activity returns, and an HTTP body;
 * - `iterationItemMaxChars` — the ForEach item recorded for each iteration.
 * A cut record keeps its whole length, so the run view says how much was cut.
 */
export const RUN_CAPTURE_LEVELS = ['standard', 'full'] as const;
export const RunCaptureLevelSchema = z.enum(RUN_CAPTURE_LEVELS);
export type RunCaptureLevel = z.infer<typeof RunCaptureLevelSchema>;

/** The hard ceilings a workspace may raise the caps to. */
export const RUN_CAPTURE_CEILINGS = {
  inputMaxChars: 1_000_000,
  outputMaxBytes: 16 * 1024 * 1024,
  iterationItemMaxChars: 1_000_000,
} as const;

export const RunCaptureSchema = z.object({
  level: RunCaptureLevelSchema,
  inputMaxChars: z.number().int().positive(),
  outputMaxBytes: z.number().int().positive(),
  iterationItemMaxChars: z.number().int().positive(),
});
export type RunCapture = z.infer<typeof RunCaptureSchema>;

export const DEFAULT_RUN_CAPTURE: RunCapture = {
  level: 'standard',
  inputMaxChars: DISPATCH_INPUT_MAX_CHARS,
  outputMaxBytes: 1024 * 1024,
  iterationItemMaxChars: 16_000,
};

export const WorkspaceSettingsSchema = z.object({
  defaultActivityTimeoutSeconds: TimeoutSecondsSchema.nullable(),
  lookupMaxRows: LookupMaxRowsSchema,
  runCapture: RunCaptureSchema,
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  defaultActivityTimeoutSeconds: DEFAULT_ACTIVITY_TIMEOUT_SECONDS,
  lookupMaxRows: LOOKUP_ROW_CAP,
  runCapture: DEFAULT_RUN_CAPTURE,
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
 * ceiling would refuse the save anyway. Lookup max rows is bounded by ADF's
 * 5000-row Lookup limit. Every field is required: an omitted one must never be
 * written as its default, silently undoing what was saved (#473).
 */
export const LookupMaxRowsPutSchema = LookupMaxRowsSchema.max(LOOKUP_ROW_CEILING_MAX, {
  message: `Lookup max rows is at most ${LOOKUP_ROW_CEILING_MAX}`,
});

/**
 * #1567 OR36 A4 — the write rule for `runCapture`: a known level, and each cap
 * a whole number between a floor that keeps a record readable and the hard
 * ceiling (`RUN_CAPTURE_CEILINGS`).
 */
export const RUN_CAPTURE_FLOORS = {
  inputMaxChars: 1_000,
  outputMaxBytes: 1_024,
  iterationItemMaxChars: 100,
} as const;

const capBetween = (key: keyof typeof RUN_CAPTURE_CEILINGS, what: string) =>
  z
    .number()
    .int()
    .min(RUN_CAPTURE_FLOORS[key], {
      message: `the ${what} is at least ${RUN_CAPTURE_FLOORS[key]}`,
    })
    .max(RUN_CAPTURE_CEILINGS[key], {
      message: `the ${what} is at most ${RUN_CAPTURE_CEILINGS[key]}`,
    });

export const RunCapturePutSchema = RunCaptureSchema.extend({
  inputMaxChars: capBetween('inputMaxChars', 'input capture limit'),
  outputMaxBytes: capBetween('outputMaxBytes', 'output capture limit'),
  iterationItemMaxChars: capBetween('iterationItemMaxChars', 'item capture limit'),
}).strict();

export const WorkspaceSettingsPutBodySchema = z
  .object({
    defaultActivityTimeoutSeconds: TimeoutSecondsSchema.max(TIMEOUT_SECONDS_SANITY_CEILING, {
      message: `the default activity timeout is at most ${TIMEOUT_SECONDS_SANITY_CEILING} seconds (one year)`,
    }).nullable(),
    lookupMaxRows: LookupMaxRowsPutSchema,
    runCapture: RunCapturePutSchema,
  })
  .strict();
