import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { closeOnEscape, closeOnLeave, closeOnOutsidePointer } from './helpDisclosure';

function help() {
  render(
    <>
      <details
        onKeyDown={closeOnEscape}
        onBlur={closeOnLeave}
        onToggle={closeOnOutsidePointer}
        data-testid="help"
      >
        <summary>?</summary>
        <span tabIndex={-1}>inside</span>
      </details>
      <button type="button">outside</button>
      <p>plain text</p>
    </>,
  );
  const details = screen.getByTestId('help') as HTMLDetailsElement;
  details.open = true;
  // jsdom queues `toggle` like a browser; dispatch it so the listener arms now.
  fireEvent(details, new Event('toggle'));
  return details;
}

describe('the ? help disclosure (#1484 M2)', () => {
  it('closes on Escape and hands focus back to its summary', () => {
    const details = help();
    fireEvent.keyDown(screen.getByText('inside'), { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(screen.getByText('?'));
  });

  it('closes when focus moves outside it, not inside it, and not to nothing', () => {
    const details = help();
    fireEvent.blur(screen.getByText('?'), { relatedTarget: screen.getByText('inside') });
    expect(details.open).toBe(true);
    // The window losing focus, or a click on text: no `relatedTarget`.
    fireEvent.blur(screen.getByText('inside'), { relatedTarget: null });
    expect(details.open).toBe(true);
    fireEvent.blur(screen.getByText('inside'), { relatedTarget: screen.getByText('outside') });
    expect(details.open).toBe(false);
  });

  it('closes on a pointer press outside it, and not on one inside it', () => {
    const details = help();
    fireEvent.pointerDown(screen.getByText('inside'));
    expect(details.open).toBe(true);
    fireEvent.pointerDown(screen.getByText('plain text'));
    expect(details.open).toBe(false);
  });
});
