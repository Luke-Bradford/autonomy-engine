import type { Expr } from './expr.js';
import { SubstituteError } from './types.js';

// ---------------------------------------------------------------------------
// #6 E4 — the CLOSED function catalog: one entry per function, and the CALLING
// CONVENTION that both the evaluator (`params.ts` `evalExpr`) and the static
// checker (`params.ts` `checkExprStatic`) read.
//
// The convention is DATA, not a name-check. Before E4 the one lazy function
// (`default`) was special-cased BY NAME in both the evaluator and the checker.
// Adding lazy `and`/`or`/`if` and the lambda-taking `filter`/`map`/`count` by
// that route would multiply the special-casing and let the two paths drift, so
// spec #6's spike-hardened block asks for a per-fn convention instead:
//
//   - `call: 'eager'`   — args are resolved, type-checked against `args`, then
//                         handed to `impl`. This is ~90% of the catalog.
//   - `call: 'special'` — the fn receives UNEVALUATED arg ASTs plus an injected
//                         evaluator, so it controls what gets evaluated and
//                         when. This is what buys SHORT-CIRCUIT (`and`/`or`/`if`),
//                         the missing-output rescue (`default`), and the
//                         per-element lambda (`filter`/`map`/`count`).
//
// SECURITY / INERTNESS: there is no `eval`, no `new Function`, and deliberately
// no `expr()` "evaluate this string" fn. The lambda forms re-evaluate an arg's
// AST with `item` rebound — they NEVER re-parse a resolved string — so a value
// carrying `${...}` text stays inert data (spec #6's no-injection guarantee).
//
// PURITY: every impl is pure and total-or-throwing. No clock, no I/O, no host
// access, no entropy — `guid`/`rand` are deliberately absent (spec #6 Round-2:
// they have no logged fact to bind to, so they would break replay). The date
// fns (E5a) hold that line by taking an EXPLICIT timestamp and working in UTC;
// `utcNow()` is NOT here, because binding it to a `node.dispatched` stamp needs
// a dispatch-handshake change (E5b) — see the catalog's date section.
// ---------------------------------------------------------------------------

/**
 * A function's declared argument/return types — the "per-fn type signature" half
 * of E4. These are load-bearing NOW: `checkArgTypes` enforces them at run time,
 * which is what makes spec #6's "no implicit type coercion beyond the explicit
 * conversion fns" non-goal an actual rule (`${add('2', 3)}` throws instead of
 * quietly yielding `5` or `'23'`).
 *
 * `array` carries NO element type. Spec #6's spike calls this out ("static typing
 * of array-forms is theatre without an array/element type") and asks for a
 * DECISION: extend the vocabulary with `array<T>`/`record<{…}>`, or state that
 * array forms are runtime-checked only. E4 takes the latter — the element shape
 * belongs to a structured output's `OutputSpec` (#2) and to E6's type inference,
 * so inventing it here would front-run both with nothing to consume it. The
 * consequence is documented and owned: a misspelled `${item.badField}` is caught
 * at RUN time (a loud throw), not at edit time. E6 owns closing that gap.
 */
export type SigType = 'string' | 'number' | 'boolean' | 'array' | 'any';

/**
 * The evaluator injected into a `special` fn. Passing this in (rather than
 * importing the evaluator) keeps the dependency one-directional —
 * `params.ts` → `functions.ts` — so the catalog never imports the module that
 * reads it.
 */
export interface EvalIn {
  /** Resolve an arg's AST in the current scope. */
  eval: (expr: Expr) => unknown;
  /**
   * Resolve an arg, rescuing ONLY an absent node output. The try/catch lives in
   * `params.ts` so the internal error class it keys on stays private to that
   * module (it is engine-internal control flow, not public API).
   */
  soft: (expr: Expr) => { ok: true; value: unknown } | { ok: false };
  /** Re-evaluate a LAMBDA arg's AST once per element, with `item` bound to it. */
  withItem: (expr: Expr, item: unknown) => unknown;
}

interface FnSpecBase {
  /** Positional arg types. With `variadic`, the LAST entry repeats. */
  args: SigType[];
  variadic?: boolean;
  /** Minimum arity. The maximum is derived: `variadic ? ∞ : args.length`. */
  minArgs: number;
  ret: SigType;
  /**
   * Arg positions that are LAMBDAS: unevaluated ASTs re-run per element with
   * `item` bound. Read by BOTH the evaluator (to bind `item`) and the static
   * checker (to decide where an `${item}` ref is legal) — one declaration, so
   * the two cannot disagree about `item`'s scope.
   */
  lambdaArgs?: number[];
  /**
   * The arg position where an absent node output is rescued — CHECKER-ONLY.
   *
   * This deliberately does NOT drive the runtime: `default` is lazy in its
   * SECOND arg too (it must not evaluate the fallback when the first arg is
   * present), so its rescue lives in `run()` and cannot be expressed as "eval
   * position N softly". The two are kept in agreement by test, not by
   * construction — an honest annotation rather than a drift guard that isn't one.
   */
  staticSoftArg?: number;
}

export type FnSpec = FnSpecBase &
  (
    | { call: 'eager'; impl: (args: unknown[]) => unknown }
    | { call: 'special'; run: (args: Expr[], ev: EvalIn) => unknown }
  );

/**
 * Cap on any array the language MATERIALISES or CONSUMES. Inertness stops
 * injection but not resource abuse: a huge `${nodes.http.output.body}` fed to
 * `map`, or a `${range(0, 2000000000)}`, would exhaust memory inside the PURE
 * reducer (spec #6 Round-2 "Resource limits"). The cap is applied to producers
 * (`range`/`createArray`/`split`/`union`/`intersection`) as well as consumers,
 * because a producer allocates before any consumer's check could fire. It is a
 * pure, deterministic bound, so replay is unaffected.
 */
export const MAX_ARRAY_ELEMENTS = 10_000;

