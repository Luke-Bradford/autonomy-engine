import { AppSettingsSchema, type AppSettings } from '@autonomy-studio/shared';
import { apiFetch } from './client';

/**
 * The process-level settings the Settings page reads (U15 slice 2, #1094).
 *
 * Parsed through the SAME shared schema the server's payload is typed against,
 * like every other client here. That is load-bearing rather than ceremonial for
 * this one: `MasterKeyStatusSchema`'s refinement is what rejects a `generated`
 * status with no path — an advisory telling the operator to back up a file it
 * cannot name — and the server builds its response with `satisfies` rather than
 * a parse, so this is where that check actually runs.
 */
export function getSettings(signal?: AbortSignal): Promise<AppSettings> {
  return apiFetch('/api/settings', { schema: AppSettingsSchema, signal });
}
