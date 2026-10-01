import { describe, expect, it } from 'vitest';
import { versionLabel } from './versionLabel';

describe('versionLabel (#1395)', () => {
  it('reads a saved version as v<n> and a debug version as debug <n>', () => {
    expect(versionLabel(3, false)).toBe('v3');
    expect(versionLabel(3, true)).toBe('debug 3');
  });
});
