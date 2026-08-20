import { describe, expect, it } from 'vitest';
import { coerceValue, type CoercionFailureCode } from './coerce.js';
import { DataTypeSchema, type DataType } from '../schemas/dataset.js';

/**
 * #996 M5 slice 1 (#1122) — the §6.2 coercion matrix, pinned cell by cell.
 *
 * The table is keyed by (source value KIND × target type), not by the example
 * strings §6.2 happens to be written in. Every input in the spec's table but one
 * is a string, so a suite built from those rows alone would never exercise
 * `bigint`, `Uint8Array`, `boolean`, `Date`, `undefined` or a container — and
 * `connectors/sqlite.ts`'s `SqliteValue` proves the first two are exactly what a
 * SQLite→SQLite copy (§12's first) actually hands over.
 *
 * Every refusal asserts its CODE, never just `ok === false`: a bare falsity
 * assertion passes for an implementation that refuses everything, and passes
 * when the refusal is for the wrong reason.
 */

const TARGETS = DataTypeSchema.options;

/** Assert a successful coercion produced exactly `value`. */
function expectOk(result: ReturnType<typeof coerceValue>, value: unknown): void {
  expect(result).toEqual({ ok: true, value });
}
/** Assert a refusal, BY CODE. */
function expectFail(result: ReturnType<typeof coerceValue>, code: CoercionFailureCode): void {
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.code).toBe(code);
}

describe('coerceValue — §6.2, the two rows that carry the risk', () => {
  it('"1.5" to integer FAILS rather than truncating to 1', () => {
    expectFail(coerceValue('1.5', 'integer'), 'not_integral');
    expectFail(coerceValue(1.5, 'integer'), 'not_integral');
    expectOk(coerceValue('1.5', 'number'), 1.5);
  });

  it('a date is NEVER guessed — no declared dateFormat is a refusal', () => {
    expectFail(coerceValue('03/04/2026', 'date'), 'no_date_format');
    expectFail(coerceValue('2026-04-03', 'timestamp'), 'no_date_format');
    // The same input is a different day under two declared formats, which is
    // the whole reason guessing is refused.
    expectOk(coerceValue('03/04/2026', 'date', { dateFormat: 'dd/MM/yyyy' }), '2026-04-03');
    expectOk(coerceValue('03/04/2026', 'date', { dateFormat: 'MM/dd/yyyy' }), '2026-03-04');
  });
});

