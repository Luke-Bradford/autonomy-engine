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
    examples: () => ({ mode: 'insert' as const, functions: [] }),
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

// #1694 OR42 F10 — a top-level JSON box expands on edit; a JSON cell does not.
describe('ConfigFieldControl — a JSON box expands on edit', () => {
  it('top-level, rests at a line and grows while edited', () => {
    const json: ConfigField = { name: 'quota', kind: 'json', optional: true };
    const { getByRole } = render(<ConfigFieldControl field={json} value="" onChange={noop} />);
    const box = getByRole('textbox', { name: /quota/ });
    expect(box).toHaveAttribute('data-grow', 'edit');
    expect(box).toHaveAttribute('rows', '1');
  });

  it('in a row, keeps its two lines', () => {
    const json: ConfigField = { name: 'quota', kind: 'json', optional: true };
    const { getByRole } = render(
      <ConfigFieldControl field={json} value="" onChange={noop} name="Rules row 1 quota" />,
    );
    const box = getByRole('textbox');
    expect(box).not.toHaveAttribute('data-grow');
    expect(box).toHaveAttribute('rows', '2');
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
    const input = getByRole('textbox', { name: 'Timeout (ms)' });
    const hint = container.querySelector(`#${CSS.escape(input.getAttribute('aria-describedby')!)}`);
    expect(hint?.textContent).toBe('Number. How long one request may take. timeoutMs');
  });

  // #1477 OR29 — labels, not prose: the hint is the `?`'s note beside the label,
  // not a paragraph under the control, and it still describes the control.
  it.each(['text', 'number', 'enum'] as const)(
    "%s: a titled field's hint is behind a `?` beside its label",
    (kind) => {
      const field: ConfigField = {
        name: 'target',
        kind,
        optional: false,
        ...(kind === 'enum' ? { enumOptions: ['a'] } : {}),
        label: { title: 'Target', description: 'Where it goes.' },
      };
      const { getByLabelText, container } = render(
        <ConfigFieldControl field={field} value="" onChange={noop} />,
      );
      expect(container.querySelector('p.field-hint')).toBeNull();
      const control = getByLabelText('Target', { exact: true });
      const note = container.querySelector(
        `#${CSS.escape(control.getAttribute('aria-describedby')!)}`,
      );
      expect(note?.textContent).toContain('Where it goes.');
      expect(note?.closest('details.help-disclosure')?.parentElement?.className).toBe(
        'labelled-control__head help-row',
      );
      expect(getByLabelText('About Target', { exact: true }).tagName).toBe('SUMMARY');
    },
  );

  it('an untitled field keeps its key as the label and has no hint', () => {
    const field: ConfigField = { name: 'path', kind: 'text', optional: true, singleLine: true };
    const { getByRole } = render(<ConfigFieldControl field={field} value="" onChange={noop} />);
    expect(getByRole('textbox', { name: 'path' }).hasAttribute('aria-describedby')).toBe(false);
  });

  // #1694 OR42 — a `?` only where the catalog wrote a note. A titled field
  // without one has none, and its label carries the key on hover instead.
  it.each([
    ['text', 'textbox'],
    ['enum', 'combobox'],
    ['boolean', 'checkbox'],
  ] as const)('a titled %s field with no note has no `?`, its key on the label', (kind, role) => {
    const field: ConfigField = {
      name: 'content',
      kind,
      optional: true,
      ...(kind === 'enum' ? { enumOptions: ['a'] } : {}),
      label: { title: 'Content' },
    };
    const { getByRole, getByText, container } = render(
      <ConfigFieldControl field={field} value="" onChange={noop} />,
    );
    expect(container.querySelector('details.help-disclosure')).toBeNull();
    expect(getByRole(role, { name: 'Content' }).hasAttribute('aria-describedby')).toBe(false);
    expect(getByText('Content').closest('[title]')?.getAttribute('title')).toBe('content');
  });

  it('a titled row list with no note has no `?`, its key on the label', () => {
    const field: ConfigField = {
      name: 'headers',
      kind: 'objectList',
      optional: true,
      label: { title: 'Request headers' },
      elementFields: [{ name: 'name', kind: 'text', optional: true }],
    };
    const { getByRole, container } = render(
      <ConfigFieldControl field={field} value={[]} onChange={noop} />,
    );
    expect(container.querySelector('details.help-disclosure')).toBeNull();
    expect(getByRole('group', { name: 'Request headers' }).hasAttribute('aria-describedby')).toBe(
      false,
    );
    expect(container.querySelector('.object-list-label [title]')?.getAttribute('title')).toBe(
      'headers',
    );
  });

  it('a titled field with a note keeps its key in the note, not on the label', () => {
    const field: ConfigField = {
      name: 'url',
      kind: 'text',
      optional: true,
      singleLine: true,
      label: { title: 'Request URL', description: 'Joined to the base URL.' },
    };
    const { getByRole, container } = render(
      <ConfigFieldControl field={field} value="" onChange={noop} />,
    );
    expect(getByRole('textbox', { name: 'Request URL' })).toHaveAccessibleDescription(
      'Joined to the base URL. url',
    );
    expect(container.querySelector('label [title]')).toBeNull();
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

  it('a titled checkbox keeps its hint out of its name', () => {
    const field: ConfigField = {
      name: 'writable',
      kind: 'boolean',
      optional: true,
      label: { title: 'Allow writes', description: 'Lets a copy write here.' },
    };
    const { getByRole } = render(
      <ConfigFieldControl field={field} value={false} onChange={noop} />,
    );
    const box = getByRole('checkbox', { name: 'Allow writes' });
    expect(box).toHaveAccessibleDescription('Lets a copy write here. writable');
  });

  it('a titled row list is described by its hint', () => {
    const field: ConfigField = {
      name: 'headers',
      kind: 'objectList',
      optional: true,
      label: { title: 'Headers', description: 'Sent with every request.' },
      elementFields: [{ name: 'source', kind: 'text', optional: true }],
    };
    const { getByRole } = render(<ConfigFieldControl field={field} value={[]} onChange={noop} />);
    expect(getByRole('group', { name: 'Headers' })).toHaveAccessibleDescription(
      'Sent with every request. headers',
    );
  });
});

describe('ConfigFieldControl — a number field says what it admits (#1396)', () => {
  const port: ConfigField = {
    name: 'port',
    kind: 'number',
    optional: true,
    label: { title: 'Port' },
    numberRule: {
      integer: true,
      min: { value: 1, inclusive: true },
      max: { value: 65535, inclusive: true },
    },
  };

  it('leads the hint with the rule, and the label is the title alone', () => {
    const noted: ConfigField = {
      ...port,
      label: { title: 'Port', description: 'Where it listens.' },
    };
    const { getByRole } = render(<ConfigFieldControl field={noted} value="" onChange={noop} />);
    expect(getByRole('textbox', { name: 'Port' })).toHaveAccessibleDescription(
      'Whole number from 1 to 65535. Where it listens. port',
    );
  });

  // #1694 OR42 — a rule alone is not a note, so a field the catalog wrote no
  // note for has no `?`; the rule is still its description, out of sight.
  it.each([
    ['a titled', port],
    ['an untitled', { ...port, label: undefined }],
  ] as const)('%s number field with no note has no `?`, its rule still described', (_, field) => {
    const { getByRole, container } = render(
      <ConfigFieldControl field={field} value="" onChange={noop} />,
    );
    expect(getByRole('textbox', { name: /^port$/i })).toHaveAccessibleDescription(
      'Whole number from 1 to 65535.',
    );
    expect(container.querySelector('details.help-disclosure')).toBeNull();
    expect(container.querySelector('.visually-hidden')?.textContent).toBe(
      'Whole number from 1 to 65535.',
    );
  });

  it.each([
    [{ integer: true, min: { value: 1, inclusive: true } }, 'numeric'],
    [{ integer: false, min: { value: 0, inclusive: false } }, 'decimal'],
    [{ integer: true, max: { value: -1, inclusive: true } }, 'text'],
    [{ integer: false, min: { value: -5, inclusive: true } }, 'text'],
    [{ integer: false }, 'text'],
  ] as const)('%o gets the %s keypad', (numberRule, keypad) => {
    const { getByRole } = render(
      <ConfigFieldControl field={{ ...port, numberRule }} value="" onChange={noop} />,
    );
    expect(getByRole('textbox', { name: 'Port' })).toHaveAttribute('inputmode', keypad);
  });

  it('a row cell has no hint, so it keeps the " — number" suffix', () => {
    const cell: ConfigField = { name: 'n', kind: 'number', optional: true };
    const { getByRole } = render(
      <ConfigFieldControl field={cell} name="rows row 1 n" value="" onChange={noop} />,
    );
    expect(getByRole('textbox', { name: 'rows row 1 n — number' })).not.toHaveAttribute(
      'aria-describedby',
    );
  });
});

describe('ConfigFieldControl — a resource form validation slot (#1396)', () => {
  const fields: ConfigField[] = [
    { name: 'timeoutMs', kind: 'number', optional: true },
    { name: 'path', kind: 'text', optional: false },
    { name: 'mode', kind: 'enum', optional: false, enumOptions: ['a', 'b'] },
    {
      name: 'headers',
      kind: 'keyValue',
      optional: true,
      elementFields: [
        { name: 'key', kind: 'text', optional: false },
        { name: 'value', kind: 'text', optional: false },
      ],
    },
  ];

  it.each(fields)('$kind: keyed, marked invalid and described by its error', (field) => {
    const { container } = render(
      <ConfigFieldControl
        field={field}
        value={field.kind === 'keyValue' ? [] : ''}
        onChange={noop}
        validation={{ key: `config.${field.name}`, error: 'must be a number' }}
      />,
    );
    const control = container.querySelector<HTMLElement>(`[data-field="config.${field.name}"]`)!;
    expect(control).not.toBeNull();
    expect(control).toHaveAttribute('data-invalid', 'true');
    // ARIA does not allow `aria-invalid` on a row list's `group`.
    if (field.kind === 'keyValue') expect(control).not.toHaveAttribute('aria-invalid');
    else expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveAccessibleDescription(/^Must be a number/);
  });

  it.each(fields)('$kind: on the canvas (no validation) nothing is added', (field) => {
    const { container } = render(
      <ConfigFieldControl
        field={field}
        value={field.kind === 'keyValue' ? [] : ''}
        onChange={noop}
      />,
    );
    expect(container.querySelector('[data-field]')).toBeNull();
    expect(container.querySelector('[aria-invalid]')).toBeNull();
    expect(container.querySelector('.field-error-slot')).toBeNull();
  });
});

describe('ConfigFieldControl — a number field is a label beside its input, not around it (#1477 OR29)', () => {
  it('pairs the label by for/id, so the dock grid can put the label in its own column', () => {
    const field: ConfigField = { name: 'maxTokens', kind: 'number', optional: true };
    const { getByLabelText } = render(
      <ConfigFieldControl field={field} value="12" onChange={noop} />,
    );
    const input = getByLabelText('maxTokens') as HTMLInputElement;
    expect(input.closest('label')).toBeNull();
    expect(input.closest('.labelled-control')).toHaveClass('config-field');
    expect(input).toHaveClass('number-input');
    expect(labelTextOf(input)).toEqual(['maxTokens']);
  });
});

describe('ConfigFieldControl — a row list is a compact table (#1477 OR29)', () => {
  const mapping: ConfigField = {
    name: 'mapping',
    kind: 'objectList',
    optional: true,
    elementFields: [
      { name: 'source', kind: 'text', optional: false },
      { name: 'type', kind: 'enum', optional: true, enumOptions: ['string', 'integer'] },
      { name: 'width', kind: 'number', optional: true },
      { name: 'rules', kind: 'json', optional: true },
      { name: 'nullable', kind: 'boolean', optional: true },
    ],
  };

  it('names each column once, with the format and required mark its cells used to repeat', () => {
    const { getByRole } = render(
      <ConfigFieldControl field={mapping} value={[{}, {}]} onChange={noop} />,
    );
    const table = getByRole('table', { name: 'mapping' });
    const ths = Array.from(table.querySelectorAll('th'));
    expect(ths.map((th) => th.textContent)).toEqual([
      'Source',
      'Type',
      'Width — number',
      'Rules — JSON',
      'Nullable',
      'Actions',
    ]);
    expect(ths[0]!.querySelector('.required-mark')).not.toBeNull();
    expect(ths[1]!.querySelector('.required-mark')).toBeNull();
    expect(table.querySelectorAll('tbody > tr')).toHaveLength(2);
  });

  it("a cell's label is out of sight but still its control's whole name", () => {
    const { getByRole } = render(
      <ConfigFieldControl field={mapping} value={[{}]} onChange={noop} />,
    );
    for (const control of [
      getByRole('textbox', { name: 'Mapping row 1 source' }),
      getByRole('combobox', { name: 'Mapping row 1 type' }),
      getByRole('textbox', { name: 'Mapping row 1 width — number' }),
      getByRole('checkbox', { name: 'Mapping row 1 nullable' }),
    ]) {
      const label = control.closest('td')!.querySelector('label')!;
      expect(label.querySelector('.visually-hidden')).not.toBeNull();
      // Nothing of the label's text is left in sight.
      const seen = Array.from(label.childNodes).filter(
        (n) => !(n instanceof HTMLElement && n.classList.contains('visually-hidden')),
      );
      expect(seen.map((n) => n.textContent).join('')).toBe('');
    }
    // A cell's asterisk is the header's, not its own.
    expect(getByRole('table').querySelector('td .required-mark')).toBeNull();
  });

  it("a titled list's hint is behind a `?` beside its label, not a paragraph under the table", () => {
    const field: ConfigField = {
      ...mapping,
      label: { title: 'Column mapping', description: 'Which column fills which.' },
    };
    const { getByRole, container } = render(
      <ConfigFieldControl field={field} value={[{}]} onChange={noop} />,
    );
    expect(container.querySelector('p.field-hint')).toBeNull();
    const help = container.querySelector('.object-list-label details.help-disclosure');
    expect(help).not.toBeNull();
    expect(help!.querySelector('summary')).toHaveAccessibleName('About Column mapping');
    // Still the group's description, and the table keeps the list's name alone.
    expect(getByRole('group', { name: 'Column mapping' })).toHaveAccessibleDescription(
      'Which column fills which. mapping',
    );
    expect(getByRole('table')).toHaveAccessibleName('Column mapping');
  });

  it('a top-level field keeps its visible label (only cells hide theirs)', () => {
    const { container } = render(
      <ConfigFieldControl
        field={{ name: 'path', kind: 'text', optional: true }}
        value=""
        onChange={noop}
      />,
    );
    expect(container.querySelector('.visually-hidden')).toBeNull();
  });

  it("a cell's expression toggles are glyphs with their full names", () => {
    const picker = {
      describe: () => '',
      resolve: () => ({ mode: 'off' }),
      wraps: () => null,
      examples: () => [],
    } as unknown as Parameters<typeof ConfigFieldControl>[0]['picker'];
    const { getByRole } = render(
      <ConfigFieldControl field={mapping} value={[{}]} onChange={noop} picker={picker} />,
    );
    expect(
      getByRole('button', { name: 'Insert reference into mapping row 1 source' }),
    ).toHaveTextContent('${}');
    expect(getByRole('button', { name: 'Functions for mapping row 1 source' })).toHaveTextContent(
      'ƒx',
    );
    // A cell shows its toggles only while it has focus, and Safari does not
    // focus a button on click: the toggle's mousedown keeps focus in the box.
    const refs = getByRole('button', { name: 'Insert reference into mapping row 1 source' });
    expect(fireEvent.mouseDown(refs)).toBe(false);
    expect(
      fireEvent.mouseDown(getByRole('button', { name: 'Functions for mapping row 1 source' })),
    ).toBe(false);
    // A top-level field's toggles are glyphs too (#1477 OR29: worded, they were
    // 44px a field), but always shown, so they need none of that.
    const top = render(
      <ConfigFieldControl
        field={{ name: 'url', kind: 'text', optional: true }}
        value=""
        onChange={noop}
        picker={picker}
      />,
    );
    const worded = top.getByRole('button', { name: 'Insert reference into url' });
    expect(worded).toHaveTextContent('${}');
    expect(fireEvent.mouseDown(worded)).toBe(true);
  });
});

// #1694 OR42 item 5 — a unit leaves the label for a suffix inside the box, and
// stays in the field's name; item 9 — a cell's empty choice is blank.
describe('ConfigFieldControl — units as suffixes, blank empty cells (#1694)', () => {
  /** The label as DRAWN: its text without what `.visually-hidden` keeps out of sight. */
  function drawnLabel(control: HTMLElement): string {
    const label = (control as HTMLInputElement).labels![0]!.cloneNode(true) as HTMLElement;
    label.querySelectorAll('.visually-hidden').forEach((hidden) => hidden.remove());
    return (label.textContent ?? '').trim();
  }

  it.each([
    ['number', { kind: 'number' as const }],
    ['one-line text', { kind: 'text' as const, singleLine: true as const }],
  ])('a %s field draws its unit as a suffix and keeps it in its name', (_, shape) => {
    const field: ConfigField = {
      name: 'seconds',
      optional: true,
      label: { title: 'Wait time', unit: 'seconds' },
      ...shape,
    };
    const { getByRole } = render(<ConfigFieldControl field={field} value="" onChange={noop} />);
    const input = getByRole('textbox', { name: 'Wait time (seconds)' });
    expect(drawnLabel(input)).toBe('Wait time');
    const suffix = input.parentElement!.querySelector('.input-unit__suffix');
    expect(suffix?.textContent).toBe('s');
    expect(suffix?.getAttribute('aria-hidden')).toBe('true');
    expect(input.getAttribute('data-size')).toBe('s');
  });

  it('a field without a unit has no suffix box', () => {
    const field: ConfigField = { name: 'n', kind: 'number', optional: true };
    const { getByRole } = render(<ConfigFieldControl field={field} value="" onChange={noop} />);
    expect(getByRole('textbox').closest('.input-unit')).toBeNull();
  });

  it("an optional cell's empty choice is blank; a required cell's and a top-level field's read — none —", () => {
    const field: ConfigField = {
      name: 'onError',
      kind: 'enum',
      optional: true,
      enumOptions: ['fail', 'null'],
    };
    const cell = render(
      <ConfigFieldControl field={field} name="mapping row 1 on error" value="" onChange={noop} />,
    );
    expect(cell.getByRole('combobox').querySelector('option[value=""]')?.textContent).toBe('');
    cell.unmount();
    // A REQUIRED cell keeps it: there, empty is a gap to fill.
    const required = render(
      <ConfigFieldControl
        field={{ ...field, optional: false }}
        name="mapping row 1 type"
        value=""
        onChange={noop}
      />,
    );
    expect(required.getByRole('combobox').querySelector('option[value=""]')?.textContent).toBe(
      '— none —',
    );
    required.unmount();
    const top = render(<ConfigFieldControl field={field} value="" onChange={noop} />);
    expect(top.getByRole('combobox').querySelector('option[value=""]')?.textContent).toBe(
      '— none —',
    );
    expect(top.getByRole('combobox').getAttribute('data-size')).toBe('s');
  });
});

describe('ConfigFieldControl — an unset enum names its default (#1732)', () => {
  const field: ConfigField = {
    name: 'onOverLimit',
    kind: 'enum',
    optional: true,
    enumOptions: ['truncate', 'fail'],
    defaultText: 'fail',
    label: {
      title: 'When over the limit',
      options: { truncate: 'Truncate and warn', fail: 'Fail' },
    },
  };
  const empty = (root: HTMLElement) => root.querySelector('option[value=""]')?.textContent;

  it('labels the empty choice with the schema default, and still writes nothing', () => {
    const { getByRole } = render(<ConfigFieldControl field={field} value="" onChange={noop} />);
    const select = getByRole('combobox') as HTMLSelectElement;
    expect(empty(select)).toBe('Fail (default)');
    expect(select.value).toBe('');
  });

  it('keeps — none — when there is no default, or the default is not a choice', () => {
    const plain: ConfigField = { ...field, defaultText: undefined };
    const none = render(<ConfigFieldControl field={plain} value="" onChange={noop} />);
    expect(empty(none.getByRole('combobox'))).toBe('— none —');
    none.unmount();
    const stray = render(
      <ConfigFieldControl field={{ ...field, defaultText: 'gone' }} value="" onChange={noop} />,
    );
    expect(empty(stray.getByRole('combobox'))).toBe('— none —');
  });

  it("an optional cell's empty choice stays blank (#1694 OR42 item 9)", () => {
    const { getByRole } = render(
      <ConfigFieldControl field={field} name="mapping row 1 on error" value="" onChange={noop} />,
    );
    expect(empty(getByRole('combobox'))).toBe('');
  });
});

describe('ConfigFieldControl — what a list holds is behind its `?`, not a paragraph (#1694 OR42)', () => {
  const secrets: ConfigField = {
    name: 'auth',
    kind: 'keyValue',
    optional: true,
    recordValue: 'secret',
    elementFields: [
      { name: 'key', kind: 'text', optional: false },
      { name: 'secret', kind: 'text', optional: false },
    ],
  };
  const described: ConfigField = {
    ...secrets,
    label: { title: 'Auth', description: 'Headers sent with the request.' },
  };

  const schema: ConfigField = {
    name: 'outputSchema',
    kind: 'outputSchema',
    optional: true,
    elementFields: [{ name: 'name', kind: 'text', optional: false }],
  };

  it.each([
    ['an output schema', schema, /^Each row is one field of the structured output.*\{"enum"/],
    ['a secret list with no note of its own', secrets, /^Each row names a secret/],
    [
      'a secret list after its own note',
      described,
      /^Headers sent with the request\..*Each row names a secret/,
    ],
  ])('%s', (_, field, reads) => {
    const { container } = render(<ConfigFieldControl field={field} value={[]} onChange={noop} />);
    // No paragraph explains the rows; the `?` beside the list's label does.
    for (const p of container.querySelectorAll('p')) {
      expect(p.textContent).not.toMatch(/Each row/);
    }
    const notes = container.querySelectorAll('.object-list-label details');
    expect(notes).toHaveLength(1);
    const note = notes[0]!.querySelector('[id]')!;
    expect(note.textContent).toMatch(reads);
    // The note is still the list's description, for a screen reader.
    const group = container.querySelector('.object-list')!;
    expect(group.getAttribute('aria-describedby')?.split(' ')).toContain(note.id);
  });
});

describe('ConfigFieldControl — a set of choices (#1600 C8a, #1736)', () => {
  const field: ConfigField = {
    name: 'fieldList',
    kind: 'enumSet',
    optional: false,
    enumOptions: ['exists', 'size', 'childItems'],
    label: {
      title: 'Field list',
      options: { exists: 'Exists', size: 'Size', childItems: 'Child items' },
    },
  };
  const boxes = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

  it('is a group named by its title, one tick box per option, named by its option title', () => {
    const { getByRole } = render(
      <ConfigFieldControl field={field} value={'size'} onChange={noop} />,
    );
    const group = getByRole('group', { name: 'Field list' });
    const ticks = boxes(group);
    expect(ticks.map((b) => b.labels?.[0]?.textContent)).toEqual(['Exists', 'Size', 'Child items']);
    expect(ticks.map((b) => b.checked)).toEqual([false, true, false]);
  });

  it('writes the ticks in the options’ order, whatever order they were ticked in', () => {
    const changes: string[] = [];
    const { container } = render(
      <ConfigFieldControl
        field={field}
        value={'childItems'}
        onChange={(v) => changes.push(String(v))}
      />,
    );
    fireEvent.click(boxes(container)[0]!);
    expect(changes).toEqual(['exists\nchildItems']);
  });

  it('unticking removes only that option', () => {
    const changes: string[] = [];
    const { container } = render(
      <ConfigFieldControl
        field={field}
        value={'exists\nsize\nchildItems'}
        onChange={(v) => changes.push(String(v))}
      />,
    );
    fireEvent.click(boxes(container)[1]!);
    expect(changes).toEqual(['exists\nchildItems']);
  });
});
