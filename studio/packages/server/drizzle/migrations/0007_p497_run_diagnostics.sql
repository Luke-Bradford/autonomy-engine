-- #497: the pure reducer's `diagnostics` had NO production sink.
--
-- `reduce(state, event) → { state, commands, diagnostics }`. Every non-test
-- caller bound `.state`/`.commands` and dropped the third — verified by grep
-- across `driver.ts`/`reconcile.ts`/`retry-alarm.ts`, and admitted in the
-- reducer's own docblocks. So the "and say so" half of four SHIPPED tickets was
-- written to nowhere: #480 (a cross-boundary edge is IGNORED), #487 (a ghost
-- container child is neutralized), #488 (a self-container edge is inert), #491
-- (WHICH entities stalled a run), plus `noteInertBranch`, `container capped at
-- maxRounds`, `dispatch prep failed` and every `impossible <event>` rejection.
-- The engine's DECISIONS were all durable and correct; the EXPLANATION was not.
--
-- NOT AN ENGINE EVENT, which is the decision this table embodies. `run_events`
-- is a log of FACTS; a diagnostic is a DERIVATION of (immutable doc + log).
-- Storing a derivation as a fact would (a) enter `EngineEventSchema`, re-folding
-- every already-bound log — the #443 authority question — and (b) double-count
-- on replay, since a re-fold RE-DERIVES the diagnostic and would also meet the
-- stored one. A separate table has neither problem, and nothing the engine gates
-- on ever reads it.
--
-- WHY DURABLE AT ALL, rather than re-derived on read by an endpoint that folds
-- the log: `resume()` (`driver.ts`) folds NO event — it settles over a
-- projection — so its diagnostics are not a function of the log, and a read-time
-- re-derivation could not reproduce them by construction. Durability also stamps
-- the explanation when it was TRUE: the doc is immutable, but the reducer is not,
-- so a re-derivation reports what TODAY's reducer says about an old run.
--
-- THE KEY: `(run_id, seq, phase, ordinal)`, with writes as INSERT OR IGNORE, so
-- a re-derivation at the same log position is a NO-OP rather than a duplicate —
-- replay determinism by construction, not by remembering. `phase` is IN the key
-- because it must be: `resume()` derives at the same `seq` as the fold that
-- preceded it (`retry-alarm.ts` appends `node.retryDue` at seq N, folds it, then
-- its afterCommit drives → `resume()` over a projection whose max seq is N).
-- Without `phase` those two DIFFERENT derivations share a key and `OR IGNORE`
-- splices them into one list that is silently part-one, part-the-other.
--
-- CASCADE, not a retention job: a diagnostic is meaningless without its run, so
-- it dies with it — the same posture as `run_events`, and deliberately NOT
-- `scheduled_wakeups`' (0005), whose settled rows outlive their subject and so
-- accumulate forever (#464).
--
-- Storage is bounded per-RUN in the repo layer, not here (see
-- `RUN_DIAGNOSTIC_CAP`): `MAX_DRIVER_STEPS` is 1_000_000 and several diagnostics
-- are emitted per node per settle, so a per-fold cap alone bounds nothing. The
-- cap is stated in-band as a `phase='cap'` marker row rather than applied
-- silently — an absent fact must never be manufactured as "that was all of them"
-- (the F13a/#473 rule).

CREATE TABLE run_diagnostics (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  phase TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  message TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE UNIQUE INDEX run_diagnostics_run_id_seq_phase_ordinal_idx
  ON run_diagnostics (run_id, seq, phase, ordinal);
CREATE INDEX run_diagnostics_run_id_idx ON run_diagnostics (run_id);
