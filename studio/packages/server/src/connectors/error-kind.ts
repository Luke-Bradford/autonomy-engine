import { FAILURE_CODES, type FailureKind } from '@autonomy-studio/shared';
import type { ConnectorErrorKind } from './types.js';

/**
 * #1 F0 — the seam between the connector taxonomy and the engine's.
 *
 * Adapters classify failures 5 ways (`ConnectorErrorKind`) because that is what
 * a PROVIDER tells us. The engine's `FailureKind` is 3-valued because that is
 * the only question the pure reducer may answer: retry, don't, or it was
 * cancelled. This maps the former onto the latter WITHOUT losing information —
 * whatever the narrowing drops is preserved in `code`.
 *
 * The mapping is fixed by spec #2's error taxonomy, not chosen here:
 * - `auth` (401/403) → **permanent**: a bad key never fixes itself by retrying;
 *   it needs an operator. `code:'auth'` keeps it distinguishable from a plain
 *   bad request (which is also permanent, but is not a credentials problem).
 * - `rate_limit` (429) → **transient**: the canonical backoff candidate.
 *   `code:'rate_limit'` is what a later policy layer keys off to prefer the
 *   provider's `retry-after` over the configured interval (#2 L7), and what #5's
 *   quota/reset-window primitive needs to tell throttling from a network blip.
 * - `transient`/`permanent`/`cancelled` pass straight through — same meaning on
 *   both sides of the seam, so no `code` is minted (an echo of `kind` would be
 *   noise, not information).
 *
 * Exhaustive by construction: adding a `ConnectorErrorKind` without extending
 * this switch fails the type-check rather than silently defaulting.
 */
export function toEngineFailure(kind: ConnectorErrorKind): { kind: FailureKind; code?: string } {
  switch (kind) {
    case 'auth':
      return { kind: 'permanent', code: FAILURE_CODES.AUTH };
    case 'rate_limit':
      return { kind: 'transient', code: FAILURE_CODES.RATE_LIMIT };
    case 'transient':
      return { kind: 'transient' };
    case 'permanent':
      return { kind: 'permanent' };
    case 'cancelled':
      return { kind: 'cancelled' };
  }
}

/**
 * #1125 M5 slice 2 — the data-movement spec's §4.2 rule, and the SECOND half of
 * this module's job.
 *
 * §4 settles that "a copy is atomic at the sink, or it is not retryable". The
 * trap it exists for is measured, not hypothetical: `retryEligible`
 * (`shared/src/engine/reduce.ts`) reads only `kind === 'transient'` and
 * `policy.retry` — it never consults `idempotent`, which governs boot recovery
 * alone. So a copy that dies at row 500,000 on a network blip is classified
 * `transient`, retried FROM ROW 0, and duplicates every row it already wrote
 * into an append sink.
 *
 * The rule: where a failure may have left rows behind, the failure is
 * `permanent` **whatever its cause**, because the engine's only retry is a
 * duplicating one. Losing an automatic retry is the correct trade against
 * silently doubling an operator's table.
 *
 * It lives here, beside `toEngineFailure`, rather than in a module of its own:
 * both halves of §4's classification are one taxonomy question, and this module
 * is already the seam where connector failure kinds become engine verdicts.
 *
 * The sqlite sink always reports `partialWritePossible: false` — it writes
 * inside one transaction and proves the rollback happened before saying so — so
 * this function is a pass-through there. It is not dead code: M7's `delimited`
 * sink and any driver that cannot transact a whole batch reach the other branch,
 * and a sink that could not prove its rollback (`rollback` itself threw while
 * `db.inTransaction`) reaches it today.
 *
 * `cancelled` deliberately does NOT downgrade. It is already never retried
 * (`toEngineFailure` above), so re-labelling it `permanent` would only lose the
 * information that an operator stopped the run.
 */
export function classifySinkFailure(failure: {
  kind: ConnectorErrorKind;
  partialWritePossible: boolean;
}): ConnectorErrorKind {
  if (!failure.partialWritePossible) return failure.kind;
  switch (failure.kind) {
    case 'transient':
    case 'rate_limit':
      return 'permanent';
    case 'auth':
    case 'permanent':
    case 'cancelled':
      return failure.kind;
  }
}
