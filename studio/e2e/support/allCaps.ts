import type { Page } from '@playwright/test';
import { ACRONYMS } from '../../packages/web/src/testing/sentenceCase';

/**
 * #1594 OR40 — "no visible string is ALL CAPS, except acronyms or a status
 * badge" (the epic's Acceptance, "Case"). Two scopes, one acronym list
 * (`lib/words.ts`):
 *
 * - `capitals` (S4): nothing capitalised by its computed style, and no
 *   heading, tab, button, column header, legend or label in capitals.
 * - `allCapsText` (S6r): every visible text node under a root, body text
 *   included.
 */

/** Everything on the page that is drawn in capitals, by style or by its own text. */
export function capitals(page: Page, acronyms: readonly string[]) {
  return page.evaluate((acronyms) => {
    const kept = new Set(acronyms);
    // A time column names the viewer's zone ("Started GMT+1", "BST"): a value,
    // not a label, so the browser's own short zone name is kept.
    const zone = new Intl.DateTimeFormat('en', { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    for (const w of (zone ?? '').split(/[^\p{L}]+/u)) kept.add(w);
    const found: string[] = [];
    // `getClientRects`, not `offsetParent`: a fixed-position element has no offset parent.
    const visible = (el: Element) => el.getClientRects().length > 0;
    for (const el of document.querySelectorAll('body *')) {
      const t = getComputedStyle(el).textTransform;
      if ((t === 'uppercase' || t === 'capitalize') && visible(el) && el.textContent?.trim()) {
        found.push(`${el.tagName.toLowerCase()}.${el.className}: text-transform ${t}`);
      }
    }
    const named = 'h1, h2, h3, h4, h5, button, [role="tab"], th, legend, label';
    for (const el of document.querySelectorAll(named)) {
      if (!visible(el)) continue;
      for (const word of (el.textContent ?? '').split(/[^\p{L}]+/u)) {
        // The glossary's one banned variant: the term is "Parameters".
        if (/^params?$/i.test(word)) {
          found.push(`${el.tagName.toLowerCase()} "${el.textContent?.trim()}": ${word}`);
        }
        if (
          word.length > 1 &&
          word === word.toUpperCase() &&
          /\p{Lu}/u.test(word) &&
          !kept.has(word)
        ) {
          found.push(`${el.tagName.toLowerCase()} "${el.textContent?.trim()}": ${word}`);
        }
      }
    }
    return found;
  }, acronyms);
}

/**
 * Every visible ALL-CAPS word under `root` that is not an acronym, named by its
 * element: `strong "UNREADABLE"`. Read as DRAWN: a parent's
 * `text-transform: uppercase` capitalises its text, so a lowercase source string
 * styled into capitals fails too. Status badges and code are exempt, and so is
 * a `<time>`: its zone's abbreviation (GMT, PDT) depends on where it is read.
 * Text nodes only: attribute text (`aria-label`, `title`) is not read, and a
 * word split across elements is read in parts. ONE evaluate.
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
