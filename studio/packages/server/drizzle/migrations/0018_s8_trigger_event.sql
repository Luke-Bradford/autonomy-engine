-- #5 S8 — event-mode trigger firing: the named-channel SUBSCRIPTION config
-- (`{name, …}`) an `event` trigger fires on (an authed `POST /api/events
-- {name, …}` fans out to every enabled, owner-matching event trigger subscribed
-- to that name). Full rationale: the scheduler-lifecycle spec §S4/S8 + the
-- `EventConfigSchema` header in `packages/shared/src/schemas/trigger.ts`.
--
-- Nullable with NO default, exactly like `triggers.recurrence` (0010) and
-- `run_windows`: NULL is the HONEST value for every existing row — a non-event
-- trigger has no subscription, and a pre-S8 `mode:'event'` row (inert then,
-- inert still) was never configured with one. Never a manufactured `{}`
-- (contrast #473's fail-open `.default([])`). A native `ADD COLUMN` (no table
-- recreate), so it disturbs no index; `triggers` is mutable by design (no
-- immutability trigger to re-create).

ALTER TABLE triggers ADD COLUMN event TEXT;
