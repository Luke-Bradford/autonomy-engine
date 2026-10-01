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
    expect(labelTextOf(container.querySelector('textarea')!)).toEqual(['sheet']);
    expect(labelTextOf(container.querySelector('select')!)).toEqual(['Sheet in this workbook']);
  });
});

describe('ConfigFieldControl — choices say what they are, and why there are none (#844 V6)', () => {
  const variable: ConfigField = {
    name: 'variable',
    kind: 'text',
    optional: false,
    singleLine: true,
    literal: true,
  };

  it('labels each option through the panel’s describe, while its value stays the literal', () => {
    const { container } = render(
      <ConfigFieldControl
        field={variable}
        value="rows"
        onChange={noop}
        choices={{
          label: 'Declared variable',
          values: ['count', 'rows'],
          describe: (name) => `${name} (${name === 'rows' ? 'array' : 'number'})`,
          onChoose: noop,
        }}
      />,
    );
    const select = container.querySelector('select')!;
    expect(select.value).toBe('rows');
    expect(Array.from(select.options, (o) => [o.value, o.textContent])).toEqual([
      ['', '— choose —'],
      ['count', 'count (number)'],
      ['rows', 'rows (array)'],
    ]);
  });

  it('an EMPTY list shows the panel’s hint instead of silently rendering nothing', () => {
    const { container } = render(
      <ConfigFieldControl
        field={variable}
        value=""
        onChange={noop}
        choices={{
          label: 'Declared variable',
          values: [],
          emptyHint: 'No variables are declared.',
          onChoose: noop,
        }}
      />,
    );
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('.config-field-choices-empty')?.textContent).toBe(
      'No variables are declared.',
    );
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

describe('ConfigFieldControl — human labels and required fields (#1396)', () => {
  it('a titled field reads as its title and unit, and keeps its key in the hint', () => {
    const field: ConfigField = {
      name: 'timeoutMs',
      kind: 'number',
      optional: true,
      label: { title: 'Timeout', unit: 'ms', description: 'How long one request may take.' },
    };
    const { getByRole, container } = render(
      <ConfigFieldControl field={field} value="" onChange={noop} />,
    );
    const input = getByRole('textbox', { name: 'Timeout (ms) — number' });
    const hint = container.querySelector(`#${CSS.escape(input.getAttribute('aria-describedby')!)}`);
    expect(hint?.textContent).toBe('How long one request may take. timeoutMs');
  });

  it('an untitled field keeps its key as the label and has no hint', () => {
    const field: ConfigField = { name: 'path', kind: 'text', optional: true, singleLine: true };
    const { getByRole } = render(<ConfigFieldControl field={field} value="" onChange={noop} />);
    expect(getByRole('textbox', { name: 'path' }).hasAttribute('aria-describedby')).toBe(false);
  });

  it('marks a required field, and only a required one', () => {
    const required: ConfigField = { name: 'host', kind: 'text', optional: false, singleLine: true };
    const optional: ConfigField = { name: 'port', kind: 'text', optional: true, singleLine: true };
    const a = render(<ConfigFieldControl field={required} value="" onChange={noop} />);
    expect(a.getByRole('textbox', { name: 'host' }).getAttribute('aria-required')).toBe('true');
    expect(a.container.querySelector('.required-mark')).not.toBeNull();
    a.unmount();
    const b = render(<ConfigFieldControl field={optional} value="" onChange={noop} />);
    expect(b.getByRole('textbox', { name: 'port' }).hasAttribute('aria-required')).toBe(false);
    expect(b.container.querySelector('.required-mark')).toBeNull();
  });

  it('a required row list gets the asterisk but no aria-required on its group', () => {
    const field: ConfigField = {
      name: 'mapping',
      kind: 'objectList',
      optional: false,
      elementFields: [{ name: 'source', kind: 'text', optional: true }],
    };
    const { getByRole, container } = render(
      <ConfigFieldControl field={field} value={[]} onChange={noop} />,
    );
    expect(getByRole('group', { name: 'mapping' }).hasAttribute('aria-required')).toBe(false);
    expect(container.querySelector('.required-mark')).not.toBeNull();
  });
});
