import { describe, expect, it } from 'vitest';
import {
  CopyMappingError,
  newCopyCounters,
  pumpCopyRows,
  type CopyCounters,
  type CopyPumpMappingEntry,
} from './pump.js';
import type { CoercedValue } from './coerce.js';

/**
 * #996 M5 slice 3 (#1129) — the copy PUMP.
 *
 * Two properties carry this suite, and they are the two the spec argues about
 * hardest. First, §6.2's "no third outcome": a mapped value either lands or the
 * ROW fails with a named code, and nothing in between is reachable. Second, the
 * split between a per-row failure and a copy-wide REFUSAL — a mapping that
 * names a column the source does not have is not a million failed rows, it is a
 * misconfiguration, and reporting it as the former is how a copy "succeeds"
 * having written nothing.
 */

async function* batchesOf(
  ...batches: Record<string, unknown>[][]
): AsyncIterable<readonly Record<string, unknown>[]> {
  for (const batch of batches) yield batch;
}

async function collect(
  gen: AsyncIterable<readonly Record<string, CoercedValue>[]>,
): Promise<Record<string, CoercedValue>[][]> {
  const out: Record<string, CoercedValue>[][] = [];
  for await (const batch of gen) out.push(batch.map((r) => ({ ...r })));
  return out;
}

/** A mapping entry with the two fields every test sets and the rest defaulted. */
const map = (
  entry: Partial<CopyPumpMappingEntry> & Pick<CopyPumpMappingEntry, 'sink'>,
): CopyPumpMappingEntry => ({ type: 'string', onError: 'fail', ...entry });

function run(
  source: AsyncIterable<readonly Record<string, unknown>[]>,
  mapping: CopyPumpMappingEntry[],
  extra: { counters?: CopyCounters; onBatch?: () => void } = {},
): { counters: CopyCounters; batches: Promise<Record<string, CoercedValue>[][]> } {
  const counters = extra.counters ?? newCopyCounters();
  return {
    counters,
    batches: collect(pumpCopyRows(source, { mapping, counters, onBatch: extra.onBatch })),
  };
}

const failed = async (p: Promise<unknown>): Promise<CopyMappingError> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CopyMappingError);
  return err as CopyMappingError;
};

describe('the straight copy', () => {
  it('maps every row of every batch, renaming columns, and counts what it read', async () => {
    const { counters, batches } = run(
      batchesOf(
        [
          { id: 1n, name: 'a' },
          { id: 2n, name: 'b' },
        ],
        [{ id: 3n, name: 'c' }],
      ),
      [
        map({ source: 'id', sink: 'ident', type: 'integer' }),
        map({ source: 'name', sink: 'label' }),
      ],
    );

    expect(await batches).toEqual([
      [
        { ident: 1n, label: 'a' },
        { ident: 2n, label: 'b' },
      ],
      [{ ident: 3n, label: 'c' }],
    ]);
    expect(counters.rowsRead).toBe(3);
    expect(counters.rowsFailed).toBe(0);
    expect(counters.failuresByCode).toEqual({});
    expect(counters.firstFailure).toBeUndefined();
    // `rowsWritten` belongs to the SINK half and the pump must never guess it.
    expect(counters.rowsWritten).toBe(0);
  });

  it('copies only the mapped columns, and a source column named by nothing is dropped', async () => {
    const { batches } = run(batchesOf([{ id: 1n, secret: 'x' }]), [
      map({ source: 'id', sink: 'id', type: 'integer' }),
    ]);
    expect(await batches).toEqual([[{ id: 1n }]]);
  });

  it('reports `truncated: false` — no v1 copy source can truncate (§5)', async () => {
    const { counters, batches } = run(batchesOf([{ a: '1' }]), [map({ source: 'a', sink: 'a' })]);
    await batches;
    expect(counters.truncated).toBe(false);
  });

  it('yields nothing at all for an empty source, and refuses nothing either', async () => {
    const { counters, batches } = run(batchesOf(), [map({ source: 'nosuch', sink: 'a' })]);
    expect(await batches).toEqual([]);
    expect(counters.rowsRead).toBe(0);
  });
});

