import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { closeOnEscape, closeOnLeave } from './helpDisclosure';

function help() {
  render(
    <>
      <details open onKeyDown={closeOnEscape} onBlur={closeOnLeave} data-testid="help">
        <summary>?</summary>
        <span tabIndex={-1}>inside</span>
      </details>
      <button type="button">outside</button>
    </>,
  );
  return screen.getByTestId('help') as HTMLDetailsElement;
}

describe('the ? help disclosure (#1484 M2)', () => {
  it('closes on Escape and hands focus back to its summary', () => {
    const details = help();
    fireEvent.keyDown(screen.getByText('inside'), { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(screen.getByText('?'));
  });

  it('closes when focus leaves it, not when it moves inside it', () => {
    const details = help();
    fireEvent.blur(screen.getByText('?'), { relatedTarget: screen.getByText('inside') });
    expect(details.open).toBe(true);
    fireEvent.blur(screen.getByText('inside'), { relatedTarget: screen.getByText('outside') });
    expect(details.open).toBe(false);
  });
});
