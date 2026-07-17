-- #4 A13: the `webhook` external-wait CORRELATION store.
--
-- A `webhook` control node parks the run `external_wait_pending` until an inbound
-- HTTP callback appends `externalWait.completed` (or its expiry alarm appends
-- `externalWait.expired`). One row here links a parked (run_id, node_id,
-- attempt_id) to the SHA-256 hash of its capability token, so the inbound route
-- `POST /api/external-wait/:token` can authenticate a callback (token → hash →
-- row) and correlate it to the exact parked attempt.
--
-- The RAW token is NEVER stored — only its hash. The row is read by an
-- UNAUTHENTICATED inbound route, so a DB read must never expose a live bearer
-- credential; the token is re-DERIVED on demand as HMAC(masterKey, ...)
-- (`webhooks/external-wait-token.ts`), the same "no plaintext secret at rest"
-- posture as the encrypted connection secrets.
--
-- UNIQUE (token_hash) is the inbound lookup's only query. UNIQUE (run_id,
-- node_id, attempt_id) is load-bearing for crash recovery: a driver re-arm on
-- resume upserts the SAME row (INSERT OR IGNORE) rather than minting a second
-- token, mirroring `scheduled_wakeups`' (kind, dedupe_key) dedupe. Because the
-- token is DERIVED deterministically from (run_id, node_id, attempt_id), the
-- re-arm reproduces the identical token → identical hash → the conflict is a
-- no-op, and the already-issued callback URL keeps resolving.
--
-- CHECK on `status` mirrors the closed `ExternalWaitStatusSchema` enum (the same
-- defense-in-depth the 0002/0005 migrations apply). A row settles
-- pending → completed/expired exactly once (every transition is
-- `WHERE status = 'pending'`), so a completed row is never downgraded to expired
-- by a late-firing timeout alarm.
--
-- run_id FKs `runs` ON DELETE CASCADE: an external-wait row is meaningless once
-- its run is gone (unlike `webhook_deliveries`, which keeps a bare provenance
-- run_id). This is live driver state, never provenance.

CREATE TABLE external_waits (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE UNIQUE INDEX external_waits_token_hash_idx ON external_waits (token_hash);
CREATE UNIQUE INDEX external_waits_run_node_attempt_idx ON external_waits (run_id, node_id, attempt_id);
