-- item 7 / S1 — the SOURCE: a standalone, name-addressable secret.
--
-- Before this, the ONLY secret in the system was a connection-owned row minted
-- as a side effect of a connection/webhook write and addressed by an opaque
-- machine `ref`. F15's `{ "$secret": "<name>" }` sink (S2) needs a secret that
-- exists INDEPENDENTLY of any connection binding and is addressed by a
-- user-chosen NAME. This migration adds that addressing surface to the existing
-- encrypted `secrets` table (do NOT build a greenfield store — the XChaCha20
-- ciphertext-at-rest is already here; only the surface was missing). Full
-- rationale: `studio/docs/2026-07-16-foundation-unified-secret-model.md` §1.
--
-- Both columns are NULLABLE with no DEFAULT: a plain `ADD COLUMN … TEXT` on a
-- table with rows fills every existing row with NULL, which is the HONEST value
-- for them — a connection-owned secret has no owner-scoped name and never will
-- (it stays addressed by `ref`). NULL is not a manufactured benign default here
-- (contrast 0006's `'[]'`, which had to backfill a NOT NULL column): it records
-- what these rows actually ARE — provenance = connection, not standalone.
--
-- The UNIQUE index over `(owner_id, name)` is what makes a `{$secret:"<name>"}`
-- marker resolve deterministically per owner (S3). It does NOT collide the
-- existing connection secrets: SQLite treats NULLs as DISTINCT in a UNIQUE
-- index (verified: many `(NULL, NULL)` rows coexist), so every connection
-- secret — all `(NULL, NULL)` — is exempt, and only two standalone secrets with
-- the SAME owner AND the SAME non-null name conflict.
--
-- `secrets` carries no immutability trigger (unlike `pipeline_versions`) — it is
-- mutable by design (`updateSecretCiphertext` rotates in place) — so a native
-- `ADD COLUMN` disturbs nothing.

ALTER TABLE secrets ADD COLUMN owner_id TEXT;
ALTER TABLE secrets ADD COLUMN name TEXT;
CREATE UNIQUE INDEX secrets_owner_name_idx ON secrets (owner_id, name);
