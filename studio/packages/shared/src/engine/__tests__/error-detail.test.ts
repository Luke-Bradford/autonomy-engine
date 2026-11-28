/** #1567 OR36 A5 — `node.failed.detail` for a thrown error. */
import { describe, expect, it } from 'vitest';
import {
  ERROR_DETAIL_MAX_CAUSES,
  ERROR_DETAIL_MAX_FRAMES,
  errorDetail,
  trimFramePath,
} from '../error-detail.js';

describe('#1567 errorDetail', () => {
  it('records the cause chain with each code, the error first', () => {
    const root = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const err = new Error('query failed', { cause: root });
    expect(errorDetail(err)?.causes).toEqual([
      { message: 'query failed' },
      { message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' },
    ]);
  });

  it('caps the chain, stops on a cycle, and records nothing for a non-Error', () => {
    let e: Error = new Error('0');
    for (let i = 1; i < 10; i++) e = new Error(String(i), { cause: e });
    expect(errorDetail(e)?.causes).toHaveLength(ERROR_DETAIL_MAX_CAUSES);
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(errorDetail(b)?.causes.map((c) => c.message)).toEqual(['b', 'a']);
    expect(errorDetail('nope')).toBeUndefined();
  });

  it('keeps frames only, capped, with absolute paths trimmed', () => {
    const err = new Error('x');
    err.stack = [
      'Error: x',
      ...Array.from(
        { length: 30 },
        (_, i) => `    at f${i} (/Users/someone/dev/studio/packages/server/src/a.ts:${i}:1)`,
      ),
    ].join('\n');
    const stack = errorDetail(err)?.stack ?? [];
    expect(stack).toHaveLength(ERROR_DETAIL_MAX_FRAMES);
    expect(stack[0]).toBe('at f0 (packages/server/src/a.ts:0:1)');
  });

  it('trims a node_modules path and an unknown absolute path to their tail', () => {
    expect(trimFramePath('at g (/home/u/x/node_modules/pg/lib/c.js:3:4)')).toBe(
      'at g (node_modules/pg/lib/c.js:3:4)',
    );
    expect(trimFramePath('at h (file:///opt/app/dist/main.js:9:2)')).toBe('at h (main.js:9:2)');
    expect(trimFramePath('at node:internal/process:1:1')).toBe('at node:internal/process:1:1');
  });
});
