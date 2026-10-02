import { expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/**
 * #1397 — answer the page's confirmation dialog (`useConfirm`): wait for it,
 * click its action button (`accept`, always the last button) or Cancel, and
 * wait for it to close. Returns the dialog's text so a test can assert the
 * consequences it named. `typeName` fills in the "Type <name> to confirm" box
 * first, for a dialog that asks for it.
 *
 * Waiting for the close is what keeps a declined test honest: an
 * `expect(deleteMock).not.toHaveBeenCalled()` straight after the click would
 * pass while the dialog was still open, whichever way it was answered.
 */
export async function answerConfirm(user: UserEvent, answer: 'accept' | 'cancel'): Promise<string> {
  const dialog = await screen.findByRole('alertdialog');
  const text = dialog.textContent ?? '';
  const buttons = within(dialog).getAllByRole('button');
  const target =
    answer === 'cancel'
      ? within(dialog).getByRole('button', { name: 'Cancel' })
      : buttons[buttons.length - 1]!;
  await user.click(target);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  return text;
}