describe('coerceValue — §6.2 string sources', () => {
  it('"42" reaches integer, number and string, but not boolean or date', () => {
    expectOk(coerceValue('42', 'integer'), 42n);
    expectOk(coerceValue('42', 'number'), 42);
    expectOk(coerceValue('42', 'string'), '42');
    expectFail(coerceValue('42', 'boolean'), 'not_a_boolean');
    expectFail(coerceValue('42', 'date'), 'no_date_format');
  });

  it('overflow is non-finite, and fails integer AND number', () => {
    expectFail(coerceValue('1e400', 'integer'), 'non_finite');
    expectFail(coerceValue('1e400', 'number'), 'non_finite');
    expectOk(coerceValue('1e400', 'string'), '1e400');
  });

  it('only "1" reaches integer/number from the boolean-ish tokens', () => {
    expectOk(coerceValue('1', 'integer'), 1n);
    expectOk(coerceValue('1', 'number'), 1);
    expectFail(coerceValue('true', 'integer'), 'not_a_number');
    expectFail(coerceValue('yes', 'number'), 'not_a_number');
  });

  it('boolean tokens are symmetric, so a CSV can carry false at all', () => {
    for (const t of ['true', 'yes', '1', 'TRUE', ' True ']) {
      expectOk(coerceValue(t, 'boolean'), true);
    }
    for (const f of ['false', 'no', '0', 'FALSE', ' No ']) {
      expectOk(coerceValue(f, 'boolean'), false);
    }
    expectFail(coerceValue('maybe', 'boolean'), 'not_a_boolean');
  });

  it('the numeric grammar is DECIMAL — a hex string is not silently reinterpreted', () => {
    expectFail(coerceValue('0x10', 'integer'), 'not_a_number');
    expectFail(coerceValue('0b101', 'number'), 'not_a_number');
    expectFail(coerceValue('1_000', 'integer'), 'not_a_number');
    expectFail(coerceValue('Infinity', 'number'), 'not_a_number');
    expectFail(coerceValue('NaN', 'number'), 'not_a_number');
    // an integral exponent form IS a whole number, and is accepted
    expectOk(coerceValue('1e2', 'integer'), 100n);
  });

  it('signed and zero-padded integer literals are read exactly, and never throw', () => {
    // The BigInt path is the one place in this module that could throw rather
    // than return, which would take down a whole pump on one bad row. `BigInt`'s
    // string grammar is NOT `Number`'s — so what `INTEGER_RE` admits is pinned
    // against what `BigInt` accepts, rather than assumed to agree.
    expectOk(coerceValue('+42', 'integer'), 42n);
    expectOk(coerceValue('-42', 'integer'), -42n);
    expectOk(coerceValue('007', 'integer'), 7n);
    expectOk(coerceValue('+007', 'integer'), 7n);
    expectOk(coerceValue('-0', 'integer'), 0n);
    expectOk(coerceValue('+9007199254740993', 'integer'), 9007199254740993n);
    // The sign survives into the other targets too.
    expectOk(coerceValue('+1.5', 'number'), 1.5);
    expectOk(coerceValue('+42', 'string'), '+42');
    // A lone sign is not an integer, and is refused rather than reaching BigInt.
    expectFail(coerceValue('+', 'integer'), 'not_a_number');
    expectFail(coerceValue('-', 'integer'), 'not_a_number');
  });

  it('nothing in the matrix THROWS — every input kind returns a result', () => {
    // The never-throw contract, asserted rather than described: a throw from one
    // row crashes the pump instead of failing that row.
    const hostile: readonly unknown[] = [
      '+42',
      '-',
      '+',
      '.',
      '1e',
      '--1',
      '0x',
      ''.padEnd(400, '9'),
      '9'.repeat(400),
      Symbol('s'),
      () => 1,
      new Map(),
    ];
    for (const value of hostile) {
      for (const target of TARGETS) {
        expect(() => coerceValue(value, target, { dateFormat: 'yyyy-MM-dd' })).not.toThrow();
      }
    }
  });

  it('a 17-digit id survives as an exact bigint rather than losing its last digit', () => {
    expectOk(coerceValue('9007199254740993', 'integer'), 9007199254740993n);
    expect(Number('9007199254740993')).toBe(9007199254740992); // the loss, demonstrated
    expectOk(coerceValue('9007199254740991', 'integer'), 9007199254740991n);
  });
});

describe('coerceValue — §6.4 nullValue, and the "" cell it governs', () => {
  it('with NO sentinel declared, "" is the empty STRING and fails every other target', () => {
    expectOk(coerceValue('', 'string'), '');
    // `Number('')` is 0 — a manufactured zero is exactly what this must not do.
    expectFail(coerceValue('', 'integer'), 'not_a_number');
    expectFail(coerceValue('', 'number'), 'not_a_number');
    expectFail(coerceValue('', 'boolean'), 'not_a_boolean');
    expectFail(coerceValue('', 'date'), 'no_date_format');
  });

  it('a declared sentinel is null for EVERY target, including string', () => {
    const opts = { nullValue: '\\N' };
    for (const target of TARGETS) expectOk(coerceValue('\\N', target, opts), null);
  });

  it('the sentinel matches EXACTLY — a non-sentinel value under the same opts is untouched', () => {
    const opts = { nullValue: '\\N' };
    expectOk(coerceValue('hello', 'string', opts), 'hello');
    expectOk(coerceValue('\\n', 'string', opts), '\\n');
    expectOk(coerceValue(' \\N ', 'string', opts), ' \\N ');
    expectOk(coerceValue('7', 'integer', opts), 7n);
  });

  it('an empty sentinel is what makes "" null — and only then', () => {
    expectOk(coerceValue('', 'integer', { nullValue: '' }), null);
    expectOk(coerceValue('', 'string', { nullValue: '' }), null);
  });
});

