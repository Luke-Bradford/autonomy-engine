import { and, asc, count, eq, ne, or } from 'drizzle-orm';
import {
  RunDiagnosticSchema,
  type RunDiagnostic,
  type RunDiagnosticPhase,
} from '@autonomy-studio/shared';
import { runDiagnostics } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

/**
 * #497 — the durable sink for the pure reducer's `diagnostics`.
 *
 * Append-only, mirroring `run-events.ts`: there is deliberately no update/delete
 * export. Rows die with their run (`ON DELETE CASCADE`), so there is no
 * retention job to forget (contrast #464).
 *
 * The whole module is best-effort by NATURE, not by sloppiness: a diagnostic is
 * an EXPLANATION of a decision, never the decision. The decisions are durable in
 * `run_events` and the `runs` row. So nothing here may ever break a drive — see
 * `recordRunDiagnostics`.
 */

/**
 * The per-RUN ceiling on recorded diagnostics.
 *
 * Per-RUN rather than per-fold, which is the whole point: a per-fold cap bounds
 * nothing, because `MAX_DRIVER_STEPS` is 1_000_000 and the attacker-shaped
 * diagnostics repeat PER FOLD — `noteInertBranch` once per node per settle,
 * `container capped at maxRounds` once per container per round — on a doc that
 * (being pre-#444) was never validated. A per-fold cap of 50 would therefore
 * bound a single run at ~5e7 rows, which is not a bound in any sense an operator
 * would recognise.
 *
 * 500 is a judgement, not a derivation: comfortably above what any well-formed
 * run emits (a healthy run emits none at all — a diagnostic means something was
 * neutralized), while small enough that a malicious doc cannot fill a disk.
 *
 * The cap is enforced by a `count()` per diagnostic-bearing fold rather than by
 * cross-fold state on the recorder, which is deliberate: the recorder is
 * stateless (each call stands alone, so a re-boot re-deriving mid-run needs no
 * carried counter to stay correct), and the count is only ever paid on the
 * already-pathological path — a well-formed run emits no diagnostics and returns
 * before the query. A doomed run past the cap keeps paying one count + one no-op
 * marker insert per fold, which is bounded by `MAX_DRIVER_STEPS` and acceptable
 * for a run that is going to fail regardless.
 */
export const RUN_DIAGNOSTIC_CAP = 500;

/** `seq` of the `cap` marker. BELOW every real seq (which start at 0) so the
 * standard read surfaces the caveat before the list it qualifies. */
const CAP_MARKER_SEQ = -1;

const capMarkerMessage = (cap: number): string =>
  `diagnostics for this run reached the cap of ${cap} and later ones were NOT recorded. ` +
  `The run's decisions are unaffected and remain fully durable in its event log — what is ` +
  `capped here is the EXPLANATION of them. A run emitting this many diagnostics almost ` +
  `always means a malformed doc reached the reducer (see the diagnostics below).`;

/**
 * Record one fold's `diagnostics[]` at the log position it was derived at.
 *
 * IDEMPOTENT BY CONSTRUCTION. `(run_id, seq, phase, ordinal)` is UNIQUE and every
 * insert is `OR IGNORE`, so re-deriving at the same log position — a re-boot
 * re-resuming, an at-least-once alarm redelivering — is a no-op rather than a
 * duplicate. The doc is immutable and the reducer is pure, so the same log
 * position yields byte-identical messages; that is what makes the ignore SAFE
 * rather than lossy.
 *
 * `db` MUST be the same handle the event's `appendEngineEvent` used — pass the
 * caller's `tx` inside a transaction, never a `deps.db` reached around it.
 * `retry-alarm.ts` appends INSIDE the alarm clock's transaction, whose rollback
 * is the documented at-least-once contract: a diagnostic written outside it would
 * survive a rollback that erased the event, and then `OR IGNORE` would swallow
 * the REAL diagnostics when the redelivery re-appended at that same seq. The
 * `appendAndFold` helper (`run/events.ts`) exists so the two handles cannot
 * diverge in the first place.
 *
 * NEVER THROWS — the caller is mid-drive, and an explanation must not be able to
 * take down the thing it is explaining. A failure here is reported through `log`
 * (when the call site has one) and dropped, exactly as a bus publish is isolated
 * from the driver's pump.
 */
