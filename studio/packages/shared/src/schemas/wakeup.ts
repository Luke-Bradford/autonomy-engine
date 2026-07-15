import { z } from 'zod';

/**
 * #5 S1 — the durable-alarm OUTBOX row (`scheduled_wakeups`).
 *
 * The ONE time-based firing primitive: `{dueAt, kind, ref}` persisted, surviving
 * restart, re-armed at boot. Every time-based firing consumes it — schedule
 * ticks, retry (`node.retryDue`, #1), `wait` (#4), `webhook` expiry (#4),
 * tumbling windows, and lease-expiry reclaim. NOT a per-feature timer.
 *
 * The **event log is the domain truth; `scheduled_wakeups` is driver infra** —
 * a wakeup row is bookkeeping about *when to append an event*, never a fact
 * about the run itself. Like `webhook_deliveries`, it is never reachable from an
 * HTTP client projection.
 *
 * Lives in `shared` (not server-local) for a mechanical reason, not a
 * client-facing one: `db/schema.ts` sources every enum column's vocabulary from
 * the Zod `.options` via `asEnumTuple(...)`, so `WakeupStatusSchema` must be
 * importable from `@autonomy-studio/shared` for the enum to have ONE source.
 */

/**
 * The row's lifecycle. `pending` is the only non-terminal state; the other three
 * are the three distinct ways an alarm stops mattering, each with its own
 * writer:
 *
 * - `fired`     — the clock ran the kind's handler and it acted.
 * - `suppressed` — the handler declined: the alarm was no longer CURRENT (a
 *   stale retry, an expired lease, a disabled/unbound/out-of-window trigger).
 *   Distinct from `cancelled` because nobody disarmed it — it came due and the
 *   freshness check said no. Spec #5: "every due event re-checks currency
 *   before it fires, so stale retries / expired leases / disabled triggers
 *   can't emit valid-looking events."
 * - `cancelled` — disarmed before it came due (a `wait` node cancelled), or
 *   replaced by `supersedeWakeup` (then `supersededBy` names the replacement).
 *
 * Deliberately NO `claimed`: the fire is ONE transaction (handler + status
 * update together — see `scheduler/alarms.ts`), so there is no suspension point
 * between picking a row up and settling it, and a persisted `claimed` state
 * would exist only to be swept up after a crash. The multi-worker claim LEASE
 * (`claimed_by`/`claim_expires`/`claimedAt`) that spec #5's spike block flags as
 * a later S-tier lands as one coherent change when the scheduler actually
 * scales past better-sqlite3's single writer.
 */
export const WakeupStatusSchema = z.enum(['pending', 'fired', 'suppressed', 'cancelled']);
export type WakeupStatus = z.infer<typeof WakeupStatusSchema>;

/**
 * The typed handle a wakeup points AT (spec #5: "Typed `ref` + freshness
 * predicate per kind — runId/nodeId/attemptId/timerId/triggerId/windowKey/
 * leaseToken"). A flat `string → string` map on purpose:
 *
 *  1. every named ref field above is a string id, and
 *  2. it makes `buildDedupeKey`'s serialisation trivially deterministic — no
 *     number formatting, no nesting, no `undefined`-vs-absent ambiguity.
 *
 * The per-kind SHAPE (`{runId, nodeId, attemptId}` for retry, `{triggerId}` for
 * a schedule tick) is declared by each handler's `refSchema` and validated when
 * the alarm is ARMED — see `scheduler/alarms.ts`. Validating at arm time rather
 * than at fire time means a malformed ref fails at the call site that wrote it,
 * not hours later in a background tick.
 */
export const WakeupRefSchema = z.record(z.string(), z.string());
export type WakeupRef = z.infer<typeof WakeupRefSchema>;

/**
 * Serialise a `ref` to a deterministic string: keys SORTED, values JSON-escaped.
 *
 * Load-bearing, not cosmetic. `ref` is a JSON object, so a plain
 * `JSON.stringify` keys off INSERTION order — the same logical alarm armed from
 * two call sites (or re-armed on replay from a differently-ordered literal)
 * would produce two different `dedupeKey`s, both would pass the UNIQUE
 * (kind, dedupeKey) index, and the alarm would double-fire. Sorting is what
 * makes "same ref" mean "same key".
 *
 * `JSON.stringify` per entry (rather than a `join`) keeps it INJECTIVE: a bare
 * `Object.values(ref).join(':')` would make `{a:'x:y'}` and `{a:'x',b:'y'}`
 * collide. Pinned by test.
 *
 * (This is NOT #3 G1's canonicalizer — that one hashes pipeline docs for git,
 * and owns number formatting + nesting this deliberately does not have.)
 */