describe('coerceValue — SQL NULL and an ABSENT value are different facts', () => {
  it('null is null for every target', () => {
    for (const target of TARGETS) expectOk(coerceValue(null, target), null);
  });

  it('undefined is REFUSED, never folded into null', () => {
    for (const target of TARGETS) expectFail(coerceValue(undefined, target), 'absent_value');
  });

  it('a sentinel does not rescue a SQL NULL into anything else', () => {
    expectOk(coerceValue(null, 'string', { nullValue: 'NULL' }), null);
  });
});

describe('coerceValue — the int64 bound on integer (#1155)', () => {
  /**
   * The bound is [-2^63, 2^63-1] — measured against better-sqlite3 12.11.1,
   * which throws `RangeError: The bound string, buffer, or bigint is too big`
   * outside it. Before the bound, that RangeError escaped from inside the
   * sink's open transaction and killed the WHOLE copy.
   *
   * The matrix is ASYMMETRIC BY ARM and must be written that way, because the
   * `number` arm cannot express the top of the range: `2**63 - 1` is not a
   * representable double and has already rounded UP to `2**63` before
   * `coerceValue` is called. Asserting `coerceValue(2**63 - 1, 'integer')`
   * succeeds would be asserting a falsehood.
   */
  it('a bigint at either end of int64 is accepted, and one step past is refused', () => {
    expectOk(coerceValue(2n ** 63n - 1n, 'integer'), 2n ** 63n - 1n);
    expectOk(coerceValue(-(2n ** 63n), 'integer'), -(2n ** 63n));
    expectFail(coerceValue(2n ** 63n, 'integer'), 'integer_out_of_range');
    expectFail(coerceValue(-(2n ** 63n) - 1n, 'integer'), 'integer_out_of_range');
  });

  it('a string at either end of int64 is exact, and one step past is refused', () => {
    expectOk(coerceValue('9223372036854775807', 'integer'), 2n ** 63n - 1n);
    expectOk(coerceValue('-9223372036854775808', 'integer'), -(2n ** 63n));
    expectFail(coerceValue('9223372036854775808', 'integer'), 'integer_out_of_range');
    expectFail(coerceValue('-9223372036854775809', 'integer'), 'integer_out_of_range');
  });

  it('a number is bounded at the largest DOUBLE inside int64, not at int64 itself', () => {
    // 2**63 - 1024 is the largest integral double <= MAX_INT64.
    expectOk(coerceValue(2 ** 63 - 1024, 'integer'), 9223372036854774784n);
    expectOk(coerceValue(-(2 ** 63), 'integer'), -(2n ** 63n)); // exactly representable
    expectFail(coerceValue(2 ** 63, 'integer'), 'integer_out_of_range');
    expectFail(coerceValue(-(2 ** 63) - 2048, 'integer'), 'integer_out_of_range');
    expectFail(coerceValue(1e20, 'integer'), 'integer_out_of_range');
  });

  it('the range verdict never displaces a more precise one', () => {
    // #1155 A5: the bound comes LAST, so these keep the verdict that describes
    // them better rather than collapsing into a range answer.
    expectFail(coerceValue('1e400', 'integer'), 'non_finite');
    expectFail(coerceValue(Infinity, 'integer'), 'non_finite');
    expectFail(coerceValue('1.5', 'integer'), 'not_integral');
    expectFail(coerceValue(1.5, 'integer'), 'not_integral');
  });

  it('an out-of-range value is still a NUMBER, so the number target still takes it', () => {
    // The bound is on the `integer` DOMAIN, not on the value being unusable.
    expectOk(coerceValue(1e20, 'number'), 1e20);
  });
});

