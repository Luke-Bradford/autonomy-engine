import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatasetPreviewResult, InlineDataset } from '@autonomy-studio/shared';
import { previewDatasetSource } from '../../api/datasets';
import { SourcePreview } from './SourcePreview';

vi.mock('../../api/datasets', async (importActual) => {
  const actual = await importActual<typeof import('../../api/datasets')>();
  return { ...actual, previewDatasetSource: vi.fn() };
});
const preview = vi.mocked(previewDatasetSource);

afterEach(() => preview.mockReset());

const query = (sql: string, parameters?: Record<string, unknown>): InlineDataset => ({
  kind: 'query',
  config: parameters === undefined ? { sql } : { sql, parameters },
});

function deferred() {
  let resolve!: (r: DatasetPreviewResult) => void;
  const promise = new Promise<DatasetPreviewResult>((r) => (resolve = r));
  return { promise, resolve };
}

const button = () => screen.getByRole('button', { name: /Preview data|Reading…/ });

describe('SourcePreview (#1600 C1q-c)', () => {
  it('shows the rows it read, a NULL as NULL, under a count', async () => {
    preview.mockResolvedValue({
      ok: true,
      rows: [
        { id: 1, note: null },
        { id: 2, note: 'b' },
      ],
      truncated: false,
    });
    render(<SourcePreview inline={query('SELECT 1')} connectionId="c1" connectionParams={false} />);
    await act(async () => fireEvent.click(button()));
    expect(screen.getByText('2 rows')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Preview rows' });
    expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['id', 'note']);
    expect(table.querySelector('.preview-null')?.textContent).toBe('NULL');
  });

  it('says a prefix is a prefix, and shows the server’s note instead when there is one', async () => {
    preview.mockResolvedValueOnce({ ok: true, rows: [{ id: 1 }], truncated: true });
    const { rerender } = render(
      <SourcePreview inline={query('SELECT 1')} connectionId="c1" connectionParams={false} />,
    );
    await act(async () => fireEvent.click(button()));
    expect(screen.getByText('First 1 rows')).toBeTruthy();

    preview.mockResolvedValueOnce({ ok: true, rows: [], truncated: true, note: 'Too wide.' });
    rerender(
      <SourcePreview inline={query('SELECT 2')} connectionId="c1" connectionParams={false} />,
    );
    await act(async () => fireEvent.click(button()));
    expect(screen.getByText('Too wide.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('asks for a value in place of a ${} and binds it as the run would', async () => {
    preview.mockResolvedValue({ ok: true, rows: [], truncated: false });
    render(
      <SourcePreview
        inline={query('SELECT * FROM t WHERE a > :wm', { wm: '${nodes.l.output.rows[0].wm}' })}
        connectionId="c1"
        connectionParams={false}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Preview value for :wm' }), {
      target: { value: '100' },
    });
    await act(async () => fireEvent.click(button()));
    expect(preview.mock.calls[0]![0]).toEqual({
      connectionId: 'c1',
      source: { from: 'inline', inline: query('SELECT * FROM t WHERE a > :wm', { wm: 100 }) },
    });
  });

  // An edit aborts the request in flight, which then never answers. Undoing the
  // edit must not bring its "Reading…" back with nothing left to end it.
  it('is not stuck reading when an edit is undone during a read', async () => {
    const first = deferred();
    preview.mockReturnValueOnce(first.promise);
    const { rerender } = render(
      <SourcePreview inline={query('SELECT 1')} connectionId="c1" connectionParams={false} />,
    );
    await act(async () => fireEvent.click(button()));
    expect(button().textContent).toBe('Reading…');

    rerender(
      <SourcePreview inline={query('SELECT 12')} connectionId="c1" connectionParams={false} />,
    );
    rerender(
      <SourcePreview inline={query('SELECT 1')} connectionId="c1" connectionParams={false} />,
    );
    expect(button().textContent).toBe('Preview data');
    expect((button() as HTMLButtonElement).disabled).toBe(false);

    // The aborted read's late answer is ignored.
    await act(async () => first.resolve({ ok: true, rows: [{ id: 1 }], truncated: false }));
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('cannot read without a saved connection, and says what Preview does not apply', () => {
    render(<SourcePreview inline={query('SELECT 1')} connectionId={undefined} connectionParams />);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Pick a saved source connection to preview')).toBeTruthy();
    expect(screen.getByText(/connection parameters are not applied/)).toBeTruthy();
  });
});
