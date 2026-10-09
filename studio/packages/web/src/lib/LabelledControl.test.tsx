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

  // #1477 OR29 — a `?` beside the label: in a head row WITH it, never inside it.
  it('puts a help slot beside the label, outside it, so the name stays the label alone', () => {
    const { container } = render(
      <LabelledControl label="Path" help={<button type="button">About Path</button>}>
        {(id) => <input id={id} />}
      </LabelledControl>,
    );
    const input = screen.getByLabelText('Path', { exact: true });
    const label = input.closest('.labelled-control')!.querySelector('label')!;
    expect(label.textContent).toBe('Path');
    expect(label.parentElement?.className).toBe('labelled-control__head help-row');
    expect(label.nextElementSibling).toBe(screen.getByRole('button', { name: 'About Path' }));
    // Without one, the label is the wrapper's own child, as it always was.
    const { container: bare } = render(
      <LabelledControl label="Plain">{(id) => <input id={id} />}</LabelledControl>,
    );
    expect(bare.querySelector('.labelled-control > label')).not.toBeNull();
    expect(bare.querySelector('.labelled-control__head')).toBeNull();
    expect(container.querySelector('.labelled-control > label')).toBeNull();
  });

  // #1594 OR40 S3c-2 — a field's explanation behind a `?` beside its label: the
  // note is the control's description, the `?` is named for the field, and the
  // label's text (the control's name) is the label alone.
  it('draws `about` as a ? beside the label whose note describes the control', () => {
    const { container } = render(
      <LabelledControl label="Value" about={{ name: 'Value', note: 'Cleartext, never a credential' }}>
        {(id, describedBy) => <input id={id} aria-describedby={describedBy} />}
      </LabelledControl>,
    );
    const input = screen.getByLabelText('Value', { exact: true });
    expect(input).toHaveAccessibleDescription('Cleartext, never a credential');
    const summary = container.querySelector('.labelled-control__head > .help-disclosure > summary');
    expect(summary?.getAttribute('aria-label')).toBe('About Value');
    expect(container.querySelector('.field-hint')).toBeNull();
    expect(container.querySelector('.page-hint')).toBeNull();
  });

  it('describes the control by its hint line and its ? note together', () => {
    render(
      <LabelledControl
        label="Kind"
        hint="A file on the server"
        about={{ name: 'Kind', note: 'Fixed once saved' }}
      >
        {(id, describedBy) => <select id={id} aria-describedby={describedBy} />}
      </LabelledControl>,
    );
    expect(screen.getByLabelText('Kind', { exact: true })).toHaveAccessibleDescription(
      'A file on the server Fixed once saved',
    );
  });
});
