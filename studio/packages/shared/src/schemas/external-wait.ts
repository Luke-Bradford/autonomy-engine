import { z } from 'zod';

/**
 * #4 A13 — the lifecycle of an `external_waits` correlation row: the durable link
 * between a parked `webhook` node and the inbound HTTP callback that resumes it.
 *
 * `pending` — the webhook node is parked (`external_wait_pending`) and this row is
 *   its live correlation: a valid callback for its token will complete it, and its
 *   expiry alarm will expire it. `completed` / `expired` are TERMINAL and settled
 *   from `pending` exactly once (`WHERE status = 'pending'`), so a completed row is
 *   never downgraded to expired by a late-firing timeout alarm, nor vice-versa.
 *
 * Like `webhook_deliveries` and `scheduled_wakeups`, this is driver INFRA — a row
 * maps a token HASH to a parked (runId, nodeId, attemptId), never part of any
 * resource response and carrying no plaintext secret (the raw token is derived, not
 * stored). The event log stays the domain truth; this row is how an unauthenticated
 * inbound route finds which parked attempt a presented token authorises.
 */
export const ExternalWaitStatusSchema = z.enum(['pending', 'completed', 'expired']);
export type ExternalWaitStatus = z.infer<typeof ExternalWaitStatusSchema>;
