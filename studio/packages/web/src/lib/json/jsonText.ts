/**
 * #1396 — JSON as the operator TYPES it: where it is wrong, and how to lay it out.
 *
 * Both work on the text, never on a parsed value. `JSON.parse` cannot say where a
 * mistake is in every browser (JavaScriptCore names no position, and V8's
 * "Unexpected token" form names none either), so the forms used to show a
 * position on some machines and not on others. And a Format that went through
 * `JSON.parse` + `JSON.stringify` would change what was typed: an integer past
 * 2^53 loses digits, `1E+2` becomes `100`, an escape is rewritten and a duplicate
 * key disappears. Format must only move whitespace.
 *
 * The scanner follows RFC 8259 exactly as `JSON.parse` does — whitespace is space,
 * tab, LF and CR only, so a BOM or a no-break space is refused, as `JSON.parse`
 * refuses it — and the test suite holds the two to the same verdict. It is a loop
 * with an explicit stack, not recursion, so deep nesting cannot overflow it.
 */

export type JsonScan = { ok: true } | { ok: false; offset: number; reason: string };

type Container = '{' | '[';

/** What may come next. */
type Expect = 'value' | 'valueOrClose' | 'keyOrClose' | 'key' | 'colon' | 'commaOrClose' | 'end';

const INDENT = '  ';

/**
 * Format lays out no deeper than this. The indent grows with the depth, so the
 * laid-out text grows with its square: 200,000 nested brackets scan in a blink
 * but would lay out to tens of gigabytes. Hand-written JSON is never this deep.
 */
export const MAX_LAYOUT_DEPTH = 256;

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

class Refusal {
  constructor(
    readonly offset: number,
    readonly reason: string,
  ) {}
}

/** The end of the string token starting at `start` (its opening quote). */
function endOfString(text: string, start: number): number {
  let i = start + 1;
  for (;;) {
    const ch = text[i];
    if (ch === undefined) throw new Refusal(start, 'unterminated string');
    if (ch === '"') return i + 1;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          throw new Refusal(i, 'invalid escape in a string');
        }
        i += 6;
      } else if (next !== undefined && '"\\/bfnrt'.includes(next)) {
        i += 2;
      } else {
        throw new Refusal(i, 'invalid escape in a string');
      }
    } else if (ch.charCodeAt(0) < 0x20) {
      throw new Refusal(i, 'a line break or control character inside a string');
    } else {
      i += 1;
    }
  }
}

/** The end of the number token starting at `start`. */
function endOfNumber(text: string, start: number): number {
  let i = start;
  if (text[i] === '-') i += 1;
  if (text[i] === '0') {
    i += 1;
  } else if (isDigit(text[i])) {
    while (isDigit(text[i])) i += 1;
  } else {
    throw new Refusal(start, 'invalid number');
  }
  if (text[i] === '.') {
    i += 1;
    if (!isDigit(text[i])) throw new Refusal(start, 'invalid number');
    while (isDigit(text[i])) i += 1;
  }
  if (text[i] === 'e' || text[i] === 'E') {
    i += 1;
    if (text[i] === '+' || text[i] === '-') i += 1;
    if (!isDigit(text[i])) throw new Refusal(start, 'invalid number');
    while (isDigit(text[i])) i += 1;
  }
  // `01` and `1x` are one bad token, not a number followed by junk.
  if (isDigit(text[i]) || /[A-Za-z_.]/.test(text[i] ?? ''))
    throw new Refusal(start, 'invalid number');
  return i;
}

