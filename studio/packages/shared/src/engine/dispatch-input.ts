/**
 * #890 — the record of the input a node was DISPATCHED with, stored on
 * `node.dispatched.input` so the run monitor can show what actually ran (ADF's
 * activity "Input") rather than the authored template.
 *
 * What is recorded is the reducer's `preparedInput`: the node's config after
 * `${}` substitution and BEFORE the executor resolves any `{$secret}` marker, so
 * a config-sink secret appears as its marker NAME, never its value. No other
 * secret reaches `${}` output: secret params are stripped from substitution,
 * connection and sink secrets are decrypted after it, and an upstream secure
 * output folds as its marker. The executor still scrubs every plaintext it
 * resolved before calling this — see `executor.ts`.
 *
 * Bounded per dispatch, because a `foreach` dispatches once per item and a retry
 * once per attempt: the log grows by at most this much per dispatch, the same
 * order as the outputs every dispatch already records. Small enough that the
 * monitor mounts the whole stored text with no disclosure (`InputSection`).
 */
import type { DispatchInput } from './types.js';
import { surrogateSafeCut } from './surrogate.js';

/** #890 — the most JSON text one `node.dispatched.input` keeps, in UTF-16 units. */
export const DISPATCH_INPUT_MAX_CHARS = 4_000;

/**
 * Compact JSON of `config` minus its `outputs` key, cut at
 * `DISPATCH_INPUT_MAX_CHARS` without splitting a surrogate pair. `chars` is
 * always the WHOLE length and `truncated` is present only when the text was cut. `undefined` when JSON cannot represent the value
 * (a cycle, a bigint): absent means "not recorded", and a substitute would be
 * an invented input.
 *
 * `outputs` is dropped because it is not an input: it is the node's declared
 * RESULT contract (`config.outputs`, #1 F13, read by `engine/outputs.ts`), which
 * save-time lowering seeds from the catalog, so it would open every record with
 * a template the author may never have written.
 */
export function captureDispatchInput(config: Record<string, unknown>): DispatchInput | undefined {
  const input = { ...config };
  delete input['outputs'];
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    return undefined;
  }
  if (text.length <= DISPATCH_INPUT_MAX_CHARS) return { text, chars: text.length };
  return {
    text: text.slice(0, surrogateSafeCut(text, DISPATCH_INPUT_MAX_CHARS)),
    chars: text.length,
    truncated: true,
  };
}
