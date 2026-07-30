import { expect, type Page } from '@playwright/test';

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

/**
 * Assert the page stayed quiet.
 *
 * The wait is a FLUSH, not a hopeful sleep: `problems` is appended to by async
 * CDP events, so asserting the instant the last action resolves drops anything
 * emitted a tick later — a rejected promise from an effect, a background fetch
 * failing after the assertion. That is a "passes while broken" hole, which is
 * the one failure mode this suite must not have.
 *
 * `allow` is for a spec that PROVOKES a failure on purpose — injecting a 502, say
 * — where the browser's own network entry is expected output rather than a
 * regression. Two rules keep it from becoming the hole it looks like:
 *
 *  - every pattern must MATCH something. An allow-list entry that matches
 *    nothing cannot be doing anything except hiding a future regression, so an
 *    unused one FAILS rather than passing quietly.
 *  - anchor each pattern on the browser-level text, not on a substring the APP
 *    might also emit. `/502/` would swallow the app's own `request failed (502)`
 *    (`packages/web/src/api/client.ts`) — measured: a deliberate `console.error`
 *    carrying that text passed straight through a loose filter.
 */
export async function expectQuiet(
  page: Page,
  problems: string[],
  allow: RegExp[] = [],
): Promise<void> {
  await page.waitForTimeout(150);
  for (const pattern of allow) {
    expect(
      problems.filter((p) => pattern.test(p)),
      `allowed console pattern ${String(pattern)} matched nothing — it can only hide a regression`,
    ).not.toHaveLength(0);
  }
  expect(problems.filter((p) => !allow.some((pattern) => pattern.test(p)))).toEqual([]);
}