/**
 * Cap on the TOTAL elements one field's evaluation may materialise.
 *
 * The per-array cap alone is not enough: it is per-ARRAY, so
 * `${length(map(range(0,10000), range(0,10000)))}` passes every individual
 * check (each array is exactly at the cap) while allocating 10^8 elements —
 * and a third nesting reaches 10^12. `MAX_ARRAY_ELEMENTS` therefore bounds the
 * SHAPE of any one array, and this bounds the WORK of the whole evaluation.
 *
 * Charged in `params.ts` at the one site every array-producing call funnels
 * through, so no fn can forget it. Purely a counter — deterministic, so replay
 * is unaffected.
 */
export const MAX_ARRAY_ELEMENTS_TOTAL = 100_000;

// --- shared coercion helpers (moved here from params.ts: the catalog needs them
// at module-init, and `substitute` imports `toStr` back for embedded refs) -----

/** Coerce a resolved value to a string (embedded-ref + `concat` semantics). */
export function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

/** A value `default()` treats as "missing" and replaces with its fallback. */
function isAbsent(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === false;
}

function slug(v: unknown): string {
  const s = toStr(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'x';
}

// --- runtime type enforcement (the signatures, made real) -------------------

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  // `NaN`/`Infinity` ARE `typeof 'number'`, but the `number` sig rejects them
  // (it requires a FINITE number), so reporting them as "number" yields the
  // baffling "must be a number, got number". Name the actual value instead.
  if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : String(v);
  return typeof v;
}

function matchesSig(v: unknown, t: SigType): boolean {
  switch (t) {
    case 'any':
      return true;
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
  }
}

function expect(fn: string, v: unknown, t: SigType, at: string): unknown {
  if (!matchesSig(v, t)) {
    throw new SubstituteError(`function '${fn}': ${at} must be a ${t}, got ${typeName(v)}`);
  }
  return v;
}

/** Type-check already-resolved EAGER args against the fn's signature. */
export function checkArgTypes(name: string, spec: FnSpec, args: unknown[]): void {
  args.forEach((v, i) => {
    const t =
      (spec.variadic ? (spec.args[Math.min(i, spec.args.length - 1)] ?? 'any') : spec.args[i]) ??
      'any';
    expect(name, v, t, `argument ${i + 1}`);
  });
}

/** A `special` fn's own arg check (its args are evaluated lazily, one at a time). */
function expectBool(fn: string, v: unknown, at: string): boolean {
  return expect(fn, v, 'boolean', at) as boolean;
}

function num(fn: string, v: unknown, at: string): number {
  return expect(fn, v, 'number', at) as number;
}

function str(fn: string, v: unknown, at: string): string {
  return expect(fn, v, 'string', at) as string;
}

/**
 * Type-check an array arg. Deliberately does NOT cap: `length`/`empty`/`first`/
 * `last`/`contains`/`take`/`skip` allocate nothing and must stay usable on an
 * over-cap array — `take` and `skip` are exactly how an author brings a huge
 * `${nodes.http.output.body}` back UNDER the cap, so capping them would remove
 * the only escape hatch and make an oversized array wholly unusable. Spec #6
 * Round-2 scopes the cap to the fns that LOOP or MATERIALISE (`capped`, below).
 */
function arr(fn: string, v: unknown, at: string): unknown[] {
  return expect(fn, v, 'array', at) as unknown[];
}

/** Enforce `MAX_ARRAY_ELEMENTS` on ONE array a fn loops over or materialises. */
function capped(fn: string, a: unknown[]): unknown[] {
  cap(fn, a.length);
  return a;
}

/** Enforce the single-array cap on a COUNT — before allocating, where possible. */
function cap(fn: string, n: number): number {
  if (n > MAX_ARRAY_ELEMENTS) {
    throw new SubstituteError(
      `function '${fn}': array is too large (${n} elements, cap ${MAX_ARRAY_ELEMENTS})`,
    );
  }
  return n;
}

/** An array a fn will LOOP over: type-checked AND capped. */
function loopArr(fn: string, v: unknown, at: string): unknown[] {
  return capped(fn, arr(fn, v, at));
}

/** Count non-overlapping occurrences of `sep` in `s`, allocating nothing. */
function occurrences(s: string, sep: string): number {
  let n = 0;
  for (let i = s.indexOf(sep); i !== -1; i = s.indexOf(sep, i + sep.length)) n += 1;
  return n;
}

/** The arity bounds implied by a signature. */
export function arity(spec: FnSpec): { min: number; max: number | null } {
  return { min: spec.minArgs, max: spec.variadic ? null : spec.args.length };
}

// --- ordering + equality (STRICT — no coercion) ------------------------------

/**
 * Ordered comparison over two numbers OR two strings. Mixed types THROW rather
 * than coerce: JS would happily rank `'10' < 9`, which is exactly the silent
 * nonsense spec #6's no-coercion non-goal exists to prevent.
 */
function order(fn: string, a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  throw new SubstituteError(
    `function '${fn}': arguments must be two numbers or two strings, ` +
      `got ${typeName(a)} and ${typeName(b)}`,
  );
}

/**
 * Value equality WITHOUT coercion: `equals(1, '1')` is `false`, never `true` and
 * never a throw (it must accept mixed types to answer the question at all).
 * Arrays/plain objects compare structurally so `equals(nodes.x.output.tags,
 * createArray('a'))` is answerable; everything else is identity.
 */
