import {
  FORMAT_TOKEN_NAMES,
  MAX_TIME_MS,
  MIN_TIME_MS,
  utcMs,
  type FormatTokenName,
} from '../engine/functions.js';
import type { DataType } from '../schemas/dataset.js';

/**
 * #996 M5 slice 1 (#1122) — the COERCION MATRIX (data-movement spec §6.2, §6.4).
 *
 * §6.2 opens with the reason this module exists: *"Under-specifying this is how
 * silent data corruption ships."* Every conversion either produces a value or
 * FAILS THE ROW with a named reason. There is no third outcome, and in
 * particular no "best effort" — the two rows the spec singles out are
 * `"1.5"` → `integer`, which FAILS rather than truncating to 1 (*"a copy that
 * quietly rounds a price column is worse than one that stops"*), and dates,
 * which parse by the DECLARED format only and are never guessed (`03/04/2026`
 * is a different day in two countries).
 *
 * PURE: no I/O, no clock, no locale. It is called per value per row in a
 * streaming pump (slice 3), so it returns a result rather than throwing —
 * per-row exceptions in a million-row copy are both a cost and a control-flow
 * smell. `engine/outputs.ts`'s `InboundOutputsResult` is the precedent for the
 * shape, including a machine-readable discriminator BESIDE the prose reason:
 * §5 makes `rowsFailed` a declared output, and a summary that can say
 * "410 not_integral, 2 unparseable_date" needs a bounded code, not unbounded
 * per-row prose.
 *
 * WHAT THIS IS NOT. `engine/params.ts`'s private `coerce` handles pipeline
 * PARAMS. The two are deliberately separate and must not be merged: a different
 * closed type set (`json`/`secret` there, `integer`/`date`/`timestamp` here),
 * and it THROWS where this reports per row. Its posture — finite-on-the-result,
 * decimal-only, fail-loud — is honoured here, and that is the right amount of
 * sharing between them.
 */

/** The machine-readable failure discriminator (§5's `rowsFailed` needs to be
 * summarisable). Bounded on purpose: a prose-only reason gives a pump unbounded
 * per-row string cardinality and nothing to aggregate or branch on. */
export type CoercionFailureCode =
  | 'unsupported_source_type'
  | 'absent_value'
  | 'not_a_number'
  | 'not_integral'
  | 'non_finite'
  | 'lossy_integer'
  | 'not_a_boolean'
  | 'no_date_format'
  | 'invalid_date_format'
  | 'unparseable_date'
  | 'date_out_of_range';

/**
 * What a coercion may PRODUCE. Declared and exported because slice 2's sink
 * writer has to bind these values and `unknown` would leave it writing casts —
 * and a cast that claims a type its value is outside of is the failure no type
 * error catches (#1114's lesson).
 *
 * `date` renders `'YYYY-MM-DD'` and `timestamp` a canonical ISO instant, both as
 * STRINGS, and `boolean` stays a JS boolean. That is store-AGNOSTIC on purpose:
 * `better-sqlite3` cannot bind a `Date` or a `boolean` at all
 * (`catalog/dataset-config.ts` records the measured `TypeError`), so the 0/1
 * encoding is the SQLite writer's job in slice 2 — putting it here would bake
 * one store's binding rules into a matrix every store shares.
 */
export type CoercedValue = string | number | bigint | boolean | null;

export type CoercionResult =
  | { ok: true; value: CoercedValue }
  | { ok: false; code: CoercionFailureCode; reason: string };

/**
 * The per-source-dataset format facts (§2.6). They are passed IN rather than
 * read from a dataset config because they live on the FILE kinds (`delimited`,
 * `excel`), whose config schemas are still `unimplementedDatasetConfigSchema`
 * until M7/M11. §2.6 states why they are absent from the SQL kinds: *"a database
 * column already has a type and a real `NULL`, so there is nothing to declare."*
 */
