import { z } from 'zod';
import { RunEventSchema } from './run.js';

/**
 * The FE/BE contract for the P6 live-run-monitor WebSocket
 * (`GET /api/runs/:id/events/stream`). The server streams the very same
 * `run_events` envelopes the REST replay endpoint returns — so a late-joiner
 * that first replays the DB and then tails the socket sees ONE uniform event
 * shape, deduplicated by the monotonic `seq`. Only the server ever sends these;
 * the client sends nothing (a pure tail), so this is the whole wire vocabulary.
 */

/** A single durable run event — either replayed from the DB on connect, or a
 * live append tailed off the in-process bus. Identical shape both ways; the
 * client orders/dedupes purely by `event.seq`. */
export const RunStreamEventMessageSchema = z.object({
  kind: z.literal('event'),
  event: RunEventSchema,
});
export type RunStreamEventMessage = z.infer<typeof RunStreamEventMessageSchema>;

/**
 * Sent exactly once, immediately after the initial DB replay has been fully
 * flushed, so the UI can flip from "loading history" to "live". `throughSeq` is
 * the highest `seq` the replay covered (`-1` when the run had no events yet);
 * every subsequent `event` message carries `seq > throughSeq`.
 */
export const RunStreamReplayCompleteMessageSchema = z.object({
  kind: z.literal('replay_complete'),
  throughSeq: z.number().int(),
});
export type RunStreamReplayCompleteMessage = z.infer<typeof RunStreamReplayCompleteMessageSchema>;

/** Every message the server can push over the run-events socket. */
export const RunStreamServerMessageSchema = z.discriminatedUnion('kind', [
  RunStreamEventMessageSchema,
  RunStreamReplayCompleteMessageSchema,
]);
export type RunStreamServerMessage = z.infer<typeof RunStreamServerMessageSchema>;