function deepEquals(a: unknown, b: unknown): boolean {
  // Numbers compare with `===`, NOT `Object.is`: `Object.is(-0, 0)` is false,
  // which would make `equals(mul(-1, 0), 0)` false while `greaterOrEquals` AND
  // `lessOrEquals` both say true — a silent contradiction between the equality
  // and ordering fns, reachable from data via `mul(<negative>, 0)`.
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEquals(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      ka.length === kb.length &&
      ka.every((k, i) => k === kb[i]) &&
      ka.every((k) => deepEquals(a[k], b[k]))
    );
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --- base64 (implemented in-module: `shared` is the PURE engine) -------------
// No `Buffer`, no `btoa`, no `TextEncoder`: this package's `lib` is ES2023 with
// no DOM/node types, and reaching for a host global would break spec #6's "no
// host access" rule. Hand-rolled UTF-8 + base64 keeps it pure and identical in
// browser and server.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Smallest code point each UTF-8 sequence length may legally encode (anti-overlong). */
const MIN_CP = [0, 0, 0x80, 0x800, 0x10000] as const;

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const cp = s.codePointAt(i) as number;
    if (cp > 0xffff) i += 1; // a surrogate PAIR was consumed by codePointAt
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

function utf8Str(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i] as number;
    let cp: number;
    let len: number;
    if (b0 < 0x80) [cp, len] = [b0, 1];
    else if ((b0 & 0xe0) === 0xc0) [cp, len] = [b0 & 0x1f, 2];
    else if ((b0 & 0xf0) === 0xe0) [cp, len] = [b0 & 0x0f, 3];
    else if ((b0 & 0xf8) === 0xf0) [cp, len] = [b0 & 0x07, 4];
    else throw new SubstituteError("function 'base64ToString': not valid UTF-8");
    if (i + len > bytes.length)
      throw new SubstituteError("function 'base64ToString': truncated UTF-8");
    for (let k = 1; k < len; k += 1) {
      const bk = bytes[i + k] as number;
      if ((bk & 0xc0) !== 0x80)
        throw new SubstituteError("function 'base64ToString': not valid UTF-8");
      cp = (cp << 6) | (bk & 0x3f);
    }
    // Validate the DECODED code point, not just the byte framing: an out-of-range
    // cp would otherwise escape as a raw `RangeError` from `fromCodePoint`, and
    // an overlong/surrogate encoding would silently decode to a character the
    // input did not legitimately represent.
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp < (MIN_CP[len] ?? 0)) {
      throw new SubstituteError("function 'base64ToString': not valid UTF-8");
    }
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

function base64Encode(s: string): string {
  const b = utf8Bytes(s);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const b0 = b[i] as number;
    const b1 = b[i + 1];
    const b2 = b[i + 2];
    out += B64[b0 >> 2] as string;
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)] as string;
    out += b1 === undefined ? '=' : (B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] as string);
    out += b2 === undefined ? '=' : (B64[b2 & 63] as string);
  }
  return out;
}

function base64Decode(s: string): string {
  const clean = s.replace(/=+$/, '');
  if (/[^A-Za-z0-9+/]/.test(clean)) {
    throw new SubstituteError("function 'base64ToString': not valid base64");
  }
  // A length ≡ 1 (mod 4) is structurally impossible — 6 bits cannot be a byte.
  // Without this, `base64ToString('A')` would silently return ''.
  if (clean.length % 4 === 1) {
    throw new SubstituteError("function 'base64ToString': not valid base64");
  }
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return utf8Str(bytes);
}

// --- the catalog (SSOT: extend the language by adding ONE entry here) --------

