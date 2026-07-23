-- #3 G1 — stable cross-workspace resource identity.
--
-- Every authored resource (and every immutable pipeline VERSION — a
-- `(pipeline_id, version)` pair is NOT stable across machines) gains a
-- `resource_id`: the identity a git file carries (#3 G3+), classified by on
-- workspace import (#3 G4/G5), and referenced by CAS-publish provenance
-- (#3 G6). The DB `id` stays the runtime key; `resource_id` is the PORTABLE
-- key. Server-minted on create; this migration backfills every pre-G1 row
-- with a fresh random identity (these rows have never been exported WITH an
-- identity, so fresh ids are truthful — there is no prior identity to
-- preserve; format differs from the app's `res_<nanoid>` mints, which is fine
-- because prefixes are cosmetic, per `repo/ids.ts`, "never parse it back
-- out").
--
-- Nullable in SQL, NOT NULL at the app layer: SQLite cannot ADD COLUMN NOT
-- NULL without a constant DEFAULT (an empty-string sentinel a stray insert
-- path could silently inherit — worse than NULL, which fails LOUDLY at the
-- Zod read boundary since every repo read re-parses rows through schemas that
-- REQUIRE resourceId). A 4-table recreate for DDL-level NOT NULL buys nothing
-- the read boundary doesn't already enforce.
--
-- Uniqueness is OWNER-scoped, not global: workspace-git import PRESERVES
-- resourceIds, so two owners importing the same repo on one instance must
-- not collide. (`owner_id` is nullable; SQLite treats NULLs as distinct in
-- unique indexes — acceptable for legacy single-user rows, where the app
-- layer mints fresh ids anyway.) Versions scope by pipeline; owner rides the
-- pipeline FK.

ALTER TABLE pipelines ADD COLUMN resource_id TEXT;
UPDATE pipelines SET resource_id = 'res_' || lower(hex(randomblob(16))) WHERE resource_id IS NULL;
CREATE UNIQUE INDEX pipelines_owner_resource_id_idx ON pipelines (owner_id, resource_id);

-- pipeline_versions carries the `pipeline_versions_no_update` immutability
-- trigger (0002) — it RAISE(ABORT)s the backfill UPDATE. Dropping it around a
-- SYSTEM backfill inside this migration's transaction is sanctioned: the
-- invariant the trigger defends is "no runtime path mutates a version's
-- CONTENT", and stamping a brand-new identity column on legacy rows mutates
-- nothing the immutability contract covers. The trigger is recreated VERBATIM
-- below (and the migration-era test suite re-verifies it still fires).
ALTER TABLE pipeline_versions ADD COLUMN resource_id TEXT;
DROP TRIGGER pipeline_versions_no_update;
UPDATE pipeline_versions SET resource_id = 'res_' || lower(hex(randomblob(16))) WHERE resource_id IS NULL;
CREATE TRIGGER pipeline_versions_no_update
BEFORE UPDATE ON pipeline_versions
BEGIN
  SELECT RAISE(ABORT, 'pipeline_versions are immutable: update is not allowed');
END;
CREATE UNIQUE INDEX pipeline_versions_pipeline_resource_id_idx ON pipeline_versions (pipeline_id, resource_id);

ALTER TABLE connections ADD COLUMN resource_id TEXT;
UPDATE connections SET resource_id = 'res_' || lower(hex(randomblob(16))) WHERE resource_id IS NULL;
CREATE UNIQUE INDEX connections_owner_resource_id_idx ON connections (owner_id, resource_id);

ALTER TABLE triggers ADD COLUMN resource_id TEXT;
UPDATE triggers SET resource_id = 'res_' || lower(hex(randomblob(16))) WHERE resource_id IS NULL;
CREATE UNIQUE INDEX triggers_owner_resource_id_idx ON triggers (owner_id, resource_id);
