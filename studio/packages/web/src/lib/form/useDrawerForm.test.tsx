import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { useDrawerForm, type DrawerForm } from './useDrawerForm';

/** The signature is the form itself: a string form is dirty when it changes. */
const identity = (form: string) => form;

/** Mount the hook in a data router (its route hold needs one) and expose it. */
function mountHook(): { current: () => DrawerForm<string> } {
  let latest: DrawerForm<string> | null = null;
  function Probe() {
    latest = useDrawerForm(identity);
    return latest.guard.routeHold;
  }
  const router = createMemoryRouter([{ path: '*', element: <Probe /> }]);
  render(<RouterProvider router={router} />);
  return { current: () => latest! };
}

describe('useDrawerForm (#1396)', () => {
  it('a save that lands after another form opened does not close the new one', () => {
    const hook = mountHook();
    act(() => hook.current().openForm('first'));
    const firstSeq = hook.current().seq;
    act(() => hook.current().openForm('second'));
    expect(hook.current().seq).toBeGreaterThan(firstSeq);

    act(() => hook.current().closeIfLatest(firstSeq));
    expect(hook.current().form).toBe('second');
    act(() => hook.current().closeIfLatest(hook.current().seq));
    expect(hook.current().form).toBeNull();
  });

  it('a form opened against a baseline is dirty until it matches it (#1477)', () => {
    const hook = mountHook();
    act(() => hook.current().openForm('pasted', ''));
    expect(hook.current().dirty).toBe(true);
    act(() => hook.current().setForm(''));
    expect(hook.current().dirty).toBe(false);
    act(() => hook.current().openForm('plain'));
    expect(hook.current().dirty).toBe(false);
  });

  it('closeWhere closes only a matching form, dirty or not, without the prompt', () => {
    const hook = mountHook();
    act(() => hook.current().openForm('kept'));
    act(() => hook.current().setForm('kept, edited'));
    act(() => hook.current().closeWhere((open) => open === 'other'));
    expect(hook.current().form).toBe('kept, edited');
    act(() => hook.current().closeWhere((open) => open.startsWith('kept')));
    expect(hook.current().form).toBeNull();
    expect(hook.current().guard.confirming).toBe(false);
  });

  it('closes a clean form at once, and holds a dirty one at the prompt', () => {
    const hook = mountHook();
    act(() => hook.current().openForm('opened'));
    act(() => hook.current().requestClose());
    expect(hook.current().form).toBeNull();

    act(() => hook.current().openForm('opened'));
    act(() => hook.current().setForm('edited'));
    act(() => hook.current().requestClose());
    expect(hook.current().guard.confirming).toBe(true);
    expect(hook.current().form).toBe('edited');
    act(() => hook.current().guard.discard());
    expect(hook.current().form).toBeNull();
  });

  it('records the opener only when the held open goes ahead', () => {
    const hook = mountHook();
    const first = document.createElement('button');
    const second = document.createElement('button');
    act(() => hook.current().openFrom(first, () => hook.current().openForm('a')));
    expect(hook.current().openerRef.current).toBe(first);

    act(() => hook.current().setForm('a edited'));
    act(() => hook.current().openFrom(second, () => hook.current().openForm('b')));
    // Held at the prompt, then abandoned: the form and its opener stay.
    act(() => hook.current().guard.keep());
    expect(hook.current().form).toBe('a edited');
    expect(hook.current().openerRef.current).toBe(first);
  });

  describe('a save that outlives its form (#1438)', () => {
    it('isOpen is false once the form is replaced, closed, or closed by a delete', () => {
      const hook = mountHook();
      act(() => hook.current().openForm('first'));
      const first = hook.current().seq;
      expect(hook.current().isOpen(first)).toBe(true);
      act(() => hook.current().openForm('second'));
      expect(hook.current().isOpen(first)).toBe(false);
      const second = hook.current().seq;
      // A delete closes without a new open, so the seq alone would still match.
      act(() => hook.current().closeWhere(() => true));
      expect(hook.current().isLatest(second)).toBe(true);
      expect(hook.current().isOpen(second)).toBe(false);
    });

    it('records a failure only for a form that has gone, until a form next opens', () => {
      const hook = mountHook();
      act(() => hook.current().openForm('first'));
      const first = hook.current().seq;
      act(() => hook.current().saveFailedFor(first)('shown in the form'));
      expect(hook.current().lostSave).toBeNull();

      act(() => hook.current().openForm('second'));
      act(() => hook.current().saveFailedFor(first)('Could not save “first”: boom'));
      expect(hook.current().lostSave).toBe('Could not save “first”: boom');

      act(() => hook.current().openForm('third'));
      expect(hook.current().lostSave).toBeNull();
    });
  });
});
