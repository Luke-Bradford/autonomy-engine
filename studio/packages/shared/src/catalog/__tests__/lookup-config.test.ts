import { describe, expect, it } from 'vitest';
import { LOOKUP_ROW_CAP, LOOKUP_ROW_CEILING_MAX, lookupConfigSchema } from '../lookup-config.js';

/** #1600 OR41 C7a — a Lookup's Settings (activity catalogue §4.2). */
describe('lookupConfigSchema', () => {
  it('parses an ABSENT config to today’s read, so a stored lookup does not change', () => {
    expect(lookupConfigSchema.parse({})).toEqual({
      firstRowOnly: false,
      maxRows: LOOKUP_ROW_CAP,
      overLimit: 'truncate',
    });
  });

  // #1600 C7d — past the 1000 default, up to ADF's 5000; the run is held to the
  // workspace's Lookup max rows besides.
  it('takes Max rows from 1 up to ADF’s 5000, whole numbers only', () => {
    expect(LOOKUP_ROW_CEILING_MAX).toBe(5000);
    for (const maxRows of [1, 250, LOOKUP_ROW_CAP, LOOKUP_ROW_CAP + 1, LOOKUP_ROW_CEILING_MAX]) {
      expect(lookupConfigSchema.safeParse({ maxRows }).success).toBe(true);
    }
    for (const maxRows of [0, -1, 1.5, LOOKUP_ROW_CEILING_MAX + 1, '10']) {
      expect(lookupConfigSchema.safeParse({ maxRows }).success).toBe(false);
    }
  });

  it('takes the two over-limit choices and nothing else', () => {
    expect(lookupConfigSchema.safeParse({ overLimit: 'fail' }).success).toBe(true);
    expect(lookupConfigSchema.safeParse({ overLimit: 'skip' }).success).toBe(false);
  });

  it('leaves the declared outputs the prepared input carries alone', () => {
    expect(
      lookupConfigSchema.safeParse({ outputs: [{ name: 'rows', type: 'json' }] }).success,
    ).toBe(true);
  });
});
