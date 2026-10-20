import { SESSION_LOG_OUTPUT, sessionLogRunValues, type SessionLog } from '@autonomy-studio/shared';
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

/**
 * #1600 OR41 C6d-2 — the session log's reason for an item someone else removed
 * while the activity ran: Delete's skip and Copy's *Skip missing files*.
 */
export const REMOVED_BY_SOMEONE_ELSE = 'removed by someone else';

/**
 * #1600 OR41 C8d — a Get metadata *Wait until* that does not hold yet: check
 * again after the node's *Check every*. Shared by the path and the table halves
 * (C8d-2b) so the two answer it in one shape.
 */
export function notYet(
  timers: { readonly checkEverySeconds: number; readonly giveUpAfterSeconds: number },
  reason: string,
): ActivityEvent {
  return {
    type: 'notReady',
    reason,
    recheckAfterSeconds: timers.checkEverySeconds,
    giveUpAfterSeconds: timers.giveUpAfterSeconds,
  };
}

/**
 * #1600 OR41 C6b — a session log's lines as the run log takes them: one
 * `node.output sessionLog` each, by `sessionLogRunValues`' rule, counting what a
 * capped log already left out. Delete (C9c), a rows Copy (C6a) and a files Copy
 * (C6b) yield them at the terminal through this one loop. `folderHint` is off
 * for an activity that cannot write its log to a folder (Copy, until C6c).
 */
export function* sessionLogRunEvents(
  log: SessionLog,
  opts: { folderHint?: boolean } = {},
): Generator<ActivityEvent> {
  for (const value of sessionLogRunValues(log.lines, undefined, {
    dropped: log.dropped,
    ...(opts.folderHint !== undefined && { folderHint: opts.folderHint }),
  })) {
    yield { type: 'output', name: SESSION_LOG_OUTPUT, value };
  }
}
