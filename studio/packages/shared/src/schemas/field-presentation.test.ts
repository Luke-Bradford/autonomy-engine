import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  unnamedEnumValues,
  optionTitles,
  authoredAsExpression,
  fieldLabelOf,
  isAuthoredAsExpression,
  isSingleLine,
  presented,
  singleLine,
} from './field-presentation.js';

describe('field presentation tags (#864 item 4)', () => {
  it('keeps a fact a schema already carries when a second one is added', () => {
    const both = authoredAsExpression(singleLine(z.string()));
    expect(isSingleLine(both)).toBe(true);
    expect(isAuthoredAsExpression(both)).toBe(true);
  });

  it('merges onto an INHERITED entry without writing it back to the parent', () => {
    const parent = singleLine(z.string());
    const clone = authoredAsExpression(parent.min(1));
    expect(isSingleLine(clone)).toBe(true);
    expect(isAuthoredAsExpression(clone)).toBe(true);
    expect(isAuthoredAsExpression(parent)).toBe(false);
  });
});

describe('human field labels (#1396)', () => {
  it('reads a title, description and unit back from the tagged schema', () => {
    const field = presented(z.number().optional(), {
      title: 'Timeout',
      description: 'How long one request may take.',
      unit: 'ms',
    });
    expect(fieldLabelOf(field)).toEqual({
      title: 'Timeout',
      description: 'How long one request may take.',
      unit: 'ms',
    });
  });

  it('keeps a fact the schema already carried', () => {
    const field = presented(singleLine(z.string()), { title: 'Host' });
    expect(isSingleLine(field)).toBe(true);
    expect(fieldLabelOf(field)).toEqual({ title: 'Host' });
  });

  it('says nothing for an untitled schema', () => {
    expect(fieldLabelOf(singleLine(z.string()))).toBeUndefined();
    expect(fieldLabelOf(z.string())).toBeUndefined();
  });
});

describe('unnamedEnumValues (#1396)', () => {
  const mode = z.enum(['a', 'b']);

  it('reports each value with no name, through the wrappers', () => {
    expect(
      unnamedEnumValues({
        bare: mode,
        defaulted: mode.default('a'),
        titled: presented(mode.optional(), { title: 'Mode' }),
        text: z.string(),
      }),
    ).toEqual(['bare.a', 'bare.b', 'defaulted.a', 'defaulted.b', 'titled.a', 'titled.b']);
  });

  it('reports a blank name, and a name two values share', () => {
    const field = presented(mode.optional(), { title: 'Mode', options: { a: 'Same', b: 'Same' } });
    expect(
      unnamedEnumValues({
        field,
        blank: presented(z.enum(['x']), { title: 'X', options: { x: ' ' } }),
      }),
    ).toEqual(['field.a', 'field.b', 'blank.x']);
  });

  it('reports an unnamed enum inside a row, a record value or a union member', () => {
    // A row list renders each enum cell as a select too, so the gate walks
    // into the element (`messages[].role`), a record's values and a union.
    const named = presented(z.enum(['a', 'b']), {
      title: 'Mode',
      options: { a: 'Alpha', b: 'Beta' },
    });
    expect(
      unnamedEnumValues({
        rows: z.array(z.object({ cell: mode, ok: named })).optional(),
        byName: z.record(z.string(), z.object({ cell: mode.optional() })),
        either: z.union([z.object({ cell: mode }), z.string()]),
        fine: z.array(z.object({ ok: named })),
      }),
    ).toEqual([
      'rows[].cell.a',
      'rows[].cell.b',
      'byName.*.cell.a',
      'byName.*.cell.b',
      'either.cell.a',
      'either.cell.b',
    ]);
  });

  it('optionTitles takes its values from the schema, so a shared wider table fits', () => {
    const two = z.enum(['a', 'b']);
    // @ts-expect-error — `b` has no name
    optionTitles(two, { a: 'A' });
    const wider = { a: 'A', b: 'B', c: 'C' };
    expect(optionTitles(two, wider)).toBe(wider);
  });

  it('reads names from the outermost labelled layer, however deep it sits', () => {
    // Named on `.optional()`, then wrapped twice more: the form reads through
    // every layer, so the gate must too.
    const named = presented(mode.optional(), {
      title: 'Mode',
      options: optionTitles(mode, { a: 'Alpha', b: 'Beta' }),
    });
    expect(unnamedEnumValues({ deep: named.default('a').nullable() })).toEqual([]);
  });

  it('passes a field whose every value is named', () => {
    const named = presented(mode.optional(), {
      title: 'Mode',
      options: optionTitles(mode, { a: 'Alpha', b: 'Beta' }),
    });
    expect(unnamedEnumValues({ named })).toEqual([]);
  });
});