describe('coerceValue — the input domain a SQLite source actually produces', () => {
  it('a bigint is exact into integer, and refused where it would round', () => {
    expectOk(coerceValue(9007199254740993n, 'integer'), 9007199254740993n);
    expectOk(coerceValue(42n, 'number'), 42);
    expectFail(coerceValue(9007199254740993n, 'number'), 'lossy_integer');
    expectOk(coerceValue(9007199254740993n, 'string'), '9007199254740993');
    expectFail(coerceValue(1n, 'boolean'), 'unsupported_source_type');
    expectFail(coerceValue(1n, 'timestamp'), 'unsupported_source_type');
  });

  it('a BLOB has no declared form and is refused for EVERY target, string included', () => {
    const blob = new Uint8Array([0xde, 0xad]);
    for (const target of TARGETS) expectFail(coerceValue(blob, target), 'unsupported_source_type');
  });

  it('a real number renders canonically to string and never via a locale', () => {
    expectOk(coerceValue(1.5, 'string'), '1.5');
    expectOk(coerceValue(-0.25, 'string'), '-0.25');
    expectOk(coerceValue(1.5, 'number'), 1.5);
    expectFail(coerceValue(Number.POSITIVE_INFINITY, 'number'), 'non_finite');
    expectFail(coerceValue(Number.NaN, 'string'), 'non_finite');
  });

  it('a real boolean is itself, is text, and is NOT 1/0', () => {
    expectOk(coerceValue(true, 'boolean'), true);
    expectOk(coerceValue(false, 'string'), 'false');
    expectFail(coerceValue(true, 'integer'), 'unsupported_source_type');
    expectFail(coerceValue(true, 'number'), 'unsupported_source_type');
  });

  it('a container is refused everywhere — never "[object Object]"', () => {
    // Reachable through a mapping row's `expression` arm (§6.1), which resolves
    // to arbitrary JSON.
    for (const target of TARGETS) {
      expectFail(coerceValue({ a: 1 }, target), 'unsupported_source_type');
      expectFail(coerceValue([1, 2], target), 'unsupported_source_type');
    }
    expect(String({ a: 1 })).toBe('[object Object]'); // what is being refused
  });

  it('a Date passes into date/timestamp/string and nothing else', () => {
    const d = new Date('2026-08-19T10:30:00.000Z');
    expectOk(coerceValue(d, 'date'), '2026-08-19');
    expectOk(coerceValue(d, 'timestamp'), '2026-08-19T10:30:00.000Z');
    expectOk(coerceValue(d, 'string'), '2026-08-19T10:30:00.000Z');
    expectFail(coerceValue(d, 'integer'), 'unsupported_source_type');
    expectFail(coerceValue(d, 'boolean'), 'unsupported_source_type');
    expectFail(coerceValue(new Date(Number.NaN), 'timestamp'), 'unparseable_date');
  });
});

