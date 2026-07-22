-- #2 L14c — the per-connection quota RESET-WINDOW store (the PROACTIVE half of
-- the CLI/subscription quota primitive; the reactive half — pattern-match a
-- subprocess's exhaustion output into a `rate_limit` failure — shipped in the
-- first L14c slice on `connectors/agent.ts`).
--
-- A subscription CLI (`agent_cli`) has a usage quota that resets on a rolling
-- window. When ONE dispatch discovers exhaustion (a durable
-- `node.failed{code:'rate_limit', retryAfterSeconds}` on an `agent_cli`
-- connection), the driver records the reset epoch here, keyed by the resolved
-- `connection_id` it dispatched with (L13a `${}` routing means the id is a
-- frozen fact on the event, not the node's template string). Every SUBSEQUENT
-- dispatch of that shared connection, in ANY run, reads this row at pre-flight
-- and short-circuits to the same `rate_limit` retry WITHOUT spawning a doomed
-- subprocess (the admission gate).
--
-- ONE row per connection (connection_id PRIMARY KEY, upserted MAX-of-window so a
-- longer window is never shortened). reset_epoch_ms is a STORED fact anchored to
-- the failure event's durable `ts` (never recomputed at read time);
-- updated_at_ms is a last-write AUDIT stamp (read nowhere; it advances on every
-- write, so on a MAX-upsert that keeps an earlier window it stamps the newest
-- write, not the kept window). The driver is the SOLE WRITER (the studio analog
-- of the engine's
-- reset-epoch-split invariant; the adapter only EXTRACTS the window). The layer
-- is a best-effort OPTIMISATION over the already-correct reactive path: an absent
-- row means "not known exhausted", so a missed write degrades to reactive
-- behaviour, never to incorrectness (fail-safe, never fail-open).
--
-- connection_id FKs `connections` ON DELETE CASCADE: a window is meaningless once
-- its connection is gone. Driver INFRA, never part of a resource response.

CREATE TABLE connection_quota_state (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  reset_epoch_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
