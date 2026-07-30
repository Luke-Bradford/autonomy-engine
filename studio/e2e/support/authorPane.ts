import { type Page } from '@playwright/test';

/**
 * The Factory Resources pane (U4), addressed the way a user perceives it.
 *
 * Promoted out of `factory-resources.spec.ts` when `bug-sweep.spec.ts` became
 * the SECOND spec to need the tree — for the reason `support/theme.ts` and
 * `support/canvas.ts` both record: this repo has paid once for a helper that
 * existed twice and was hardened in only one copy. These locators encode real
 * decisions (the pane is a `navigation` landmark, the tree a `list` inside it,
 * the row menu is revealed on hover) and each can change.
 */

/** The pane itself. */
export function pane(page: Page) {
  return page.getByRole('navigation', { name: 'Author sections' });
}

/** The pipelines tree inside the pane. */
export function tree(page: Page) {
  return pane(page).getByRole('list', { name: 'Pipelines' });
}

/**
 * The pane's LOAD-failure banner — the one with a Retry beside it.
 *
 * Scoped by `:not([role=alert])` deliberately: `.factory-resources__error` is
 * worn by TWO elements, this one and the ACTION error (a failed create/rename/
 * delete), which is an `alert`. An unscoped locator is a strict-mode violation
 * the moment both are up, and — worse for a recovery assertion — a
 * `toHaveCount(0)` on it would mean "no error of either kind", so an unrelated
 * failed mutation could sink an assertion about the LOAD having recovered.
 */
export function loadBanner(page: Page) {
  return pane(page).locator('.factory-resources__error:not([role="alert"])');
}

/** Open a row's `⋯` menu. It is revealed on hover, so hover first. */
export async function openRowMenu(page: Page, name: string): Promise<void> {
  const row = tree(page).getByRole('listitem').filter({ hasText: name }).first();
  await row.hover();
  await row.getByRole('button', { name: `More actions for ${name}` }).click();
}
