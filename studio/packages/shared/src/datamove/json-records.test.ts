import { describe, expect, it } from 'vitest';
import { JsonRecordsError, parseJsonRecords, type JsonRecordsOptions } from './json-records.js';

async function* one(text: string): AsyncGenerator<string> {
  yield text;
}

/** One character per chunk: every boundary a record, string or escape can be split on. */
async function* chars(text: string): AsyncGenerator<string> {
  for (const c of text) yield c;
}

async function collect(
  text: string,
  opts: Partial<JsonRecordsOptions> = {},
  feed: (t: string) => AsyncGenerator<string> = one,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const batch of parseJsonRecords(feed(text), {
    layout: 'array',
    batchRows: 100,
    maxRecordChars: 1000,
    ...opts,
  })) {
    out.push(...batch);
  }
  return out;
}

async function refusal(
  text: string,
  opts: Partial<JsonRecordsOptions> = {},
): Promise<JsonRecordsError> {
  const err = await collect(text, opts).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(JsonRecordsError);
  return err as JsonRecordsError;
}

const ARRAY = ` [ {"a":1,"b":"x, ]}"} ,{"a":2,"b":"say \\"hi\\" \\\\"},
  {"a":null,"b":{"n":[1,{"m":"]"}]}}, 7, "s", true, null, [1,2] ]\n`;
const ARRAY_VALUES = [
  { a: 1, b: 'x, ]}' },
  { a: 2, b: 'say "hi" \\' },
  { a: null, b: { n: [1, { m: ']' }] } },
  7,
  's',
  true,
  null,
  [1, 2],
];

describe('parseJsonRecords — array layout', () => {
  it('yields each element of the top-level array, whole and one character at a time', async () => {
    expect(await collect(ARRAY)).toEqual(ARRAY_VALUES);
    expect(await collect(ARRAY, {}, chars)).toEqual(ARRAY_VALUES);
  });

  it('yields nothing for an empty array', async () => {
    expect(await collect('[]')).toEqual([]);
    expect(await collect(' [ \n ] \n')).toEqual([]);
  });

  it('batches by batchRows', async () => {
    const sizes: number[] = [];
    for await (const batch of parseJsonRecords(one('[1,2,3,4,5]'), {
      layout: 'array',
      batchRows: 2,
      maxRecordChars: 100,
    })) {
      sizes.push(batch.length);
    }
    expect(sizes).toEqual([2, 2, 1]);
  });

  it('refuses a document that is not an array', async () => {
    expect((await refusal('{"a":1}')).code).toBe('not_an_array');
    expect((await refusal('')).code).toBe('not_an_array');
  });

  it('refuses a missing or trailing comma, an unclosed array and content after it', async () => {
    expect((await refusal('[1 2]')).code).toBe('invalid_json');
    expect((await refusal('[1,]')).code).toBe('invalid_json');
    expect((await refusal('[,1]')).code).toBe('invalid_json');
    expect((await refusal('[1,2')).code).toBe('invalid_json');
    expect((await refusal('[{"a":1}')).code).toBe('invalid_json');
    expect((await refusal('[1] x')).code).toBe('trailing_content');
  });

  it('refuses an element that is not JSON, naming its position and never its text', async () => {
    const err = await refusal('[{"a":1},{"a":secret}]');
    expect(err.code).toBe('invalid_json');
    expect(err.message).toContain('element 2');
    expect(err.message).not.toContain('secret');
  });

  it('bounds one element, so an unclosed string cannot swallow the file', async () => {
    const err = await refusal(`[{"a":"${'x'.repeat(50)}`, { maxRecordChars: 20 });
    expect(err.code).toBe('record_too_long');
  });
});

describe('parseJsonRecords — lines layout', () => {
  const LINES = '{"a":1}\r\n\n  \n{"a":"two\\nlines"}\n[1]\n{"a":3}';

  it('yields one value per line, skips blank lines, and takes a last line with no end', async () => {
    const expected = [{ a: 1 }, { a: 'two\nlines' }, [1], { a: 3 }];
    expect(await collect(LINES, { layout: 'lines' })).toEqual(expected);
    expect(await collect(LINES, { layout: 'lines' }, chars)).toEqual(expected);
  });

  it('refuses a line that is not JSON, naming the line', async () => {
    const err = await refusal('{"a":1}\n{"a":\n', { layout: 'lines' });
    expect(err.code).toBe('invalid_json');
    expect(err.message).toContain('line 2');
  });

  it('bounds one line', async () => {
    const err = await refusal(`{"a":"${'x'.repeat(50)}"}\n`, {
      layout: 'lines',
      maxRecordChars: 20,
    });
    expect(err.code).toBe('record_too_long');
  });
});

it('refuses a batch size that is not a positive integer', async () => {
  expect((await refusal('[1]', { batchRows: 0 })).code).toBe('invalid_batch_rows');
});
