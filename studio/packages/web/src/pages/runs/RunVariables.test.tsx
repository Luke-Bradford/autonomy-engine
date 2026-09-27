import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VariableDef } from '@autonomy-studio/shared';
import { RunVariables } from './RunVariables';

afterEach(cleanup);

const DECLARED: VariableDef[] = [
  { name: 'rows', type: 'array', default: [] },
  { name: 'count', type: 'number', default: 0 },
];

function region() {
  return screen.getByRole('region', { name: 'Variables' });
}

/** Each body row as `[name, type, value]`. */
function rowsOf(): string[][] {
  return within(region())
    .getAllByRole('row')
    .slice(1)
    .map((r) => Array.from(r.querySelectorAll('th, td'), (c) => c.textContent ?? ''));
}

describe('RunVariables (#844 V7)', () => {
  it('shows the engine’s values in DECLARED order, typed by the declaration', () => {
    render(
      <RunVariables
        declared={DECLARED}
        overlay={{ ready: true, state: { variables: { count: 5, rows: ['x', 'y'] } } }}
        settled
      />,
    );
    expect(rowsOf()).toEqual([
      ['rows', 'array', '["x","y"]'],
      ['count', 'number', '5'],
    ]);
    expect(within(region()).getByText('Final values.')).toBeTruthy();
  });

  it('says the values are live while the run is still going', () => {
    render(
      <RunVariables
        declared={DECLARED}
        overlay={{ ready: true, state: { variables: { count: 0, rows: [] } } }}
        settled={false}
      />,
    );
    expect(
      within(region()).getByText('Current values, updated as the run writes them.'),
    ).toBeTruthy();
  });

  it('states why there are no values when the projection is not ready, rather than showing none', () => {
    render(
      <RunVariables
        declared={DECLARED}
        overlay={{ ready: false, reason: 'Waiting for the run’s event log…' }}
        settled={false}
      />,
    );
    expect(region().textContent).toContain(
      'Variable values are unavailable. Waiting for the run’s event log…',
    );
    expect(within(region()).queryByRole('table')).toBeNull();
  });

  it('says a variable holds no value instead of printing a blank', () => {
    render(
      <RunVariables
        declared={DECLARED}
        overlay={{ ready: true, state: { variables: { count: 1 } } }}
        settled
      />,
    );
    expect(rowsOf()[0]).toEqual(['rows', 'array', 'no value']);
  });

  it('quotes a string, so an empty one is not a blank cell', () => {
    render(
      <RunVariables
        declared={[{ name: 'label', type: 'string', default: '' }]}
        overlay={{ ready: true, state: { variables: { label: '' } } }}
        settled
      />,
    );
    expect(rowsOf()[0]).toEqual(['label', 'string', '""']);
  });

  it('shows a long value whole in a bounded block, and a very long one behind a disclosure', async () => {
    const long = 'z'.repeat(500);
    const huge = Array.from({ length: 1000 }, (_, i) => `row-${i}`);
    render(
      <RunVariables
        declared={[
          { name: 's', type: 'string', default: '' },
          { name: 'rows', type: 'array', default: [] },
        ]}
        overlay={{ ready: true, state: { variables: { s: long, rows: huge } } }}
        settled
      />,
    );
    const [first, second] = rowsOf();
    expect(first?.[2]).toBe(JSON.stringify(long));
    const hugeText = JSON.stringify(huge);
    expect(second?.[2]).not.toContain(hugeText);
    await userEvent.click(
      within(region()).getByRole('button', { name: `Show all ${hugeText.length} characters` }),
    );
    expect(rowsOf()[1]?.[2]).toContain(hugeText);
  });

  it('renders nothing for a pipeline with no variables, or with no version doc', () => {
    const ready = { ready: true as const, state: { variables: {} } };
    const { container, rerender } = render(<RunVariables declared={[]} overlay={ready} settled />);
    expect(container.innerHTML).toBe('');
    rerender(<RunVariables declared={undefined} overlay={ready} settled />);
    expect(container.innerHTML).toBe('');
  });
});
