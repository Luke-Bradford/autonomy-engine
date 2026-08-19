import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunWindowsEditor } from './RunWindowsEditor';
import { blankRunWindowRow, type RunWindowsFormState } from './runWindowsForm';

/**
 * #1092 — WHERE FOCUS LANDS when a run-window row is removed.
 *
 * This is a CHARACTERIZATION test: it records what the editor does today, so a
 * later fix has a measured baseline to move rather than a description to argue
 * with. The ticket reported that removing a middle row "moves focus to a
 * different logical window", and the honest answer turned out to be narrower —
 * which is the whole reason to pin it before changing anything.
 *
 * `key={index}` (RunWindowsEditor.tsx) means React matches rows by POSITION, so
 * removing row 0 of three keeps the DOM nodes of positions 0 and 1 and unmounts
 * position 2's — even though the row that logically went away was the first.
 * Every row's data shifts down into a reused DOM node.
 */

/** The editor is controlled, so a host holds the state a real form would. */
function Host({ initialRows }: { initialRows: number }) {
  const [value, setValue] = useState<RunWindowsFormState>(() => ({
    restricted: true,
    rows: Array.from({ length: initialRows }, (_, i) => ({
      ...blankRunWindowRow(),
      start: `0${i + 1}:00`,
      end: `0${i + 2}:00`,
    })),
  }));
  return <RunWindowsEditor value={value} onChange={setValue} mode="schedule" />;
}

const startInput = (n: number) => screen.getByLabelText(`Window ${n} start`);

describe('#1092 run-window row removal and focus', () => {
  it('keyboard removal of the FIRST of three rows leaves focus on a button that now removes a DIFFERENT window', async () => {
    const user = userEvent.setup();
    render(<Host initialRows={3} />);
    expect(startInput(3)).toHaveValue('03:00');

    // Keyboard, not mouse: the operator tabs to "Remove window 1" and presses
    // Enter, so focus is on that button when the list re-renders.
    const remove1 = screen.getByRole('button', { name: 'Remove window 1' });
    remove1.focus();
    await user.keyboard('{Enter}');

    // Row 0's data is gone; two rows remain and their data shifted down.
    expect(startInput(1)).toHaveValue('02:00');
    expect(startInput(2)).toHaveValue('03:00');

    // THE WART: position 0's button was reused, so focus is still on it — and it
    // is still labelled "Remove window 1", which now means the row that used to
    // be window 2. A second Enter removes a window the operator never chose to
    // aim at. Stable per-row keys would instead unmount this button (focus would
    // fall to <body>), which is why the fix is not a one-line key swap.
    expect(document.activeElement).toBe(remove1);
    expect(remove1).toHaveAccessibleName('Remove window 1');
    expect(startInput(1)).toHaveValue('02:00');
  });

  it("the DOM node holding a row's data is NOT the node that held it before the removal", async () => {
    const user = userEvent.setup();
    render(<Host initialRows={3} />);

    // The input the operator is editing, captured as a NODE — this is the
    // identity claim, and it is the one `key={index}` gets wrong.
    const editing = startInput(3);
    expect(editing).toHaveValue('03:00');

    await user.click(screen.getByRole('button', { name: 'Remove window 1' }));

    // That row's data is still on screen, one position up...
    const nowHolding = startInput(2);
    expect(nowHolding).toHaveValue('03:00');
    // ...but in a DIFFERENT element: React reused positions 0 and 1 and
    // unmounted position 2, so the node the operator had focused/selected/was
    // mid-IME-composition in is gone, and its data was copied into a node that
    // used to hold a different window. Per-row keys are what would make these
    // the same element.
    expect(nowHolding).not.toBe(editing);
    expect(editing.isConnected).toBe(false);
  });

  it('no row data is corrupted by the reuse — every field is controlled', async () => {
    const user = userEvent.setup();
    render(<Host initialRows={3} />);
    await user.click(screen.getByRole('button', { name: 'Remove window 2' }));

    // The saved windows are always correct, which is why #1092 is a focus wart
    // and not a data defect.
    expect(startInput(1)).toHaveValue('01:00');
    expect(startInput(2)).toHaveValue('03:00');
    expect(screen.queryByLabelText('Window 3 start')).toBeNull();
  });
});
