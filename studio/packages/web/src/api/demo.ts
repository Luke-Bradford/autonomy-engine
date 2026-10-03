import {
  DemoRemoveResponseSchema,
  DemoSeedResponseSchema,
  DemoStatusSchema,
  type DemoRemoveResponse,
  type DemoSeedResponse,
  type DemoStatus,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

/** #1481 OR32 — whether any of the demo's resources exist (`GET /api/demo`). */
export function getDemoStatus(signal?: AbortSignal): Promise<DemoStatus> {
  return apiFetch('/api/demo', { schema: DemoStatusSchema, signal });
}

/**
 * Loads the demo (`POST /api/demo/seed`). Sent with NO body, so no JSON
 * content type: Fastify refuses an empty body that claims to be JSON.
 */
export function loadDemo(): Promise<DemoSeedResponse> {
  return apiFetch('/api/demo/seed', { method: 'POST', schema: DemoSeedResponseSchema });
}

/** Removes the demo, its run history and its files (`DELETE /api/demo`). */
export function removeDemo(): Promise<DemoRemoveResponse> {
  return apiFetch('/api/demo', { method: 'DELETE', schema: DemoRemoveResponseSchema });
}
