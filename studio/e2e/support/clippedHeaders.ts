import type { Page } from '@playwright/test';

/**
 * #1594 OR40 S6 — every header label in `table` that its cell cuts, named with
 * what it needs and has: `Duration (54/52px)`. Read in ONE evaluate. The
 * epic's Acceptance, "Overflow": no header cell is clipped.
 *
 * A label is cut when it needs more than its cell's content box (the cell's
 * width less its padding). A sort button's need is its own `scrollWidth`, not
 * the cell's: in some fonts the ▲ glyph spills a pixel or two past its
 * fixed-width box (CI's did, on a 240px Name column), which is no cut. A label
 * with no button is measured by a range over its text, since a cell's own
 * `scrollWidth` counts its padding and would pass a label it cuts. A header
 * whose name is for assistive tech only (the ⋯ column) is skipped.
 */
export function clippedHeaderLabels(page: Page, table: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const grid = document.querySelector(selector);
    if (!grid) throw new Error(`no ${selector}`);
    return [...grid.querySelectorAll<HTMLElement>('thead th')]
      .filter((th) => !th.querySelector('.visually-hidden') && (th.textContent ?? '').trim())
      .map((th) => {
        const s = getComputedStyle(th);
        const room = th.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
        const button = th.querySelector<HTMLElement>('.sort-button');
        let need: number;
        if (button) need = button.scrollWidth;
        else {
          // The text's own extent: not the cell's contents, which include its
          // absolutely-placed resize handle.
          const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
          const range = document.createRange();
          let left = Infinity;
          let right = -Infinity;
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!(n.textContent ?? '').trim()) continue;
            range.selectNodeContents(n);
            const r = range.getBoundingClientRect();
            left = Math.min(left, r.left);
            right = Math.max(right, r.right);
          }
          need = right - left;
        }
        return { text: (th.textContent ?? '').trim(), need: Math.round(need), room };
      })
      .filter(({ need, room }) => need > room + 1)
      .map(({ text, need, room }) => `${text} (${need}/${Math.round(room)}px)`);
  }, table);
}
