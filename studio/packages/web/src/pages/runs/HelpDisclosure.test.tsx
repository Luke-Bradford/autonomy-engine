import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelpDisclosure } from './HelpDisclosure';

function help() {
  const view = render(
    <>
      <HelpDisclosure label="About it" noteId="note">
        inside
      </HelpDisclosure>
      <button type="button">outside</button>
      <p>plain text</p>
    </>,
  );
  const details = screen.getByText('inside').closest('details')!;
  // Opened as a click on the summary would; `toggle` is dispatched explicitly
  // because jsdom does not fire it from the property.
  act(() => {
    details.open = true;
    fireEvent(details, new Event('toggle'));
  });
  return { details, ...view };
}

afterEach(() => vi.restoreAllMocks());

describe('HelpDisclosure (#1484 M2 — the ? help)', () => {
  it('is the note’s label and description hook', () => {
    help();
    expect(screen.getByLabelText('About it').tagName).toBe('SUMMARY');
    expect(document.getElementById('note')).toHaveTextContent('inside');
  });

  it('closes on Escape and hands focus back to its summary', () => {
    const { details } = help();
    fireEvent.keyDown(screen.getByText('inside'), { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('About it'));
  });

  it('closes when focus moves outside it, not inside it, and not to nothing', () => {
    const { details } = help();
    fireEvent.blur(screen.getByLabelText('About it'), {
      relatedTarget: screen.getByText('inside'),
    });
    expect(details.open).toBe(true);
    // The window losing focus, or a click on text: no `relatedTarget`.
    fireEvent.blur(screen.getByText('inside'), { relatedTarget: null });
    expect(details.open).toBe(true);
    fireEvent.blur(screen.getByText('inside'), { relatedTarget: screen.getByText('outside') });
    expect(details.open).toBe(false);
  });

  it('closes on a pointer press outside it, and not on one inside it', () => {
    const { details } = help();
    fireEvent.pointerDown(screen.getByText('inside'));
    expect(details.open).toBe(true);
    fireEvent.pointerDown(screen.getByText('plain text'));
    expect(details.open).toBe(false);
  });

  it('removes its document listener when it unmounts while open', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = help();
    const armed = add.mock.calls.find(([type]) => type === 'pointerdown');
    expect(armed).toBeDefined();
    unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', armed![1], true);
  });
});
