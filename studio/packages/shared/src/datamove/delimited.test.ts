import { describe, expect, it } from 'vitest';
import {
  DelimitedParseError,
  parseDelimitedRows,
  type DelimitedParseOptions,
} from './delimited.js';

const BASE: DelimitedParseOptions = { delimiter: ',', quote: '"', batchRows: 1000 };

/** Feed a whole document as ONE chunk — the common case, and the one where the
 * parser has no incidental await to hide behind. */
async function* one(text: string): AsyncGenerator<string> {
  yield text;
}

/** Feed a document one CHARACTER at a time — the adversarial chunking. Every
 * boundary case (a split CRLF, a split quoted field, a split escape) is covered
 * by running the same corpus through this. */
async function* chars(text: string): AsyncGenerator<string> {
  for (const c of text) yield c;
}

async function collect(
  text: string,
  opts: Partial<DelimitedParseOptions> = {},
  feed: (t: string) => AsyncGenerator<string> = one,
): Promise<string[][]> {
  const rows: string[][] = [];
  for await (const batch of parseDelimitedRows(feed(text), { ...BASE, ...opts })) {
    rows.push(...batch);
  }
  return rows;
}

/** Every case that must parse identically whole, and one character at a time. */
const CORPUS: [name: string, text: string, expected: string[][]][] = [
  [
    'plain LF rows',
    'a,b\n1,2\n',
    [
      ['a', 'b'],
      ['1', '2'],
    ],
  ],
  [
    'CRLF rows',
    'a,b\r\n1,2\r\n',
    [
      ['a', 'b'],
      ['1', '2'],
    ],
  ],
  [
    'lone CR rows',
    'a,b\r1,2\r',
    [
      ['a', 'b'],
      ['1', '2'],
    ],
  ],
  [
    'no trailing terminator',
    'a,b\n1,2',
    [
      ['a', 'b'],
      ['1', '2'],
    ],
  ],
  ['empty fields', 'a,,b\n', [['a', '', 'b']]],
  ['a wholly empty row of one field', ',\n', [['', '']]],
  ['quoted delimiter', '"a,b",c\n', [['a,b', 'c']]],
  ['quoted LF', '"a\nb",c\n', [['a\nb', 'c']]],
  ['quoted CRLF is preserved verbatim', '"a\r\nb",c\n', [['a\r\nb', 'c']]],
  ['doubled quote', '"a""b"\n', [['a"b']]],
  ['a quoted empty field', '"",x\n', [['', 'x']]],
  // A line holding ONE quoted empty field is a row of one empty string. The
  // structural "one field, empty" blank test could not tell it from a blank
  // line and silently DROPPED it — a row the file contains, gone without a word.
  ['a lone quoted empty field is a ROW, not a blank line', '"a"\n""\n"b"\n', [['a'], [''], ['b']]],
  ['…and at the very end of the document, with no terminator', '"a"\n""', [['a'], ['']]],
  ['a bare quote inside an UNQUOTED field is data', 'a"b,c\n', [['a"b', 'c']]],
  ['whitespace before a quote means the field is not quoted', ' "a",b\n', [[' "a"', 'b']]],
  ['a blank line is skipped', 'a\n\n\nb\n', [['a'], ['b']]],
  ['ragged rows are yielded VERBATIM', 'a,b,c\n1\n2,3\n', [['a', 'b', 'c'], ['1'], ['2', '3']]],
  [
    'duplicate header names are NOT deduped',
    'id,id\n1,2\n',
    [
      ['id', 'id'],
      ['1', '2'],
    ],
  ],
  ['a NUL is ordinary data', 'a\0b\n', [['a\0b']]],
  ['a lone CR at EOF terminates the row', 'a\r', [['a']]],
];

describe('the delimited parser reads the same document however it is chunked', () => {
  for (const [name, text, expected] of CORPUS) {
    it(`${name} — whole`, async () => {
      await expect(collect(text)).resolves.toEqual(expected);
    });
    it(`${name} — one character per chunk`, async () => {
      await expect(collect(text, {}, chars)).resolves.toEqual(expected);
    });
  }

  it('reads an empty document as no rows at all', async () => {
    await expect(collect('')).resolves.toEqual([]);
    // A document that is only terminators has no rows either — every line is blank.
    await expect(collect('\n\r\n\r')).resolves.toEqual([]);
  });
});

