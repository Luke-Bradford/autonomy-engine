import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvCell, toCsv } from '../csv.js';

describe('csvCell (#1484 — the runs export)', () => {
  it('writes plain text, numbers and booleans as they are, and null as an empty cell', () => {
    expect([csvCell('orders'), csvCell(42), csvCell(-1.5), csvCell(true), csvCell(null)]).toEqual([
      'orders',
      '42',
      '-1.5',
      'true',
      '',
    ]);
  });

  it('quotes a cell holding a comma, a quote, CR or LF, and doubles the quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
  });

  it("guards a TEXT cell a spreadsheet would read as a formula with a leading '", () => {
    for (const lead of ['=', '+', '-', '@', '\t']) {
      expect(csvCell(`${lead}SUM(A1)`)).toBe(`'${lead}SUM(A1)`);
    }
    // Guarded AND quoted when it also needs quoting.
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('\rcr')).toBe(`"'\rcr"`);
  });

  it('never guards a number, so a negative one is not corrupted', () => {
    expect(csvCell(-3)).toBe('-3');
  });
});

describe('toCsv', () => {
  it('writes a BOM, the header, then each row, every line ending CRLF', () => {
    expect(
      toCsv(
        ['id', 'name'],
        [
          ['r1', 'a,b'],
          ['r2', null],
        ],
      ),
    ).toBe(`${CSV_BOM}id,name\r\nr1,"a,b"\r\nr2,\r\n`);
  });

  it('is just the BOM and header for no rows', () => {
    expect(toCsv(['id'], [])).toBe(`${CSV_BOM}id\r\n`);
  });
});
