import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getActivity } from '@autonomy-studio/shared';
import {
  assembleConfig,
  deriveConfigFields,
  formatFieldValue,
  parseFieldInput,
  unrepresentableFields,
  type ConfigField,
} from './configForm';

/** Look a field up by name, failing loudly rather than returning `undefined`. */
function field(fields: ConfigField[] | null, name: string): ConfigField {
  const found = fields?.find((f) => f.name === name);
  if (!found) throw new Error(`no derived field named ${name} (got ${fields?.map((f) => f.name)})`);
  return found;
}

/** The derived fields of a catalogued activity, failing loudly if it has none. */
function fieldsOf(type: string): ConfigField[] {
  const entry = getActivity(type);
  if (!entry) throw new Error(`no catalog entry for ${type}`);
  const derived = deriveConfigFields(entry.configSchema);
  if (!derived) throw new Error(`${type} derived no fields`);
  return derived;
}

describe('deriveConfigFields', () => {
  it('classifies each primitive construct by its own control', () => {
    const fields = deriveConfigFields(
      z.object({
        s: z.string(),
        n: z.number(),
        b: z.boolean(),
        e: z.enum(['low', 'high']),
        l: z.array(z.string()),
      }),
    );

    expect(field(fields, 's').kind).toBe('text');
    expect(field(fields, 'n').kind).toBe('number');
    expect(field(fields, 'b').kind).toBe('boolean');
    expect(field(fields, 'e').kind).toBe('enum');
    expect(field(fields, 'e').enumOptions).toEqual(['low', 'high']);
    expect(field(fields, 'l').kind).toBe('stringList');
  });

  it('unwraps optional / default / nullable, recording that the key may be absent', () => {
    const fields = deriveConfigFields(
      z.object({
        req: z.string(),
        opt: z.string().optional(),
        def: z.string().default('hi'),
        nul: z.string().nullable(),
      }),
    );

    expect(field(fields, 'req').optional).toBe(false);
    expect(field(fields, 'req').kind).toBe('text');
    expect(field(fields, 'opt').optional).toBe(true);
    expect(field(fields, 'opt').kind).toBe('text');
    // A defaulted key is absent-able too, and the default is offered as a hint
    // rather than written in — applying must not turn "absent" into "explicit".
    expect(field(fields, 'def').optional).toBe(true);
    expect(field(fields, 'def').kind).toBe('text');
    expect(field(fields, 'def').defaultText).toBe('hi');
    // `nullable` is seen THROUGH but does not make the key absent-able: it
    // permits the VALUE null, which is not the same as omitting the key, and
    // labelling such a field "optional" would be a lie the author acts on.
    expect(field(fields, 'nul')).toMatchObject({ kind: 'text', optional: false });
  });

  it('survives the object-level refinements the cross-field rules are written as', () => {
    // Empirically verified against zod 4.4.3: `.refine`/`.superRefine` on a
    // ZodObject return a ZodObject and PRESERVE `.shape`. `llm_call`'s schema is
    // written this way (two `.refine` + three `.superRefine`), so if this ever
    // stopped holding, the single most complex activity would silently lose its
    // whole form and fall back to the JSON hatch.
    const fields = deriveConfigFields(
      z
        .object({ a: z.string(), b: z.string().optional() })
        .refine(() => true)
        .superRefine(() => {}),
    );

    expect(fields?.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('degrades a construct it cannot render to a JSON field rather than throwing', () => {
    const fields = deriveConfigFields(
      z.object({
        nested: z.object({ x: z.string() }),
        rec: z.record(z.string(), z.string()),
        rows: z.array(z.object({ x: z.string() })),
        nums: z.array(z.number()),
        either: z.union([z.string(), z.number()]),
        anything: z.unknown(),
      }),
    );

    for (const name of ['nested', 'rec', 'rows', 'nums', 'either', 'anything']) {
      expect(field(fields, name).kind).toBe('json');
    }
  });

  it('returns null for a schema that is not object-rooted, so the caller falls back', () => {
    // Fail-safe: an un-walkable ROOT yields no form at all (the whole-config JSON
    // editor), never a partial form that silently drops the keys it missed.
    expect(deriveConfigFields(z.string())).toBeNull();
    expect(deriveConfigFields(z.union([z.object({ a: z.string() }), z.string()]))).toBeNull();
  });

  it('derives the real http_request entry, records and secret sink included', () => {
    const fields = fieldsOf('http_request');

    expect(field(fields, 'url')).toMatchObject({ kind: 'text', optional: false });
    expect(field(fields, 'method')).toMatchObject({ kind: 'text', optional: true });
    expect(field(fields, 'body')).toMatchObject({ kind: 'text', optional: true });
    // A record of headers has no typed control this ticket — it authors as JSON.
    expect(field(fields, 'headers')).toMatchObject({ kind: 'json', optional: true });
    // The secret SINK authors as an inert `{$secret:name}` marker, which is a
    // credential NAME and never the credential — safe to render as JSON.
    expect(field(fields, 'secretHeaders')).toMatchObject({ kind: 'json', optional: true });
  });

  it('derives a control activity too, whose loose schema is a UX pre-check only', () => {
    // `wait`'s real constraints live in `validateDoc` (`validateWaitConfig`), not
    // in this schema — `seconds` is a `z.string()` precisely so it can hold a
    // `${}` expression. The form must therefore NOT present itself as the gate:
    // it renders the loose shape, the server still refuses a bad one at save.
    // Pinned because deriving forms for the control activities silently widened
    // this ticket's surface from one activity to the whole catalog.
    expect(field(fieldsOf('wait'), 'seconds')).toMatchObject({ kind: 'text', optional: false });
    expect(field(fieldsOf('if'), 'condition')).toMatchObject({ kind: 'text', optional: false });
    expect(field(fieldsOf('switch'), 'cases')).toMatchObject({ kind: 'stringList' });
  });
});

describe('formatFieldValue', () => {
  const text: ConfigField = { name: 'url', kind: 'text', optional: false };
  const num: ConfigField = { name: 'maxTokens', kind: 'number', optional: true };
  const bool: ConfigField = { name: 'emitMessages', kind: 'boolean', optional: true };
  const list: ConfigField = { name: 'cases', kind: 'stringList', optional: false };
  const json: ConfigField = { name: 'headers', kind: 'json', optional: true };

  it('renders an absent key as an empty control', () => {
    expect(formatFieldValue(text, undefined)).toEqual({ ok: true, value: '' });
    expect(formatFieldValue(num, undefined)).toEqual({ ok: true, value: '' });
    expect(formatFieldValue(bool, undefined)).toEqual({ ok: true, value: false });
  });

  it('renders each kind into its control', () => {
    expect(formatFieldValue(text, 'https://x')).toEqual({ ok: true, value: 'https://x' });
    expect(formatFieldValue(num, 512)).toEqual({ ok: true, value: '512' });
    expect(formatFieldValue(bool, true)).toEqual({ ok: true, value: true });
    expect(formatFieldValue(list, ['a', 'b'])).toEqual({ ok: true, value: 'a\nb' });
    expect(formatFieldValue(json, { a: 1 })).toEqual({ ok: true, value: '{\n  "a": 1\n}' });
  });

  it('REFUSES a stored value whose type disagrees with its control', () => {
    // The kind comes from the SCHEMA; the stored value comes from the DOC, and a
    // doc authored by the API, imported from git, or written by an older catalog
    // can disagree. Rendering `{a:1}` into a text box would apply back as the
    // string "[object Object]" — a silent corruption on a no-op edit. So an
    // unrepresentable value is refused here and the panel forces the JSON hatch.
    expect(formatFieldValue(text, { a: 1 }).ok).toBe(false);
    expect(formatFieldValue(num, '${params.n}').ok).toBe(false);
    expect(formatFieldValue(bool, 'yes').ok).toBe(false);
    expect(formatFieldValue(list, [1, 2]).ok).toBe(false);
    expect(formatFieldValue(list, 'a,b').ok).toBe(false);
  });

  it('names every field whose stored value cannot be rendered', () => {
    expect(unrepresentableFields([text, num], { url: 'ok', maxTokens: 5 })).toEqual([]);
    expect(unrepresentableFields([text, num], { url: { a: 1 }, maxTokens: '${x}' })).toEqual([
      'url',
      'maxTokens',
    ]);
  });
});

describe('parseFieldInput', () => {
  const text: ConfigField = { name: 'url', kind: 'text', optional: false };
  const optText: ConfigField = { name: 'body', kind: 'text', optional: true };
  const num: ConfigField = { name: 'maxTokens', kind: 'number', optional: true };
  const bool: ConfigField = { name: 'emitMessages', kind: 'boolean', optional: true };
  const reqBool: ConfigField = { name: 'flag', kind: 'boolean', optional: false };
  const list: ConfigField = { name: 'cases', kind: 'stringList', optional: false };
  const json: ConfigField = { name: 'headers', kind: 'json', optional: true };
  const en: ConfigField = { name: 'mode', kind: 'enum', optional: true, enumOptions: ['a', 'b'] };

  it('omits the key for an empty input rather than writing an empty value', () => {
    // One uniform rule across every kind: empty means "not set". Writing `''` or
    // `null` instead would turn "the author left it alone" into an explicit value
    // the engine then has to interpret.
    for (const f of [text, optText, num, list, json, en]) {
      expect(parseFieldInput(f, '')).toEqual({ ok: true, omit: true });
    }
    // A REQUIRED key omitted is not this function's business to refuse — the
    // activity's own schema reports it missing, with its own message.
    expect(parseFieldInput(text, '   ')).toEqual({ ok: true, omit: true });
  });

  it('parses each kind back out of its control', () => {
    expect(parseFieldInput(text, 'https://x')).toEqual({
      ok: true,
      omit: false,
      value: 'https://x',
    });
    expect(parseFieldInput(num, '512')).toEqual({ ok: true, omit: false, value: 512 });
    expect(parseFieldInput(num, '0.5')).toEqual({ ok: true, omit: false, value: 0.5 });
    expect(parseFieldInput(en, 'b')).toEqual({ ok: true, omit: false, value: 'b' });
    expect(parseFieldInput(list, 'a\n\n b \n')).toEqual({
      ok: true,
      omit: false,
      value: ['a', 'b'],
    });
    expect(parseFieldInput(json, '{"a":1}')).toEqual({ ok: true, omit: false, value: { a: 1 } });
  });

  it('preserves a text value verbatim, including whitespace an expression needs', () => {
    expect(parseFieldInput(text, '  ${params.url}  ')).toEqual({
      ok: true,
      omit: false,
      value: '  ${params.url}  ',
    });
  });

  it('distinguishes an unchecked OPTIONAL box from an explicit false', () => {
    // `catalog/lower.ts` reads `emitMessages` to decide whether to add the
    // messages transcript row, so absent and `false` must stay distinguishable:
    // an optional box that writes `false` would make every node explicit.
    expect(parseFieldInput(bool, false)).toEqual({ ok: true, omit: true });
    expect(parseFieldInput(bool, true)).toEqual({ ok: true, omit: false, value: true });
    expect(parseFieldInput(reqBool, false)).toEqual({ ok: true, omit: false, value: false });
  });

  it('REFUSES an input it cannot parse instead of coercing it', () => {
    expect(parseFieldInput(num, 'abc').ok).toBe(false);
    expect(parseFieldInput(num, '1e').ok).toBe(false);
    expect(parseFieldInput(json, '{nope}').ok).toBe(false);
    expect(parseFieldInput(en, 'zzz').ok).toBe(false);
  });
});

describe('assembleConfig', () => {
  const fields: ConfigField[] = [
    { name: 'url', kind: 'text', optional: false },
    { name: 'body', kind: 'text', optional: true },
  ];

  it('preserves every config key the form does not own', () => {
    // The generalisation of the old `outputs` special case. `config.outputs` is
    // the F13 contract, written by `catalog/lower.ts` and absent from every
    // activity's `configSchema` — so no derived field owns it. Any other
    // undeclared key an API-authored or imported doc carries is preserved by the
    // same rule. Storing a `safeParse` OUTPUT here would drop them all silently:
    // a plain `z.object` STRIPS unknown keys (verified against zod 4.4.3).
    const result = assembleConfig(
      { url: 'old', outputs: [{ name: 'r', type: 'string' }], extra: 7 },
      fields,
      {
        url: 'new',
        body: '',
      },
    );

    expect(result).toEqual({
      ok: true,
      owned: { url: 'new' },
      config: { url: 'new', outputs: [{ name: 'r', type: 'string' }], extra: 7 },
    });
  });

  it('deletes a key the author cleared', () => {
    const result = assembleConfig({ url: 'u', body: 'gone' }, fields, { url: 'u', body: '' });
    expect(result).toEqual({ ok: true, owned: { url: 'u' }, config: { url: 'u' } });
  });

  it('reports the first unparseable field by name and assembles nothing', () => {
    const withNum: ConfigField[] = [...fields, { name: 'n', kind: 'number', optional: true }];
    const result = assembleConfig({}, withNum, { url: 'u', body: '', n: 'abc' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/^n: /);
  });
});
