import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { parseWholeNumber } from '../triggers/formFields';
import { DraftNumberField } from './DraftNumberField';

/** #1393 — the field's error: reserved, wired to the input, and cleared once fixed. */
describe('DraftNumberField error', () => {
  function mount() {
    const onCommit = vi.fn();
    const view = render(
      <DraftNumberField
        label="Retries"
        stored={undefined}
        parse={parseWholeNumber}
        hint="How many times."
        onCommit={onCommit}
      />,
    );
    return { ...view, onCommit, input: screen.getByRole('textbox', { name: 'Retries' }) };
  }

  it('keeps the hint and fills a slot that was already there', () => {
    const { container, input } = mount();
    const slot = container.querySelector('.field-error-slot');
    expect(slot).not.toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('false');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.blur(input);
    const alert = screen.getByRole('alert');
    // The SAME slot, now populated — not a new element in the flow.
    expect(container.querySelector('.field-error-slot')).toBe(slot);
    expect(slot?.contains(alert)).toBe(true);
    expect(screen.getByText('How many times.')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  });

  it('clears the error as soon as the text is valid, before any blur', () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.blur(input);
    expect(screen.queryByRole('alert')).not.toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('does not raise an error while typing', () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: 'x' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
