import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { parseWholeNumber } from '../triggers/formFields';
import { useFieldErrorLine } from '../../lib/form/FieldErrorLine';
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
        about="How many times."
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
    // #1594 OR40 S3c-2 — the meaning is behind a `?` beside the label, and
    // still the input's description after its error.
    expect(container.querySelector('summary')?.getAttribute('aria-label')).toBe('About Retries');
    expect(input).toHaveAccessibleDescription(`${alert.textContent} How many times.`);
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

/** #1694 OR42 item 5 — fields that share ONE reserved line reserve none of their own. */
describe('DraftNumberField in a shared error line', () => {
  function Group() {
    const errors = useFieldErrorLine();
    return (
      <>
        {(['Retries', 'Timeout'] as const).map((label) => (
          <DraftNumberField
            key={label}
            label={label}
            unit={label === 'Timeout' ? 'seconds' : undefined}
            stored={undefined}
            parse={parseWholeNumber}
            about="How many."
            onCommit={vi.fn()}
            errorLine={errors.node}
          />
        ))}
        {errors.line}
      </>
    );
  }

  function invalid(name: string) {
    const input = screen.getByRole('textbox', { name });
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.blur(input);
    return input;
  }

  it('reserves one line for the group, and the error lands in it, named', () => {
    const { container } = render(<Group />);
    const slots = container.querySelectorAll('.field-error-slot');
    expect(slots).toHaveLength(1);
    const line = slots[0]!;
    // The line is the group's last child: no field sits under it.
    expect(container.lastElementChild).toBe(line);
    const input = invalid('Retries');
    const alert = screen.getByRole('alert');
    expect(line.contains(alert)).toBe(true);
    expect(alert.textContent).toMatch(/^Retries: .*whole number/);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    // Named by the title alone; the unit is not part of the name.
    invalid('Timeout (seconds)');
    expect(screen.getAllByRole('alert').map((a) => a.textContent?.split(':')[0])).toEqual([
      'Retries',
      'Timeout',
    ]);
    expect(container.querySelectorAll('.field-error-slot')).toHaveLength(1);
  });

  it("clears only the fixed field's error", () => {
    render(<Group />);
    const retries = invalid('Retries');
    invalid('Timeout (seconds)');
    fireEvent.change(retries, { target: { value: '2' } });
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([
      expect.stringMatching(/^Timeout: /),
    ]);
  });
});