export function recordRunDiagnostics(
  db: Db,
  runId: string,
  seq: number,
  phase: Exclude<RunDiagnosticPhase, 'cap'>,
  messages: readonly string[],
  log?: { error(obj: unknown, msg?: string): void },
): void {
  if (messages.length === 0) return;
  try {
    // The headroom counts diagnostics from OTHER derivations only — every real
    // row EXCEPT this batch's own `(seq, phase)`, and never the `cap` marker
    // (which is a caveat ON the list, not a member of it).
    //
    // Excluding this batch's own rows is what makes truncation idempotent, and
    // it is the fix to a real trap: a plain "count all real rows" includes the
    // rows THIS call already wrote on a prior identical invocation (the
    // re-boot/redelivery the `OR IGNORE` design targets), so `available` would
    // shrink on replay, `kept` would become a strict prefix, and the marker
    // would fire — stamping a COMPLETE list as truncated, the exact inverse of
    // the F13a/#473 rule. Because every batch's rows are themselves idempotent,
    // "rows from other batches" is stable across replays, so the same batch
    // reaches the same keep/truncate verdict every time.
    const existingOther =
      db
        .select({ n: count() })
        .from(runDiagnostics)
        .where(
          and(
            eq(runDiagnostics.runId, runId),
            ne(runDiagnostics.phase, 'cap'),
            // NOT (this batch's own rows): `a OR b` negates to `NOT a AND NOT b`.
            or(ne(runDiagnostics.seq, seq), ne(runDiagnostics.phase, phase)),
          ),
        )
        .get()?.n ?? 0;

    const available = RUN_DIAGNOSTIC_CAP - existingOther;
    if (available <= 0) {
      // Genuinely full from other derivations: this batch adds nothing and is
      // wholly dropped — which IS truncation, so it is stated.
      writeCapMarker(db, runId);
      return;
    }

    const ts = Date.now();
    const kept = messages.slice(0, available);
    for (const [ordinal, message] of kept.entries()) {
      const row: RunDiagnostic = {
        id: newId('rdg'),
        runId,
        seq,
        phase,
        ordinal,
        message,
        ts,
      };
      db.insert(runDiagnostics).values(RunDiagnosticSchema.parse(row)).onConflictDoNothing().run();
    }
    // Truncation is STATED, never silent — an absent fact must not be
    // manufactured as "that was all of them" (the F13a/#473 rule).
    if (kept.length < messages.length) writeCapMarker(db, runId);
  } catch (err) {
    log?.error({ err, runId, seq, phase }, 'recording run diagnostics failed');
  }
}

/** Exactly one per run: `OR IGNORE` on the fixed `(runId, -1, 'cap', 0)` key. */
function writeCapMarker(db: Db, runId: string): void {
  const row: RunDiagnostic = {
    id: newId('rdg'),
    runId,
    seq: CAP_MARKER_SEQ,
    phase: 'cap',
    ordinal: 0,
    message: capMarkerMessage(RUN_DIAGNOSTIC_CAP),
    ts: Date.now(),
  };
  db.insert(runDiagnostics).values(RunDiagnosticSchema.parse(row)).onConflictDoNothing().run();
}

/**
 * One run's diagnostics in derivation order.
 *
 * `(seq, phase, ordinal)` — the same tuple as the UNIQUE key, so the order is
 * total and stable. Two properties of it are deliberate rather than incidental:
 * the `cap` marker's `seq: -1` sorts FIRST (a reader learns the list is
 * incomplete before reading it), and at a shared `seq`, `'fold'` sorts before
 * `'resume'`, which is also their causal order (the fold of event N precedes any
 * resume over a projection that includes it).
 */
export function listRunDiagnostics(db: Db, runId: string): RunDiagnostic[] {
  const rows = db
    .select()
    .from(runDiagnostics)
    .where(eq(runDiagnostics.runId, runId))
    .orderBy(asc(runDiagnostics.seq), asc(runDiagnostics.phase), asc(runDiagnostics.ordinal))
    .all();
  return rows.map((row) => RunDiagnosticSchema.parse(row));
}
