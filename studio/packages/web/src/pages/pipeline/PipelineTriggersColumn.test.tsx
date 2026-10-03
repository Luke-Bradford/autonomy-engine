import { createRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Pipeline,
  PipelineVersion,
  TriggerNextFire,
  TriggerPublic,
} from '@autonomy-studio/shared';
import { renderWithDataRouter } from '../../testing/renderWithRouter';
import * as triggersApi from '../../api/triggers';
import * as pipelinesApi from '../../api/pipelines';
import * as workspaceGitApi from '../../api/workspaceGit';
import { PipelineTriggersColumn } from './PipelineTriggersColumn';

vi.mock('../../api/triggers', async (importActual) => ({
  ...(await importActual<typeof import('../../api/triggers')>()),
  listTriggers: vi.fn(),
  listTriggerNextFires: vi.fn(),
  createTrigger: vi.fn(),
  updateTrigger: vi.fn(),
}));
vi.mock('../../api/pipelines', () => ({
  listAllPipelineVersions: vi.fn(),
  getActivePipelineVersion: vi.fn(),
}));
vi.mock('../../api/workspaceGit', () => ({ getWorkspaceGit: vi.fn() }));

const listTriggersMock = vi.mocked(triggersApi.listTriggers);
const nextFiresMock = vi.mocked(triggersApi.listTriggerNextFires);
const createMock = vi.mocked(triggersApi.createTrigger);
const listAllVersionsMock = vi.mocked(pipelinesApi.listAllPipelineVersions);

