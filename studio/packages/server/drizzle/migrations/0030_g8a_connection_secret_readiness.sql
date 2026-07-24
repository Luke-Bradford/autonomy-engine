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

-- One-time backfill. `secret_ref` is an FK onto `secrets.ref` with onDelete
-- RESTRICT, so a non-NULL `secret_ref` ALWAYS resolves to a real row ⟹ 'ready'.
-- Otherwise the kind axis decides: the hosted-API LLM kinds need a connection
-- credential ⟹ 'needs_secret'; every other kind (ollama/agent_cli/http/fs) runs
-- credential-less ⟹ 'not_required'. This hardcoded kind list is a SNAPSHOT of
-- `SECRET_REQUIRING_CONNECTION_KINDS` (shared/schemas/connection.ts), which is
-- the runtime SSOT `deriveSecretStatus` uses on every subsequent write.
UPDATE connections
SET secret_status = CASE
  WHEN secret_ref IS NOT NULL THEN 'ready'
  WHEN kind IN ('anthropic_api', 'openai_api') THEN 'needs_secret'
  ELSE 'not_required'
END;