export interface CoercionOptions {
  /**
   * §6.4 — the dataset's NULL SENTINEL. Default: NONE, and that is the decision
   * rather than an oversight. CSV genuinely cannot distinguish `""` from absent,
   * so studio refuses to guess: by default an empty field is the empty STRING.
   * A file that uses `\N` or `NULL` declares it once, here.
   *
   * It matches a STRING source value only, and it is applied BEFORE type
   * dispatch, for every target type — so `\N` reaching a `string` column is
   * `null`, not the literal text `"\N"`.
   */
  readonly nullValue?: string;
  /**
   * §6.2 — the ONLY way a textual date is read. Absent + a `date`/`timestamp`
   * target is a refusal (`no_date_format`), never a guess. Token vocabulary is
   * `formatDateTime`'s, shared rather than reinvented (`FORMAT_TOKEN_NAMES`).
   */
  readonly dateFormat?: string;
}

const fail = (code: CoercionFailureCode, reason: string): CoercionResult => ({
  ok: false,
  code,
  reason,
});
const ok = (value: CoercedValue): CoercionResult => ({ ok: true, value });

/**
 * A DECIMAL numeric literal — optional sign, optional fraction, optional
 * exponent. Deliberately not `Number()`'s grammar: bare `Number` accepts
 * `0x10`/`0b101`/`0o7`, and silently reading `"0x10"` as 16 is exactly the
 * implicit reinterpretation §6.2 forbids. `functions.ts`'s `float` settled the
 * same question the same way; the finite check then lives on the RESULT, not on
 * the shape of the input, because 310 digits overflow a shape that looks fine
 * (`params.ts:1048`).
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** An INTEGER literal with no fraction and no exponent — the form that can be
 * read exactly by `BigInt`, so a 17-digit id survives (see `toInteger`). */
const INTEGER_RE = /^[+-]?\d+$/;

/**
 * §6.2's boolean row lists only the TRUTHY tokens (`"true"`, `"yes"`, `"1"`).
 * Read literally that leaves `"false"` failing, i.e. every `false` in a CSV
 * fails its row while every `true` copies — so this SETTLES the symmetric set as
 * an M5 decision extending §6.2, rather than shipping a matrix that can express
 * only one of a boolean's two values.
 *
 * Matched case-insensitively after trimming, which is safe in a way date parsing
 * is not: `TRUE` has exactly one meaning in every locale, whereas `03/04/2026`
 * has two. This diverges deliberately from `functions.ts`'s `bool`, which
 * accepts exact lowercase only — that reads an AUTHOR's expression literal,
 * where a typo should be loud; this reads a machine-produced data file, where
 * `TRUE` is a fact about the exporter, not a mistake.
 */
const TRUE_TOKENS: ReadonlySet<string> = new Set(['true', 'yes', '1']);
const FALSE_TOKENS: ReadonlySet<string> = new Set(['false', 'no', '0']);

/** One `dateFormat` token's parse rule: how many digits it matches and which
 * field it fills. Keyed by `FormatTokenName`, so a token added to the RENDER set
 * in `functions.ts` without a rule here is a compile error. */
interface ParseToken {
  readonly pattern: string;
  readonly field: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'ms';
}
const PARSE_TOKENS: Readonly<Record<FormatTokenName, ParseToken>> = Object.freeze({
  yyyy: { pattern: '(\\d{4})', field: 'year' },
  MM: { pattern: '(\\d{2})', field: 'month' },
  dd: { pattern: '(\\d{2})', field: 'day' },
  HH: { pattern: '(\\d{2})', field: 'hour' },
  mm: { pattern: '(\\d{2})', field: 'minute' },
  ss: { pattern: '(\\d{2})', field: 'second' },
  fff: { pattern: '(\\d{3})', field: 'ms' },
});

function isFormatToken(run: string): run is FormatTokenName {
  return (FORMAT_TOKEN_NAMES as readonly string[]).includes(run);
}

