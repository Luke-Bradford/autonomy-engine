import { eq } from 'drizzle-orm';
import {
  DEFAULT_WORKSPACE_SETTINGS,
  WorkspaceSettingsSchema,
  type WorkspaceSettings,
  type WorkspaceSettingsResponse,
} from '@autonomy-studio/shared';
import { workspaceSettings } from '../db/schema.js';
import type { Db } from './types.js';

/**
 * #1600 OR41 C0f — a workspace's settings. The write rule (the timeout's
 * ceiling) is the route's `WorkspaceSettingsPutBodySchema`; this module persists
 * and decodes SHAPE only, so a row written under an older rule still reads.
 *
 * A workspace with no row reads `DEFAULT_WORKSPACE_SETTINGS` with
 * `stored: false`. That default is the documented one, not a manufactured fact,
 * and the response says which it is.
 */
export function getWorkspaceSettings(db: Db, ownerId: string): WorkspaceSettingsResponse {
  const row = db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.ownerId, ownerId))
    .get();
  if (row === undefined) {
    return {
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS,
        runCapture: { ...DEFAULT_WORKSPACE_SETTINGS.runCapture },
      },
      stored: false,
    };
  }
  return {
    settings: WorkspaceSettingsSchema.parse({
      defaultActivityTimeoutSeconds: row.defaultActivityTimeoutSeconds,
      lookupMaxRows: row.lookupMaxRows,
      runCapture: {
        level: row.runCaptureLevel,
        inputMaxChars: row.runCaptureInputMaxChars,
        outputMaxBytes: row.runCaptureOutputMaxBytes,
        iterationItemMaxChars: row.runCaptureIterationItemMaxChars,
      },
    }),
    stored: true,
  };
}

/** Writes the whole document: an upsert on the owner's one row. */
export function putWorkspaceSettings(
  db: Db,
  ownerId: string,
  input: WorkspaceSettings,
): WorkspaceSettingsResponse {
  const { runCapture, ...rest } = WorkspaceSettingsSchema.parse(input);
  const columns = {
    ...rest,
    runCaptureLevel: runCapture.level,
    runCaptureInputMaxChars: runCapture.inputMaxChars,
    runCaptureOutputMaxBytes: runCapture.outputMaxBytes,
    runCaptureIterationItemMaxChars: runCapture.iterationItemMaxChars,
  };
  const now = Date.now();
  db.insert(workspaceSettings)
    .values({ ownerId, ...columns, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: workspaceSettings.ownerId,
      set: { ...columns, updatedAt: now },
    })
    .run();
  return getWorkspaceSettings(db, ownerId);
}
