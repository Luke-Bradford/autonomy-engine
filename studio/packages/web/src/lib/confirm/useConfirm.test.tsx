import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { splitConfirmMessage, useConfirm, type ConfirmRequest } from './useConfirm';

/** A page that asks one question per click and shows each answer. */
function Harness({ request }: { request: ConfirmRequest }): ReactNode {
  const [confirm, dialog] = useConfirm();
  const [answers, setAnswers] = useState<boolean[]>([]);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void confirm(request).then((a) => setAnswers((prev) => [...prev, a]));
        }}
      >
        Ask
      </button>
      <output>{answers.join(',')}</output>
      {dialog}
    </>
  );
}

const DELETE: ConfirmRequest = {
  message: 'Delete pipeline "Nightly"?\n\nIts triggers stop.\n\nThis cannot be undone.',
  confirmLabel: 'Delete',
};

describe('splitConfirmMessage', () => {
  it('takes the first paragraph as the title and the rest as the body', () => {
    expect(splitConfirmMessage(DELETE.message)).toEqual({
      title: 'Delete pipeline "Nightly"?',
      paragraphs: ['Its triggers stop.', 'This cannot be undone.'],
    });
    expect(splitConfirmMessage('Delete trigger "t"?')).toEqual({
      title: 'Delete trigger "t"?',
      paragraphs: [],
    });
  });
});

describe('useConfirm', () => {
  it('names the object in the title, lists the consequences, and answers true on the action', async () => {
    const user = userEvent.setup();
    render(<Harness request={DELETE} />);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete pipeline "Nightly"?' });
    expect(dialog).toHaveTextContent('Its triggers stop.');
    expect(dialog).toHaveTextContent('This cannot be undone.');
    const action = screen.getByRole('button', { name: 'Delete' });
    expect(action).toHaveClass('danger');
    await user.click(action);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('true');
  });

  it('answers false on Cancel and on Escape, and focuses Cancel first', async () => {
    const user = userEvent.setup();
    render(<Harness request={DELETE} />);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByRole('alertdialog');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('false,false');
  });

  it('keeps the action disabled until the exact name is typed', async () => {
    const user = userEvent.setup();
    render(<Harness request={{ ...DELETE, typeToConfirm: 'Nightly' }} />);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByRole('alertdialog');
    const action = screen.getByRole('button', { name: 'Delete' });
    const input = screen.getByLabelText('Type Nightly to confirm');
    await waitFor(() => expect(input).toHaveFocus());
    expect(action).toBeDisabled();
    await user.type(input, 'nightly{Enter}');
    expect(action).toBeDisabled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'Nightly');
    expect(action).toBeEnabled();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('true');
  });

  it('refuses a second question while one is open, and leaves the open one alone', async () => {
    let confirmFn: ((r: ConfirmRequest) => Promise<boolean>) | null = null;
    function Capture(): ReactNode {
      const [confirm, dialog] = useConfirm();
      confirmFn = confirm;
      return dialog;
    }
    const user = userEvent.setup();
    render(<Capture />);
    let first: Promise<boolean> | null = null;
    act(() => {
      first = confirmFn!({ ...DELETE, typeToConfirm: 'Nightly' });
    });
    const input = await screen.findByLabelText('Type Nightly to confirm');
    await user.type(input, 'Night');
    let second: Promise<boolean> | null = null;
    act(() => {
      second = confirmFn!({ message: 'Delete pipeline "Other"?', confirmLabel: 'Delete' });
    });
    await expect(second!).resolves.toBe(false);
    // Still the first question, half-typed name and all.
    expect(screen.getByRole('alertdialog', { name: 'Delete pipeline "Nightly"?' })).toBeInTheDocument();
    expect(input).toHaveValue('Night');
    await user.type(input, 'ly{Enter}');
    await expect(first!).resolves.toBe(true);
  });

  it('gives focus back to the button that asked, after Cancel, Escape and the action', async () => {
    const user = userEvent.setup();
    render(<Harness request={DELETE} />);
    const ask = screen.getByRole('button', { name: 'Ask' });
    for (const answer of ['cancel', 'escape', 'action'] as const) {
      await user.click(ask);
      await screen.findByRole('alertdialog');
      if (answer === 'cancel') await user.click(screen.getByRole('button', { name: 'Cancel' }));
      else if (answer === 'escape') await user.keyboard('{Escape}');
      else await user.click(screen.getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(ask).toHaveFocus());
    }
    expect(screen.getByRole('status')).toHaveTextContent('false,false,true');
  });

  it('gives focus to restoreFocus instead, when the asker is going away', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">More actions</button>
        <Harness
          request={{
            ...DELETE,
            restoreFocus: () => screen.getByRole('button', { name: 'More actions', hidden: true }),
          }}
        />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'More actions' })).toHaveFocus());
  });

  it('describes the dialog by its consequences, not only its title', async () => {
    const user = userEvent.setup();
    render(<Harness request={DELETE} />);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleDescription(
      'Its triggers stop. This cannot be undone.',
    );
  });

  it('answers an open question false when the page unmounts', async () => {
    let confirmFn: ((r: ConfirmRequest) => Promise<boolean>) | null = null;
    function Capture(): ReactNode {
      const [confirm, dialog] = useConfirm();
      confirmFn = confirm;
      return dialog;
    }
    const { unmount } = render(<Capture />);
    let pending: Promise<boolean> | null = null;
    act(() => {
      pending = confirmFn!(DELETE);
    });
    await screen.findByRole('alertdialog');
    unmount();
    await expect(pending!).resolves.toBe(false);
  });
});
