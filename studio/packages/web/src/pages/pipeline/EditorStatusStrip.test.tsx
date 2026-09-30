import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { EditorStatusStrip } from './EditorStatusStrip';
import { newestFirst } from './noticeOrder';

/**
 * #1393 — the editor's one notice line. jsdom computes no layout, so the
 * fixed height is `editor-layout-stability.spec.ts`'s to prove; these pin
 * WHICH notices are drawn in the line, which the height depends on (a second
 * one rendered in the flow is exactly the shift being removed).
 */
describe('newestFirst', () => {
  it('moves a key whose text changed to the front', () => {
    expect(
      newestFirst(['canvas', 'save'], { canvas: 'Copied a.', save: null }, [
        { key: 'canvas', text: 'Copied a.' },
        { key: 'save', text: 'Saved v2.' },
      ]),
    ).toEqual(['save', 'canvas']);
  });

  it('keeps the order when a text only clears', () => {
    expect(
      newestFirst(['save', 'canvas'], { canvas: 'Copied a.', save: 'Saved v2.' }, [
        { key: 'canvas', text: null },
        { key: 'save', text: 'Saved v2.' },
      ]),
    ).toEqual(['save', 'canvas']);
  });
});

function strip(save: string | null, canvas: string | null, standing: string[] = []) {
  return (
    <EditorStatusStrip
      standing={standing.map((text) => ({
        key: text,
        node: (
          <div className="notice-conflict" role="alert">
            <p>{text}</p>
          </div>
        ),
      }))}
      transient={[
        { key: 'canvas', text: canvas, role: 'status' },
        { key: 'save', text: save },
      ]}
    />
  );
}

describe('EditorStatusStrip', () => {
  it('draws ONE transient message, the newest, and counts the other', () => {
    const { container, rerender } = render(strip('Saved v2.', null));
    rerender(strip('Saved v2.', 'Copied a.'));
    const drawn = [...container.querySelectorAll('.notice')].map((n) => n.textContent);
    expect(drawn).toEqual(['Copied a.']);
    expect(screen.getByRole('button', { name: '+1 more' })).toBeTruthy();

    // A later save is newer than the copy, so it takes the line back.
    rerender(strip('Saved v3.', 'Copied a.'));
    expect([...container.querySelectorAll('.notice')].map((n) => n.textContent)).toEqual([
      'Saved v3.',
    ]);
  });

  it('draws a standing banner BESIDE the newest message, not behind it', () => {
    const { container } = render(strip('Save failed: archived', null, ['Archived.']));
    expect(screen.getByRole('alert').textContent).toBe('Archived.');
    expect(container.querySelector('.notice')?.textContent).toBe('Save failed: archived');
    // Both are drawn, so there is nothing more to disclose.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lists the notices the line could not draw, only while open', () => {
    const { container } = render(strip('Saved v2.', null, ['Conflict.', 'Archived.']));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    const more = screen.getByRole('button', { name: '+1 more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const list = container.querySelector('.editor-status-strip__list');
    // The hidden one only: a second copy of the shown banner would be a
    // second alert with a second set of its buttons.
    expect(list?.textContent).toBe('Archived.');
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    fireEvent.keyDown(list!, { key: 'Escape' });
    expect(container.querySelector('.editor-status-strip__list')).toBeNull();
  });

  it('is mounted and empty with nothing to say, so it holds its line', () => {
    const { container } = render(strip(null, null));
    expect(container.querySelector('.editor-status-strip')).not.toBeNull();
    expect(container.querySelector('.notice')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('#1395 — draws a notice\'s link after its text, inside the same line', () => {
    const { container } = render(
      <MemoryRouter>
        <EditorStatusStrip
          standing={[]}
          transient={[
            { key: 'run', text: 'Run started (v2).', link: { to: '/monitor/runs/r1', label: 'Open run' } },
          ]}
        />
      </MemoryRouter>,
    );
    const notice = container.querySelector('.editor-status-strip__transient .notice');
    expect(notice?.textContent).toBe('Run started (v2). Open run');
    expect(screen.getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe('/monitor/runs/r1');
  });
});