export const FUNCTIONS: Readonly<Record<string, FnSpec>> = Object.freeze({
  // -- logical / comparison --------------------------------------------------
  // `and`/`or`/`if` are `special` so they SHORT-CIRCUIT. The spike proved the
  // eager variadic form throws on `and(false, nodes.missing.output.x)` instead
  // of returning false, so a cheap guard could not protect an absent term.
  //
  // NB this is a RUN-TIME property only. The static checker still rejects a
  // non-guaranteed output in ANY arg, and that false-reject is intentional: the
  // checker cannot know arg0 is `false`, so relaxing it would equally accept
  // `and(true, nodes.a.output.v)` — a doc that validates clean and then throws
  // at run with no escape hatch. Short-circuit's real value is defending the
  // UNVALIDATED path (`validateRefs` is advisory; the server never calls it),
  // plus parity with what an author expects `and`/`if` to mean.
  and: {
    call: 'special',
    args: ['boolean'],
    variadic: true,
    minArgs: 2,
    ret: 'boolean',
    run: (args, ev) => {
      for (const [i, a] of args.entries()) {
        if (!expectBool('and', ev.eval(a), `argument ${i + 1}`)) return false;
      }
      return true;
    },
  },
  or: {
    call: 'special',
    args: ['boolean'],
    variadic: true,
    minArgs: 2,
    ret: 'boolean',
    run: (args, ev) => {
      for (const [i, a] of args.entries()) {
        if (expectBool('or', ev.eval(a), `argument ${i + 1}`)) return true;
      }
      return false;
    },
  },
  if: {
    call: 'special',
    args: ['boolean', 'any', 'any'],
    minArgs: 3,
    ret: 'any',
    run: (args, ev) => {
      const cond = expectBool('if', ev.eval(args[0] as Expr), 'argument 1');
      return ev.eval(args[cond ? 1 : 2] as Expr);
    },
  },
  not: { call: 'eager', args: ['boolean'], minArgs: 1, ret: 'boolean', impl: (a) => !a },
  equals: {
    call: 'eager',
    args: ['any', 'any'],
    minArgs: 2,
    ret: 'boolean',
    impl: (a) => deepEquals(a[0], a[1]),
  },
  greater: {
    call: 'eager',
    args: ['any', 'any'],
    minArgs: 2,
    ret: 'boolean',
    impl: (a) => order('greater', a[0], a[1]) > 0,
  },
  greaterOrEquals: {
    call: 'eager',
    args: ['any', 'any'],
    minArgs: 2,
    ret: 'boolean',
    impl: (a) => order('greaterOrEquals', a[0], a[1]) >= 0,
  },
  less: {
    call: 'eager',
    args: ['any', 'any'],
    minArgs: 2,
    ret: 'boolean',
    impl: (a) => order('less', a[0], a[1]) < 0,
  },
  lessOrEquals: {
    call: 'eager',
    args: ['any', 'any'],
    minArgs: 2,
    ret: 'boolean',
    impl: (a) => order('lessOrEquals', a[0], a[1]) <= 0,
  },

  // -- the missing-output rescue (pre-E4, kept) -------------------------------
  // Not in spec #6's v1 catalog, but LIVE today and load-bearing: it is the only
  // way to read an output that is reachable but not guaranteed. `coalesce` below
  // is the spec's null-coalescer and is deliberately NOT the same fn — `default`
  // also treats `''`/`false` as absent and rescues a MISSING output.
  default: {
    call: 'special',
    args: ['any', 'any'],
    minArgs: 2,
    ret: 'any',
    staticSoftArg: 0,
    run: (args, ev) => {
      const first = ev.soft(args[0] as Expr);
      if (!first.ok || isAbsent(first.value)) return ev.eval(args[1] as Expr);
      return first.value;
    },
  },

  // -- string ----------------------------------------------------------------
  concat: {
    call: 'eager',
    args: ['any'],
    variadic: true,
    minArgs: 1,
    ret: 'string',
    impl: (a) => a.map(toStr).join(''),
  },
  substring: {
    call: 'eager',
    args: ['string', 'number', 'number'],
    minArgs: 2,
    ret: 'string',
    impl: (a) => {
      const s = a[0] as string;
      const start = a[1] as number;
      if (start < 0) throw new SubstituteError("function 'substring': start must be >= 0");
      if (a.length === 2) return s.slice(start);
      const len = a[2] as number;
      if (len < 0) throw new SubstituteError("function 'substring': length must be >= 0");
      return s.slice(start, start + len);
    },
  },
  // Replaces EVERY occurrence (ADF parity), via split/join so the needle is
  // literal text — never a regex, which would be a code-ish surface.
  replace: {
    call: 'eager',
    args: ['string', 'string', 'string'],
    minArgs: 3,
    ret: 'string',
    impl: (a) => {
      const needle = a[1] as string;
      if (needle === '')
        throw new SubstituteError("function 'replace': the search string is empty");
      return (a[0] as string).split(needle).join(a[2] as string);
    },
  },
  split: {
    call: 'eager',
    args: ['string', 'string'],
    minArgs: 2,
    ret: 'array',
    // Bound the result BEFORE allocating: counting occurrences is a scan with no
    // allocation, whereas splitting a 200k-char string first would materialise
    // 200k strings and only then notice. Same discipline as `range`.
    impl: (a) => {
      const s = a[0] as string;
      const sep = a[1] as string;
      cap('split', sep === '' ? s.length : occurrences(s, sep) + 1);
      return s.split(sep);
    },
  },
  trim: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'string',
    impl: (a) => (a[0] as string).trim(),
  },
  toLower: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'string',
    impl: (a) => (a[0] as string).toLowerCase(),
  },
  toUpper: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'string',
    impl: (a) => (a[0] as string).toUpperCase(),
  },
  startsWith: {
    call: 'eager',
    args: ['string', 'string'],
    minArgs: 2,
    ret: 'boolean',
    impl: (a) => (a[0] as string).startsWith(a[1] as string),
  },
  endsWith: {
    call: 'eager',
    args: ['string', 'string'],
    minArgs: 2,
    ret: 'boolean',
    impl: (a) => (a[0] as string).endsWith(a[1] as string),
  },
  indexOf: {
    call: 'eager',
    args: ['string', 'string'],
    minArgs: 2,
    ret: 'number',
    impl: (a) => (a[0] as string).indexOf(a[1] as string),
  },
  lastIndexOf: {
    call: 'eager',
    args: ['string', 'string'],
    minArgs: 2,
    ret: 'number',
    impl: (a) => (a[0] as string).lastIndexOf(a[1] as string),
  },
  slug: { call: 'eager', args: ['any'], minArgs: 1, ret: 'string', impl: (a) => slug(a[0]) },

  // -- collection ------------------------------------------------------------
  // `length`/`empty`/`contains`/`first`/`last` are overloaded over string|array
  // (ADF parity), so their sig is `any` and the impl dispatches on the shape.
  length: {
    call: 'eager',
    args: ['any'],
    minArgs: 1,
    ret: 'number',
    impl: (a) => sized('length', a[0]).length,
  },
  empty: {
    call: 'eager',
    args: ['any'],
    minArgs: 1,
    ret: 'boolean',
    impl: (a) => sized('empty', a[0]).length === 0,
  },
  contains: {
    call: 'eager',
    args: ['any', 'any'],
    minArgs: 2,
    ret: 'boolean',
    impl: (a) => {
      const c = a[0];
      if (typeof c === 'string') return c.includes(str('contains', a[1], 'argument 2'));
      return loopArr('contains', c, 'argument 1').some((x) => deepEquals(x, a[1]));
    },
  },
  first: {
    call: 'eager',
    args: ['any'],
    minArgs: 1,
    ret: 'any',
    impl: (a) => at('first', a[0], 0),
  },
  last: { call: 'eager', args: ['any'], minArgs: 1, ret: 'any', impl: (a) => at('last', a[0], -1) },
  take: {
    call: 'eager',
    args: ['array', 'number'],
    minArgs: 2,
    ret: 'array',
    impl: (a) => arr('take', a[0], 'argument 1').slice(0, count0('take', a[1])),
  },
  skip: {
    call: 'eager',
    args: ['array', 'number'],
    minArgs: 2,
    ret: 'array',
    impl: (a) => arr('skip', a[0], 'argument 1').slice(count0('skip', a[1])),
  },
  join: {
    call: 'eager',
    args: ['array', 'string'],
    minArgs: 2,
    ret: 'string',
    impl: (a) =>
      loopArr('join', a[0], 'argument 1')
        .map(toStr)
        .join(a[1] as string),
  },
  intersection: {
    call: 'eager',
    args: ['array'],
    variadic: true,
    minArgs: 2,
    ret: 'array',
    impl: (a) => {
      const [head, ...rest] = a.map((x, i) => loopArr('intersection', x, `argument ${i + 1}`));
      return capped(
        'intersection',
        (head as unknown[]).filter((x) => rest.every((o) => o.some((y) => deepEquals(x, y)))),
      );
    },
  },
  union: {
    call: 'eager',
    args: ['array'],
    variadic: true,
    minArgs: 2,
    ret: 'array',
    impl: (a) => {
      const out: unknown[] = [];
      for (const [i, x] of a.entries()) {
        for (const el of loopArr('union', x, `argument ${i + 1}`)) {
          if (!out.some((y) => deepEquals(el, y))) out.push(el);
          // Check INSIDE the loop: `union` is variadic, so N args each at the
          // cap would accumulate N × cap before a post-hoc check could fire.
          cap('union', out.length);
        }
      }
      return out;
    },
  },
  createArray: {
    call: 'eager',
    args: ['any'],
    variadic: true,
    minArgs: 1,
    ret: 'array',
    impl: (a) => capped('createArray', [...a]),
  },
  // A PRODUCER: cap BEFORE allocating, or `range(0, 2e9)` OOMs the reducer.
  range: {
    call: 'eager',
    args: ['number', 'number'],
    minArgs: 2,
    ret: 'array',
    impl: (a) => {
      const start = a[0] as number;
      const n = count0('range', a[1]);
      if (n > MAX_ARRAY_ELEMENTS) {
        throw new SubstituteError(
          `function 'range': array is too large (${n} elements, cap ${MAX_ARRAY_ELEMENTS})`,
        );
      }
      return Array.from({ length: n }, (_, i) => start + i);
    },
  },

  // -- array forms (the lambda convention) -----------------------------------
  // The predicate/projection is a BARE expression, not a nested `${}` — the
  // grammar makes that structural (a `${}` body closes at the first unquoted
  // `}`), so `filter(rows, greater(item.score, 5))` is the only expressible
  // shape. Its AST is re-evaluated per element with `item` bound; a resolved
  // string is never re-parsed, which is what keeps the array forms inert.
  filter: {
    call: 'special',
    args: ['array', 'any'],
    minArgs: 2,
    ret: 'array',
    lambdaArgs: [1],
    run: (args, ev) =>
      loopArr('filter', ev.eval(args[0] as Expr), 'argument 1').filter((el) =>
        expectBool('filter', ev.withItem(args[1] as Expr, el), 'the predicate'),
      ),
  },
  map: {
    call: 'special',
    args: ['array', 'any'],
    minArgs: 2,
    ret: 'array',
    lambdaArgs: [1],
    run: (args, ev) =>
      loopArr('map', ev.eval(args[0] as Expr), 'argument 1').map((el) =>
        ev.withItem(args[1] as Expr, el),
      ),
  },
  // Arity-overloaded (the spike): `count(arr)` is a length, `count(arr, pred)`
  // is a conditional tally.
  count: {
    call: 'special',
    args: ['array', 'any'],
    minArgs: 1,
    ret: 'number',
    lambdaArgs: [1],
    run: (args, ev) => {
      const a = loopArr('count', ev.eval(args[0] as Expr), 'argument 1');
      if (args.length === 1) return a.length;
      return a.filter((el) =>
        expectBool('count', ev.withItem(args[1] as Expr, el), 'the predicate'),
      ).length;
    },
  },
  sum: {
    call: 'eager',
    args: ['array'],
    minArgs: 1,
    ret: 'number',
    impl: (a) => numbers('sum', a[0]).reduce((x, y) => x + y, 0),
  },
  avg: {
    call: 'eager',
    args: ['array'],
    minArgs: 1,
    ret: 'number',
    impl: (a) => {
      const ns = numbers('avg', a[0]);
      if (ns.length === 0) throw new SubstituteError("function 'avg': the array is empty");
      return ns.reduce((x, y) => x + y, 0) / ns.length;
    },
  },

  // -- conversion ------------------------------------------------------------
  string: { call: 'eager', args: ['any'], minArgs: 1, ret: 'string', impl: (a) => toStr(a[0]) },
  int: {
    call: 'eager',
    args: ['any'],
    minArgs: 1,
    ret: 'number',
    impl: (a) => {
      const v = a[0];
      if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
      if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v.trim());
      throw new SubstituteError(`function 'int': cannot convert ${typeName(v)} to an integer`);
    },
  },
  float: {
    call: 'eager',
    args: ['any'],
    minArgs: 1,
    ret: 'number',
    impl: (a) => {
      const v = a[0];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      // A DECIMAL literal only: bare `Number()` accepts `0x10`/`0b101`/`0o7`,
      // which is exactly the implicit reinterpretation this language forbids.
      if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(v)) return Number(v);
      throw new SubstituteError(`function 'float': cannot convert ${typeName(v)} to a number`);
    },
  },
  bool: {
    call: 'eager',
    args: ['any'],
    minArgs: 1,
    ret: 'boolean',
    impl: (a) => {
      const v = a[0];
      if (typeof v === 'boolean') return v;
      if (v === 'true') return true;
      if (v === 'false') return false;
      if (typeof v === 'number' && Number.isFinite(v)) return v !== 0;
      throw new SubstituteError(`function 'bool': cannot convert ${typeName(v)} to a boolean`);
    },
  },
  array: {
    call: 'eager',
    args: ['any'],
    minArgs: 1,
    ret: 'array',
    // Not capped: it materialises nothing new (an array arg passes straight
    // through), and a wrapped scalar is exactly one element.
    impl: (a) => (Array.isArray(a[0]) ? a[0] : [a[0]]),
  },
  // Parses TEXT into DATA. The result is never rescanned, even if a parsed value
  // is itself the string `"${secret}"` (spec #6 Round-2) — `substitute` does not
  // re-enter, so there is no `expr()` by the back door.
  json: {
    call: 'eager',
    args: ['any'],
    minArgs: 1,
    ret: 'any',
    impl: (a) => {
      if (typeof a[0] !== 'string') return a[0];
      try {
        return JSON.parse(a[0]) as unknown;
      } catch {
        throw new SubstituteError("function 'json': the value is not valid JSON");
      }
    },
  },
  // The spec's null-coalescer: FIRST non-null/undefined. Narrower than
  // `default` on purpose — `''` and `false` are values here, not absences.
  coalesce: {
    call: 'eager',
    args: ['any'],
    variadic: true,
    minArgs: 1,
    ret: 'any',
    impl: (a) => a.find((v) => v !== null && v !== undefined) ?? null,
  },
  base64: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'string',
    impl: (a) => base64Encode(a[0] as string),
  },
  base64ToString: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'string',
    impl: (a) => base64Decode(a[0] as string),
  },
  encodeUriComponent: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'string',
    impl: (a) => encodeURIComponent(a[0] as string),
  },
  decodeUriComponent: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'string',
    impl: (a) => {
      try {
        return decodeURIComponent(a[0] as string);
      } catch {
        throw new SubstituteError("function 'decodeUriComponent': malformed percent-encoding");
      }
    },
  },

  // -- math ------------------------------------------------------------------
  add: {
    call: 'eager',
    args: ['number', 'number'],
    minArgs: 2,
    ret: 'number',
    impl: (a) => (a[0] as number) + (a[1] as number),
  },
  sub: {
    call: 'eager',
    args: ['number', 'number'],
    minArgs: 2,
    ret: 'number',
    impl: (a) => (a[0] as number) - (a[1] as number),
  },
  mul: {
    call: 'eager',
    args: ['number', 'number'],
    minArgs: 2,
    ret: 'number',
    impl: (a) => (a[0] as number) * (a[1] as number),
  },
  div: {
    call: 'eager',
    args: ['number', 'number'],
    minArgs: 2,
    ret: 'number',
    impl: (a) => {
      if ((a[1] as number) === 0) throw new SubstituteError("function 'div': division by zero");
      return (a[0] as number) / (a[1] as number);
    },
  },
  mod: {
    call: 'eager',
    args: ['number', 'number'],
    minArgs: 2,
    ret: 'number',
    impl: (a) => {
      if ((a[1] as number) === 0) throw new SubstituteError("function 'mod': division by zero");
      return (a[0] as number) % (a[1] as number);
    },
  },
  min: {
    call: 'eager',
    args: ['number'],
    variadic: true,
    minArgs: 1,
    ret: 'number',
    impl: (a) => Math.min(...(a as number[])),
  },
  max: {
    call: 'eager',
    args: ['number'],
    variadic: true,
    minArgs: 1,
    ret: 'number',
    impl: (a) => Math.max(...(a as number[])),
  },

  // -- date (#6 E5a) ---------------------------------------------------------
  // Every one takes an EXPLICIT timestamp and works in UTC — no clock, no host
  // timezone, no tzdata — so the family is pure and replay-identical.
  // `${run.startedAt}` (E3) is the run-stable source.
  //
  // THREE fns from spec #6's line-75 list are deliberately ABSENT, each because
  // it fails a non-negotiable rather than because it was forgotten (recorded as
  // deviations in the spec, per the precedent E4 set for `slug`/`default`):
  //
  //   - `utcNow()` — E5b. It must bind the driver-stamped `node.dispatched`
  //     time, but the reducer resolves node config in `prepInput` at the
  //     `pending→ready` transition, BEFORE any dispatch stamp exists (and
  //     `node.dispatched` carries no timestamp field at all). Binding it needs a
  //     change to the dispatch handshake, which is crash-safety-critical.
  //   - `ticks()` — 100ns units since 0001-01-01 is ~6.4e17 today, far above
  //     `Number.MAX_SAFE_INTEGER`. It would PASS the `number` signature and then
  //     be silently wrong below the second (`sub(ticks(b), ticks(a))` over a 1ms
  //     gap yields 9984, not 10000). Silent wrongness is worse than absence.
  //   - `convertTimeZone()` — needs a tz database. `Intl` supplies one, but it
  //     is the HOST's ICU data: it varies by Node build and mutates as
  //     governments change DST rules, so folding one log on two hosts could
  //     diverge — breaking replay-safety. (Same call as the hand-rolled base64:
  //     the pure engine does not reach for host facilities.)
  formatDateTime: {
    call: 'eager',
    args: ['string', 'string'],
    minArgs: 2,
    ret: 'string',
    impl: (a) => formatDateTime('formatDateTime', a),
  },
  addDays: {
    call: 'eager',
    args: ['string', 'number'],
    minArgs: 2,
    ret: 'string',
    impl: (a) => addFixed('addDays', a, FIXED_UNIT_MS['Day'] as number),
  },
  addHours: {
    call: 'eager',
    args: ['string', 'number'],
    minArgs: 2,
    ret: 'string',
    impl: (a) => addFixed('addHours', a, FIXED_UNIT_MS['Hour'] as number),
  },
  addMinutes: {
    call: 'eager',
    args: ['string', 'number'],
    minArgs: 2,
    ret: 'string',
    impl: (a) => addFixed('addMinutes', a, FIXED_UNIT_MS['Minute'] as number),
  },
  addSeconds: {
    call: 'eager',
    args: ['string', 'number'],
    minArgs: 2,
    ret: 'string',
    impl: (a) => addFixed('addSeconds', a, FIXED_UNIT_MS['Second'] as number),
  },
  addToTime: {
    call: 'eager',
    args: ['string', 'number', 'string'],
    minArgs: 3,
    ret: 'string',
    impl: (a) => shiftBy('addToTime', a, 1),
  },
  subtractFromTime: {
    call: 'eager',
    args: ['string', 'number', 'string'],
    minArgs: 3,
    ret: 'string',
    impl: (a) => shiftBy('subtractFromTime', a, -1),
  },
  startOfDay: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'string',
    impl: (a) => startOf('startOfDay', a, 'day'),
  },
  startOfHour: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'string',
    impl: (a) => startOf('startOfHour', a, 'hour'),
  },
  startOfMonth: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'string',
    impl: (a) => startOf('startOfMonth', a, 'month'),
  },
  // 0=Sunday — ADF parity, and what `triggers/run-window.ts` already reads via
  // `getUTCDay()`. A different numbering here would ship two weekday
  // conventions in one product.
  dayOfWeek: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'number',
    impl: (a) => new Date(parseTs('dayOfWeek', a[0], 'argument 1')).getUTCDay(),
  },
  dayOfMonth: {
    call: 'eager',
    args: ['string'],
    minArgs: 1,
    ret: 'number',
    impl: (a) => new Date(parseTs('dayOfMonth', a[0], 'argument 1')).getUTCDate(),
  },
});