function trigger(overrides: Partial<TriggerPublic> = {}): TriggerPublic {
  return {
    id: 'trg_1',
    resourceId: 'res_trg1',
    ownerId: 'local',
    name: 'Nightly',
    pipelineVersionId: 'plv_1',
    params: {},
    mode: 'manual',
    schedule: null,
    webhook: null,
    event: null,
    window: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: null,
    recurrence: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function pipeline(id: string, name: string): Pipeline {
  return {
    id,
    resourceId: `res_${id}`,
    ownerId: 'local',
    name,
    concurrency: null,
    folder: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function version(id: string, pipelineId: string, n: number): PipelineVersion {
  return {
    id,
    resourceId: `res_${id}`,
    pipelineId,
    version: n,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    containers: [],
    variables: [],
    description: '',
    annotations: [],
    catalogVersion: 1,
    createdAt: 1,
    sourceCommit: null,
    sourceBranch: null,
    sourceFilePath: null,
    sourceBlobSha: null,
  };
}

beforeEach(() => {
  listAllVersionsMock.mockResolvedValue([
    { pipeline: pipeline('pl_1', 'Mine'), version: version('plv_1', 'pl_1', 3) },
    { pipeline: pipeline('pl_2', 'Other'), version: version('plv_9', 'pl_2', 1) },
  ]);
  listTriggersMock.mockResolvedValue([
    trigger(),
    trigger({ id: 'trg_2', name: 'Not mine', pipelineVersionId: 'plv_9' }),
  ]);
  nextFiresMock.mockResolvedValue([]);
  vi.mocked(workspaceGitApi.getWorkspaceGit).mockResolvedValue(null);
  vi.mocked(pipelinesApi.getActivePipelineVersion).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mount(props: Partial<Parameters<typeof PipelineTriggersColumn>[0]> = {}) {
  const onDirtyChange = vi.fn();
  const onClose = vi.fn();
  const view = renderWithDataRouter(
    <PipelineTriggersColumn
      pipelineId="pl_1"
      headId="plv_1"
      newBinding={{ kind: 'active', pipelineId: 'pl_1' }}
      newReason={null}
      newRequest={0}
      returnFocusTo={createRef<HTMLElement>()}
      onClose={onClose}
      onDirtyChange={onDirtyChange}
      {...props}
    />,
    '/pipelines/pl_1',
  );
  return { ...view, onDirtyChange, onClose };
}

describe('PipelineTriggersColumn (#1476 OR28 slice 3)', () => {
  it("lists only this pipeline's triggers, with mode, version and state", async () => {
    mount();
    const row = (await screen.findByText('Nightly')).closest('li')!;
    expect(within(row).getByText(/v3 · enabled/)).toBeInTheDocument();
    expect(screen.queryByText('Not mine')).not.toBeInTheDocument();
  });

  it('opens a new form already bound to this pipeline, and lists the trigger it creates', async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue(trigger({ id: 'trg_3', name: 'Hourly' }));
    mount({ newRequest: 1 });
    const form = within(await screen.findByRole('form', { name: /Trigger form/i }));
    await user.type(form.getByLabelText('Name'), 'Hourly');
    listTriggersMock.mockResolvedValue([trigger(), trigger({ id: 'trg_3', name: 'Hourly' })]);
    await user.click(form.getByRole('button', { name: /Create trigger/i }));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Hourly', bindToActive: { pipelineId: 'pl_1' } }),
    );
    expect(await screen.findByText('Hourly')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /Trigger form/i })).not.toBeInTheDocument();
  });

  it('reports a dirty form up, holds no route itself, and clears dirty when it goes', async () => {
    const user = userEvent.setup();
    const { onDirtyChange, router, unmount } = mount({ newRequest: 1 });
    const form = within(await screen.findByRole('form', { name: /Trigger form/i }));
    await user.type(form.getByLabelText('Name'), 'x');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // The editor's own leave guard holds route changes; this column must not.
    await act(() => router.navigate('/pipelines'));
    expect(router.state.location.pathname).toBe('/pipelines');

    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('asks before a dirty form is closed, and keeps it on Keep editing', async () => {
    const user = userEvent.setup();
    mount({ newRequest: 1 });
    const form = within(await screen.findByRole('form', { name: /Trigger form/i }));
    await user.type(form.getByLabelText('Name'), 'x');
    await user.click(form.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: /Keep editing/i }));
    expect(screen.getByRole('form', { name: /Trigger form/i })).toBeInTheDocument();
  });

  it('refuses New trigger with the reason, even with a binding to offer (archived)', async () => {
    mount({
      newReason: 'This pipeline is archived, so a trigger could not run it. Unarchive it first.',
    });
    const button = await screen.findByRole('button', { name: 'New trigger' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/archived/));
    await waitFor(() => expect(screen.getByText('Nightly')).toBeInTheDocument());
  });

  it('does not open a requested form while New trigger is refused', async () => {
    mount({ newRequest: 1, newReason: 'Wait for the pipeline to load.' });
    await screen.findByText('Nightly');
    expect(screen.queryByRole('form', { name: /Trigger form/i })).not.toBeInTheDocument();
  });

  it('opens a requested form only once the load has landed, so its pickers are filled', async () => {
    let answer!: (list: TriggerPublic[]) => void;
    listTriggersMock.mockReturnValueOnce(new Promise((res) => (answer = res)));
    mount({ newRequest: 1 });
    await waitFor(() => expect(listAllVersionsMock).toHaveBeenCalled());
    expect(screen.queryByRole('form', { name: /Trigger form/i })).not.toBeInTheDocument();
    act(() => answer([trigger()]));
    const form = within(await screen.findByRole('form', { name: /Trigger form/i }));
    expect(form.getByRole('option', { name: 'Mine' })).toBeInTheDocument();
  });

  it('reloads when the editor saves a new version, so its triggers are listed', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [head, setHead] = useState('plv_1');
      return (
        <>
          <button type="button" onClick={() => setHead('plv_2')}>
            save v4
          </button>
          <PipelineTriggersColumn
            pipelineId="pl_1"
            headId={head}
            newBinding={{ kind: 'active', pipelineId: 'pl_1' }}
            newReason={null}
            newRequest={0}
            returnFocusTo={createRef<HTMLElement>()}
            onClose={() => {}}
            onDirtyChange={() => {}}
          />
        </>
      );
    }
    renderWithDataRouter(<Harness />, '/pipelines/pl_1');
    await screen.findByText('Nightly');
    listAllVersionsMock.mockResolvedValue([
      { pipeline: pipeline('pl_1', 'Mine'), version: version('plv_1', 'pl_1', 3) },
      { pipeline: pipeline('pl_1', 'Mine'), version: version('plv_2', 'pl_1', 4) },
    ]);
    listTriggersMock.mockResolvedValue([
      trigger(),
      trigger({ id: 'trg_4', name: 'On v4', pipelineVersionId: 'plv_2' }),
    ]);
    await user.click(screen.getByRole('button', { name: 'save v4' }));
    const row = (await screen.findByText('On v4')).closest('li')!;
    expect(within(row).getByText(/v4 · enabled/)).toBeInTheDocument();
  });

  describe('next fire time (#1476 slice 4)', () => {
    const schedule = { mode: 'schedule' as const, schedule: '0 2 * * *' };
    const at = Date.now() + 3_600_000;

    it('says when a schedule trigger is next due', async () => {
      listTriggersMock.mockResolvedValue([trigger(schedule)]);
      nextFiresMock.mockResolvedValue([{ triggerId: 'trg_1', at, source: 'schedule' }]);
      mount();
      const row = (await screen.findByText('Nightly')).closest('li')!;
      await waitFor(() =>
        expect(row).toHaveTextContent(`enabled · next scheduled ${new Date(at).toLocaleString()}`),
      );
    });

    it('re-reads once the soonest shown time passes, and the row moves on', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const soon = Date.now() + 10_000;
        const later = soon + 3_600_000;
        listTriggersMock.mockResolvedValue([trigger(schedule)]);
        nextFiresMock
          .mockResolvedValueOnce([{ triggerId: 'trg_1', at: soon, source: 'schedule' }])
          .mockResolvedValue([{ triggerId: 'trg_1', at: later, source: 'schedule' }]);
        mount();
        const row = (await screen.findByText('Nightly')).closest('li')!;
        await waitFor(() => expect(row).toHaveTextContent(new Date(soon).toLocaleString()));
        await act(() => vi.advanceTimersByTimeAsync(16_000));
        await waitFor(() => expect(row).toHaveTextContent(new Date(later).toLocaleString()));
      } finally {
        vi.useRealTimers();
      }
    });

    it('a failed re-read drops the passed time and says why, rather than leaving it on screen', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const soon = Date.now() + 10_000;
        listTriggersMock.mockResolvedValue([trigger(schedule)]);
        nextFiresMock.mockResolvedValue([{ triggerId: 'trg_1', at: soon, source: 'schedule' }]);
        mount();
        const row = (await screen.findByText('Nightly')).closest('li')!;
        await waitFor(() => expect(row).toHaveTextContent('next scheduled'));
        listTriggersMock.mockRejectedValue(new Error('server gone'));
        await act(() => vi.advanceTimersByTimeAsync(16_000));
        expect(await screen.findByRole('alert')).toHaveTextContent('server gone');
        expect(row).not.toHaveTextContent(/next scheduled|due now/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a far-off time is waited for, never re-read at once (a timer that long would overflow)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const nextYear = Date.now() + 400 * 86_400_000;
        listTriggersMock.mockResolvedValue([trigger(schedule)]);
        nextFiresMock.mockResolvedValue([{ triggerId: 'trg_1', at: nextYear, source: 'schedule' }]);
        mount();
        const row = (await screen.findByText('Nightly')).closest('li')!;
        await waitFor(() => expect(row).toHaveTextContent('next scheduled'));
        await act(() => vi.advanceTimersByTimeAsync(60_000));
        expect(nextFiresMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    async function createHourly() {
      const user = userEvent.setup();
      const hourly = trigger({ id: 'trg_3', name: 'Hourly', ...schedule });
      createMock.mockResolvedValue(hourly);
      listTriggersMock.mockResolvedValue([trigger(schedule), hourly]);
      await user.click(screen.getByRole('button', { name: 'New trigger' }));
      await user.type(screen.getByLabelText('Name'), 'Hourly');
      await user.click(screen.getByRole('button', { name: 'Create trigger' }));
    }

    it('a just-saved trigger is never shown beside times read before its save', async () => {
      const at = Date.now() + 3_600_000;
      listTriggersMock.mockResolvedValue([trigger(schedule)]);
      nextFiresMock.mockResolvedValue([{ triggerId: 'trg_1', at, source: 'schedule' }]);
      mount();
      await screen.findByText('Nightly');
      let answer!: (v: TriggerNextFire[]) => void;
      nextFiresMock.mockReturnValueOnce(new Promise((res) => (answer = res)));
      await createHourly();
      await waitFor(() => expect(nextFiresMock).toHaveBeenCalledTimes(2));
      // The list waits for the times: no "nothing scheduled" for the new one.
      expect(screen.queryByText('Hourly')).not.toBeInTheDocument();
      answer([
        { triggerId: 'trg_1', at, source: 'schedule' },
        { triggerId: 'trg_3', at, source: 'schedule' },
      ]);
      const row = (await screen.findByText('Hourly')).closest('li')!;
      expect(row).toHaveTextContent('enabled · next scheduled');
    });

    it('a failed next-fire read leaves the list, and drops the times it can no longer vouch for', async () => {
      listTriggersMock.mockResolvedValue([trigger(schedule)]);
      nextFiresMock.mockResolvedValue([
        { triggerId: 'trg_1', at: Date.now() + 3_600_000, source: 'schedule' },
      ]);
      mount();
      const nightly = (await screen.findByText('Nightly')).closest('li')!;
      await waitFor(() => expect(nightly).toHaveTextContent('next scheduled'));
      nextFiresMock.mockRejectedValue(new Error('boom'));
      await createHourly();
      const hourly = (await screen.findByText('Hourly')).closest('li')!;
      // Not "nothing scheduled" either: an unknown is not shown as an absence.
      for (const row of [nightly, hourly]) {
        expect(row).toHaveTextContent('enabled');
        expect(row).not.toHaveTextContent(/next|nothing scheduled/);
      }
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
