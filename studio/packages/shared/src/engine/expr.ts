import { SubstituteError } from './types.js';

// ---------------------------------------------------------------------------
// #6 E1 — the `${}` expression GRAMMAR: the parser + AST that every other part
// of the language reads. This module is the grammar SSOT — `substitute` (the
// evaluator) and `validateRefs` (the static checker) both parse through
// `parseExpr`, so they can never disagree on what an expression MEANS.
//
// There is NO `eval` and NO `new Function` here: parsing is a hand tokenizer
// over a CLOSED grammar, so `${__import__(...)}` is simply an unknown function
// reference. Resolution's security-critical INERTNESS property (a resolved
// value is never rescanned) lives in `substitute` and depends on this module
// only for `scanTemplateRefs` finding each `${...}` boundary ONCE.
//
// Grammar:
//   expr    := literal | call | ref
//   literal := number | boolean | string        -- number is int OR float
//   call    := NAME '(' [ expr { ',' expr } ] ')'
//   ref     := field { '.' field | '[' expr ']' }
//
// SCOPE: `[]` addressing PARSES here into `segments`, but RESOLVING it is #6
// E7. Until E7 lands, `params.ts` refuses any index-bearing ref outright — so
// the grammar accepts strictly more than the language currently resolves.
// ---------------------------------------------------------------------------

/** One node of a parsed `${}` expression. The AST is the grammar's SSOT. */
export type Expr =
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'ref'; source: string; segments: ExprSegment[] }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean };

/**
 * One step of a reference path. `segments` is the ONLY structural
 * representation of a path — a ref's `source` is an opaque diagnostic string
 * and must never be split or re-parsed (a quoted index like `m['b.c']` is one
 * segment but two dot-parts, so the two disagree by construction).
 */
export type ExprSegment = { kind: 'field'; name: string } | { kind: 'index'; expr: Expr };

/** A function name: identifier chars, cased. Spec #6's catalog is camelCase. */
const CALL_RE = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s;

/** A number literal — int OR FLOAT. `7.5` must not tokenize as a ref. */
const NUM_RE = /^-?\d+(\.\d+)?$/;

/** Sentinel protecting a `$${` literal escape during a substitution pass. */
const ESC = '\x00AE_DOLLAR_BRACE\x00';

/** Replace each `$${` escape with an inert sentinel, before any `${` scan. */
export function protectEscapes(s: string): string {
  return s.split('$${').join(ESC);
}

/** Restore sentinels to literal `${`. Inverse of `protectEscapes`. */
export function restoreEscapes(s: string): string {
  return s.split(ESC).join('${');
}

/**
 * The ONE quoting rule, shared by every scanner here (the `${}` boundary, the
 * argument splitter, and the ref-path tokenizer) so they can never drift: a
 * quote character opens a span closed by the NEXT occurrence of that SAME
 * character. There is deliberately no backslash escaping.
 *
 * `openIdx` must index a quote char. Returns the closing quote's index, or -1
 * if the span never closes.
 */
function quotedSpanEnd(s: string, openIdx: number): number {
  return s.indexOf(s[openIdx] as string, openIdx + 1);
}

function isQuote(ch: string | undefined): boolean {
  return ch === "'" || ch === '"';
}

// --- the parser -------------------------------------------------------------

/**
 * Parse ONE expression (a `${...}` body, a function argument, or an index) —
 * the single entry point for the whole grammar. Whitespace inside the braces is
 * insignificant. Throws `SubstituteError` on any malformed body; a malformed
 * expression is NEVER silently reinterpreted as a literal or a ref.
 */
export function parseExpr(bodyRaw: string): Expr {
  const body = bodyRaw.trim();
  if (body === '') throw new SubstituteError('malformed expression: empty expression');

  if (isQuote(body[0])) return parseStringLiteral(body);
  if (body === 'true') return { kind: 'bool', value: true };
  if (body === 'false') return { kind: 'bool', value: false };

  const m = CALL_RE.exec(body);
  if (m) {
    const name = m[1] as string;
    const args = splitArgs(m[2] as string).map(parseExpr);
    return { kind: 'call', name, args };
  }

  if (NUM_RE.test(body)) {
    // FINITE only (#6 E6). `NUM_RE` has no exponent, but 310 digits still
    // overflow to `Infinity` — and a `num` node is typed `number` by
    // `inferExprType` unconditionally, so an infinite literal would be a value
    // whose own declared type rejects it. The grammar owns its literals: refuse
    // here rather than mint one no fn will accept.
    const value = Number(body);
    if (!Number.isFinite(value)) {
      throw new SubstituteError(
        `malformed expression: number literal '${body}' overflows to ${String(value)}`,
      );
    }
    return { kind: 'num', value };
  }
  return parseRef(body);
}

/**
 * A string literal must be a COMPLETE token: the closing quote is the LAST
 * character. A first-char/last-char check would accept `"a", "b"` and silently
 * yield the string `a", "b` — turning a typo into wrong data instead of a loud
 * error, in the security-critical resolution path.
 */
