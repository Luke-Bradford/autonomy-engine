-- #5 S6b — per-pipeline concurrency cap (#1 D1 field, F8b enforcement).
-- NULL = uncapped: every pre-S6b pipeline is genuinely uncapped, so the
-- nullable backfill records the truth (no manufactured default — #473).
ALTER TABLE pipelines ADD COLUMN concurrency INTEGER;
