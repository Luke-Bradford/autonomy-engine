import { describe, expect, it } from 'vitest';
import { drawerFileStem } from './drawerTab';

describe('drawerFileStem (#1484 M2 downloads)', () => {
  it('names the run, activity, attempt and item, slugged', () => {
    expect(
      drawerFileStem(['run', 'ab12cd34', 'Copy data 1', 'attempt 2', 'Item 2 of 2 · b.csv']),
    ).toBe('run-ab12cd34-copy-data-1-attempt-2-item-2-of-2-b-csv');
  });

  it('bounds a long item label, and never ends on a hyphen', () => {
    const stem = drawerFileStem(['run', 'x', 'a'.repeat(78) + ' tail']);
    expect(stem.length).toBeLessThanOrEqual(80);
    expect(stem.endsWith('-')).toBe(false);
  });

  it('falls back to a real name when nothing survives the slug', () => {
    expect(drawerFileStem(['✓✓', ''])).toBe('activity');
  });
});
