import { describe, expect, it } from 'vitest';
import { shortId } from './ids';

describe('shortId (#1392)', () => {
  it('keeps the random tail of a server id and drops its type prefix', () => {
    expect(shortId('run_V1StGXR8_Z5jdHi6B-myT')).toBe('Hi6B-myT');
  });

  it('leaves an id that is already short whole, rather than cutting it mid-word', () => {
    expect(shortId('run_e2e_u3')).toBe('run_e2e_u3');
  });
});
