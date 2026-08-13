import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectionPublic } from '@autonomy-studio/shared';
import { ConnectionsPage } from './ConnectionsPage';
import * as api from '../api/connections';
import * as downloadApi from '../api/download';
import * as portabilityApi from '../api/portability';
import { renderWithRouter } from '../testing/renderWithRouter';

// Mock only the network calls; keep ConnectionWriteSchema real so the form's
// client-side validation is exercised exactly as it ships.
vi.mock('../api/connections', async (importActual) => {
  const actual = await importActual<typeof import('../api/connections')>();
  return {
    ...actual,
    listConnections: vi.fn(),
    createConnection: vi.fn(),
    updateConnection: vi.fn(),
    deleteConnection: vi.fn(),
  };
});

// The real `downloadTextFile` clicks an anchor, which jsdom follows on the NEXT
// TICK and then reports as an unimplemented-navigation error attributed to
// whichever test happens to be running by then. Its own behaviour is covered in
// `api/download.test.ts`; here only the fact that the page calls it, with what.
vi.mock('../api/download', async (importActual) => ({
  ...(await importActual<typeof import('../api/download')>()),
  downloadTextFile: vi.fn(),
}));
// Only the two network calls are mocked. `parseEnvelopeText`,
// `describeImported` and `describeAttention` stay REAL, so the import case
// below asserts the sentence the operator actually reads.
vi.mock('../api/portability', async (importActual) => ({
  ...(await importActual<typeof import('../api/portability')>()),
  exportConnection: vi.fn(),
  importEnvelope: vi.fn(),
}));

