import { resolveRunParams, type Output, type Param, type ParamType } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import {
  blankOutput,
  blankParam,
  coerceDefaultInput,
  defaultAdvisory,
  formatDefaultInput,
  nameIssues,
  withRequired,
} from './paramRules';

function param(over: Partial<Param> = {}): Param {
  return { name: 'p', type: 'string', required: false, ...over };
}

function output(over: Partial<Output> = {}): Output {
  return { name: 'o', type: 'string', ...over };
}

describe('blankParam / blankOutput', () => {
  it('mints a name that is free', () => {
    expect(blankParam([]).name).toBe('param_1');
    expect(blankOutput([]).name).toBe('output_1');
  });

  it('skips names already taken, so a fresh row never lands on the gate', () => {
    const taken = [param({ name: 'param_1' }), param({ name: 'param_2' })];
    expect(blankParam(taken).name).toBe('param_3');
  });

  it('steps past a gap rather than reusing it, so two adds never collide', () => {
    // `param_2` is free, but minting it would collide the moment the operator
    // renames `param_1` back. Counting from the length is the stable rule.
    expect(blankParam([param({ name: 'param_1' }), param({ name: 'param_3' })]).name).toBe(
      'param_4',
    );
  });

  it('mints a param that is optional and has no default', () => {
    const p = blankParam([]);
    expect(p.required).toBe(false);
    expect('default' in p).toBe(false);
  });

  it('mints an output with no `optional` key, which the schema reads as required', () => {
    expect('optional' in blankOutput([])).toBe(false);
  });
});

describe('nameIssues — the save gate', () => {
  it('passes a clean set', () => {
    expect(nameIssues([param({ name: 'a' })], [output({ name: 'b' })])).toEqual([]);
  });

  it('reports a duplicate param name in the SERVER’s words', () => {
    // Matching `refuseDuplicateNames` verbatim (schemas/pipeline.ts) is the
    // point: this gate exists to spare a round-trip to a refusal, so it must
    // not invent a second vocabulary for the same rejection.
    expect(nameIssues([param({ name: 'a' }), param({ name: 'a' })], [])).toEqual([
      "duplicate param name 'a' (param names must be unique within the pipeline)",
    ]);
  });

  it('reports a duplicate output name', () => {
    expect(nameIssues([], [output({ name: 'x' }), output({ name: 'x' })])).toEqual([
      "duplicate output name 'x' (output names must be unique within the pipeline)",
    ]);
  });

  it('does NOT collide a param with an output of the same name', () => {
    // Separate namespaces in the schema — `${params.x}` and an output `x` are
    // different things, and refusing that would block a legal doc.
    expect(nameIssues([param({ name: 'x' })], [output({ name: 'x' })])).toEqual([]);
  });

  it('reports an empty name by position, since it has no name to quote', () => {
    expect(nameIssues([param({ name: 'a' }), param({ name: '' })], [])).toEqual([
      'param #2 has no name',
    ]);
  });

  it('treats a whitespace-only name as empty', () => {
    expect(nameIssues([param({ name: '   ' })], [])).toEqual(['param #1 has no name']);
  });

  it('reports every offender, not just the first', () => {
    const issues = nameIssues(
      [param({ name: '' }), param({ name: 'b' }), param({ name: 'b' })],
      [output({ name: '' })],
    );
    expect(issues).toHaveLength(3);
  });
});

