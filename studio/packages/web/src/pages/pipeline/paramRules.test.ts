import { type Output, type Param } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import {
  blankOutput,
  blankParam,
  coerceDefaultInput,
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

describe('withRequired — the toggle means what it says', () => {
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
