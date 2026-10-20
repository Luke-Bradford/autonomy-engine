import { DatasetIoError } from './dataset-io-error.js';

/**
 * #1600 OR41 C6e-1 — run Verify after copy's check, if there is one, at the
 * point both sinks call it: the last batch written, the transaction still open.
 * A reason is thrown as a `permanent` failure from inside the sink's `try`, so
 * the sink's own ROLLBACK runs and reports whether it proved the store clean.
 * Permanent because a retry reads the same rows into the same store.
 */
export function verifyBeforeCommit(
  check: ((rowsWritten: number) => string | null) | null | undefined,
  rowsWritten: number,
): void {
  if (check == null) return;
  const reason = check(rowsWritten);
  if (reason !== null) throw new DatasetIoError('permanent', reason);
}
