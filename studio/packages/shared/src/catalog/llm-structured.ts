import { z } from 'zod';
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
 * missing field. A response that fails it terminalizes the node `permanent`
 * (L4c adds an internal repair sub-call before that; today it fails on the first
 * invalid response).
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
 * ALL declared properties are REQUIRED at runtime (the author's `required` list
 * is not consulted here): the lowering pass (`lowerOutputSchema`) lowers EVERY
 * property to a plain `{name,type}` with no optionality channel, and the
 * reducer's `validateOutputs` fails a `missing declared output` — and
 * `matchesType(undefined, 'string')` is false — so a structured node's contract
 * is "every declared field must be produced". True optional/nullable RUNTIME
 * semantics (an absent optional field → a present `null` output) needs a lowering
 * + `matchesType` change and is tracked as a follow-up (#594); L4b's floor is all-present.
 *
 * `enum` (#592) is enforced on top of the base type: L4a accepted `enum` on a
 * property but nothing consumed it, so an author who wrote `enum:[...]` got no
 * guarantee. Here the parsed value MUST be a member (works for non-string enums
 * too). Unknown keys are STRIPPED (Zod's default object behaviour) — the spec's
 * "strip unknown keys, store only the validated/normalized object".
 */
export function validateStructuredOutput(
  schema: LlmOutputSchema,
  payload: unknown,
): StructuredValidationResult {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    let field = baseZodForProperty(prop.type);
    if (prop.enum !== undefined) {
      const allowed = prop.enum;
      field = field.refine((v) => allowed.includes(v), {
        message: 'value is not one of the declared enum values',
      });
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
  return { ok: true, value: parsed.data };
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
