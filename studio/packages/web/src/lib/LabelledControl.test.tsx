import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LabelledControl } from './LabelledControl';

describe('LabelledControl (#1227)', () => {
  it('pairs the label with its textarea by for/id, so the label text never absorbs the value', () => {
    render(
      <LabelledControl label="Params (JSON)">
        {(id) => <textarea id={id} defaultValue="" />}
      </LabelledControl>,
    );
    const box = screen.getByLabelText<HTMLTextAreaElement>('Params (JSON)', { exact: true });
    fireEvent.change(box, { target: { value: '{"a":1}' } });
    // The trap a wrapping label sets: its text becomes `name + value`, so an
    // exact label lookup stops resolving the moment the field has content.
    expect(screen.getByLabelText('Params (JSON)', { exact: true })).toBe(box);
    const label = box.labels?.[0];
    expect(label?.textContent).toBe('Params (JSON)');
    expect(label?.contains(box)).toBe(false);
  });

  it("keeps a select's option text out of its label", () => {
    render(
      <LabelledControl label="Kind" className="extra">
        {(id) => (
          <select id={id} defaultValue="b">
            <option value="a">Alpha</option>
            <option value="b">Beta</option>
          </select>
        )}
      </LabelledControl>,
    );
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Kind' });
    expect(select.labels?.[0]?.textContent).toBe('Kind');
    expect(select.parentElement?.className).toBe('labelled-control extra');
  });

  // #1413 — a hint under the control (a Kind picker's description) describes it.
  it('renders a hint under the control and hands its id to the control', () => {
    render(
      <LabelledControl label="Kind" hint="Rows of a CSV file.">
        {(id, hintId) => (
          <select id={id} aria-describedby={hintId}>
            <option>CSV</option>
          </select>
        )}
      </LabelledControl>,
    );
    const select = screen.getByRole('combobox', { name: 'Kind' });
    expect(select).toHaveAccessibleDescription('Rows of a CSV file.');
    expect(select.parentElement?.lastElementChild?.className).toBe('field-hint');
  });

  it('without a hint, renders no hint and hands the control no id for one', () => {
    let handed: string | undefined = 'unset';
    const { container } = render(
      <LabelledControl label="Kind">
        {(id, hintId) => {
          handed = hintId;
          return <select id={id} />;
        }}
      </LabelledControl>,
    );
    expect(handed).toBeUndefined();
    expect(container.querySelector('.field-hint')).toBeNull();
  });
});