function parseStringLiteral(body: string): Expr {
  const close = quotedSpanEnd(body, 0);
  if (close === -1) {
    throw new SubstituteError(`malformed expression: unterminated string literal in '${body}'`);
  }
  if (close !== body.length - 1) {
    throw new SubstituteError(
      `malformed expression: unexpected text after the string literal in '${body}'`,
    );
  }
  return { kind: 'str', value: body.slice(1, close) };
}

/**
 * Tokenize a reference path into `segments`: `nodes.x.output.rows[params.i].sku`
 * → field nodes, field x, field output, field rows, index(ref params.i), field
 * sku. An index body is itself an expression (parsed recursively).
 *
 * A FIELD's charset is deliberately PERMISSIVE — any run of chars that is not a
 * path delimiter. Node ids and param names are `z.string().min(1)`
 * (`schemas/pipeline.ts`), i.e. ANY non-empty string, so a strict identifier
 * charset would reject `${nodes.my-node.output.text}` for a node id that is
 * legal today. An unknown namespace still fails as an unresolvable reference at
 * resolve/validate time — this tokenizer only decides SHAPE, never meaning.
 *
 * `.`, `[` and `]` are consequently RESERVED in a field name: a node whose id
 * literally contains brackets (`arr[0]`) was addressable before `[]` became
 * grammar and is now read as an index. Accepted cost of ADF-parity addressing.
 */
function parseRef(source: string): Expr {
  const segments: ExprSegment[] = [];
  let i = 0;

  const readField = (): void => {
    const start = i;
    while (i < source.length && source[i] !== '.' && source[i] !== '[' && source[i] !== ']') i += 1;
    const name = source.slice(start, i);
    if (name === '') {
      throw new SubstituteError(`malformed expression: empty path segment in '${source}'`);
    }
    segments.push({ kind: 'field', name });
  };

  // A path must START with a field (the namespace) — never `.x` or `[0]`.
  if (source[0] === '.' || source[0] === '[' || source[0] === ']') {
    throw new SubstituteError(`malformed expression: reference '${source}' must start with a name`);
  }
  readField();

  while (i < source.length) {
    const ch = source[i];
    if (ch === '.') {
      i += 1;
      readField();
    } else if (ch === '[') {
      const close = matchingBracket(source, i);
      const inner = source.slice(i + 1, close);
      if (inner.trim() === '') {
        throw new SubstituteError(`malformed expression: empty index '[]' in '${source}'`);
      }
      segments.push({ kind: 'index', expr: parseExpr(inner) });
      i = close + 1;
    } else {
      // A stray `]` — `[` is consumed with its match, so this can only be junk.
      throw new SubstituteError(`malformed expression: unexpected '${ch}' in '${source}'`);
    }
  }
  return { kind: 'ref', source, segments };
}

