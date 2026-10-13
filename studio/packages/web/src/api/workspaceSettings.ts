import {
  WorkspaceSettingsResponseSchema,
  type WorkspaceSettings,
  type WorkspaceSettingsResponse,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

/** #1600 OR41 C0f — the workspace's own settings (owner-scoped, unlike `getSettings`). */
export function getWorkspaceSettings(signal?: AbortSignal): Promise<WorkspaceSettingsResponse> {
  return apiFetch('/api/workspace/settings', { schema: WorkspaceSettingsResponseSchema, signal });
}

export function putWorkspaceSettings(body: WorkspaceSettings): Promise<WorkspaceSettingsResponse> {
  return apiFetch('/api/workspace/settings', {
    method: 'PUT',
    body,
    schema: WorkspaceSettingsResponseSchema,
  });
}