function serializeRef(ref: WakeupRef): string {
  const entries = Object.keys(ref)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(ref[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Build a wakeup's `dedupeKey` — the SSOT for alarm IDENTITY, and a SPEC
 * artifact rather than an impl detail (spec #5's spike block).
 *
 * `(kind, ref, discriminator)`, where `discriminator` distinguishes the
 * OCCURRENCE: `attempt-<n>` (retry), `round-<r>` (loop), `tick-<epoch>` (cron).
 *
 * **`discriminator` is required, and that is the whole point.** The spike's
 * headline finding: omit the attempt number and attempt-2's retry collides with
 * attempt-1's already-`fired` row, so — because arming is an idempotent
 * upsert-if-absent — it **silently never arms**. No error, no retry, no trace.
 * Making the field impossible to forget is the fix; an empty string is rejected
 * for the same reason.
 *
 * `kind` is included even though the index is `(kind, dedupeKey)` and the column
 * already carries it. Deliberate: it keeps the key SELF-DESCRIBING in logs and
 * in a DB browser, where a bare `{...}:attempt-1` would not say what it arms.
 * The redundancy costs nothing and matches the spec's `(kind, ref,
 * discriminator)` wording verbatim.
 */
export function buildDedupeKey(input: {
  kind: string;
  ref: WakeupRef;
  discriminator: string;
}): string {
  const { kind, ref, discriminator } = z
    .object({
      kind: z.string().min(1),
      ref: WakeupRefSchema,
      discriminator: z.string().min(1),
    })
    .parse(input);
  return `${kind}:${serializeRef(ref)}:${discriminator}`;
}

/**
 * The caller-facing input to the ONE write path a wakeup row has (`armWakeup`).
 *
 * Named for the call, not `NewScheduledWakeup`, following the note in
 * `webhook-delivery.ts`: `id`/`status`/`firedAt`/`supersededBy` are all
 * server-set, so an insert schema spanning them would mis-model the write path.
 * The caller supplies WHEN (`dueAt`), WHAT (`kind`), AT-WHAT (`ref`) and
 * WHICH-OCCURRENCE (`discriminator`); the `dedupeKey` is DERIVED from those via
 * `buildDedupeKey`, never passed in — so no caller can hand-spell a key and
 * skip the discriminator.
 */
export const ArmWakeupInputSchema = z.object({
  /**
   * Open `z.string()`, no enum, no CHECK. At S1 no consumer exists, so a closed
   * vocabulary would be speculative; and `kind` is a durable field, which makes
   * an enum a back-compat trap (the reasoning `node.failed.code` records in
   * `engine/types.ts`). The alarm clock's handler REGISTRY is the runtime
   * authority: a kind with no registered handler is never claimed.
   */
  kind: z.string().min(1),
  ref: WakeupRefSchema,
  /**
   * Epoch ms. A STORED FACT, never recomputed at fold time (spec #5's spike
   * block: `nextRetryAt`/backoff lives here so the reducer stays clock-free and
   * replay is deterministic).
   */
  dueAt: z.number().int(),
  /** See `buildDedupeKey` — `attempt-<n>` / `round-<r>` / `tick-<epoch>`. */
  discriminator: z.string().min(1),
});
export type ArmWakeupInput = z.infer<typeof ArmWakeupInputSchema>;

/** A durable `scheduled_wakeups` row. */
export const ScheduledWakeupSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  ref: WakeupRefSchema,
  dueAt: z.number().int(),
  dedupeKey: z.string().min(1),
  status: WakeupStatusSchema,
  /** Epoch ms the clock settled this row; null while `pending`. */
  firedAt: z.number().int().nullable(),
  /** The replacement row's id when `supersedeWakeup` cancelled this one. */
  supersededBy: z.string().min(1).nullable(),
});
export type ScheduledWakeup = z.infer<typeof ScheduledWakeupSchema>;