describe('a per-row failure', () => {
  it('drops ONLY the offending row and keeps copying (`onError: fail`)', async () => {
    const { counters, batches } = run(batchesOf([{ n: '1' }, { n: '1.5' }, { n: '3' }]), [
      map({ source: 'n', sink: 'n', type: 'integer' }),
    ]);

    expect(await batches).toEqual([[{ n: 1n }, { n: 3n }]]);
    expect(counters.rowsRead).toBe(3);
    expect(counters.rowsFailed).toBe(1);
    expect(counters.failuresByCode).toEqual({ not_integral: 1 });
    expect(counters.firstFailure).toEqual({
      rowIndex: 1,
      sink: 'n',
      code: 'not_integral',
      reason: expect.any(String),
    });
  });

  it('writes null instead of failing the row when the column opts out (`onError: null`)', async () => {
    const { counters, batches } = run(batchesOf([{ n: '1.5' }]), [
      map({ source: 'n', sink: 'n', type: 'integer', onError: 'null' }),
    ]);

    expect(await batches).toEqual([[{ n: null }]]);
    expect(counters.rowsFailed).toBe(0);
    expect(counters.failuresByCode).toEqual({});
  });

  /**
   * #1155 A3 — an out-of-range value is an ordinary row failure, so the
   * existing opt-out applies to it unchanged. Before the bound this row could
   * not opt out of anything: the value reached the binder and took the copy
   * down.
   */
  it('writes null for an OUT-OF-RANGE integer when the column opts out', async () => {
    const { counters, batches } = run(batchesOf([{ n: '9223372036854775808' }, { n: '7' }]), [
      map({ source: 'n', sink: 'n', type: 'integer', onError: 'null' }),
    ]);

    expect(await batches).toEqual([[{ n: null }, { n: 7n }]]);
    expect(counters.rowsFailed).toBe(0);
    expect(counters.failuresByCode).toEqual({});
  });

  it('counts an out-of-range row under its own code, distinct from a rounding refusal', async () => {
    const { counters, batches } = run(batchesOf([{ n: '9223372036854775808' }, { n: '1.5' }]), [
      map({ source: 'n', sink: 'n', type: 'integer', onError: 'fail' }),
    ]);

    // A batch whose rows ALL failed yields nothing at all, not an empty batch.
    expect(await batches).toEqual([]);
    expect(counters.rowsFailed).toBe(2);
    // The whole point of a bounded code: two unrelated defects tally apart.
    expect(counters.failuresByCode).toEqual({ integer_out_of_range: 1, not_integral: 1 });
  });

  it('fails the row ONCE even when several of its columns fail', async () => {
    const { counters, batches } = run(batchesOf([{ a: 'x', b: 'y' }]), [
      map({ source: 'a', sink: 'a', type: 'integer' }),
      map({ source: 'b', sink: 'b', type: 'integer' }),
    ]);

    expect(await batches).toEqual([]);
    expect(counters.rowsFailed).toBe(1);
    // The FIRST failing column decides the recorded code; the row stops there.
    expect(counters.failuresByCode).toEqual({ not_a_number: 1 });
  });

  it('aggregates failures BY CODE across batches, which is what the bounded code is for', async () => {
    const { counters, batches } = run(batchesOf([{ n: '1.5' }, { n: 'nope' }], [{ n: '2.5' }]), [
      map({ source: 'n', sink: 'n', type: 'integer' }),
    ]);
    await batches;
    expect(counters.failuresByCode).toEqual({ not_integral: 2, not_a_number: 1 });
    expect(counters.rowsFailed).toBe(3);
  });

  it('fails a BLOB row rather than stringifying it — no declared type can hold one (#1131)', async () => {
    const { counters, batches } = run(batchesOf([{ b: new Uint8Array([1, 2, 3]) }]), [
      map({ source: 'b', sink: 'b', type: 'string' }),
    ]);

    expect(await batches).toEqual([]);
    expect(counters.rowsFailed).toBe(1);
    expect(counters.failuresByCode).toEqual({ unsupported_source_type: 1 });
  });

  it('fails only the RAGGED row when a later row is missing a key the first row had', async () => {
    const { counters, batches } = run(batchesOf([{ a: '1' }, {}, { a: '3' }]), [
      map({ source: 'a', sink: 'a' }),
    ]);

    expect(await batches).toEqual([[{ a: '1' }, { a: '3' }]]);
    expect(counters.failuresByCode).toEqual({ absent_value: 1 });
  });
});

