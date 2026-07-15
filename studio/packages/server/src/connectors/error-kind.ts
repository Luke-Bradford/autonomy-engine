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
