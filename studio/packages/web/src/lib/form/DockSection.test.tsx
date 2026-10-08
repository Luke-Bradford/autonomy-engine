import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DockSection } from './DockSection';

describe('DockSection (#1477 OR29 — help behind a ?)', () => {
  it('names the region by its heading alone, and keeps the hint as its description', () => {
    render(
      <DockSection heading="Params" hint="The typed inputs a run supplies.">
        <p>rows</p>
      </DockSection>,
    );
    const region = screen.getByRole('region', { name: 'Params' });
    expect(region).toHaveAccessibleDescription('The typed inputs a run supplies.');
    // Not a paragraph on the page: the note is inside a closed `?`.
    expect(screen.getByText('The typed inputs a run supplies.')).not.toBeVisible();
  });

  it('shows the hint from the ? on demand', async () => {
    render(
      <DockSection heading="Params" hint="The typed inputs a run supplies.">
        <p>rows</p>
      </DockSection>,
    );
    await userEvent.click(screen.getByLabelText('About Params'));
    expect(screen.getByText('The typed inputs a run supplies.')).toBeVisible();
  });
});
