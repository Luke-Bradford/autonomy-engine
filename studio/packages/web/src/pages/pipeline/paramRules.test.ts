import { type Output, type Param, type VariableDef } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import {
  blankOutput,
  blankParam,
  blankVariable,
  coerceDefaultInput,
  coerceGlobalValue,
  coerceVariableDefault,
  formatDefaultInput,
  formatVariableDefault,
  nameIssues,
  paramDefaultNote,
  paramNameNote,
  withRequired,
  withVariableType,
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
    expect(nameIssues([param({ name: 'a' })], [output({ name: 'b' })], [])).toEqual([]);
  });

  it('reports a duplicate param name in the SERVER’s words', () => {
    // Matching `refuseDuplicateNames` verbatim (schemas/pipeline.ts) is the
    // point: this gate exists to spare a round-trip to a refusal, so it must
    // not invent a second vocabulary for the same rejection.
    expect(nameIssues([param({ name: 'a' }), param({ name: 'a' })], [], [])).toEqual([
      "duplicate param name 'a' (param names must be unique within the pipeline)",
    ]);
  });

  it('reports a duplicate output name', () => {
    expect(nameIssues([], [output({ name: 'x' }), output({ name: 'x' })], [])).toEqual([
      "duplicate output name 'x' (output names must be unique within the pipeline)",
    ]);
  });

  it('does NOT collide a param with an output of the same name', () => {
    // Separate namespaces in the schema — `${params.x}` and an output `x` are
    // different things, and refusing that would block a legal doc.
    expect(nameIssues([param({ name: 'x' })], [output({ name: 'x' })], [])).toEqual([]);
  });

  it('reports an empty name by position, since it has no name to quote', () => {
    expect(nameIssues([param({ name: 'a' }), param({ name: '' })], [], [])).toEqual([
      'param #2 has no name',
    ]);
  });

  it('treats a whitespace-only name as empty', () => {
    expect(nameIssues([param({ name: '   ' })], [], [])).toEqual(['param #1 has no name']);
  });

  it('reports every offender, not just the first', () => {
    const issues = nameIssues(
      [param({ name: '' }), param({ name: 'b' }), param({ name: 'b' })],
      [output({ name: '' })],
      [],
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

  // #844 — a json param's string default used to show UNQUOTED, so a string
  // carried over from a `string` param (`'{"a":1}'`) looked like an object on
  // screen while a run received text, and editing `hello` failed JSON parsing.
  it("shows a json param's STRING default json-quoted, so it reads as the string it is", () => {
    expect(formatDefaultInput('{"a":1}', 'json')).toBe('"{\\"a\\":1}"');
    expect(formatDefaultInput('hello', 'json')).toBe('"hello"');
    expect(coerceDefaultInput('json', formatDefaultInput('hello', 'json'))).toEqual({
      ok: true,
      has: true,
      value: 'hello',
    });
  });

  it('leaves a string default unquoted for every non-json type', () => {
    expect(formatDefaultInput('hi', 'string')).toBe('hi');
    expect(formatDefaultInput('label', 'secret')).toBe('label');
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

describe('paramNameNote / paramDefaultNote — non-gating notes on a row (#844)', () => {
  it('say nothing about an ordinary param', () => {
    const p = param({ name: 'topic_1', default: 'news' });
    expect(paramNameNote(p)).toBeNull();
    expect(paramDefaultNote(p)).toBeNull();
  });

  it('note a name that is not a plain identifier', () => {
    for (const name of ['a.b', 'my name', 'a-b', '1x']) {
      const note = paramNameNote(param({ name }));
      expect(note).toContain(`'${name}'`);
      expect(note).toContain('Insert reference');
    }
  });

  it('say a name is UNREACHABLE only when it holds a character the grammar splits on', () => {
    // `${params.my name}` and `${params.a-b}` resolve — measured — so claiming
    // otherwise would be a false note.
    for (const name of ['my name', 'a-b', '1x']) {
      expect(paramNameNote(param({ name }))).not.toContain('can reach it');
    }
    for (const name of ['a.b', 'a[0]', 'a]', 'x}', "it's", 'say"hi']) {
      expect(paramNameNote(param({ name }))).toContain('no ${params.…} reference can reach it');
    }
  });

  it('leave a blank name to the save gate, which already reports it', () => {
    expect(paramNameNote(param({ name: '' }))).toBeNull();
    expect(paramNameNote(param({ name: '   ' }))).toBeNull();
  });

  it('note a ${} in a default, which is delivered as written and never evaluated', () => {
    expect(paramDefaultNote(param({ default: 'run-${run.runId}' }))).toContain('not evaluated');
  });

  it('find a ${} nested inside a json default, arrays included', () => {
    const p = param({ type: 'json', default: { a: [1, { b: 'x ${params.y}' }] } });
    expect(paramDefaultNote(p)).toContain('not evaluated');
    expect(paramDefaultNote(param({ type: 'json', default: [['${x}']] }))).not.toBeNull();
  });

  it('survive a json default nested far past the call-stack depth', () => {
    let deep: unknown = '${x}';
    for (let i = 0; i < 20_000; i += 1) deep = [deep];
    expect(paramDefaultNote(param({ type: 'json', default: deep }))).not.toBeNull();
  });

  it('survive a json default far WIDER than a call can take as spread arguments', () => {
    const wide = [...Array.from({ length: 500_000 }, () => 'x'), '${x}'];
    expect(paramDefaultNote(param({ type: 'json', default: wide }))).not.toBeNull();
  });

  it('note an escaped $${ too, because a default never unescapes it either', () => {
    expect(paramDefaultNote(param({ default: 'cost $${x}' }))).not.toBeNull();
  });

  it('do not note a lone $ or a { that is not a reference opener', () => {
    expect(paramDefaultNote(param({ default: '$5 {x}' }))).toBeNull();
    expect(paramDefaultNote(param({ type: 'json', default: { k: '$ {' } }))).toBeNull();
  });
});

function variable(over: Partial<VariableDef> = {}): VariableDef {
  return { name: 'v', type: 'string', default: '', ...over };
}

describe('#844 V3 — variable rows', () => {
  it('a new row states its starting value and takes a fresh name', () => {
    expect(blankVariable([])).toEqual({ name: 'var_1', type: 'string', default: '' });
    expect(blankVariable([variable({ name: 'var_2' })]).name).toBe('var_3');
  });

  it('duplicate variable names gate Save, in their own namespace', () => {
    expect(nameIssues([], [], [variable({ name: 'a' }), variable({ name: 'a' })])).toEqual([
      "duplicate variable name 'a' (variable names must be unique within the pipeline)",
    ]);
    expect(nameIssues([], [], [variable({ name: '' })])).toEqual(['variable #1 has no name']);
    // A param, an output and a variable may all be called `x`.
    expect(
      nameIssues([param({ name: 'x' })], [output({ name: 'x' })], [variable({ name: 'x' })]),
    ).toEqual([]);
  });

  it('blank is the empty string for a string, and refused for every other type', () => {
    expect(coerceVariableDefault('string', '')).toEqual({ ok: true, value: '' });
    expect(coerceVariableDefault('string', ' a ')).toEqual({ ok: true, value: ' a ' });
    for (const t of ['number', 'boolean', 'array'] as const) {
      expect(coerceVariableDefault(t, '  ').ok).toBe(false);
    }
  });

  it('parses each type strictly', () => {
    expect(coerceVariableDefault('number', '5')).toEqual({ ok: true, value: 5 });
    expect(coerceVariableDefault('number', 'five').ok).toBe(false);
    expect(coerceVariableDefault('boolean', 'false')).toEqual({ ok: true, value: false });
    expect(coerceVariableDefault('boolean', 'no').ok).toBe(false);
    expect(coerceVariableDefault('array', '[1, "a"]')).toEqual({ ok: true, value: [1, 'a'] });
    // Valid JSON that is not an array is still refused.
    expect(coerceVariableDefault('array', '{"a":1}').ok).toBe(false);
    expect(coerceVariableDefault('array', '[1,').ok).toBe(false);
  });

  it('formats a default so it round-trips through its own parser', () => {
    for (const v of [
      variable({ type: 'string', default: 'hello' }),
      variable({ type: 'number', default: 2.5 }),
      variable({ type: 'boolean', default: true }),
      variable({ type: 'array', default: [1, { a: 'b' }] }),
    ]) {
      expect(coerceVariableDefault(v.type, formatVariableDefault(v.default, v.type))).toEqual({
        ok: true,
        value: v.default,
      });
    }
  });

  it('a type change carries a default that converts, and zeroes one that does not', () => {
    expect(withVariableType(variable({ type: 'number', default: 5 }), 'string').default).toBe('5');
    expect(withVariableType(variable({ type: 'string', default: '5' }), 'number').default).toBe(5);
    expect(withVariableType(variable({ type: 'string', default: 'true' }), 'boolean').default).toBe(
      true,
    );
    expect(withVariableType(variable({ type: 'string', default: 'hi' }), 'number').default).toBe(0);
    expect(withVariableType(variable({ type: 'string', default: '' }), 'array').default).toEqual(
      [],
    );
    expect(withVariableType(variable({ type: 'array', default: [1] }), 'boolean').default).toBe(
      false,
    );
    // Same type: the row is returned untouched, so no edit is recorded.
    const same = variable({ type: 'number', default: 1 });
    expect(withVariableType(same, 'number')).toBe(same);
  });

  it('zeroes an array into a FRESH array, never one shared between rows', () => {
    const a = withVariableType(variable({ default: 'x' }), 'array');
    const b = withVariableType(variable({ default: 'y' }), 'array');
    expect(a.default).not.toBe(b.default);
  });
});

describe('coerceGlobalValue (#844 GL2)', () => {
  it('keeps a string verbatim, blank included — empty text is a value', () => {
    expect(coerceGlobalValue('string', '')).toEqual({ ok: true, value: '' });
    expect(coerceGlobalValue('string', ' a ')).toEqual({ ok: true, value: ' a ' });
  });

  it('refuses a blank non-string rather than inventing 0, false or null', () => {
    for (const type of ['number', 'boolean', 'json'] as const) {
      expect(coerceGlobalValue(type, '  ')).toEqual({
        ok: false,
        error: `a ${type} global needs a value`,
      });
    }
  });

  it('reads each type strictly', () => {
    expect(coerceGlobalValue('number', '42')).toEqual({ ok: true, value: 42 });
    expect(coerceGlobalValue('number', 'abc')).toEqual({ ok: false, error: 'expected a number' });
    expect(coerceGlobalValue('boolean', 'false')).toEqual({ ok: true, value: false });
    expect(coerceGlobalValue('json', '{"a":[1]}')).toEqual({ ok: true, value: { a: [1] } });
    expect(coerceGlobalValue('json', 'null')).toEqual({ ok: true, value: null });
    expect(coerceGlobalValue('json', '{')).toEqual({ ok: false, error: 'expected valid JSON' });
  });
});
