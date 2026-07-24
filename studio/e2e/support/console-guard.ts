import type { Page } from '@playwright/test';

/**
 * Records everything the page reported that a user would consider broken:
 * `console.error`/`console.warn`, and — the one that matters most — uncaught
 * exceptions, which can leave a page rendering its shell while doing nothing.
 *
 * Attach BEFORE the first navigation; messages emitted during load are the
 * whole point. Returns the live array so a spec asserts on it after the page
 * has settled.
 */
export function collectPageProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (msg) => {
    const type = msg.type();
    // Playwright reports `console.warn` as type 'warning'.
    if (type === 'error' || type === 'warning') {
      problems.push(`console.${type}: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    problems.push(`pageerror: ${err.message}`);
  });
  return problems;
}
