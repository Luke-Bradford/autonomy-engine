import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/**
 * #1397 — answer the page's confirmation dialog (`useConfirm`). Waits for the
 * dialog, then clicks its action button (`accept`) or Cancel, and returns the
 * dialog's text so a test can assert the consequences it named.
 */
export async function answerConfirm(
  user: UserEvent,
  answer: 'accept' | 'cancel',
): Promise<string> {
  const dialog = await screen.findByRole('alertdialog');
  const text = dialog.textContent ?? '';
  const buttons = within(dialog).getAllByRole('button');
  const target =
    answer === 'cancel'
      ? within(dialog).getByRole('button', { name: 'Cancel' })
      : buttons[buttons.length - 1]!;
  await user.click(target);
  return text;
}
