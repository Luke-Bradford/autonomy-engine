import { describe, expect, it } from 'vitest';
import { countOf } from './countOf';

describe('countOf', () => {
  it('agrees in number, with a regular plural by default', () => {
    expect(countOf(1, 'trigger')).toBe('1 trigger');
    expect(countOf(0, 'trigger')).toBe('0 triggers');
    expect(countOf(3, 'trigger')).toBe('3 triggers');
  });

  it('takes an irregular plural', () => {
    expect(countOf(1, 'activity', 'activities')).toBe('1 activity');
    expect(countOf(2, 'activity', 'activities')).toBe('2 activities');
  });
});
