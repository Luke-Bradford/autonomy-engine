/**
 * #1600 OR41 C0d (catalogue spec §3; ADF "user properties") — resolving an
 * activity's user properties at dispatch.
 *
 * A user property is monitoring metadata, so it must never change what a run
 * does. A `${}` in `config` that fails to evaluate fails the run
 * (`prepFailure`), because the activity cannot run without it; a user property
 * that fails is recorded with its `error` instead, and the activity runs. Each
 * property is resolved on its own, so one bad property does not hide the rest.
 */
import { USER_PROPERTY_VALUE_MAX_CHARS, type UserProperty } from '../schemas/pipeline.js';
import { toStr } from './functions.js';
import type { ResolvedUserProperty } from './types.js';

function bounded(text: string): { text: string; truncated?: true } {
  return text.length > USER_PROPERTY_VALUE_MAX_CHARS
    ? { text: text.slice(0, USER_PROPERTY_VALUE_MAX_CHARS), truncated: true }
    : { text };
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
    let resolved: unknown;
    try {
      resolved = evaluate(value);
    } catch (err) {
      const { text, truncated } = bounded(err instanceof Error ? err.message : String(err));
      return { name, error: text, ...(truncated ? { truncated } : {}) };
    }
    const { text, truncated } = bounded(typeof resolved === 'string' ? resolved : toStr(resolved));
    return { name, value: text, ...(truncated ? { truncated } : {}) };
  });
}
