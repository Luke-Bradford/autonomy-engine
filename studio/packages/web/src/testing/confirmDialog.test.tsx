import { useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { answerConfirm } from './confirmDialog';

/**
 * A dialog that is in the tree before its buttons are, as a Fluent dialog is
 * while it mounts on a slow runner (#1495).
 */
function SlowDialog({ onAnswer }: { onAnswer: (a: string) => void }) {
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 50);
    return () => clearTimeout(t);
  }, []);
  if (!open) return null;
  const answer = (a: string) => {
    onAnswer(a);
    setOpen(false);
  };
  return (
    <div role="alertdialog" aria-label="Cancel run?">
      Cancel run r1?
      {ready && (
        <>
          <button onClick={() => answer('cancel')}>Keep running</button>
          <button onClick={() => answer('accept')}>Cancel run</button>
        </>
      )}
    </div>
  );
}

describe('answerConfirm', () => {
  it('waits for the dialog buttons, not just the dialog (#1495)', async () => {
    const answers: string[] = [];
    render(<SlowDialog onAnswer={(a) => answers.push(a)} />);
    const text = await answerConfirm(userEvent.setup(), 'accept');
    expect(answers).toEqual(['accept']);
    expect(text).toContain('Cancel run r1?');
  });
});
