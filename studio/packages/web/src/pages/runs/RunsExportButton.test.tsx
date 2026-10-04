import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as runsApi from '../../api/runs';
import * as download from '../../api/download';
import { ApiError } from '../../api/client';
import {
  RunsExportButton,
  runsExportFileName,
  runsExportTruncatedLabel,
} from './RunsExportButton';

vi.mock('../../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../../api/runs')>()),
  exportRunsCsv: vi.fn(),
}));
vi.mock('../../api/download', async (importActual) => ({
  ...(await importActual<typeof import('../../api/download')>()),
  downloadTextFile: vi.fn(),
}));

const exportMock = vi.mocked(runsApi.exportRunsCsv);
const downloadMock = vi.mocked(download.downloadTextFile);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RunsExportButton (#1484)', () => {
  it('exports the query it is given and saves the CSV', async () => {
    exportMock.mockResolvedValue({ csv: 'run_id\r\n', truncated: null });
    const query = { status: 'failure' as const, q: 'orders' };
    render(<RunsExportButton query={query} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
    expect(exportMock).toHaveBeenCalledWith(query, expect.any(AbortSignal));
    const [name, text, mime] = downloadMock.mock.calls[0]!;
    expect(name).toMatch(/^runs-\d{8}-\d{6}Z\.csv$/);
    expect([text, mime]).toEqual(['run_id\r\n', 'text/csv']);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('says when the server cut the file at its cap', async () => {
    exportMock.mockResolvedValue({ csv: 'x', truncated: 10000 });
    render(<RunsExportButton query={{}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Exported the first 10,000 runs. Narrow the filters for the rest.',
    );
  });

  it('is disabled while an export is in flight', async () => {
    let finish: (v: { csv: string; truncated: null }) => void = () => undefined;
    exportMock.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<RunsExportButton query={{}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeDisabled();
    finish({ csv: 'x', truncated: null });
    expect(await screen.findByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('alerts on a failure and saves nothing', async () => {
    exportMock.mockRejectedValue(new ApiError(500, 'disk on fire'));
    render(<RunsExportButton query={{}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Export failed: disk on fire');
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('drops a note about the last export when the filters change', async () => {
    exportMock.mockResolvedValue({ csv: 'x', truncated: 10000 });
    const { rerender } = render(<RunsExportButton query={{}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await screen.findByRole('status');
    rerender(<RunsExportButton query={{ status: 'success' }} />);
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