function unexpected(text: string, at: number): Refusal {
  if (at >= text.length) return new Refusal(at, 'unexpected end of input');
  const code = text.codePointAt(at) ?? 0;
  const ch = String.fromCodePoint(code);
  // An invisible character (a BOM, a no-break space) is named by its code point.
  const shown = /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(ch)
    ? `'${ch}'`
    : `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return new Refusal(at, `unexpected character ${shown}`);
}

/**
 * Walk the text once, calling `emit` with each token's source slice and the
 * nesting depth AFTER it. Throws a `Refusal` at the first mistake.
 */
function walk(text: string, emit: (token: string, depth: number) => void): void {
  const stack: Container[] = [];
  let expect: Expect = 'value';
  let i = 0;
  for (;;) {
    while (i < text.length && isWhitespace(text[i]!)) i += 1;
    const ch = text[i];
    const top = stack[stack.length - 1];

    if (expect === 'end') {
      if (ch === undefined) return;
      throw new Refusal(i, 'unexpected text after the JSON value');
    }
    if (ch === undefined) throw new Refusal(i, 'unexpected end of input');

    if (expect === 'colon') {
      if (ch !== ':') throw new Refusal(i, "expected ':'");
      emit(':', stack.length);
      i += 1;
      expect = 'value';
      continue;
    }

    if (expect === 'commaOrClose') {
      const close = top === '{' ? '}' : ']';
      if (ch === ',') {
        emit(',', stack.length);
        i += 1;
        expect = top === '{' ? 'key' : 'value';
      } else if (ch === close) {
        stack.pop();
        emit(ch, stack.length);
        i += 1;
        expect = stack.length === 0 ? 'end' : 'commaOrClose';
      } else {
        throw new Refusal(i, `expected ',' or '${close}'`);
      }
      continue;
    }

    if (expect === 'key' || expect === 'keyOrClose') {
      if (expect === 'keyOrClose' && ch === '}') {
        stack.pop();
        emit('}', stack.length);
        i += 1;
        expect = stack.length === 0 ? 'end' : 'commaOrClose';
        continue;
      }
      if (ch !== '"') throw new Refusal(i, 'expected a property name in double quotes');
      const end = endOfString(text, i);
      emit(text.slice(i, end), stack.length);
      i = end;
      expect = 'colon';
      continue;
    }

    // expect is 'value' or 'valueOrClose'.
    if (expect === 'valueOrClose' && ch === ']') {
      stack.pop();
      emit(']', stack.length);
      i += 1;
      expect = stack.length === 0 ? 'end' : 'commaOrClose';
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      emit(ch, stack.length);
      i += 1;
      expect = ch === '{' ? 'keyOrClose' : 'valueOrClose';
      continue;
    }
    let end: number;
    if (ch === '"') {
      end = endOfString(text, i);
    } else if (ch === '-' || isDigit(ch)) {
      end = endOfNumber(text, i);
    } else {
      const literal = ['true', 'false', 'null'].find((word) => text.startsWith(word, i));
      if (literal === undefined || /[A-Za-z0-9_]/.test(text[i + literal.length] ?? '')) {
        // `tru`, `True`, `nullx`: name the word, not its first letter, which
        // may well begin a word JSON has.
        const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))?.[0];
        if (word !== undefined) {
          throw new Refusal(
            i,
            `'${word}' is not a JSON value (the words are true, false and null)`,
          );
        }
        throw unexpected(text, i);
      }
      end = i + literal.length;
    }
    emit(text.slice(i, end), stack.length);
    i = end;
    expect = stack.length === 0 ? 'end' : 'commaOrClose';
  }
}

/** Whether `text` is one JSON value, and if not, where and why not. */
export function scanJson(text: string): JsonScan {
  try {
    walk(text, () => undefined);
    return { ok: true };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, offset: err.offset, reason: err.reason };
    throw err;
  }
}

class TooDeep {}

/**
 * `text` laid out as `JSON.stringify(value, null, 2)` lays it out — two-space
 * indent, `"key": value`, `{}` and `[]` for empty containers — so pressing Format
 * on text a form seeded with `JSON.stringify(…, null, 2)` changes nothing and does
 * not mark the form edited. Every token is copied from the source, so values are
 * exactly as typed. `null` for blank text, text that is not JSON, and JSON
 * nested deeper than `MAX_LAYOUT_DEPTH`.
 */
export function formatJsonText(text: string): string | null {
  if (text.trim() === '') return null;
  const out: string[] = [];
  let openPending = false;
  const newline = (depth: number) => `\n${INDENT.repeat(depth)}`;
  try {
    walk(text, (token, depth) => {
      if (depth > MAX_LAYOUT_DEPTH) throw new TooDeep();
      if (token === '}' || token === ']') {
        out.push(openPending ? token : `${newline(depth)}${token}`);
        openPending = false;
        return;
      }
      if (openPending) out.push(newline(depth - (token === '{' || token === '[' ? 1 : 0)));
      openPending = false;
      if (token === ',') {
        out.push(`,${newline(depth)}`);
      } else if (token === ':') {
        out.push(': ');
      } else {
        out.push(token);
        if (token === '{' || token === '[') openPending = true;
      }
    });
  } catch (err) {
    if (err instanceof Refusal || err instanceof TooDeep) return null;
    throw err;
  }
  return out.join('');
}

/** 1-based line and column of `offset`; a CRLF is one break, a column counts characters. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split(/\r\n|\r|\n/);
  const last = lines[lines.length - 1] ?? '';
  return { line: lines.length, column: [...last].length + 1 };
}

/**
 * `null` if `parsed` is JSON, else "line L, column C: reason".
 *
 * Pass `shown` when the text that was parsed is not the text on screen — a form
 * that trims before parsing — so the line and column point into what the operator
 * sees. `parsed` must be a substring of `shown`; `trim()` guarantees the first
 * occurrence is the right one, since its first character is not trimmable.
 */
export function describeJsonProblem(parsed: string, shown: string = parsed): string | null {
  const scan = scanJson(parsed);
  if (scan.ok) return null;
  const lead = Math.max(0, shown.indexOf(parsed));
  const { line, column } = positionOf(shown, lead + scan.offset);
  return `line ${line}, column ${column}: ${scan.reason}`;
}

/**
 * A form's refusal of text that is not JSON, saying where: "not valid JSON (line
 * 2, column 7: expected ':')". Arguments as for `describeJsonProblem`.
 */
export function notValidJson(parsed: string, shown: string = parsed): string {
  const problem = describeJsonProblem(parsed, shown);
  return problem === null ? 'not valid JSON' : `not valid JSON (${problem})`;
}
