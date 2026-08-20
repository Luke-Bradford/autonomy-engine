import type { ConnectorErrorKind } from './types.js';

/**
 * A dataset READ or WRITE that failed, carrying the failure `kind` the M5 `copy`
 * adapter maps straight onto its terminal `node.failed` event (#1 F0's
 * structured failure kind).
 *
 * ONE class for both directions, deliberately. It was `DatasetReadError` when M4
 * shipped only a reader; a second `DatasetWriteError` would have meant a second
 * near-identical mapper over the same `TRANSIENT_SQLITE_CODES` set — the
 * duplication `confine.ts` was extracted to prevent. (It would also have collided
 * in name with `DatasetWriteBodySchema` in `routes/datasets.ts`, where "dataset
 * write" means HTTP CRUD on the dataset ROW, not moving data into a store.)
 *
 * Classification is FAIL-SAFE, exactly as `fs.ts`'s errno mapper is: only the
 * SQLite codes that genuinely mean "busy right now" are `transient`, and
 * everything else — including any unrecognised throw — is `permanent`, never
 * blind-retried.
 *
 * `partialWritePossible` carries §4.2's one input: whether rows may already have
 * landed in the sink. It is false for every read (a read writes nothing) and for
 * a sink whose transaction demonstrably rolled back; it is true ONLY where this
 * code cannot prove the store was left in its pre-copy state. Turning it into a
 * verdict is `classifySinkFailure`'s job (`error-kind.ts`), never this class's —
 * this only reports the fact.
 */
export class DatasetIoError extends Error {
  readonly kind: ConnectorErrorKind;
  readonly partialWritePossible: boolean;

  constructor(
    kind: ConnectorErrorKind,
    message: string,
    options?: { cause?: unknown; partialWritePossible?: boolean },
  ) {
    super(message, options);
    this.name = 'DatasetIoError';
    this.kind = kind;
    this.partialWritePossible = options?.partialWritePossible ?? false;
  }
}
