import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GlobalParam } from '@autonomy-studio/shared';
import { GlobalParamsPage } from './GlobalParamsPage';
import * as api from '../api/globalParams';
import { ApiError } from '../api/client';
import * as download from '../api/download';
import * as portability from '../api/portability';
import { renderWithDataRouter } from '../testing/renderWithRouter';
import { answerConfirm } from '../testing/confirmDialog';

// Network calls only; the shared schemas stay REAL, so the client-side checks
// run exactly as they ship.
vi.mock('../api/globalParams', async (importActual) => {
  const actual = await importActual<typeof import('../api/globalParams')>();
  return {
    ...actual,
    listGlobalParams: vi.fn(),
    createGlobalParam: vi.fn(),
    updateGlobalParam: vi.fn(),
    deleteGlobalParam: vi.fn(),
    getGlobalParamUsage: vi.fn(),
  };
});

const listMock = vi.mocked(api.listGlobalParams);
const createMock = vi.mocked(api.createGlobalParam);
const updateMock = vi.mocked(api.updateGlobalParam);
const deleteMock = vi.mocked(api.deleteGlobalParam);
const usageMock = vi.mocked(api.getGlobalParamUsage);

function global(overrides: Partial<GlobalParam> = {}): GlobalParam {
  return {
    id: 'gp_1',
    ownerId: 'local',
    name: 'apiUrl',
    type: 'string',
    value: 'https://example.test',
    description: 'the base URL',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** The drawer's form (#1396): one open at a time, so found by its name. */
function form() {
  return screen.getByRole('form', { name: 'Global parameter form' });
}

function field(label: string) {
  return within(form()).getByLabelText(label, { exact: true });
}

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'New global parameter' }));
  return form();
}

