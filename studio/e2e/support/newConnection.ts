import type { Page } from '@playwright/test';

/**
 * #1477 — Manage → Connections → New connection opens the kind gallery
 * first; this picks `kind` there, which opens that kind's form. The page must
 * already be on Connections.
 */
export async function openNewConnection(page: Page, kind: string): Promise<void> {
  await page.getByRole('button', { name: 'New connection' }).click();
  // By the stored kind id the tile's glyph carries, so a call site names the
  // kind as the form and the API do, not by its display label.
  await page
    .getByRole('dialog', { name: 'New connection' })
    .locator(`.kind-gallery__tile:has(.kind-icon[data-kind="${kind}"])`)
    .click();
  await page.getByRole('form', { name: 'Connection form' }).waitFor();
}
