import { BuildInfoSchema, type BuildInfo } from '@autonomy-studio/shared';
import { apiFetch } from './client';

/**
 * The running build's identity. Parsed through the SAME shared schema the server
 * validates against, exactly as the other clients in this directory do — a
 * contract check between the two halves, not a formality.
 */
export function getVersion(signal?: AbortSignal): Promise<BuildInfo> {
  return apiFetch('/api/version', { schema: BuildInfoSchema, signal });
}
