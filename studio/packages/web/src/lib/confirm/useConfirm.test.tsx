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

  it('answers a superseded question false, and a fresh question starts with an empty name', async () => {
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
    await user.type(await screen.findByLabelText('Type Nightly to confirm'), 'Night');
    let second: Promise<boolean> | null = null;
    act(() => {
      second = confirmFn!({ ...DELETE, typeToConfirm: 'Nightly' });
    });
    await expect(first!).resolves.toBe(false);
    expect(await screen.findByLabelText('Type Nightly to confirm')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(second!).resolves.toBe(false);
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