// --- impl helpers for the overloaded collection fns --------------------------

/**
 * A string or an array — the two things `length`/`empty` accept. NOT capped:
 * asking an over-cap array how long it is must WORK, or the author cannot even
 * write the guard (`if(greater(length(x), 10000), …)`) that avoids the cap.
 */
function sized(fn: string, v: unknown): { length: number } {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v;
  throw new SubstituteError(
    `function '${fn}': argument 1 must be a string or an array, got ${typeName(v)}`,
  );
}

/** `first`/`last` over a string or array; an empty collection yields `null`. */
function at(fn: string, v: unknown, idx: 0 | -1): unknown {
  if (typeof v === 'string') {
    if (v.length === 0) return null;
    return idx === 0 ? v[0] : v[v.length - 1];
  }
  const a = arr(fn, v, 'argument 1');
  if (a.length === 0) return null;
  return idx === 0 ? a[0] : a[a.length - 1];
}

/** An array whose elements must ALL be numbers (`sum`/`avg`). */
function numbers(fn: string, v: unknown): number[] {
  return capped(fn, arr(fn, v, 'argument 1')).map((x, i) => num(fn, x, `element ${i + 1}`));
}

/** A non-negative integer count/index. */
function count0(fn: string, v: unknown): number {
  const n = num(fn, v, 'argument 2');
  if (!Number.isInteger(n) || n < 0) {
    throw new SubstituteError(`function '${fn}': the count must be a non-negative integer`);
  }
  return n;
}

