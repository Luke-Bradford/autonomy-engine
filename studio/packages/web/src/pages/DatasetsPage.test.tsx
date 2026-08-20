import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectionPublic, Dataset } from '@autonomy-studio/shared';
import { DatasetsPage } from './DatasetsPage';
import * as datasetsApi from '../api/datasets';
import * as connectionsApi from '../api/connections';
import { renderWithRouter } from '../testing/renderWithRouter';

// Mock only the network calls; `DatasetWriteSchema` stays REAL so the form's
// client-side validation is exercised exactly as it ships.
vi.mock('../api/datasets', async (importActual) => {
  const actual = await importActual<typeof import('../api/datasets')>();
  return {
    ...actual,
    listDatasets: vi.fn(),
    createDataset: vi.fn(),
    updateDataset: vi.fn(),
    deleteDataset: vi.fn(),
  };
});
vi.mock('../api/connections', async (importActual) => ({
  ...(await importActual<typeof import('../api/connections')>()),
  listConnections: vi.fn(),
}));

const listMock = vi.mocked(datasetsApi.listDatasets);
const createMock = vi.mocked(datasetsApi.createDataset);
const updateMock = vi.mocked(datasetsApi.updateDataset);
const deleteMock = vi.mocked(datasetsApi.deleteDataset);
const listConnectionsMock = vi.mocked(connectionsApi.listConnections);

