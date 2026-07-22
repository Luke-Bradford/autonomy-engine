-- #5 S7 (#465) — `supersede` (cancel-old + arm-new) lands with its first
-- consumer, the lease heartbeat. `superseded_by` records the replacement row's
-- id on the cancelled row: provenance only, no self-FK, never joined for
-- correctness (the `webhook_deliveries.run_id` precedent). Deferred from S1
-- under the "a column with no writer is unreachable surface" rule — a native
-- add-column here is exactly why deferring cost nothing.
ALTER TABLE scheduled_wakeups ADD COLUMN superseded_by TEXT;
