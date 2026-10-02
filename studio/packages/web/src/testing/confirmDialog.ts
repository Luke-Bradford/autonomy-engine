import { expect } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/**
 * #1397 — answer the page's confirmation dialog (`useConfirm`): wait for it,
 * click its action button (`accept`, always the last button) or Cancel, and
 * wait for it to close. Cancel is the FIRST button whatever its label (a
 * request may rename it, e.g. "Keep running"). Returns the dialog's text so a test can assert the
 * consequences it named. A dialog that asks for a typed name needs the name
 * typed (`Type <name> to confirm`) before `accept`.
 *
 * Waiting for the close is what keeps a declined test honest: an
 * `expect(deleteMock).not.toHaveBeenCalled()` straight after the click would
 * pass while the dialog was still open, whichever way it was answered.
 */
export async function answerConfirm(
  user: Pick<UserEvent, 'click'>,
  answer: 'accept' | 'cancel',
): Promise<string> {
  const dialog = await screen.findByRole('alertdialog');
  const text = dialog.textContent ?? '';
  const buttons = within(dialog).getAllByRole('button');
  const target = answer === 'cancel' ? buttons[0]! : buttons[buttons.length - 1]!;
  await user.click(target);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  return text;
}

/*
 * Typing and keys INTO the dialog go through `fireEvent`, not `user.type` /
 * `user.keyboard`. In jsdom, tabster (Fluent's focus manager) sees user-event's
 * focus calls as user focus, schedules its 100 ms "pull focus back into the
 * modal" timer, and — with no layout, so no element it can call focusable —
 * BLURS the focused control instead. Keystrokes after that land on <body>: a
 * name typed as "Nightly" arrives as "Ni" about one run in two under load. In a
 * browser the same timer finds the control and refocuses it, so this is a jsdom
 * artifact; real keyboard behaviour is covered by e2e/confirm-dialog.spec.ts.
 */

/** Set the dialog's `Type <name> to confirm` box to `value`. */
export function setConfirmName(name: string, value: string): void {
  const dialog = screen.getByRole('alertdialog');
  fireEvent.change(within(dialog).getByLabelText(`Type ${name} to confirm`), {
    target: { value },
  });
}

/** Press a key on the open dialog (Escape answers Cancel), or on `target` inside it. */
export function pressInConfirm(key: 'Escape' | 'Enter', target?: HTMLElement): void {
  fireEvent.keyDown(target ?? screen.getByRole('alertdialog'), { key });
}