/** Escape a literal run for embedding in the assembled pattern. */
function escapeLiteral(run: string): string {
  return run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledFormat {
  readonly re: RegExp;
  readonly fields: readonly ParseToken['field'][];
}

/**
 * Compile a `dateFormat` into an anchored matcher.
 *
 * Scans runs of the SAME character, exactly as `formatDateTime` renders, so
 * `yyyyMMdd` tokenises without separators and the two directions agree by
 * construction. An alphabetic run must BE a token — an unknown one is refused
 * rather than treated as a literal, for `FORMAT_TOKENS`' own reason: silently
 * matching `yy` as text would let an author believe a format worked.
 *
 * A REPEATED token is refused too. `'yyyy-yyyy'` has no single answer when the
 * two capture different years, and picking one (first? last?) is a guess in the
 * one function whose whole contract is that it does not guess.
 */
function compileFormat(format: string): CompiledFormat | CoercionFailureCode {
  const fields: ParseToken['field'][] = [];
  const seen = new Set<string>();
  let pattern = '';
  // `[\s\S]`, not `.`, so a newline cannot split a run — `formatDateTime` uses
  // the identical expression for the identical reason.
  const runs = format.match(/([\s\S])\1*/g) ?? [];
  for (const run of runs) {
    if (!/[A-Za-z]/.test(run[0]!)) {
      pattern += escapeLiteral(run);
      continue;
    }
    if (!isFormatToken(run)) return 'invalid_date_format';
    if (seen.has(run)) return 'invalid_date_format';
    seen.add(run);
    pattern += PARSE_TOKENS[run].pattern;
    fields.push(PARSE_TOKENS[run].field);
  }
  return { re: new RegExp(`^${pattern}$`), fields };
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

/**
 * Parse a textual date through the compiled format into a UTC instant.
 *
 * Time fields default to zero; the DATE fields do not default, because a format
 * carrying no `yyyy`/`MM`/`dd` cannot name a day and defaulting one would invent
 * the fact. The assembled instant is then round-tripped against its own
 * components, which is what catches `2026-02-31` — `Date.UTC` rolls it forward
 * to 3 March rather than refusing, and a copy that silently moves a date by two
 * days is precisely the corruption this section exists to prevent.
 */
function parseWithFormat(
  text: string,
  compiled: CompiledFormat,
): { ok: true; ms: number; parts: DateParts } | { ok: false; code: CoercionFailureCode } {
  const m = compiled.re.exec(text);
  if (m === null) return { ok: false, code: 'unparseable_date' };

  const parts: DateParts = { year: -1, month: -1, day: -1, hour: 0, minute: 0, second: 0, ms: 0 };
  compiled.fields.forEach((field, i) => {
    parts[field] = Number(m[i + 1]);
  });
  if (parts.year < 0 || parts.month < 0 || parts.day < 0) {
    return { ok: false, code: 'invalid_date_format' };
  }

  // `utcMs`, not `Date.UTC`: the latter maps years 0-99 onto 1900+y, so a
  // declared `0001-01-01` would silently become 1901 and still round-trip
  // against ITSELF. Shared rather than re-corrected here — that correction is
  // invisible until something tests year 1.
  const ms = utcMs(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.ms,
  );
  const back = new Date(ms);
  const roundTrips =
    back.getUTCFullYear() === parts.year &&
    back.getUTCMonth() === parts.month - 1 &&
    back.getUTCDate() === parts.day &&
    back.getUTCHours() === parts.hour &&
    back.getUTCMinutes() === parts.minute &&
    back.getUTCSeconds() === parts.second &&
    back.getUTCMilliseconds() === parts.ms;
  if (!roundTrips) return { ok: false, code: 'unparseable_date' };
  // The same representable range `isoOf` enforces, from the same constants.
  if (ms < MIN_TIME_MS || ms > MAX_TIME_MS) return { ok: false, code: 'date_out_of_range' };
  return { ok: true, ms, parts };
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** `Date.prototype.toISOString` renders years outside 0001-9999 in expanded
 * form, and a `date` target wants the plain calendar day regardless — so build
 * it from the validated components rather than slicing an ISO string. */
function renderDate(parts: DateParts): string {
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

/**
 * A string → `integer`. Exact by construction for the plain-integer form: a
 * 17-digit id read through `Number` loses its last digit silently, which is the
 * corruption M4 spent a decision on when it opened SQLite with
 * `defaultSafeIntegers(true)`. So a plain integer literal is read with `BigInt`
 * and narrowed to `number` only when that is lossless.
 */
function integerFromString(text: string): CoercionResult {
  if (INTEGER_RE.test(text)) {
    const big = BigInt(text);
    return ok(
      big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(big)
        : big,
    );
  }
  if (!DECIMAL_RE.test(text)) {
    return fail('not_a_number', `'${text}' is not a decimal number`);
  }
  const n = Number(text);
  if (!Number.isFinite(n)) return fail('non_finite', `'${text}' is not a finite number`);
  // `"1.5"` → integer FAILS, never truncates (§6.2). `"1e2"` is integral and is
  // accepted: the refusal is about LOSING a fractional part, not about the
  // notation it was written in.
  if (!Number.isInteger(n)) return fail('not_integral', `'${text}' is not a whole number`);
  return ok(n);
}

function numberFromString(text: string): CoercionResult {
  if (!DECIMAL_RE.test(text)) return fail('not_a_number', `'${text}' is not a decimal number`);
  const n = Number(text);
  if (!Number.isFinite(n)) return fail('non_finite', `'${text}' is not a finite number`);
  return ok(n);
}

/**
 * Coerce ONE source value to ONE declared target type (§6.2).
 *
 * The INPUT domain is the union the v1 sources actually produce, not just the
 * strings §6.2's table happens to be written in: `connectors/sqlite.ts`'s
 * `SqliteValue` is `string | number | bigint | Uint8Array | null`, and §12 makes
 * SQLite→SQLite the first copy — so `bigint` and BLOBs are what arrives, and a
 * mapping's `expression` arm (§6.1) can additionally resolve to any JSON value.
 * Every one of those has an outcome below, because a matrix that is a PARTIAL
 * function over its own inputs is how the "no third outcome" rule gets broken by
 * accident.
 *
 * Two deliberate refusals worth stating, both cases §6.2 has no row for and both
 * resolved the same way — the spec's own principle that a conversion never
 * REINTERPRETS:
 *   - a container or a BLOB → `string` FAILS. `String({})` is `"[object
 *     Object]"`, a lossy stand-in that looks like data.
 *   - a real `boolean` → `integer`/`number` FAILS, and a `Date`/`bigint` →
 *     `boolean` likewise. 1/0 and truthiness are conventions, not conversions.
 */
export function coerceValue(
  value: unknown,
  target: DataType,
  opts: CoercionOptions = {},
): CoercionResult {
  // `undefined` is ABSENT, not null, and is refused rather than folded into one.
  // An absent column is a drift fact (§7); manufacturing `null` from it is the
  // same fail-open shape as #473's `.default([])`, where a missing column was
  // read back as a benign empty value and the loss became invisible.
  if (value === undefined) {
    return fail('absent_value', 'the source value is absent (no such column in the row)');
  }

  // A real SQL NULL is null for EVERY target type (§6.2's `SQL NULL` row).
  // `nullValue` is not consulted for it and could not help: §2.6 puts the
  // sentinel on the file kinds only, "because a database column already has a
  // type and a real `NULL`".
  if (value === null) return ok(null);

  // §6.4 — the sentinel, applied BEFORE type dispatch so it reaches a `string`
  // target too. Without this a dataset declaring `nullValue: '\N'` would copy
  // the literal text `"\N"` into a nullable string column.
  if (typeof value === 'string' && opts.nullValue !== undefined && value === opts.nullValue) {
    return ok(null);
  }

  switch (target) {
    case 'string':
      return toStringValue(value);
    case 'integer':
      return toInteger(value);
    case 'number':
      return toNumber(value);
    case 'boolean':
      return toBoolean(value);
    case 'date':
    case 'timestamp':
      return toInstant(value, target, opts);
  }
}

function toStringValue(value: unknown): CoercionResult {
  if (typeof value === 'string') return ok(value);
  // The CANONICAL form, never a locale one (§6.2's last row): `String(1.5)` is
  // `"1.5"` everywhere, whereas `toLocaleString` is `"1,5"` in half of Europe.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('non_finite', 'a non-finite number has no text form');
    return ok(String(value));
  }
  if (typeof value === 'bigint') return ok(value.toString());
  if (typeof value === 'boolean') return ok(value ? 'true' : 'false');
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) return fail('unparseable_date', 'an invalid Date has no text form');
    if (ms < MIN_TIME_MS || ms > MAX_TIME_MS) {
      return fail('date_out_of_range', 'the instant is outside years 0001-9999');
    }
    return ok(value.toISOString());
  }
  return fail('unsupported_source_type', `a ${describe(value)} has no declared text form`);
}

function toInteger(value: unknown): CoercionResult {
  if (typeof value === 'bigint') return ok(value); // exact; NEVER narrowed here
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('non_finite', 'the value is not a finite number');
    // A real `1.5` → integer fails for the same reason `"1.5"` does.
    if (!Number.isInteger(value)) return fail('not_integral', `${value} is not a whole number`);
    return ok(value);
  }
  if (typeof value === 'string') return integerFromString(value.trim());
  return fail('unsupported_source_type', `a ${describe(value)} is not an integer`);
}