describe('coerceValue — dateFormat parses over formatDateTime vocabulary', () => {
  it('reads every token, without separators too', () => {
    expectOk(
      coerceValue('2026-08-19 10:30:05.250', 'timestamp', {
        dateFormat: 'yyyy-MM-dd HH:mm:ss.fff',
      }),
      '2026-08-19T10:30:05.250Z',
    );
    expectOk(coerceValue('20260819', 'date', { dateFormat: 'yyyyMMdd' }), '2026-08-19');
  });

  it('a time-only format cannot name a day, and is refused rather than defaulted', () => {
    expectFail(coerceValue('10:30', 'date', { dateFormat: 'HH:mm' }), 'invalid_date_format');
  });

  it('an unknown token is refused, not treated as a literal', () => {
    // `yy` renders nowhere in studio; accepting it as text would hand the author
    // a date that silently contains the letters "yy".
    expectFail(coerceValue('26-08-19', 'date', { dateFormat: 'yy-MM-dd' }), 'invalid_date_format');
  });

  it('a repeated token is refused rather than resolved by a guess', () => {
    expectFail(
      coerceValue('2026-2026', 'date', { dateFormat: 'yyyy-yyyy' }),
      'invalid_date_format',
    );
  });

  it('a date that does not exist is refused, NOT rolled forward', () => {
    // `Date.UTC(2026, 1, 31)` is 3 March — a silent two-day move.
    expectFail(coerceValue('2026-02-31', 'date', { dateFormat: 'yyyy-MM-dd' }), 'unparseable_date');
    expectOk(coerceValue('2024-02-29', 'date', { dateFormat: 'yyyy-MM-dd' }), '2024-02-29');
    expectFail(coerceValue('2026-13-01', 'date', { dateFormat: 'yyyy-MM-dd' }), 'unparseable_date');
    expectFail(
      coerceValue('2026-08-19T10:30:00Z', 'date', { dateFormat: 'yyyy-MM-dd' }),
      'unparseable_date',
    );
  });

  it('the representable range is the one isoOf enforces — years 0001-9999', () => {
    expectOk(coerceValue('0001-01-01', 'date', { dateFormat: 'yyyy-MM-dd' }), '0001-01-01');
    expectOk(coerceValue('9999-12-31', 'date', { dateFormat: 'yyyy-MM-dd' }), '9999-12-31');
    expectFail(
      coerceValue('0000-12-31', 'date', { dateFormat: 'yyyy-MM-dd' }),
      'date_out_of_range',
    );
  });

  it('date truncates the instant while timestamp keeps it', () => {
    const opts = { dateFormat: 'yyyy-MM-dd HH:mm:ss' };
    expectOk(coerceValue('2026-08-19 23:59:59', 'date', opts), '2026-08-19');
    expectOk(coerceValue('2026-08-19 23:59:59', 'timestamp', opts), '2026-08-19T23:59:59.000Z');
  });
});

