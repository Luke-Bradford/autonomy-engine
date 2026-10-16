import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatasetTablesResult, InlineDataset } from '@autonomy-studio/shared';
import { listConnectionTables } from '../../api/datasets';
import { ConnectionTables } from './ConnectionTables';

vi.mock('../../api/datasets', async (importActual) => {
  const actual = await importActual<typeof import('../../api/datasets')>();
  return { ...actual, listConnectionTables: vi.fn() };
});
const list = vi.mocked(listConnectionTables);

afterEach(() => list.mockReset());

const table = (config: Record<string, unknown>): InlineDataset => ({ kind: 'table', config });
const button = () => screen.getByRole('button', { name: /List tables|Listing…/ });
const chooser = () => screen.queryByRole('combobox', { name: 'Table in this connection' });

describe('ConnectionTables (#1600 C1q-c)', () => {
  it('offers the listed tables, a schema-qualified one by both names, and hands back the pair', async () => {
    list.mockResolvedValue({
      ok: true,
      tables: [
        { schema: 'public', name: 'orders' },
        { schema: 'sales', name: 'orders' },
        { schema: null, name: 'a.b' },
      ],
      truncated: false,
    });
    const choose = vi.fn();
    render(<ConnectionTables inline={table({ table: '' })} connectionId="c1" choose={choose} />);
    expect(chooser()).toBeNull();
    await act(async () => fireEvent.click(button()));
    expect(list).toHaveBeenCalledWith('c1', expect.any(AbortSignal));
    const select = chooser() as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual([
      '— choose —',
      'public.orders',
      'sales.orders',
      'a.b',
    ]);
    // Two tables share a name across schemas: the choice is the pair, by position.
    fireEvent.change(select, { target: { value: '1' } });
    expect(choose).toHaveBeenCalledWith({ schema: 'sales', name: 'orders' });
  });

  it('shows the current table as chosen only when schema and name both match', async () => {
    list.mockResolvedValue({
      ok: true,
      tables: [
        { schema: 'public', name: 'orders' },
        { schema: 'sales', name: 'orders' },
      ],
      truncated: false,
    });
    const { rerender } = render(
      <ConnectionTables
        inline={table({ schema: 'sales', table: 'orders' })}
        connectionId="c1"
        choose={() => {}}
      />,
    );
    await act(async () => fireEvent.click(button()));
    expect((chooser() as HTMLSelectElement).value).toBe('1');
    rerender(
      <ConnectionTables inline={table({ table: 'orders' })} connectionId="c1" choose={() => {}} />,
    );
    expect((chooser() as HTMLSelectElement).value).toBe('-1');
  });

  it('says a refusal, an empty list and a prefix', async () => {
    list.mockResolvedValueOnce({ ok: false, error: 'this connection is disabled' });
    render(<ConnectionTables inline={table({})} connectionId="c1" choose={() => {}} />);
    await act(async () => fireEvent.click(button()));
    expect(screen.getByText('this connection is disabled')).toBeTruthy();

    list.mockResolvedValueOnce({ ok: true, tables: [], truncated: false });
    await act(async () => fireEvent.click(button()));
    expect(screen.getByText('No tables')).toBeTruthy();

    list.mockResolvedValueOnce({
      ok: true,
      tables: [{ schema: null, name: 't' }],
      truncated: true,
    });
    await act(async () => fireEvent.click(button()));
    expect(screen.getByText('First 1 tables; type a name to use another')).toBeTruthy();
  });

  it('drops a list, and aborts its request, when the connection changes', async () => {
    let resolve!: (r: DatasetTablesResult) => void;
    list.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { rerender } = render(
      <ConnectionTables inline={table({})} connectionId="c1" choose={() => {}} />,
    );
    await act(async () => fireEvent.click(button()));
    const signal = list.mock.calls[0]![1]!;
    rerender(<ConnectionTables inline={table({})} connectionId="c2" choose={() => {}} />);
    expect(signal.aborted).toBe(true);
    // The answer for c1 arrives late and is not shown for c2.
    await act(async () =>
      resolve({ ok: true, tables: [{ schema: null, name: 't' }], truncated: false }),
    );
    expect(chooser()).toBeNull();
    expect(button().textContent).toBe('List tables');

    list.mockResolvedValueOnce({
      ok: true,
      tables: [{ schema: null, name: 'u' }],
      truncated: false,
    });
    await act(async () => fireEvent.click(button()));
    expect(chooser()).not.toBeNull();
    rerender(<ConnectionTables inline={table({})} connectionId="c1" choose={() => {}} />);
    expect(chooser()).toBeNull();
  });

  it('cannot list without a saved connection', () => {
    render(<ConnectionTables inline={table({})} connectionId={undefined} choose={() => {}} />);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
  });
});
