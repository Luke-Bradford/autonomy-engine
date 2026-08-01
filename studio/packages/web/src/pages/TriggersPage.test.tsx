import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { renderWithRouter } from '../testing/renderWithRouter';
import userEvent from '@testing-library/user-event';
import type { Pipeline, PipelineVersion, TriggerPublic } from '@autonomy-studio/shared';
import { TriggersPage } from './TriggersPage';
import * as triggersApi from '../api/triggers';
import * as pipelinesApi from '../api/pipelines';
import * as runsApi from '../api/runs';
import { ROUTES } from '../routes';

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
// The navigation case below lands on the run detail page, which fetches the run
// and opens a WebSocket; stub both so only the routing is under test.
vi.mock('../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../api/runs')>()),
  getRun: vi.fn(),
  getRunEvents: vi.fn().mockResolvedValue([]),
  listRuns: vi.fn().mockResolvedValue([]),
}));
vi.mock('./runs/useRunStream', async (importActual) => ({
  ...(await importActual<typeof import('./runs/useRunStream')>()),
  useRunStream: vi.fn().mockReturnValue({ events: [], phase: 'connecting', error: undefined }),
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
    resourceId: 'res_trg1',
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
  resourceId: 'res_pl1',
  ownerId: 'local',
  name: 'My pipeline',
  concurrency: null,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};

const version: PipelineVersion = {
  id: 'plv_1',
  resourceId: 'res_plv1',
  pipelineId: 'pl_1',
  version: 3,
  params: [],
  outputs: [],
  nodes: [],
  edges: [],
  containers: [],
  catalogVersion: 1,
  createdAt: 1,
  sourceCommit: null,
  sourceBranch: null,
  sourceFilePath: null,
  sourceBlobSha: null,
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
    renderWithRouter(<TriggersPage />);
    expect(await screen.findByText(/No triggers yet/i)).toBeInTheDocument();
  });

  it('renders a trigger row with its binding label resolved from pipelines', async () => {
    listTriggersMock.mockResolvedValue([trigger({ name: 'Nightly' })]);
    renderWithRouter(<TriggersPage />);
    expect(await screen.findByText('Nightly')).toBeInTheDocument();
    // Binding label is `${pipeline.name} v${version}`, not the opaque id.
    expect(await screen.findByText('My pipeline v3')).toBeInTheDocument();
  });

  it('shows "unbound" for a trigger with no pipeline version', async () => {
    listTriggersMock.mockResolvedValue([
      trigger({ pipelineVersionId: null, enabled: false, mode: 'manual', schedule: null }),
    ]);
    renderWithRouter(<TriggersPage />);
    expect(await screen.findByText('unbound')).toBeInTheDocument();
  });

  it('fires a trigger and reports the started run id', async () => {
    const user = userEvent.setup();
    listTriggersMock.mockResolvedValue([trigger({ name: 'Nightly' })]);
    renderWithRouter(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /Fire Nightly now/i }));
    await waitFor(() => expect(fireMock).toHaveBeenCalledWith('trg_1'));
    expect(await screen.findByText(/started \(run run_9\)/i)).toBeInTheDocument();
  });

  it('reports a skipped fire with its reason', async () => {
    const user = userEvent.setup();
    fireMock.mockResolvedValue({ outcome: 'skipped', reason: 'a run is already active' });
    listTriggersMock.mockResolvedValue([trigger({ name: 'Nightly' })]);
    renderWithRouter(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /Fire Nightly now/i }));
    expect(await screen.findByText(/skipped — a run is already active/i)).toBeInTheDocument();
  });

  it('creates a schedule trigger from a raw cron, via the escape-hatch mode', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /New trigger/i }));

    const formEl = screen.getByRole('form', { name: /Trigger form/i });
    const form = within(formEl);
    await user.type(form.getByLabelText('Name'), 'Nightly');
    await user.selectOptions(form.getByLabelText('Pipeline version'), 'plv_1');
    await user.selectOptions(form.getByLabelText('Mode'), 'schedule');
    // #439 U14b — a new schedule trigger now opens on the RECURRENCE builder;
    // the raw cron is the deliberate escape hatch behind this toggle.
    await user.selectOptions(form.getByLabelText(/Schedule authored as/i), 'cron');
    await user.type(form.getByLabelText(/Schedule \(cron\)/i), '0 2 * * *');

    await user.click(form.getByRole('button', { name: /Create trigger/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const body = createMock.mock.calls[0]![0];
    expect(body.name).toBe('Nightly');
    expect(body.pipelineVersionId).toBe('plv_1');
    expect(body.mode).toBe('schedule');
    expect(body.schedule).toBe('0 2 * * *');
    // The unselected side must be an EXPLICIT null, not omitted: on a PATCH an
    // omitted `recurrence` means "untouched", which would leave a stale one in
    // place and be refused by `assertRecurrenceConsistent`.
    expect(body.recurrence).toBeNull();
  });

  it('creates a schedule trigger from the structured recurrence builder', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /New trigger/i }));

    const formEl = screen.getByRole('form', { name: /Trigger form/i });
    const form = within(formEl);
    await user.type(form.getByLabelText('Name'), 'Weekdays 9am London');
    await user.selectOptions(form.getByLabelText('Pipeline version'), 'plv_1');
    await user.selectOptions(form.getByLabelText('Mode'), 'schedule');
    await user.selectOptions(form.getByLabelText('Frequency'), 'week');
    await user.click(form.getByRole('checkbox', { name: 'Mon' }));
    await user.click(form.getByRole('checkbox', { name: 'Wed' }));
    await user.type(form.getByLabelText(/^Hours/i), '9');
    await user.type(form.getByLabelText(/Time zone/i), 'Europe/London');

    await user.click(form.getByRole('button', { name: /Create trigger/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const body = createMock.mock.calls[0]![0];
    expect(body.mode).toBe('schedule');
    expect(body.recurrence).toEqual({
      frequency: 'week',
      interval: 1,
      schedule: { hours: [9], weekDays: [1, 3] },
      timeZone: 'Europe/London',
    });
    // A recurrence DERIVES its cron server-side, so the client must not also
    // author one — the write boundary refuses a body carrying both.
    expect(body.schedule).toBeNull();
  });

  it('offers only the schedule sub-fields the chosen frequency honours', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /New trigger/i }));

    const form = within(screen.getByRole('form', { name: /Trigger form/i }));
    await user.selectOptions(form.getByLabelText('Mode'), 'schedule');

    // `day` honours minutes + hours, but not weekDays or monthDays.
    expect(form.queryByRole('checkbox', { name: 'Mon' })).not.toBeInTheDocument();
    expect(form.queryByLabelText(/Days of month/i)).not.toBeInTheDocument();
    expect(form.getByLabelText(/^Hours/i)).toBeInTheDocument();

    await user.selectOptions(form.getByLabelText('Frequency'), 'month');
    expect(form.getByLabelText(/Days of month/i)).toBeInTheDocument();
    expect(form.queryByRole('checkbox', { name: 'Mon' })).not.toBeInTheDocument();

    // `minute` honours nothing — a per-minute recurrence fires every minute.
    await user.selectOptions(form.getByLabelText('Frequency'), 'minute');
    expect(form.queryByLabelText(/^Hours/i)).not.toBeInTheDocument();
    expect(form.queryByLabelText(/^Minutes/i)).not.toBeInTheDocument();
  });

  it('forgets a selection the new frequency does not honour, and never submits it', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /New trigger/i }));

    const form = within(screen.getByRole('form', { name: /Trigger form/i }));
    await user.type(form.getByLabelText('Name'), 'Switched');
    await user.selectOptions(form.getByLabelText('Pipeline version'), 'plv_1');
    await user.selectOptions(form.getByLabelText('Mode'), 'schedule');
    await user.selectOptions(form.getByLabelText('Frequency'), 'week');
    await user.click(form.getByRole('checkbox', { name: 'Mon' }));

    // Switching to `day`, which does not honour weekDays. The selection must be
    // FORGOTTEN, not merely hidden: coming back to `week` shows it untouched.
    // (The submitted body below is guarded independently by `formToRecurrence`,
    // so asserting only the body would not distinguish "cleared" from "hidden".)
    await user.selectOptions(form.getByLabelText('Frequency'), 'day');
    await user.selectOptions(form.getByLabelText('Frequency'), 'week');
    expect(form.getByRole('checkbox', { name: 'Mon' })).not.toBeChecked();

    await user.selectOptions(form.getByLabelText('Frequency'), 'day');
    await user.type(form.getByLabelText(/^Hours/i), '9');
    await user.click(form.getByRole('button', { name: /Create trigger/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const body = createMock.mock.calls[0]![0];
    expect(body.recurrence).toEqual({
      frequency: 'day',
      interval: 1,
      schedule: { hours: [9] },
    });
  });

  it('reports an invalid recurrence instead of sending it', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /New trigger/i }));

    const form = within(screen.getByRole('form', { name: /Trigger form/i }));
    await user.type(form.getByLabelText('Name'), 'No day picked');
    await user.selectOptions(form.getByLabelText('Pipeline version'), 'plv_1');
    await user.selectOptions(form.getByLabelText('Mode'), 'schedule');
    // A weekly recurrence REQUIRES weekDays; none are ticked.
    await user.selectOptions(form.getByLabelText('Frequency'), 'week');

    await user.click(form.getByRole('button', { name: /Create trigger/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/recurrence/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('re-edits a recurrence trigger without re-authoring its derived cron', async () => {
    // The defect this closes: `formForEdit` used to load the DERIVED cron into
    // the raw-cron field, so any save of a recurrence-backed trigger authored
    // both a recurrence and a cron — which `assertRecurrenceConsistent` refuses
    // with a 400. A recurrence trigger could not be edited at all.
    const user = userEvent.setup();
    listTriggersMock.mockResolvedValue([
      trigger({
        name: 'Weekly',
        mode: 'schedule',
        schedule: '0 9 * * 1',
        recurrence: { frequency: 'week', interval: 1, schedule: { weekDays: [1], hours: [9] } },
      }),
    ]);
    renderWithRouter(<TriggersPage />);
    await user.click(await screen.findByRole('button', { name: /^Edit$/i }));

    const form = within(screen.getByRole('form', { name: /Trigger form/i }));
    // The builder round-trips the stored recurrence, and the raw-cron field is
    // not even on screen.
    expect(form.getByLabelText('Frequency')).toHaveValue('week');
    expect(form.getByRole('checkbox', { name: 'Mon' })).toBeChecked();
    expect(form.queryByLabelText(/Schedule \(cron\)/i)).not.toBeInTheDocument();

    await user.type(form.getByLabelText('Name'), ' nightly');
    await user.click(form.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const patch = updateMock.mock.calls[0]![1];
    expect(patch.schedule).toBeNull();
    expect(patch.recurrence).toEqual({
      frequency: 'week',
      interval: 1,
      schedule: { weekDays: [1], hours: [9] },
    });
  });

  it('blocks saving an enabled but unbound trigger with a friendly message', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TriggersPage />);
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
    renderWithRouter(<TriggersPage />);
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
    renderWithRouter(<TriggersPage />);
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
    renderWithRouter(<TriggersPage />);
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
    renderWithRouter(<TriggersPage />);
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
    renderWithRouter(<TriggersPage />);
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
    renderWithRouter(<TriggersPage />);
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

  /**
   * The one deep link U2 rewrote on this page (`/runs/:id` ->
   * `/monitor/runs/:id`), asserted against the app's REAL `ROUTES` so a moved
   * route fails here rather than silently sending "Watch live" nowhere. The
   * page previously had no coverage of this button at all, which made it the
   * only rewritten path in the ticket with nothing watching it.
   */
  it('"Watch live" after a fire lands on that run under the Monitor hub', async () => {
    const user = userEvent.setup();
    listTriggersMock.mockResolvedValue([trigger({ name: 'Nightly' })]);
    fireMock.mockResolvedValue({ outcome: 'started', runId: 'run_9' });
    vi.mocked(runsApi.getRun).mockResolvedValue({ id: 'run_9' } as never);

    const router = createMemoryRouter(ROUTES, { initialEntries: ['/manage/triggers'] });
    render(<RouterProvider router={router} />);

    await user.click(await screen.findByRole('button', { name: /Fire Nightly now/i }));
    await user.click(await screen.findByRole('button', { name: /Watch live/i }));

    expect(router.state.location.pathname).toBe('/monitor/runs/run_9');
    expect(await screen.findByRole('heading', { name: /run_9/ })).toBeInTheDocument();
  });
});
