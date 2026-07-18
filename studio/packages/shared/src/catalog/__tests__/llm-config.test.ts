import { describe, expect, it } from 'vitest';
import { getActivity } from '../registry.js';
import {
  llmCallConfigSchema,
  llmOutputSchemaSchema,
  llmStructuredOutputSurfaceSchema,
  lowerOutputSchema,
  normalizeLlmRequest,
} from '../llm-config.js';

describe('llmCallConfigSchema', () => {
  it('accepts the v1 `prompt` shorthand', () => {
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi' }).success).toBe(true);
  });

  it('accepts the v2 role-tagged `messages[]`', () => {
    const r = llmCallConfigSchema.safeParse({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('accepts the full v2 sampling surface', () => {
    const r = llmCallConfigSchema.safeParse({
      prompt: 'hi',
      system: 's',
      model: 'm',
      maxTokens: 10,
      temperature: 0.2,
      topP: 0.9,
      stop: ['\n\n'],
      seed: 7,
    });
    expect(r.success).toBe(true);
  });

  // HIGH constraint: `ctx.input` is the whole substituted node.config, which
  // carries the seeded `outputs` contract key (+ future L3/L4a/L10 fields). The
  // schema MUST be non-strict or every real dispatch fails on an extra key.
  it('is non-strict — an unknown key like the `outputs` contract passes', () => {
    const r = llmCallConfigSchema.safeParse({
      prompt: 'hi',
      outputs: [{ key: 'text', type: 'string' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an out-of-range `topP` at save-time (universal [0,1] bound)', () => {
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', topP: 1.5 }).success).toBe(false);
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', topP: -0.1 }).success).toBe(false);
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', topP: 0.9 }).success).toBe(true);
  });

  it('rejects a negative `temperature` (universal lower bound; upper is provider-owned)', () => {
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', temperature: -0.1 }).success).toBe(false);
    // 1.5 is valid for OpenAI/Ollama — the upper bound is intentionally not enforced here.
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', temperature: 1.5 }).success).toBe(true);
  });

  it('rejects an empty-string `stop` element but allows an empty `stop` array', () => {
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', stop: [''] }).success).toBe(false);
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', stop: ['x', ''] }).success).toBe(false);
    // `stop: []` is benign (no stop sequences) — not a save-time error.
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', stop: [] }).success).toBe(true);
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', stop: ['STOP'] }).success).toBe(true);
  });

  it('rejects both `prompt` and `messages` (ambiguous)', () => {
    const r = llmCallConfigSchema.safeParse({
      prompt: 'hi',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects neither `prompt` nor `messages`', () => {
    expect(llmCallConfigSchema.safeParse({ system: 's' }).success).toBe(false);
  });

  it('rejects an empty `messages` array', () => {
    expect(llmCallConfigSchema.safeParse({ messages: [] }).success).toBe(false);
  });

  it('rejects `messages` with no non-system turn', () => {
    const r = llmCallConfigSchema.safeParse({
      messages: [{ role: 'system', content: 'only system' }],
    });
    expect(r.success).toBe(false);
  });

  // #2 L3 — the reasoning knob. Exactly the spec's enum (low|medium|high|max).
  it('accepts each `reasoningEffort` level', () => {
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      expect(llmCallConfigSchema.safeParse({ prompt: 'hi', reasoningEffort: effort }).success).toBe(
        true,
      );
    }
  });

  it('rejects a `reasoningEffort` outside the spec enum', () => {
    // `xhigh` is a real Anthropic effort level but is intentionally NOT in the
    // cross-provider SSOT enum (spec #2 config v2 lists low|medium|high|max);
    // this boundary test pins that decision.
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', reasoningEffort: 'xhigh' }).success).toBe(
      false,
    );
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', reasoningEffort: 'none' }).success).toBe(
      false,
    );
  });

  it('treats `reasoningEffort` as optional (omitting it is valid)', () => {
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi' }).success).toBe(true);
  });

  // SSOT: the catalog entry and the adapter validation are ONE schema object.
  it('IS the llm_call catalog configSchema (single source of truth)', () => {
    expect(getActivity('llm_call')!.configSchema).toBe(llmCallConfigSchema);
  });
});

describe('normalizeLlmRequest', () => {
  it('lowers the v1 `prompt` to a single user message', () => {
    const n = normalizeLlmRequest({ prompt: 'hi' });
    expect(n.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(n.system).toBeUndefined();
  });

  it('folds the top-level `system` shorthand and preserves user turns', () => {
    const n = normalizeLlmRequest({
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(n.system).toBe('be terse');
    expect(n.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('folds a NON-LEADING system message to the top-level system, keeping non-system order', () => {
    const n = normalizeLlmRequest({
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'system', content: 'mid' },
        { role: 'assistant', content: 'a1' },
      ],
    });
    expect(n.system).toBe('mid');
    expect(n.messages).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('joins the top-level system and any system messages with a blank line', () => {
    const n = normalizeLlmRequest({
      system: 'top',
      messages: [
        { role: 'system', content: 'inline' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(n.system).toBe('top\n\ninline');
  });

  it('drops an inert empty-string system (behavior noted in the schema doc)', () => {
    const n = normalizeLlmRequest({ prompt: 'hi', system: '' });
    expect(n.system).toBeUndefined();
  });

  // WARNING (review): the TS type does not encode the "exactly one of
  // prompt/messages" invariant (only the runtime `.refine` does), so a caller
  // that bypasses `llmCallConfigSchema.safeParse` could reach here with neither.
  // Fail loud at the boundary instead of emitting `content: undefined` typed as
  // `string` (validate at system boundaries; never manufacture a lie).
  it('throws on a config with neither `prompt` nor `messages` (bypassed parse)', () => {
    expect(() => normalizeLlmRequest({} as never)).toThrow(/prompt.*or.*messages/i);
  });

  it('passes sampling through, yielding undefined (never null/0) for absent knobs', () => {
    const bare = normalizeLlmRequest({ prompt: 'hi' });
    expect(bare.sampling).toEqual({
      temperature: undefined,
      maxTokens: undefined,
      topP: undefined,
      stop: undefined,
      seed: undefined,
    });
    const full = normalizeLlmRequest({
      prompt: 'hi',
      temperature: 0.2,
      maxTokens: 10,
      topP: 0.9,
      stop: ['x'],
      seed: 7,
    });
    expect(full.sampling).toEqual({
      temperature: 0.2,
      maxTokens: 10,
      topP: 0.9,
      stop: ['x'],
      seed: 7,
    });
  });

  // #2 L3 — `reasoningEffort` is a top-level sibling of `sampling` (it maps to a
  // DIFFERENT request location per provider, so it is not a sampling knob); it
  // passes through verbatim, `undefined` when absent.
  it('passes `reasoningEffort` through, undefined when absent', () => {
    expect(normalizeLlmRequest({ prompt: 'hi' }).reasoningEffort).toBeUndefined();
    expect(normalizeLlmRequest({ prompt: 'hi', reasoningEffort: 'high' }).reasoningEffort).toBe(
      'high',
    );
  });
});

// #2 L4a — the restricted `outputSchema` SUBSET (object root, finite named
// scalar/json/array/object properties, closed additionalProperties, no
// oneOf/anyOf/$ref). This is the SINGLE schema both the save-time validator
// (`validateDoc`) and the lowering gate (`catalog/lower.ts`) parse through, so the
// subset rules can never drift between "what saves" and "what lowers".
describe('llmOutputSchemaSchema', () => {
  const objSchema = (extra: Record<string, unknown> = {}) => ({
    type: 'object',
    properties: { category: { type: 'string' }, score: { type: 'number' } },
    ...extra,
  });

  it('accepts a well-formed object-root subset', () => {
    expect(llmOutputSchemaSchema.safeParse(objSchema()).success).toBe(true);
  });

  it('accepts every scalar/json/array/object property type + integer', () => {
    const r = llmOutputSchemaSchema.safeParse({
      type: 'object',
      properties: {
        s: { type: 'string' },
        n: { type: 'number' },
        i: { type: 'integer' },
        b: { type: 'boolean' },
        o: { type: 'object', properties: { inner: { type: 'string' } } },
        a: { type: 'array', items: { type: 'string' } },
      },
    });
    expect(r.success).toBe(true);
  });

  it('accepts benign root metadata (description/title) — symmetric with property-level', () => {
    expect(
      llmOutputSchemaSchema.safeParse({
        type: 'object',
        title: 'Classification',
        description: 'the classifier result',
        properties: { category: { type: 'string', description: 'the label' } },
      }).success,
    ).toBe(true);
  });

  it('rejects a non-object root', () => {
    expect(
      llmOutputSchemaSchema.safeParse({ type: 'array', items: { type: 'string' } }).success,
    ).toBe(false);
  });

  it('rejects an empty `properties` (a structured output must declare a field)', () => {
    expect(llmOutputSchemaSchema.safeParse({ type: 'object', properties: {} }).success).toBe(false);
  });

  it('rejects an unsupported property type', () => {
    expect(
      llmOutputSchemaSchema.safeParse({ type: 'object', properties: { x: { type: 'null' } } })
        .success,
    ).toBe(false);
  });

  it('rejects oneOf/anyOf/$ref at the root (strict subset)', () => {
    expect(llmOutputSchemaSchema.safeParse(objSchema({ oneOf: [] })).success).toBe(false);
    expect(llmOutputSchemaSchema.safeParse(objSchema({ anyOf: [] })).success).toBe(false);
    expect(llmOutputSchemaSchema.safeParse(objSchema({ $ref: '#/x' })).success).toBe(false);
  });

  it('rejects open additionalProperties but accepts an explicit `false`', () => {
    expect(llmOutputSchemaSchema.safeParse(objSchema({ additionalProperties: true })).success).toBe(
      false,
    );
    expect(
      llmOutputSchemaSchema.safeParse(objSchema({ additionalProperties: false })).success,
    ).toBe(true);
  });

  it('rejects a non-addressable property name (would derive an unaddressable output)', () => {
    expect(
      llmOutputSchemaSchema.safeParse({
        type: 'object',
        properties: { 'my-field': { type: 'string' } },
      }).success,
    ).toBe(false);
  });

  it('rejects a `required` entry that names no declared property', () => {
    expect(
      llmOutputSchemaSchema.safeParse(objSchema({ required: ['category', 'ghost'] })).success,
    ).toBe(false);
    expect(llmOutputSchemaSchema.safeParse(objSchema({ required: ['category'] })).success).toBe(
      true,
    );
  });
});

describe('lowerOutputSchema', () => {
  it('maps top-level properties to Output[] with type lowering, preserving order', () => {
    const outputs = lowerOutputSchema({
      type: 'object',
      properties: {
        category: { type: 'string' },
        count: { type: 'integer' },
        score: { type: 'number' },
        ok: { type: 'boolean' },
        meta: { type: 'object', properties: { a: { type: 'string' } } },
        tags: { type: 'array', items: { type: 'string' } },
      },
    });
    // integer→number, object/array→json; insertion order preserved.
    expect(outputs).toEqual([
      { name: 'category', type: 'string' },
      { name: 'count', type: 'number' },
      { name: 'score', type: 'number' },
      { name: 'ok', type: 'boolean' },
      { name: 'meta', type: 'json' },
      { name: 'tags', type: 'json' },
    ]);
  });

  it('lowers a property literally named `text` to a single output (no catalog-default collision)', () => {
    // The catalog default `[text, stopReason]` is OVERWRITTEN, not merged, by the
    // lowering pass — so a structured field named `text` is the sole `text` output.
    expect(lowerOutputSchema({ type: 'object', properties: { text: { type: 'string' } } })).toEqual(
      [{ name: 'text', type: 'string' }],
    );
  });

  // #594 — a property NOT named in an EXPLICIT `required` list lowers with
  // `optional:true`; a required one carries no `optional` (absent = required).
  it('marks a property omitted from a present `required` list as optional', () => {
    const outputs = lowerOutputSchema({
      type: 'object',
      properties: { category: { type: 'string' }, reason: { type: 'string' } },
      required: ['category'],
    });
    expect(outputs).toEqual([
      { name: 'category', type: 'string' },
      { name: 'reason', type: 'string', optional: true },
    ]);
  });

  // An ABSENT `required` list keeps the L4b floor: ALL required (no `optional`
  // key), NOT strict-JSON-Schema "absent required = all optional" — which would
  // silently null-fill and change existing saved-schema semantics toward data
  // loss. Optionality is opt-in via an explicit partial `required` list.
  it('leaves every property required when there is no `required` list', () => {
    const outputs = lowerOutputSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    });
    expect(outputs).toEqual([
      { name: 'a', type: 'string' },
      { name: 'b', type: 'number' },
    ]);
  });

  // The one input shape `isOptionalProperty` treats differently from "absent":
  // an EXPLICIT empty `required: []` is a present list naming nothing, so EVERY
  // property is optional (`required !== undefined` && never `.includes`). This
  // is the deliberate present-vs-absent split — pin it so the `!== undefined`
  // guard is never "simplified" into a truthiness/length check that would
  // collapse `[]` into the absent (all-required) floor.
  it('treats an EXPLICIT empty `required: []` as ALL properties optional', () => {
    const outputs = lowerOutputSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: [],
    });
    expect(outputs).toEqual([
      { name: 'a', type: 'string', optional: true },
      { name: 'b', type: 'number', optional: true },
    ]);
  });
});

// #2 L4a — the outputMode↔outputSchema COUPLING surface, the exact slice both the
// lowering pass and `validateDoc` parse from a node's config.
describe('llmStructuredOutputSurfaceSchema', () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } } };

  it('accepts a text-mode / legacy node (both fields absent — back-compat)', () => {
    expect(llmStructuredOutputSurfaceSchema.safeParse({}).success).toBe(true);
    expect(llmStructuredOutputSurfaceSchema.safeParse({ outputMode: 'text' }).success).toBe(true);
  });

  it('accepts a structured node with a valid outputSchema', () => {
    expect(
      llmStructuredOutputSurfaceSchema.safeParse({ outputMode: 'structured', outputSchema: schema })
        .success,
    ).toBe(true);
  });

  it('rejects structured WITHOUT an outputSchema', () => {
    expect(llmStructuredOutputSurfaceSchema.safeParse({ outputMode: 'structured' }).success).toBe(
      false,
    );
  });

  it('rejects an outputSchema WITHOUT structured mode (text-mode stray schema)', () => {
    expect(llmStructuredOutputSurfaceSchema.safeParse({ outputSchema: schema }).success).toBe(
      false,
    );
    expect(
      llmStructuredOutputSurfaceSchema.safeParse({ outputMode: 'text', outputSchema: schema })
        .success,
    ).toBe(false);
  });

  it('ignores the rest of a real node.config (non-strict — config carries many keys)', () => {
    expect(
      llmStructuredOutputSurfaceSchema.safeParse({
        prompt: 'hi',
        outputs: [{ name: 'text', type: 'string' }],
        outputMode: 'structured',
        outputSchema: schema,
      }).success,
    ).toBe(true);
  });
});

// #2 L4a — the coupling rule is shared with the DISPATCH schema so a structured
// node fails the same way whether checked at save or at dispatch.
describe('llmCallConfigSchema — L4a structured-output coupling', () => {
  it('accepts a legacy text config unchanged (no outputMode/outputSchema)', () => {
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi' }).success).toBe(true);
  });

  it('accepts a structured config with a valid schema', () => {
    expect(
      llmCallConfigSchema.safeParse({
        prompt: 'classify this',
        outputMode: 'structured',
        outputSchema: { type: 'object', properties: { category: { type: 'string' } } },
      }).success,
    ).toBe(true);
  });

  it('rejects structured-without-schema and schema-without-structured at dispatch too', () => {
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi', outputMode: 'structured' }).success).toBe(
      false,
    );
    expect(
      llmCallConfigSchema.safeParse({
        prompt: 'hi',
        outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
      }).success,
    ).toBe(false);
  });
});
