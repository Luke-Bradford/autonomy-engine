import { describe, expect, it } from 'vitest';
import { CopyMappingSchema } from './copy-config.js';

/**
 * #996 M5 slice 1 (#1122) — the `copy` mapping declaration (§6.1).
 *
 * The XOR and duplicate-sink tests assert the issue PATH, not merely that
 * parsing failed: §6.1 asks for a `superRefine` with a per-element path so an
 * issue "names its row rather than the whole array", and a bare
 * `success === false` assertion passes for an array-level refine that names
 * nothing — i.e. it would certify the one property being claimed without
 * testing it. Each case puts a VALID row at index 0 so the reported index is
 * load-bearing.
 */

const validRow = { source: 'a', sink: 'a_out', type: 'string' as const };

describe('CopyMappingSchema — source XOR expression (§6.1)', () => {
  it('accepts either arm, and defaults onError to fail', () => {
    const parsed = CopyMappingSchema.parse([
      { source: 'id', sink: 'id', type: 'integer' },
      { expression: '${params.batch}', sink: 'batch', type: 'string', onError: 'null' },
    ]);
    expect(parsed[0]).toEqual({ source: 'id', sink: 'id', type: 'integer', onError: 'fail' });
    expect(parsed[1]?.onError).toBe('null');
  });

  it('refuses BOTH arms, naming the offending row', () => {
    const r = CopyMappingSchema.safeParse([
      validRow,
      { source: 'b', expression: '${x}', sink: 'b_out', type: 'string' },
    ]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual([1, 'expression']);
  });

  it('refuses NEITHER arm, naming the offending row', () => {
    const r = CopyMappingSchema.safeParse([validRow, { sink: 'b_out', type: 'string' }]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual([1, 'source']);
  });
});

describe('CopyMappingSchema — one sink column, one writer', () => {
  it('refuses two rows writing the same sink, naming the SECOND', () => {
    // Silent last-wins into the operator's store: perfectly valid SQL, and
    // nothing downstream reports it.
    const r = CopyMappingSchema.safeParse([
      validRow,
      { source: 'b', sink: 'a_out', type: 'string' },
    ]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual([1, 'sink']);
    expect(r.error?.issues[0]?.message).toContain('a_out');
  });

  it('distinct sinks from the same source column are fine', () => {
    expect(
      CopyMappingSchema.safeParse([
        { source: 'a', sink: 'x', type: 'string' },
        { source: 'a', sink: 'y', type: 'string' },
      ]).success,
    ).toBe(true);
  });
});

describe('CopyMappingSchema — the declared shape', () => {
  it('the target type is drawn from the CLOSED DataType set', () => {
    const r = CopyMappingSchema.safeParse([{ source: 'a', sink: 'a', type: 'money' }]);
    expect(r.success).toBe(false);
    // A type with no §6.2 matrix row would be a silent corruption path.
    expect(r.error?.issues[0]?.path).toEqual([0, 'type']);
  });

  it('is strict — an unknown key is refused rather than dropped', () => {
    const r = CopyMappingSchema.safeParse([{ ...validRow, transfrom: 'upper' }]);
    expect(r.success).toBe(false);
  });

  it('refuses an empty sink or source name', () => {
    expect(CopyMappingSchema.safeParse([{ source: 'a', sink: '', type: 'string' }]).success).toBe(
      false,
    );
    expect(CopyMappingSchema.safeParse([{ source: '', sink: 'a', type: 'string' }]).success).toBe(
      false,
    );
  });

  it('an empty mapping parses — it is the pump that decides what to do with one', () => {
    expect(CopyMappingSchema.parse([])).toEqual([]);
  });
});
