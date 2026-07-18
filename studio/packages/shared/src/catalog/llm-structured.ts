import { z } from 'zod';
import { isOptionalProperty } from './llm-config.js';
import type { LlmOutputSchema } from './llm-config.js';

/**
 * #2 L4b — RUNTIME strict parse/validate for a `structured` `llm_call`, plus the
 * provider-neutral "emit JSON" instruction. L4a was save-time only (validate the
 * `outputSchema` subset, lower it into `config.outputs`); this module is the
 * counterpart the three adapters call at DISPATCH to turn a provider's raw
 * structured response into the typed `succeeded.outputs` the reducer's
 * `validateOutputs` (`engine/outputs.ts`) will accept.
 *
 * This is the SINGLE correctness guarantee for structured output: each adapter
 * asks its provider for JSON in that provider's native mode (Anthropic forced
 * tool-use, OpenAI `response_format:json_object`, Ollama `format`), but the
 * provider's enforcement is BEST-EFFORT — a gateway/model may return prose or a
 * near-miss. `validateStructuredOutput` is what makes the field addressable:
 * strip unknown keys, NO coercion, enforce declared type + enum (#592), reject a
 * missing REQUIRED field (an optional field → present-null, #594). A response
 * that fails it triggers a bounded internal repair sub-call (#2 L4c,
 * `runStructuredWithRepair`) and terminalizes the node `permanent` only once the
 * repairs are exhausted.
 *
 * DRIFT GUARD (kept STRICTER-or-equal to `matchesType`): the reducer re-checks
 * this module's output against the LOWERED `config.outputs` via `matchesType`
 * (`integer`/`number`→a finite `number`, `object`/`array`→the opaque `json`), so
 * a value this validator accepts must never be re-rejected there. `integer` →
 * `z.number().int()` (a finite integer), `number` → `z.number().finite()` (E6:
 * `number` means finite everywhere in this engine), `object`/`array` → an
 * object/array shape that `matchesType('json')` accepts unconditionally.
 */

export type StructuredValidationResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

/**
 * The Zod type for one declared property's BASE type (before any enum
 * constraint). Deliberately stricter-or-equal to `matchesType` (see header):
 * `integer` is a finite integer, `number` is finite, `object`/`array` validate
 * the container shape (their inner shape is opaque `json`, #6 E7). NO coercion —
 * a `z.number()` rejects the string `"5"`, which is the spec's "no implicit
 * coercion" rule.
 */
function baseZodForProperty(type: LlmOutputSchema['properties'][string]['type']): z.ZodTypeAny {
  switch (type) {
    case 'string':
      return z.string();
    case 'integer':
      return z.number().int();
    case 'number':
      return z.number().finite();
    case 'boolean':
      return z.boolean();
    case 'object':
      return z.record(z.string(), z.unknown());
    case 'array':
      return z.array(z.unknown());
  }
}

/**
 * Validate a raw structured payload against a `structured` node's `outputSchema`.
 *
 * OPTIONALITY (#594): a property is REQUIRED unless the schema carries an EXPLICIT
 * `required` list that OMITS it (an ABSENT `required` list = all required, the L4b
 * all-present floor — see `lowerOutputSchema`). A required property must be present
 * + non-null. An OPTIONAL property may be absent or `null`; either way it is
 * normalized to a present `null` in the returned object (PRESENT-NULL), so the
 * stored `succeeded.outputs` always carries the key and the reducer's
 * `validateOutputs`/`storeOutputs` (which accept the present-null for an optional
 * lowered row) never re-reject it. This keeps the DRIFT GUARD exact: a scalar
 * present-null this validator emits is exactly what `validateOutputs` tolerates
 * for an optional output (`matchesType(null, <scalar>)` is `false`, so the
 * null-tolerance lives in `validateOutputs`, not here).
 *
 * `enum` (#592) is enforced on top of the base type: the parsed value MUST be a
 * member (works for non-string enums too). For an OPTIONAL enum, an absent/`null`
 * value bypasses the enum check (present-null) — only a PRESENT non-null value is
 * constrained. Unknown keys are STRIPPED (Zod's default object behaviour) — the
 * spec's "strip unknown keys, store only the validated/normalized object".
 *
 * A failure returns `{ ok:false, reason }`; the adapter's repair loop (#2 L4c)
 * feeds `reason` back to the model in a corrective re-prompt before terminalizing.
 */
