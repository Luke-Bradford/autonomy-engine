import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { addParamsReplaySafetyIssues } from './replay-safety.js';

// Drive the helper the way the two call sites do: a `superRefine` over a params
// record. `safeParse` surfaces the exact issues the helper raised.
const Schema = z.record(z.string(), z.unknown()).superRefine(addParamsReplaySafetyIssues);

describe('addParamsReplaySafetyIssues', () => {
  it('accepts finite scalars, nested containers, and `${...}` bindings', () => {
    const ok = Schema.safeParse({
      a: 1,
      b: -0,
      c: 1e308,
      d: { nested: [1, 2, { deep: 3 }] },
      e: '${trigger.body.x}',
      f: null,
      g: true,
    });
    expect(ok.success).toBe(true);
  });

  it('flags each non-finite number with its param path and never echoes the value', () => {
    const bad = Schema.safeParse({ x: Infinity, y: { z: NaN }, w: [-Infinity] });
    expect(bad.success).toBe(false);
    if (bad.success) return;
    const paths = bad.error.issues.map((i) => i.message).sort();
    expect(paths).toHaveLength(3);
    expect(paths.some((m) => m.includes('params.x'))).toBe(true);
    expect(paths.some((m) => m.includes('params.y.z'))).toBe(true);
    expect(paths.some((m) => m.includes('params.w'))).toBe(true);
    // Path-only: the numeric value is never surfaced.
    for (const m of paths) {
      expect(m).not.toMatch(/Infinity|NaN/);
    }
  });

  it('raises no issue for an empty params record', () => {
    expect(Schema.safeParse({}).success).toBe(true);
  });
});
