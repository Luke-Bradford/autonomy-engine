-- P4c: durable webhook-delivery ledger for replay protection + caller
-- idempotency.
--
-- A webhook fire is admitted to the launcher AT MOST ONCE per
-- `(trigger_id, idempotency_key)`. The UNIQUE index is the atomic guard: two
-- concurrent identical (authenticated) deliveries both reach the INSERT, but
-- only one succeeds — the other hits the constraint and is served as a
-- `duplicate` without firing. The row is DURABLE (survives a process restart),
-- which an in-memory nonce cache would not, so a replay after a reboot is still
-- caught within — and beyond — the signature's timestamp tolerance window.
--
-- `idempotency_key` is the caller's `x-webhook-idempotency-key` when supplied,
-- else the request signature itself (deterministic in secret+timestamp+body).
--
-- `ON DELETE CASCADE`: deleting a trigger discards its delivery history (the
-- webhook endpoint for that trigger no longer exists, so its idempotency ledger
-- is meaningless). `received_at` is indexed for age-based pruning.
--
-- `run_id` is deliberately a BARE column (no FK to `runs`): the ledger is
-- provenance/idempotency bookkeeping, never joined for correctness, and a run
-- may be deleted/archived while its delivery record is kept — a dangling
-- `run_id` is harmless here.

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES triggers (id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'started', 'queued', 'skipped')),
  run_id TEXT,
  received_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX webhook_deliveries_trigger_key_idx
  ON webhook_deliveries (trigger_id, idempotency_key);
CREATE INDEX webhook_deliveries_received_at_idx
  ON webhook_deliveries (received_at);
