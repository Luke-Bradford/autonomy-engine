import { describe, expect, it } from 'vitest';
import { LOOKUP_ACTIVITY_TYPE, WARNING_CODES } from '@autonomy-studio/shared';
import { LOOKUP_BYTE_CAP, LOOKUP_ROW_CAP } from '../../limits.js';
import { runLookupActivity } from '../lookup.js';
import { DatasetIoError } from '../dataset-io-error.js';
import type { SourceIo } from '../source-io.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

/**
 * #996 M12 slice 2 (#1221) — the `lookup` ACTIVITY.
 *
 * Driven through a fake {@link SourceIo} rather than a real store, deliberately:
 * every property this slice settles — §5's two caps, the truncate-and-mark
 * contract, and the value normalisation that keeps a materialised row
 * persistable — is a property of THIS layer and of no store in particular.
 * `lookup-store.test.ts` covers both the real reader and the one claim a unit
 * test structurally cannot make: that the outputs survive the durable log.
 */

function sourceIo(
  batches: readonly (readonly Record<string, unknown>[])[],
  over: Partial<SourceIo> = {},
): SourceIo {
  return {
    async *readBatches() {
      for (const batch of batches) yield batch;
    },
    sourceCoercion: () => ({}),
    ...over,
  };
}

function lookupCtx(over: { datasets?: unknown; signal?: AbortSignal } = {}): ActivityContext {
  return {
    runId: 'run-1',
    nodeId: 'n1',
    attemptId: 'a1',
    activityType: LOOKUP_ACTIVITY_TYPE,
    input: {},
    connectionConfig: {},
    ...(over.datasets === null
      ? {}
      : {
          datasets: over.datasets ?? {
            source: { id: 'ds-1', name: 'src', kind: 'table', config: { table: 't' }, columns: [] },
          },
        }),
    signal: over.signal ?? new AbortController().signal,
  } as unknown as ActivityContext;
}

async function run(ctx: ActivityContext, io: SourceIo): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for await (const event of runLookupActivity(ctx, io)) events.push(event);
  return events;
}

const terminal = (events: ActivityEvent[]): ActivityEvent =>
  events[events.length - 1] as ActivityEvent;

const outputsOf = (events: ActivityEvent[]): Record<string, unknown> => {
  const end = terminal(events);
  expect(end.type).toBe('succeeded');
  return end.type === 'succeeded' ? end.outputs : {};
};

const warnings = (events: ActivityEvent[]) => events.filter((e) => e.type === 'warned');

/** The single value a one-column, one-row lookup materialises. */
async function valueOf(raw: unknown, io: Partial<SourceIo> = {}): Promise<unknown> {
  const events = await run(lookupCtx(), sourceIo([[{ c: raw }]], io));
  const rows = outputsOf(events).rows as Record<string, unknown>[];
  return rows[0]?.c;
}

describe('the happy path contract', () => {
  it('yields ONE terminal carrying exactly the four declared outputs', async () => {
    const events = await run(
      lookupCtx(),
      sourceIo([[{ id: 1, name: 'a' }], [{ id: 2, name: 'b' }]]),
    );

    // Exactly one terminal: the executor folds the FIRST it sees, so a second
    // would be silently discarded state.
    expect(events.filter((e) => e.type === 'succeeded' || e.type === 'failed')).toHaveLength(1);
    expect(outputsOf(events)).toEqual({
      rows: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
      rowCount: 2,
      bytes: Buffer.byteLength('{"id":1,"name":"a"}{"id":2,"name":"b"}', 'utf8'),
      truncated: false,
    });
  });

  it('says nothing when nothing was truncated — a warning is a FACT, not a status line', async () => {
    expect(warnings(await run(lookupCtx(), sourceIo([[{ a: 1 }]])))).toEqual([]);
  });

  it('`rowCount` is ALWAYS `rows.length`, including when a cap bound', async () => {
    // Pinned because the name invites the other reading. On a truncated lookup
    // the source total is UNKNOWN — the read stopped — so this can only mean
    // "rows materialised". A consumer computing `rowCount - rows.length` as
    // "rows dropped" must get 0 forever rather than a number that looks real.
    for (const batches of [[[{ a: 1 }]], [[]], Array.from({ length: 3 }, () => [{ a: 'x' }])]) {
      const out = outputsOf(await run(lookupCtx(), sourceIo(batches)));
      expect(out.rowCount).toBe((out.rows as unknown[]).length);
    }
  });
});

