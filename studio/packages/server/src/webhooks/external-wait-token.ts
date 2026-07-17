import { createHmac, createHash } from 'node:crypto';

/**
 * #4 A13 — the correlation-token SSOT for `webhook` external-wait.
 *
 * When a `webhook` node parks, an inbound HTTP callback must be able to (a) prove
 * it is authorised to resume THIS parked node and (b) be correlated to its
 * (runId, nodeId, attemptId). A high-entropy capability token — carried in the
 * callback URL (`POST /api/external-wait/:token`) — does both: holding it IS the
 * authorisation, and it maps to exactly one parked attempt.
 *
 * The token is DERIVED DETERMINISTICALLY, not random, and that choice is
 * load-bearing on two fronts:
 *   1. **Crash-recovery reproducibility.** A crash between the alarm/row arm and
 *      the `externalWait.created` append re-derives the node `ready`, which
 *      re-emits `scheduleExternalWait`; `armExternalWait` runs again and MUST
 *      reproduce the identical token so the already-issued callback URL still
 *      resolves. A random token could not (only its hash is persisted). Keying the
 *      HMAC on the replay-stable `(runId, nodeId, attemptId)` makes the re-arm
 *      yield the same token — the same reason `deterministicChildRunId` keys a
 *      child run id on `(runId, nodeId, attemptId)`.
 *   2. **No plaintext secret at rest, anywhere.** Only `sha256(token)` is stored
 *      (in the `external_waits` row, for the inbound lookup) and the raw token is
 *      NEVER written to `run_events` (which is served raw, streamed and bussed) —
 *      it is re-derived on demand from an owner-scoped endpoint. This mirrors the
 *      codebase's "encrypt/never-store secrets at rest" posture.
 *
 * The master key is the same secret that encrypts connection secrets, so the
 * token is unforgeable without it AND the `(runId, nodeId, attemptId)` inputs
 * include the unguessable `attemptId` (`${nodeId}#${attempts}` — minted, but the
 * run id itself is a nanoid). Callers in the driver reach this via a seam closed
 * over the master key; the routes (which hold `fastify.masterKey`) call it
 * directly — one derivation, so the three sites can never disagree.
 */

/**
 * The HMAC message binding a token to exactly one parked attempt. `JSON.stringify`
 * of the tuple is a collision-free encoding regardless of the ids' contents (nodeId
 * is user-authored, so a plain delimiter could be forged inside it); the array form
 * quotes/escapes each element, so no two distinct triples share a message.
 */
function tokenMessage(args: { runId: string; nodeId: string; attemptId: string }): string {
  return JSON.stringify([args.runId, args.nodeId, args.attemptId]);
}

/**
 * Derive the capability token for a parked webhook attempt: base64url of
 * `HMAC-SHA256(masterKey, tokenMessage)`. Deterministic — the same inputs always
 * yield the same token.
 */
export function deriveExternalWaitToken(
  masterKey: Uint8Array,
  args: { runId: string; nodeId: string; attemptId: string },
): string {
  return createHmac('sha256', masterKey).update(tokenMessage(args)).digest('base64url');
}

/**
 * The at-rest handle for a token: `sha256(token)` as lowercase hex. Stored in the
 * `external_waits` row so an inbound caller's presented token is matched by hash
 * (the raw token is never persisted). A hash — not the raw token — because the row
 * is queried by an UNAUTHENTICATED inbound route: a DB read never exposes a live
 * bearer credential.
 */
export function hashExternalWaitToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