function store(overrides: Partial<ConnectionPublic> = {}): ConnectionPublic {
  return {
    id: 'conn_1',
    resourceId: 'res_conn1',
    ownerId: 'local',
    name: 'Warehouse',
    kind: 'sqlite',
    config: { path: '/tmp/wh.db' },
    parameters: [],
    secretStatus: 'not_required',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds_1',
    resourceId: 'res_ds1',
    ownerId: 'local',
    name: 'Orders',
    connectionId: 'conn_1',
    kind: 'table',
    config: { table: 'orders' },
    columns: [{ name: 'id', type: 'integer', nullable: false }],
    parameters: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function form() {
  return screen.getByRole('form', { name: 'Dataset form' });
}

/** `userEvent.type` reads `{` as a key descriptor, so JSON goes in by paste. */
async function pasteInto(
  user: ReturnType<typeof userEvent.setup>,
  el: HTMLElement,
  text: string,
): Promise<void> {
  await user.click(el);
  await user.paste(text);
}

const COLUMNS_JSON = JSON.stringify([{ name: 'id', type: 'integer', nullable: false }]);

beforeEach(() => {
  listMock.mockResolvedValue([]);
  listConnectionsMock.mockResolvedValue([store()]);
  createMock.mockResolvedValue(dataset());
  updateMock.mockResolvedValue(dataset());
  deleteMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DatasetsPage', () => {
  it('shows the empty state after loading', async () => {
    renderWithRouter(<DatasetsPage />);
    expect(await screen.findByText(/No datasets yet/i)).toBeInTheDocument();
  });

  it('renders a row with its kind, its store’s NAME and its column count', async () => {
    listMock.mockResolvedValue([dataset()]);
    renderWithRouter(<DatasetsPage />);
    const row = within(await screen.findByRole('row', { name: /Orders/ }));
    expect(row.getByText('table')).toBeInTheDocument();
    // The store resolves to a name, not the raw `conn_1`.
    expect(row.getByText('Warehouse')).toBeInTheDocument();
    expect(row.getByText('1')).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    renderWithRouter(<DatasetsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('creates a dataset from the kind’s own fields', async () => {
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.type(within(form()).getByLabelText('Name'), 'Orders');
    await user.selectOptions(within(form()).getByLabelText('Store'), 'conn_1');
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'table');
    // `table` is a control derived from the kind's own schema, not a JSON blob.
    await user.type(within(form()).getByLabelText('table'), 'orders');
    await pasteInto(user, within(form()).getByLabelText('Columns (JSON)'), COLUMNS_JSON);

    listMock.mockResolvedValue([dataset()]);
    await user.click(screen.getByRole('button', { name: 'Create dataset' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: 'Orders',
        connectionId: 'conn_1',
        kind: 'table',
        config: { table: 'orders' },
        columns: [{ name: 'id', type: 'integer', nullable: false }],
      }),
    );
    // `parameters` is ABSENT, never `[]`: an explicit empty array would clear a
    // stored override allowlist on the server, which treats it as deliberate.
    expect(Object.keys(createMock.mock.calls[0]![0])).not.toContain('parameters');
  });

  it('REFUSES a blank columns draft rather than saving an empty declaration', async () => {
    // `DatasetSchema.columns` is required with no `.default([])` so that an
    // absent column list fails loudly instead of being manufactured as "this
    // table has no columns" — which auto-map would read as an empty mapping.
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.type(within(form()).getByLabelText('Name'), 'Orders');
    await user.type(within(form()).getByLabelText('table'), 'orders');
    await user.click(screen.getByRole('button', { name: 'Create dataset' }));

    expect(await within(form()).findByRole('alert')).toHaveTextContent(/Columns is required/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('accepts an EXPLICIT empty column list, because that is a stated fact', async () => {
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.type(within(form()).getByLabelText('Name'), 'Orders');
    await user.type(within(form()).getByLabelText('table'), 'orders');
    await pasteInto(user, within(form()).getByLabelText('Columns (JSON)'), '[]');
    await user.click(screen.getByRole('button', { name: 'Create dataset' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ columns: [] })),
    );
  });

  it('names the offending column when the declaration is the wrong shape', async () => {
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.type(within(form()).getByLabelText('Name'), 'Orders');
    await user.type(within(form()).getByLabelText('table'), 'orders');
    // `nullable` is REQUIRED with no default — a fact about the store that
    // neither default would answer correctly.
    await pasteInto(
      user,
      within(form()).getByLabelText('Columns (JSON)'),
      '[{ "name": "id", "type": "integer" }]',
    );
    await user.click(screen.getByRole('button', { name: 'Create dataset' }));

    expect(await within(form()).findByRole('alert')).toHaveTextContent(/nullable/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('seeds the edit form from the stored row, so a rename cannot wipe the columns', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dataset()]);
    renderWithRouter(<DatasetsPage />);
    await screen.findByText('Orders');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(within(form()).getByLabelText('Name'));
    await user.type(within(form()).getByLabelText('Name'), 'Orders v2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith('ds_1', {
        name: 'Orders v2',
        connectionId: 'conn_1',
        kind: 'table',
        config: { table: 'orders' },
        // Carried through from the stored row — NOT reset to [].
        columns: [{ name: 'id', type: 'integer', nullable: false }],
      }),
    );
  });

  it('shows a dangling store as its raw id, and never silently re-points it', async () => {
    // A dataset's `connectionId` is checked at WRITE time only; the connection
    // can be deleted afterwards. Dropping the unresolved id from the select
    // would make it fall back to the first connection, which READS as the
    // binding while the row says otherwise — and the next Save would write it.
    const user = userEvent.setup();
    listMock.mockResolvedValue([dataset({ connectionId: 'conn_gone' })]);
    renderWithRouter(<DatasetsPage />);
    await screen.findByText('Orders');
    expect(screen.getByText('conn_gone')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(within(form()).getByLabelText('Store')).toHaveValue('conn_gone');
    expect(
      within(form()).getByText(/names a connection that no longer exists/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        'ds_1',
        expect.objectContaining({ connectionId: 'conn_gone' }),
      ),
    );
  });

  it('carries a key from another kind rather than stranding it', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([
      dataset({ kind: 'query', config: { sql: 'select 1', table: 'orders' } }),
    ]);
    renderWithRouter(<DatasetsPage />);
    await screen.findByText('Orders');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    // `table` belongs to the `table` kind, not to `query` — but the stored
    // config holds it, so it is rendered (optional) and can be blanked away.
    expect(within(form()).getByLabelText('table (optional)')).toHaveValue('orders');
    expect(within(form()).getByText(/Carried from another kind \(table\)/)).toBeInTheDocument();
  });

  it('warns when the kind’s own schema refuses the draft, without refusing the save', async () => {
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    // A name only a quoting rule could make safe is refused by the identifier
    // rule (§8) — the operator learns that here, not when a run fails.
    await user.type(within(form()).getByLabelText('table'), 'order lines');
    expect(
      await within(form()).findByText(/This table config is incomplete: .*bare SQL identifier/),
    ).toBeInTheDocument();
  });

  it('forces the JSON editor for a kind with no reader, and says why', async () => {
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'delimited');

    // `delimited`'s config schema is a `looseObject`, so it derives NO controls.
    // The empty-fields branch would have said "This kind has no settings",
    // which is false — spec §2.6 lists seven keys for it.
    expect(within(form()).getByLabelText('Config (JSON)')).toBeInTheDocument();
    expect(within(form()).queryByText('This kind has no settings.')).not.toBeInTheDocument();
    expect(within(form()).getByText(/no reader exists for a delimited dataset yet/)).toBeVisible();
    // No mode toggle: there is no field form to switch to.
    expect(
      within(form()).queryByRole('button', { name: 'Edit as fields' }),
    ).not.toBeInTheDocument();
  });

  it('deletes only on confirmation, and says what breaks', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([dataset()]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithRouter(<DatasetsPage />);
    await screen.findByText('Orders');

    await user.click(screen.getByRole('button', { name: 'Delete Orders' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('fail at dispatch'));
    expect(deleteMock).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Delete Orders' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('ds_1'));
  });

  it('says a store is needed at all when there are no connections', async () => {
    const user = userEvent.setup();
    listConnectionsMock.mockResolvedValue([]);
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    expect(within(form()).getByText(/needs a connection first/)).toBeInTheDocument();
  });
});