export function validateStructuredOutput(
  schema: LlmOutputSchema,
  payload: unknown,
): StructuredValidationResult {
  // Optionality reads the SHARED `isOptionalProperty` SSOT (llm-config.ts), the
  // SAME rule `lowerOutputSchema` freezes with — so "what validates" and "what
  // lowers" can never disagree about which fields are optional.
  const optionalNames: string[] = [];
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    let field = baseZodForProperty(prop.type);
    if (prop.enum !== undefined) {
      const allowed = prop.enum;
      field = field.refine((v) => allowed.includes(v), {
        message: 'value is not one of the declared enum values',
      });
    }
    // `.nullable().optional()` wraps the (enum-)refined base, so a present `null`
    // or an absent key SHORT-CIRCUITS the refine — the enum/type checks run only
    // on a present non-null value, exactly the present-null contract above.
    if (isOptionalProperty(schema, name)) {
      optionalNames.push(name);
      field = field.nullable().optional();
    }
    shape[name] = field;
  }
  // `z.object` STRIPS unknown keys by default (not `.strict()`, which would
  // reject them, nor `.passthrough()`, which would persist an undeclared key).
  const parsed = z.object(shape).safeParse(payload);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return { ok: false, reason };
  }
  // Present-null normalization: an OPTIONAL property that was absent (Zod drops
  // the key under `.optional()`), or present as `undefined`, is written back as an
  // explicit `null` so the stored object carries every declared key in exactly one
  // shape. Keying on `=== undefined` (not `hasOwnProperty`) covers both the absent
  // case and a `{opt: undefined}` payload; an explicit `null` is already the shape
  // and is left untouched.
  const value: Record<string, unknown> = { ...parsed.data };
  for (const name of optionalNames) {
    if (value[name] === undefined) value[name] = null;
  }
  return { ok: true, value };
}

/**
 * The provider-neutral system directive appended for the adapters whose JSON mode
 * does NOT itself carry the schema (OpenAI `response_format:json_object`, which
 * additionally REQUIRES the literal token "JSON" somewhere in the prompt; Ollama,
 * where `format` carries the schema but the instruction is a harmless belt-and-
 * suspenders). Anthropic does NOT use this — its schema rides in the forced tool's
 * `input_schema`. Contains the word "JSON" by construction.
 */
export function structuredOutputInstruction(schema: LlmOutputSchema): string {
  return (
    'You must respond with a single JSON object that conforms to the following ' +
    'JSON Schema, and output nothing else (no prose, no code fences):\n' +
    JSON.stringify(schema)
  );
}

/**
 * Parse a provider's completion TEXT as JSON and validate it — the OpenAI/Ollama
 * path, where the structured payload arrives as a string in `message.content`
 * rather than a pre-parsed object (Anthropic's forced-tool `input` is already an
 * object, so it calls `validateStructuredOutput` directly). A non-string content
 * or unparseable JSON is a structured failure (the same `permanent` class as a
 * schema mismatch — a 2xx that produced no usable structured completion).
 */
export function parseAndValidateStructured(
  schema: LlmOutputSchema,
  contentText: unknown,
): StructuredValidationResult {
  if (typeof contentText !== 'string') {
    return { ok: false, reason: 'response completion is not a string' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(contentText);
  } catch {
    return { ok: false, reason: 'response completion is not valid JSON' };
  }
  return validateStructuredOutput(schema, payload);
}
