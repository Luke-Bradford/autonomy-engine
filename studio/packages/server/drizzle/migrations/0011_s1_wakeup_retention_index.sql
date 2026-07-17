-- #464 — RETENTION for the `scheduled_wakeups` outbox. Settled rows
-- (`fired`/`suppressed`/`cancelled`) were terminal-but-permanent; a retention
-- sweep now prunes those older than a floor (default 30 days). This index serves
-- that sweep's query (`WHERE status <> 'pending' AND fired_at < ? ORDER BY
-- fired_at`).
--
-- PARTIAL, over settled rows only: it indexes `fired_at` for exactly the rows the
-- sweep scans, turning a full sort of the settled set into an index range scan
-- (load-bearing on a high-volume instance, and it keeps the first-boot backlog
-- drain fast). Pending rows are excluded, so it never competes with the claim
-- scan's `(status, due_at)` index. Rationale + safety argument:
-- `packages/server/src/repo/scheduled-wakeups.ts` (`pruneSettledWakeups`).

CREATE INDEX scheduled_wakeups_retention_idx
  ON scheduled_wakeups (fired_at)
  WHERE status <> 'pending';