function toNumber(value: unknown): CoercionResult {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('non_finite', 'the value is not a finite number');
    return ok(value);
  }
  if (typeof value === 'bigint') {
    // Narrowing here WOULD be lossy above 2^53, and a `number` column cannot
    // hold the exact value — so it is refused rather than rounded.
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return fail('lossy_integer', `${value} cannot be held exactly by a number column`);
    }
    return ok(Number(value));
  }
  if (typeof value === 'string') return numberFromString(value.trim());
  return fail('unsupported_source_type', `a ${describe(value)} is not a number`);
}

function toBoolean(value: unknown): CoercionResult {
  if (typeof value === 'boolean') return ok(value);
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (TRUE_TOKENS.has(t)) return ok(true);
    if (FALSE_TOKENS.has(t)) return ok(false);
    return fail('not_a_boolean', `'${value}' is not a boolean`);
  }
  // A real number is NOT truthiness-tested: `2` has no boolean meaning, and
  // accepting `1`/`0` alone would make the rule depend on which of two equally
  // numeric values arrived.
  return fail('unsupported_source_type', `a ${describe(value)} is not a boolean`);
}

function toInstant(value: unknown, target: 'date' | 'timestamp', opts: CoercionOptions) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) return fail('unparseable_date', 'the Date is invalid');
    if (ms < MIN_TIME_MS || ms > MAX_TIME_MS) {
      return fail('date_out_of_range', 'the instant is outside years 0001-9999');
    }
    return ok(target === 'date' ? value.toISOString().slice(0, 10) : value.toISOString());
  }
  if (typeof value !== 'string') {
    // A number is NOT read as epoch-ms and a bigint is not read as a day count.
    // Both would be a guess about a unit nothing declared.
    return fail('unsupported_source_type', `a ${describe(value)} is not a ${target}`);
  }
  if (opts.dateFormat === undefined) {
    return fail(
      'no_date_format',
      `a textual ${target} needs the dataset's declared dateFormat; it is never guessed`,
    );
  }
  const compiled = compileFormat(opts.dateFormat);
  if (typeof compiled === 'string') {
    return fail(compiled, `dateFormat '${opts.dateFormat}' is not a valid format`);
  }
  const parsed = parseWithFormat(value.trim(), compiled);
  if (!parsed.ok) {
    return fail(parsed.code, `'${value}' does not match dateFormat '${opts.dateFormat}'`);
  }
  return ok(target === 'date' ? renderDate(parsed.parts) : new Date(parsed.ms).toISOString());
}

/** A short, NON-ECHOING description of an unsupported source value. The type,
 * never the text: a coercion reason travels into a run log an operator reads,
 * and echoing an arbitrary value there would put source data into it — the same
 * posture `formatDateTime` takes when it reports a position rather than a run. */
function describe(value: unknown): string {
  if (value instanceof Uint8Array) return 'binary value';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Date) return 'date';
  return typeof value === 'object' ? 'structured value' : typeof value;
}