async function openEdit(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Edit ${name}` }));
  return form();
}

/** The delete dialog's `Type <name> to confirm` box (#1397), if it asked for one. */
const typeBox = (name: string) =>
  screen.queryByRole('textbox', { name: `Type ${name} to confirm` });

const USAGE_READ_BY_PIPELINE = {
  pipelines: [{ pipelineId: 'p1', pipelineName: 'Ingest', versionId: 'pv3', version: 3 }],
  triggers: [],
};

const create = () => within(form()).getByRole('button', { name: 'Create global parameter' });
const save = () => within(form()).getByRole('button', { name: 'Save changes' });

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([]);
  usageMock.mockResolvedValue({ pipelines: [], triggers: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GlobalParamsPage (#844 GL2)', () => {
  it('says the store is cleartext, not for credentials, and that runs record what they read', async () => {
    renderWithDataRouter(<GlobalParamsPage />);
    expect(await screen.findByText('No global parameters yet.')).toBeInTheDocument();
    // #844 GL3 — pipelines read them now, and a run keeps the values it read.
    expect(screen.queryByText(/cannot read them yet/)).toBeNull();
    expect(screen.getByText(/A run records the values it read/)).toBeInTheDocument();
    expect(screen.getByText('cleartext')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Secrets' })).toHaveAttribute(
      'href',
      '/manage/secrets',
    );
  });

  it('reports a failed load', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    renderWithDataRouter(<GlobalParamsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load global parameters: boom',
    );
  });

  it('lists each global with its type and cleartext value', async () => {
    listMock.mockResolvedValue([
      global(),
      global({ id: 'gp_2', name: 'cfg', type: 'json', value: { a: 1 }, description: '' }),
    ]);
    renderWithDataRouter(<GlobalParamsPage />);
    const first = (await screen.findByText('apiUrl')).closest('tr')!;
    expect(
      within(first)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['apiUrl', 'String', 'https://example.test', 'the base URL', 'EditExportDelete']);
    const cfg = screen.getByText('cfg').closest('tr')!;
    expect(within(cfg).getByText('{"a":1}')).toHaveAttribute('title', '{"a":1}');
    // No form until one is asked for.
    expect(screen.queryByRole('form', { name: 'Global parameter form' })).toBeNull();
  });

  // #1396 — the edit form: name and type LOCKED (GL-D1), the value editable.
  it('opens a saved global with its name and type read-only, and focus on the value', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global({ type: 'json', value: { a: 1 } })]);
    renderWithDataRouter(<GlobalParamsPage />);
    await openEdit(user, 'apiUrl');
    expect(screen.getByRole('dialog', { name: 'Edit global parameter' })).toBeInTheDocument();
    expect(field('Name')).toHaveAttribute('readonly');
    expect(field('Name')).toHaveValue('apiUrl');
    expect(field('Type')).toHaveAttribute('readonly');
    expect(field('Type')).toHaveValue('JSON');
    expect(field('Value')).toHaveValue('{"a":1}');
    expect(field('Description')).toHaveValue('the base URL');
    // The first field the operator can change, not the read-only Name.
    expect(field('Value')).toHaveFocus();
  });

  it('creates a global: POSTs the typed value, closes the drawer, then refetches', async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue(global({ name: 'retries', type: 'number', value: 3 }));
    renderWithDataRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');

    await openNew(user);
    expect(field('Name')).not.toHaveAttribute('readonly');
    expect(field('Name')).toHaveFocus();
    await user.type(field('Name'), 'retries');
    expect(within(field('Type')).getByRole('option', { name: 'Number' })).toHaveValue('number');
    await user.selectOptions(field('Type'), 'number');
    await user.type(field('Value'), '3');
    await user.click(create());

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: 'retries',
        type: 'number',
        value: 3,
        description: '',
      }),
    );
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('form', { name: 'Global parameter form' })).toBeNull();
  });

  it('refuses an unreadable value locally and sends nothing', async () => {
    const user = userEvent.setup();
    renderWithDataRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');
    await openNew(user);
    await user.type(field('Name'), 'n');
    await user.selectOptions(field('Type'), 'number');
    await user.type(field('Value'), 'abc');
    await user.click(create());
    expect(await within(form()).findByRole('alert')).toHaveTextContent('expected a number');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a name that cannot be referenced, with the shared rule', async () => {
    const user = userEvent.setup();
    renderWithDataRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');
    await openNew(user);
    await user.type(field('Name'), 'api-url');
    await user.click(create());
    expect(await within(form()).findByRole('alert')).toHaveTextContent(
      'cannot be referenced as ${global.<name>}',
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('names a bad name AND a bad value together', async () => {
    const user = userEvent.setup();
    renderWithDataRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');
    await openNew(user);
    await user.type(field('Name'), 'api-url');
    await user.selectOptions(field('Type'), 'number');
    await user.click(create());
    const alert = await within(form()).findByRole('alert');
    expect(alert).toHaveTextContent('cannot be referenced');
    expect(alert).toHaveTextContent('a number global needs a value');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('names the case-insensitive duplicate on a 409, and keeps the form open', async () => {
    const user = userEvent.setup();
    createMock.mockRejectedValue(new ApiError(409, 'conflict', undefined));
    renderWithDataRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');
    await openNew(user);
    await user.type(field('Name'), 'ApiUrl');
    await user.click(create());
    expect(await within(form()).findByRole('alert')).toHaveTextContent(
      'A global parameter named “ApiUrl” already exists. Names ignore case.',
    );
    expect(field('Name')).toHaveValue('ApiUrl');
  });

  it('saves only what changed — a cleared description is sent as empty text', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global()]);
    updateMock.mockResolvedValue(global({ description: '' }));
    renderWithDataRouter(<GlobalParamsPage />);
    await openEdit(user, 'apiUrl');
    await user.clear(field('Description'));
    await user.click(save());
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('gp_1', { description: '' }));
  });

  it('checks a changed value against the STORED type before sending', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global({ type: 'number', value: 3 })]);
    updateMock.mockResolvedValue(global({ type: 'number', value: 4 }));
    renderWithDataRouter(<GlobalParamsPage />);
    await openEdit(user, 'apiUrl');

    await user.clear(field('Value'));
    await user.type(field('Value'), 'x');
    await user.click(save());
    expect(await within(form()).findByRole('alert')).toHaveTextContent('expected a number');
    expect(updateMock).not.toHaveBeenCalled();

    await user.clear(field('Value'));
    await user.type(field('Value'), '4');
    await user.click(save());
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('gp_1', { value: 4 }));
  });

  it('sends nothing when an edit changed nothing, and just closes', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global()]);
    renderWithDataRouter(<GlobalParamsPage />);
    await openEdit(user, 'apiUrl');
    await user.click(save());
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Global parameter form' })).toBeNull(),
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  // A save still in flight when the operator moves to another global must
  // close only ITS form when it lands, never the one opened since.
  it('a save that lands after another form opened leaves that form open', async () => {
    const user = userEvent.setup();
    const b = global({ id: 'gp_2', name: 'b', description: '' });
    listMock.mockResolvedValue([global(), b]);
    let land!: (value: GlobalParam) => void;
    updateMock.mockReturnValue(new Promise<GlobalParam>((resolve) => (land = resolve)));
    renderWithDataRouter(<GlobalParamsPage />);
    await openEdit(user, 'apiUrl');
    await user.type(field('Description'), ' (prod)');
    await user.click(save());
    await waitFor(() => expect(updateMock).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Edit b' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(field('Name')).toHaveValue('b');
    await user.type(field('Description'), 'typed while the other saved');

    land(global({ description: 'the base URL (prod)' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(field('Name')).toHaveValue('b');
    expect(field('Description')).toHaveValue('typed while the other saved');
  });

  it('refuses a json value that would not replay (1e400 is Infinity), before sending', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global({ type: 'json', value: { a: 1 } })]);
    renderWithDataRouter(<GlobalParamsPage />);
    await openEdit(user, 'apiUrl');
    await user.clear(field('Value'));
    await user.click(field('Value'));
    await user.paste('{"a":1e400}');
    await user.click(save());
    expect(await within(form()).findByRole('alert')).toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });

  // A refetch while a form is open (here: another row deleted) must neither
  // reset the open form nor move what its Save diffs against.
  it('keeps an open edit, and its PATCH baseline, across a refetch of the list', async () => {
    const user = userEvent.setup();
    const b = global({ id: 'gp_2', name: 'b' });
    listMock.mockResolvedValue([global(), b]);
    deleteMock.mockResolvedValue(undefined);
    updateMock.mockResolvedValue(global({ value: 'unsaved' }));
    renderWithDataRouter(<GlobalParamsPage />);
    await openEdit(user, 'apiUrl');
    await user.clear(field('Value'));
    await user.type(field('Value'), 'unsaved');

    // The server now holds a DIFFERENT description for apiUrl than the form
    // opened with; the form's baseline is still the one it opened with.
    listMock.mockResolvedValue([global({ description: 'changed elsewhere' })]);
    await user.click(screen.getByRole('button', { name: 'Delete b' }));
    await answerConfirm(user, 'accept');
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('b')).toBeNull());

    expect(field('Value')).toHaveValue('unsaved');
    expect(field('Description')).toHaveValue('the base URL');
    await user.click(save());
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('gp_1', { value: 'unsaved' }));
  });

  it('deletes only after the confirmation, and not when it is cancelled', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global()]);
    deleteMock.mockResolvedValue(undefined);
    renderWithDataRouter(<GlobalParamsPage />);
    const del = await screen.findByRole('button', { name: 'Delete apiUrl' });

    await user.click(del);
    await answerConfirm(user, 'cancel');
    expect(deleteMock).not.toHaveBeenCalled();

    await user.click(del);
    const asked = await answerConfirm(user, 'accept');
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('gp_1'));
    expect(asked).toContain('"apiUrl"');
    expect(usageMock).toHaveBeenCalledWith('gp_1');
  });

  it('closes the drawer when the global it is editing is deleted', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global()]);
    deleteMock.mockResolvedValue(undefined);
    renderWithDataRouter(<GlobalParamsPage />);
    await openEdit(user, 'apiUrl');
    // Dirty, so the close must bypass the guard: there is nothing left to save to.
    await user.type(field('Value'), '-edited');
    listMock.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Delete apiUrl' }));
    await answerConfirm(user, 'accept');
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Global parameter form' })).toBeNull(),
    );
    expect(screen.queryByRole('alertdialog', { name: 'Unsaved changes' })).toBeNull();
  });

  // #844 GL3 (GL-D4) — the confirmation names what reads the global.
  it('lists what reads the global in the delete confirmation', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global()]);
    usageMock.mockResolvedValue({
      pipelines: [{ pipelineId: 'p1', pipelineName: 'Ingest', versionId: 'pv3', version: 3 }],
      triggers: [
        {
          triggerId: 't1',
          triggerName: 'Nightly',
          enabled: false,
          pipelineName: 'Ingest',
          versionId: 'pv1',
          version: 1,
        },
      ],
    });
    renderWithDataRouter(<GlobalParamsPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete apiUrl' }));
    const text = await answerConfirm(user, 'cancel');
    expect(text).toContain('Read by the latest version of:');
    expect(text).toContain('• Ingest (v3)');
    expect(text).toContain('• Nightly (Ingest v1, disabled)');
    expect(text).toMatch(/will not start until a global of that name and type exists again/);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  // #1397 — a global something reads is not deleted by a stray click: the name
  // has to be typed.
  it('keeps Delete disabled until the name is typed, when something reads the global', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global()]);
    deleteMock.mockResolvedValue(undefined);
    usageMock.mockResolvedValue(USAGE_READ_BY_PIPELINE);
    renderWithDataRouter(<GlobalParamsPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete apiUrl' }));
    const dialog = await screen.findByRole('alertdialog');
    const action = within(dialog).getByRole('button', { name: 'Delete' });
    expect(action).toBeDisabled();

    const box = within(dialog).getByRole('textbox', { name: 'Type apiUrl to confirm' });
    await user.type(box, 'apiUrL');
    expect(box).toHaveValue('apiUrL');
    expect(action).toBeDisabled();
    await user.clear(box);
    await user.type(box, 'apiUrl');
    expect(box).toHaveValue('apiUrl');
    expect(action).toBeEnabled();
    expect(deleteMock).not.toHaveBeenCalled();

    await answerConfirm(user, 'accept');
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('gp_1'));
  });

  it('says so when what reads it could not be checked, and still lets the delete go ahead', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global()]);
    deleteMock.mockResolvedValue(undefined);
    usageMock.mockRejectedValue(new Error('boom'));
    renderWithDataRouter(<GlobalParamsPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete apiUrl' }));
    // A failed read is advisory (GL-D4): the plain question, no name to type.
    const dialog = await screen.findByRole('alertdialog');
    expect(typeBox('apiUrl')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
    const asked = await answerConfirm(user, 'accept');
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('gp_1'));
    expect(asked).toContain('could not be checked');
    expect(asked).not.toContain('No pipeline');
  });

  describe('the unsaved-changes guard (#1396)', () => {
    it('closes a clean form at once, without a request', async () => {
      const user = userEvent.setup();
      renderWithDataRouter(<GlobalParamsPage />);
      await screen.findByText('No global parameters yet.');
      await openNew(user);
      await user.click(within(form()).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('form', { name: 'Global parameter form' })).toBeNull();
      expect(createMock).not.toHaveBeenCalled();
    });

    it('asks before discarding typed edits, and Keep editing keeps them', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([global()]);
      renderWithDataRouter(<GlobalParamsPage />);
      await openEdit(user, 'apiUrl');
      await user.type(field('Description'), ' (prod)');
      await user.click(within(form()).getByRole('button', { name: 'Cancel' }));

      const prompt = screen.getByRole('alertdialog', { name: 'Unsaved changes' });
      await user.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
      expect(field('Description')).toHaveValue('the base URL (prod)');

      await user.click(within(form()).getByRole('button', { name: 'Cancel' }));
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(screen.queryByRole('form', { name: 'Global parameter form' })).toBeNull();
      expect(updateMock).not.toHaveBeenCalled();
    });
  });
});

describe('GlobalParamsPage export and import (#844 GL6)', () => {
  it('exports a saved global to a file', async () => {
    listMock.mockResolvedValue([global()]);
    const exportMock = vi
      .spyOn(portability, 'exportGlobalParam')
      .mockResolvedValue('{"kind":"global-param"}');
    const saveMock = vi.spyOn(download, 'downloadTextFile').mockImplementation(() => {});
    renderWithDataRouter(<GlobalParamsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Export apiUrl' }));

    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith(
        'global-param-apiurl-gp_1.json',
        '{"kind":"global-param"}',
      ),
    );
    expect(exportMock).toHaveBeenCalledWith('gp_1');
  });

  it('offers an import from a file', async () => {
    renderWithDataRouter(<GlobalParamsPage />);
    expect(await screen.findByText(/No global parameters yet/)).toBeVisible();
    expect(screen.getByLabelText(/import/i)).toBeInTheDocument();
  });
});

/* #1396 OR5 slice 6 — inline validation on the global parameter form. */
describe('GlobalParamsPage — inline validation (#1396)', () => {
  it('a refused Save marks the name and the value, each beside itself, and focuses the first', async () => {
    const user = userEvent.setup();
    renderWithDataRouter(<GlobalParamsPage />);
    await screen.findByText(/No global parameters yet/i);
    await openNew(user);
    await user.type(field('Name'), 'my-param');
    await user.selectOptions(field('Type'), 'number');
    await user.type(field('Value'), 'abc');
    await user.click(create());

    expect(createMock).not.toHaveBeenCalled();
    const alert = within(form()).getByRole('alert');
    expect(alert).toHaveTextContent('Fix these 2 fields:');
    await waitFor(() => expect(field('Name')).toHaveFocus());
    expect(field('Name')).toHaveAccessibleDescription(/cannot be referenced/);
    expect(field('Value')).toHaveAttribute('aria-invalid', 'true');

    await user.clear(field('Value'));
    await user.type(field('Value'), '3');
    expect(field('Value')).toHaveAttribute('aria-invalid', 'false');
    expect(alert).toHaveTextContent('Fix this field:');
  });

  it('a 409 on create is shown beside the Name', async () => {
    createMock.mockRejectedValue(new ApiError(409, 'conflict', undefined));
    const user = userEvent.setup();
    renderWithDataRouter(<GlobalParamsPage />);
    await screen.findByText(/No global parameters yet/i);
    await openNew(user);
    await user.type(field('Name'), 'apiUrl');
    await user.click(create());

    await waitFor(() => expect(field('Name')).toHaveFocus());
    expect(field('Name')).toHaveAccessibleDescription(/already exists\. Names ignore case/);
  });

  it('on an edit, a changed value is checked when it is left, and blocks the PATCH', async () => {
    listMock.mockResolvedValue([global({ type: 'number', value: 3 })]);
    const user = userEvent.setup();
    renderWithDataRouter(<GlobalParamsPage />);
    await openEdit(user, 'apiUrl');

    await user.clear(field('Value'));
    await user.type(field('Value'), 'many');
    expect(field('Value')).toHaveAttribute('aria-invalid', 'false');
    await user.tab();
    expect(field('Value')).toHaveAttribute('aria-invalid', 'true');
    await user.click(save());
    expect(updateMock).not.toHaveBeenCalled();
    expect(within(form()).getByRole('alert')).toHaveTextContent('Fix this field:');
  });
});
