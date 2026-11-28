import { describe, expect, it } from 'vitest';
import { formatDelimitedField, formatDelimitedRow } from './delimited-format.js';
import { parseDelimitedRows, type DelimitedParseOptions } from './delimited.js';

const COMMA = { delimiter: ',', quote: '"' } as const;

async function* one(text: string): AsyncGenerator<string> {
  yield text;
}

/** Parse `text` with the reader's own grammar, so every case below is a round trip. */
async function parse(text: string, opts: Partial<DelimitedParseOptions> = {}): Promise<string[][]> {
  const rows: string[][] = [];
  for await (const batch of parseDelimitedRows(one(text), {
    ...COMMA,
    batchRows: 100,
    ...opts,
  })) {
    rows.push(...batch);
  }
  return rows;
}

describe('formatDelimitedField', () => {
  it('leaves a plain value unquoted', () => {
    expect(formatDelimitedField('ada', COMMA)).toBe('ada');
  });

  it('quotes a value holding the delimiter, the quote or a line break, doubling the quote', () => {
    expect(formatDelimitedField('a,b', COMMA)).toBe('"a,b"');
    expect(formatDelimitedField('say "hi"', COMMA)).toBe('"say ""hi"""');
    expect(formatDelimitedField('two\nlines', COMMA)).toBe('"two\nlines"');
    expect(formatDelimitedField('cr\rhere', COMMA)).toBe('"cr\rhere"');
  });

  it('quotes an empty string, so it never reads back as a skipped blank line', () => {
    expect(formatDelimitedField('', COMMA)).toBe('""');
  });

  it('doubles a declared escape character inside the quotes', () => {
    expect(formatDelimitedField('c:\\dir', { ...COMMA, escape: '\\' })).toBe('"c:\\\\dir"');
  });
});

describe('formatDelimitedRow', () => {
  it('joins the fields with the delimiter and ends the row with CRLF', () => {
    expect(formatDelimitedRow(['1', 'ada'], COMMA)).toBe('1,ada\r\n');
    expect(formatDelimitedRow(['1', 'a;b'], { delimiter: ';', quote: "'" })).toBe("1;'a;b'\r\n");
  });

  it('writes a null as a bare empty field, and quotes it when it is the only one', async () => {
    expect(formatDelimitedRow(['a', null, ''], COMMA)).toBe('a,,""\r\n');
    expect(formatDelimitedRow([null], COMMA)).toBe('""\r\n');
    expect(await parse(formatDelimitedRow([null], COMMA))).toEqual([['']]);
  });

  const TRICKY = ['plain', 'a,b', 'say "hi"', 'two\nlines', 'tab\there', ' lead', '', 'c:\\dir'];

  it('reads back exactly through the reader grammar', async () => {
    const text = formatDelimitedRow(TRICKY, COMMA) + formatDelimitedRow(['x', 'y'], COMMA);
    expect(await parse(text)).toEqual([TRICKY, ['x', 'y']]);
  });

  it('reads back exactly with a declared escape and another delimiter and quote', async () => {
    const opts = { delimiter: '|', quote: "'", escape: '\\' } as const;
    const values = ["it's", 'a|b', 'c:\\dir\\', "''"];
    expect(await parse(formatDelimitedRow(values, opts), opts)).toEqual([values]);
  });
});
