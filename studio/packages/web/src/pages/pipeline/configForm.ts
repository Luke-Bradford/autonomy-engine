import type { z } from 'zod';

/**
 * The pure rules behind the per-activity node config form (U7).
 *
 * The form is DERIVED from each activity's Zod `configSchema` rather than from
 * hand-written field metadata on `ActivityCatalogEntry`. That schema is already
 * the single source of truth for an activity's authored shape — `agent-config.ts`
 * says so explicitly, and `httpSecretHeadersSchema` exists precisely to stop the
 * catalog and its adapter desyncing on one. A parallel `fields: [...]` list would
 * be a third copy of the same shape, free to drift the moment an activity gains a
 * setting. So this module is the ONE place that reads Zod's internals, kept pure
 * and exhaustively tested, where a Zod-major change fails loudly in unit tests
 * instead of silently rendering the wrong control.
 *
 * The division of labour with the SERVER matters and is deliberately narrow:
 * this form is a UX affordance, NOT a gate. Several activities' `configSchema` is
 * palette metadata whose real constraints live in `validateDoc` (`wait.seconds`
 * is a `z.string()` so it can hold a `${}` expression; `validateWaitConfig` is
 * what actually judges it). The panel's local `safeParse` only spares the author a
 * round-trip to a 400 they were going to get anyway. It must never present itself
 * as the authority, and it must never refuse to save something the server accepts.
 *
 * Two properties here are load-bearing against SILENT DATA LOSS:
 *
 *  - `assembleConfig` merges the form's keys over the ORIGINAL config and never
 *    stores a `safeParse` output. A plain `z.object` STRIPS unknown keys (verified
 *    against zod 4.4.3), so storing the parse result would drop `config.outputs`
 *    — the F13 contract `catalog/lower.ts` owns — along with any other key an
 *    API-authored or git-imported doc carries. Preserving every key the form does
 *    not own generalises the old `outputs` special case into one rule.
 *  - `formatFieldValue` REFUSES a stored value whose runtime type disagrees with
 *    its schema-derived control, rather than rendering it lossily. The kind comes
 *    from the schema; the value comes from the doc, and the two can legitimately
 *    disagree. Rendering `{a:1}` into a text box would apply back as the string
 *    "[object Object]" — a corruption caused by opening the panel, not by editing.
 */

/** The controls this form can render. Anything else authors as JSON. */
export type ConfigFieldKind = 'text' | 'number' | 'boolean' | 'enum' | 'stringList' | 'json';

/** One derived control: a config key, and how to author it. */
export interface ConfigField {
  readonly name: string;
  readonly kind: ConfigFieldKind;
  /** Whether the key may be ABSENT (optional / defaulted), not whether it may be empty. */
  readonly optional: boolean;
  /** The permitted values, for `kind: 'enum'` only. */
  readonly enumOptions?: readonly string[];
  /** A defaulted key's default, offered as a placeholder — never written in. */
  readonly defaultText?: string;
}

/** A stored value rendered into its control, or a refusal to render it at all. */
export type FieldRender = { ok: true; value: string | boolean } | { ok: false; reason: string };

/** A control's input read back out: a value, an instruction to drop the key, or a refusal. */
export type FieldParse =
  | { ok: true; omit: true }
  | { ok: true; omit: false; value: unknown }
  | { ok: false; message: string };

