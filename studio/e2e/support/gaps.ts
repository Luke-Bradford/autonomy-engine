import type { Page } from '@playwright/test';

/**
 * #1594 OR40 S6t — the RENDERED gap from each visible child of `selector`'s
 * first match to the next, as `↓8` (the next is below) or `→8` (it shares the
 * row), in whole px. A paragraph's browser margin, a collapsed margin or a part
 * that wrapped beside another shows here, where a declared `gap` would not.
 */
export function childGaps(page: Page, selector: string): Promise<string[] | null> {
  return page.evaluate((sel) => {
    const parent = document.querySelector(sel);
    if (!parent) return null;
    const boxes = [...parent.children]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => el.getBoundingClientRect());
    return boxes.slice(1).map((b, i) => {
      const a = boxes[i]!;
      const sameRow = b.top < a.bottom && a.top < b.bottom;
      return sameRow ? `→${Math.round(b.left - a.right)}` : `↓${Math.round(b.top - a.bottom)}`;
    });
  }, selector);
}
