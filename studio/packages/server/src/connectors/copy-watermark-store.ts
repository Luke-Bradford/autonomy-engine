import type { SqlParameterValue } from '@autonomy-studio/shared';
import type { ActivityContext } from './types.js';

/**
 * #1600 OR41 C5a — store Automatic's new watermark once the sink has committed:
 * `null` when stored (or when there is nothing to store), else why it was not.
 * The rows are committed either way, so a failure says the next run copies them
 * again rather than letting the node succeed with a watermark left behind.
 * C5b — a Files as-is copy's too, once every file is written (`what`).
 */
export function storeWatermark(
  ctx: ActivityContext,
  next: SqlParameterValue,
  what: 'rows were committed' | 'files were copied',
): string | null {
  if (next === null || ctx.copyWatermark === undefined) return null;
  try {
    ctx.copyWatermark.commit(next);
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `the ${what}, but the watermark could not be stored, so the next run copies them again: ${reason}`;
  }
}