/** The assembled config, plus the schema-declared subset to validate on its own. */
export type AssembleResult =
  | { ok: true; config: Record<string, unknown>; owned: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * The shape of a Zod v4 internal definition, as far as this module reads it.
 *
 * Declared structurally and read through `defOf` so that EVERY access to Zod's
 * internals is funnelled through one cast in one file. `z.ZodType` erases the
 * concrete subclass, so there is no public API that answers "what construct is
 * this" for an arbitrary schema — but the discriminants below are stable v4
 * surface (`.def.type`, `.shape`, `.options`, `.element`).
 */
interface ZodDefLike {
  readonly type?: string;
  readonly innerType?: unknown;
  readonly defaultValue?: unknown;
}

function defOf(schema: unknown): ZodDefLike | null {
  const def = (schema as { def?: unknown } | null | undefined)?.def;
  return typeof def === 'object' && def !== null ? (def as ZodDefLike) : null;
}

/**
 * Wrappers that make a key ABSENT-able. `nullable` is deliberately NOT here: it
 * permits the VALUE `null`, which is not the same as omitting the key, and
 * labelling such a field "optional" would be a lie the author acts on.
 */
const ABSENTABLE_WRAPPERS = new Set(['optional', 'default', 'prefault', 'nullish']);
/** Wrappers to see through without changing whether the key may be absent. */
const TRANSPARENT_WRAPPERS = new Set(['nullable', 'readonly', 'catch', 'lazy', 'pipe']);

interface Unwrapped {
  readonly inner: unknown;
  readonly optional: boolean;
  readonly defaultText?: string;
}

/** Peel the wrappers off a field schema, recording whether the key may be absent. */
function unwrap(schema: unknown): Unwrapped {
  let inner = schema;
  let optional = false;
  let defaultText: string | undefined;

  // Bounded: each step consumes one wrapper, and a schema nests finitely many.
  for (let depth = 0; depth < 16; depth += 1) {
    const def = defOf(inner);
    const type = def?.type;
    if (type === undefined) break;
    if (!ABSENTABLE_WRAPPERS.has(type) && !TRANSPARENT_WRAPPERS.has(type)) break;
    if (ABSENTABLE_WRAPPERS.has(type)) optional = true;
    if (defaultText === undefined && def?.defaultValue !== undefined) {
      // Zod has carried this as both a value and a thunk across releases.
      const raw = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
      defaultText = typeof raw === 'string' ? raw : JSON.stringify(raw);
    }
    if (def?.innerType === undefined) break;
    inner = def.innerType;
  }

  return { inner, optional, defaultText };
}

/** Which control an unwrapped field schema gets. Unknown constructs author as JSON. */
function classify(schema: unknown): Pick<ConfigField, 'kind' | 'enumOptions'> {
  switch (defOf(schema)?.type) {
    case 'string':
      return { kind: 'text' };
    case 'number':
    case 'int':
      return { kind: 'number' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'enum': {
      const options = (schema as { options?: unknown }).options;
      // A non-string enum has no `<select>` this form can build honestly.
      return Array.isArray(options) && options.every((o) => typeof o === 'string')
        ? { kind: 'enum', enumOptions: options as string[] }
        : { kind: 'json' };
    }
    case 'array': {
      const element = (schema as { element?: unknown }).element;
      return defOf(unwrap(element).inner)?.type === 'string'
        ? { kind: 'stringList' }
        : { kind: 'json' };
    }
    default:
      return { kind: 'json' };
  }
}

/**
 * The controls for one activity's config, or `null` when the schema is not
 * object-rooted.
 *
 * `null` is FAIL-SAFE, and the distinction matters: an unrecognised FIELD
 * degrades to a JSON control (the key is still authorable), but an unrecognised
 * ROOT yields no form at all, so the caller falls back to the whole-config JSON
 * editor. A partial form built from a root this module misread would silently
 * drop the keys it failed to see.
 */
export function deriveConfigFields(schema: z.ZodType): ConfigField[] | null {
  if (defOf(schema)?.type !== 'object') return null;
  const shape = (schema as unknown as { shape?: unknown }).shape;
  if (typeof shape !== 'object' || shape === null) return null;

  return Object.entries(shape as Record<string, unknown>).map(([name, fieldSchema]) => {
    const { inner, optional, defaultText } = unwrap(fieldSchema);
    const { kind, enumOptions } = classify(inner);
    return { name, kind, optional, ...(enumOptions && { enumOptions }), ...(defaultText !== undefined && { defaultText }) };
  });
}

/** Render a stored config value into its control, refusing what it cannot represent. */
export function formatFieldValue(field: ConfigField, value: unknown): FieldRender {
  if (value === undefined) return { ok: true, value: field.kind === 'boolean' ? false : '' };

  switch (field.kind) {
    case 'text':
      return typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, reason: 'not a string' };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true, value: String(value) }
        : { ok: false, reason: 'not a number' };
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, reason: 'not a boolean' };
    case 'enum':
      return typeof value === 'string' && (field.enumOptions ?? []).includes(value)
        ? { ok: true, value }
        : { ok: false, reason: 'not one of the permitted values' };
    case 'stringList':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? { ok: true, value: value.join('\n') }
        : { ok: false, reason: 'not a list of strings' };
    case 'json': {
      const text = JSON.stringify(value, null, 2);
      // `undefined` back from stringify means the value has no JSON form at all.
      return typeof text === 'string' ? { ok: true, value: text } : { ok: false, reason: 'not JSON' };
    }
  }
}

