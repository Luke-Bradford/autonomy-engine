import {
  GlobalParamSchema,
  paginatedResponseSchema,
  type GlobalParam,
  type GlobalParamCreateBody,
  type GlobalParamPatchBody,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';
import { fetchAllPages, pageQuery } from './pagination';

/**
 * #844 GL2 — the client half of the workspace global-params store (spec
 * `studio/docs/2026-09-27-foundation-global-params.md` GL-D1). The bodies are
 * the SHARED write types the routes parse, so the page cannot drift from the
 * server's rules.
 *
 * Values are cleartext configuration (GL-D5), so unlike `secrets.ts` every
 * response here carries the value.
 */
const GlobalParamPageSchema = paginatedResponseSchema(GlobalParamSchema);

/** Owner-scoped list, every page walked (the `Promise<T[]>` contract the other list wrappers present). */
export function listGlobalParams(signal?: AbortSignal): Promise<GlobalParam[]> {
  return fetchAllPages((cursor) =>
    apiFetch(`/api/global-params${pageQuery(cursor)}`, { schema: GlobalParamPageSchema, signal }),
  );
}

/** A case-variant of an existing name is a 409: names are unique per owner `COLLATE NOCASE`. */
export function createGlobalParam(body: GlobalParamCreateBody): Promise<GlobalParam> {
  return apiFetch('/api/global-params', { method: 'POST', body, schema: GlobalParamSchema });
}

/** `value` and `description` only — `name` and `type` are immutable (GL-D1); the route 400s either. */
export function updateGlobalParam(id: string, body: GlobalParamPatchBody): Promise<GlobalParam> {
  return apiFetch(`/api/global-params/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: GlobalParamSchema,
  });
}

export function deleteGlobalParam(id: string): Promise<void> {
  return apiFetch<void>(`/api/global-params/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