// --- dates (#6 E5a) ----------------------------------------------------------
//
// Every date fn takes an EXPLICIT timestamp and works in UTC. That is what keeps
// the family pure: no clock, no host timezone, no tz database — so folding a run
// log twice, on any host, yields the same value (spec #6's replay-safety
// invariant). `${run.startedAt}` (E3) is the run-stable source; `utcNow()` is
// E5b, and the two fns needing a tz/exact-long are recorded deviations — see the
// catalog's date section.
//
// These are the first `Date` uses in the pure engine. `Date` is used ONLY as
// UTC calendar arithmetic over an explicit instant — never `new Date()`,
// never `Date.now()`, never a local-time getter.

/**
 * The one accepted timestamp shape: ISO-8601 date-time with an EXPLICIT offset.
 *
 * Deliberately strict, because `new Date(s)` is not: it reads an offset-less
 * `2026-07-15T10:30:00` as LOCAL time (host-dependent) and accepts
 * implementation-defined free text like `July 4, 2026`. Either would make a
 * resolved value depend on the host — the replay hazard spec #6 forbids. The
 * accept-set can be WIDENED later back-compatibly; it could not be narrowed.
 */
const ISO_TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The representable range: year 0001 through 9999 (.NET `DateTime`'s range).
 *
 * Bounded to 4-digit years so every value this module RETURNS is re-parseable by
 * `ISO_TS_RE` — outside it `toISOString()` emits an expanded form
 * (`+275760-09-13T…`) that our own parser would then reject, silently breaking
 * composition (`addDays(addDays(t, n), 1)`).
 */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, month0: number): number {
  return month0 === 1 && isLeapYear(y) ? 29 : (DAYS_IN_MONTH[month0] as number);
}

