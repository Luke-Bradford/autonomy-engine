/**
 * #1600 OR41 C0d (catalogue spec §3; ADF "user properties") — resolving an
 * activity's user properties when it starts (at dispatch, or for an activity
 * the engine evaluates or a pipeline call, as its command is built, #1673).
 *
 * A user property is monitoring metadata, so it must never change what a run
 * does. A `${}` in `config` that fails to evaluate fails the run
 * (`prepFailure`), because the activity cannot run without it; a user property
 * that fails is recorded with its `error` instead, and the activity runs. Each
 * property is resolved on its own, so one bad property does not hide the rest.
 */
import { USER_PROPERTY_VALUE_MAX_CHARS, type UserProperty } from '../schemas/pipeline.js';
import { interpolationMode, restoreEscapes } from './expr.js';
import { toStr } from './functions.js';
import type { ResolvedUserProperty } from './types.js';

/** #1673 — the error an inactive activity records for a value with a `${}`. */
export const INACTIVE_USER_PROPERTY_UNRESOLVED = 'the activity is inactive';

/**
 * #1673 — `evaluate` for an inactive activity, which reads no run state.
 * Save-time validation leaves an inactive node out (C0c), so its `${}`s were
 * never checked for a secure output's read or a secret ref, and none may be
 * evaluated: a value with one (an unterminated one too) records
 * {@link INACTIVE_USER_PROPERTY_UNRESOLVED} as its error. A literal renders as
 * `substitute` renders one, its escaped `$${` restored.
 */
export function literalOnly(template: string): string {
  const mode = interpolationMode(template);
  if (mode.mode !== 'literal') throw new Error(INACTIVE_USER_PROPERTY_UNRESOLVED);
  return restoreEscapes(mode.scanned);
}

function bounded(text: string): { text: string; truncated?: true } {
  if (text.length <= USER_PROPERTY_VALUE_MAX_CHARS) return { text };
  // Never end on the first half of a surrogate pair: a lone surrogate is not
  // text, and it would be written into the run log.
  const last = text.charCodeAt(USER_PROPERTY_VALUE_MAX_CHARS - 1);
  const end =
    last >= 0xd800 && last <= 0xdbff
      ? USER_PROPERTY_VALUE_MAX_CHARS - 1
      : USER_PROPERTY_VALUE_MAX_CHARS;
  return { text: text.slice(0, end), truncated: true };
}

/**
 * Resolve each property with `evaluate` (the reducer's `substitute` in the
 * node's scope). A non-string result is written as an embedded `${}` would be
 * (`toStr`), so a property reads like the same expression inside a config
 * string. Pure: no clock, no I/O, so a replay resolves the same values.
 */
export function resolveUserProperties(
  props: readonly UserProperty[],
  evaluate: (template: string) => unknown,
): ResolvedUserProperty[] {
  return props.map(({ name, value }) => {
    // The stringifying is inside the `try` too: nothing about one property may
    // escape to `prepFailure` and fail the run.
    try {
      const resolved = evaluate(value);
      const { text, truncated } = bounded(
        typeof resolved === 'string' ? resolved : toStr(resolved),
      );
      return { name, value: text, ...(truncated ? { truncated } : {}) };
    } catch (err) {
      const { text, truncated } = bounded(err instanceof Error ? err.message : String(err));
      return { name, error: text, ...(truncated ? { truncated } : {}) };
    }
  });
}
