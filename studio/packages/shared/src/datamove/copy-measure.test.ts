import { describe, expect, it } from 'vitest';

import { copyMeasure } from './copy-measure.js';

const none = { verified: false, result: 'none' } as const;

describe('copyMeasure (#1600 OR41 C6f-1)', () => {
  it('rounds the duration and divides the bytes read by it, per second', () => {
    expect(copyMeasure(10, 260.4, 1000, none)).toEqual({
      durationMs: 250,
      throughput: 4000,
      consistency: none,
    });
  });

  it('reports no throughput for a copy that took under half a millisecond', () => {
    expect(copyMeasure(5, 5.4, 1000, none)).toMatchObject({ durationMs: 0, throughput: null });
  });

  it('passes the consistency verdict through', () => {
    const verdict = { verified: true, result: 'skipped' } as const;
    expect(copyMeasure(0, 1, 0, verdict).consistency).toEqual(verdict);
  });
});