/**
 * `Date.UTC` for a full year — it maps years 0-99 to 1900+y, which would turn
 * `0026-01-01` into 1926. Corrected via `setUTCFullYear`, which does not.
 */
function utcMs(
  y: number,
  month1: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
): number {
  const t = Date.UTC(y, month1 - 1, d, h, mi, s, ms);
  if (y >= 0 && y < 100) {
    const dt = new Date(t);
    dt.setUTCFullYear(y);
    return dt.getTime();
  }
  return t;
}

const MIN_TIME_MS = utcMs(1, 1, 1, 0, 0, 0, 0);
const MAX_TIME_MS = utcMs(9999, 12, 31, 23, 59, 59, 999);

/** Parse an accepted timestamp to epoch-ms, or throw. */
function parseTs(fn: string, v: unknown, at: string): number {
  const s = str(fn, v, at);
  const m = ISO_TS_RE.exec(s);
  // Never echo the value: a misconfigured doc may have routed a secret here, and
  // `SubstituteError` messages are client-safe by contract (`types.ts`).
  const refuse = (why: string): never => {
    throw new SubstituteError(`function '${fn}': ${at} ${why}`);
  };
  if (m === null) {
    return refuse(
      "must be an ISO-8601 timestamp with an explicit offset, like '2026-07-15T10:30:00Z' " +
        "or '2026-07-15T10:30:00+01:00'",
    );
  }
  const [y, mo, d, h, mi, s2] = m.slice(1, 7).map((x) => Number(x)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // Sub-millisecond precision is TRUNCATED, not refused: real APIs emit
  // microseconds (RFC3339 allows any number of digits) and a `Date` is
  // millisecond-resolution, so refusing them would make these fns unusable on an
  // ordinary HTTP output. The loss is the representation's own limit.
  const ms = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3));
  if (mo < 1 || mo > 12) return refuse('has a month outside 1-12');
  if (h > 23 || mi > 59 || s2 > 59) return refuse('has a time outside 00:00:00-23:59:59');
  if (d < 1 || d > daysInMonth(y, mo - 1))
    return refuse('has a day that does not exist in its month');
  const offset = m[8] as string;
  let offsetMs = 0;
  if (offset !== 'Z') {
    const sign = offset.startsWith('-') ? -1 : 1;
    const digits = offset.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4));
    if (oh > 23 || om > 59) return refuse('has an offset outside ±23:59');
    offsetMs = sign * (oh * 3600000 + om * 60000);
  }
  const t = utcMs(y, mo, d, h, mi, s2, ms) - offsetMs;
  // The range is checked HERE, not only in `isoOf`, so it holds of INPUTS as
  // well as results. `\d{4}` admits year 0000, which is outside the range — and
  // only the fns that RENDER a timestamp pass through `isoOf`, so without this
  // `addDays('0000-01-01T00:00:00Z', 1)` refused while
  // `dayOfWeek('0000-01-01T00:00:00Z')` answered 6 and `formatDateTime` emitted
  // '0000-01-01'. One boundary, one rule.
  if (t < MIN_TIME_MS || t > MAX_TIME_MS) {
    return refuse('is outside the representable range (only years 0001-9999)');
  }
  return t;
}

