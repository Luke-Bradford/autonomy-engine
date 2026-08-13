import { describe, expect, it } from 'vitest';
import { catalog } from '@autonomy-studio/shared';
import { activityIcon } from './activityIcon';

/**
 * EVERY catalogued activity draws its OWN glyph.
 *
 * `activityIcon` is keyed by a plain string, so a wrong or missing key does not
 * fail to compile — it falls through to the category glyph and the activity
 * quietly wears somebody else's icon. That is a defect nothing else can see: the
 * canvas renders, the tests pass, and the palette just stops distinguishing two
 * activities.
 *
 * Measured rather than hypothetical: the first cut of the map used
 * `if_condition`, `webhook_wait`, `call_pipeline` and `list_directory`, while
 * the catalog's ids are `if`, `webhook`, `execute_pipeline` and `file_list`.
 * Four of sixteen, all silent.
 */
describe('activityIcon', () => {
  it('gives every catalogued activity a glyph of its own, not a fallback', () => {
    const fallback = activityIcon('a-type-the-catalog-does-not-have', 'general');
    const missing = [...catalog.keys()].filter((type) => activityIcon(type) === fallback);
    expect(
      missing,
      `these activities fall back to the generic glyph: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('still returns something drawable for an activity it has never heard of', () => {
    /* The catalog is open — a new activity can be registered without touching
       the map, and it must draw a sensible family glyph rather than a hole. */
    for (const category of ['general', 'ai', 'control', undefined]) {
      /* Not `typeof … === 'function'`: a Fluent icon is a `forwardRef` component,
         which is an OBJECT. Asserting the wrong shape here would have failed for
         a reason that has nothing to do with coverage. */
      expect(
        activityIcon('brand-new-activity', category),
        `category ${String(category)}`,
      ).toBeDefined();
    }
  });
});
