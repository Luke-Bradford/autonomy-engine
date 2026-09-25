import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
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
