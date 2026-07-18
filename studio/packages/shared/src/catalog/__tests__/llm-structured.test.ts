import { describe, expect, it } from 'vitest';
import {
  parseAndValidateStructured,
  structuredOutputInstruction,
  validateStructuredOutput,
} from '../llm-structured.js';
import { llmOutputSchemaSchema } from '../llm-config.js';
import { validateOutputs } from '../../engine/outputs.js';
import { lowerOutputSchema } from '../llm-config.js';
import type { LlmOutputSchema } from '../llm-config.js';

function schema(raw: unknown): LlmOutputSchema {
  return llmOutputSchemaSchema.parse(raw);
}

describe('validateStructuredOutput', () => {
  it('accepts a payload matching a flat scalar schema and returns the normalized object', () => {
    const s = schema({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
    });
    const r = validateStructuredOutput(s, { name: 'Ada', age: 36 });
    expect(r).toEqual({ ok: true, value: { name: 'Ada', age: 36 } });
  });

  it('strips unknown keys, storing only declared fields', () => {
    const s = schema({ type: 'object', properties: { name: { type: 'string' } } });
    const r = validateStructuredOutput(s, { name: 'Ada', secret: 'leak', extra: 1 });
    expect(r).toEqual({ ok: true, value: { name: 'Ada' } });
  });

  it('does NOT coerce: a numeric string for a number field fails', () => {
    const s = schema({ type: 'object', properties: { age: { type: 'integer' } } });
    const r = validateStructuredOutput(s, { age: '36' });
    expect(r.ok).toBe(false);
  });

  it('fails on a missing declared field (every declared field is required at runtime)', () => {
    const s = schema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    });
    const r = validateStructuredOutput(s, { a: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('b');
  });

  it('fails a field of the wrong type', () => {
    const s = schema({ type: 'object', properties: { flag: { type: 'boolean' } } });
    expect(validateStructuredOutput(s, { flag: 'yes' }).ok).toBe(false);
  });

  it('enforces enum membership (#592): an out-of-set value fails', () => {
    const s = schema({
      type: 'object',
      properties: { category: { type: 'string', enum: ['bug', 'feature'] } },
    });
    expect(validateStructuredOutput(s, { category: 'bug' })).toEqual({
      ok: true,
      value: { category: 'bug' },
    });
    const bad = validateStructuredOutput(s, { category: 'question' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('enum');
  });

  it('accepts nested object/array (opaque json) without inspecting inner shape', () => {
    const s = schema({
      type: 'object',
      properties: {
        meta: { type: 'object' },
        tags: { type: 'array' },
      },
    });
    const r = validateStructuredOutput(s, { meta: { any: 'thing' }, tags: [1, 'two', {}] });
    expect(r).toEqual({ ok: true, value: { meta: { any: 'thing' }, tags: [1, 'two', {}] } });
  });

  it('rejects a non-object payload', () => {
    const s = schema({ type: 'object', properties: { a: { type: 'string' } } });
    expect(validateStructuredOutput(s, 'not an object').ok).toBe(false);
    expect(validateStructuredOutput(s, null).ok).toBe(false);
    expect(validateStructuredOutput(s, [1, 2]).ok).toBe(false);
  });

  // DRIFT GUARD: a value this validator accepts must survive the reducer's
  // `validateOutputs` against the LOWERED contract for every declared type.
  it('an accepted object survives validateOutputs against the lowered contract', () => {
    const s = schema({
      type: 'object',
      properties: {
        str: { type: 'string' },
        int: { type: 'integer' },
        num: { type: 'number' },
        bool: { type: 'boolean' },
        obj: { type: 'object' },
        arr: { type: 'array' },
      },
    });
    const payload = { str: 'x', int: 3, num: 1.5, bool: true, obj: { k: 1 }, arr: [1] };
    const validated = validateStructuredOutput(s, payload);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const { errs } = validateOutputs(
      { kind: 'declared', outputs: lowerOutputSchema(s) },
      validated.value,
    );
    expect(errs).toEqual([]);
  });
});

describe('parseAndValidateStructured', () => {
  const s = schema({ type: 'object', properties: { name: { type: 'string' } } });

  it('parses a JSON string completion and validates it', () => {
    expect(parseAndValidateStructured(s, JSON.stringify({ name: 'Ada' }))).toEqual({
      ok: true,
      value: { name: 'Ada' },
    });
  });

  it('fails a non-string completion', () => {
    const r = parseAndValidateStructured(s, { name: 'Ada' });
    expect(r.ok).toBe(false);
  });

  it('fails an unparseable JSON completion', () => {
    const r = parseAndValidateStructured(s, '{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('valid JSON');
  });
});

describe('structuredOutputInstruction', () => {
  it('mentions JSON (OpenAI json_object mode requires the token) and embeds the schema', () => {
    const s = schema({ type: 'object', properties: { name: { type: 'string' } } });
    const instr = structuredOutputInstruction(s);
    expect(instr).toContain('JSON');
    expect(instr).toContain('"name"');
  });
});

// #594 — an author's OPTIONAL field (a property NOT named in an EXPLICIT
// `required` list) whose model legitimately omits it must yield a PRESENT-`null`
// output, NOT a `permanent` node failure. An ABSENT `required` list keeps the
// L4b floor (all-present) — optionality is opt-in via a partial `required` list.
describe('validateStructuredOutput — optional fields (#594)', () => {
  it('an omitted optional field → present-null (the key is always carried)', () => {
    const s = schema({
      type: 'object',
      properties: { category: { type: 'string' }, reason: { type: 'string' } },
      required: ['category'],
    });
    // Model returned only the required field; `reason` is optional and omitted.
    expect(validateStructuredOutput(s, { category: 'bug' })).toEqual({
      ok: true,
      value: { category: 'bug', reason: null },
    });
  });

  it('an explicit null for an optional field is accepted (present-null)', () => {
    const s = schema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    });
    expect(validateStructuredOutput(s, { a: 'x', b: null })).toEqual({
      ok: true,
      value: { a: 'x', b: null },
    });
  });

  it('an optional field PRESENT with a value still validates its type', () => {
    const s = schema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    });
    expect(validateStructuredOutput(s, { a: 'x', b: 3 })).toEqual({
      ok: true,
      value: { a: 'x', b: 3 },
    });
    // A present, wrongly-typed optional value is STILL a failure — optional
    // means "may be absent", not "any type".
    expect(validateStructuredOutput(s, { a: 'x', b: 'nope' }).ok).toBe(false);
  });

  it('an optional ENUM field: present must be a member, absent → present-null', () => {
    const s = schema({
      type: 'object',
      properties: {
        a: { type: 'string' },
        sev: { type: 'string', enum: ['low', 'high'] },
      },
      required: ['a'],
    });
    expect(validateStructuredOutput(s, { a: 'x' })).toEqual({
      ok: true,
      value: { a: 'x', sev: null },
    });
    expect(validateStructuredOutput(s, { a: 'x', sev: 'high' }).ok).toBe(true);
    expect(validateStructuredOutput(s, { a: 'x', sev: 'bogus' }).ok).toBe(false);
  });

  it('a REQUIRED field is still mandatory (an explicit required list is honoured)', () => {
    const s = schema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
    });
    const r = validateStructuredOutput(s, { a: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('b');
  });

  // DRIFT GUARD (#594): a present-null this validator emits for an optional
  // field must survive the reducer's `validateOutputs` against the lowered
  // contract. This MUST use a SCALAR optional — `matchesType(null,'json')` is
  // already true, so an optional `object`/`array` would false-pass and hide a
  // missing null short-circuit in `validateOutputs`; a `string`/`number`/
  // `boolean` null is where the short-circuit is load-bearing.
  it('an omitted optional SCALAR survives validateOutputs against the lowered contract', () => {
    const s = schema({
      type: 'object',
      properties: {
        keep: { type: 'string' },
        s: { type: 'string' },
        n: { type: 'number' },
        b: { type: 'boolean' },
      },
      required: ['keep'],
    });
    const validated = validateStructuredOutput(s, { keep: 'x' });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value).toEqual({ keep: 'x', s: null, n: null, b: null });
    const { errs } = validateOutputs(
      { kind: 'declared', outputs: lowerOutputSchema(s) },
      validated.value,
    );
    expect(errs).toEqual([]);
  });
});
