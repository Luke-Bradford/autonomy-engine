// #1600 OR41 C6f-1 — what a Copy reports about its own run, in both modes:
// how long it took, how fast it read, and what its consistency check found
// (activity catalogue §4.1 outputs; ADF's `copyDuration`, `throughput` and
// `dataConsistencyVerification`). One home, so a rows Copy and a Files as-is
// Copy cannot word the same fact two ways.

/**
 * ADF's `InconsistentData`: `found` is a check that failed the copy (so it is
 * only ever an `output` event ahead of the failure), `skipped` is one Skip
 * inconsistent files stepped over, `none` is neither, including a copy whose
 * check was off.
 */
export const COPY_CONSISTENCY_RESULTS = ['none', 'found', 'skipped'] as const;
export type CopyConsistencyResult = (typeof COPY_CONSISTENCY_RESULTS)[number];

export interface CopyConsistency {
  /**
   * The check was on (ADF's `Verified`; off is its `NotVerified`). It does not
   * claim the data was consistent: `result` says that. ADF's `Unsupported`
   * cannot arise, because save and dispatch refuse a check a copy cannot make.
   */
  readonly verified: boolean;
  readonly result: CopyConsistencyResult;
}

export interface CopyMeasure {
  readonly durationMs: number;
  /** Bytes read per second, or null for a copy too quick to divide by. */
  readonly throughput: number | null;
  readonly consistency: CopyConsistency;
}

/**
 * The run's measures from its start and end (a monotonic clock, in ms) and the
 * bytes it read. Throughput is over the rounded duration, so the two outputs
 * always agree with each other.
 */
export function copyMeasure(
  startedMs: number,
  endedMs: number,
  bytesRead: number,
  consistency: CopyConsistency,
): CopyMeasure {
  const durationMs = Math.max(0, Math.round(endedMs - startedMs));
  return {
    durationMs,
    throughput: durationMs === 0 ? null : Math.round((bytesRead * 1000) / durationMs),
    consistency,
  };
}
