-- #3 G8a (Foundation Spec #3 git-publish, "Secret readiness is a real runtime
-- GATE", spec 120-131 / 742-745) — connection secret-readiness + enable flag.
--
-- `enabled`: NOT NULL DEFAULT 1 (true). Every pre-G8 connection was usable — a
-- truthful backfill, not a manufactured absent value (#473). Matches the
-- `pipelines.archived` precedent (a constant-default NOT NULL ADD COLUMN).
--
-- `secret_status` is a DERIVED per-row value (it depends on kind + whether a
-- secret is present), so it has NO single constant DEFAULT. Added nullable, then
-- backfilled per-row below; the read boundary (`ConnectionSchema`) enforces NOT
-- NULL, so any row this migration failed to set would fail loudly rather than
-- read as a benign default (the `resource_id` fail-closed pattern, #473).
ALTER TABLE connections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE connections ADD COLUMN secret_status TEXT;

-- One-time backfill, mirroring `deriveSecretStatus` EXACTLY (kind axis first):
-- a credential-less kind is 'not_required' regardless of a stray secret_ref
-- (readiness is about the REQUIRED credential); a secret-requiring kind is
-- 'ready' iff it has a secret_ref (FK onDelete RESTRICT ⟹ a non-NULL ref always
-- resolves), else 'needs_secret'. The hardcoded kind list is a SNAPSHOT of
-- `SECRET_REQUIRING_CONNECTION_KINDS` (shared/schemas/connection.ts), the
-- runtime SSOT `deriveSecretStatus` uses on every subsequent write.
UPDATE connections
SET secret_status = CASE
  WHEN kind NOT IN ('anthropic_api', 'openai_api') THEN 'not_required'
  WHEN secret_ref IS NOT NULL THEN 'ready'
  ELSE 'needs_secret'
END;
