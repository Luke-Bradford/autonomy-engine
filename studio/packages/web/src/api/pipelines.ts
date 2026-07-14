import { z } from 'zod';
import {
  NewPipelineSchema,
  NewPipelineVersionSchema,
  PipelineSchema,
  PipelineVersionSchema,
  type Pipeline,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

const PipelineListSchema = z.array(PipelineSchema);
const PipelineVersionListSchema = z.array(PipelineVersionSchema);

/**
 * Client write bodies, derived from the SAME shared insert schemas the server
 * routes use (`packages/server/src/routes/pipelines.ts`), so the form's
 * client-side validation is identical to the server's — one source of truth.
 * `ownerId` is stamped server-side from the principal; `pipelineId` comes from
 * the route param, never the body.
 */
export const PipelineWriteSchema = NewPipelineSchema.omit({ ownerId: true });
export type PipelineWrite = z.input<typeof PipelineWriteSchema>;

export const PipelineVersionWriteSchema = NewPipelineVersionSchema.omit({ pipelineId: true });
export type PipelineVersionWrite = z.input<typeof PipelineVersionWriteSchema>;

/** Owner-scoped list of pipelines (`GET /api/pipelines`). */
export function listPipelines(signal?: AbortSignal): Promise<Pipeline[]> {
  return apiFetch('/api/pipelines', { schema: PipelineListSchema, signal });
}

/**
 * The immutable versions of one pipeline (`GET /api/pipelines/:id/versions`),
 * newest-or-oldest order as the server returns them. The Triggers page uses
 * these to offer a version-binding dropdown; a run/trigger always binds a
 * specific version id, never "latest".
 */
export function listPipelineVersions(
  pipelineId: string,
  signal?: AbortSignal,
): Promise<PipelineVersion[]> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`, {
    schema: PipelineVersionListSchema,
    signal,
  });
}

/** Create a pipeline (`POST /api/pipelines`). The server assigns the id. */
export function createPipeline(body: PipelineWrite): Promise<Pipeline> {
  return apiFetch('/api/pipelines', { method: 'POST', body, schema: PipelineSchema });
}

/** Fetch one pipeline (`GET /api/pipelines/:id`); 404 → `ApiError(404)`. */
export function getPipeline(id: string, signal?: AbortSignal): Promise<Pipeline> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(id)}`, { schema: PipelineSchema, signal });
}

/**
 * Delete a pipeline (`DELETE /api/pipelines/:id`, 204). The server refuses
 * (409 `pipeline_has_runs`) when the pipeline has run history — the caller
 * catches `ApiError.status === 409` for a friendly message.
 */
export function deletePipeline(id: string): Promise<void> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Save the canvas as a NEW immutable version (`POST /api/pipelines/:id/versions`).
 * A pipeline version is never updated in place — every save is a new row, whose
 * `version` the server auto-increments and whose `catalogVersion` it defaults to
 * the current catalog (the body omits it).
 */
export function createPipelineVersion(
  pipelineId: string,
  body: PipelineVersionWrite,
): Promise<PipelineVersion> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`, {
    method: 'POST',
    body,
    schema: PipelineVersionSchema,
  });
}
