-- #5 S1: the durable-alarm OUTBOX — the ONE time-based firing primitive.
--
-- A driver-owned durable alarm `{dueAt, kind, ref}`: persisted, survives
-- restart, re-armed at boot by re-reading ROWS (not by rebuilding in-memory
-- timers). Every time-based firing consumes it — schedule ticks, retry
-- (#1 D4), `wait` + `webhook` expiry (#4), tumbling windows, lease-expiry
-- reclaim. The alternative this replaces is a per-feature `setTimeout`, which
-- loses every pending alarm on restart.
--
-- The event log stays the DOMAIN truth; this table is driver INFRA — a row
-- says *when to append an event*, never what happened. Like
-- `webhook_deliveries` it is internal bookkeeping, never part of a resource
-- response.
--
-- UNIQUE (kind, dedupe_key) is the load-bearing constraint: it dedupes ARMING,
-- so a reducer command that re-emits on replay upserts the same row instead of
-- arming a duplicate alarm. `dedupe_key` is ALWAYS derived via `buildDedupeKey`
-- (`shared/src/schemas/wakeup.ts`) from (kind, ref, discriminator) — the
-- discriminator (`attempt-<n>`/`round-<r>`/`tick-<epoch>`) is what stops
-- attempt-2's retry from colliding with attempt-1's already-`fired` row and
-- silently never arming.
--
-- CHECK on `status` but NOT on `kind` — the same split the 0002 migration
-- documents (a CHECK mirrors a CLOSED Zod enum; defense-in-depth on the write).
-- `status` is closed and settled. `kind` is deliberately OPEN: no consumer
-- exists yet, so a vocabulary here would be speculative, and pinning a durable
-- field to an enum is a back-compat trap (a CHECK would additionally need a
-- table-recreate migration to add each new kind). The alarm clock's handler
-- REGISTRY is the runtime authority — an unregistered kind is never claimed.
--
-- No `claimed` status and no `claimed_at` column: the fire is ONE transaction
-- (handler + status update), so there is no suspension point between picking a
-- row up and settling it, and a persisted `claimed` state would exist only to
-- be swept after a crash. A crash mid-fire rolls back and leaves the row
-- `pending` — re-delivered next tick, which IS the at-least-once contract. The
-- multi-worker claim lease (`claimed_by`/`claim_expires`) that spec #5's spike
-- block flags for a later S-tier lands as one coherent change if the scheduler
-- ever scales past better-sqlite3's single writer.
--
-- No FK on `ref`: it is a per-kind typed JSON handle (runId/nodeId/attemptId/
-- triggerId/windowKey/leaseToken), not one column, and its shape varies by
-- kind. Referential currency is NOT an FK's job here — a wakeup whose target
-- is gone or stale must be SUPPRESSED (a durable, observable outcome the
-- handler decides via its freshness check), not silently cascade-deleted.
-- Each handler declares a `refSchema`, validated when the alarm is armed.
--
-- Index (status, due_at) serves the claim scan — "pending rows due by now",
-- the only hot query — leading with the equality column. Retention: `fired`/
-- `suppressed`/`cancelled` rows accumulate with no prune path today, the same
-- gap `webhook_deliveries` has (#421); filed as a sibling, deliberately not
-- solved here (a retention policy needs the consumers' replay semantics, which
-- do not exist yet).

CREATE TABLE scheduled_wakeups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'suppressed', 'cancelled')),
  fired_at INTEGER,
  superseded_by TEXT
);

CREATE UNIQUE INDEX scheduled_wakeups_kind_dedupe_key_idx
  ON scheduled_wakeups (kind, dedupe_key);
CREATE INDEX scheduled_wakeups_status_due_at_idx
  ON scheduled_wakeups (status, due_at);
