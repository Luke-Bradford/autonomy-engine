import type { ActivityEvent, ConnectorErrorKind } from './types.js';

/**
 * Build a terminal `failed` event.
 *
 * Lifted out of `fs.ts` by #1134 (M5 slice 4b) rather than copied into `copy.ts`:
 * a third hand-written `{ type: 'failed', kind, error }` literal is how the
 * shape drifts, and this one is small enough that two copies is already one too
 * many. It stays a plain builder — the KIND is always the caller's decision,
 * because fail-safe classification is per-adapter (`fs.ts`'s errno table,
 * `error-kind.ts`'s sink classifier) and a default here would quietly pick one.
 */
export function failed(kind: ConnectorErrorKind, error: string): ActivityEvent {
  return { type: 'failed', kind, error };
}
