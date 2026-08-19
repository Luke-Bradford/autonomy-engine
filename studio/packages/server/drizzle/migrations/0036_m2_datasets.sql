-- #1114 (M2 slice 2, data-movement spec §2) — `datasets`, the FOURTH first-class
-- workspace resource.
--
-- A dataset is "a thing in a store, in a shape": the ADDRESS half of a copy
-- (which store, which table/path, what format), while the CONTRACT half (the
-- column mapping) lives in a `copy` node's config inside an immutable pipeline
-- version. A run must execute the mapping it was authored with, but resolves the
-- address live.
--
-- MUTABLE, like `connections` and `triggers` and unlike `pipeline_versions`.
-- The spec probed and rejected the claim that an un-versioned resource would
-- break run binding: run binding is preserved by `runs.pipeline_version_id`
-- being NOT NULL with ON DELETE RESTRICT, not by every resource being versioned.
-- A dataset address is the same class of fact as a connection's `config`.
--
-- `connection_id` has NO FOREIGN KEY, and that is a decision rather than an
-- omission. `DELETE /api/connections/:id` is a deliberate HARD delete with a
-- designed answer for dependents (it re-gates every dependent trigger in the
-- same transaction); an ON DELETE RESTRICT here would make that existing path
-- throw an opaque constraint error for a case it was built to handle, and an ON
-- DELETE CASCADE would silently destroy the operator's authored datasets as a
-- side effect of removing a credential. Neither is worth having. A dataset whose
-- connection is gone fails LOUDLY at the two points that matter: the serializer
-- reports it as an unserializable resource rather than committing a dangling
-- ref, and a copy dispatching against it is refused (M5/M6).
--
-- `resource_id` is nullable in SQL and Zod-enforced NOT NULL at the read
-- boundary — the identical treatment the other four resource tables get (see
-- 0024): ADD COLUMN cannot be NOT NULL without a constant DEFAULT sentinel that
-- a stray insert could silently inherit. Here the table is new, so every row it
-- will ever hold is written by `createDataset` with a minted id; the nullable
-- column exists for uniformity with the G1 identity contract, and the unique
-- index is OWNER-scoped (never global) because workspace-git import PRESERVES
-- resourceIds, so two owners importing the same repo must not collide.
--
-- `columns` is NOT NULL with NO DEFAULT. An absent column list must fail rather
-- than read as "this table has no columns" (#473's lesson, and the spec states
-- it in as many words) — a manufactured empty schema would make auto-map
-- silently produce an empty mapping. `parameters` DOES take a DEFAULT '[]',
-- which is the opposite polarity on purpose: that default withholds a
-- permission (nothing is overridable) rather than manufacturing a fact.

CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  resource_id TEXT,
  owner_id TEXT,
  name TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  config TEXT NOT NULL,
  columns TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX datasets_owner_id_idx ON datasets (owner_id);
CREATE UNIQUE INDEX datasets_owner_resource_id_idx ON datasets (owner_id, resource_id);
