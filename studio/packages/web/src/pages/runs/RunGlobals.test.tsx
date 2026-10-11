import { afterEach, describe, expect, it } from 'vitest';
import { FORM_SECTION_HINTS } from '../../lib/form/sectionHints';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunGlobals } from './RunGlobals';

afterEach(cleanup);

function region() {
  return screen.getByRole('region', { name: 'Global parameters' });
}

/** Each body row as `[name, value]`. */
function rowsOf(): string[][] {
  return within(region())
    .getAllByRole('row')
    .slice(1)
    .map((r) => Array.from(r.querySelectorAll('th, td'), (c) => c.textContent ?? ''));
}

describe('RunGlobals (#844 GL5)', () => {
  it('shows the snapshot the run read, sorted by name, each value as JSON', () => {
    render(
      <RunGlobals
        overlay={{ ready: true, state: { globals: { region: 'eu', Batch: 50, flags: [1, 2] } } }}
      />,
    );
    expect(rowsOf()).toEqual([
      ['Batch', '50'],
      ['flags', '[1,2]'],
      ['region', '"eu"'],
    ]);
    // #1594 OR40 S6g — what the values are is the section's `?`, not prose.
    expect(region()).toHaveAccessibleDescription(FORM_SECTION_HINTS.run.globals);
  });

  it('quotes a string, so an empty one is not a blank cell', () => {
    render(<RunGlobals overlay={{ ready: true, state: { globals: { label: '' } } }} />);
    expect(rowsOf()).toEqual([['label', '""']]);
  });

  it('shows a very long value behind a disclosure that reaches the whole of it', async () => {
    const huge = 'q'.repeat(20_000);
    render(<RunGlobals overlay={{ ready: true, state: { globals: { big: huge } } }} />);
    const text = JSON.stringify(huge);
    expect(rowsOf()[0]?.[1]).not.toContain(text);
    await userEvent.click(
      within(region()).getByRole('button', { name: `Show all ${text.length} characters` }),
    );
    expect(rowsOf()[0]?.[1]).toContain(text);
  });

  it('renders nothing for a run that read no globals', () => {
    const { container } = render(<RunGlobals overlay={{ ready: true, state: { globals: {} } }} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing while the projection is unavailable, rather than an empty table', () => {
    const { container } = render(
      <RunGlobals overlay={{ ready: false, reason: 'Loading this run’s history…' }} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
