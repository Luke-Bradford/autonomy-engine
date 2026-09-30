import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CATALOG_VERSION, type PipelineVersion } from '@autonomy-studio/shared';
import { RunNowPanel } from './RunNowPanel';

const runPipelineVersion = vi.fn();
vi.mock('../../api/pipelines', () => ({
  runPipelineVersion: (...args: unknown[]) => runPipelineVersion(...args) as unknown,
}));

const version = {
  id: 'pv_1',
  pipelineId: 'p_1',
  version: 4,
  params: [
    { name: 'city', type: 'string', required: false, default: 'Leeds' },
    { name: 'count', type: 'number', required: true },
  ],
  outputs: [],
  nodes: [],
  edges: [],
  catalogVersion: CATALOG_VERSION,
} as unknown as PipelineVersion;

function panel(onStarted = vi.fn(), onClose = vi.fn()) {
  render(
    <RunNowPanel pipelineId="p_1" version={version} onStarted={onStarted} onClose={onClose} />,
  );
  return { onStarted, onClose };
}

describe('RunNowPanel (#1395 OR4)', () => {
  beforeEach(() => {
    runPipelineVersion.mockReset();
  });

  it('prefills each param with its default and names the version it runs', () => {
    panel();
    expect(screen.getByRole('dialog', { name: 'Run v4' })).toBeInTheDocument();
    expect(screen.getByLabelText('city')).toHaveValue('Leeds');
    expect(screen.getByLabelText('count')).toHaveValue('');
  });

  it('sends typed values for exactly that version, then hands up the new run', async () => {
    runPipelineVersion.mockResolvedValue({ outcome: 'started', runId: 'run_9' });
    const { onStarted } = panel();
    fireEvent.change(screen.getByLabelText('count'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('run_9'));
    expect(runPipelineVersion).toHaveBeenCalledWith('p_1', {
      pipelineVersionId: 'pv_1',
      params: { city: 'Leeds', count: 3 },
    });
  });

  it('refuses a value the type cannot take, without a request', () => {
    panel();
    fireEvent.change(screen.getByLabelText('count'), { target: { value: 'three' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect(screen.getByRole('alert')).toHaveTextContent('count: expected a number');
    expect(runPipelineVersion).not.toHaveBeenCalled();
  });

  it('says why when the server skips the run, and stays open', async () => {
    runPipelineVersion.mockResolvedValue({ outcome: 'skipped', reason: 'at its cap' });
    const { onStarted } = panel();
    fireEvent.change(screen.getByLabelText('count'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The run did not start: at its cap.',
    );
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('closes on Escape and on Cancel', () => {
    const { onClose } = panel();
    fireEvent.keyDown(screen.getByLabelText('city'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
