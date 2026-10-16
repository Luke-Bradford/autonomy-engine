import { queryDatasetConfigSchema, type DatasetKind } from '@autonomy-studio/shared';
import { DatasetIoError } from './dataset-io-error.js';

/**
 * #1600 OR41 C1q-c — a `query` dataset's `queryTimeoutSeconds` (ADF's
 * copy-source `queryTimeout`), as both store readers enforce it.
 *
 * The readers start the clock just before the statement first runs, so opening
 * the store does not count against it, and ask it for the time left before each
 * batch is pulled. The schema's docblock states what bounds an overrun on each
 * store; this module only keeps the time.
 *
 * `transient`, with no failure code: an adapter's own timeout is reported the
 * way `http.ts`, `llm-shared.ts` and `agent.ts` report theirs, and the same way
 * postgres's own `57014` cancel already classifies. `FAILURE_CODES.TIMEOUT`
 * stays the node policy's.
 */
export interface QueryClock {
  /**
   * Milliseconds left, or `null` when the query has no limit. Throws the
   * timeout's `DatasetIoError` once none are left, so a reader that asks before
   * each pull never starts one past the limit.
   */
  remainingMs(): number | null;
  /** The failure a store's own cancel is reported as, once the clock caused it. */
  expired(): DatasetIoError;
}

/** The query timeout a dataset declares, or `null` (a `table`, or none set). The
 * reader has already refused an invalid config, so a failed parse here is `null`
 * rather than a second refusal. */
export function queryTimeoutSecondsOf(
  kind: DatasetKind,
  config: Record<string, unknown>,
): number | null {
  if (kind !== 'query') return null;
  const parsed = queryDatasetConfigSchema.safeParse(config);
  return parsed.success ? (parsed.data.queryTimeoutSeconds ?? null) : null;
}

export function startQueryClock(
  timeoutSeconds: number | null,
  now: () => number = Date.now,
): QueryClock {
  const started = now();
  const expired = () =>
    new DatasetIoError(
      'transient',
      `the query ran past its query timeout of ${String(timeoutSeconds)} seconds`,
    );
  return {
    remainingMs() {
      if (timeoutSeconds === null) return null;
      const left = started + timeoutSeconds * 1000 - now();
      if (left <= 0) throw expired();
      return left;
    },
    expired,
  };
}
