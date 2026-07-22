import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Pipeline, PipelineVersion, TriggerPublic } from '@autonomy-studio/shared';
import { TriggersPage } from './TriggersPage';
import * as triggersApi from '../api/triggers';
import * as pipelinesApi from '../api/pipelines';

// Mock only the network layers; keep TriggerWriteSchema real so the form's
// client-side validation is exercised exactly as it ships.
vi.mock('../api/triggers', async (importActual) => {
  const actual = await importActual<typeof import('../api/triggers')>();
  return {
    ...actual,
    listTriggers: vi.fn(),
    createTrigger: vi.fn(),
    updateTrigger: vi.fn(),
    deleteTrigger: vi.fn(),
    fireTrigger: vi.fn(),
    provisionWebhookSecret: vi.fn(),
  };
});
vi.mock('../api/pipelines', () => ({
  listPipelines: vi.fn(),
  listPipelineVersions: vi.fn(),
}));

const listTriggersMock = vi.mocked(triggersApi.listTriggers);
const createMock = vi.mocked(triggersApi.createTrigger);
const updateMock = vi.mocked(triggersApi.updateTrigger);
const deleteMock = vi.mocked(triggersApi.deleteTrigger);
const fireMock = vi.mocked(triggersApi.fireTrigger);
const provisionMock = vi.mocked(triggersApi.provisionWebhookSecret);
const listPipelinesMock = vi.mocked(pipelinesApi.listPipelines);
const listVersionsMock = vi.mocked(pipelinesApi.listPipelineVersions);

