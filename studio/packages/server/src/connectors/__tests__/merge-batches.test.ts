import { describe, expect, it } from 'vitest';
import { mergeBatches } from '../merge-batches.js';

/** #1600 OR41 C6f-3 — the fan-in that feeds a partitioned read into one pump. */
const tick = () => new Promise((r) => setTimeout(r, 1));

function source(values: number[], log: string[], name: string, failAt?: number) {
  return (async function* () {
    try {
      for (const [i, v] of values.entries()) {
        await tick();
        if (i === failAt) throw new Error(`${name} failed`);
        yield v;
      }
    } finally {
      log.push(`${name} closed`);
    }
  })();
}

describe('mergeBatches', () => {
  it('yields every batch of every source once', async () => {
    const log: string[] = [];
    const out: number[] = [];
    for await (const v of mergeBatches(
      [source([1, 2, 3], log, 'a'), source([10, 20], log, 'b'), source([], log, 'c')],
      () => {},
    )) {
      out.push(v);
    }
    expect(out.sort((x, y) => x - y)).toEqual([1, 2, 3, 10, 20]);
    expect(log.sort()).toEqual(['a closed', 'b closed', 'c closed']);
  });

  it('on a failure, stops and closes the others, then throws the first failure', async () => {
    const log: string[] = [];
    let stopped = 0;
    const run = async () => {
      for await (const _ of mergeBatches(
        [source([1, 2, 3, 4, 5], log, 'a'), source([10, 20], log, 'b', 1)],
        () => {
          stopped += 1;
        },
      )) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow('b failed');
    expect(stopped).toBe(1);
    expect(log.sort()).toEqual(['a closed', 'b closed']);
  });

  it('when the consumer stops early, stops and closes every source before returning', async () => {
    const log: string[] = [];
    let stopped = 0;
    for await (const v of mergeBatches(
      [source([1, 2, 3], log, 'a'), source([10, 20, 30], log, 'b')],
      () => {
        stopped += 1;
      },
    )) {
      if (v > 0) break;
    }
    expect(stopped).toBe(1);
    expect(log.sort()).toEqual(['a closed', 'b closed']);
  });

  it('keeps the first failure when a stopped sibling then throws its own', async () => {
    const log: string[] = [];
    let stop = false;
    const sibling = (async function* () {
      try {
        for (;;) {
          await tick();
          if (stop) throw new Error('cancelled');
          yield 1;
        }
      } finally {
        log.push('sibling closed');
      }
    })();
    const run = async () => {
      for await (const _ of mergeBatches([sibling, source([5], log, 'b', 0)], () => {
        stop = true;
      })) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow('b failed');
    expect(log.sort()).toEqual(['b closed', 'sibling closed']);
  });
});
