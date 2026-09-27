import { describe, expect, it } from 'vitest';
import { ANNOTATION_MAX_CHARS } from '@autonomy-studio/shared';
import { readRunFilters } from './runFilters';

describe('readRunFilters — U26 annotation', () => {
  it('keeps an annotation, decoded, exactly as written', () => {
    const params = new URLSearchParams({ annotation: 'Finance EU & UK+ café' });
    expect(readRunFilters(params)).toEqual({ annotation: 'Finance EU & UK+ café' });
  });

  /** A value the server's shared schema would 400 is dropped, so a junk link lands
   * on the unfiltered list rather than on an error page. */
  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(ANNOTATION_MAX_CHARS + 1)],
  ])('drops an annotation that is %s', (_label, value) => {
    expect(readRunFilters(new URLSearchParams({ annotation: value }))).toEqual({});
  });
});
