import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Section } from './Section';

// #1594 OR40 S3 — the ONE section: a heading in the section type, a `?` that
// holds what the section is for (#1413: every section says it, and the note is
// the section's accessible description), optional actions on the heading row,
// and an optional collapse.
describe('Section (#1594 OR40 S3)', () => {
  it('is a group named by its heading alone, described by its help', () => {
    render(
      <Section heading="Basics" help="What this thing is called.">
        <input aria-label="Name" />
      </Section>,
    );
    const group = screen.getByRole('group', { name: 'Basics' });
    expect(group).toHaveAccessibleDescription('What this thing is called.');
    expect(screen.getByRole('heading', { level: 3, name: 'Basics' })).toBeInTheDocument();
    // Not a paragraph on the page: the note is inside a closed `?`.
    expect(screen.getByText('What this thing is called.')).not.toBeVisible();
  });

  it('shows the help from the ? on demand', async () => {
    render(
      <Section heading="Parameters" help="The typed inputs a run supplies.">
        <p>rows</p>
      </Section>,
    );
    await userEvent.click(screen.getByLabelText('About Parameters'));
    expect(screen.getByText('The typed inputs a run supplies.')).toBeVisible();
  });

  it('a landmark section is a region, at the level it is given, with its actions', () => {
    render(
      <Section
        heading="Account quota"
        help="How much of each account's allowance is used."
        level={2}
        landmark
        actions={<button type="button">Refresh quota</button>}
      >
        <p>figures</p>
      </Section>,
    );
    const region = screen.getByRole('region', { name: 'Account quota' });
    expect(region).toHaveAccessibleDescription("How much of each account's allowance is used.");
    expect(screen.getByRole('heading', { level: 2, name: 'Account quota' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Account quota' })).toBeNull();
    expect(region).toContainElement(screen.getByRole('button', { name: 'Refresh quota' }));
  });

  it('a collapsible section is a disclosure: closed unless defaultOpen', async () => {
    render(
      <Section heading="Advanced" help="Settings most people never touch." collapsible>
        <input aria-label="Retries" />
      </Section>,
    );
    const toggle = screen.getByRole('button', { name: 'Advanced' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Retries')).not.toBeVisible();
    // Still the group's name and description while closed.
    expect(screen.getByRole('group', { name: 'Advanced' })).toHaveAccessibleDescription(
      'Settings most people never touch.',
    );
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Retries')).toBeVisible();
  });

  it('a collapsible section opens when defaultOpen turns true after mount', () => {
    // A form whose record loads after it mounts: stored state must not hide.
    const ui = (open: boolean) => (
      <Section
        heading="Advanced"
        help="Settings most people never touch."
        collapsible
        defaultOpen={open}
      >
        <input aria-label="Retries" />
      </Section>
    );
    const { rerender } = render(ui(false));
    expect(screen.getByLabelText('Retries')).not.toBeVisible();
    rerender(ui(true));
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByLabelText('Retries')).toBeVisible();
  });
});