/** A promise this test resolves by hand, so a load can be held open across
 *  other interactions and answered out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const listMock = vi.mocked(api.listConnections);
const createMock = vi.mocked(api.createConnection);
const updateMock = vi.mocked(api.updateConnection);
const deleteMock = vi.mocked(api.deleteConnection);
const downloadMock = vi.mocked(downloadApi.downloadTextFile);
const exportMock = vi.mocked(portabilityApi.exportConnection);
const importMock = vi.mocked(portabilityApi.importEnvelope);

function conn(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
  return {
    id: 'conn_1',
    resourceId: 'res_conn1',
    ownerId: 'local',
    name: 'Claude',
    kind: 'anthropic_api',
    config: { model: 'claude-opus-4-8' },
    parameters: [],
    secretStatus: 'ready',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockResolvedValue([]);
  createMock.mockResolvedValue(conn());
  updateMock.mockResolvedValue(conn());
  deleteMock.mockResolvedValue(undefined);
  exportMock.mockResolvedValue('{"kind":"connection"}');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConnectionsPage', () => {
  it('shows the empty state after loading', async () => {
    renderWithRouter(<ConnectionsPage />);
    expect(await screen.findByText(/No connections yet/i)).toBeInTheDocument();
  });

  it('renders a connection row with its kind', async () => {
    listMock.mockResolvedValue([conn({ name: 'My Claude', kind: 'anthropic_api' })]);
    renderWithRouter(<ConnectionsPage />);
    expect(await screen.findByText('My Claude')).toBeInTheDocument();
    expect(screen.getByText('anthropic_api')).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    renderWithRouter(<ConnectionsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('creates a connection from the form', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText(/No connections yet/i);

    await user.click(screen.getByRole('button', { name: 'New connection' }));
    await user.type(screen.getByLabelText('Name'), 'Prod key');
    await user.selectOptions(screen.getByLabelText('Kind'), 'openai_api');
    const config = screen.getByLabelText('Config (JSON)');
    await user.clear(config);
    await user.type(config, '{{"model":"gpt-4o"}');
    await user.type(screen.getByLabelText('Secret'), 'sk-secret');

    // After a successful create, the list refetches and includes the new row.
    listMock.mockResolvedValue([conn({ name: 'Prod key', kind: 'openai_api' })]);
    await user.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: 'Prod key',
        kind: 'openai_api',
        config: { model: 'gpt-4o' },
        secret: 'sk-secret',
      }),
    );
    expect(await screen.findByText('Prod key')).toBeInTheDocument();
  });

  it('does not let the MOUNT load overwrite the list a create just refreshed', async () => {
    // #1062 — the New connection button is not gated behind the list having
    // arrived, so a create can complete while the initial load is still in
    // flight. Without a latest-wins guard the mount load lands second and
    // writes a list taken BEFORE the connection existed: the new row appears
    // and then silently vanishes.
    const user = userEvent.setup();
    const mountLoad = deferred<ConnectionPublic[]>();
    listMock.mockReturnValueOnce(mountLoad.promise);
    createMock.mockResolvedValue(conn({ name: 'Prod key' }));
    renderWithRouter(<ConnectionsPage />);

    // The mount load is held open; the form is reachable regardless.
    await user.click(screen.getByRole('button', { name: 'New connection' }));
    await user.type(screen.getByLabelText('Name'), 'Prod key');
    await user.type(screen.getByLabelText('Secret'), 'sk-secret');

    // The post-create refresh resolves FIRST, with the connection present.
    listMock.mockResolvedValue([conn({ name: 'Prod key' })]);
    await user.click(screen.getByRole('button', { name: 'Create connection' }));
    expect(await screen.findByText('Prod key')).toBeInTheDocument();

    // ...and only now does the stale mount load answer, with the empty list it
    // was always going to return.
    mountLoad.resolve([]);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));

    expect(screen.getByText('Prod key')).toBeInTheDocument();
    expect(screen.queryByText(/No connections yet/i)).not.toBeInTheDocument();
  });

  it('rejects invalid config JSON without calling the API', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText(/No connections yet/i);

    await user.click(screen.getByRole('button', { name: 'New connection' }));
    await user.type(screen.getByLabelText('Name'), 'Broken');
    const config = screen.getByLabelText('Config (JSON)');
    await user.clear(config);
    await user.type(config, 'not json');
    await user.click(screen.getByRole('button', { name: 'Create connection' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Invalid config JSON/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('edits a connection and leaves the secret blank by default', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([conn({ name: 'Editable' })]);
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText('Editable');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Connection form' });
    expect(within(form).getByLabelText('Name')).toHaveValue('Editable');
    // Secret is never prefilled — it is write-only.
    expect(within(form).getByLabelText('Secret')).toHaveValue('');

    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const [id, body] = updateMock.mock.calls[0]!;
    expect(id).toBe('conn_1');
    expect(body.name).toBe('Renamed');
    expect(body).not.toHaveProperty('secret'); // blank secret is omitted, not sent as ''
  });

  it('sends a rotated secret when one is typed on edit', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([conn({ name: 'Rotatable' })]);
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText('Rotatable');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Connection form' });
    await user.type(within(form).getByLabelText('Secret'), 'sk-new');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const [, body] = updateMock.mock.calls[0]!;
    expect(body.secret).toBe('sk-new');
  });

  it('threads an AbortSignal into the initial load', async () => {
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText(/No connections yet/i);
    expect(listMock).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('deletes a connection after confirmation', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([conn({ name: 'Doomed' })]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText('Doomed');

    await user.click(screen.getByRole('button', { name: 'Delete Doomed' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('conn_1'));
  });

  it('does not delete when confirmation is cancelled', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([conn({ name: 'Safe' })]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText('Safe');

    await user.click(screen.getByRole('button', { name: 'Delete Safe' }));
    expect(deleteMock).not.toHaveBeenCalled();
  });

  // #959 — the export half. The server has carried
  // `GET /api/connections/:id/export` since P1c with no web caller.
  it('exports a connection as the server bytes, under a name carrying its id', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([conn({ id: 'conn_9', name: 'My Claude' })]);
    exportMock.mockResolvedValue('{"kind":"connection","canonical":true}');
    renderWithRouter(<ConnectionsPage />);

    await user.click(await screen.findByRole('button', { name: 'Export My Claude' }));

    expect(exportMock).toHaveBeenCalledWith('conn_9');
    // The bytes go to disk UNCHANGED — an export body is canonical JSON, and
    // re-serializing it here would make this page a second authority on it.
    expect(downloadMock).toHaveBeenCalledWith(
      'connection-my-claude-conn_9.json',
      '{"kind":"connection","canonical":true}',
    );
  });

  it('reports a failed export instead of writing an error body to disk', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([conn({ name: 'My Claude' })]);
    exportMock.mockRejectedValue(new Error('connection not found'));
    renderWithRouter(<ConnectionsPage />);

    await user.click(await screen.findByRole('button', { name: 'Export My Claude' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Could not export .*My Claude.*connection not found/,
    );
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('offers the import surface, and refreshes the list when one lands here', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([]);
    renderWithRouter(<ConnectionsPage />);

    const picker = await screen.findByLabelText('Export file');
    // A connection envelope arriving on the connections list must repopulate
    // it — an imported row that only appears after a manual reload reads as an
    // import that did nothing.
    listMock.mockResolvedValue([conn({ name: 'Imported Claude' })]);
    importMock.mockResolvedValue({
      kind: 'connection',
      connection: conn({ id: 'conn_new', name: 'Imported Claude' }),
      // The honesty surface: an export never carries a secret, so the operator
      // is told the connection cannot call anything yet.
      attention: [{ type: 'requiresSecret' }],
    });

    await user.upload(
      picker,
      new File(['{"kind":"connection"}'], 'connection.json', { type: 'application/json' }),
    );

    await waitFor(() => expect(importMock).toHaveBeenCalled());
    // The ROW, not the panel's own sentence — both name the connection, so this
    // asks for the one only a refreshed list can produce.
    expect(
      await screen.findByRole('button', { name: 'Export Imported Claude' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/needs its secret/);
  });
});