describe('the copy-wide refusal — a broken mapping is not a million failed rows', () => {
  it('refuses an empty mapping rather than yielding key-less rows at the sink', async () => {
    const err = await failed(run(batchesOf([{ a: '1' }]), []).batches);
    expect(err.code).toBe('empty_mapping');
  });

  it('refuses two mappings writing the SAME sink column — last-writer-wins is data loss', async () => {
    const { counters, batches } = run(batchesOf([{ a: 'A', b: 'B' }]), [
      map({ source: 'a', sink: 'id' }),
      map({ source: 'b', sink: 'id' }),
    ]);
    const err = await failed(batches);
    expect(err.code).toBe('duplicate_sink_column');
    expect(err.message).toContain('id');
    expect(counters.rowsRead).toBe(0);
  });

  it('refuses a duplicate sink even against an EMPTY source — it is a mapping fact', async () => {
    const err = await failed(
      run(batchesOf(), [map({ source: 'a', sink: 'id' }), map({ source: 'b', sink: 'id' })])
        .batches,
    );
    expect(err.code).toBe('duplicate_sink_column');
  });

  it('refuses a source column the rows do not have, BEFORE a row moves', async () => {
    const { counters, batches } = run(batchesOf([{ a: '1' }]), [
      map({ source: 'nosuch', sink: 'x' }),
    ]);
    const err = await failed(batches);
    expect(err.code).toBe('missing_source_column');
    expect(err.message).toContain('nosuch');
    expect(counters.rowsRead).toBe(0);
    expect(counters.rowsFailed).toBe(0);
  });

  it('names EVERY missing column, not just the first', async () => {
    const err = await failed(
      run(batchesOf([{ a: '1' }]), [
        map({ source: 'nope1', sink: 'x' }),
        map({ source: 'nope2', sink: 'y' }),
      ]).batches,
    );
    expect(err.message).toContain('nope1');
    expect(err.message).toContain('nope2');
  });

  it('nulls a missing column for every row when that column opted out', async () => {
    const { counters, batches } = run(batchesOf([{ a: '1' }, { a: '2' }]), [
      map({ source: 'a', sink: 'a' }),
      map({ source: 'nosuch', sink: 'x', onError: 'null' }),
    ]);

    expect(await batches).toEqual([
      [
        { a: '1', x: null },
        { a: '2', x: null },
      ],
    ]);
    expect(counters.rowsFailed).toBe(0);
  });

  it('refuses an AMBIGUOUS case-insensitive match rather than picking one', async () => {
    const err = await failed(
      run(batchesOf([{ Name: 'a', name: 'b' }]), [map({ source: 'NAME', sink: 'n' })]).batches,
    );
    expect(err.code).toBe('ambiguous_source_column');
    expect(err.message).toContain('NAME');
  });

  it('refuses ambiguity even where the column opted out — `null` covers values, not mappings', async () => {
    const err = await failed(
      run(batchesOf([{ Name: 'a', name: 'b' }]), [
        map({ source: 'NAME', sink: 'n', onError: 'null' }),
      ]).batches,
    );
    expect(err.code).toBe('ambiguous_source_column');
  });
});

describe('source column identity', () => {
  it('prefers an EXACT match over a case-insensitive one', async () => {
    const { batches } = run(batchesOf([{ name: 'exact', NAME: 'other' }]), [
      map({ source: 'name', sink: 'n' }),
    ]);
    expect(await batches).toEqual([[{ n: 'exact' }]]);
  });

  it('matches case-insensitively when there is exactly one candidate', async () => {
    const { batches } = run(batchesOf([{ Name: 'ci' }]), [map({ source: 'nAmE', sink: 'n' })]);
    expect(await batches).toEqual([[{ n: 'ci' }]]);
  });

  it("folds ASCII only, as SQLite's NOCASE does — U+212A is not a `k`", async () => {
    // `'\u212A'.toLowerCase()` is `'k'` in JavaScript, and SQLite would never
    // fold it. A mapping naming `temp_k` must therefore NOT bind a column
    // spelled with the KELVIN SIGN.
    const { counters, batches } = run(batchesOf([{ 'TEMP_\u212A': 12 }]), [
      map({ source: 'temp_k', sink: 't', type: 'number', onError: 'null' }),
    ]);
    expect(await batches).toEqual([[{ t: null }]]);
    expect(counters.rowsFailed).toBe(0);
  });
});