describe('§5 the two caps — truncate and MARK, never fail', () => {
  it('stops at LOOKUP_ROW_CAP and names the row cap in the warning', async () => {
    const batch = Array.from({ length: LOOKUP_ROW_CAP + 50 }, (_, i) => ({ i }));
    const events = await run(lookupCtx(), sourceIo([batch]));

    const out = outputsOf(events);
    expect((out.rows as unknown[]).length).toBe(LOOKUP_ROW_CAP);
    expect(out.truncated).toBe(true);
    const warned = warnings(events);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ code: WARNING_CODES.LOOKUP_TRUNCATED });
    expect(warned[0]?.type === 'warned' ? warned[0].reason : '').toContain(`${LOOKUP_ROW_CAP}-row`);
  });

  it('stops at LOOKUP_BYTE_CAP with a PREFIX, and names the byte cap', async () => {
    // Rows of ~10 KiB each: the byte cap binds long before the row cap does.
    const wide = Array.from({ length: 400 }, () => ({ blob: 'x'.repeat(10_000) }));
    const events = await run(lookupCtx(), sourceIo([wide]));

    const out = outputsOf(events);
    const rows = out.rows as unknown[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(400);
    expect(out.truncated).toBe(true);
    expect(out.bytes as number).toBeLessThanOrEqual(LOOKUP_BYTE_CAP);
    const reason = warnings(events)[0];
    expect(reason?.type === 'warned' ? reason.reason : '').toContain(`${LOOKUP_BYTE_CAP}-byte`);
  });

  it('the cap is checked BEFORE a row is admitted, so it is never overshot', async () => {
    // The decision this pins: admit-then-stop would bound the payload at "the
    // cap plus one row", and a row is bounded by nothing. Two rows that each fit
    // alone but not together must yield ONE.
    const half = 'y'.repeat(Math.floor(LOOKUP_BYTE_CAP * 0.6));
    const out = outputsOf(await run(lookupCtx(), sourceIo([[{ v: half }, { v: half }]])));
    expect((out.rows as unknown[]).length).toBe(1);
    expect(out.truncated).toBe(true);
  });

  it('a FIRST row that alone exceeds the byte cap yields NO rows, and says so', async () => {
    const events = await run(
      lookupCtx(),
      sourceIo([[{ v: 'z'.repeat(LOOKUP_BYTE_CAP + 1) }, { v: 'small' }]]),
    );

    const out = outputsOf(events);
    expect(out.rows).toEqual([]);
    expect(out.rowCount).toBe(0);
    // The activity still SUCCEEDS — §5's "never fail" holds on this path too.
    expect(terminal(events).type).toBe('succeeded');
    const reason = warnings(events)[0];
    expect(reason?.type === 'warned' ? reason.reason : '').toContain('NO rows were');
  });

  it('TERMINATES on an unbounded source, and lets the reader clean up', async () => {
    // Two properties in one, because the second is only observable while the
    // first is at risk. A source that never ends is not hypothetical — it is
    // what a large table looks like to this loop — so the row cap has to be what
    // stops it, not the source running out.
    //
    // And stopping is a `break` out of a `for await`, which calls the
    // generator's `.return()` and runs its `finally`. That is where every store
    // reader releases its cursor and its handle (`sqlite.ts`'s reader closes the
    // cursor then the db, in that order, and says why). If this loop ever exited
    // by any means that skips it — a `return` from inside the iteration, a flag
    // checked after the loop — a TRUNCATED lookup would leak a connection on a
    // path that by definition runs whenever the cap bites.
    let cleanedUp = false;
    const endless: SourceIo = {
      sourceCoercion: () => ({}),
      async *readBatches() {
        try {
          for (;;) yield [{ a: 'x' }];
        } finally {
          cleanedUp = true;
        }
      },
    };

    const out = outputsOf(await run(lookupCtx(), endless));
    expect((out.rows as unknown[]).length).toBe(LOOKUP_ROW_CAP);
    expect(out.truncated).toBe(true);
    expect(cleanedUp).toBe(true);
  });

  it('an EMPTY source is `[]` with truncated FALSE — the pair that keeps `[]` honest', async () => {
    // The property the refuse-before-admit ordering buys, and the reason no
    // third output is needed: `[]` + false means the source is genuinely empty,
    // `[]` + true (above) means at least one row exists and none fit.
    const events = await run(lookupCtx(), sourceIo([[]]));
    const out = outputsOf(events);
    expect(out).toEqual({ rows: [], rowCount: 0, bytes: 0, truncated: false });
    expect(warnings(events)).toEqual([]);
  });
});