/**
 * The names of every field whose STORED value its control cannot represent.
 *
 * Non-empty means the panel must fall back to the whole-config JSON editor for
 * this node: showing a form that cannot round-trip what is already saved would
 * corrupt the doc on an apply the author believes changed one other field.
 */
export function unrepresentableFields(
  fields: readonly ConfigField[],
  config: Record<string, unknown>,
): string[] {
  return fields.filter((f) => !formatFieldValue(f, config[f.name]).ok).map((f) => f.name);
}

/** Numeric text this form accepts — decimal only, so `1e` and `0x10` are refused, not coerced. */
const NUMERIC_INPUT = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Read one control's input back out as a config value. */
export function parseFieldInput(field: ConfigField, raw: string | boolean): FieldParse {
  if (field.kind === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, message: 'expected a checkbox value' };
    // An UNCHECKED optional box omits the key rather than writing `false`, so
    // "absent" and "explicitly false" stay distinguishable — `catalog/lower.ts`
    // reads exactly that difference on `emitMessages`.
    if (!raw && field.optional) return { ok: true, omit: true };
    return { ok: true, omit: false, value: raw };
  }

  if (typeof raw !== 'boolean' && raw.trim() === '') {
    // One uniform rule: empty means "not set". Writing `''` or `null` instead
    // would turn "the author left this alone" into an explicit value the engine
    // has to interpret. A REQUIRED key omitted is not refused here — the
    // activity's own schema reports it missing, in its own words.
    return { ok: true, omit: true };
  }
  if (typeof raw === 'boolean') return { ok: false, message: 'expected a text value' };

  switch (field.kind) {
    case 'text':
      // Verbatim, NOT trimmed: leading/trailing space can be meaningful in a
      // value that is interpolated into a larger string.
      return { ok: true, omit: false, value: raw };
    case 'number':
      return NUMERIC_INPUT.test(raw.trim())
        ? { ok: true, omit: false, value: Number(raw.trim()) }
        : { ok: false, message: 'must be a number' };
    case 'enum':
      return (field.enumOptions ?? []).includes(raw)
        ? { ok: true, omit: false, value: raw }
        : { ok: false, message: 'must be one of the permitted values' };
    case 'stringList': {
      const values = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
      return values.length === 0
        ? { ok: true, omit: true }
        : { ok: true, omit: false, value: values };
    }
    case 'json':
      try {
        return { ok: true, omit: false, value: JSON.parse(raw) };
      } catch {
        return { ok: false, message: 'is not valid JSON' };
      }
    case 'boolean':
      return { ok: false, message: 'expected a checkbox value' };
  }
}

/**
 * Merge the form's inputs into the node's config.
 *
 * Returns the config to STORE and, separately, the schema-declared subset to
 * validate against `configSchema` — validating the whole assembled object would
 * work too (Zod strips), but keeping the validated value to exactly the declared
 * keys preserves today's behaviour and keeps the cross-field `refine`/
 * `superRefine` rules seeing precisely what the schema author intended.
 */
export function assembleConfig(
  original: Record<string, unknown>,
  fields: readonly ConfigField[],
  inputs: Readonly<Record<string, string | boolean | undefined>>,
): AssembleResult {
  // Start from the ORIGINAL so every key no derived field owns survives —
  // `config.outputs` above all, which no `configSchema` declares.
  const config: Record<string, unknown> = { ...original };
  const owned: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = inputs[field.name] ?? (field.kind === 'boolean' ? false : '');
    const parsed = parseFieldInput(field, raw);
    if (!parsed.ok) return { ok: false, message: `${field.name}: ${parsed.message}` };
    if (parsed.omit) {
      delete config[field.name];
      continue;
    }
    config[field.name] = parsed.value;
    owned[field.name] = parsed.value;
  }

  return { ok: true, config, owned };
}
