import { describe, expect, it } from 'vitest';
import { percentOf } from './PipelinesGrid';

describe('percentOf (#1569)', () => {
  it('rounds, but never a failure up to 100% or a success down to 0%', () => {
    expect(percentOf(3, 1, 0.75)).toBe(75);
    expect(percentOf(249, 1, 249 / 250)).toBe(99);
    expect(percentOf(1, 249, 1 / 250)).toBe(1);
    expect(percentOf(5, 0, 1)).toBe(100);
    expect(percentOf(0, 5, 0)).toBe(0);
  });
});
