import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunWindowsEditor } from './RunWindowsEditor';
import { blankRunWindowRow, type RunWindowsFormState } from './runWindowsForm';

/**
 * #1092 — ROW IDENTITY and WHERE FOCUS LANDS when a run-window row is removed.
 *
 * This file began as a CHARACTERIZATION test recording what `key={index}` did,
 * so a fix would have a measured baseline to move rather than a description to
 * argue with. The fix has landed and the assertions are inverted here; the
 * baseline they moved from is preserved in each test's comment, because "the
 * node is the same one" only means something against "it used to be a
 * different one".
 *
 * WHAT IS FIXED: React now matches rows by identity, so a surviving row keeps
 * the DOM element the operator was working in, and focus is placed deliberately
 * after a removal instead of coming to rest on a reused control that has
 * quietly changed meaning.
 *
 * WHAT IS NOT, and is not claimed to be: the visible LABELS are positional
 * (`Window 2 start` becomes `Window 1 start` when the row above it goes). That
 * renumbering is a property of numbering windows by position at all, not of the
 * keys, and it is out of scope for this ticket.
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
const removeButton = (n: number) => screen.getByRole('button', { name: `Remove window ${n}` });

describe('#1092 run-window row removal — identity and focus', () => {
  it("the DOM node holding a surviving row's data is the SAME node it was before the removal", async () => {
    const user = userEvent.setup();
    render(<Host initialRows={3} />);

    // The input the operator is editing, captured as a NODE — this is the
    // identity claim, and it is the one `key={index}` got wrong.
    const editing = startInput(3);
    expect(editing).toHaveValue('03:00');

    await user.click(removeButton(1));

    // That row's data is still on screen, one position up...
    const nowHolding = startInput(2);
    expect(nowHolding).toHaveValue('03:00');
    // ...in the SAME element. Under `key={index}` React reused positions 0 and 1
    // and unmounted position 2, so this node was destroyed and its value copied
    // into a node that had held a different window — taking the operator's
    // selection, caret and any in-flight IME composition with it.
    expect(nowHolding).toBe(editing);
    expect(editing.isConnected).toBe(true);
  });

  it('keyboard removal moves focus to the NEIGHBOUR that inherits the position, not to a reused button', async () => {
    const user = userEvent.setup();
    render(<Host initialRows={3} />);
    expect(startInput(3)).toHaveValue('03:00');

    // Keyboard, not mouse: the operator tabs to "Remove window 1" and presses
    // Enter, so focus is on that button when the list re-renders.
    const remove1 = removeButton(1);
    remove1.focus();
    await user.keyboard('{Enter}');

    // Row 0's data is gone; two rows remain and their data shifted down.
    expect(startInput(1)).toHaveValue('02:00');
    expect(startInput(2)).toHaveValue('03:00');

    // The button that was focused is GONE — its whole row unmounted, which is
    // the point. Under `key={index}` it survived, still labelled "Remove window
    // 1", still focused, and now aimed at the window that used to be second: a
    // second Enter would have removed a window the operator never chose.
    expect(remove1.isConnected).toBe(false);
    // Focus was placed on the row that inherited the position, so a keyboard
    // user is neither stranded on <body> nor left holding a changed control.
    expect(document.activeElement).toBe(removeButton(1));
    expect(document.activeElement).not.toBe(remove1);
  });

  it('removing the LAST row moves focus to the row before it', async () => {
    const user = userEvent.setup();
    render(<Host initialRows={3} />);

    // There is no row below to inherit the position, so the fallback is the one
    // above — the nearest control of the same kind.
    const remove2 = removeButton(2);
    await user.click(removeButton(3));

    expect(screen.queryByLabelText('Window 3 start')).toBeNull();
    expect(document.activeElement).toBe(remove2);
    expect(remove2.isConnected).toBe(true);
  });

  it('removing the ONLY row moves focus to "Add window" rather than stranding on <body>', async () => {
    const user = userEvent.setup();
    render(<Host initialRows={1} />);

    await user.click(removeButton(1));

    expect(screen.queryByLabelText('Window 1 start')).toBeNull();
    // The pane's one control that always exists — the same fallback
    // `FactoryResources` uses when the row it wanted to return to has gone.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add window' }));
  });

  it('no row data is corrupted by the removal — every field is controlled', async () => {
    const user = userEvent.setup();
    render(<Host initialRows={3} />);
    await user.click(removeButton(2));

    // Unchanged by the fix, and asserted for exactly that reason: #1092 was a
    // focus/identity wart and never a data defect, so the saved windows were
    // correct before and must still be.
    expect(startInput(1)).toHaveValue('01:00');
    expect(startInput(2)).toHaveValue('03:00');
    expect(screen.queryByLabelText('Window 3 start')).toBeNull();
  });

  it('a row ADDED after a removal is a new row, and does not inherit the removed row’s element', async () => {
    const user = userEvent.setup();
    render(<Host initialRows={2} />);

    const survivor = startInput(2);
    await user.click(removeButton(1));
    expect(startInput(1)).toBe(survivor);

    await user.click(screen.getByRole('button', { name: 'Add window' }));
    expect(startInput(1)).toBe(survivor);
    // The new row is genuinely new: blank, and a different element from either
    // the survivor or the row that was removed.
    expect(startInput(2)).toHaveValue('');
    expect(startInput(2)).not.toBe(survivor);
  });
});
