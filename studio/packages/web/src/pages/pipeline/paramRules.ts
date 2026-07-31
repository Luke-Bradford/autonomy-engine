import type { Output, Param, ParamType } from '@autonomy-studio/shared';

/**
 * The pure rules behind the pipeline-level params/outputs editor (U16).
 *
 * Split out of `PipelineCanvas` for the same reason as `containerRules` (U6d):
 * every decision here is a pure function of the doc, so it can be tested — and
 * mutation-proven — without mounting the canvas and its whole API surface.
 *
 * The division of labour with the SERVER is the load-bearing part, and it is
 * deliberately asymmetric:
 *
 *  - `nameIssues` mirrors refusals the server ALSO makes (`ParamSchema.name`'s
 *    `min(1)` and `NewPipelineVersionSchema`'s `refuseDuplicateNames`), so it is
 *    safe to gate Save on: it only spares the author a round-trip to a 400 they
 *    were going to get anyway, and the editor that surfaces it can now repair it.
 *  - `defaultAdvisory` reports things the server ACCEPTS. It must NEVER gate
 *    Save. A version minted before this editor existed — or imported from git —
 *    can legitimately hold a type-mismatched default, and refusing to save such
 *    a doc would leave the operator unable to save ANY edit to that pipeline:
 *    exactly the one-way trap #748 closed, re-created by the check meant to
 *    help. Tell the truth, do not bar the exit.
 */

/** A secret's value is a credential LABEL, never the credential — `engine/params.ts`. */
const SECRET_LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/** The numeric shapes run-time `coerce` accepts from a string — `engine/params.ts`. */
const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * Mint a fresh row with a name nothing else is using.
 *
 * Counts UP from the length rather than filling the lowest free gap: a gap-filler
 * hands out `param_2` while `param_3` exists, which collides again the moment
 * the operator renames anything. The name is a starting point the author is
 * expected to replace — its only real job is to not land on the save gate.
 */