describe('coerceValue — every (input kind x target) pair has an outcome', () => {
  const INPUTS: readonly { label: string; value: unknown }[] = [
    { label: 'string', value: 'x' },
    { label: 'numeric string', value: '7' },
    { label: 'empty string', value: '' },
    { label: 'number', value: 3 },
    { label: 'fractional number', value: 3.5 },
    { label: 'bigint', value: 3n },
    { label: 'boolean', value: true },
    { label: 'Date', value: new Date('2026-01-01T00:00:00.000Z') },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'blob', value: new Uint8Array([1]) },
    { label: 'object', value: {} },
    { label: 'array', value: [] },
  ];

  it.each(INPUTS)('$label is decided for every target — value or named code', ({ value }) => {
    for (const target of TARGETS) {
      const r = coerceValue(value, target, { dateFormat: 'yyyy-MM-dd' });
      if (r.ok) {
        // The output domain slice 2's sink writer binds against.
        expect(['string', 'number', 'bigint', 'boolean', 'object']).toContain(typeof r.value);
        if (typeof r.value === 'object') expect(r.value).toBeNull();
      } else {
        expect(typeof r.code).toBe('string');
        expect(r.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('NO refusal reason echoes the source value — every kind, every target', () => {
    // The container path was never the risk. §6.1's `expression` arm can resolve
    // a SECRET to a string, and a secret need only fail a numeric or boolean
    // coercion — the ordinary paths — to be written verbatim into a reason that
    // lands in a run log. So the rule is asserted across the whole grid, not on
    // the one arm that happens to describe rather than quote.
    const SECRET = 'sk-live-abcdef0123456789';
    const carriers: readonly unknown[] = [
      SECRET,
      { token: SECRET },
      [SECRET],
      new Uint8Array([1, 2]),
    ];
    for (const value of carriers) {
      for (const target of TARGETS) {
        for (const opts of [{}, { dateFormat: 'yyyy-MM-dd' }, { nullValue: 'NULL' }]) {
          const r = coerceValue(value, target, opts);
          if (!r.ok) expect(r.reason).not.toContain('sk-live');
        }
      }
    }
  });

  it('a refusal reason quotes no source text at all, only the declared format', () => {
    // Stronger than the secret probe above and not satisfiable by redaction: a
    // reason may name the AUTHORED dateFormat (config, not data) and nothing else.
    const probes: readonly unknown[] = [
      'ZZmarkerZZ',
      12345.678,
      98765n,
      // #1155: in-range values never reach the range arm, so without this the
      // probe could not catch an `integer_out_of_range` reason that echoed.
      2n ** 64n,
      new Uint8Array([7]),
    ];
    for (const value of probes) {
      for (const target of TARGETS) {
        const r = coerceValue(value, target, { dateFormat: 'yyyy-MM-dd' });
        if (!r.ok) {
          expect(r.reason).not.toContain('ZZmarker');
          expect(r.reason).not.toContain('12345');
          expect(r.reason).not.toContain('98765');
          expect(r.reason).not.toContain('18446744073709551616');
        }
      }
    }
  });

  it('a memoised dateFormat gives the identical answer on the second call', () => {
    // The compile cache must be indistinguishable in the result — a hit and a
    // miss agree, and a BAD format stays bad rather than being cached as good.
    const opts = { dateFormat: 'dd/MM/yyyy' };
    expectOk(coerceValue('03/04/2026', 'date', opts), '2026-04-03');
    expectOk(coerceValue('03/04/2026', 'date', opts), '2026-04-03');
    expectFail(coerceValue('2026-04-03', 'date', opts), 'unparseable_date');
    const bad = { dateFormat: 'yy-MM-dd' };
    expectFail(coerceValue('26-04-03', 'date', bad), 'invalid_date_format');
    expectFail(coerceValue('26-04-03', 'date', bad), 'invalid_date_format');
    // A different format is still compiled on its own terms after the cache is hot.
    expectOk(coerceValue('03/04/2026', 'date', { dateFormat: 'MM/dd/yyyy' }), '2026-03-04');
  });

  it('eviction cannot corrupt a later answer — 40 distinct formats, then a fresh one', () => {
    // NOT a test of the bound itself: the cache size is deliberately not
    // observable through the public API, so this cannot and does not assert that
    // eviction HAPPENED (it passes with the `clear()` removed — checked). What it
    // pins is the property that matters to a caller: crossing the bound leaves
    // results unchanged. The bound is a leak guard, and its evidence is the
    // `FORMAT_CACHE_MAX` constant, not an assertion.
    for (let i = 0; i < 40; i++) {
      const sep = String.fromCharCode(33 + i); // 40 distinct literal separators
      coerceValue(`2026${sep}08${sep}19`, 'date', { dateFormat: `yyyy${sep}MM${sep}dd` });
    }
    expectOk(coerceValue('2026-08-19', 'date', { dateFormat: 'yyyy-MM-dd' }), '2026-08-19');
  });

  it('every DataType in the closed set is handled — no target falls through', () => {
    // Pins the exhaustiveness: a type added to `DataTypeSchema` with no arm
    // would return `undefined` here rather than a result.
    const targets: readonly DataType[] = TARGETS;
    for (const target of targets) {
      expect(coerceValue('x', target, { dateFormat: 'yyyy-MM-dd' })).toHaveProperty('ok');
    }
  });
});

/**
 * #1150 — an `integer` target must produce a value SQLite stores as INTEGER.
 *
 * The declared type exists to choose a STORAGE CLASS, and better-sqlite3 binds
 * every JS `number` as REAL regardless of integrality — measured on 12.11.1:
 * binding `42` and asking `typeof()` back gives `real`, and into a TEXT column
 * it lands as the string `"42.0"`. Only a `bigint` binds as INTEGER.
 *
 * So narrowing a whole number to `number` here is not an optimisation, it is the
 * corruption: a copy declared `integer` silently writes a different value than
 * the one it read. `CoercedValue` already admits `bigint` and `SinkValue`
 * extends it, so nothing downstream needs a new shape to carry this.
 *
 * Asserted with `typeof`, not against a literal: `toEqual` treats `42n` and `42`
 * as different, but a test that only compared values would still pass if a later
 * change reintroduced the narrowing for some inputs and not others.
 */
describe('#1150 — an integer target binds as SQLite INTEGER', () => {
  const integral = ['42', '0', '-7', '9007199254740993', '1e2'];

  it('yields a bigint for every integral source, whatever its notation', () => {
    for (const source of integral) {
      const result = coerceValue(source, 'integer');
      expect(result.ok, `'${source}' should coerce`).toBe(true);
      expect(
        result.ok === true && typeof result.value,
        `'${source}' must bind as INTEGER, so it must be a bigint`,
      ).toBe('bigint');
    }
  });

  it('yields a bigint for a real JS number source too', () => {
    /* The source side of a SQLite→SQLite copy hands over JS numbers, so this is
       the path an operator actually hits, not a synthetic one. */
    const result = coerceValue(42, 'integer');
    expect(result.ok === true && typeof result.value).toBe('bigint');
    expect(result.ok === true && result.value).toBe(42n);
  });

  it('still refuses a fractional value rather than truncating', () => {
    /* The fix must not widen what `integer` ACCEPTS — only what it produces. */
    expectFail(coerceValue('1.5', 'integer'), 'not_integral');
    expectFail(coerceValue(1.5, 'integer'), 'not_integral');
  });

  it('leaves `number` targets as JS numbers', () => {
    /* `number` means REAL; only `integer` changes. A blanket bigint would break
       the other half of the matrix. */
    expect(coerceValue('42', 'number')).toEqual({ ok: true, value: 42 });
  });
});

/**
 * #1156 — an exponent-form integer must be read EXACTLY, at any width.
 *
 * The plain form (`INTEGER_RE`) has always gone through `BigInt(text)` and is
 * exact. The decimal/exponent fallback went through `Number(text)` first — a
 * double — so an integral value above 2^53 was ROUNDED before `BigInt` ever saw
 * it, and the last digit was silently gone.
 *
 * The same corruption class as #1150 and invisible for the same reason: the
 * value is well inside int64, so the range bound (#1155) does not catch it, and
 * the result is a plausible number that is not the one in the source.
 *
 * Asserted against the exact decimal, not against `BigInt(Number(...))`, which
 * would restate the defect and pass against it.
 */
describe('#1156 — exponent form is exact, not routed through a double', () => {
  it('keeps every digit of an integral value above 2^53', () => {
    // 9007199254740993 = 2^53 + 1: the smallest integer a double cannot hold.
    expect(coerceValue('9.007199254740993e15', 'integer')).toEqual({
      ok: true,
      value: 9007199254740993n,
    });
  });

  it('agrees with the plain form for the same value written both ways', () => {
    /* The notation is not supposed to change the value. This is the property the
       two arms exist to share, and the one the double broke. */
    const plain = coerceValue('9007199254740993', 'integer');
    const exponent = coerceValue('9.007199254740993e15', 'integer');
    expect(exponent).toEqual(plain);
  });

  it('still refuses a fractional exponent form rather than truncating', () => {
    /* `1.5e0` is 1.5. Reading exactly must not become reading leniently. */
    expectFail(coerceValue('1.5e0', 'integer'), 'not_integral');
    expectFail(coerceValue('1.23e1', 'integer'), 'not_integral');
  });

  it('still accepts an integral exponent form, and a negative one', () => {
    expect(coerceValue('1e2', 'integer')).toEqual({ ok: true, value: 100n });
    expect(coerceValue('-1e2', 'integer')).toEqual({ ok: true, value: -100n });
    expect(coerceValue('1.5e1', 'integer')).toEqual({ ok: true, value: 15n });
  });

  it('leaves `number` targets on the double path — only `integer` is exact', () => {
    expect(coerceValue('1e2', 'number')).toEqual({ ok: true, value: 100 });
  });
});