describe('defaultAdvisory — non-gating, and it mirrors run-time `coerce`', () => {
  it('says nothing about a param with no default', () => {
    expect(defaultAdvisory(param({ type: 'number' }))).toBeNull();
  });

  it('DOES flag a required param that carries a bad default', () => {
    // The correction of a wrong belief. `resolveRunParams` reads
    // `hasOwnProperty(p,'default')` BEFORE `p.required`, so a required param
    // holding a default resolves from it and never demands an override — the
    // run fails on it exactly as it would for an optional param. An earlier cut
    // returned null here and said nothing about a doc that cannot run.
    expect(defaultAdvisory(param({ type: 'number', required: true, default: 'nope' }))).toContain(
      'finite number',
    );
  });

  it('still says nothing about a required param with NO default', () => {
    expect(defaultAdvisory(param({ type: 'number', required: true }))).toBeNull();
  });

  it('accepts a numeric STRING for a number param, because `coerce` does', () => {
    // engine/params.ts `coerce` accepts /^-?\d+(\.\d+)?$/. Advising against a
    // default that runs fine would be a false alarm.
    expect(defaultAdvisory(param({ type: 'number', default: '5' }))).toBeNull();
    expect(defaultAdvisory(param({ type: 'number', default: -2.5 }))).toBeNull();
  });

  it('flags a number default that is not a number at all', () => {
    expect(defaultAdvisory(param({ type: 'number', default: 'abc' }))).toContain('finite number');
  });

  it('flags a non-finite number, which `coerce` refuses', () => {
    expect(defaultAdvisory(param({ type: 'number', default: Infinity }))).toContain(
      'finite number',
    );
  });

  it("accepts the strings 'true'/'false' for a boolean, because `coerce` does", () => {
    expect(defaultAdvisory(param({ type: 'boolean', default: 'true' }))).toBeNull();
    expect(defaultAdvisory(param({ type: 'boolean', default: false }))).toBeNull();
  });

  it('flags a boolean default that is neither', () => {
    expect(defaultAdvisory(param({ type: 'boolean', default: 'yes' }))).toContain('boolean');
  });

  it('flags a non-string default on a string param', () => {
    expect(defaultAdvisory(param({ type: 'string', default: 7 }))).toContain('string');
  });

  it('accepts anything for a json param, because `coerce` returns it as-is', () => {
    expect(defaultAdvisory(param({ type: 'json', default: { a: [1] } }))).toBeNull();
    expect(defaultAdvisory(param({ type: 'json', default: 'anything' }))).toBeNull();
  });

  it('flags a secret default that breaks the credential-label charset', () => {
    expect(defaultAdvisory(param({ type: 'secret', default: 'has space' }))).toContain('label');
  });

  it('accepts a well-formed secret label', () => {
    expect(defaultAdvisory(param({ type: 'secret', default: 'openai.key_1-A' }))).toBeNull();
  });

  it('flags a secret label over 64 characters', () => {
    expect(defaultAdvisory(param({ type: 'secret', default: 'a'.repeat(65) }))).toContain('label');
  });
});

describe('coerceDefaultInput — the form field text becomes a TYPED doc value', () => {
  it('reads blank as "no default" for every type', () => {
    for (const t of ['string', 'number', 'boolean', 'json', 'secret'] as const) {
      expect(coerceDefaultInput(t, '   ')).toEqual({ ok: true, has: false });
    }
  });

  it('stores a number as a NUMBER, not the typed text', () => {
    // The doc keeps a properly typed default, so `${params.n}` types as number
    // downstream rather than depending on run-time coercion of a string.
    expect(coerceDefaultInput('number', ' 42 ')).toEqual({ ok: true, has: true, value: 42 });
  });

  it('refuses a number field that is not a number', () => {
    const r = coerceDefaultInput('number', 'abc');
    expect(r.ok).toBe(false);
  });

  it('refuses a number that overflows to Infinity', () => {
    expect(coerceDefaultInput('number', '1e400').ok).toBe(false);
  });

  it('stores a boolean as a BOOLEAN', () => {
    expect(coerceDefaultInput('boolean', 'true')).toEqual({ ok: true, has: true, value: true });
    expect(coerceDefaultInput('boolean', 'false')).toEqual({ ok: true, has: true, value: false });
  });

  it('parses json, keeping structure', () => {
    expect(coerceDefaultInput('json', '{"a":[1,2]}')).toEqual({
      ok: true,
      has: true,
      value: { a: [1, 2] },
    });
  });

  it('refuses malformed json instead of storing the raw text', () => {
    expect(coerceDefaultInput('json', '{oops').ok).toBe(false);
  });

  it('keeps a string verbatim, including inner spaces', () => {
    expect(coerceDefaultInput('string', ' hello world ')).toEqual({
      ok: true,
      has: true,
      value: ' hello world ',
    });
  });

  it('refuses a secret whose text is not a credential label', () => {
    expect(coerceDefaultInput('secret', 'not a label!').ok).toBe(false);
  });

  it('accepts a valid secret label, trimmed', () => {
    expect(coerceDefaultInput('secret', ' my.key ')).toEqual({
      ok: true,
      has: true,
      value: 'my.key',
    });
  });
});

