import { ACTIVITY_MODE_GROUPS } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import { activityModeSelect, activityModeTitle } from './activityModes';

describe('activity mode selects (#1600 OR41 C7b)', () => {
  it.each(ACTIVITY_MODE_GROUPS.map((group) => [group[0]!, group] as const))(
    '%s names every mode of its group, in order',
    (_first, group) => {
      for (const type of group) {
        const select = activityModeSelect(type)!;
        expect(select.types).toBe(group);
        expect(Object.keys(select.options)).toEqual([...group]);
      }
    },
  );

  it('names a mode only where it is not the first', () => {
    expect(activityModeTitle('file_read', 'Lookup')).toBe('Lookup (whole file as text)');
    expect(activityModeTitle('copy_files', 'Copy data')).toBe('Copy data (files as-is)');
    expect(activityModeTitle('lookup', 'Lookup')).toBe('Lookup');
    expect(activityModeTitle('llm_call', 'LLM call')).toBe('LLM call');
    expect(activityModeSelect('llm_call')).toBeUndefined();
  });
});