/** Index of the `]` matching the `[` at `openIdx` (quote- and nest-aware). */
function matchingBracket(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (isQuote(ch)) {
      const close = quotedSpanEnd(s, i);
      if (close === -1) break;
      i = close;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new SubstituteError(`malformed expression: unterminated '[' in '${s}'`);
}

/**
 * Split a call's argument list on TOP-LEVEL commas, honoring quotes, nested
 * parens and brackets — a hand tokenizer, so arbitrary code can never execute.
 * Throws on unbalanced quotes/parens/brackets.
 */
function splitArgs(s: string): string[] {
  const args: string[] = [];
  let buf = '';
  let parens = 0;
  let brackets = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (isQuote(ch)) {
      const close = quotedSpanEnd(s, i);
      if (close === -1) {
        throw new SubstituteError('malformed expression: unbalanced quotes/parens');
      }
      buf += s.slice(i, close + 1);
      i = close;
      continue;
    }
    if (ch === '(') parens += 1;
    else if (ch === ')') parens -= 1;
    else if (ch === '[') brackets += 1;
    else if (ch === ']') brackets -= 1;
    else if (ch === ',' && parens === 0 && brackets === 0) {
      args.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (parens !== 0 || brackets !== 0) {
    throw new SubstituteError('malformed expression: unbalanced quotes/parens');
  }
  const tail = buf.trim();
  if (tail || args.length) args.push(tail);
  return args;
}

// --- the `${...}` boundary scanner (SSOT: substitute + validateRefs share it) -

/** One located `${...}`: `s[start..start+1] === '${'`, `s[end] === '}'`. */
export interface RefMatch {
  start: number;
  end: number;
  body: string;
}

/**
 * Index of the `}` closing a `${` body that starts at `bodyStart` (right after
 * the opening `${`), or -1 if none closes before the end of `s`. The closer is
 * the first `}` NOT inside a quoted string (so `default(params.a, "b}c")` works).
 *
 * An unquoted `}` cannot legally appear elsewhere in a body — refs don't nest
 * and expressions have no bare braces — so a premature/stray `}` just yields a
 * body `parseExpr` rejects with a clear error (fail-loud). Deliberately NO
 * paren/bracket depth counter: a shared counter desynced on unbalanced parens
 * (`${foo(a))}`) and could swallow past the real boundary.
 *
 * This is ALSO what makes the bare-predicate rule structural (spec #6 Round-2):
 * because the body closes at the first unquoted `}`, a nested `${}` inside a
 * predicate is not expressible, so `filter`/`map`/`count` predicates are BARE
 * expressions.
 */
function findRefEnd(s: string, bodyStart: number): number {
  for (let i = bodyStart; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (isQuote(ch)) {
      const close = quotedSpanEnd(s, i);
      if (close === -1) return -1; // an unterminated quote closes nothing after it
      i = close;
    } else if (ch === '}') {
      return i;
    }
  }
  return -1;
}

/**
 * Scan `s` left-to-right for every `${...}`. `s` must already be
 * `protectEscapes`d by the caller, so a literal `${` never reaches this scan.
 * Matches are non-overlapping (scanning resumes after each closing `}`).
 *
 * `unterminatedAt` is the index of a `${` with no matching top-level `}`, or
 * `null` if every opener closed. Scanning stops at the first unterminated
 * opener — by construction there is no further unquoted `}` after it.
 */
export function scanTemplateRefs(s: string): {
  matches: RefMatch[];
  unterminatedAt: number | null;
} {
  const matches: RefMatch[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('${', i);
    if (open === -1) break;
    const end = findRefEnd(s, open + 2);
    if (end === -1) return { matches, unterminatedAt: open };
    matches.push({ start: open, end, body: s.slice(open + 2, end) });
    i = end + 1;
  }
  return { matches, unterminatedAt: null };
}

// --- #6 E2: the interpolation MODE classifier (SSOT) -------------------------

/**
 * How a field's text uses the `${}` language. Spec #6's two-mode model:
 *
 *  - `literal` — no `${}` at all. Still carries `$${` escapes to restore.
 *  - `whole` — the field is EXACTLY one `${expr}`, so the resolved value keeps
 *    its native type (`${params.n}` with n=42 yields the number 42).
 *  - `interpolated` — one or more `${}` embedded in text; every segment is
 *    string-coerced and concatenated.
 *
 * `scanned` is the PROTECTED string (escapes replaced by sentinels) that a
 * match's `start`/`end` index into. It is returned because those offsets are
 * meaningless against the raw input — a caller splicing `matches` MUST slice
 * `scanned`, never the original.
 *
 * `matches` is populated in EVERY mode (empty for `literal`, the single covering
 * match for `whole`), so a caller that just wants "every `${}` in this field,
 * whatever the mode" — the static ref-scan does — reads it here instead of
 * re-deriving the boundary scan. `whole` additionally exposes `body` for the one
 * question only it answers.
 *
 * `unterminatedAt` reports a `${` that never closed; the classifier NEVER
 * throws, because its callers hold different policies (`substitute` raises,
 * `validateRefs` collects the error and keeps checking so the canvas can badge
 * every problem at once). A field with an open brace is never `whole`.
 *
 * CAUTION: when `unterminatedAt !== null`, `matches` holds only the refs found
 * BEFORE the open brace — scanning stops there. A caller that splices `matches`
 * without checking `unterminatedAt` would silently TRUNCATE its output instead
 * of failing loudly. Check `unterminatedAt` first, always.
 */
export type TemplateMode = {
  matches: RefMatch[];
  scanned: string;
  unterminatedAt: number | null;
} & ({ mode: 'literal' } | { mode: 'whole'; body: string } | { mode: 'interpolated' });

/**
 * Classify `s`'s interpolation mode — the ONE decision `substitute` (evaluator)
 * and `validateWholeValue` (static checker) share, so they can never disagree
 * about whether a field preserves its type.
 *
 * Classifies the string AS GIVEN: trimming is deliberately the CALLER's choice.
 * Spec #6 Round-2 I1 ("mode is decided after canonical-trimming the field")
 * applies ONLY to whole-value-REQUIRED fields — `exitWhen` today, `if.condition`
 * / `foreach.items` at #4 — where a stray space demoting a boolean to the string
 * `"true"` is unambiguously a bug. Trimming HERE would instead re-type every
 * ordinary template: `"${nodes.a.output.text}\n"` is a normal prompt/file-body
 * field, and a blanket trim would flip it to whole-value mode — silently eating
 * the newline and emitting an array where a string belongs.
 */
export function interpolationMode(s: string): TemplateMode {
  const scanned = protectEscapes(s);
  const { matches, unterminatedAt } = scanTemplateRefs(scanned);
  if (unterminatedAt !== null) return { mode: 'interpolated', matches, scanned, unterminatedAt };
  if (matches.length === 0) return { mode: 'literal', matches, scanned, unterminatedAt: null };
  const only = matches[0] as RefMatch;
  if (matches.length === 1 && only.start === 0 && only.end === scanned.length - 1) {
    return { mode: 'whole', body: only.body, matches, scanned, unterminatedAt: null };
  }
  return { mode: 'interpolated', matches, scanned, unterminatedAt: null };
}
