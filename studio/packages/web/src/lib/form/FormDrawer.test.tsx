import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { FormDrawer } from './FormDrawer';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

/** A drawer whose `busy` the test flips, as a save starting and failing would. */
function mountDrawer() {
  let setBusy: (busy: boolean) => void = () => {};
  function Probe() {
    const [busy, set] = useState(false);
    setBusy = set;
    const guard = useUnsavedChangesGuard(false);
    return (
      <FormDrawer
        title="New thing"
        formLabel="Thing form"
        guard={guard}
        onRequestClose={() => {}}
        onSubmit={(event) => event.preventDefault()}
        busy={busy}
        actions={<button type="submit">Save</button>}
      >
        <label>
          Name
          <input />
        </label>
        <label>
          Note
          <input />
        </label>
      </FormDrawer>
    );
  }
  const router = createMemoryRouter([{ path: '*', element: <Probe /> }]);
  render(<RouterProvider router={router} />);
  return { setBusy: (busy: boolean) => act(() => setBusy(busy)) };
}

const body = () =>
  screen.getByRole('form', { name: 'Thing form' }).querySelector('.form-drawer-body')!;

describe('FormDrawer while busy (#1438)', () => {
  it('makes the fields inert while a save is in flight, and live again after', () => {
    const { setBusy } = mountDrawer();
    expect(body()).not.toHaveAttribute('inert');
    setBusy(true);
    expect(body()).toHaveAttribute('inert');
    expect(body()).toHaveAttribute('aria-busy', 'true');
    setBusy(false);
    expect(body()).not.toHaveAttribute('inert');
    expect(body()).not.toHaveAttribute('aria-busy');
  });

  it('gives focus back to the field the operator was in when the save fails', () => {
    const { setBusy } = mountDrawer();
    const note = screen.getByRole('textbox', { name: 'Note' });
    act(() => note.focus());
    setBusy(true);
    // What a browser does to focus inside an inert subtree; jsdom does not.
    act(() => note.blur());
    expect(document.body).toHaveFocus();
    setBusy(false);
    expect(note).toHaveFocus();
  });

  it('leaves focus alone if the operator has moved it since', () => {
    const { setBusy } = mountDrawer();
    const note = screen.getByRole('textbox', { name: 'Note' });
    // The footer is outside the inert body.
    const save = screen.getByRole('button', { name: 'Save' });
    act(() => note.focus());
    setBusy(true);
    act(() => save.focus());
    setBusy(false);
    expect(save).toHaveFocus();
  });
});
