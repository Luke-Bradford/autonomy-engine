import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigFieldControl, type FieldPicker } from './ConfigFieldControl';
import type { ConfigField } from './configForm';

/**
 * #1694 OR42 F10 — ⤢ opens a config field in a full-size editor.
 *
 * jsdom has `HTMLDialogElement` but no `showModal`, so it is stubbed here to set
 * `open`. The top layer, inertness and focus return past it are therefore
 * e2e-only (`e2e/expression-editor.spec.ts`); these tests pin the React half:
 * the draft, OK, Cancel, the insert target and the keys. The `cancel`/`close`
 * backstops are tested nowhere: no key reaches them while `onKeyDown` is there.
 */
const realShowModal = HTMLDialogElement.prototype.showModal;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = realShowModal;
});

const picker: FieldPicker = {
  describe: (s) => s.name ?? s.ref,
  resolve: () => ({
    mode: 'insert',
    suggestions: [
      {
        ref: 'pipeline.parameters.city',
        insert: '${pipeline.parameters.city}',
        kind: 'param',
        name: 'city',
        declaredType: 'string',
        availability: 'available',
      },
    ],
  }),
  wraps: () => [],
  examples: () => ({ mode: 'insert', functions: [] }),
};

const prompt: ConfigField = { name: 'prompt', kind: 'text', optional: false };

function setup(field: ConfigField = prompt, value = 'Hello') {
  const onChange = vi.fn();
  const outerKey = vi.fn();
  render(
    // A page-level key handler, as the dock and canvas have: the editor's keys
    // must not reach it.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div onKeyDown={outerKey}>
      <ConfigFieldControl field={field} value={value} onChange={onChange} picker={picker} />
    </div>,
  );
  return { onChange, outerKey, opener: screen.getByRole('button', { name: /in the editor$/ }) };
}

const editorBox = () =>
  screen.getByRole('dialog', { name: 'prompt' }).querySelector('textarea') as HTMLTextAreaElement;

describe('ExpressionEditor — ⤢ on a config field (#1694 OR42 F10)', () => {
  it('opens a modal editor seeded with the field, named by it', () => {
    const { opener } = setup();
    expect(opener).toHaveAccessibleName('Open prompt in the editor');
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'prompt' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('open');
    expect(editorBox().value).toBe('Hello');
    expect(document.activeElement).toBe(editorBox());
  });

  it('OK writes the draft through onChange once, and closes', () => {
    const { onChange, opener } = setup();
    fireEvent.click(opener);
    fireEvent.change(editorBox(), { target: { value: 'Hello ${x}' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('Hello ${x}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('OK with the text unchanged writes nothing', () => {
    const { onChange, opener } = setup();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Cancel and Escape discard the draft', () => {
    const { onChange, opener } = setup();
    fireEvent.click(opener);
    fireEvent.change(editorBox(), { target: { value: 'gone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    expect(editorBox().value).toBe('Hello');
    fireEvent.change(editorBox(), { target: { value: 'gone too' } });
    fireEvent.keyDown(editorBox(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a reference lands in the editor's draft, not in the field", () => {
    const { onChange, opener } = setup();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'prompt' });
    const toggle = dialog.querySelector<HTMLButtonElement>(
      'button[aria-label="Insert reference into prompt"]',
    )!;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /^city/ }));
    expect(editorBox().value).toBe('Hello${pipeline.parameters.city}');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onChange).toHaveBeenCalledWith('Hello${pipeline.parameters.city}');
  });

  it('an Escape the flyout takes closes its list, not the editor', () => {
    const { opener } = setup();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'prompt' });
    const toggle = dialog.querySelector<HTMLButtonElement>(
      'button[aria-label="Insert reference into prompt"]',
    )!;
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(toggle, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('dialog', { name: 'prompt' })).toBeInTheDocument();
  });

  it("keeps its keys from the page's handlers", () => {
    const { outerKey, opener } = setup();
    fireEvent.click(opener);
    fireEvent.keyDown(editorBox(), { key: 'z', metaKey: true });
    fireEvent.keyDown(editorBox(), { key: 'Escape' });
    expect(outerKey).not.toHaveBeenCalled();
  });

  it('⌘Enter is OK in a multi-line field; a plain Enter is a line break', () => {
    const { onChange, opener } = setup();
    fireEvent.click(opener);
    fireEvent.keyDown(editorBox(), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'prompt' })).toBeInTheDocument();
    fireEvent.change(editorBox(), { target: { value: 'a\nb' } });
    fireEvent.keyDown(editorBox(), { key: 'Enter', metaKey: true });
    expect(onChange).toHaveBeenCalledWith('a\nb');
  });

  it('a one-line field takes no line break, and Enter is OK', () => {
    const url: ConfigField = { name: 'prompt', kind: 'text', optional: false, singleLine: true };
    const { onChange, opener } = setup(url, 'https://x');
    fireEvent.click(opener);
    fireEvent.change(editorBox(), { target: { value: 'https://x/\n${a}' } });
    expect(editorBox().value).toBe('https://x/${a}');
    fireEvent.keyDown(editorBox(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('https://x/${a}');
  });

  it('is offered on a top-level text field only', () => {
    const literal: ConfigField = { name: 'key', kind: 'text', optional: false, literal: true };
    render(<ConfigFieldControl field={literal} value="" onChange={vi.fn()} picker={picker} />);
    render(<ConfigFieldControl field={prompt} value="" onChange={vi.fn()} />);
    // A table cell: named by its row, with the flyout but no ⤢.
    render(
      <ConfigFieldControl
        field={prompt}
        name="Mapping row 1 expression"
        value=""
        onChange={vi.fn()}
        picker={picker}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Insert reference into mapping row 1 expression' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /in the editor$/ })).toBeNull();
  });

  it('Ctrl+Enter is OK too', () => {
    const { onChange, opener } = setup();
    fireEvent.click(opener);
    fireEvent.change(editorBox(), { target: { value: 'b' } });
    fireEvent.keyDown(editorBox(), { key: 'Enter', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('the Enter that ends an IME composition is not OK', () => {
    const url: ConfigField = { name: 'prompt', kind: 'text', optional: false, singleLine: true };
    const { onChange, opener } = setup(url, 'x');
    fireEvent.click(opener);
    fireEvent.change(editorBox(), { target: { value: 'xか' } });
    fireEvent.keyDown(editorBox(), { key: 'Enter', isComposing: true });
    expect(screen.getByRole('dialog', { name: 'prompt' })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an untouched OK does not put back the text over a change made while open', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ConfigFieldControl field={prompt} value="a" onChange={onChange} picker={picker} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open prompt in the editor' }));
    rerender(<ConfigFieldControl field={prompt} value="b" onChange={onChange} picker={picker} />);
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
