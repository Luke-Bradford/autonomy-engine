import { describe, expect, it } from 'vitest';
import type { VariableDef } from '@autonomy-studio/shared';
import { variableWriteChoices } from './variableChoices';

const declared: VariableDef[] = [
  { name: 'count', type: 'number', default: 0 },
  { name: 'rows', type: 'array', default: [] },
  { name: 'label', type: 'string', default: '' },
  { name: 'seen', type: 'array', default: [] },
];

describe('variableWriteChoices (#844 V6)', () => {
  it('a set_variable may write any declared variable, in declaration order', () => {
    expect(variableWriteChoices('set_variable', declared)?.values).toEqual([
      'count',
      'rows',
      'label',
      'seen',
    ]);
  });

  it('an append_variable is offered only the array variables', () => {
    expect(variableWriteChoices('append_variable', declared)?.values).toEqual(['rows', 'seen']);
  });

  it('names each variable with its type, which decides how a literal value is read', () => {
    const choices = variableWriteChoices('set_variable', declared)!;
    expect(choices.describe('count')).toBe('count (number)');
    expect(choices.describe('rows')).toBe('rows (array)');
  });

  it('says WHY a list is empty: none declared, versus none of them an array', () => {
    expect(variableWriteChoices('set_variable', [])).toMatchObject({
      values: [],
      emptyHint: expect.stringMatching(/^No variables are declared/),
    });
    expect(variableWriteChoices('append_variable', [])?.emptyHint).toMatch(
      /^No variables are declared/,
    );
    const noArrays = declared.filter((v) => v.type !== 'array');
    expect(variableWriteChoices('append_variable', noArrays)).toMatchObject({
      values: [],
      emptyHint: expect.stringMatching(/^No array variables/),
    });
  });

  it('offers nothing for an activity that writes no variable', () => {
    expect(variableWriteChoices('http_request', declared)).toBeUndefined();
    expect(variableWriteChoices('if', declared)).toBeUndefined();
  });
});