describe('the `expression` arm — a constant per DISPATCH, not per row (§8)', () => {
  it('applies the substituted constant to every row, coerced to the declared type', async () => {
    const { counters, batches } = run(batchesOf([{ a: '1' }, { a: '2' }]), [
      map({ source: 'a', sink: 'a' }),
      map({ expression: '7', sink: 'tag', type: 'integer' }),
    ]);

    expect(await batches).toEqual([
      [
        { a: '1', tag: 7n },
        { a: '2', tag: 7n },
      ],
    ]);
    expect(counters.rowsFailed).toBe(0);
  });

  it('accepts a NON-string constant, because substitution preserves native type', async () => {
    const { batches } = run(batchesOf([{ a: '1' }]), [
      map({ expression: 42, sink: 'n', type: 'integer' }),
      map({ expression: true, sink: 'b', type: 'boolean' }),
    ]);
    expect(await batches).toEqual([[{ n: 42n, b: true }]]);
  });

  /**
   * #1155 A2 — the constant arm of the int64 bound, DECIDED rather than
   * discovered. An out-of-range constant is a MAPPING fault, not a row fault:
   * it is invariant across rows, so failing every row identically would be the
   * copy-wide refusal written out one row at a time. This is the same split
   * §6.2 draws, and it is a strict improvement on the pre-#1155 behaviour,
   * where the value reached the binder and killed the copy with a RangeError
   * naming neither column nor row.
   */
  it('refuses an OUT-OF-RANGE constant copy-wide, naming the column', async () => {
    const err = await run(batchesOf([{ a: '1' }]), [
      map({ expression: 1e20, sink: 'big', type: 'integer' }),
    ])
      .batches.then(
        () => undefined,
        (e: unknown) => e,
      )
      .then((e) => e as CopyMappingError);

    expect(err).toBeInstanceOf(CopyMappingError);
    expect(err.code).toBe('uncoercible_constant');
    expect(err.message).toContain('big');
  });

  it('refuses an uncoercible constant copy-wide rather than failing every row identically', async () => {
    const err = await run(batchesOf([{ a: '1' }]), [
      map({ expression: 'not-a-number', sink: 'n', type: 'integer' }),
    ])
      .batches.then(
        () => undefined,
        (e: unknown) => e,
      )
      .then((e) => e as CopyMappingError);

    expect(err).toBeInstanceOf(CopyMappingError);
    expect(err.code).toBe('uncoercible_constant');
    expect(err.message).toContain('n');
  });

  it('names EVERY uncoercible constant, not just the first', async () => {
    const err = await run(batchesOf([{ a: '1' }]), [
      map({ expression: 'nope', sink: 'x', type: 'integer' }),
      map({ expression: 'also-nope', sink: 'y', type: 'number' }),
    ])
      .batches.then(
        () => undefined,
        (e: unknown) => e as CopyMappingError,
      )
      .then((e) => e as CopyMappingError);

    expect(err.code).toBe('uncoercible_constant');
    expect(err.message).toContain('x');
    expect(err.message).toContain('y');
  });

  it('nulls an uncoercible constant that opted out, without refusing the copy', async () => {
    const { batches } = run(batchesOf([{ a: '1' }]), [
      map({ expression: 'not-a-number', sink: 'n', type: 'integer', onError: 'null' }),
    ]);
    expect(await batches).toEqual([[{ n: null }]]);
  });
});

describe('bytesRead', () => {
  it('measures every value of the source row, including columns nothing maps', async () => {
    const { counters, batches } = run(
      batchesOf([{ s: 'abc', blob: new Uint8Array(5), n: 1.5, big: 9n, b: true, nil: null }]),
      [map({ source: 's', sink: 's' })],
    );
    await batches;
    // 3 (utf8) + 5 (bytes) + 8 (number) + 8 (bigint) + 1 (boolean) + 0 (null)
    expect(counters.bytesRead).toBe(25);
  });

  it('charges a multi-byte character its UTF-8 length, not its UTF-16 length', async () => {
    const { counters, batches } = run(batchesOf([{ s: 'é😀' }]), [map({ source: 's', sink: 's' })]);
    await batches;
    expect(counters.bytesRead).toBe(6); // é = 2, 😀 = 4
  });

  it('counts a FAILED row too — it was read before it was rejected', async () => {
    const { counters, batches } = run(batchesOf([{ n: 'nope' }]), [
      map({ source: 'n', sink: 'n', type: 'integer' }),
    ]);
    await batches;
    expect(counters.rowsFailed).toBe(1);
    expect(counters.bytesRead).toBe(4);
  });
});

describe('progress and partials', () => {
  it('ticks ONCE per source batch, AFTER the consumer has taken that batch', async () => {
    const order: string[] = [];
    const counters = newCopyCounters();
    const gen = pumpCopyRows(batchesOf([{ a: '1' }], [{ a: '2' }]), {
      mapping: [map({ source: 'a', sink: 'a' })],
      counters,
      onBatch: () => order.push(`tick:${counters.rowsRead}`),
    });

    for await (const batch of gen) order.push(`consume:${batch.length}`);

    expect(order).toEqual(['consume:1', 'tick:1', 'consume:1', 'tick:2']);
  });

  it('still ticks for a batch whose rows ALL failed — a working copy must not look hung', async () => {
    let ticks = 0;
    const { counters, batches } = run(
      batchesOf([{ n: 'x' }, { n: 'y' }], [{ n: '3' }]),
      [map({ source: 'n', sink: 'n', type: 'integer' })],
      { onBatch: () => (ticks += 1) },
    );

    expect(await batches).toEqual([[{ n: 3n }]]);
    expect(ticks).toBe(2);
    expect(counters.rowsFailed).toBe(2);
  });

  it('leaves the counters readable after the SOURCE throws mid-stream', async () => {
    async function* explodes(): AsyncIterable<readonly Record<string, unknown>[]> {
      yield [{ a: '1' }, { a: '2' }];
      throw new Error('source died');
    }
    const counters = newCopyCounters();
    await expect(
      collect(pumpCopyRows(explodes(), { mapping: [map({ source: 'a', sink: 'a' })], counters })),
    ).rejects.toThrow('source died');

    expect(counters.rowsRead).toBe(2);
    expect(counters.bytesRead).toBe(2);
  });
});
