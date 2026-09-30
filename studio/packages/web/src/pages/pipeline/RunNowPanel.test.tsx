import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CATALOG_VERSION, type PipelineVersion } from '@autonomy-studio/shared';
import { DebugRunPanel, RunNowPanel } from './RunNowPanel';

const runPipelineVersion = vi.fn();
const debugPipelineDraft = vi.fn();
vi.mock('../../api/pipelines', () => ({
  runPipelineVersion: (...args: unknown[]) => runPipelineVersion(...args) as unknown,
  debugPipelineDraft: (...args: unknown[]) => debugPipelineDraft(...args) as unknown,
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

function panel(onStarted = vi.fn(), onClose = vi.fn(), v = version, dirty = false) {
  render(
    <RunNowPanel
      pipelineId="p_1"
      version={v}
      dirty={dirty}
      onStarted={onStarted}
      onClose={onClose}
    />,
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

  it('says in the form, when the canvas has unsaved edits, that they are not included', () => {
    panel(vi.fn(), vi.fn(), version, true);
    expect(screen.getByText(/Your unsaved edits are not included/)).toHaveTextContent(
      'This runs the saved v4. Your unsaved edits are not included.',
    );
  });

  it('says nothing about unsaved edits when there are none', () => {
    panel();
    expect(screen.queryByText(/unsaved edits/)).toBeNull();
  });

  it('offers a boolean as a choice and json as a text area, and sends them typed', async () => {
    runPipelineVersion.mockResolvedValue({ outcome: 'started', runId: 'run_1' });
    const typed = {
      ...version,
      params: [
        { name: 'dry', type: 'boolean', required: false, default: false },
        { name: 'opts', type: 'json', required: false },
      ],
    } as unknown as PipelineVersion;
    const { onStarted } = panel(vi.fn(), vi.fn(), typed);
    const dry = screen.getByLabelText('dry');
    const opts = screen.getByLabelText('opts');
    expect(dry.tagName).toBe('SELECT');
    expect(opts.tagName).toBe('TEXTAREA');
    fireEvent.change(dry, { target: { value: 'true' } });
    fireEvent.change(opts, { target: { value: '{"a":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(runPipelineVersion).toHaveBeenCalledWith('p_1', {
      pipelineVersionId: 'pv_1',
      params: { dry: true, opts: { a: 1 } },
    });
  });

  it('starts ONE run for two submits in the same tick', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    runPipelineVersion.mockReturnValue(new Promise((r) => (resolve = r)));
    panel();
    fireEvent.change(screen.getByLabelText('count'), { target: { value: '1' } });
    const start = screen.getByRole('button', { name: 'Start run' });
    fireEvent.click(start);
    fireEvent.submit(start.closest('form')!);
    // Both submits reach the request synchronously, so a second call would be here now.
    expect(runPipelineVersion).toHaveBeenCalledTimes(1);
    resolve({ outcome: 'started', runId: 'run_1' });
    await waitFor(() => expect(start).not.toBeDisabled());
  });
});

describe('DebugRunPanel (#1395 slice 3)', () => {
  beforeEach(() => {
    debugPipelineDraft.mockReset();
  });

  const draftDoc = {
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };

  it('sends the draft as it is AT START with typed params, then hands up the debug version', async () => {
    const debugVersion = { ...version, id: 'pv_debug', version: 1 };
    debugPipelineDraft.mockResolvedValue({
      outcome: 'started',
      runId: 'run_d',
      pipelineVersion: debugVersion,
      retentionDays: 7,
    });
    let current = { ...draftDoc, description: 'at open' };
    const onStarted = vi.fn();
    render(
      <DebugRunPanel
        pipelineId="p_1"
        params={version.params}
        draft={() => current}
        onStarted={onStarted}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Debug the draft' })).toBeInTheDocument();
    expect(screen.getByText(/not added to the versions/)).toBeInTheDocument();
    current = { ...draftDoc, description: 'at start' };
    fireEvent.change(screen.getByLabelText('count'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run_d',
          pipelineVersion: debugVersion,
          retentionDays: 7,
        }),
      ),
    );
    expect(debugPipelineDraft).toHaveBeenCalledWith('p_1', {
      version: { ...draftDoc, description: 'at start' },
      params: { city: 'Leeds', count: 2 },
    });
  });

  it('says why when the server skips the debug run', async () => {
    debugPipelineDraft.mockResolvedValue({
      outcome: 'skipped',
      reason: 'the pipeline is already running its maximum of 1 at once',
      retentionDays: 7,
    });
    const onStarted = vi.fn();
    render(
      <DebugRunPanel
        pipelineId="p_1"
        params={[]}
        draft={() => draftDoc}
        onStarted={onStarted}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('maximum of 1');
    expect(onStarted).not.toHaveBeenCalled();
  });
});
