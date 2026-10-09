import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  fieldAttrs,
  focusField,
  splitIssues,
  useFieldValidation,
  type FieldErrors,
} from './fieldValidation';
import { FieldError } from './FieldError';
import { FormErrors } from './FormErrors';
import { FormDrawer } from './FormDrawer';
import type { UnsavedChangesGuard } from './useUnsavedChangesGuard';
import { Section } from '../Section';

describe('splitIssues (#1396)', () => {
  const known = new Set(['name', 'config.timeoutMs', 'config.headers', 'config']);
  const isKey = (key: string) => known.has(key);

  it('files an issue under the longest known prefix of its path, keeping the rest of the path', () => {
    const { fields, rest } = splitIssues(
      [
        { path: ['config', 'headers', 2, 'key'], message: 'duplicate key' },
        { path: 'config.timeoutMs', message: 'must be positive' },
        { path: ['name'], message: 'too short' },
      ],
      isKey,
    );
    expect(fields).toEqual({
      'config.headers': '2.key: duplicate key',
      'config.timeoutMs': 'must be positive',
      name: 'too short',
    });
    expect(rest).toEqual([]);
  });

  it('keeps every message for a key and returns the unmatched issues in order', () => {
    const unmatched = { path: ['kind'], message: 'bad kind' };
    const pathless = { message: 'whole body refused' };
    const { fields, rest } = splitIssues(
      [
        { path: 'name', message: 'first' },
        unmatched,
        { path: 'name', message: 'second' },
        pathless,
      ],
      isKey,
    );
    expect(fields).toEqual({ name: 'first; second' });
    expect(rest).toEqual([unmatched, pathless]);
  });

  it('an issue with no message still marks its field', () => {
    expect(splitIssues([{ path: 'name' }], isKey).fields).toEqual({ name: 'Invalid value' });
  });
});

describe('fieldAttrs (#1396)', () => {
  it('leads the description with the error, and marks a row list without aria-invalid', () => {
    expect(fieldAttrs({ key: 'k', error: 'bad', errorId: 'e', hintId: 'h' })).toEqual({
      'data-field': 'k',
      'data-invalid': true,
      'aria-invalid': true,
      'aria-describedby': 'e h',
    });
    expect(fieldAttrs({ key: 'k', error: 'bad', errorId: 'e', group: true })).toEqual({
      'data-field': 'k',
      'data-invalid': true,
      'aria-describedby': 'e',
    });
    expect(fieldAttrs({ key: 'k', error: undefined, errorId: 'e' })).toEqual({
      'data-field': 'k',
      'data-invalid': undefined,
      'aria-invalid': false,
      'aria-describedby': undefined,
    });
  });
});

describe('focusField (#1396)', () => {
  it('opens the collapsed section a field sits in, then focuses it', () => {
    render(
      <details>
        <summary>Advanced</summary>
        <input aria-label="Deep" data-field="deep" />
      </details>,
    );
    focusField(document.body, 'deep');
    expect(document.querySelector('details')!.open).toBe(true);
    expect(screen.getByLabelText('Deep')).toHaveFocus();
  });

  it('opens a collapsed Section (#1594 OR40) a field sits in, then focuses it', () => {
    render(
      <Section heading="Advanced" help="Settings most people never touch." collapsible>
        <input aria-label="Deep" data-field="deep" />
      </Section>,
    );
    focusField(document.body, 'deep');
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByLabelText('Deep')).toBeVisible();
    expect(screen.getByLabelText('Deep')).toHaveFocus();
  });
});

const LABELS: Record<string, string> = { name: 'Name', age: 'Age', pair: 'Pair' };

/**
 * A small form on the real FormDrawer: `name` must be non-empty, `age` must be
 * digits, and the two halves of `pair` (a row list: one field, two controls)
 * go together. `checks` is recomputed from the values every render, as a page
 * does it. `refuse` stands in for a server that refuses with field errors.
 */
