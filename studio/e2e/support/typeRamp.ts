import type { Page } from '@playwright/test';
import type { DENSITIES } from './appearance';

/**
 * #1594 OR40 — the type ramp: the only (size px / weight) pairs rendered text
 * may use, per density (the epic's Acceptance, "Typography"). Hard-coded rather
 * than read from `tokens.css`, for the reason `appearance.ts` gives: a spec
 * observes the shipped contract from outside, so a token that drifts off the
 * ramp fails here instead of moving the ramp with it.
 */
export const TYPE_RAMP: Record<(typeof DENSITIES)[number], readonly string[]> = {
  compact: ['12/400', '12/600', '13/400', '13/600', '14/600', '20/600'],
  comfortable: ['12/400', '12/600', '14/400', '14/600', '16/600', '20/600'],
};

/**
 * Every visible element under `root` that draws text of its own (a non-blank
 * text node child) at a pair off the ramp, named so a failure says which one:
 * `h2.section__title "Recent runs" 15.2/700`. Read in ONE evaluate.
 */
export function offRampText(
  page: Page,
  density: (typeof DENSITIES)[number],
  root = '.content',
): Promise<string[]> {
  return page.evaluate(
    ([rootSelector, allowed]) => {
      const scope = document.querySelector(rootSelector);
      if (!scope) throw new Error(`no ${rootSelector}`);
      const off: string[] = [];
      for (const el of [scope, ...scope.querySelectorAll('*')]) {
        const own = [...el.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
        );
        if (!own || el.getClientRects().length === 0) continue;
        // Not drawn: hidden, or the body of a closed `<details>` (a `?` note).
        if (el.closest('.visually-hidden, [hidden], details:not([open]) > :not(summary)')) continue;
        const s = getComputedStyle(el);
        const pair = `${parseFloat(s.fontSize)}/${s.fontWeight}`;
        if (!allowed.includes(pair)) {
          const cls =
            typeof el.className === 'string' && el.className
              ? `.${el.className.split(' ')[0]}`
              : '';
          off.push(
            `${el.tagName.toLowerCase()}${cls} "${(el.textContent ?? '').trim().slice(0, 30)}" ${pair}`,
          );
        }
      }
      return off;
    },
    [root, TYPE_RAMP[density]] as const,
  );
}
