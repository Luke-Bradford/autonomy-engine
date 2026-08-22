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
    listDatasetSheets: vi.fn(),
    createDataset: vi.fn(),
    updateDataset: vi.fn(),
    deleteDataset: vi.fn(),
  };
});
vi.mock('../api/connections', async (importActual) => ({
  ...(await importActual<typeof import('../api/connections')>()),
  listConnections: vi.fn(),
}));

/**
 * #1215 — the no-reader seam, made TESTABLE after the last real witness went.
 *
 * Five arms below exercise production branches that fire when a dataset kind
 * has no reader: the JSON editor is forced open, the toggle is hidden, and a
 * kind change commits the field draft into the JSON text. They used `excel` as
 * the witness, because it was the last kind without a reader — and M11 gave it
 * one, so no kind can produce those branches any more.
 *
 * Deleting the arms was the alternative and it is worse: the branches are live
 * code that the NEXT dataset kind reaches on its first day, and `DatasetsPage`
 * would then ship them untested for however long that takes. So the seam is
 * mocked at its narrowest point — one predicate, opt-in per test through
 * `unreadableKind`, defaulting to the REAL behaviour (every kind readable) so
 * every other arm in this file runs against the shipped function.
 *
 * This is a fiction about which KIND lacks a reader, and not about the branch:
 * the contract under test is "what the form does when `datasetKindIsImplemented`
 * says no", and that is exactly what is driven. `dataset-config.test.ts` pins
 * the other half — that the set really does span every kind today, and reds the
 * moment a fifth arrives.
 */
let unreadableKind: string | null = null;
vi.mock('@autonomy-studio/shared', async (importActual) => {
  const actual = await importActual<typeof import('@autonomy-studio/shared')>();
  return {
    ...actual,
    datasetKindIsImplemented: (kind: string) =>
      kind === unreadableKind ? false : actual.datasetKindIsImplemented(kind as never),
  };
});

const listMock = vi.mocked(datasetsApi.listDatasets);
const createMock = vi.mocked(datasetsApi.createDataset);
const updateMock = vi.mocked(datasetsApi.updateDataset);
const deleteMock = vi.mocked(datasetsApi.deleteDataset);
const listConnectionsMock = vi.mocked(connectionsApi.listConnections);
const sheetsMock = vi.mocked(datasetsApi.listDatasetSheets);

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
  sheetsMock.mockResolvedValue({ ok: true, sheets: ['People', 'Costs'] });
});

