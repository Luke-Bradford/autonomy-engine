import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionKindName, DatasetKindName, KindSelect, TriggerModeName } from './KindName';
import { CONNECTION_KIND_ICONS, TRIGGER_MODE_ICONS } from './kindIcons';
import { activityIcon } from '../pages/pipeline/activityIcon';

/**
 * #1396 — a kind is shown as its display name WITH an icon. The icon is
 * decoration: the name is still the text a reader hears and a test or a sort
 * reads, and the glyph carries which kind it draws so a swap can be asserted.
 */
describe('kind names with an icon', () => {
  it('draws the display name after a hidden glyph that names its kind', () => {
    const { container } = render(<ConnectionKindName kind="postgres" />);
    const name = container.querySelector('.kind-name')!;
    expect(name.textContent).toBe('PostgreSQL');
    const glyph = name.querySelector('.kind-icon')!;
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(glyph.getAttribute('data-kind')).toBe('postgres');
    expect(glyph.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
  });

  it('names dataset kinds and trigger modes the same way', () => {
    const { container } = render(
      <>
        <DatasetKindName kind="delimited" />
        <TriggerModeName mode="tumbling" />
      </>,
    );
    const names = [...container.querySelectorAll('.kind-name')];
    expect(names.map((n) => n.textContent)).toEqual(['Delimited text (CSV)', 'Tumbling window']);
    expect(names.map((n) => n.querySelector('.kind-icon svg') !== null)).toEqual([true, true]);
  });

  it('the picker shows the chosen kind beside it, hidden, and keeps its control', () => {
    const { container } = render(
      <KindSelect icons={CONNECTION_KIND_ICONS} kind="fs">
        <select aria-label="Kind" />
      </KindSelect>,
    );
    const glyph = container.querySelector('.kind-select > .kind-icon')!;
    expect(glyph.getAttribute('data-kind')).toBe('fs');
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByLabelText('Kind').parentElement).toBe(container.firstElementChild);
  });

  it('a kind with an activity draws the shape the canvas draws for that act', () => {
    // One icon language: the canvas's glyphs are the 20px variants, these the
    // unsized ones, so compare the icon's name with the size taken out.
    const shape = (glyph: { displayName?: string }) => glyph.displayName?.replace(/\d+/, '');
    const pairs: [{ displayName?: string }, string][] = [
      [CONNECTION_KIND_ICONS.anthropic_api, 'llm_call'],
      [CONNECTION_KIND_ICONS.agent_cli, 'agent_task'],
      [CONNECTION_KIND_ICONS.http, 'http_request'],
      [CONNECTION_KIND_ICONS.fs, 'file_list'],
      [TRIGGER_MODE_ICONS.webhook, 'webhook'],
    ];
    for (const [glyph, activity] of pairs) {
      expect(shape(glyph), activity).toBe(shape(activityIcon(activity)));
      expect(shape(glyph), activity).toMatch(/Regular$/);
    }
  });
});
