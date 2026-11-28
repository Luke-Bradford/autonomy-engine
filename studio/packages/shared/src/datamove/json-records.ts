/**
 * #1405 OR14 — the JSON record grammar, as a pure streaming machine: the JSON
 * twin of `delimited.ts`, and pure for the same reasons (no I/O, no decoding,
 * no scheduling; the reader owns those).
 *
 * Two layouts:
 * - **array** — one top-level JSON array; each ELEMENT is a record. The array is
 *   split element by element as text arrives, so a large file is never held
 *   whole: only the element being read is. Each element is then handed to
 *   `JSON.parse`, which is what validates it.
 * - **lines** — JSON Lines: one value per line. A blank line is skipped, a CRLF
 *   ends a line like LF, and a last line with no terminator is still a record.
 *
 * It yields the parsed VALUES, whatever they are. Whether a record must be an
 * object, and what its columns are called, is the reader's to decide.
 *
 * `maxRecordChars` bounds one record's text, for `delimited.ts`'s reason: an
 * unclosed string has no end to find, and an unbounded machine would read the
 * whole file into one record before saying anything.
 *
 * A refusal names a record by its position (`element 3`, `line 7`), never by its
 * text: the text is the operator's data.
 */

export type JsonRecordsFailureCode =
  'not_an_array' | 'invalid_json' | 'trailing_content' | 'record_too_long' | 'invalid_batch_rows';

export class JsonRecordsError extends Error {
  readonly code: JsonRecordsFailureCode;
  constructor(code: JsonRecordsFailureCode, message: string) {
    super(message);
    this.name = 'JsonRecordsError';
    this.code = code;
  }
}

export interface JsonRecordsOptions {
  readonly layout: 'array' | 'lines';
  /** Records per yielded batch. No default here; the reader passes it. */
  readonly batchRows: number;
  readonly maxRecordChars: number;
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

function parseRecord(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new JsonRecordsError('invalid_json', `${where} is not valid JSON`);
  }
}

function tooLong(where: string, max: number): JsonRecordsError {
  return new JsonRecordsError(
    'record_too_long',
    `${where} runs past ${max} characters without ending — the file may be malformed`,
  );
}

/** Stream `chunks` as batches of parsed records. */
export async function* parseJsonRecords(
  chunks: AsyncIterable<string>,
  opts: JsonRecordsOptions,
): AsyncGenerator<unknown[], void, undefined> {
  if (!Number.isInteger(opts.batchRows) || opts.batchRows < 1) {
    throw new JsonRecordsError(
      'invalid_batch_rows',
      `batchRows must be a positive integer, got ${opts.batchRows}`,
    );
  }
  if (opts.layout === 'lines') yield* lines(chunks, opts);
  else yield* arrayElements(chunks, opts);
}

async function* lines(
  chunks: AsyncIterable<string>,
  opts: JsonRecordsOptions,
): AsyncGenerator<unknown[], void, undefined> {
  let pending = '';
  let lineNo = 0;
  let batch: unknown[] = [];
  const take = (line: string): void => {
    lineNo += 1;
    if (line.length > opts.maxRecordChars) throw tooLong(`line ${lineNo}`, opts.maxRecordChars);
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text.trim() === '') return;
    batch.push(parseRecord(text, `line ${lineNo}`));
  };
  for await (const chunk of chunks) {
    pending += chunk;
    let nl = pending.indexOf('\n');
    while (nl !== -1) {
      take(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      if (batch.length >= opts.batchRows) {
        yield batch;
        batch = [];
      }
      nl = pending.indexOf('\n');
    }
    if (pending.length > opts.maxRecordChars)
      throw tooLong(`line ${lineNo + 1}`, opts.maxRecordChars);
  }
  if (pending !== '') take(pending);
  if (batch.length > 0) yield batch;
}

type ArrayState =
  | 'start' // before the opening `[`
  | 'first' // after `[`: an element or `]`
  | 'value' // after `,`: an element is required
  | 'in' // inside an element
  | 'after' // after an element: `,` or `]`
  | 'end'; // after the closing `]`

async function* arrayElements(
  chunks: AsyncIterable<string>,
  opts: JsonRecordsOptions,
): AsyncGenerator<unknown[], void, undefined> {
  let state: ArrayState = 'start';
  let record = '';
  let depth = 0; // open `{`/`[` inside the element
  let inString = false;
  let escaped = false;
  let bare = false; // a number, `true`, `false` or `null`: ends at a delimiter
  let element = 0;
  let batch: unknown[] = [];

  const finish = (): void => {
    batch.push(parseRecord(record, `element ${element}`));
    record = '';
    state = 'after';
  };
  const unexpected = (what: string): JsonRecordsError =>
    new JsonRecordsError('invalid_json', `the array is not valid JSON: ${what}`);

  for await (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i]!;
      if (state === 'in') {
        if (bare) {
          if (isSpace(ch) || ch === ',' || ch === ']') {
            finish();
            i -= 1; // the delimiter belongs to the state after the element
            continue;
          }
          record += ch;
        } else {
          record += ch;
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') {
              inString = false;
              if (depth === 0) finish();
            }
          } else if (ch === '"') inString = true;
          else if (ch === '{' || ch === '[') depth += 1;
          else if (ch === '}' || ch === ']') {
            depth -= 1;
            if (depth === 0) finish();
          }
        }
        if (record.length > opts.maxRecordChars) {
          throw tooLong(`element ${element}`, opts.maxRecordChars);
        }
        continue;
      }
      if (isSpace(ch)) continue;
      // `finish` moves the state inside a closure, which narrowing cannot see.
      switch (state as ArrayState) {
        case 'start':
          if (ch !== '[') {
            throw new JsonRecordsError(
              'not_an_array',
              'the file is not a JSON array — a JSON dataset holds one array of records',
            );
          }
          state = 'first';
          break;
        case 'first':
        case 'value':
          if (ch === ']') {
            if (state === 'value')
              throw unexpected(`a comma after element ${element} has no element after it`);
            state = 'end';
            break;
          }
          if (ch === ',') throw unexpected(`a comma where element ${element + 1} should start`);
          element += 1;
          state = 'in';
          record = ch;
          bare = !(ch === '{' || ch === '[' || ch === '"');
          depth = ch === '{' || ch === '[' ? 1 : 0;
          inString = ch === '"';
          escaped = false;
          break;
        case 'after':
          if (ch === ',') {
            if (batch.length >= opts.batchRows) {
              yield batch;
              batch = [];
            }
            state = 'value';
          } else if (ch === ']') state = 'end';
          else throw unexpected(`element ${element} is not followed by a comma or the array's end`);
          break;
        case 'end':
          throw new JsonRecordsError(
            'trailing_content',
            'the file carries more after its array ends — a JSON dataset holds one array',
          );
      }
    }
  }
  if (state === 'in' && bare) finish();
  if (state === 'start') {
    throw new JsonRecordsError(
      'not_an_array',
      'the file is empty — a JSON dataset holds one array of records',
    );
  }
  if (state !== 'end') throw unexpected('the file ends before the array closes');
  if (batch.length > 0) yield batch;
}
