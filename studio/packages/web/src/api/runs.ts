import { z } from 'zod';
import { RunSchema, RunEventSchema, type Run, type RunEvent } from '@autonomy-studio/shared';
import { apiFetch } from './client';

const RunListSchema = z.array(RunSchema);
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

/** Owner-scoped list of runs, newest-first as the server returns them. */
export function listRuns(signal?: AbortSignal): Promise<Run[]> {
  return apiFetch('/api/runs', { schema: RunListSchema, signal });
}

/** One run by id (`GET /api/runs/:id`); 404 → `ApiError(404)`. */
export function getRun(id: string, signal?: AbortSignal): Promise<Run> {
  return apiFetch(`/api/runs/${encodeURIComponent(id)}`, { schema: RunSchema, signal });
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
