import type { Page } from '@playwright/test';

/**
 * #1594 OR40 — "no visible string is ALL CAPS, except acronyms or a status
 * badge" (the epic's Acceptance, "Case").
 *
 * The acronyms a page may draw in capitals. A word of two or more capitals that
 * is not here fails, so a new acronym is a deliberate addition rather than a
 * pass by default.
 */
export const ACRONYMS: readonly string[] = [
  'AI',
  'API',
  'CLI',
  'CSV',
  'HTTP',
  'ID',
  'JSON',
  'LLM',
  'POST',
  'SQL',
  'URL',
  'USD',
  'UTC',
];

/**
 * Every visible ALL-CAPS word under `root` that is not an acronym, named by its
 * element: `strong "UNREADABLE"`. Read as DRAWN: a parent's
 * `text-transform: uppercase` capitalises its text, so a lowercase source string
 * styled into capitals fails too. Status badges and code are exempt, and so is
 * a `<time>`: its zone's abbreviation (GMT, PDT) depends on where it is read.
 * ONE evaluate.
 */
export function allCapsText(page: Page, root = '.content'): Promise<string[]> {
  return page.evaluate(
    ([rootSelector, acronyms]) => {
      const scope = document.querySelector(rootSelector);
      if (!scope) throw new Error(`no ${rootSelector}`);
      const found: string[] = [];
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        if (!el || el.getClientRects().length === 0) continue;
        if (el.closest('.visually-hidden, [hidden], details:not([open]) > :not(summary)')) continue;
        if (el.closest('code, pre, time, .badge, .run-status, .node-status')) continue;
        const raw = node.textContent ?? '';
        const drawn = getComputedStyle(el).textTransform === 'uppercase' ? raw.toUpperCase() : raw;
        for (const [word] of drawn.matchAll(/\b[A-Z][A-Z0-9]+\b/g)) {
          if (!acronyms.includes(word)) found.push(`${el.tagName.toLowerCase()} "${word}"`);
        }
      }
      return found;
    },
    [root, ACRONYMS] as const,
  );
}
