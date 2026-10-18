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
    expect(variableWriteChoices('set_variable', undefined, declared)?.values).toEqual([
      'count',
      'rows',
      'label',
      'seen',
    ]);
  });

  it('an append_variable is offered only the array variables', () => {
    expect(variableWriteChoices('append_variable', undefined, declared)?.values).toEqual([
      'rows',
      'seen',
    ]);
  });

  it('#1600 C12a — a Set variable follows its Operation: Append offers only arrays', () => {
    expect(variableWriteChoices('set_variable', 'append', declared)?.values).toEqual([
      'rows',
      'seen',
    ]);
    // The empty choice is the schema default, Set; so is a value the save
    // refuses, whose own issue says why.
    for (const operation of ['', 'set', 'prepend']) {
      expect(variableWriteChoices('set_variable', operation, declared)?.values, operation).toEqual([
        'count',
        'rows',
        'label',
        'seen',
      ]);
    }
  });

  it('names each variable with its type, which decides how a literal value is read', () => {
    const choices = variableWriteChoices('set_variable', undefined, declared)!;
    expect(choices.describe('count')).toBe('count (number)');
    expect(choices.describe('rows')).toBe('rows (array)');
  });

  it('says WHY a list is empty: none declared, versus none of them an array', () => {
    expect(variableWriteChoices('set_variable', undefined, [])).toMatchObject({
      values: [],
      emptyHint: 'No variables declared',
    });
    expect(variableWriteChoices('append_variable', undefined, [])?.emptyHint).toBe(
      'No variables declared',
    );
    const noArrays = declared.filter((v) => v.type !== 'array');
    expect(variableWriteChoices('set_variable', 'append', noArrays)).toMatchObject({
      values: [],
      emptyHint: 'No array variables',
    });
  });

  it('offers nothing for an activity that writes no variable', () => {
    expect(variableWriteChoices('http_request', 'append', declared)).toBeUndefined();
    expect(variableWriteChoices('if', undefined, declared)).toBeUndefined();
  });
});