describe('value normalisation — a materialised row must survive the durable log', () => {
  it('renders a bigint as an EXACT decimal string, never a lossy number', async () => {
    // `sqlite.ts` opens with `defaultSafeIntegers(true)` and KEEPS a bigint
    // wherever narrowing would lose information; `Number()` here would put the
    // silent one-off corruption back at the last possible moment.
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    expect(await valueOf(big)).toBe('9007199254740993');
    // Compared against what NARROWING would have produced, not against a
    // numeric literal: `9007199254740993` written as a JS number IS
    // `…992`, so a `Number(...) !== 9007199254740993` assertion can never fail
    // and would certify nothing.
    expect(await valueOf(big)).not.toBe(String(Number(big)));
  });

  it('renders a Date as an ISO instant, so in-run and reloaded agree', async () => {
    expect(await valueOf(new Date('2026-08-22T11:22:33.000Z'))).toBe('2026-08-22T11:22:33.000Z');
  });

  it('renders bytes as base64, not as the `{"0":1}` JSON.stringify would produce', async () => {
    expect(await valueOf(new Uint8Array([1, 2, 3]))).toBe('AQID');
    expect(await valueOf(Buffer.from('hi'))).toBe('aGk=');
  });

  it('names a non-finite number rather than letting it become `null`', async () => {
    // postgres `float8` holds all three and `pg` hands back the JS values.
    // `JSON.stringify` renders each as `null`, turning a real reading into an
    // indistinguishable absence — #473's shape, and the one direction forbidden.
    expect(await valueOf(Number.NaN)).toBe('NaN');
    expect(await valueOf(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(await valueOf(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });

  it('passes a jsonb object and an array through UNCHANGED', async () => {
    // The regression this exists for: a rule refusing "any object" would fail an
    // entirely ordinary postgres schema on its first row, because
    // `pg.types.getTypeParser` returns plain objects for `json`/`jsonb` and
    // plain arrays for every array type.
    expect(await valueOf({ a: 1, b: [true, null, 'x'] })).toEqual({ a: 1, b: [true, null, 'x'] });
    expect(await valueOf([1, 2, 3])).toEqual([1, 2, 3]);
    expect(await valueOf({ nested: { d: new Date(0) } })).toEqual({
      nested: { d: '1970-01-01T00:00:00.000Z' },
    });
  });

  it('ACCEPTS a class instance that carries its data as own properties (pg `interval`)', async () => {
    // `postgres.ts` delegates every OID it does not override to
    // `pg.types.getTypeParser`, and the `interval` parser returns a
    // `PostgresInterval` — a class instance whose data is entirely own
    // enumerable properties. Measured: it stringifies to
    // `{"years":1,"months":2,…}` and round-trips as a plain object. Refusing it
    // would have failed the whole lookup on any table with an interval column.
    //
    // Shaped like the real thing rather than importing `pg-types`: the property
    // under test is "not a plain object, but carries own enumerable data", and a
    // local class states that directly.
    class PostgresInterval {
      constructor(
        readonly years: number,
        readonly months: number,
        readonly days: number,
      ) {}
    }
    expect(await valueOf(new PostgresInterval(1, 2, 3))).toEqual({ years: 1, months: 2, days: 3 });
  });

  it('normalises NEGATIVE ZERO to 0 — JSON cannot hold it, so the two must agree', async () => {
    // The third number JSON cannot represent, and the only one whose loss is
    // harmless: `JSON.stringify(-0)` is `"0"`. Normalised up front so the
    // in-memory outputs and the reloaded ones are the same value.
    expect(Object.is(await valueOf(-0), 0)).toBe(true);
    expect(Object.is(await valueOf(-0), -0)).toBe(false);
  });

  it('keeps a key literally named `__proto__` as DATA', async () => {
    const out = (await valueOf({ ['__proto__']: 'sneaky' })) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe('sneaky');
  });

  it('OMITS a key whose value is undefined, so the row does not change shape on persist', async () => {
    const out = outputsOf(await run(lookupCtx(), sourceIo([[{ a: 1, b: undefined }]])));
    const row = (out.rows as Record<string, unknown>[])[0] as Record<string, unknown>;
    // `toEqual` cannot see a present-undefined key — assert the key's ABSENCE.
    expect('b' in row).toBe(false);
    expect(row).toEqual({ a: 1 });
  });
});

describe('value normalisation — what it REFUSES, and how it reports it', () => {
  const failureOf = async (raw: unknown): Promise<string> => {
    const end = terminal(await run(lookupCtx(), sourceIo([[{ id: 1 }], [{ price: raw }]])));
    expect(end.type).toBe('failed');
    return end.type === 'failed' ? end.error : '';
  };

  it('refuses an XlsxCellFault BY NAME — it is a plain object, so shape alone would miss it', async () => {
    const error = await failureOf({ xlsxFault: 'error-cell', detail: '#N/A' });
    expect(error).toContain('unreadable');
    // The column and the ROW INDEX locate it; the VALUE never appears. `reason`
    // and `error` are prose fields no redaction pass inspects, so quoting a cell
    // would put row data into the log through the one channel that cannot scrub.
    expect(error).toContain("column 'price'");
    // Row ONE, from a fixture whose bad row is the second — so the index counts
    // rows MATERIALISED across the whole read, not within the batch that
    // happened to carry it. A batch-local index would name a row an operator
    // cannot find.
    expect(error).toContain('row 1');
    expect(error).not.toContain('#N/A');
  });

  it('classifies an unpersistable value `permanent` — retrying reads the same cell', async () => {
    const end = terminal(
      await run(lookupCtx(), sourceIo([[{ c: { xlsxFault: 'phantom-date', detail: 'x' } }]])),
    );
    expect(end.type === 'failed' ? end.kind : null).toBe('permanent');
  });

  it('refuses a class instance that carries NO own data — a rebuild would invent `{}`', async () => {
    // The refusal is about what the value CARRIES, not what constructed it. This
    // one has only a getter on its prototype, so rebuilding it from own
    // enumerable properties would produce `{}` — manufacturing an empty object
    // out of a real value, which is #1223's failure exactly.
    class Opaque {
      get amount(): number {
        return 3;
      }
    }
    expect(await failureOf(new Opaque())).toContain('Opaque');
  });

  it('refuses an object that defines its own JSON form', async () => {
    // It would serialise as something the rebuild does not produce, so what got
    // persisted would differ from what was checked.
    class Custom {
      readonly a = 1;
      toJSON(): string {
        return 'something else';
      }
    }
    expect(await failureOf(new Custom())).toContain('own JSON form');
  });

  it('refuses an invalid Date rather than rendering it as something', async () => {
    expect(await failureOf(new Date(Number.NaN))).toContain('invalid Date');
  });

  it('refuses a value nested past the depth ceiling instead of substituting a sentinel', async () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 150; i += 1) deep = { n: deep };
    expect(await failureOf(deep)).toContain('nests deeper');
  });
});

describe('§6.4 the source dataset’s declared format facts', () => {
  it('applies the NULL SENTINEL, so a lookup and a copy agree about what null is', async () => {
    // Without this a `delimited` dataset declaring `nullValue: '\\N'` would
    // materialise the literal string into durable outputs while the same dataset
    // read by a copy nulls it — the operator's declared sentinel silently doing
    // nothing.
    expect(await valueOf('\\N', { sourceCoercion: () => ({ nullValue: '\\N' }) })).toBeNull();
    expect(await valueOf('kept', { sourceCoercion: () => ({ nullValue: '\\N' }) })).toBe('kept');
  });

  it('applies the sentinel at the COLUMN value only, never inside a jsonb document', async () => {
    // It is a fact about how a FILE spells NULL in a field; matching it against a
    // string nested in a database value would apply a delimited rule to one.
    expect(
      await valueOf({ note: '\\N' }, { sourceCoercion: () => ({ nullValue: '\\N' }) }),
    ).toEqual({ note: '\\N' });
  });

  it('does NOT apply dateFormat — a lookup declares no target type to parse toward', async () => {
    expect(
      await valueOf('22/08/2026', { sourceCoercion: () => ({ dateFormat: 'dd/MM/yyyy' }) }),
    ).toBe('22/08/2026');
  });

  it('reports a source config it cannot read, rather than whatever opening the store failed with', async () => {
    const end = terminal(
      await run(
        lookupCtx(),
        sourceIo([[{ a: 1 }]], {
          sourceCoercion: () => {
            throw new Error('invalid delimited dataset config');
          },
        }),
      ),
    );
    expect(end.type === 'failed' ? end.error : '').toContain('invalid delimited dataset config');
  });
});

describe('the refusal ladder and failure classification', () => {
  it('refuses a dispatch with no source dataset', async () => {
    const end = terminal(await run(lookupCtx({ datasets: null }), sourceIo([[{ a: 1 }]])));
    expect(end.type).toBe('failed');
    expect(end.type === 'failed' ? end.error : '').toContain('requires a source dataset');
  });

  it('reports an already-aborted dispatch as CANCELLED, not as a failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const end = terminal(
      await run(lookupCtx({ signal: controller.signal }), sourceIo([[{ a: 1 }]])),
    );
    expect(end.type === 'failed' ? end.kind : null).toBe('cancelled');
  });

  it("passes a store's OWN verdict through unchanged — a transient stays transient", async () => {
    // Re-classifying here would second-guess the only code with the evidence: a
    // `SQLITE_BUSY` reported `permanent` sends an operator to fix a dataset that
    // is correct, and denies a retry that would have worked.
    const io: SourceIo = {
      sourceCoercion: () => ({}),
      // eslint-disable-next-line require-yield
      async *readBatches() {
        throw new DatasetIoError('transient', 'the store is busy', { partialWritePossible: false });
      },
    };
    const end = terminal(await run(lookupCtx(), io));
    expect(end.type === 'failed' ? end.kind : null).toBe('transient');
  });
});

describe('the round-trip property', () => {
  it('every output survives JSON.stringify -> JSON.parse IDENTICALLY', async () => {
    // The claim the whole normaliser exists to make. `run_events.payload` is
    // `text(..., { mode: 'json' })`, so drizzle JSON.stringify's these on insert
    // and JSON.parse's them on read; anything that is not a fixed point here is
    // a value that means one thing in this run and another to anything reading
    // the run back.
    const out = outputsOf(
      await run(
        lookupCtx(),
        sourceIo([
          [
            {
              n: 1.5,
              big: BigInt('9007199254740993'),
              when: new Date('2026-01-02T03:04:05.000Z'),
              blob: new Uint8Array([255, 0, 128]),
              doc: { a: [1, null, 'x'], b: { c: true } },
              nan: Number.NaN,
              negZero: -0,
              nil: null,
              s: 'héllo 😀',
            },
          ],
        ]),
      ),
    );
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});
