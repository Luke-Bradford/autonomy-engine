import type { ActivityEvent, ConnectorErrorKind } from './types.js';

/**
 * Build a terminal `failed` event.
 *
 * Lifted out of `fs.ts` by #1134 (M5 slice 4b) rather than copied into `copy.ts`,
 * so the two files that needed it share one builder instead of drifting.
 *
 * It is NOT yet the tree's single source for the shape, and saying so is the
 * point: `http.ts`, `openai.ts`, `anthropic.ts` and `ollama.ts` still write the
 * `{ type: 'failed', kind, error }` literal by hand. Migrating them is a pure
 * tidy with no bearing on this slice, so it is left alone rather than smuggled
 * into a data-movement diff — but a reader should not infer from this file's
 * existence that the job is done.
 *
 * It stays a plain builder — the KIND is always the caller's decision,
 * because fail-safe classification is per-adapter (`fs.ts`'s errno table,
 * `error-kind.ts`'s sink classifier) and a default here would quietly pick one.
 */
export function failed(kind: ConnectorErrorKind, error: string): ActivityEvent {
  return { type: 'failed', kind, error };
}
