import { describe, expect, it } from 'vitest';
import { withLabel } from './shellLabel';

describe('withLabel (#1392)', () => {
  it('adds, replaces and removes a label under the normalised path', () => {
    const a = withLabel({}, '/author/pipelines/p/', 'One');
    expect(a).toEqual({ '/author/pipelines/p': 'One' });
    expect(withLabel(a, '/author/pipelines/p', 'Two')).toEqual({ '/author/pipelines/p': 'Two' });
    expect(withLabel(a, '/author/pipelines/p', undefined)).toEqual({});
  });

  it('returns the same object when nothing changes, so the shell does not re-render', () => {
    const a = withLabel({}, '/x', 'One');
    expect(withLabel(a, '/x', 'One')).toBe(a);
    expect(withLabel(a, '/y', undefined)).toBe(a);
  });

  it('treats an empty label as no label — an empty crumb has no accessible name', () => {
    expect(withLabel({ '/x': 'One' }, '/x', '')).toEqual({});
  });
});