afterEach(() => {
  unreadableKind = null;
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
    unreadableKind = 'excel'; // see the seam above — no real kind lacks a reader now
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'excel');

    // The branch keys on `datasetKindIsImplemented` and NOT on `fields.length`,
    // which is precisely what this arm proves: under the seam, `excel` has a
    // full field schema and STILL gets the JSON editor, because the reason is
    // the reader and never an absent form.
    expect(within(form()).getByLabelText('Config (JSON)')).toBeInTheDocument();
    expect(within(form()).queryByText('This kind has no settings.')).not.toBeInTheDocument();

    // The "no reader exists for a …" SENTENCE is deliberately not asserted
    // here. It comes from `datasetConfigAdvisory`, which consults
    // `datasetKindIsImplemented` through an intra-module call the seam above
    // cannot reach — and faking that function too would mean asserting the
    // mock's own string, which proves nothing. That sentence is the shared
    // package's, its branch is unreachable there for the same reason, and
    // `dataset-config.test.ts` pins the fact that makes it so.
    // No mode toggle: the reader gate, not an absent field form, is why.
    expect(
      within(form()).queryByRole('button', { name: 'Edit as fields' }),
    ).not.toBeInTheDocument();
  });

  it('carries a typed field into the JSON editor a reader-less kind forces open', async () => {
    unreadableKind = 'excel'; // see the seam above — no real kind lacks a reader now
    // The one mode change that does not run through the explicit toggle: a kind
    // with no reader forces `jsonMode` on. Without committing the field draft
    // first, the textarea opens on a `jsonText` written before anything was
    // typed — showing a config the operator did not build, and saving it.
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.type(within(form()).getByLabelText('Name'), 'Orders');
    await user.type(within(form()).getByLabelText('table'), 'orders');
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'excel');

    expect(within(form()).getByLabelText('Config (JSON)')).toHaveValue(
      JSON.stringify({ table: 'orders' }, null, 2),
    );

    // And the value that is on screen is the value that is SAVED.
    await pasteInto(user, within(form()).getByLabelText('Columns (JSON)'), '[]');
    await user.click(screen.getByRole('button', { name: 'Create dataset' }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'excel', config: { table: 'orders' } }),
      ),
    );
  });

  it('carries a JSON edit back into the fields when the kind change closes the editor', async () => {
    unreadableKind = 'excel'; // see the seam above — no real kind lacks a reader now
    // The mirror of the case above, and the one the textarea itself creates:
    // its `onChange` writes `jsonText` and NEVER `config`, so re-seeding the
    // new kind's controls from `config` seeds them from before those
    // keystrokes — silently discarding everything typed into the editor.
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.type(within(form()).getByLabelText('Name'), 'Orders');
    await user.selectOptions(within(form()).getByLabelText('Store'), 'conn_1');
    await user.type(within(form()).getByLabelText('table'), 'orders');
    // A kind with no reader forces the editor open (see the case above).
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'excel');

    const editor = within(form()).getByLabelText('Config (JSON)');
    await user.clear(editor);
    await pasteInto(user, editor, JSON.stringify({ table: 'invoices', schema: 'main' }));

    // Back to a kind WITH a reader: the editor closes, and EVERY field must show
    // what the JSON said rather than the pre-edit draft — including `table`,
    // where the stale `form.inputs` entry is what used to win.
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'table');
    expect(within(form()).getByLabelText('table')).toHaveValue('invoices');
    expect(within(form()).getByLabelText(/^schema/)).toHaveValue('main');

    // And what is on screen is what is SAVED.
    await pasteInto(user, within(form()).getByLabelText('Columns (JSON)'), COLUMNS_JSON);
    await user.click(screen.getByRole('button', { name: 'Create dataset' }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'table',
          config: { table: 'invoices', schema: 'main' },
        }),
      ),
    );
  });

  it('keeps the JSON editor open when the kind changes on a draft that will not parse', async () => {
    unreadableKind = 'excel'; // see the seam above — no real kind lacks a reader now
    // The parse-failure half of the case above. `jsonMode` is DERIVED, so a new
    // kind that happens to render the stale `config` would reopen the field
    // form on the pre-edit value while the operator's unparseable text vanished
    // behind it. `toFieldMode` already refuses to leave JSON mode on a parse
    // failure; a kind change has to refuse for the same reason.
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.type(within(form()).getByLabelText('table'), 'orders');
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'excel');

    const editor = within(form()).getByLabelText('Config (JSON)');
    await user.clear(editor);
    await pasteInto(user, editor, '{oops');

    await user.selectOptions(within(form()).getByLabelText('Kind'), 'table');

    // The kind changed — the operator is not trapped in it — but the editor is
    // still open on exactly what they typed, and the message says why.
    expect(within(form()).getByLabelText('Kind')).toHaveValue('table');
    expect(within(form()).getByLabelText('Config (JSON)')).toHaveValue('{oops');
    expect(within(form()).getByRole('alert')).toBeInTheDocument();
    expect(within(form()).queryByLabelText('table')).not.toBeInTheDocument();
  });

  it('names the unreadable control instead of opening JSON on a draft that omits it', async () => {
    unreadableKind = 'excel'; // see the seam above — no real kind lacks a reader now
    const user = userEvent.setup();
    listMock.mockResolvedValue([
      dataset({ kind: 'query', config: { sql: 'select 1', parameters: { a: 1 } } }),
    ]);
    renderWithRouter(<DatasetsPage />);
    await screen.findByText('Orders');
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    // `parameters` is a record, so it derives a JSON control; typing something
    // unparseable into it makes the field draft unreadable.
    await pasteInto(user, within(form()).getByLabelText(/^parameters \(optional\)/), '{oops');
    // `excel` — the kind-change branch this exercises only fires for a kind with
    // NO reader, and #1167 gave `delimited` one.
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'excel');

    expect(await within(form()).findByRole('alert')).toHaveTextContent(/parameters/);
    // The kind still changed — the operator is not trapped in it.
    expect(within(form()).getByLabelText('Kind')).toHaveValue('excel');
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

  it('gives `delimited` the typed field form now that a reader exists (#1167)', async () => {
    // The other side of the JSON-forced test above, and the user-visible half of
    // M7 slice 3: a `delimited` dataset stops being a kind you can only author
    // as raw JSON. The controls are §2.6's, derived from the schema #1163 gave
    // it; what changed here is only the READER gate.
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'delimited');

    expect(within(form()).getByLabelText('path')).toBeInTheDocument();
    expect(within(form()).getByLabelText('header')).toBeInTheDocument();
    expect(within(form()).queryByLabelText('Config (JSON)')).not.toBeInTheDocument();
    // The toggle is back too — it is hidden only for a kind with no reader.
    expect(within(form()).getByRole('button', { name: 'Edit as JSON' })).toBeInTheDocument();
    // And no stale advisory: the no-reader note was the reason the form was
    // locked, so it must go with the lock.
    expect(
      within(form()).queryByText(/no reader exists for a delimited dataset yet/),
    ).not.toBeInTheDocument();
  });

  it('opens a NEW dataset on a kind that lives in the store it opens on (#1167)', async () => {
    // Before #1167 the default was "the first kind with a reader", which was
    // stable only while one store had one. With `delimited` implemented that
    // rule returns `delimited` for every new dataset — so a form opening on a
    // `sqlite` connection would render "Kind and store disagree" on mount,
    // before the operator had touched anything.
    const user = userEvent.setup();
    listConnectionsMock.mockResolvedValue([store({ id: 'conn_files', kind: 'fs' })]);
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    expect(within(form()).getByLabelText('Kind')).toHaveValue('delimited');
    expect(within(form()).queryByText(/Kind and store disagree/)).not.toBeInTheDocument();
  });

  it('flags a stranded row on the LIST, without anyone opening it (#1158)', async () => {
    // A connection's `kind` is MUTABLE (`routes/connections.ts` documents the
    // transition), and nothing re-checks the datasets that named it. Before
    // this, #1145's advisory rendered on the edit FORM only — so a `table`
    // dataset whose store had become an `http` connection was disagreeing,
    // truly, and invisibly, until somebody happened to open it.
    listMock.mockResolvedValue([dataset()]);
    listConnectionsMock.mockResolvedValue([store({ kind: 'http' })]);
    renderWithRouter(<DatasetsPage />);

    const row = within(await screen.findByRole('row', { name: /Orders/ }));
    // The store still resolves — this is not the dangling case.
    expect(row.getByText('Warehouse')).toBeInTheDocument();
    // Compact where it is DRAWN, complete where it is READ: the cell is a fixed
    // width and five of these sentences stacked in it is a wall.
    expect(row.getByText(/kind mismatch/i)).toBeInTheDocument();
    expect(
      row.getByText(
        // 'sqlite' or 'postgres' since #1190 opened `table` to postgres — the
        // advisory ENUMERATES the map rather than naming one store, so it stays
        // true as the map grows.
        /dataset kind 'table' lives in a store of kind 'sqlite' or 'postgres', but this one names a connection of kind 'http'/,
      ),
    ).toBeInTheDocument();
  });

  it('leaves an AGREEING row unmarked, so the mark means something (#1158)', async () => {
    listMock.mockResolvedValue([dataset()]);
    listConnectionsMock.mockResolvedValue([store()]);
    renderWithRouter(<DatasetsPage />);

    const row = within(await screen.findByRole('row', { name: /Orders/ }));
    expect(row.getByText('Warehouse')).toBeInTheDocument();
    expect(row.queryByText(/kind mismatch/i)).toBeNull();
  });

  it('says nothing about kind for a DANGLING store, having resolved no kind (#1158)', async () => {
    // `datasetConnectionKindAdvisory`'s documented contract: a null
    // connectionKind says NOTHING, because a complaint derived from a
    // connection nobody resolved is invented on a fact never established. The
    // row already has its own, truer, message for this state.
    listMock.mockResolvedValue([dataset({ connectionId: 'conn_gone' })]);
    listConnectionsMock.mockResolvedValue([store()]);
    renderWithRouter(<DatasetsPage />);

    const row = within(await screen.findByRole('row', { name: /Orders/ }));
    expect(row.getByText(/conn_gone/)).toBeInTheDocument();
    expect(row.getByText(/\(missing\)/)).toBeInTheDocument();
    expect(row.queryByText(/kind mismatch/i)).toBeNull();
  });

  it('flags a dataset whose kind disagrees with the store it names (#1145)', async () => {
    // The ticket's own example. `routes/datasets.ts` checks that the connection
    // exists and is owned and NOTHING else, so this row saves today and is only
    // refused when a copy is dispatched — which is what the note exists to say
    // earlier.
    const user = userEvent.setup();
    // TWO connections, and the agreeing one FIRST, so the selections below are
    // real state changes rather than no-ops. `blankForm` opens on
    // `connections[0]` at `DEFAULT_KIND` — with only the mismatched connection
    // seeded, the form would already be in the state this test means to reach,
    // and it would prove the advisory renders on mount while proving nothing
    // about it recomputing when the operator picks a different store.
    listConnectionsMock.mockResolvedValue([
      store({ id: 'conn_db', name: 'Orders DB', kind: 'sqlite' }),
      store({ id: 'conn_llm', name: 'Claude', kind: 'anthropic_api' }),
    ]);
    renderWithRouter(<DatasetsPage />);
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    // Quiet first — `conn_db` is a `sqlite` store and `table` lives there.
    expect(within(form()).queryByText(/Kind and store disagree/)).not.toBeInTheDocument();

    await user.selectOptions(within(form()).getByLabelText('Store'), 'conn_llm');
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'table');

    expect(within(form()).getByText(/Kind and store disagree/)).toHaveTextContent(
      /dataset kind 'table' lives in a store of kind 'sqlite' or 'postgres', but this one names a connection of kind 'anthropic_api'/,
    );
    // ADVISORY, never a gate: the server accepts this row, so the form must not
    // refuse it. This is the assertion that keeps it from being hardened into a
    // block by a later change.
    expect(screen.getByRole('button', { name: 'Create dataset' })).toBeEnabled();
  });

  it('stays quiet when the kind and the store agree (#1145)', async () => {
    const user = userEvent.setup();
    renderWithRouter(<DatasetsPage />); // the default `store()` fixture is `sqlite`
    await screen.findByText(/No datasets yet/i);

    await user.click(screen.getByRole('button', { name: 'New dataset' }));
    await user.selectOptions(within(form()).getByLabelText('Kind'), 'table');

    expect(within(form()).queryByText(/Kind and store disagree/)).not.toBeInTheDocument();
  });

  /**
   * #1218 — the `sheet` field stops being typed blind.
   *
   * Driven through the PAGE rather than the control, because the parts that can
   * actually go wrong are the panel's: which field gets offered values, what a
   * choice does to the OTHER field, and when a listing stops being about the
   * draft on screen.
   */
  describe('excel sheet chooser (#1218)', () => {
    async function openExcelForm(user: ReturnType<typeof userEvent.setup>) {
      listConnectionsMock.mockResolvedValue([store({ id: 'conn_fs', kind: 'fs', name: 'Files' })]);
      renderWithRouter(<DatasetsPage />);
      await user.click(await screen.findByRole('button', { name: 'New dataset' }));
      await user.selectOptions(within(form()).getByLabelText('Store'), 'conn_fs');
      await user.selectOptions(within(form()).getByLabelText('Kind'), 'excel');
      await pasteInto(user, within(form()).getByLabelText('path'), '/data/book.xlsx');
    }

    it('offers no chooser until the sheets have been listed', async () => {
      const user = userEvent.setup();
      await openExcelForm(user);

      // The free-text box is the ONLY surface before a listing, and it must
      // remain reachable: a workbook whose path is not readable yet has no list
      // to offer, and a form that demanded one would be unauthorable.
      expect(within(form()).getByLabelText('sheet (optional)')).toBeInTheDocument();
      expect(within(form()).queryByLabelText('Sheet in this workbook')).toBeNull();
      expect(sheetsMock).not.toHaveBeenCalled();
    });

    it('asks for a path before it asks the server for anything', async () => {
      const user = userEvent.setup();
      listConnectionsMock.mockResolvedValue([store({ id: 'conn_fs', kind: 'fs', name: 'Files' })]);
      renderWithRouter(<DatasetsPage />);
      await user.click(await screen.findByRole('button', { name: 'New dataset' }));
      await user.selectOptions(within(form()).getByLabelText('Store'), 'conn_fs');
      await user.selectOptions(within(form()).getByLabelText('Kind'), 'excel');

      await user.click(within(form()).getByRole('button', { name: 'List sheets' }));

      expect(await screen.findByText(/Enter the workbook path first/)).toBeInTheDocument();
      expect(sheetsMock).not.toHaveBeenCalled();
    });

    it('lists on demand and offers every named sheet', async () => {
      const user = userEvent.setup();
      await openExcelForm(user);

      await user.click(within(form()).getByRole('button', { name: 'List sheets' }));

      const chooser = await within(form()).findByLabelText('Sheet in this workbook');
      expect(sheetsMock).toHaveBeenCalledWith({
        connectionId: 'conn_fs',
        path: '/data/book.xlsx',
      });
      expect(within(chooser).getByRole('option', { name: 'People' })).toBeInTheDocument();
      expect(within(chooser).getByRole('option', { name: 'Costs' })).toBeInTheDocument();
    });

    it('writes the chosen name into `sheet` AND blanks `sheetIndex`', async () => {
      const user = userEvent.setup();
      await openExcelForm(user);
      // A `sheetIndex` typed first is the trap: the schema refuses a config
      // naming both, so a chooser that only wrote `sheet` would make itself the
      // cause of the refusal on Save.
      await pasteInto(user, within(form()).getByLabelText('sheetIndex (optional) — number'), '2');

      await user.click(within(form()).getByRole('button', { name: 'List sheets' }));
      await user.selectOptions(
        await within(form()).findByLabelText('Sheet in this workbook'),
        'Costs',
      );

      expect(within(form()).getByLabelText('sheet (optional)')).toHaveValue('Costs');
      expect(within(form()).getByLabelText('sheetIndex (optional) — number')).toHaveValue('');
    });

    it('stops offering a listing once the path moves out from under it', async () => {
      const user = userEvent.setup();
      await openExcelForm(user);
      await user.click(within(form()).getByRole('button', { name: 'List sheets' }));
      await within(form()).findByLabelText('Sheet in this workbook');

      await pasteInto(user, within(form()).getByLabelText('path'), '-other');

      // The names belong to the workbook that WAS named. Offering them against a
      // different path would invite a choice that refuses at dispatch — the very
      // failure this ticket exists to remove.
      await waitFor(() =>
        expect(within(form()).queryByLabelText('Sheet in this workbook')).toBeNull(),
      );
    });

    it('shows a refusal as an answer, not as a form error', async () => {
      sheetsMock.mockResolvedValue({ ok: false, error: "'/data/book.xlsx' could not be opened" });
      const user = userEvent.setup();
      await openExcelForm(user);

      await user.click(within(form()).getByRole('button', { name: 'List sheets' }));

      const said = await screen.findByText(/could not be opened/);
      expect(said).toHaveAttribute('role', 'status');
      expect(within(form()).queryByLabelText('Sheet in this workbook')).toBeNull();
      // The box survives the refusal — the operator can still type the name.
      expect(within(form()).getByLabelText('sheet (optional)')).toBeInTheDocument();
    });

    it('declines to offer an unnamed sheet, and says how to reach it', async () => {
      // `DatasetSheetsResultSchema` admits an empty name so one odd sheet cannot
      // make a whole workbook uninspectable; `sheet` is `.min(1)`, so offering
      // it would be a choice the save refuses.
      sheetsMock.mockResolvedValue({ ok: true, sheets: [''] });
      const user = userEvent.setup();
      await openExcelForm(user);

      await user.click(within(form()).getByRole('button', { name: 'List sheets' }));

      expect(await screen.findByText(/no named sheets/)).toBeInTheDocument();
      expect(within(form()).queryByLabelText('Sheet in this workbook')).toBeNull();
    });
  });
});
