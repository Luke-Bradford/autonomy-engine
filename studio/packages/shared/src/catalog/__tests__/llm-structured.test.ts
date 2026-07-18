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
