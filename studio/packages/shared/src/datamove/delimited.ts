/**
 * #996 M7 slice 1 (#1163) — the delimited (CSV) row grammar, as a PURE
 * streaming state machine (data-movement spec §2.6, §5, §12).
 *
 * §12's M7 row asks for "a row stream, not `parse(wholeFile)`", and this is the
 * half of that which owns no I/O: it consumes already-decoded text chunks and
 * yields bounded batches of POSITIONAL rows. It belongs beside `coerce.ts` and
 * `pump.ts` under `datamove/`'s charter — "pure behaviour a copy performs on
 * values" — for the same reason those do: it has no filesystem, no clock, no
 * scheduling and no store.
 *
 * ── THE THREE THINGS THIS DELIBERATELY DOES NOT DO ──────────────────────────
 *
 * **1. It does not decode bytes.** `TextDecoder` is neither an ES2023 nor a DOM
 * global, and `shared` is compiled against `lib: ["ES2023"]` with no node types
 * (`engine/functions.ts` says so where it hand-rolls `utf8ByteLength` for the
 * same reason). Decoding belongs to the reader, and so therefore does the BOM
 * — measured on node v25.9.0, `TextDecoder` strips a leading BOM itself, even
 * when it is split across a chunk boundary, so the reader owes no manual strip.
 * **The reader must construct its decoder `{ fatal: true }`**: the default
 * substitutes U+FFFD for every undecodable byte, so a mis-declared encoding
 * would write replacement characters into the sink and report success. Stated
 * honestly, the cover is uneven — `windows-1252` maps every byte and never
 * throws, and utf-16 throws only on an odd trailing byte — so `fatal` binds
 * mostly on utf-8. It is still the difference between a refusal and silent
 * corruption on the encoding operators actually use.
 *
 * **2. It does not yield to the event loop.** §9's batch-yield is the READER's
 * contract, exactly as `readSqliteDatasetBatches` owns it today, and the
 * measured note there is load-bearing: `queueMicrotask` is a NO-OP for this
 * purpose because a microtask drains before the loop turns, so it must be
 * `setImmediate`. Neither exists in `shared`, and `web` bundles this package.
 * The reader wraps: `for await (const b of parseDelimitedRows(…)) { await
 * yieldToEventLoop(); yield b; }`.
 *
 * **3. It does not name columns, and it does not skip the header.** It yields
 * `string[]` rows and nothing else, because that is the only output that can
 * feed both halves of the seam it serves — `CopyIo.readBatches` wants named
 * records and `describeSource` wants a bare `readonly string[]`, and a parser
 * that knew the dataset could not serve both without knowing which it was in.
 * So the READER skips row 1 when `header: true` and binds the names, and it
 * must not forget: nothing here does it, and a reader that assumes otherwise
 * silently drops a data row. `describeSource` reads the header by taking the
 * first row of the first batch with `batchRows: 1` and returning — there is no
 * separate header entry point to keep in step.
 *
 * With `header: false` there is no header row to name anything, and the reader
 * must name columns POSITIONALLY — never from the dataset's declared `columns`,
 * which §7 is explicit are "deliberately NOT the gate". That choice has one
 * consequence worth saying out loud now: learning the width needs one row, so a
 * headerless source is the one case where §7's "without reading a row" cannot
 * hold, and the reader owes that statement rather than a quiet exception.
 *
 * ── THE GRAMMAR, INCLUDING THE THREE CASES REAL PARSERS DISAGREE ON ─────────
 *
 * Quoting is RFC 4180: a field is quoted only if its FIRST character is the
 * quote; inside, a doubled quote is one literal quote. A declared `escape`
 * additionally makes the next character literal inside a quoted field — the two
 * rules never compete for one byte because the config schema refuses
 * `escape === quote` (and `escape === delimiter`).
 *
 * Row terminators outside a quoted field are `\r\n`, `\n` and a lone `\r`; all
 * three are ordinary data inside one. A zero-length line is skipped, so a
 * trailing terminator yields no phantom row and a blank line is not a row of one
 * empty field. A final line with no terminator is still a row.
 *
 * The three cases where mature parsers genuinely disagree, decided here rather
 * than left to whoever hits them first — each one is otherwise a silently-wrong
 * value:
 *
 * - **A bare quote inside an UNQUOTED field** (`a"b`) is DATA. The field did not
 *   start with a quote, so no quoting rule is in play.
 * - **Whitespace before an opening quote** (` "a"`) means the field is NOT
 *   quoted, so the quotes are data and the value is ` "a"`. Same rule as above,
 *   stated separately because it is the one people expect to be trimmed.
 * - **Characters after a CLOSING quote** (`"a"x`) are REFUSED. Python's `csv`
 *   appends them (`ax`), Postgres `COPY` errors; that disagreement is the tell
 *   that neither is a fact about the file. Appending invents a value the
 *   document does not contain, and inventing data is the one direction a copy
 *   must never fail in.
 *
 * ── BOUNDING ───────────────────────────────────────────────────────────────
 *
 * `maxFieldChars`/`maxRowChars` exist because "yields a stream" and "never holds
 * the whole file" are different properties, and only the second is the one §12
 * wants. A binary, a gzip or a never-closed quote has no terminator, so an
 * unbounded machine would accumulate the entire file into one field before
 * emitting anything — satisfying the signature while violating the point. Both
 * are counted in CHARACTERS rather than bytes: this side of the seam has already
 * decoded, and `bytesRead` is defined at the copy boundary (§5), not here.
 */

