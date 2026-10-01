import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  CONNECTION_KIND_ICONS,
  ConnectionKindName,
  DatasetKindName,
  KindGlyph,
  TriggerModeName,
} from './kindIcon';

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

  it('draws a kind of the same family with the glyph the canvas uses for that act', () => {
    // An HTTP connection and an LLM connection read as the activities that
    // use them do: one icon language across the app, not two.
    expect(CONNECTION_KIND_ICONS.http).not.toBe(CONNECTION_KIND_ICONS.anthropic_api);
    expect(CONNECTION_KIND_ICONS.anthropic_api).toBe(CONNECTION_KIND_ICONS.openai_api);
    expect(CONNECTION_KIND_ICONS.sqlite).toBe(CONNECTION_KIND_ICONS.postgres);
  });

  it('a bare glyph is hidden from the accessibility tree', () => {
    const { container } = render(<KindGlyph glyph={CONNECTION_KIND_ICONS.fs} kind="fs" />);
    expect(container.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
  });
});
