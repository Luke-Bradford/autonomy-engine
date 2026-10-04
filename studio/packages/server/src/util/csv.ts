/**
 * #1484 OR35 M1 — writing CSV, for the runs grid's export.
 *
 * The FIRST CSV writer in this package: `connectors/delimited-io.ts` reads
 * delimited files and says so ("there is no `delimited` writer"). Anything else
 * that comes to need one should come here rather than grow a second copy.
 *
 * RFC 4180 with CRLF line ends. A cell is quoted only when it has to be (a
 * comma, a double quote, CR or LF), and a quote inside it is doubled.
 *
 * SECURITY — formula injection. A spreadsheet treats a cell that starts with
 * `=`, `+`, `-`, `@`, TAB or CR as a formula, and the text cells here hold names
 * an operator typed (pipelines, triggers, annotations). Such a TEXT cell gets a
 * leading `'`, which a spreadsheet shows as a literal and the OWASP guidance
 * names as the defence. Numbers and booleans are never guarded: they are ours,
 * not typed, and prefixing a negative number would corrupt it. Ids are text, but
 * this tree mints them without a leading sign, so the guard never touches one.
 */

/** A cell value. `null` is an empty cell, which is how a CSV says "no value". */
export type CsvValue = string | number | boolean | null;

/** The characters a spreadsheet reads a cell's FIRST character as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Characters that force a cell to be quoted. */
const NEEDS_QUOTES = /[",\r\n]/;

/** Byte-order mark: without it, Excel decodes a UTF-8 file as the local code page
 * and garbles any non-ASCII name. Every other reader this file is for (pandas
 * with `utf-8-sig`, `csv` in a spreadsheet import, a text editor) accepts it. */
export const CSV_BOM = '﻿';

/** One cell, escaped. */
export function csvCell(value: CsvValue): string {
  if (value === null) return '';
  if (typeof value !== 'string') return String(value);
  const text = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole file: the BOM, the header line, then one line per row, each ending
 * CRLF (RFC 4180's "the last record may or may not have an ending line break" —
 * it does, so concatenating two files is never a joined line). */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const line = (cells: readonly CsvValue[]) => `${cells.map(csvCell).join(',')}\r\n`;
  return CSV_BOM + line(header) + rows.map(line).join('');
}