function freshName(prefix: string, taken: readonly { name: string }[]): string {
  const names = new Set(taken.map((t) => t.name));
  let n = taken.length + 1;
  while (names.has(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}

/**
 * A new param row: OPTIONAL, with NO `default` key at all.
 *
 * Not `default: undefined` — `resolveRunParams` reads the default with
 * `hasOwnProperty`, so a present-but-undefined key means "the default is
 * undefined" rather than "there is no default". The distinction is invisible in
 * JSON and load-bearing at run time.
 */
export function blankParam(existing: readonly Param[]): Param {
  return { name: freshName('param', existing), type: 'string', required: false };
}

/**
 * A new output row. `optional` is OMITTED, which `OutputSchema` reads as
 * required — the same absent-means-something contract as `default` above.
 */
export function blankOutput(existing: readonly Output[]): Output {
  return { name: freshName('output', existing), type: 'string' };
}

function duplicateIssues(label: string, items: readonly { name: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  items.forEach((item, i) => {
    if (!item.name.trim()) {
      // No name to quote, so report the POSITION. 1-based: it addresses a row
      // the operator is looking at, not an array index.
      out.push(`${label} #${i + 1} has no name`);
      return;
    }
    if (seen.has(item.name)) {
      // Verbatim `refuseDuplicateNames` (schemas/pipeline.ts). One rejection
      // should not have two vocabularies depending on which gate caught it.
      out.push(
        `duplicate ${label} name '${item.name}' (${label} names must be unique within the pipeline)`,
      );
    }
    seen.add(item.name);
  });
  return out;
}

/**
 * The SAVE-GATING issues for the declared params and outputs.
 *
 * Params and outputs are checked in SEPARATE namespaces, because the schema
 * keeps them separate: a param `x` and an output `x` are different declarations
 * and a doc holding both is legal. Merging them would refuse a valid pipeline.
 *
 * Kept OUT of `validateCanvas` on purpose. That function's contract is that it
 * delegates to `validatePipelineDoc`, the exact function the server's write gate
 * calls — a property worth preserving. These rules come from the write SCHEMA
 * instead, a different (and equally real) server gate, so they are concatenated
 * at the call site rather than smuggled inside a function that promises one SSOT.
 */
export function nameIssues(params: readonly Param[], outputs: readonly Output[]): string[] {
  return [...duplicateIssues('param', params), ...duplicateIssues('output', outputs)];
}

/**
 * A non-gating warning about a param's stored `default`, or `null` if it is fine.
 *
 * The predicate mirrors run-time `coerce` (`engine/params.ts`), NOT the stricter
 * `matchesType` used for node outputs. That difference is deliberate and easy to
 * get wrong: `coerce` accepts the STRING `'5'` for a `number` param, so warning
 * about it would be a false alarm about a default that runs perfectly.
 */
export function defaultAdvisory(p: Param): string | null {
  // A required param's default is never read (`resolveRunParams` demands an
  // override), so there is nothing to warn about even if one is stored.
  if (p.required) return null;
  if (!('default' in p)) return null;
  const v = p.default;

  switch (p.type) {
    case 'number':
      if (typeof v === 'number' && Number.isFinite(v)) return null;
      if (typeof v === 'string' && NUMERIC_TEXT.test(v.trim()) && Number.isFinite(Number(v.trim())))
        return null;
      return 'default is not a finite number — the run will fail when it resolves this param';
    case 'boolean':
      if (typeof v === 'boolean' || v === 'true' || v === 'false') return null;
      return 'default is not a boolean — the run will fail when it resolves this param';
    case 'string':
      if (typeof v === 'string') return null;
      return 'default is not a string — the run will fail when it resolves this param';
    case 'secret':
      if (typeof v === 'string' && SECRET_LABEL.test(v)) return null;
      return 'default is not a credential label ([A-Za-z0-9._-], max 64) — the run will fail when it resolves this param';
    case 'json':
      // `coerce` returns a `json` param's value as-is, so nothing can be wrong.
      return null;
  }
}

/** What a default field's text means: absent, a typed value, or a parse failure. */
export type DefaultParse =
  | { ok: true; has: false }
  | { ok: true; has: true; value: unknown }
  | { ok: false; error: string };

/**
 * Turn the default field's raw text into the TYPED value the doc should store.
 *
 * Storing the typed value rather than the raw text matters downstream: `${}`
 * expression typing (#6 E6) reads the declaration, so a `number` param whose
 * default is the string `'42'` would type as a string everywhere it is
 * referenced even though the run coerces it fine.
 *
 * BLANK means "no default" — not "the empty string". A string param that wants
 * `''` as its default cannot be authored here; that is a known, narrow gap, and
 * the alternative (a separate has-default checkbox on every row) buys one edge
 * case with permanent form clutter.
 */
export function coerceDefaultInput(type: ParamType, raw: string): DefaultParse {
  const text = raw.trim();
  if (!text) return { ok: true, has: false };

  switch (type) {
    case 'number': {
      if (!NUMERIC_TEXT.test(text)) return { ok: false, error: 'expected a number' };
      const n = Number(text);
      // The regex has no exponent, but ~310 digits overflow anyway — so the
      // finite check belongs on the RESULT, as it does in `coerce`.
      if (!Number.isFinite(n)) return { ok: false, error: 'number is too large' };
      return { ok: true, has: true, value: n };
    }
    case 'boolean':
      if (text === 'true') return { ok: true, has: true, value: true };
      if (text === 'false') return { ok: true, has: true, value: false };
      return { ok: false, error: "expected 'true' or 'false'" };
    case 'json':
      try {
        return { ok: true, has: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, error: 'expected valid JSON' };
      }
    case 'secret':
      if (!SECRET_LABEL.test(text))
        return { ok: false, error: 'expected a credential label ([A-Za-z0-9._-], max 64)' };
      return { ok: true, has: true, value: text };
    case 'string':
      // NOT trimmed: leading/trailing space can be meaningful in a string
      // default, and only the blank check above needed the trim.
      return { ok: true, has: true, value: raw };
  }
}

/**
 * Render a stored default back into the field's text.
 *
 * A string is shown as ITSELF rather than JSON-quoted, so the field round-trips
 * through `coerceDefaultInput` unchanged instead of accreting a pair of quotes
 * on every open-and-save cycle.
 */
export function formatDefaultInput(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

/**
 * Flip a param's `required`, honouring the schema's contract that `default` is
 * "only meaningful when `required` is false; omitted entirely otherwise".
 *
 * Becoming required DELETES the stored default rather than leaving it: a doc
 * field the schema calls meaningless is a fact nobody can act on, and it would
 * silently return if the param were made optional again — an edit the operator
 * never made.
 */
export function withRequired(p: Param, required: boolean): Param {
  if (!required) return { ...p, required: false };
  const { default: _dropped, ...rest } = p;
  return { ...rest, required: true };
}
