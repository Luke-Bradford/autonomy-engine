import {
  SubstituteError,
  assertJsonReplaySafe,
  globalSnapshotDefect,
} from '@autonomy-studio/shared';
import { listOwnerGlobalParamsNamed } from '../repo/global-params.js';
import { getGlobalReads } from '../repo/pipeline-versions.js';
import type { Db } from '../repo/types.js';

/**
 * #844 GL3 — a start refused over the global parameters its version reads. Its
 * message is written for the author (it names the global and the types, never
 * a value), so #1367 shows it on the run page and the run-now route returns it
 * as a 400.
 */
export class GlobalStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlobalStartError';
  }
}

/**
 * #844 GL3 (spec GL-D3) — the snapshot a run logs on `run.started.globals`: the
 * live values of EXACTLY the globals its version recorded reading
 * (`global_reads`), owner-scoped by the run's own owner. `undefined` when the
 * version reads none, so its `run.started` carries no field and folds to `{}`.
 *
 * The check reads the recorded list and never re-runs the validator, which
 * would refuse a version saved before some newer, unrelated rule. It throws
 * {@link GlobalStartError} when a read global is gone or now has another type
 * (deleted, or deleted and recreated), and when the snapshot is over the bound:
 * values can grow after the version was saved. The caller runs it before any
 * append, so a refusal leaves an empty log for `terminalizeInterrupted`.
 */
export function resolveRunGlobals(
  db: Db,
  run: { ownerId: string | null; pipelineVersionId: string },
): Record<string, unknown> | undefined {
  const reads = getGlobalReads(db, run.pipelineVersionId);
  // A missing version is not one that reads nothing: refuse rather than start
  // it without its values (every caller has already resolved the doc, so this
  // is a guard, not a path).
  if (reads === null) {
    throw new GlobalStartError(`pipeline version '${run.pipelineVersionId}' not found`);
  }
  if (reads.length === 0) return undefined;
  const live = new Map(
    listOwnerGlobalParamsNamed(
      db,
      run.ownerId,
      reads.map((r) => r.name),
    ).map((g) => [g.name, g]),
  );
  const snapshot: Record<string, unknown> = {};
  for (const read of reads) {
    const g = live.get(read.name);
    if (g === undefined) {
      throw new GlobalStartError(
        `global parameter "${read.name}" no longer exists. This pipeline version reads it ` +
          `as \${global.${read.name}}; create it again under Manage → Global parameters.`,
      );
    }
    if (g.type !== read.type) {
      throw new GlobalStartError(
        `global parameter "${read.name}" is now of type ${g.type}, but this pipeline ` +
          `version reads it as ${read.type}.`,
      );
    }
    // A data property: an assignment to a name like `__proto__` would set the
    // prototype, and the name rule reserves only that one.
    Object.defineProperty(snapshot, read.name, {
      value: g.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const tooBig = globalSnapshotDefect(snapshot);
  if (tooBig !== null) throw new GlobalStartError(tooBig);
  // A stored value passed the replay-safety walk on write, but the row decoder
  // checks shape only; a non-finite number must never reach the log. Its
  // `SubstituteError` is re-thrown as this module's refusal, so the run page and
  // the run-now 400 say why.
  try {
    assertJsonReplaySafe('global parameter snapshot', snapshot);
  } catch (err) {
    if (err instanceof SubstituteError) throw new GlobalStartError(err.message);
    throw err;
  }
  return snapshot;
}