/**
 * A bounded refusal code. Bounded on `CoercionFailureCode`'s precedent — "a
 * bounded code, not unbounded per-row prose" — so the reader can map each to a
 * `ConnectorErrorKind` by CODE rather than by matching on a message.
 *
 * Every one of these is `permanent` for the reader's purposes: a malformed
 * document and a bad batch size are both facts that a retry cannot change.
 * Cancellation is deliberately absent — this machine has no signal, because the
 * reader can abort at its chunk source and between batches, where the abort
 * actually belongs (§10: a cancelled run is never retried).
 */
export type DelimitedParseFailureCode =
  | 'unterminated_quote'
  | 'unexpected_character_after_quote'
  | 'field_too_large'
  | 'row_too_large'
  | 'invalid_batch_rows';

/** A refusal from the row grammar, carrying a bounded `code` and a sentence
 * that names the row — the only thing that makes it actionable in a file with a
 * million of them. */
export class DelimitedParseError extends Error {
  readonly code: DelimitedParseFailureCode;

  constructor(code: DelimitedParseFailureCode, message: string) {
    super(message);
    this.name = 'DelimitedParseError';
    this.code = code;
  }
}

export interface DelimitedParseOptions {
  /** One character, not a line terminator. Enforced by the config schema. */
  readonly delimiter: string;
  readonly quote: string;
  /** Absent means RFC 4180 doubling is the only escape. */
  readonly escape?: string;
  /**
   * Rows per yielded batch. REQUIRED with no default, deliberately: the default
   * `COPY_BATCH_ROWS` lives in the server's `limits.ts`, and a second default
   * here would be a duplicated constant that could drift. The reader passes
   * `batchRows ?? COPY_BATCH_ROWS`, exactly as `readSqliteDatasetBatches` does.
   */
  readonly batchRows: number;
  /** Bounds on accumulation. Absent means unbounded — which is right for a
   * caller that has already bounded the source some other way, and wrong for a
   * reader pointed at an arbitrary file, so the reader supplies both. */
  readonly maxFieldChars?: number;
  readonly maxRowChars?: number;
}

/**
 * Parse `chunks` into batches of positional rows.
 *
 * A single pass with no lookahead beyond one character, so a chunk boundary can
 * fall anywhere — mid-CRLF, mid-quoted-field, between a quote and the character
 * that decides whether it closed the field — without changing the result. The
 * `pendingQuote` and `sawCr` flags are exactly the two pieces of state that
 * cross a boundary; everything else is per-character.
 */