function Probe({
  refuse,
  hideAge = false,
  withDate = false,
}: {
  refuse?: FieldErrors;
  hideAge?: boolean;
  /** An unkeyed native date control, as a trigger's mode editor has. */
  withDate?: boolean;
}) {
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [pair, setPair] = useState({ a: '', b: '' });
  const [submitted, setSubmitted] = useState(0);
  const checks: Record<string, string> = {};
  if (name === '') checks.name = 'Enter a name.';
  if (!hideAge && !/^\d*$/.test(age)) checks.age = 'must be a number';
  if ((pair.a === '') !== (pair.b === '')) checks.pair = 'fill both halves';
  const validation = useFieldValidation(checks, (key) =>
    hideAge && key === 'age' ? undefined : LABELS[key],
  );
  const guard: UnsavedChangesGuard = {
    confirming: false,
    request: (action) => action(),
    keep: () => {},
    discard: () => {},
    routeHold: null,
  };
  const attrs = (key: string) =>
    fieldAttrs({ key, error: validation.errorFor(key), errorId: `${key}-error` });
  return (
    <FormDrawer
      title="Probe"
      formLabel="Probe form"
      guard={guard}
      validation={validation}
      onRequestClose={() => {}}
      onSubmit={(e) => {
        e.preventDefault();
        if (!validation.attempt()) return;
        if (refuse !== undefined) validation.showRefusedFields(refuse);
        else setSubmitted((n) => n + 1);
      }}
      status={<FormErrors validation={validation} message={null} />}
      actions={
        <>
          <button type="button" onClick={() => validation.attempt((key) => key === 'age')}>
            Test
          </button>
          <button type="submit">Save</button>
        </>
      }
    >
      <p>{`submitted ${submitted}`}</p>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} {...attrs('name')} />
      </label>
      <FieldError id="name-error" message={validation.errorFor('name')} />
      {!hideAge && (
        <>
          <label>
            Age
            <input value={age} onChange={(e) => setAge(e.target.value)} {...attrs('age')} />
          </label>
          <FieldError id="age-error" message={validation.errorFor('age')} />
        </>
      )}
      <div role="group" aria-label="Pair" {...attrs('pair')} aria-invalid={undefined}>
        <input
          aria-label="Pair A"
          value={pair.a}
          onChange={(e) => setPair({ ...pair, a: e.target.value })}
        />
        <input
          aria-label="Pair B"
          value={pair.b}
          onChange={(e) => setPair({ ...pair, b: e.target.value })}
        />
      </div>
      <FieldError id="pair-error" message={validation.errorFor('pair')} />
      {withDate && (
        <label>
          When
          <input type="date" />
        </label>
      )}
    </FormDrawer>
  );
}

const slot = (id: string) => document.getElementById(id);

