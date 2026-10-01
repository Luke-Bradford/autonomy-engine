import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JsonEditor } from './JsonEditor';
import { LabelledControl } from '../LabelledControl';

function Harness({ initial, onValue }: { initial: string; onValue?: (v: string) => void }) {
  const [text, setText] = useState(initial);
  return (
    <LabelledControl label="Config (JSON)">
      {(id) => (
        <JsonEditor
          id={id}
          label="Config (JSON)"
          rows={6}
          aria-invalid={true}
          value={text}
          onValueChange={(next) => {
            onValue?.(next);
            setText(next);
          }}
        />
      )}
    </LabelledControl>
  );
}

describe('JsonEditor (#1396)', () => {
  it('is the labelled native text box, with code-editor text settings', () => {
    render(<Harness initial="{}" />);
    const box = screen.getByLabelText('Config (JSON)');
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveAttribute('rows', '6');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAttribute('spellcheck', 'false');
    expect(box).toHaveAttribute('wrap', 'off');
    expect(box).toHaveAttribute('dir', 'ltr');
    // The button is not a second match for the field's label.
    expect(screen.getAllByLabelText(/Config \(JSON\)/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Format JSON' })).toHaveAttribute(
      'aria-description',
      'Lays out Config (JSON) with two-space indents',
    );
  });

  it('lays JSON out with two-space indents, as an edit', async () => {
    const onValue = vi.fn();
    render(<Harness initial='{"a":[1,{"b":12345678901234567890}]}' onValue={onValue} />);
    await userEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    const expected = '{\n  "a": [\n    1,\n    {\n      "b": 12345678901234567890\n    }\n  ]\n}';
    expect(screen.getByLabelText('Config (JSON)')).toHaveValue(expected);
    expect(onValue).toHaveBeenCalledWith(expected);
    expect(screen.queryByText(/Not JSON/)).toBeNull();
  });

  it('does not edit text that is already laid out, or blank text', async () => {
    const onValue = vi.fn();
    const { unmount } = render(
      <Harness initial={JSON.stringify({ a: 1 }, null, 2)} onValue={onValue} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    unmount();
    render(<Harness initial="  " onValue={onValue} />);
    await userEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    expect(onValue).not.toHaveBeenCalled();
    expect(screen.queryByText(/Not JSON/)).toBeNull();
  });

  it('leaves text that is not JSON alone, selects the mistake and says where it is', async () => {
    const onValue = vi.fn();
    const text = '{\n  "a" 1\n}';
    render(<Harness initial={text} onValue={onValue} />);
    await userEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    const box = screen.getByLabelText<HTMLTextAreaElement>('Config (JSON)');
    expect(onValue).not.toHaveBeenCalled();
    expect(box).toHaveValue(text);
    expect(box).toHaveFocus();
    expect([box.selectionStart, box.selectionEnd]).toEqual([8, 9]);
    const message = screen.getByText("Not JSON at line 2, column 7: expected ':'");
    expect(message).toHaveAttribute('aria-live', 'polite');
    expect(box.getAttribute('aria-describedby')?.split(' ')).toContain(message.id);

    // The next edit clears it.
    await userEvent.type(box, ' ');
    expect(screen.queryByText(/Not JSON/)).toBeNull();
    // …and does not come back when the edit is undone by hand.
    await userEvent.type(box, '{Backspace}');
    expect(box).toHaveValue(text);
    expect(screen.queryByText(/Not JSON/)).toBeNull();
  });

  it('drops a problem once the value changes from outside, as a reset or another node would', () => {
    const props = { id: 'j', label: 'Params', onValueChange: () => undefined };
    const { rerender } = render(<JsonEditor {...props} value="[1 2]" />);
    fireEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    expect(screen.getByText(/Not JSON at line 1, column 4/)).toBeInTheDocument();
    rerender(<JsonEditor {...props} value="[3 4]" />);
    expect(screen.queryByText(/Not JSON/)).toBeNull();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-describedby');
  });

  it('lays out JSON with a no-break space around it, as the forms that trim would read it', () => {
    const onValueChange = vi.fn();
    render(
      <JsonEditor
        id="j"
        label="Params"
        value={'\u00a0{"a":1}\ufeff'}
        onValueChange={onValueChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    expect(onValueChange).toHaveBeenCalledWith('{\n  "a": 1\n}');
  });

  it('selects the whole of a two-unit character', () => {
    render(<JsonEditor id="j" label="Params" value={'["a" 😀]'} onValueChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    const box = screen.getByRole<HTMLTextAreaElement>('textbox');
    expect([box.selectionStart, box.selectionEnd]).toEqual([5, 7]);
  });

  it('says so when JSON is too deep to lay out', () => {
    const deep = '['.repeat(300) + ']'.repeat(300);
    render(<JsonEditor id="j" label="Params" value={deep} onValueChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    expect(screen.getByText('Nested more than 256 deep: too deep to lay out')).toBeInTheDocument();
  });

  it('cannot format a box that cannot be edited', () => {
    render(
      <JsonEditor id="j" label="Params" value="[1]" readOnly onValueChange={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Format JSON' })).toBeDisabled();
  });
});
