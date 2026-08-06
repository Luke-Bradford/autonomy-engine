import {
  NewPipelineVersionSchema,
  type Output,
  type Param,
  type ParamType,
} from '@autonomy-studio/shared';

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
 *  - the TYPE-vs-`default` check is no longer here at all. It used to be
 *    (`defaultAdvisory`), reporting a defect the server ACCEPTED and therefore
 *    never gating Save: refusing to save a doc the server would take would have
 *    left an imported pipeline holding such a default permanently unsaveable —
 *    the one-way trap #748 closed. #843 moved the check to the SERVER
 *    (`paramDefaultDefect`, reached through `validateDoc`), which changes that
 *    calculus completely. The doc is refused with or without a client gate, so
 *    a non-gating client only spends a round-trip on a 400, and the trap
 *    argument no longer applies for the reason it never applied to `nameIssues`
 *    either: the editor that surfaces the defect can also repair it — U16
 *    renders an editable `type` and `default` for EVERY declared param.
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

/**
 * Run one declaration list through the SERVER'S OWN write-schema field, and
 * report what it refuses.
 *
 * Parsing `NewPipelineVersionSchema.shape.<field>` rather than re-implementing
 * its rules is the whole point: an earlier draft of this module copied
 * `refuseDuplicateNames`' message string, and nothing could have caught the two
 * drifting apart — the web test pinned the web copy, so a change to the shared
 * wording would have left both suites green and the same rejection speaking two
 * vocabularies. Here the duplicate message IS the server's, by construction.
 *
 * Two deliberate departures, both narrowing to a friendlier message rather than
 * to a different VERDICT:
 *  - an empty name is reported by POSITION, since there is no name to quote and
 *    zod's `Too small` says nothing to an operator;
 *  - a WHITESPACE-ONLY name is refused, which `z.string().min(1)` accepts. That
 *    makes this gate stricter than the server in exactly one case. It is safe
 *    for the reason the whole gate is safe — the row is repairable in the editor
 *    that shows it — but it is a real divergence, so it is stated rather than
 *    buried.
 */
function schemaNameIssues(label: 'param' | 'output', items: readonly { name: string }[]): string[] {
  const field =
    label === 'param'
      ? NewPipelineVersionSchema.shape.params
      : NewPipelineVersionSchema.shape.outputs;
  const out: string[] = [];

  items.forEach((item, i) => {
    if (!item.name.trim()) out.push(`${label} #${i + 1} has no name`);
  });

  const parsed = field.safeParse(items);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // The empty-name refusals are already reported above, in better words.
      if (issue.code === 'too_small') continue;
      out.push(issue.message);
    }
  }
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
  return [...schemaNameIssues('param', params), ...schemaNameIssues('output', outputs)];
}

/** What a default field's text means: absent, a typed value, or a parse failure. */
export type DefaultParse =
  { ok: true; has: false } | { ok: true; has: true; value: unknown } | { ok: false; error: string };

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
 * Flip a param's `required`.
 *
 * Becoming required DELETES the stored default rather than leaving it, and the
 * reason is the ENGINE's precedence, not a schema comment (the comment that used
 * to justify this said `default` was "only meaningful when `required` is false",
 * which #843 established is simply false). `resolveRunParams` reads
 * `hasOwnProperty(p, 'default')` BEFORE `p.required`, so a retained default
 * silently satisfies the demand the toggle was just used to make: the param
 * would read `required` on screen and never be asked for a value. Deleting it
 * makes the control mean what it says. The doc REMAINS legal either way — a
 * required param with a default is accepted on write and runs fine — so this is
 * an authoring decision, and the canvas states the alternative outright for a
 * doc that arrives holding one.
 */
export function withRequired(p: Param, required: boolean): Param {
  if (!required) return { ...p, required: false };
  const { default: dropped, ...rest } = p;
  void dropped; // discard: lint has no ignoreRestSiblings here
  return { ...rest, required: true };
}