export async function* parseDelimitedRows(
  chunks: AsyncIterable<string>,
  options: DelimitedParseOptions,
): AsyncGenerator<string[][], void, undefined> {
  const { delimiter, quote, escape, batchRows, maxFieldChars, maxRowChars } = options;

  if (!Number.isInteger(batchRows) || batchRows < 1) {
    throw new DelimitedParseError(
      'invalid_batch_rows',
      `batchRows must be a positive integer; got ${String(batchRows)}`,
    );
  }

  let batch: string[][] = [];
  let row: string[] = [];
  let field = '';
  let rowChars = 0;
  /** 1-based, counting only rows that were EMITTED plus the one in progress —
   * so the number in a refusal is the row an operator would count to. */
  let rowNumber = 1;

  let inQuotes = false;
  /** A field that began with the quote character. Distinguishes `"a"` (quoted,
   * so a trailing `x` is a refusal) from `a"b` (never quoted, so `"` is data). */
  let wasQuoted = false;
  /** Started at the current field, i.e. no character has been taken yet. */
  let atFieldStart = true;
  /** The previous character was a closing quote — the next one decides between
   * a doubled quote, the end of the field, and a refusal. */
  let pendingQuote = false;
  /** The previous character was an escape, inside a quoted field. */
  let pendingEscape = false;
  /** The previous character was a `\r` outside quotes: the row has already been
   * terminated, and a following `\n` is the other half of a CRLF, not a second
   * terminator. Crosses a chunk boundary, which is why it is state. */
  let sawCr = false;

  const fail = (code: DelimitedParseFailureCode, what: string): never => {
    throw new DelimitedParseError(code, `${what} (row ${rowNumber})`);
  };

  const pushChar = (c: string): void => {
    field += c;
    rowChars += 1;
    if (maxFieldChars !== undefined && field.length > maxFieldChars) {
      fail('field_too_large', `a field exceeded ${maxFieldChars} characters`);
    }
    if (maxRowChars !== undefined && rowChars > maxRowChars) {
      fail('row_too_large', `a row exceeded ${maxRowChars} characters`);
    }
  };

  const endField = (): void => {
    row.push(field);
    field = '';
    wasQuoted = false;
    atFieldStart = true;
  };

  /** Close the row in progress. Returns the completed row, or `null` when the
   * line was blank — a blank line is skipped, never a row of one empty field. */
  const endRow = (): string[] | null => {
    endField();
    const done = row;
    row = [];
    rowChars = 0;
    if (done.length === 1 && done[0] === '') return null;
    rowNumber += 1;
    return done;
  };

  for await (const chunk of chunks) {
    for (const c of chunk) {
      // A `\n` immediately after a `\r` outside quotes completes a CRLF that has
      // already terminated its row. Consume it and move on.
      if (sawCr) {
        sawCr = false;
        if (c === '\n') continue;
      }

      if (pendingEscape) {
        pendingEscape = false;
        pushChar(c);
        continue;
      }

      if (pendingQuote) {
        pendingQuote = false;
        if (c === quote) {
          // A doubled quote inside a quoted field: one literal quote, still inside.
          inQuotes = true;
          pushChar(quote);
          continue;
        }
        if (c === delimiter) {
          endField();
          continue;
        }
        if (c === '\n' || c === '\r') {
          const done = endRow();
          if (done) {
            batch.push(done);
            if (batch.length >= batchRows) {
              yield batch;
              batch = [];
            }
          }
          sawCr = c === '\r';
          continue;
        }
        return fail(
          'unexpected_character_after_quote',
          `a closing quote is followed by ${JSON.stringify(c)} instead of a delimiter ` +
            'or the end of the row',
        );
      }

      if (inQuotes) {
        if (escape !== undefined && c === escape) {
          pendingEscape = true;
          continue;
        }
        if (c === quote) {
          // Might close the field, might be the first of a doubled pair. The
          // next character decides, and it may be in the next chunk.
          inQuotes = false;
          pendingQuote = true;
          continue;
        }
        pushChar(c);
        continue;
      }

      if (atFieldStart && c === quote) {
        inQuotes = true;
        wasQuoted = true;
        atFieldStart = false;
        continue;
      }

      if (c === delimiter) {
        endField();
        continue;
      }

      if (c === '\n' || c === '\r') {
        const done = endRow();
        if (done) {
          batch.push(done);
          if (batch.length >= batchRows) {
            yield batch;
            batch = [];
          }
        }
        sawCr = c === '\r';
        continue;
      }

      atFieldStart = false;
      pushChar(c);
    }
  }

  if (inQuotes || pendingEscape) {
    return fail(
      'unterminated_quote',
      'a quoted field is never closed before the end of the document',
    );
  }

  // A document that ends exactly on a terminator has nothing in progress. One
  // that ends mid-row has a final row with no terminator, which is still a row.
  const trailing = field !== '' || row.length > 0 || wasQuoted || pendingQuote;
  if (trailing) {
    const done = endRow();
    if (done) batch.push(done);
  }
  if (batch.length > 0) yield batch;
}
