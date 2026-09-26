import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ConfigFieldControl } from './ConfigFieldControl';
import type { ConfigField } from './configForm';

const noop = (): void => undefined;

/**
 * The text a `<label>` reads as, for the control it names (#1227).
 *
 * `textContent` rather than an accessible-name query on purpose: Playwright's
 * `getByLabel` reads the label's TEXT, and a label that WRAPS its control also
 * reads the control's own text — a textarea's value, every option of a select.
 * An accessible-name query would pass either way, which is exactly how the trap
 * survived every spec that fills a field once and never re-reads it.
 */
function labelTextOf(control: HTMLElement): string[] {
  const labels = (control as HTMLTextAreaElement | HTMLSelectElement).labels;
  return Array.from(labels ?? [], (label) => label.textContent ?? '');
}

describe('ConfigFieldControl — a label names its control and nothing else (#1227)', () => {
  it('a text field keeps its label once the field holds a value', () => {
    const field: ConfigField = { name: 'path', kind: 'text', optional: false };
    const { container } = render(
      <ConfigFieldControl field={field} value="/private/var/book.xlsx" onChange={noop} />,
    );
    const textarea = container.querySelector('textarea')!;
    expect(textarea.value).toBe('/private/var/book.xlsx');
    expect(labelTextOf(textarea)).toEqual(['path']);
  });

  it('an enum field is not named by its own options', () => {
    const field: ConfigField = {
      name: 'kind',
      kind: 'enum',
      optional: false,
      enumOptions: ['delimited', 'excel'],
    };
    const { container } = render(
      <ConfigFieldControl field={field} value="excel" onChange={noop} />,
    );
    expect(labelTextOf(container.querySelector('select')!)).toEqual(['kind']);
  });

  it('the choices select beside a text field is named by the panel’s words alone', () => {
    const field: ConfigField = { name: 'sheet', kind: 'text', optional: true };
    const { container } = render(
      <ConfigFieldControl
        field={field}
        value="Sheet2"
        onChange={noop}
        choices={{ label: 'Sheet in this workbook', values: ['Sheet1', 'Sheet2'], onChoose: noop }}
      />,
    );
    expect(labelTextOf(container.querySelector('textarea')!)).toEqual(['sheet (optional)']);
    expect(labelTextOf(container.querySelector('select')!)).toEqual(['Sheet in this workbook']);
  });
});

describe('ConfigFieldControl — a single-line field is an input (#852 item 4)', () => {
  const url: ConfigField = { name: 'url', kind: 'text', optional: false, singleLine: true };

  it('renders a tagged text field as a one-line input, labelled by its name', () => {
    const { container } = render(
      <ConfigFieldControl field={url} value="https://example.test" onChange={noop} />,
    );
    expect(container.querySelector('textarea')).toBeNull();
    const input = container.querySelector('input.config-field-line') as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.value).toBe('https://example.test');
    expect(labelTextOf(input)).toEqual(['url']);
  });

  it('keeps an untagged text field a textarea', () => {
    const body: ConfigField = { name: 'body', kind: 'text', optional: true };
    const { container } = render(<ConfigFieldControl field={body} value="" onChange={noop} />);
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('input.config-field-line')).toBeNull();
  });

  it('keeps a stored line break: such a value stays in a textarea, verbatim', () => {
    const { container } = render(
      <ConfigFieldControl field={url} value={'https://a.test\n/path'} onChange={noop} />,
    );
    expect(container.querySelector('input.config-field-line')).toBeNull();
    expect(container.querySelector('textarea')!.value).toBe('https://a.test\n/path');
  });

  it('stays a textarea for the mount once the line break is deleted', () => {
    let value = 'a\nb';
    const onChange = (next: unknown): void => {
      value = next as string;
    };
    const { container, rerender } = render(
      <ConfigFieldControl field={url} value={value} onChange={onChange} />,
    );
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'ab' } });
    rerender(<ConfigFieldControl field={url} value={value} onChange={onChange} />);
    expect(value).toBe('ab');
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('input.config-field-line')).toBeNull();
  });
});

describe('ConfigFieldControl — the expression flyout is withheld on a JSON field (#864)', () => {
  // A `json` control parses its text with `JSON.parse` on apply, so a bare
  // `${...}` is not applicable there at all, and offering the picker would be
  // a dead end rather than an affordance.
  const picker = {
    describe: () => '',
    resolve: () => ({ mode: 'insert' as const, suggestions: [] }),
    wraps: () => [],
  };

  it('offers the picker on a text field and not on a json field', () => {
    const text: ConfigField = { name: 'url', kind: 'text', optional: false };
    const json: ConfigField = { name: 'quota', kind: 'json', optional: true };
    const { getByRole, queryByRole } = render(
      <>
        <ConfigFieldControl field={text} value="" onChange={noop} picker={picker} />
        <ConfigFieldControl field={json} value="" onChange={noop} picker={picker} />
      </>,
    );
    expect(getByRole('button', { name: 'Insert reference into url' })).toBeTruthy();
    expect(queryByRole('button', { name: 'Insert reference into quota' })).toBeNull();
  });
});
