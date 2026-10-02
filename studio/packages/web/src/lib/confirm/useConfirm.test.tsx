import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pressInConfirm, setConfirmName } from '../../testing/confirmDialog';
import { useEffect, useState, type ReactNode } from 'react';
import { splitConfirmMessage } from './splitConfirmMessage';
import { ConfirmHost, useConfirm, type ConfirmRequest } from './useConfirm';

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

type Ask = (r: ConfirmRequest) => Promise<boolean>;

/** Hands the hook's `confirm` to the test, to ask questions from outside a click. */
function Capture({ onReady }: { onReady: (confirm: Ask) => void }): ReactNode {
  const [confirm, dialog] = useConfirm();
  useEffect(() => onReady(confirm), [onReady, confirm]);
  return dialog;
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

  it('draws a non-destructive action as primary, never as danger', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        request={{
          message: 'Restore v1?\n\nEvery existing version is kept.',
          confirmLabel: 'Restore',
          tone: 'primary',
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByRole('alertdialog');
    const action = screen.getByRole('button', { name: 'Restore' });
    expect(action).toHaveClass('primary');
    expect(action).not.toHaveClass('danger');
  });

  it('labels the dismiss button as asked, focuses it first, and it still answers false', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        request={{
          message: 'Cancel this run?',
          confirmLabel: 'Cancel run',
          cancelLabel: 'Keep running',
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByRole('alertdialog');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    const keep = screen.getByRole('button', { name: 'Keep running' });
    await waitFor(() => expect(keep).toHaveFocus());
    await user.click(keep);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('false');
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
    pressInConfirm('Escape');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('false,false'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
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
    setConfirmName('Nightly', 'nightly');
    pressInConfirm('Enter', input);
    expect(action).toBeDisabled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    setConfirmName('Nightly', 'Nightly');
    expect(input).toHaveValue('Nightly');
    expect(action).toBeEnabled();
    pressInConfirm('Enter', input);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('true'));
  });

  it('refuses a second question while one is open, and leaves the open one alone', async () => {
    let ask: Ask | null = null;
    render(
      <Capture
        onReady={(c) => {
          ask = c;
        }}
      />,
    );
    let first: Promise<boolean> | null = null;
    act(() => {
      first = ask!({ ...DELETE, typeToConfirm: 'Nightly' });
    });
    const input = await screen.findByLabelText('Type Nightly to confirm');
    setConfirmName('Nightly', 'Night');
    let second: Promise<boolean> | null = null;
    act(() => {
      second = ask!({ message: 'Delete pipeline "Other"?', confirmLabel: 'Delete' });
    });
    await expect(second!).resolves.toBe(false);
    // Still the first question, half-typed name and all.
    expect(
      screen.getByRole('alertdialog', { name: 'Delete pipeline "Nightly"?' }),
    ).toBeInTheDocument();
    expect(input).toHaveValue('Night');
    setConfirmName('Nightly', 'Nightly');
    pressInConfirm('Enter', input);
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
      else if (answer === 'escape') pressInConfirm('Escape');
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

  it('answers false at once when asked after the page has gone', async () => {
    let ask: Ask | null = null;
    const { unmount } = render(
      <Capture
        onReady={(c) => {
          ask = c;
        }}
      />,
    );
    unmount();
    await expect(ask!(DELETE)).resolves.toBe(false);
  });

  it('does not confirm on an Enter that commits an IME composition', async () => {
    const user = userEvent.setup();
    render(<Harness request={{ ...DELETE, typeToConfirm: 'Nightly' }} />);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    const input = await screen.findByLabelText('Type Nightly to confirm');
    setConfirmName('Nightly', 'Nightly');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    pressInConfirm('Enter', input);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('true'));
  });

  it('answers an open question false when the page unmounts', async () => {
    let ask: Ask | null = null;
    const { unmount } = render(
      <Capture
        onReady={(c) => {
          ask = c;
        }}
      />,
    );
    let pending: Promise<boolean> | null = null;
    act(() => {
      pending = ask!(DELETE);
    });
    await screen.findByRole('alertdialog');
    unmount();
    await expect(pending!).resolves.toBe(false);
  });

  describe('under a ConfirmHost', () => {
    it('shows the question once, in the host, though the page renders its own slot', async () => {
      const user = userEvent.setup();
      function Page() {
        const [confirm, dialog] = useConfirm();
        return (
          <>
            <button type="button" onClick={() => void confirm(DELETE)}>
              Ask
            </button>
            {dialog}
          </>
        );
      }
      render(
        <ConfirmHost>
          <Page />
        </ConfirmHost>,
      );
      await user.click(screen.getByRole('button', { name: 'Ask' }));
      await screen.findByRole('alertdialog');
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    });

    it('closes the question when the page that asked it goes away, answering false', async () => {
      let ask: Ask | null = null;
      function App({ showPage }: { showPage: boolean }) {
        return (
          <ConfirmHost>
            {showPage && (
              <Capture
                onReady={(c) => {
                  ask = c;
                }}
              />
            )}
          </ConfirmHost>
        );
      }
      const { rerender } = render(<App showPage />);
      let pending: Promise<boolean> | null = null;
      act(() => {
        pending = ask!(DELETE);
      });
      await screen.findByRole('alertdialog');
      rerender(<App showPage={false} />);
      await expect(pending!).resolves.toBe(false);
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    });

    it("does not withdraw ANOTHER asker's question when an unrelated page goes away", async () => {
      let askA: Ask | null = null;
      function App({ showB }: { showB: boolean }) {
        return (
          <ConfirmHost>
            <Capture
              onReady={(c) => {
                askA = c;
              }}
            />
            {showB && <Capture onReady={() => {}} />}
          </ConfirmHost>
        );
      }
      const { rerender } = render(<App showB />);
      act(() => {
        void askA!(DELETE);
      });
      await screen.findByRole('alertdialog');
      rerender(<App showB={false} />);
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
  });
});