function trigger(overrides: Partial<TriggerPublic> = {}): TriggerPublic {
  return {
    id: 'trg_1',
    ownerId: 'local',
    name: 'Nightly',
    pipelineVersionId: 'plv_1',
    params: {},
    mode: 'schedule',
    schedule: '0 2 * * *',
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

const pipeline: Pipeline = {
  id: 'pl_1',
  ownerId: 'local',
  name: 'My pipeline',
  concurrency: null,
  createdAt: 1,
  updatedAt: 1,
};

const version: PipelineVersion = {
  id: 'plv_1',
  pipelineId: 'pl_1',
  version: 3,
  params: [],
  outputs: [],
  nodes: [],
  edges: [],
  containers: [],
  catalogVersion: 1,
  createdAt: 1,
};

beforeEach(() => {
  listTriggersMock.mockResolvedValue([]);
  createMock.mockResolvedValue(trigger());
  updateMock.mockResolvedValue(trigger());
  deleteMock.mockResolvedValue(undefined);
  fireMock.mockResolvedValue({ outcome: 'started', runId: 'run_9' });
  provisionMock.mockResolvedValue({ secret: 'sk_abc', deliveryUrl: '/api/webhooks/trg_1' });
  listPipelinesMock.mockResolvedValue([pipeline]);
  listVersionsMock.mockResolvedValue([version]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TriggersPage', () => {
  it('shows the empty state after loading', async () => {
    render(<TriggersPage />);
    expect(await screen.findByText(/No triggers yet/i)).toBeInTheDocument();
  });

  it('renders a trigger row with its binding label resolved from pipelines', async () => {
    listTriggersMock.mockResolvedValue([trigger({ name: 'Nightly' })]);
    render(<TriggersPage />);
    expect(await screen.findByText('Nightly')).toBeInTheDocument();
    // Binding label is `${pipeline.name} v${version}`, not the opaque id.
    expect(await screen.findByText('My pipeline v3')).toBeInTheDocument();
  });

  it('shows "unbound" for a trigger with no pipeline version', async () => {
    listTriggersMock.mockResolvedValue([
      trigger({ pipelineVersionId: null, enabled: false, mode: 'manual', schedule: null }),
    ]);
    render(<TriggersPage />);
    expect(await screen.findByText('unbound')).toBeInTheDocument();
  });

  it('fires a trigger and reports the started run id', async () => {
    const user = userEvent.setup();
    listTriggersMock.mockResolvedValue([trigger({ name: 'Nightly' })]);
    render(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /Fire Nightly now/i }));
    await waitFor(() => expect(fireMock).toHaveBeenCalledWith('trg_1'));
    expect(await screen.findByText(/started \(run run_9\)/i)).toBeInTheDocument();
  });

  it('reports a skipped fire with its reason', async () => {
    const user = userEvent.setup();
    fireMock.mockResolvedValue({ outcome: 'skipped', reason: 'a run is already active' });
    listTriggersMock.mockResolvedValue([trigger({ name: 'Nightly' })]);
    render(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /Fire Nightly now/i }));
    expect(await screen.findByText(/skipped — a run is already active/i)).toBeInTheDocument();
  });

  it('creates a schedule trigger bound to a pipeline version', async () => {
    const user = userEvent.setup();
    render(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /New trigger/i }));

    const formEl = screen.getByRole('form', { name: /Trigger form/i });
    const form = within(formEl);
    await user.type(form.getByLabelText('Name'), 'Nightly');
    await user.selectOptions(form.getByLabelText('Pipeline version'), 'plv_1');
    await user.selectOptions(form.getByLabelText('Mode'), 'schedule');
    await user.type(form.getByLabelText(/Schedule/i), '0 2 * * *');

    await user.click(form.getByRole('button', { name: /Create trigger/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const body = createMock.mock.calls[0]![0];
    expect(body.name).toBe('Nightly');
    expect(body.pipelineVersionId).toBe('plv_1');
    expect(body.mode).toBe('schedule');
    expect(body.schedule).toBe('0 2 * * *');
  });

  it('blocks saving an enabled but unbound trigger with a friendly message', async () => {
    const user = userEvent.setup();
    render(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /New trigger/i }));
    const form = within(screen.getByRole('form', { name: /Trigger form/i }));
    await user.type(form.getByLabelText('Name'), 'Oops');
    // Leave the binding as "— unbound —" and tick Enabled.
    await user.click(form.getByLabelText(/Enabled/i));
    await user.click(form.getByRole('button', { name: /Create trigger/i }));

    // Assert on the alert (the hint paragraph carries similar wording).
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /must be bound to a pipeline version/i,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('builds a `parallel` concurrency object with the entered max', async () => {
    // The Max input (required, min=1) only appears for `parallel`, so the form
    // can only ever emit a well-formed concurrency object — the shared
    // `ConcurrencyWriteSchema` (parallel⇒max, single-slot⇒no-max) is honoured
    // by construction. This asserts that construction is correct.
    const user = userEvent.setup();
    render(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /New trigger/i }));
    const form = within(screen.getByRole('form', { name: /Trigger form/i }));
    await user.type(form.getByLabelText('Name'), 'Fan out');
    await user.selectOptions(form.getByLabelText('Pipeline version'), 'plv_1');
    await user.selectOptions(form.getByLabelText('Concurrency'), 'parallel');
    await user.type(form.getByLabelText(/Max parallel runs/i), '3');
    await user.click(form.getByRole('button', { name: /Create trigger/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0]![0].concurrency).toEqual({ policy: 'parallel', max: 3 });
  });

  it('emits a single-slot concurrency object with no `max`', async () => {
    const user = userEvent.setup();
    render(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /New trigger/i }));
    const form = within(screen.getByRole('form', { name: /Trigger form/i }));
    await user.type(form.getByLabelText('Name'), 'One at a time');
    await user.selectOptions(form.getByLabelText('Pipeline version'), 'plv_1');
    await user.selectOptions(form.getByLabelText('Concurrency'), 'queue');
    await user.click(form.getByRole('button', { name: /Create trigger/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0]![0].concurrency).toEqual({ policy: 'queue' });
  });

  it('provisions a webhook secret and reveals it once', async () => {
    const user = userEvent.setup();
    listTriggersMock.mockResolvedValue([
      // Already provisioned: the server-shaped webhook config has NO secretRef
      // (stripped by TriggerPublic). Exercises the list-load parse of a
      // non-null webhook config, the path that regressed.
      trigger({
        name: 'Hook',
        mode: 'webhook',
        schedule: null,
        webhook: { idempotencyWindowSeconds: 300 },
      }),
    ]);
    render(<TriggersPage />);
    await user.click(
      await screen.findByRole('button', { name: /Provision webhook secret for Hook/i }),
    );
    await waitFor(() => expect(provisionMock).toHaveBeenCalledWith('trg_1'));
    expect(await screen.findByText('sk_abc')).toBeInTheDocument();
    expect(screen.getByText('/api/webhooks/trg_1')).toBeInTheDocument();
  });

  it('omits `webhook` when editing a trigger that STAYS a webhook, preserving its secret', async () => {
    const user = userEvent.setup();
    listTriggersMock.mockResolvedValue([
      trigger({ name: 'Hook', mode: 'webhook', schedule: null, webhook: { foo: 1 } }),
    ]);
    render(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /^Edit$/i }));
    const form = within(screen.getByRole('form', { name: /Trigger form/i }));
    await user.click(form.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const [, patch] = updateMock.mock.calls[0]!;
    // PATCH is partial; omitting `webhook` leaves the stored secret intact.
    expect(patch).not.toHaveProperty('webhook');
  });

  it('clears `webhook` when editing a trigger AWAY from webhook mode (no stale secret)', async () => {
    const user = userEvent.setup();
    listTriggersMock.mockResolvedValue([
      trigger({ name: 'Hook', mode: 'webhook', schedule: null, webhook: { foo: 1 } }),
    ]);
    render(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /^Edit$/i }));
    const form = within(screen.getByRole('form', { name: /Trigger form/i }));
    // Switch away from webhook — the stored secret must be actively cleared.
    await user.selectOptions(form.getByLabelText('Mode'), 'manual');
    await user.click(form.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const [, patch] = updateMock.mock.calls[0]!;
    expect(patch).toHaveProperty('webhook', null);
  });

  it('guards "Fire now" against a double-click while a fire is in flight', async () => {
    const user = userEvent.setup();
    // Hold the fire pending so a second click can race the first.
    let resolveFire!: (v: { outcome: 'started'; runId: string }) => void;
    fireMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFire = resolve;
      }),
    );
    listTriggersMock.mockResolvedValue([trigger({ name: 'Nightly' })]);
    render(<TriggersPage />);
    const fireBtn = await screen.findByRole('button', { name: /Fire Nightly now/i });
    await user.click(fireBtn);
    // Button reflects the in-flight state and is disabled.
    expect(fireBtn).toBeDisabled();
    expect(fireBtn).toHaveTextContent(/Firing/i);
    await user.click(fireBtn);
    expect(fireMock).toHaveBeenCalledTimes(1);

    resolveFire({ outcome: 'started', runId: 'run_9' });
    await waitFor(() => expect(fireBtn).not.toBeDisabled());
  });
});
