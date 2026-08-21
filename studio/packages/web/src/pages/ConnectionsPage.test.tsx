import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectionPublic, Dataset } from '@autonomy-studio/shared';
import { ConnectionsPage } from './ConnectionsPage';
import * as api from '../api/connections';
import * as datasetsApi from '../api/datasets';
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
    testDraftConnection: vi.fn(),
    testSavedConnection: vi.fn(),
  };
});

// #1174 — the page reads the dataset list to say what an edit would strand.
// Mocked to the EMPTY list rather than left to reject: an unmocked module here
// reaches the real `fetch` under jsdom, and the page would then correctly render
// "could not check" in every unrelated test (#1206). An empty list is a page
// that MADE the check and found nothing, which is the state the rest of this
// file means to assert against.
vi.mock('../api/datasets', async (importActual) => ({
  ...(await importActual<typeof import('../api/datasets')>()),
  listDatasets: vi.fn(),
}));

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
const testDraftMock = vi.mocked(api.testDraftConnection);
const testSavedMock = vi.mocked(api.testSavedConnection);
const listDatasetsMock = vi.mocked(datasetsApi.listDatasets);
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
  listDatasetsMock.mockResolvedValue([]);
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
    // #1087 — the kind's OWN field, not a JSON blob the author had to know.
    await user.type(screen.getByLabelText('model (optional)'), 'gpt-4o');
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
    // #1087 — the JSON editor is now the escape hatch behind a toggle, so this
    // reaches it the way an operator does. The rule it guards is unchanged.
    await user.click(screen.getByRole('button', { name: 'Edit as JSON' }));
    const config = screen.getByLabelText('Config (JSON)');
    await user.clear(config);
    await user.type(config, 'not json');
    await user.click(screen.getByRole('button', { name: 'Create connection' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Invalid config JSON/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("renders the SELECTED kind's fields, and swaps them when the kind changes", async () => {
    const user = userEvent.setup();
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText(/No connections yet/i);

    await user.click(screen.getByRole('button', { name: 'New connection' }));
    // `anthropic_api` (the first kind) declares the LLM trio plus its own
    // version header; `fs` declares none of them and requires `roots`.
    expect(screen.getByLabelText('anthropicVersion (optional)')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^roots/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Kind'), 'fs');
    // The one-per-line control labels itself `roots — one per line`.
    expect(screen.getByLabelText(/^roots/)).toBeInTheDocument();
    expect(screen.queryByLabelText('anthropicVersion (optional)')).not.toBeInTheDocument();
  });

  it('keeps what was typed when the kind changes', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText(/No connections yet/i);

    await user.click(screen.getByRole('button', { name: 'New connection' }));
    // `model` is declared by anthropic_api AND ollama, so it survives the switch
    // as the same field — a re-seed would blank it.
    await user.type(screen.getByLabelText('model (optional)'), 'claude-opus-5');
    await user.selectOptions(screen.getByLabelText('Kind'), 'ollama');

    expect(screen.getByLabelText('model (optional)')).toHaveValue('claude-opus-5');
  });

  it('carries a field the fields draft holds across the JSON toggle', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText(/No connections yet/i);

    await user.click(screen.getByRole('button', { name: 'New connection' }));
    await user.type(screen.getByLabelText('model (optional)'), 'claude-opus-5');
    // The JSON editor must open on what SAVE would write, not on the config the
    // form mounted with — otherwise the toggle silently discards the edit.
    await user.click(screen.getByRole('button', { name: 'Edit as JSON' }));

    expect(screen.getByLabelText('Config (JSON)')).toHaveValue(
      JSON.stringify({ model: 'claude-opus-5' }, null, 2),
    );
  });

  it('keeps a config key no kind declares through a field-mode save', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([
      conn({ name: 'Legacy', config: { model: 'claude-opus-4-8', somethingOld: 'keep me' } }),
    ]);
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText('Legacy');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Connection form' });
    await user.clear(within(form).getByLabelText('model (optional)'));
    await user.type(within(form).getByLabelText('model (optional)'), 'claude-opus-5');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const [, body] = updateMock.mock.calls[0]!;
    // A key the form cannot see must never be deleted by an edit to another one.
    expect(body.config).toEqual({ model: 'claude-opus-5', somethingOld: 'keep me' });
  });

  it('renders a key another kind owns as a CARRIED field, so it can be dropped', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([
      conn({ name: 'Switched', kind: 'fs', config: { roots: ['/tmp'], model: 'left over' } }),
    ]);
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText('Switched');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Connection form' });
    expect(within(form).getByText(/Carried from another kind \(model\)/)).toBeInTheDocument();

    // Blanking the carried control is the repair — it OMITS the key.
    await user.clear(within(form).getByLabelText('model (optional)'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const [, body] = updateMock.mock.calls[0]!;
    expect(body.config).toEqual({ roots: ['/tmp'] });
  });

  it('falls back to JSON for a stored value no control can represent', async () => {
    listMock.mockResolvedValue([conn({ name: 'Odd', config: { model: 42 } })]);
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText('Odd');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Connection form' });
    expect(within(form).getByText(/Saved settings this form cannot show \(model\)/)).toBeVisible();
    expect(within(form).getByLabelText('Config (JSON)')).toBeInTheDocument();
    expect(within(form).queryByLabelText('model (optional)')).not.toBeInTheDocument();
  });

  it('says what a kind does with a secret, and never demands one', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText(/No connections yet/i);

    await user.click(screen.getByRole('button', { name: 'New connection' }));
    const form = screen.getByRole('form', { name: 'Connection form' });
    // anthropic_api REQUIRES one (SECRET_REQUIRING_CONNECTION_KINDS)...
    expect(within(form).getByText(/cannot dispatch without a secret/)).toBeInTheDocument();
    // ...but the input is never `required`: a secretless row is one the server
    // accepts, and on edit blank means "keep the stored secret".
    expect(within(form).getByLabelText('Secret')).not.toBeRequired();

    // `fs` needs none at all, and says so rather than saying "optional".
    await user.selectOptions(within(form).getByLabelText('Kind'), 'fs');
    expect(within(form).getByText(/credential-less/)).toBeInTheDocument();
    expect(within(form).queryByText(/cannot dispatch without a secret/)).not.toBeInTheDocument();
  });

  it('says a config is incomplete without refusing to save it', async () => {
    const user = userEvent.setup();
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText(/No connections yet/i);

    await user.click(screen.getByRole('button', { name: 'New connection' }));
    await user.type(screen.getByLabelText('Name'), 'Empty agent');
    await user.selectOptions(screen.getByLabelText('Kind'), 'agent_cli');
    // `command` is REQUIRED by the adapter and absent here.
    expect(await screen.findByText(/This agent_cli config is incomplete/)).toBeInTheDocument();

    // Advisory, not a gate: the server stores this today, so the form must too.
    await user.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  });

  it('still says a config is wrong for the kind when the JSON editor is open', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([conn({ name: 'Fs one', kind: 'fs', config: { roots: ['/tmp'] } })]);
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText('Fs one');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Connection form' });
    await user.click(within(form).getByRole('button', { name: 'Edit as JSON' }));

    // The Kind select is reachable in JSON mode, and switching it does NOT
    // rewrite the operator's JSON — so without an advisory here, an fs-shaped
    // config saves as an agent_cli with nothing on screen to say so.
    await user.selectOptions(within(form).getByLabelText('Kind'), 'agent_cli');
    expect(within(form).getByText(/This agent_cli config is incomplete/)).toBeInTheDocument();
    // Still not a gate — the server stores this today.
    expect(within(form).getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('warns about a RELATIVE fs root, which the shared schema does not refuse', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([
      conn({ name: 'Fs rel', kind: 'fs', config: { roots: ['relative/path'] } }),
    ]);
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText('Fs rel');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Connection form' });
    // The absolute-root check is the SERVER's (`node:path`), so a schema-only
    // advisory would say nothing about the one path-safety key in the catalog.
    expect(within(form).getByText(/every fs root must be an absolute path/)).toBeInTheDocument();
    // Still advisory: the server stores this row today.
    expect(within(form).getByRole('button', { name: 'Save changes' })).toBeEnabled();
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

  it('threads an AbortSignal into EVERY load, the post-mutation refresh included', async () => {
    // Both load paths share the mount controller (#1062), so a refresh left in
    // flight when the operator navigates away is abortable too — it is not only
    // the initial load that is.
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValue([conn({ name: 'Doomed' })]);
    renderWithRouter(<ConnectionsPage />);
    await screen.findByText('Doomed');
    expect(listMock).toHaveBeenCalledWith(expect.any(AbortSignal));

    await user.click(screen.getByRole('button', { name: 'Delete Doomed' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(listMock.mock.calls[1]![0]).toEqual(expect.any(AbortSignal));
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

  /**
   * #1191 — "Test connection". The routing rule is the load-bearing part: an
   * unsaved form has no stored secret to fall back on, an edited one does, and
   * sending an edit down the draft path would report a confident credential
   * failure for every connection that keeps its secret blank.
   */
  describe('Test connection', () => {
    it('probes an UNSAVED form through the draft endpoint', async () => {
      const user = userEvent.setup();
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText(/No connections yet/i);

      await user.click(screen.getByRole('button', { name: 'New connection' }));
      await user.type(screen.getByLabelText('Name'), 'New fs');
      await user.selectOptions(screen.getByLabelText('Kind'), 'fs');
      await user.type(screen.getByLabelText(/^roots/), '/srv/data');

      testDraftMock.mockResolvedValue({ ok: true, probed: 'liveness' });
      await user.click(screen.getByRole('button', { name: 'Test connection' }));

      await waitFor(() =>
        expect(testDraftMock).toHaveBeenCalledWith({
          kind: 'fs',
          config: { roots: ['/srv/data'] },
        }),
      );
      expect(testSavedMock).not.toHaveBeenCalled();
      expect(await screen.findByRole('status')).toHaveTextContent('Connected.');
    });

    it('probes an EDITED connection through the saved endpoint, secret omitted', async () => {
      // The blank secret box means "keep the stored one", so the body must NOT
      // carry a secret — the server resolving the stored ciphertext is the
      // whole reason this path exists.
      const user = userEvent.setup();
      listMock.mockResolvedValue([conn({ name: 'Claude', kind: 'anthropic_api' })]);
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText('Claude');

      await user.click(screen.getByRole('button', { name: 'Edit' }));
      testSavedMock.mockResolvedValue({ ok: true, probed: 'liveness' });
      await user.click(screen.getByRole('button', { name: 'Test connection' }));

      await waitFor(() =>
        expect(testSavedMock).toHaveBeenCalledWith('conn_1', {
          config: { model: 'claude-opus-4-8' },
        }),
      );
      expect(testDraftMock).not.toHaveBeenCalled();
    });

    it('sends a TYPED secret with an edit, rather than the stored one', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([conn({ name: 'Claude', kind: 'anthropic_api' })]);
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText('Claude');

      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await user.type(screen.getByLabelText('Secret'), 'sk-new');
      testSavedMock.mockResolvedValue({ ok: true, probed: 'liveness' });
      await user.click(screen.getByRole('button', { name: 'Test connection' }));

      await waitFor(() =>
        expect(testSavedMock).toHaveBeenCalledWith('conn_1', {
          config: { model: 'claude-opus-4-8' },
          secret: 'sk-new',
        }),
      );
    });

    it('says a config-only probe reached nothing, rather than claiming it works', async () => {
      const user = userEvent.setup();
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText(/No connections yet/i);

      await user.click(screen.getByRole('button', { name: 'New connection' }));
      await user.selectOptions(screen.getByLabelText('Kind'), 'agent_cli');

      testDraftMock.mockResolvedValue({ ok: true, probed: 'config' });
      await user.click(screen.getByRole('button', { name: 'Test connection' }));

      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent(/not contacted until it runs/);
      expect(status).not.toHaveTextContent('Connected.');
    });

    it('shows the adapter’s refusal sentence', async () => {
      const user = userEvent.setup();
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText(/No connections yet/i);

      await user.click(screen.getByRole('button', { name: 'New connection' }));
      await user.selectOptions(screen.getByLabelText('Kind'), 'fs');
      await user.type(screen.getByLabelText(/^roots/), '/srv/data');

      testDraftMock.mockResolvedValue({ ok: false, error: 'root not accessible: /srv/data' });
      await user.click(screen.getByRole('button', { name: 'Test connection' }));

      expect(await screen.findByRole('status')).toHaveTextContent('root not accessible: /srv/data');
    });

    it('drops a verdict once the draft it was taken against has changed', async () => {
      // A green result about a host the operator has since edited is a lie with
      // a timestamp. It must stop rendering, not linger.
      const user = userEvent.setup();
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText(/No connections yet/i);

      await user.click(screen.getByRole('button', { name: 'New connection' }));
      await user.selectOptions(screen.getByLabelText('Kind'), 'fs');
      await user.type(screen.getByLabelText(/^roots/), '/srv/data');

      testDraftMock.mockResolvedValue({ ok: true, probed: 'liveness' });
      await user.click(screen.getByRole('button', { name: 'Test connection' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Connected.');

      await user.type(screen.getByLabelText(/^roots/), '-elsewhere');
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    });

    it('does not carry a verdict across to a DIFFERENT connection', async () => {
      // The table stays interactive while the form is open, so "Edit" on
      // another row swaps the form in place. Two connections with identical
      // non-secret config (a staging/prod pair, or an export/import clone)
      // produce an identical draft, so a draft-only signature would happily
      // show the first one's "Connected." for a second that was never probed.
      const user = userEvent.setup();
      listMock.mockResolvedValue([
        conn({ id: 'conn_a', name: 'Staging', config: { model: 'claude-opus-4-8' } }),
        conn({ id: 'conn_b', name: 'Prod', config: { model: 'claude-opus-4-8' } }),
      ]);
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText('Staging');

      const rows = screen.getAllByRole('button', { name: 'Edit' });
      await user.click(rows[0]!);
      testSavedMock.mockResolvedValue({ ok: true, probed: 'liveness' });
      await user.click(screen.getByRole('button', { name: 'Test connection' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Connected.');

      // Switch to the OTHER connection without closing the form.
      await user.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    });

    it('does not carry a verdict into a SECOND new-connection form', async () => {
      // "New connection" is not gated behind the form being closed, so it can be
      // pressed with a new-connection form already open. `form.id` is `null`
      // both times, so keying the form on `id` did not remount it — and
      // `blankForm()` is byte-identical each time, so the draft SIGNATURE
      // matched too, and the first draft's "Connected." rendered against a form
      // nothing had tested.
      //
      // The draft is therefore left PRISTINE here, which is the whole point:
      // the moment a field is touched the signature diverges on its own and the
      // verdict hides for reasons that have nothing to do with the remount. It
      // is the untouched blank form — the one case where both guards agree on
      // the wrong answer — that needs the open COUNTER.
      const user = userEvent.setup();
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText(/No connections yet/i);

      await user.click(screen.getByRole('button', { name: 'New connection' }));
      testDraftMock.mockResolvedValue({ ok: true, probed: 'liveness' });
      await user.click(screen.getByRole('button', { name: 'Test connection' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Connected.');

      // Start over. The new form is blank and untested — it must say nothing.
      await user.click(screen.getByRole('button', { name: 'New connection' }));
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    });

    it('never SAVES when testing', async () => {
      const user = userEvent.setup();
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText(/No connections yet/i);

      await user.click(screen.getByRole('button', { name: 'New connection' }));
      await user.type(screen.getByLabelText('Name'), 'Prod');
      await user.selectOptions(screen.getByLabelText('Kind'), 'fs');
      await user.type(screen.getByLabelText(/^roots/), '/srv/data');

      testDraftMock.mockResolvedValue({ ok: true, probed: 'liveness' });
      await user.click(screen.getByRole('button', { name: 'Test connection' }));

      await waitFor(() => expect(testDraftMock).toHaveBeenCalled());
      expect(createMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });
  });
  describe('#1174 an edit says what it would strand', () => {
    const store = conn({ id: 'conn_store', name: 'Local store', kind: 'sqlite', config: {} });

    function ds(name: string, kind: Dataset['kind'], connectionId: string): Dataset {
      return {
        id: `ds_${name}`,
        resourceId: `res_${name}`,
        ownerId: 'local',
        name,
        kind,
        connectionId,
        config: {},
        columns: [],
        parameters: [],
        createdAt: 1,
        updatedAt: 1,
      };
    }

    async function openEdit() {
      const user = userEvent.setup();
      listMock.mockResolvedValue([store]);
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText('Local store');
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      return { user, form: screen.getByRole('form', { name: 'Connection form' }) };
    }

    it('names the datasets a kind change would strand, before any save', async () => {
      listDatasetsMock.mockResolvedValue([
        ds('orders', 'table', 'conn_store'),
        ds('customers', 'table', 'conn_store'),
      ]);
      const { user, form } = await openEdit();
      await waitFor(() => expect(listDatasetsMock).toHaveBeenCalled());

      await user.selectOptions(within(form).getByLabelText('Kind'), 'http');

      const note = await within(form).findByText(/strands 2 datasets that read it/);
      expect(note).toHaveTextContent('orders, customers');
      // ADVISORY, never a gate — #1145/#1158's polarity, restated here so a
      // future change that disables Save has to delete this line to do it.
      expect(within(form).getByRole('button', { name: 'Save changes' })).toBeEnabled();
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('stays silent while the kind has not moved', async () => {
      listDatasetsMock.mockResolvedValue([ds('orders', 'table', 'conn_store')]);
      const { form } = await openEdit();
      await waitFor(() => expect(listDatasetsMock).toHaveBeenCalled());
      expect(within(form).queryByText(/strands/)).not.toBeInTheDocument();
    });

    it('says nothing about a dataset the change REPAIRS', async () => {
      // `delimited` lives on `fs`, so it disagrees with this sqlite store today
      // and AGREES after the change. Warning here would fire on the fix.
      listDatasetsMock.mockResolvedValue([ds('feed', 'delimited', 'conn_store')]);
      const { user, form } = await openEdit();
      await waitFor(() => expect(listDatasetsMock).toHaveBeenCalled());

      await user.selectOptions(within(form).getByLabelText('Kind'), 'fs');
      expect(within(form).queryByText(/strands/)).not.toBeInTheDocument();
    });

    it('admits it could not check, rather than claiming nothing is stranded', async () => {
      // The failure this whole three-state shape exists for: a page that renders
      // a clean bill of health off a fetch that never answered.
      listDatasetsMock.mockRejectedValue(new Error('datasets offline'));
      const { user, form } = await openEdit();

      await user.selectOptions(within(form).getByLabelText('Kind'), 'http');

      expect(await within(form).findByText(/Could not check/)).toHaveTextContent(
        'datasets offline',
      );
      // And the advisory's failure is LOCAL — the connections list is not an
      // error banner because a diagnostic could not be computed.
      expect(screen.getByText('Local store')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('names the stranded datasets in the delete confirmation', async () => {
      const user = userEvent.setup();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      listDatasetsMock.mockResolvedValue([
        ds('orders', 'table', 'conn_store'),
        // A dataset on ANOTHER connection must not be counted.
        ds('elsewhere', 'table', 'conn_other'),
      ]);
      listMock.mockResolvedValue([store]);
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText('Local store');

      await user.click(screen.getByRole('button', { name: 'Delete Local store' }));

      await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
      const said = confirmSpy.mock.calls[0]?.[0] ?? '';
      expect(said).toContain('1 dataset reads it');
      expect(said).toContain('orders');
      expect(said).not.toContain('elsewhere');
      // Declined — and the row is still there, which is what makes the confirm
      // a real gate on the operator's decision rather than a notice.
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('warns the delete check failed rather than asking the bare question', async () => {
      const user = userEvent.setup();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      listDatasetsMock.mockRejectedValue(new Error('datasets offline'));
      listMock.mockResolvedValue([store]);
      renderWithRouter(<ConnectionsPage />);
      await screen.findByText('Local store');

      await user.click(screen.getByRole('button', { name: 'Delete Local store' }));

      await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
      expect(confirmSpy.mock.calls[0]?.[0] ?? '').toContain('Could not check');
      // A diagnostic that could not be computed must not BLOCK the delete —
      // advisory in both directions.
      await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('conn_store'));
    });
  });
});
