import { z } from 'zod';
import {
  RunDetailSchema,
  RunSchema,
  RunSummarySchema,
  RunEventSchema,
  type Run,
  type RunSummary,
  type RunDetail,
  type RunEvent,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

const RunListSchema = z.array(RunSummarySchema);
const RunEventListSchema = z.array(RunEventSchema);

/**
 * The read half of the run model the P6 live monitor sits on. Runs are created
 * by the engine/scheduler, never by this API (there is no `POST /api/runs`), so
 * this client is deliberately read-only: a list, one run, and its append-only
 * event log. The live tail (`useRunStream`) rides the WebSocket beside these;
 * the REST replay here is what a page loads first, before (or without) tailing.
 * Every response is parsed through the SAME shared schema the server validates
 * against — a contract check, not a formality.
 */

/**
 * Owner-scoped list of runs, newest-first — an order the server now genuinely
 * imposes (`started_at DESC, id DESC`). It did not before: `listRuns` issued no
 * `ORDER BY` at all, so this docblock's previous "newest-first as the server
 * returns them" described SQLite's incidental row order, not a promise.
 *
 * R2 — each element is a `RunSummary`, the run row PLUS the pipeline name +
 * version number and trigger name the list renders. Strictly additive over
 * `Run`, so this is a widening, not a breaking change.
 */
export function listRuns(signal?: AbortSignal): Promise<RunSummary[]> {
  return apiFetch('/api/runs', { schema: RunListSchema, signal });
}

/** One run by id (`GET /api/runs/:id`); 404 → `ApiError(404)`. */
export function getRun(id: string, signal?: AbortSignal): Promise<Run> {
  return apiFetch(`/api/runs/${encodeURIComponent(id)}`, { schema: RunSchema, signal });
}

/**
 * R1 — a run WITH the immutable version doc it is bound to, in one call
 * (`GET /api/runs/:id/detail`). The monitor's node-state overlay needs the doc
 * to fold `projectRunState`; a `Run` alone carries only `pipelineVersionId`, and
 * the version routes are pipeline-scoped. 404 → `ApiError(404)`, same as `getRun`.
 */
export function getRunDetail(id: string, signal?: AbortSignal): Promise<RunDetail> {
  return apiFetch(`/api/runs/${encodeURIComponent(id)}/detail`, {
    schema: RunDetailSchema,
    signal,
  });
}

/**
 * A run's durable append-only event log (`GET /api/runs/:id/events`), `seq`
 * ascending. This is the REST replay; the live WebSocket streams the very same
 * envelopes, so a page can render history from here and dedupe live frames by
 * `seq`.
 */
export function getRunEvents(id: string, signal?: AbortSignal): Promise<RunEvent[]> {
  return apiFetch(`/api/runs/${encodeURIComponent(id)}/events`, {
    schema: RunEventListSchema,
    signal,
  });
}
