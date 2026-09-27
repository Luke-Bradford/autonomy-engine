import { describe, expect, it } from 'vitest';
import {
  GLOBAL_PARAM_MAX_BYTES,
  GlobalParamCreateBodySchema,
  GlobalParamPatchBodySchema,
  GlobalParamSchema,
  GlobalParamTypeSchema,
  GlobalParamValueSchema,
  globalParamNameDefect,
  globalParamValueDefects,
} from '../../index.js';

/**
 * #844 GL1 — the store's write rules (spec `2026-09-27-foundation-global-params.md`
 * GL-D1). Nothing READS a global yet (that is GL3); these pin what may be stored.
 */
describe('global params — the write rules (GL-D1)', () => {
  it('the type vocabulary is the param types minus `secret` (GL-D5: no secure globals)', () => {
    expect(GlobalParamTypeSchema.options).toEqual(['string', 'number', 'boolean', 'json']);
  });

  it('a value must match its declared type strictly — no coercion', () => {
    expect(globalParamValueDefects('string', 'x')).toEqual([]);
    expect(globalParamValueDefects('number', 4.5)).toEqual([]);
    expect(globalParamValueDefects('boolean', false)).toEqual([]);
    expect(globalParamValueDefects('json', { a: [1, null] })).toEqual([]);
    expect(globalParamValueDefects('json', null)).toEqual([]);
    expect(globalParamValueDefects('string', 42)).toHaveLength(1);
    expect(globalParamValueDefects('number', '42')).toHaveLength(1);
    expect(globalParamValueDefects('boolean', 'true')).toHaveLength(1);
    expect(globalParamValueDefects('string', null)).toHaveLength(1);
  });

  it('a non-finite number is refused, top-level and nested in json (it would replay as null)', () => {
    expect(globalParamValueDefects('number', Infinity)).toHaveLength(1);
    expect(globalParamValueDefects('number', NaN)).toHaveLength(1);
    expect(globalParamValueDefects('json', { big: Infinity })).not.toEqual([]);
    expect(globalParamValueDefects('json', [1, [NaN]])).not.toEqual([]);
  });

  it('a value is bounded at GLOBAL_PARAM_MAX_BYTES of serialized JSON, by UTF-8 bytes, never echoed', () => {
    // `JSON.stringify` of a string adds two quote bytes.
    const fits = 'a'.repeat(GLOBAL_PARAM_MAX_BYTES - 2);
    expect(globalParamValueDefects('string', fits)).toEqual([]);
    const over = `${fits}a`;
    const defects = globalParamValueDefects('string', over);
    expect(defects).toHaveLength(1);
    expect(defects[0]).not.toContain('aaaa');
    // A 3-byte character counts as 3, not 1.
    const wide = '€'.repeat(Math.ceil(GLOBAL_PARAM_MAX_BYTES / 3));
    expect(globalParamValueDefects('string', wide)).toHaveLength(1);
  });

  it('a name must be addressable as ${global.<name>}', () => {
    expect(globalParamNameDefect('apiUrl')).toBeNull();
    expect(globalParamNameDefect('_env2')).toBeNull();
    expect(globalParamNameDefect('api url')).not.toBeNull();
    expect(globalParamNameDefect('2env')).not.toBeNull();
    expect(globalParamNameDefect('api-url')).not.toBeNull();
    expect(globalParamNameDefect('')).not.toBeNull();
  });

  it('the create body carries each defect on its own field path', () => {
    const r = GlobalParamCreateBodySchema.safeParse({
      name: 'bad name',
      type: 'number',
      value: 'x',
    });
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join('.')).sort();
    expect(paths).toEqual(['name', 'value']);
  });

  it('the create body refuses `secret`, requires `value`, and defaults `description` to empty', () => {
    expect(
      GlobalParamCreateBodySchema.safeParse({ name: 'k', type: 'secret', value: 'x' }).success,
    ).toBe(false);
    expect(GlobalParamCreateBodySchema.safeParse({ name: 'k', type: 'string' }).success).toBe(
      false,
    );
    expect(GlobalParamCreateBodySchema.parse({ name: 'k', type: 'json', value: null })).toEqual({
      name: 'k',
      type: 'json',
      value: null,
      description: '',
    });
  });

  it('the patch body cannot carry `name` or `type` — both are immutable after creation', () => {
    expect(GlobalParamPatchBodySchema.safeParse({ value: 1 }).success).toBe(true);
    expect(GlobalParamPatchBodySchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(GlobalParamPatchBodySchema.safeParse({ type: 'string' }).success).toBe(false);
  });

  it('GlobalParamValueSchema checks a value against a GIVEN type (the patch path)', () => {
    expect(GlobalParamValueSchema.safeParse({ type: 'number', value: 3 }).success).toBe(true);
    const r = GlobalParamValueSchema.safeParse({ type: 'number', value: '3' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['value']);
  });

  it('the ROW schema decodes shape only, so a row written under older rules still reads (and deletes)', () => {
    const row = {
      id: 'gp_1',
      ownerId: 'local',
      name: 'legacy name', // not addressable under today's rule
      type: 'string',
      value: 'x'.repeat(GLOBAL_PARAM_MAX_BYTES * 2), // over today's bound
      description: '',
      createdAt: 1,
      updatedAt: 1,
    };
    expect(GlobalParamSchema.safeParse(row).success).toBe(true);
    // …but the owner is never null (GL-D1: a NULL owner defeats the unique index).
    expect(GlobalParamSchema.safeParse({ ...row, ownerId: null }).success).toBe(false);
  });
});