describe('the dialect keys change the grammar', () => {
  it('honours a custom delimiter', async () => {
    await expect(collect('a;b\n', { delimiter: ';' })).resolves.toEqual([['a', 'b']]);
    await expect(collect('a\tb\n', { delimiter: '\t' })).resolves.toEqual([['a', 'b']]);
    await expect(collect('a|b\n', { delimiter: '|' })).resolves.toEqual([['a', 'b']]);
    // The DEFAULT delimiter is then ordinary data.
    await expect(collect('a,b;c\n', { delimiter: ';' })).resolves.toEqual([['a,b', 'c']]);
  });

  it('honours a custom quote, and doubles it', async () => {
    await expect(collect("'a,b',c\n", { quote: "'" })).resolves.toEqual([['a,b', 'c']]);
    await expect(collect("'a''b'\n", { quote: "'" })).resolves.toEqual([["a'b"]]);
    // `"` is then ordinary data.
    await expect(collect('"a,b\n', { quote: "'" })).resolves.toEqual([['"a', 'b']]);
  });

  it('makes the character after a declared `escape` literal, INSIDE a quoted field', async () => {
    await expect(collect('"a\\"b",c\n', { escape: '\\' })).resolves.toEqual([['a"b', 'c']]);
    await expect(collect('"a\\\\b"\n', { escape: '\\' })).resolves.toEqual([['a\\b']]);
    // Doubling keeps working alongside it — the two rules never compete,
    // because the config schema refuses `escape === quote`.
    await expect(collect('"a""b"\n', { escape: '\\' })).resolves.toEqual([['a"b']]);
    // OUTSIDE a quoted field the escape character is ordinary data.
    await expect(collect('a\\,b\n', { escape: '\\' })).resolves.toEqual([['a\\', 'b']]);
  });

  it('treats an escape at the very end of the document as an unterminated field', async () => {
    await expect(collect('"a\\', { escape: '\\' })).rejects.toThrow(DelimitedParseError);
  });
});

describe('a malformed document is REFUSED, never silently repaired', () => {
  const codeOf = async (text: string, opts: Partial<DelimitedParseOptions> = {}) => {
    try {
      await collect(text, opts);
      return null;
    } catch (err) {
      return err instanceof DelimitedParseError ? err.code : `not-a-parse-error: ${String(err)}`;
    }
  };

  it('refuses a quoted field that is never closed', async () => {
    expect(await codeOf('a,"b\n')).toBe('unterminated_quote');
    expect(await codeOf('"')).toBe('unterminated_quote');
  });

  it('refuses characters after a closing quote instead of inventing a value', async () => {
    // `"a"x` could be read as `ax` — but that is a value the file does not
    // contain. The alternative interpretations disagree (Python's csv appends,
    // Postgres COPY errors), which is the tell that neither is a fact.
    expect(await codeOf('"a"x,b\n')).toBe('unexpected_character_after_quote');
    expect(await codeOf('"a" ,b\n')).toBe('unexpected_character_after_quote');
  });

  it('bounds a single field, so a file with no terminator cannot be buffered whole', async () => {
    expect(await codeOf('"' + 'x'.repeat(50), { maxFieldChars: 16 })).toBe('field_too_large');
    expect(await codeOf('x'.repeat(50), { maxFieldChars: 16 })).toBe('field_too_large');
  });

  it('bounds a single row, so many small fields cannot buffer one whole either', async () => {
    expect(await codeOf('a,'.repeat(50), { maxRowChars: 16 })).toBe('row_too_large');
  });

  it('bounds a row of EMPTY fields, which add no character to any field', async () => {
    // The bound charges every character the row consumed, not just the ones
    // that reach a field. Charging field content alone left both of these
    // unbounded: 200k entries accumulate in the row array against a cap of 100,
    // and neither a delimiter nor a quote ever calls the field accumulator.
    expect(await codeOf(','.repeat(10_000), { maxRowChars: 100 })).toBe('row_too_large');
    expect(await codeOf('""' + ',""'.repeat(10_000), { maxRowChars: 100 })).toBe('row_too_large');
    // And it is the ROW that is bounded, so a generous per-field cap cannot
    // rescue it — this is the case a field-only bound got wrong.
    expect(await codeOf(','.repeat(10_000), { maxRowChars: 100, maxFieldChars: 1_000_000 })).toBe(
      'row_too_large',
    );
  });

  it('bounds each field SEPARATELY — a wide row of small fields is not one big field', async () => {
    // The field counter must reset at every delimiter. Left running it would
    // charge the whole row to the field bound, so a perfectly ordinary 40-column
    // row would be refused as a single oversized field.
    expect(await codeOf('abcd,'.repeat(20) + '\n', { maxFieldChars: 8 })).toBe(null);
    // The row bound is what governs the row's total, and it still does.
    expect(await codeOf('abcd,'.repeat(20) + '\n', { maxFieldChars: 8, maxRowChars: 30 })).toBe(
      'row_too_large',
    );
    // And a genuinely oversized field is still caught among small ones.
    expect(await codeOf('a,b,' + 'x'.repeat(20) + ',c\n', { maxFieldChars: 8 })).toBe(
      'field_too_large',
    );
  });

  it('counts both bounds in CODE POINTS, so an astral character is charged once', async () => {
    // `field.length` would count UTF-16 units and bill '\u{1F600}' twice to the
    // field bound while the loop billed it once to the row bound.
    expect(await codeOf('\u{1F600}'.repeat(4) + '\n', { maxFieldChars: 5 })).toBe(null);
    expect(await codeOf('\u{1F600}'.repeat(6) + '\n', { maxFieldChars: 5 })).toBe(
      'field_too_large',
    );
    expect(await codeOf('\u{1F600}'.repeat(4) + '\n', { maxRowChars: 5 })).toBe(null);
    expect(await codeOf('\u{1F600}'.repeat(6) + '\n', { maxRowChars: 5 })).toBe('row_too_large');
  });

  it('names the PHYSICAL line, counting the blank ones it skipped as lines', async () => {
    // An operator finds the fault by counting lines in an editor, and blank
    // lines are lines there. Counting emitted ROWS instead drifts further from
    // the truth the further down the file the fault is.
    try {
      await collect('\n\n"ab\n');
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as DelimitedParseError).message).toMatch(/line 3\b/);
    }
    try {
      await collect('a\nb\n"c');
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as DelimitedParseError).message).toMatch(/line 3\b/);
    }
  });

  it('refuses a batch size that is not a positive integer', async () => {
    for (const batchRows of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await codeOf('a\n', { batchRows })).toBe('invalid_batch_rows');
    }
  });

  it('carries a bounded code AND a human sentence, like the coercion matrix', async () => {
    try {
      await collect('"a\n');
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(DelimitedParseError);
      expect((err as DelimitedParseError).code).toBe('unterminated_quote');
      expect((err as DelimitedParseError).message).toMatch(/quote/i);
      // The line is what makes it actionable in a million-row file.
      expect((err as DelimitedParseError).message).toMatch(/line 1\b/);
    }
  });
});

