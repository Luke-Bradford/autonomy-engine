import { z } from 'zod';
import {
  PipelineSchema,
  PipelineVersionSchema,
  type Pipeline,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

const PipelineListSchema = z.array(PipelineSchema);
const PipelineVersionListSchema = z.array(PipelineVersionSchema);

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