describe('useFieldValidation on the FormDrawer (#1396)', () => {
  it('tabbing past an untouched field raises nothing', async () => {
    const user = userEvent.setup();
    render(<Probe />);
    // FormDrawer focuses Name on open; leaving it untouched must not shout.
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(slot('name-error')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an edited field is checked on blur, never per keystroke, and clears as soon as it is fixed', async () => {
    const user = userEvent.setup();
    render(<Probe />);
    await user.type(screen.getByLabelText('Age'), '4x');
    // Still typing: no error yet.
    expect(slot('age-error')).toBeNull();
    await user.tab();
    expect(slot('age-error')).toHaveTextContent('Must be a number');
    expect(screen.getByLabelText('Age')).toHaveAttribute('aria-invalid', 'true');
    // Not an alert: before a submit the footer summary is the only alert.
    expect(screen.queryByRole('alert')).toBeNull();

    await user.type(screen.getByLabelText('Age'), '{Backspace}');
    expect(slot('age-error')).toBeNull();
    // Broken again while typing: still not raised until the next blur.
    await user.type(screen.getByLabelText('Age'), 'y');
    expect(slot('age-error')).toBeNull();
    await user.tab();
    expect(slot('age-error')).toHaveTextContent('Must be a number');
  });

  it('moving between the controls of one field is not leaving it', async () => {
    const user = userEvent.setup();
    render(<Probe />);
    await user.type(screen.getByLabelText('Pair A'), 'x');
    await user.tab();
    expect(screen.getByLabelText('Pair B')).toHaveFocus();
    expect(slot('pair-error')).toBeNull();
    await user.tab();
    expect(slot('pair-error')).toHaveTextContent('Fill both halves');
  });

  it('a refused submit lists every problem in ONE alert and focuses the first invalid field', async () => {
    const user = userEvent.setup();
    render(<Probe />);
    await user.type(screen.getByLabelText('Age'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('submitted 0')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Name: Enter a name.');
    expect(alert).toHaveTextContent('Age: must be a number');
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(slot('name-error')).toHaveTextContent('Enter a name.');

    // A summary line takes you to its field.
    await user.click(screen.getByRole('button', { name: 'Age: must be a number' }));
    expect(screen.getByLabelText('Age')).toHaveFocus();

    // Fixing a field takes its line out of the summary; the summary goes with the last.
    await user.type(screen.getByLabelText('Name'), 'n');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Name:');
    await user.clear(screen.getByLabelText('Age'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('focus goes to the first invalid field even when it is a row list', async () => {
    const user = userEvent.setup();
    render(<Probe />);
    await user.type(screen.getByLabelText('Name'), 'n');
    await user.type(screen.getByLabelText('Pair A'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByLabelText('Pair A')).toHaveFocus();
  });

  it("a refusal's field error stays until THAT field is edited", async () => {
    const user = userEvent.setup();
    render(<Probe refuse={{ age: 'too old' }} />);
    await user.type(screen.getByLabelText('Name'), 'n');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Age: too old');
    expect(screen.getByLabelText('Age')).toHaveFocus();
    // Leaving the field without changing it keeps the verdict.
    await user.tab();
    expect(slot('age-error')).toHaveTextContent('Too old');
    // Editing another field does not clear it either.
    await user.type(screen.getByLabelText('Name'), 'm');
    expect(slot('age-error')).toHaveTextContent('Too old');
    await user.type(screen.getByLabelText('Age'), '1');
    expect(slot('age-error')).toBeNull();
  });

  it("a refusal's error on a field that leaves the form goes with it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Probe refuse={{ age: 'too old' }} />);
    await user.type(screen.getByLabelText('Name'), 'n');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Age: too old');

    rerender(<Probe refuse={{ age: 'too old' }} hideAge />);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<Probe refuse={{ age: 'too old' }} />);
    expect(slot('age-error')).toBeNull();
  });

  it('a scoped attempt (Test) leaves the other fields alone', async () => {
    const user = userEvent.setup();
    render(<Probe />);
    await user.type(screen.getByLabelText('Age'), 'x');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Age: must be a number');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Name');
    expect(screen.getByLabelText('Age')).toHaveFocus();

    // The untouched Name is not armed by a Test: passing through it raises nothing.
    await user.click(screen.getByLabelText('Name'));
    await user.tab();
    expect(slot('name-error')).toBeNull();
  });

  it('a Test does not clear a refusal on a field outside its scope', async () => {
    const user = userEvent.setup();
    render(<Probe refuse={{ name: 'taken' }} />);
    await user.type(screen.getByLabelText('Name'), 'n');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(slot('name-error')).toHaveTextContent('Taken');

    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(slot('name-error')).toHaveTextContent('Taken');
  });
});

/** jsdom has no bad input: give a control the validity Chromium gives `1e` in a number box. */
function markBadInput(control: HTMLElement, bad = true): void {
  Object.defineProperty(control, 'validity', { configurable: true, value: { badInput: bad } });
}

describe('FormDrawer refuses input the browser could not read (#1396)', () => {
  it('on a field of the form: beside it, with every other check raised in the same press', async () => {
    const user = userEvent.setup();
    render(<Probe />);
    markBadInput(screen.getByLabelText('Age'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('submitted 0')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Fix these 2 fields:');
    expect(screen.getByLabelText('Age')).toHaveAccessibleDescription(
      '“Age” holds something that is not a complete value. Finish it or clear it.',
    );
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('elsewhere: a notice in the one alert, focus on the control, gone on the next good Save', async () => {
    const user = userEvent.setup();
    render(<Probe withDate />);
    await user.type(screen.getByLabelText('Name'), 'Ada');
    const when = screen.getByLabelText('When');
    markBadInput(when);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('submitted 0')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      '“When” holds something that is not a complete date. Finish it or clear it.',
    );
    expect(when).toHaveFocus();

    markBadInput(when, false);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('submitted 1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
