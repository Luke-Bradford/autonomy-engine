import { describe, expect, it } from 'vitest';
import { counted } from '../counted.js';

describe('counted (#1600 OR41 C6b)', () => {
  it('is singular for one and plural otherwise, zero included', () => {
    expect(counted(1, 'byte')).toBe('1 byte');
    expect(counted(0, 'file')).toBe('0 files');
    expect(counted(30, 'second')).toBe('30 seconds');
  });
});
