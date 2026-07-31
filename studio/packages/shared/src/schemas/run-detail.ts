import { z } from 'zod';
import { PipelineVersionSchema } from './pipeline.js';
import { RunSchema } from './run.js';

/**
 * R1 — the run-detail READ-MODEL: a run plus the immutable pipeline version it
 * is bound to, in ONE call.
 *
 * It exists because U11 (the run monitor's node-state overlay) needs the DOC.
 * The engine's `createEngine(doc).projectRunState(events)` is the SSOT for what
 * every node's status IS, and it cannot be asked without `nodes`/`edges`/
 * `containers`. A `Run` carries only `pipelineVersionId`, and the version APIs
 * are pipeline-SCOPED (`GET /api/pipelines/:id/versions/:v` keys off the
 * pipeline id + the version NUMBER), neither of which a run exposes. Without
 * this read-model the monitor is stuck folding its own doc-free approximation,
 * which structurally cannot see a node that never dispatched.
 *
 * Shaped as a read-model rather than a bare `GET /api/pipeline-versions/:id`
 * deliberately (`docs/2026-07-14-adf-grade-ui-design.md`, R1): a version-by-id
 * endpoint would make the page a request WATERFALL (fetch run, read its
 * `pipelineVersionId`, fetch version), and it would hand out a full authored doc
 * behind an id whose owner scoping does not ride on the version row at all.
 * Resolving both server-side keeps the ownership proof in one place.
 *
 * NO `events` member, which is a deliberate deviation from the design doc's
 * `{ run, pipelineVersion, events }` sketch: the page already receives the
 * complete log over the WebSocket (`useRunStream` replays from `seq` 0 before
 * tailing), so a second full copy of a potentially thousands-of-frames run log
 * on every page load would ship with no reader. The consequence is recorded
 * where it bites — the overlay is WS-fed, so it renders no statuses at all
 * until the replay completes, rather than drawing an all-`pending` graph that
 * would misreport a finished run as "nothing ran".
 */
export const RunDetailSchema = z.object({
  run: RunSchema,
  pipelineVersion: PipelineVersionSchema,
});
export type RunDetail = z.infer<typeof RunDetailSchema>;