/** Render epoch-ms back to the canonical shape, refusing an unrepresentable instant. */
function isoOf(fn: string, ms: number): string {
  if (!Number.isFinite(ms) || ms < MIN_TIME_MS || ms > MAX_TIME_MS) {
    throw new SubstituteError(
      `function '${fn}': the result is out of range (only years 0001-9999 are representable)`,
    );
  }
  return new Date(ms).toISOString();
}

/**
 * A whole-number interval. Fractions are refused rather than truncated:
 * `addDays(t, 0.5)` reads as "half a day" but would silently floor to zero —
 * `addHours(t, 12)` says what it means.
 */
function interval(fn: string, v: unknown): number {
  const n = num(fn, v, 'argument 2');
  if (!Number.isInteger(n)) {
    throw new SubstituteError(`function '${fn}': argument 2 must be a whole number of units`);
  }
  return n;
}

/** `addDays`/`addHours`/`addMinutes`/`addSeconds` — one fixed-width unit each. */
function addFixed(fn: string, a: unknown[], unitMs: number): string {
  return isoOf(fn, parseTs(fn, a[0], 'argument 1') + interval(fn, a[1]) * unitMs);
}

/** Fixed-width units, in ms. Month/Year are NOT here — they are calendar units. */
const FIXED_UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  Second: 1000,
  Minute: 60_000,
  Hour: 3_600_000,
  Day: 86_400_000,
  Week: 604_800_000,
});

/** The closed `addToTime`/`subtractFromTime` unit vocabulary (ADF's names). */
const TIME_UNITS = ['Second', 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year'] as const;

/**
 * Add whole months, CLAMPING to the end of a short month — .NET `AddMonths`
 * semantics. `2026-01-31 + 1 Month` has no exact answer; clamping yields
 * Feb 28 (Feb 29 in a leap year), where naive ms arithmetic would overflow into
 * March and silently skip a month.
 */
function addMonths(ms: number, n: number): number {
  const dt = new Date(ms);
  const total = dt.getUTCFullYear() * 12 + dt.getUTCMonth() + n;
  const y = Math.floor(total / 12);
  const month0 = total - y * 12;
  const day = Math.min(dt.getUTCDate(), daysInMonth(y, month0));
  return utcMs(
    y,
    month0 + 1,
    day,
    dt.getUTCHours(),
    dt.getUTCMinutes(),
    dt.getUTCSeconds(),
    dt.getUTCMilliseconds(),
  );
}

/** The shared body of `addToTime` (`sign` 1) and `subtractFromTime` (`sign` -1). */
function shiftBy(fn: string, a: unknown[], sign: 1 | -1): string {
  const ms = parseTs(fn, a[0], 'argument 1');
  const n = sign * interval(fn, a[1]);
  const unit = str(fn, a[2], 'argument 3');
  if (!(TIME_UNITS as readonly string[]).includes(unit)) {
    throw new SubstituteError(
      `function '${fn}': argument 3 must be one of ${TIME_UNITS.join(', ')} (case-sensitive)`,
    );
  }
  if (unit === 'Month') return isoOf(fn, addMonths(ms, n));
  if (unit === 'Year') return isoOf(fn, addMonths(ms, n * 12));
  return isoOf(fn, ms + n * (FIXED_UNIT_MS[unit] as number));
}

/** `startOfDay`/`startOfHour`/`startOfMonth` — zero everything below the unit. */
function startOf(fn: string, a: unknown[], unit: 'month' | 'day' | 'hour'): string {
  const dt = new Date(parseTs(fn, a[0], 'argument 1'));
  return isoOf(
    fn,
    utcMs(
      dt.getUTCFullYear(),
      dt.getUTCMonth() + 1,
      unit === 'month' ? 1 : dt.getUTCDate(),
      unit === 'hour' ? dt.getUTCHours() : 0,
      0,
      0,
      0,
    ),
  );
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * The CLOSED `formatDateTime` token set. Each renders a UTC field.
 *
 * Closed + reject-unknown, like `float`'s decimal-only regex and `replace`'s
 * literal needle: emitting an unimplemented .NET token (`yy`) raw would hand the
 * author `yy-07-15` and let them believe it worked.
 */
const FORMAT_TOKENS: Readonly<Record<string, (d: Date) => string>> = Object.freeze({
  yyyy: (d) => pad(d.getUTCFullYear(), 4),
  MM: (d) => pad(d.getUTCMonth() + 1, 2),
  dd: (d) => pad(d.getUTCDate(), 2),
  HH: (d) => pad(d.getUTCHours(), 2),
  mm: (d) => pad(d.getUTCMinutes(), 2),
  ss: (d) => pad(d.getUTCSeconds(), 2),
  fff: (d) => pad(d.getUTCMilliseconds(), 3),
});

/**
 * Render an instant through the closed token set.
 *
 * Scans runs of the SAME character (.NET's convention), so `yyyyMMdd`
 * tokenises without separators. An alphabetic run must BE a token; anything
 * else passes through literally. There is deliberately no quoted-literal
 * syntax — the format arg is already inside a `${}` string literal, and the ISO
 * shape needs no formatting (values ARE ISO), so anything richer composes with
 * `concat(formatDateTime(t,'yyyy-MM-dd'), ' at ', formatDateTime(t,'HH:mm'))`.
 */
function formatDateTime(fn: string, a: unknown[]): string {
  const dt = new Date(parseTs(fn, a[0], 'argument 1'));
  const format = str(fn, a[1], 'argument 2');
  let out = '';
  for (let i = 0; i < format.length;) {
    const ch = format[i] as string;
    let j = i;
    while (j < format.length && format[j] === ch) j += 1;
    const run = format.slice(i, j);
    if (/[A-Za-z]/.test(ch)) {
      const token = FORMAT_TOKENS[run];
      if (token === undefined) {
        throw new SubstituteError(
          `function '${fn}': '${run}' is not a format token ` +
            `(the closed set is ${Object.keys(FORMAT_TOKENS).join(', ')}; ` +
            'letters cannot appear literally — assemble with concat)',
        );
      }
      out += token(dt);
    } else {
      out += run;
    }
    i = j;
  }
  return out;
}

/** Every catalog name, sorted — for diagnostics and allowlist assertions. */
export function listFunctions(): string[] {
  return Object.keys(FUNCTIONS).sort();
}
