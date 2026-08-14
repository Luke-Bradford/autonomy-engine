-- #988: activity REPORTED BY an agent studio did not launch.
--
-- Every existing AI-activity figure is derived from `run_events` INNER JOINed to
-- `runs`, and `run_events.run_id` is NOT NULL with an FK to `runs` — so there is
-- no way to record AI use that is not attached to a studio pipeline run. That is
-- correct for what it measures and it is exactly the gap #988 names: the
-- autonomy build loop's `claude -p` fires are launched by `loop/drive.sh`
-- entirely outside studio, so `/monitor/ai` truthfully reports zero while the
-- operator is watching the loop burn their weekly quota.
--
-- This is the INGEST side of the settled shape: an external agent REPORTS IN,
-- studio does not reach out to scrape processes it did not launch. A separate
-- table rather than synthetic `runs`/`run_events` rows, because a reported
-- invocation is not a run: it has no pipeline version, no node graph, no
-- reducer state, and inventing one would put un-replayable rows into the
-- event log that the whole run model treats as authoritative.
--
-- `(owner_id, source, external_id)` is UNIQUE so a report is IDEMPOTENT: a
-- reporter that sends an invocation when it starts and again when it finishes
-- updates one row instead of counting one fire twice. `external_id` is the
-- reporter's own handle for the invocation (for the build loop, the fire id),
-- which is the only id both sides can agree on without studio issuing one first.
--
-- The four token columns are NULLABLE, and that is load-bearing rather than
-- convenient: `AgentCliActivitySchema`'s docblock already refuses printing a
-- confident `0` for work nobody measured, so "this reporter sent no usage" must
-- stay distinguishable from "it measured, and the answer was zero".
--
-- `ended_at_ms` NULL means the invocation is STILL RUNNING — the state the
-- operator was looking at when they filed this ticket.

CREATE TABLE IF NOT EXISTS external_agent_activity (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  outcome TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  reported_at_ms INTEGER NOT NULL
);

-- The idempotency key. UNIQUE per OWNER as well as per source, so two owners'
-- reporters cannot collide on a shared `external_id` vocabulary.
CREATE UNIQUE INDEX IF NOT EXISTS external_agent_activity_owner_source_external_idx
  ON external_agent_activity (owner_id, source, external_id);

-- The window query: owner-scoped, `started_at_ms >= sinceMs`. Also the order the
-- retention sweep deletes in.
CREATE INDEX IF NOT EXISTS external_agent_activity_owner_started_idx
  ON external_agent_activity (owner_id, started_at_ms);
