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
 * **CRLF needs no special case, and that is a consequence rather than a
 * coincidence**: `\r` ends the row and the `\n` that follows then ends a
 * zero-length line, which is already skipped. This was not obvious — the
 * machine carried a `sawCr` flag to swallow the `\n`, and a mutation that
 * deleted the flag passed the entire suite. It was dead state, and the honest
 * response was to delete it rather than to pin it with a test that could not
 * fail. It also means no CRLF state crosses a chunk boundary at all.
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
 * emitting anything — satisfying the signature while violating the point.
 *
 * **`maxRowChars` charges EVERY character the row consumed**, not only the ones
 * that reach a field, and that distinction is the whole bound: a first cut
 * counted field content alone, so `,,,,,…` and `"","","",…` — which add no
 * character to any field — accumulated 200,000 entries in the row array against
 * a `maxRowChars` of 100 without a murmur. The row ARRAY is the accumulator that
 * has to be bounded, and only a per-character charge bounds it.
 *
 * Both are counted in CODE POINTS, not bytes and not UTF-16 units: this side of
 * the seam has already decoded, `bytesRead` is defined at the copy boundary (§5)
 * rather than here, and the loop iterates code points — so charging `field.length`
 * would have billed an astral character twice to one bound and once to the other.
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
 * that decides whether it closed the field — without changing the result.
 * `pendingQuote` and `pendingEscape` are the only state that crosses a boundary
 * in a way a reader could get wrong; everything else is per-character. Both are
 * covered by running the whole corpus a second time at one character per chunk.
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
  /**
   * Characters consumed since the last row terminator, and characters in the
   * field in progress — both counted in CODE POINTS, because the loop below
   * iterates code points and `field.length` would count UTF-16 units, so an
   * astral character would be charged twice to one bound and once to the other.
   *
   * `rowChars` counts EVERY character the row consumed, not just the ones that
   * ended up in a field: delimiters, quotes and escapes all count. That is what
   * makes the bound total — charging only field CONTENT left `,,,,,…` and
   * `"","","",…` unbounded, since neither adds a character to any field, and a
   * row of 200,000 empty fields sailed past a `maxRowChars` of 100.
   *
   * It doubles as the blank-line test, exactly: a line is blank iff it consumed
   * NO characters at all. The structural test it replaces — one field, empty
   * string — could not tell a blank line from a line holding a single quoted
   * empty field (`""`), and silently DROPPED the second.
   */
  let rowChars = 0;
  let fieldChars = 0;
  /** 1-based PHYSICAL line, so a refusal names the line an operator would find
   * by counting in an editor. Blank lines count, which is why this is a line
   * number and not a row number — they are skipped as rows but they are still
   * lines, and a file with many of them would otherwise report a number that
   * drifts further from the truth the further down the fault is. */
  let lineNumber = 1;

  let inQuotes = false;
  /** Started at the current field, i.e. no character has been taken yet. */
  let atFieldStart = true;
  /** The previous character was a closing quote — the next one decides between
   * a doubled quote, the end of the field, and a refusal. */
  let pendingQuote = false;
  /** The previous character was an escape, inside a quoted field. */
  let pendingEscape = false;

  const fail = (code: DelimitedParseFailureCode, what: string): never => {
    throw new DelimitedParseError(code, `${what} (line ${lineNumber})`);
  };

  const pushChar = (c: string): void => {
    field += c;
    fieldChars += 1;
    if (maxFieldChars !== undefined && fieldChars > maxFieldChars) {
      fail('field_too_large', `a field exceeded ${maxFieldChars} characters`);
    }
  };

  const endField = (): void => {
    row.push(field);
    field = '';
    fieldChars = 0;
    atFieldStart = true;
  };

  /** Close the row in progress. Returns the completed row, or `null` when the
   * line was blank — a blank line is skipped, never a row of one empty field. */
  const endRow = (): string[] | null => {
    const blank = rowChars === 0;
    endField();
    const done = row;
    row = [];
    rowChars = 0;
    lineNumber += 1;
    return blank ? null : done;
  };

  for await (const chunk of chunks) {
    for (const c of chunk) {
      // Whether this character ENDS the row rather than belonging to it. Inside
      // a quoted field, and immediately after an escape, a `\n` is content —
      // which is why this cannot be a bare test on the character.
      const terminates =
        !inQuotes && !pendingEscape && (c === '\n' || c === '\r');

      // Charged before the character is classified, so a delimiter, a quote and
      // an escape all count against the row even though none reaches a field.
      // The terminator itself is NOT charged, for two reasons that both matter:
      // a row of exactly `maxRowChars` characters would otherwise be refused by
      // its own line ending, and `rowChars === 0` would stop meaning "blank
      // line" — which is the test `endRow` uses.
      if (!terminates) {
        rowChars += 1;
        if (maxRowChars !== undefined && rowChars > maxRowChars) {
          fail('row_too_large', `a row exceeded ${maxRowChars} characters`);
        }
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
        if (c !== '\n' && c !== '\r') {
          return fail(
            'unexpected_character_after_quote',
            `a closing quote is followed by ${JSON.stringify(c)} instead of a delimiter ` +
              'or the end of the row',
          );
        }
        // A terminator. Deliberately FALLS THROUGH to the one row-terminator
        // arm below rather than repeating it — a second copy of "end the row,
        // push it, maybe flush the batch" is a batch-boundary bug waiting for
        // the first quoted row that lands on one, and it was exactly that:
        // a mutation of the duplicate survived the whole suite, because every
        // batching test used unquoted rows.
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

  // A document that ends exactly on a terminator has consumed nothing since it.
  // One that ends mid-row has a final row with no terminator, which is still a
  // row — including `""` with nothing after it, which `rowChars` sees and the
  // old `field !== '' || row.length > 0` test did not.
  if (rowChars > 0) {
    const done = endRow();
    if (done) batch.push(done);
  }
  if (batch.length > 0) yield batch;
}
