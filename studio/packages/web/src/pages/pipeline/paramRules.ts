import {
  NewPipelineVersionSchema,
  isAddressableOutputName,
  type GlobalParamType,
  type Output,
  type Param,
  type ParamType,
  type VariableDef,
  type VariableType,
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
 * #844 V3 — each variable type's ZERO value: what a new row, or a type change
 * that cannot carry the old default across, writes. A variable's default is
 * REQUIRED and checked strictly (spec V-D1), so the doc always states the
 * starting value rather than leaving the run to invent one.
 */
export const VARIABLE_ZERO: Readonly<Record<VariableType, string | number | boolean | []>> = {
  string: '',
  number: 0,
  boolean: false,
  array: [],
};

/** A fresh zero value — `array`'s must not be a SHARED `[]` two rows could alias. */
function zeroOf(type: VariableType): unknown {
  return type === 'array' ? [] : VARIABLE_ZERO[type];
}

/** A new variable row, stating its starting value (V-D1). */
export function blankVariable(existing: readonly VariableDef[]): VariableDef {
  return { name: freshName('var', existing), type: 'string', default: '' };
}

/**
 * Turn a variable default field's text into the typed value the doc stores.
 *
 * Unlike a param (`coerceDefaultInput`), BLANK is not "no default": a variable
 * always has one. For a `string` it is the empty string, stored verbatim; for
 * any other type it is refused, because inventing `0` or `false` from an
 * emptied field would store a value the author never typed.
 */
export function coerceVariableDefault(
  type: VariableType,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const missing = `a ${type} variable needs a starting value`;
  if (type === 'array') {
    if (!raw.trim()) return { ok: false, error: missing };
    const parsed = coerceDefaultInput('json', raw);
    if (!parsed.ok) return { ok: false, error: 'expected a JSON array, e.g. [1, 2]' };
    if (!parsed.has || !Array.isArray(parsed.value)) {
      return { ok: false, error: 'expected a JSON array, e.g. [1, 2]' };
    }
    return { ok: true, value: parsed.value };
  }
  return coerceRequiredValue(type, raw, missing);
}

/**
 * The value-is-REQUIRED read both a variable default and a global's value
 * share: blank is `''` for a `string`, stored verbatim, and refused (with
 * `missing`) for any other type rather than invented as `0` or `false`.
 */
function coerceRequiredValue(
  type: 'string' | 'number' | 'boolean' | 'json',
  raw: string,
  missing: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (type === 'string') return { ok: true, value: raw };
  const parsed = coerceDefaultInput(type, raw);
  if (!parsed.ok) return parsed;
  if (!parsed.has) return { ok: false, error: missing };
  return { ok: true, value: parsed.value };
}

/**
 * #844 GL2 — a global's value field, read under its declared type. A global
 * always has a value (GL-D1: `value` is required), so this is the variable
 * rule, not the param one: blank is not "none". The server re-checks with
 * `globalParamValueDefects`, which adds the byte bound and json replay safety.
 */
export function coerceGlobalValue(
  type: GlobalParamType,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  return coerceRequiredValue(type, raw, `a ${type} global needs a value`);
}

/** Render a stored variable default as its field's text (the inverse of the above). */
export function formatVariableDefault(value: unknown, type: VariableType): string {
  return formatDefaultInput(value, type === 'array' ? 'json' : type);
}

/**
 * Change a variable's type, carrying the default across when it CONVERTS.
 *
 * Not ParamRow's "keep the default and let the gate name the mismatch": a
 * variable default is checked strictly, so a kept `5` under `string` would be a
 * standing error whose field already shows `5`, and a blur that changes nothing
 * cannot repair it. So the default is re-read under the new type from its own
 * text (`5` → `'5'`, `'5'` → `5`, `'true'` → `true`), and where that fails it
 * becomes the new type's zero value. A mis-click is one undo away.
 */
export function withVariableType(v: VariableDef, type: VariableType): VariableDef {
  if (type === v.type) return v;
  const carried = coerceVariableDefault(type, formatVariableDefault(v.default, v.type));
  return { ...v, type, default: carried.ok ? carried.value : zeroOf(type) };
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
function schemaNameIssues(
  label: 'param' | 'output' | 'variable',
  items: readonly { name: string }[],
): string[] {
  const field =
    label === 'param'
      ? NewPipelineVersionSchema.shape.params
      : label === 'output'
        ? NewPipelineVersionSchema.shape.outputs
        : NewPipelineVersionSchema.shape.variables;
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
 * The SAVE-GATING issues for the declared params, outputs and variables.
 *
 * Each list is checked in its OWN namespace, because the schema keeps them
 * separate: a param `x`, an output `x` and a variable `x` are different
 * declarations and a doc holding all three is legal. Merging them would refuse a
 * valid pipeline.
 *
 * Kept OUT of `validateCanvas` on purpose. That function's contract is that it
 * delegates to `validatePipelineDoc`, the exact function the server's write gate
 * calls — a property worth preserving. These rules come from the write SCHEMA
 * instead, a different (and equally real) server gate, so they are concatenated
 * at the call site rather than smuggled inside a function that promises one SSOT.
 */
export function nameIssues(
  params: readonly Param[],
  outputs: readonly Output[],
  variables: readonly VariableDef[],
): string[] {
  return [
    ...schemaNameIssues('param', params),
    ...schemaNameIssues('output', outputs),
    ...schemaNameIssues('variable', variables),
  ];
}

/**
 * #1 F8a — the SAVE-GATING issues for the General tab's description and
 * annotations: the write schema's own refusals (`NewPipelineVersionSchema`), so
 * the canvas says exactly what the server would. Concatenated at the call site
 * beside `nameIssues`, for the reason given there.
 *
 * Unlike `schemaNameIssues`, nothing is skipped: an empty annotation is a
 * `too_small` issue and has no better wording elsewhere.
 */
export function propertyIssues(description: string, annotations: readonly string[]): string[] {
  const out: string[] = [];
  const text = NewPipelineVersionSchema.shape.description.safeParse(description);
  if (!text.success) out.push(...text.error.issues.map((issue) => issue.message));
  const tags = NewPipelineVersionSchema.shape.annotations.safeParse(annotations);
  if (!tags.success) {
    for (const issue of tags.error.issues) {
      const at = issue.path[0];
      // A per-annotation refusal names its row; a whole-list one (too many) does not.
      out.push(typeof at === 'number' ? `annotation ${at + 1}: ${issue.message}` : issue.message);
    }
  }
  return out;
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
 * `''` as its default says so with the row's "Empty string" tick box
 * (`ParamRow`, #844 4c), which appears only on a blank string field rather than
 * as a has-default checkbox on every row.
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
 *
 * Except under `type: 'json'`, where the field is parsed as JSON and a string
 * must therefore be shown QUOTED to round-trip (#844). Unquoted, a string that a
 * type switch carried over from a `string` param (`'{"a":1}'`) looked exactly
 * like the object a run would never receive, and editing `hello` failed parsing.
 * `type` is optional because the run-override editor still formats untyped;
 * whether a JSON-looking string round-trips there is #1353.
 */
export function formatDefaultInput(value: unknown, type?: ParamType): string {
  if (value === undefined) return '';
  if (typeof value === 'string' && type !== 'json') return value;
  return JSON.stringify(value) ?? '';
}

/**
 * Whether any string anywhere inside `value` (arrays included) opens a `${`.
 * Iterative and spread-free, so neither a deep nor a wide json default can
 * overflow the stack while the row renders.
 */
function holdsReferenceOpener(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const v = pending.pop();
    if (typeof v === 'string') {
      if (v.includes('${')) return true;
    } else if (v !== null && typeof v === 'object') {
      // Not `push(...values)`: a spread passes every child as an argument,
      // which throws on a wide enough array just as recursion does on depth.
      for (const child of Object.values(v)) pending.push(child);
    }
  }
  return false;
}

/** Characters the ref grammar splits or quotes on, so `${params.<name>}` can never reach the name. */
const UNREACHABLE_NAME_CHARS = /[.[\]}'"]/;

/**
 * A NON-gating note for a param name that is not a plain identifier (#844), or
 * `null`. The server accepts such a name and some resolve (`${params.my name}`
 * does), but `availableRefs` will not offer one, and a name holding a character
 * the grammar splits on is never reachable at all. Blank names are left to
 * `nameIssues`, which already gates on them.
 */
export function paramNameNote(p: Param): string | null {
  if (!p.name.trim() || isAddressableOutputName(p.name)) return null;
  const reach = UNREACHABLE_NAME_CHARS.test(p.name)
    ? ', and no ${params.…} reference can reach it'
    : '';
  return (
    `'${p.name}' is not a plain identifier, so Insert reference will not offer it${reach}. ` +
    'Use letters, digits and _, not starting with a digit.'
  );
}

/**
 * A NON-gating note for a `${` anywhere in a param's default, or `null`.
 * Defaults are literal (`ParamSchema.default`), so the run receives the text;
 * an escaped `$${` is not unescaped either.
 */
export function paramDefaultNote(p: Param): string | null {
  if (!holdsReferenceOpener(p.default)) return null;
  return (
    'This default is used exactly as written: a ${…} in it is not evaluated. ' +
    'To pass a computed value, bind it on the trigger or override it on the run.'
  );
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
  return required ? { ...withoutDefault(p), required: true } : { ...p, required: false };
}

/**
 * The param with NO default: the key ABSENT, not `default: undefined` —
 * `resolveRunParams` reads it with `hasOwnProperty`, so a present-but-undefined
 * key would mean "the default is undefined".
 */
export function withoutDefault(p: Param): Param {
  const { default: dropped, ...rest } = p;
  void dropped; // discard: lint has no ignoreRestSiblings here
  return rest;
}
