/**
 * #1405 OR14 — the WRITE half of the delimited grammar: one row of text fields
 * as one line of a separated-values file.
 *
 * It writes exactly what `delimited.ts` reads, and the round trip is the test.
 * A field is quoted when it holds the delimiter, the quote, the escape or a line
 * break, and inside the quotes a quote is doubled and an escape is escaped.
 * Everything else is written bare, so a leading space or a quote mid-field stays
 * data, as the reader's grammar takes it.
 *
 * An EMPTY field is quoted. Bare, a row of one empty field would be a blank
 * line, and the reader skips a blank line rather than reading a row from it.
 *
 * Rows end in CRLF, RFC 4180's terminator, which the reader takes like `\n`.
 * Pure, like the reader's grammar: the encoding is the writer's.
 */
export interface DelimitedFormatOptions {
  readonly delimiter: string;
  readonly quote: string;
  readonly escape?: string;
}

/** One field, quoted only when its content needs it. */
export function formatDelimitedField(value: string, opts: DelimitedFormatOptions): string {
  const needsQuotes =
    value === '' ||
    value.includes(opts.delimiter) ||
    value.includes(opts.quote) ||
    value.includes('\n') ||
    value.includes('\r') ||
    (opts.escape !== undefined && value.includes(opts.escape));
  if (!needsQuotes) return value;
  let body = '';
  for (const ch of value) {
    if (ch === opts.quote) body += ch + ch;
    else if (opts.escape !== undefined && ch === opts.escape) body += ch + ch;
    else body += ch;
  }
  return opts.quote + body + opts.quote;
}

/**
 * One row, CRLF-terminated. A `null` field is written bare and empty, where an
 * empty string is quoted; the reader takes both as an empty field. A row whose
 * only field is `null` is quoted all the same, as a bare one would be a blank
 * line the reader skips.
 */
export function formatDelimitedRow(
  fields: readonly (string | null)[],
  opts: DelimitedFormatOptions,
): string {
  const text = fields.map((field) =>
    field === null ? (fields.length === 1 ? opts.quote + opts.quote : '') : formatDelimitedField(field, opts),
  );
  return text.join(opts.delimiter) + '\r\n';
}
