-- #5 S5b-1 — the ADF recurrence MODEL: a structured `{frequency, interval,
-- schedule?}` object authored on a schedule trigger and compiled to the cron
-- string stored in `triggers.schedule` (a derived cache). Full rationale:
-- `studio/docs/2026-07-14-foundation-scheduler-lifecycle.md` §S2 + the
-- `packages/shared/src/schemas/recurrence.ts` header.
--
-- Nullable with NO default, exactly like `triggers.run_windows` (the JSON-column
-- precedent): NULL is the HONEST value for every existing row — those triggers
-- were authored with a raw cron `schedule` (or no schedule at all) and never had
-- a recurrence. NULL records what they ARE (raw-cron / non-schedule), not a
-- manufactured empty object (contrast #473's fail-open `.default([])`). A native
-- `ADD COLUMN` (no table recreate), so it disturbs no index/trigger; `triggers`
-- carries no immutability trigger (it is mutable by design).

ALTER TABLE triggers ADD COLUMN recurrence TEXT;