describe('formatDefaultInput — round-trips a stored default back into the field', () => {
  it('shows nothing for an absent default', () => {
    expect(formatDefaultInput(undefined)).toBe('');
  });

  it('shows a string as itself, NOT json-quoted', () => {
    expect(formatDefaultInput('hi')).toBe('hi');
  });

  it('shows numbers and booleans plainly', () => {
    expect(formatDefaultInput(42)).toBe('42');
    expect(formatDefaultInput(true)).toBe('true');
  });

  it('shows a structured default as json', () => {
    expect(formatDefaultInput({ a: 1 })).toBe('{"a":1}');
  });

  it('round-trips every type through coerce → format unchanged', () => {
    expect(coerceDefaultInput('number', formatDefaultInput(42))).toEqual({
      ok: true,
      has: true,
      value: 42,
    });
    expect(coerceDefaultInput('json', formatDefaultInput({ a: 1 }))).toEqual({
      ok: true,
      has: true,
      value: { a: 1 },
    });
  });
});

describe('withRequired — the schema contract that `default` is optional-only', () => {
  it('DELETES the default when a param becomes required', () => {
    // ParamSchema: "Only meaningful when `required` is false; omitted entirely
    // otherwise." Keeping it would mint a doc field the schema calls meaningless.
    const next = withRequired(param({ required: false, default: 'x' }), true);
    expect(next.required).toBe(true);
    expect('default' in next).toBe(false);
  });

  it('leaves the default alone when a param becomes optional', () => {
    const next = withRequired(param({ required: true }), false);
    expect(next.required).toBe(false);
    expect('default' in next).toBe(false);
  });

  it('does not mutate the input', () => {
    const p = param({ required: false, default: 'x' });
    withRequired(p, true);
    expect(p.default).toBe('x');
  });
});

/**
 * The advisory claims to mirror run-time `coerce`. `coerce` is private, so that
 * agreement used to be asserted only in prose — which is exactly how two copies
 * of a rule drift apart without a test noticing.
 *
 * This runs both sides over one table: `defaultAdvisory` (web) and
 * `resolveRunParams` (the real engine, exported from shared). A row where one
 * says "fine" and the other throws is a divergence, whichever way round.
 */
describe('defaultAdvisory agrees with the ENGINE, not just with its own comment', () => {
  const CASES: { type: ParamType; value: unknown }[] = [
    { type: 'number', value: 42 },
    { type: 'number', value: -2.5 },
    { type: 'number', value: '5' },
    { type: 'number', value: ' 7 ' },
    { type: 'number', value: 'abc' },
    { type: 'number', value: Infinity },
    { type: 'number', value: true },
    { type: 'number', value: '1e400' },
    { type: 'boolean', value: true },
    { type: 'boolean', value: false },
    { type: 'boolean', value: 'true' },
    { type: 'boolean', value: 'false' },
    { type: 'boolean', value: 'yes' },
    { type: 'boolean', value: 1 },
    { type: 'string', value: 'hi' },
    { type: 'string', value: '' },
    { type: 'string', value: 7 },
    { type: 'string', value: null },
    { type: 'json', value: { a: 1 } },
    { type: 'json', value: [1, 2] },
    { type: 'json', value: 'anything' },
    { type: 'json', value: 5 },
    { type: 'secret', value: 'my.key_1-A' },
    { type: 'secret', value: 'has space' },
    { type: 'secret', value: 'a'.repeat(65) },
    { type: 'secret', value: 42 },
  ];

  for (const { type, value } of CASES) {
    it(`${type} default ${JSON.stringify(value) ?? String(value)}`, () => {
      const p: Param = { name: 'x', type, required: false, default: value };

      let engineRejects = false;
      try {
        resolveRunParams({ params: [p] }, {});
      } catch {
        engineRejects = true;
      }

      expect(defaultAdvisory(p) !== null).toBe(engineRejects);
    });
  }
});