describe('batching is the scheduling quantum, so its edges are exact', () => {
  const doc = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`).join('\n') + '\n';

  const batches = async (text: string, batchRows: number): Promise<number[]> => {
    const sizes: number[] = [];
    for await (const batch of parseDelimitedRows(one(text), { ...BASE, batchRows })) {
      sizes.push(batch.length);
    }
    return sizes;
  };

  it('yields exactly `batchRows` per batch, with a short final batch', async () => {
    await expect(batches(doc(7), 3)).resolves.toEqual([3, 3, 1]);
  });

  it('does not yield a phantom empty batch when the count divides exactly', async () => {
    await expect(batches(doc(6), 3)).resolves.toEqual([3, 3]);
  });

  it('flushes a batch on a QUOTED row’s terminator too', async () => {
    // The gap a surviving mutation found: the quoted path used to carry its own
    // copy of "end the row, push it, maybe flush", and every batching test here
    // used unquoted rows — so breaking the duplicate changed nothing that was
    // measured. The two paths are now one; this is what holds them together.
    const quoted = '"a"\n"b"\n"c"\n"d"\n"e"\n';
    const sizes: number[] = [];
    for await (const batch of parseDelimitedRows(one(quoted), { ...BASE, batchRows: 2 })) {
      sizes.push(batch.length);
    }
    expect(sizes).toEqual([2, 2, 1]);
    // And a document that MIXES the two still batches by row, not by shape.
    await expect(collect('"a"\nb\n"c"\n', { batchRows: 2 })).resolves.toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
  });

  it('yields nothing at all for a document with no rows', async () => {
    await expect(batches('', 3)).resolves.toEqual([]);
    await expect(batches('\n\n', 3)).resolves.toEqual([]);
  });

  it('emits the first batch BEFORE the rest of the document is read', async () => {
    // The property §12 actually asks for: "a row stream, not `parse(wholeFile)`".
    // A parser that satisfied the signature but buffered everything would only
    // pull the second chunk after the consumer took the first batch.
    const pulled: string[] = [];
    async function* traced(): AsyncGenerator<string> {
      pulled.push('first');
      yield 'a\nb\n';
      pulled.push('second');
      yield 'c\nd\n';
    }
    const it = parseDelimitedRows(traced(), { ...BASE, batchRows: 2 });
    const first = await it.next();
    expect(first.value).toEqual([['a'], ['b']]);
    expect(pulled).toEqual(['first']);
    await it.return(undefined);
  });
});
