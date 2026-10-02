import { expect, type Page } from '@playwright/test';

/**
 * #1397 — answer the in-app confirmation dialog (`useConfirm`), which replaced
 * `window.confirm` on the list pages. It is a real Fluent alert dialog, so
 * Playwright's `page.on('dialog')` never sees it; this is the replacement.
 *
 * Returns the dialog's `innerText` (title, then body) so a caller can assert the
 * consequence text the confirm exists to state. It is rendered text, so
 * whitespace differs from the old `dialog.message()` — assert FRAGMENTS with
 * `toContain`, not the whole string.
 *
 * `typeName` is for a dialog that asks for the name to be typed (a connection
 * with known dependants, a global param with known readers); the action button
 * is disabled until it matches exactly. Passing it for a dialog that does not ask
 * fails loudly on the missing textbox rather than being ignored.
 *
 * The action button is the LAST button (Cancel, then the action).
 */
export async function answerConfirm(
  page: Page,
  answer: 'accept' | 'cancel',
  opts: { typeName?: string } = {},
): Promise<string> {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  const text = await dialog.innerText();
  if (opts.typeName !== undefined) {
    await dialog
      .getByRole('textbox', { name: `Type ${opts.typeName} to confirm` })
      .fill(opts.typeName);
  }
  const buttons = dialog.getByRole('button');
  if (answer === 'accept') await buttons.last().click();
  else await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  return text;
}
