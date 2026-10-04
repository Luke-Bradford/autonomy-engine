import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as runsApi from '../../api/runs';
import type { ListRunsQuery } from '../../api/runs';
import * as download from '../../api/download';
import { ApiError } from '../../api/client';
import { RunsExportButton, RunsExportNote } from './RunsExportButton';
import { useRunsExport } from './useRunsExport';
import { runsExportFileName, runsExportTruncatedLabel } from './runsExport';

vi.mock('../../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../../api/runs')>()),
  exportRunsCsv: vi.fn(),
}));
vi.mock('../../api/download', async (importActual) => ({
  ...(await importActual<typeof import('../../api/download')>()),
  downloadBlob: vi.fn(),
}));

const exportMock = vi.mocked(runsApi.exportRunsCsv);
const downloadMock = vi.mocked(download.downloadBlob);

/** The page's wiring: one exporter, its button and its note. */
function Harness({ query }: { query: ListRunsQuery }) {
  const exporter = useRunsExport(query);
  return (
    <>
      <RunsExportButton exporter={exporter} />
      <RunsExportNote exporter={exporter} />
    </>
  );
}

const click = () => fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useRunsExport + RunsExportButton (#1484)', () => {
  it('exports the query it is given and saves the server bytes', async () => {
    const file = new Blob(['run_id\r\n'], { type: 'text/csv' });
    exportMock.mockResolvedValue({ file, truncated: null });
    const query = { status: 'failure' as const, q: 'orders' };
    render(<Harness query={query} />);
    click();
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
    expect(exportMock).toHaveBeenCalledWith(query, expect.any(AbortSignal));
    const [name, saved] = downloadMock.mock.calls[0]!;
    expect(name).toMatch(/^runs-\d{8}-\d{6}Z\.csv$/);
    expect(saved).toBe(file);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('says when the server cut the file at its cap', async () => {
    exportMock.mockResolvedValue({ file: new Blob(['x']), truncated: 10000 });
    render(<Harness query={{}} />);
    click();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'The CSV holds the first 10,000 runs. Narrow the filters for the rest.',
    );
  });

  it('is disabled while an export is in flight', async () => {
    let finish: (v: { file: Blob; truncated: null }) => void = () => undefined;
    exportMock.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<Harness query={{}} />);
    click();
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeDisabled();
    finish({ file: new Blob(['x']), truncated: null });
    expect(await screen.findByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('alerts on a failure and saves nothing', async () => {
    exportMock.mockRejectedValue(new ApiError(500, 'disk on fire'));
    render(<Harness query={{}} />);
    click();
    expect(await screen.findByRole('alert')).toHaveTextContent('Export failed: disk on fire');
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('still reports a failure that answers after the filters changed', async () => {
    let fail: (err: Error) => void = () => undefined;
    exportMock.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const { rerender } = render(<Harness query={{}} />);
    click();
    rerender(<Harness query={{ status: 'success' }} />);
    fail(new ApiError(500, 'disk on fire'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Export failed: disk on fire');
  });

  it('clears a note once the filters change after it', async () => {
    exportMock.mockResolvedValue({ file: new Blob(['x']), truncated: 10000 });
    const { rerender } = render(<Harness query={{}} />);
    click();
    await screen.findByRole('status');
    rerender(<Harness query={{ status: 'success' }} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('runsExportFileName / runsExportTruncatedLabel', () => {
  it('stamps the file in UTC, with no colon', () => {
    expect(runsExportFileName(Date.UTC(2026, 9, 4, 8, 5, 9, 123))).toBe(
      'runs-20261004-080509Z.csv',
    );
  });

  it('groups the cap with commas', () => {
    expect(runsExportTruncatedLabel(10000)).toContain('10,000');
  });
});
