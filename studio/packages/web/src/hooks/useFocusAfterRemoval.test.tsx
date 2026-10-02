import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RowMenuOrigin } from '../lib/RowMoreMenu';
import { useFocusAfterRemoval } from './useFocusAfterRemoval';

interface Row {
  readonly id: string;
}

interface Api {
  setRows: (rows: Row[] | null) => void;
  restoreFocus: (id: string) => () => HTMLElement | null;
  removing: (id: string) => () => void;
}
let api: Api | null = null;
const expose = (next: Api) => {
  api = next;
};

/** What `RowMoreMenu` hands an action: the row's `⋯`, and a lookup for it. */
function origin(id: string): RowMenuOrigin {
  const find = () => document.getElementById(`menu-${id}`);
  return { element: find()!, find };
}

/** A table whose rows each have a `⋯`, as the list pages draw them. */
function Table({ initial }: { initial: Row[] }): ReactNode {
  const [rows, setRows] = useState<Row[] | null>(initial);
  const createRef = useRef<HTMLButtonElement>(null);
  const { restoreFocus, removing } = useFocusAfterRemoval(rows, createRef);
  useEffect(
    () =>
      expose({
        setRows,
        restoreFocus: (id) => restoreFocus(origin(id)),
        removing: (id) => removing(id, origin(id)),
      }),
    [restoreFocus, removing],
  );
  return (
    <>
      <button ref={createRef} type="button">
        New
      </button>
      <button type="button">Elsewhere</button>
      <table>
        <tbody>
          {(rows ?? []).map((row) => (
            <tr key={row.id}>
              <td>
                <button id={`menu-${row.id}`} type="button" className="row-menu__trigger">
                  {`Actions for ${row.id}`}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const ABC = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const button = (name: string) => screen.getByRole('button', { name });

/** Confirm `id`'s removal, with focus on its `⋯` as the dialog leaves it, then remove it. */
function remove(id: string, rest: Row[]): void {
  api!.removing(id);
  button(`Actions for ${id}`).focus();
  act(() => api!.setRows(rest));
}

describe('useFocusAfterRemoval (#1470)', () => {
  it("moves focus from a removed row's ⋯ to the next row's", () => {
    render(<Table initial={ABC} />);
    remove('b', [{ id: 'a' }, { id: 'c' }]);
    expect(button('Actions for c')).toHaveFocus();
  });

  it("moves to the previous row's ⋯ when the last row goes", () => {
    render(<Table initial={ABC} />);
    remove('c', [{ id: 'a' }, { id: 'b' }]);
    expect(button('Actions for b')).toHaveFocus();
  });

  it("moves to the page's create control when the list empties", () => {
    render(<Table initial={[{ id: 'a' }]} />);
    remove('a', []);
    expect(button('New')).toHaveFocus();
  });

  it('leaves focus alone when the operator has moved it somewhere else', () => {
    render(<Table initial={ABC} />);
    api!.removing('b');
    button('Elsewhere').focus();
    act(() => api!.setRows([{ id: 'a' }, { id: 'c' }]));
    expect(button('Elsewhere')).toHaveFocus();
  });

  it('does nothing while the row is still listed', () => {
    render(<Table initial={ABC} />);
    api!.removing('b');
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    act(() => api!.setRows([...ABC]));
    expect(document.body).toHaveFocus();
  });

  // A declined question records nothing, and a failed delete forgets its row:
  // the row leaving LATER, for some other reason, must not pull focus about.
  it('does not act for a declined question, nor for a removal that failed', () => {
    render(<Table initial={ABC} />);
    api!.restoreFocus('a');
    const forget = api!.removing('b');
    forget();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    act(() => api!.setRows([{ id: 'c' }]));
    expect(document.body).toHaveFocus();
  });

  it('reads an unknown list (null) as unknown, not as emptied', () => {
    render(<Table initial={ABC} />);
    api!.removing('b');
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    act(() => api!.setRows(null));
    expect(document.body).toHaveFocus();
  });

  it("answers the dialog with the row's ⋯ while it is there, and its neighbour's once it is gone", () => {
    render(<Table initial={ABC} />);
    const lookup = api!.restoreFocus('b');
    expect(lookup()).toBe(button('Actions for b'));
    // Gone before the dialog finished closing; focus is in the dialog, not stranded.
    button('Elsewhere').focus();
    act(() => api!.setRows([{ id: 'a' }, { id: 'c' }]));
    expect(lookup()).toBe(button('Actions for c'));
  });
});
