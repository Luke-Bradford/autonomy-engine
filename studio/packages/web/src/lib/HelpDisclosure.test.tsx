import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelpDisclosure, placeNote } from './HelpDisclosure';

function help() {
  const view = render(
    <>
      <HelpDisclosure label="About it" noteId="note">
        inside
      </HelpDisclosure>
      <button type="button">outside</button>
      <p>plain text</p>
    </>,
  );
  const details = screen.getByText('inside').closest('details')!;
  // Opened as a click on the summary would; `toggle` is dispatched explicitly
  // because jsdom does not fire it from the property.
  act(() => {
    details.open = true;
    fireEvent(details, new Event('toggle'));
  });
  return { details, ...view };
}

afterEach(() => vi.restoreAllMocks());

describe('HelpDisclosure (#1484 M2 — the ? help)', () => {
  it('is the note’s label and description hook', () => {
    help();
    expect(screen.getByLabelText('About it').tagName).toBe('SUMMARY');
    expect(document.getElementById('note')).toHaveTextContent('inside');
  });

  it('closes on Escape and hands focus back to its summary', () => {
    const { details } = help();
    fireEvent.keyDown(screen.getByText('inside'), { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('About it'));
  });

  it('claims the Escape that closes it, and only that one', () => {
    const { details } = help();
    // `fireEvent` returns false when the handler called `preventDefault`: a
    // drawer or the expanded dock around it then leaves that Escape alone.
    expect(fireEvent.keyDown(screen.getByText('inside'), { key: 'Escape' })).toBe(false);
    expect(details.open).toBe(false);
    expect(fireEvent.keyDown(screen.getByLabelText('About it'), { key: 'Escape' })).toBe(true);
  });

  it('closes when focus moves outside it, not inside it, and not to nothing', () => {
    const { details } = help();
    fireEvent.blur(screen.getByLabelText('About it'), {
      relatedTarget: screen.getByText('inside'),
    });
    expect(details.open).toBe(true);
    // The window losing focus, or a click on text: no `relatedTarget`.
    fireEvent.blur(screen.getByText('inside'), { relatedTarget: null });
    expect(details.open).toBe(true);
    fireEvent.blur(screen.getByText('inside'), { relatedTarget: screen.getByText('outside') });
    expect(details.open).toBe(false);
  });

  it('closes on a pointer press outside it, and not on one inside it', () => {
    const { details } = help();
    fireEvent.pointerDown(screen.getByText('inside'));
    expect(details.open).toBe(true);
    fireEvent.pointerDown(screen.getByText('plain text'));
    expect(details.open).toBe(false);
  });

  it('removes its document listener when it unmounts while open', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = help();
    const armed = add.mock.calls.find(([type]) => type === 'pointerdown');
    expect(armed).toBeDefined();
    unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', armed![1], true);
  });

  it('inline (#1477 OR29): the same note and description, anchored by its row', () => {
    render(
      <section aria-describedby="n_inline">
        <HelpDisclosure label="About Params" noteId="n_inline" inline>
          What the section holds.
        </HelpDisclosure>
      </section>,
    );
    const details = screen.getByText('What the section holds.').closest('details');
    expect(details).toHaveClass('help-disclosure', 'help-disclosure--inline');
    expect(screen.getByRole('note')).toHaveAttribute('id', 'n_inline');
  });
});

/** A box at `left, top`, `width` by `height`, as `getBoundingClientRect` gives it. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

describe('placeNote (#1695 OR43 — the open note, in the top layer)', () => {
  function place(
    q: DOMRect,
    note: { width: number; height: number },
    opts: { inline?: DOMRect; viewport?: { width: number; height: number } } = {},
  ) {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(opts.viewport?.width ?? 1440);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(opts.viewport?.height ?? 900);
    const row = document.createElement('div');
    const details = document.createElement('details');
    const span = document.createElement('span');
    row.append(details);
    details.append(span);
    document.body.append(row);
    vi.spyOn(details, 'getBoundingClientRect').mockReturnValue(q);
    vi.spyOn(span, 'getBoundingClientRect').mockReturnValue(rect(0, 0, note.width, note.height));
    if (opts.inline) {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(opts.inline);
      // jsdom has no layout, so no offsetParent: the row stands in for it.
      Object.defineProperty(details, 'offsetParent', { value: row });
    }
    placeNote(details, span, opts.inline !== undefined);
    const out = {
      left: span.style.left,
      top: span.style.top,
      width: span.style.getPropertyValue('--help-anchor-width'),
    };
    row.remove();
    return out;
  }

  it('opens under the ?, its right edge on the ?\'s', () => {
    expect(place(rect(600, 100, 16, 16), { width: 352, height: 60 })).toEqual({
      left: `${616 - 352}px`,
      top: '120px',
      width: '',
    });
  });

  it('opens above the ? when the room below is too short', () => {
    // 860 + 4 + 60 > 900 - 8: flipped, its bottom 4px over the ?.
    expect(place(rect(600, 840, 16, 16), { width: 352, height: 60 }).top).toBe(`${840 - 4 - 60}px`);
  });

  it('stays below when there is no more room above either', () => {
    expect(
      place(rect(600, 40, 16, 16), { width: 352, height: 120 }, { viewport: { width: 1440, height: 150 } }).top,
    ).toBe('60px');
  });

  it('is held inside the viewport sideways', () => {
    // Its right edge on the ?'s would put its left at -252.
    expect(place(rect(84, 100, 16, 16), { width: 352, height: 60 }).left).toBe('8px');
  });

  it('inline: under its row, at the row\'s left and width', () => {
    expect(
      place(rect(900, 100, 16, 16), { width: 400, height: 60 }, { inline: rect(500, 90, 400, 28) }),
    ).toEqual({ left: '500px', top: '122px', width: '400px' });
  });
});
