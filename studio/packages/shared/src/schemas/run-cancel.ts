import { z } from 'zod';

/**
 * CX2 (#1320) — the `202` body of `POST /api/runs/:id/cancel`. Shared FE/BE for
 * the reason `RerunAcceptedSchema` is: the server's reply is typed by it and the
 * web client parses with it, so the two ends cannot drift apart silently.
 *
 * `state` says how far the cancel got by the time the route answered, and the two
 * values mean different things (spec D5/D6):
 *  - `requested` — the cancel is recorded as an intent and will be folded by
 *    whichever holder owns the run's state. It is NOT done: in-flight work stops
 *    cooperatively, and the run may still finish `success` if its last node
 *    completes first (D3). Poll the run for its terminal status.
 *  - `cancelled` — the run was still `queued` (held by admission, no event log),
 *    so the cancel was a row patch and the run is already terminal.
 *
 * There is no request body: the cancel's source is set by the server, never
 * typed by the operator (spec D2).
 */
export const RunCancelAcceptedSchema = z.object({
  runId: z.string().min(1),
  state: z.enum(['requested', 'cancelled']),
});
export type RunCancelAccepted = z.infer<typeof RunCancelAcceptedSchema>;
