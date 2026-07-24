-- #3 G6a — the WORKSPACE-AUDIT log (Foundation Spec #3, "Publish must be
-- EVENT-SOURCED"). An owner-scoped, append-only log of workspace mutations that
-- the DB row-state cannot answer historically: repo.connected, pipeline.archived,
-- import.applied (G6c adds pipeline.published and projects the `active` pointer
-- from this log). Mirrors `run_events` (0002): id, monotonic per-owner `seq`,
-- envelope `type`, JSON `payload`, and a `created_at` timestamp. UNIQUE(owner_id,
-- seq) is the real backstop for the repo layer's read-max-then-insert numbering.
CREATE TABLE workspace_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX workspace_events_owner_id_seq_idx ON workspace_events (owner_id, seq);
CREATE INDEX workspace_events_owner_id_idx ON workspace_events (owner_id);

-- APPEND-ONLY: no update/delete path exists in the repository layer (see
-- repo/workspace-events.ts) — the same defense-in-depth invariant `run_events`
-- and `pipeline_versions` carry. Unlike `run_events` there is no parent row to
-- cascade-delete: this log is keyed only by `owner_id`, so BOTH triggers are
-- unconditional (an owner's audit history is never rewritten in place, and the
-- only way it goes away is dropping the whole workspace out of band).
CREATE TRIGGER workspace_events_no_update
BEFORE UPDATE ON workspace_events
BEGIN
  SELECT RAISE(ABORT, 'workspace_events are append-only: update is not allowed');
END;

CREATE TRIGGER workspace_events_no_direct_delete
BEFORE DELETE ON workspace_events
BEGIN
  SELECT RAISE(ABORT, 'workspace_events are append-only: delete is not allowed');
END;
