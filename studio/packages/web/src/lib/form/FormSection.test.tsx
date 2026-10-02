import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormSection } from './FormSection';

// #1413 OR22 — a section says what it holds, in one line under its title, and
// that line is the group's accessible description, so a screen reader hears it
// on entering the group as a sighted person reads it.
describe('FormSection hint (#1413)', () => {
  it('a plain section describes its fieldset with the hint', () => {
    render(
      <FormSection title="Basics" hint="What this thing is called.">
        <input aria-label="Name" />
      </FormSection>,
    );
    const group = screen.getByRole('group', { name: 'Basics' });
    expect(group).toHaveAccessibleDescription('What this thing is called.');
  });

  it('a collapsible section describes its body group with the hint', () => {
    render(
      <FormSection
        title="Advanced"
        hint="Settings most people never touch."
        collapsible
        defaultOpen
      >
        <input aria-label="Retries" />
      </FormSection>,
    );
    const group = screen.getByRole('group', { name: 'Advanced' });
    expect(group).toHaveAccessibleDescription('Settings most people never touch.');
  });
});
