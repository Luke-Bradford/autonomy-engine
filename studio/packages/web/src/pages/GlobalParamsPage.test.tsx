import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GlobalParam } from '@autonomy-studio/shared';
import { GlobalParamsPage } from './GlobalParamsPage';
import * as api from '../api/globalParams';
import { ApiError } from '../api/client';
import { renderWithRouter } from '../testing/renderWithRouter';

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
  };
});

const listMock = vi.mocked(api.listGlobalParams);
const createMock = vi.mocked(api.createGlobalParam);
const updateMock = vi.mocked(api.updateGlobalParam);
const deleteMock = vi.mocked(api.deleteGlobalParam);

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

function row(name: string) {
  return screen.getByRole('group', { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GlobalParamsPage (#844 GL2)', () => {
  it('says the store is cleartext, not for credentials, and not read yet', async () => {
    renderWithRouter(<GlobalParamsPage />);
    expect(await screen.findByText('No global parameters yet.')).toBeInTheDocument();
    // Pinned so GL3, which makes pipelines read globals, has to change it.
    expect(screen.getByText(/Pipelines cannot read them yet/)).toBeInTheDocument();
    expect(screen.getByText('cleartext')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Secrets' })).toHaveAttribute(
      'href',
      '/manage/secrets',
    );
  });

  it('reports a failed load', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    renderWithRouter(<GlobalParamsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load global parameters: boom',
    );
  });

  it('shows a saved global with its name and type LOCKED, and its value', async () => {
    listMock.mockResolvedValue([
      global(),
      global({ id: 'gp_2', name: 'cfg', type: 'json', value: { a: 1 } }),
    ]);
    renderWithRouter(<GlobalParamsPage />);
    const first = await screen.findByRole('group', { name: 'global apiUrl' });
    expect(within(first).getByLabelText('global 1 name')).toHaveAttribute('readonly');
    expect(within(first).getByLabelText('global 1 type')).toHaveAttribute('readonly');
    expect(within(first).getByLabelText('global 1 type')).toHaveValue('string');
    expect(within(first).getByLabelText('global 1 value')).toHaveValue('https://example.test');
    expect(within(row('global cfg')).getByLabelText('global 2 value')).toHaveValue('{"a":1}');
    // Save is off until something changed.
    expect(within(first).getByRole('button', { name: 'save global 1' })).toBeDisabled();
    expect(within(first).getByRole('button', { name: 'delete global 1' })).toHaveTextContent(
      'Delete',
    );
  });

  it('creates a global: POSTs the typed value, then refetches', async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue(global({ name: 'retries', type: 'number', value: 3 }));
    renderWithRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');

    await user.click(screen.getByRole('button', { name: 'Add global parameter' }));
    const draft = row('new global 1');
    expect(within(draft).getByLabelText('global 1 name')).not.toHaveAttribute('readonly');
    await user.type(within(draft).getByLabelText('global 1 name'), 'retries');
    await user.selectOptions(within(draft).getByLabelText('global 1 type'), 'number');
    await user.type(within(draft).getByLabelText('global 1 value'), '3');
    await user.click(within(draft).getByRole('button', { name: 'create global 1' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: 'retries',
        type: 'number',
        value: 3,
        description: '',
      }),
    );
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('refuses an unreadable value locally and sends nothing', async () => {
    const user = userEvent.setup();
    renderWithRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');
    await user.click(screen.getByRole('button', { name: 'Add global parameter' }));
    const draft = row('new global 1');
    await user.type(within(draft).getByLabelText('global 1 name'), 'n');
    await user.selectOptions(within(draft).getByLabelText('global 1 type'), 'number');
    await user.type(within(draft).getByLabelText('global 1 value'), 'abc');
    await user.click(within(draft).getByRole('button', { name: 'create global 1' }));
    expect(await within(draft).findByRole('alert')).toHaveTextContent('expected a number');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a name that cannot be referenced, with the shared rule', async () => {
    const user = userEvent.setup();
    renderWithRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');
    await user.click(screen.getByRole('button', { name: 'Add global parameter' }));
    const draft = row('new global 1');
    await user.type(within(draft).getByLabelText('global 1 name'), 'api-url');
    await user.click(within(draft).getByRole('button', { name: 'create global 1' }));
    expect(await within(draft).findByRole('alert')).toHaveTextContent(
      'cannot be referenced as ${global.<name>}',
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('names a bad name AND a bad value together', async () => {
    const user = userEvent.setup();
    renderWithRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');
    await user.click(screen.getByRole('button', { name: 'Add global parameter' }));
    const draft = row('new global 1');
    await user.type(within(draft).getByLabelText('global 1 name'), 'api-url');
    await user.selectOptions(within(draft).getByLabelText('global 1 type'), 'number');
    await user.click(within(draft).getByRole('button', { name: 'create global 1' }));
    const alert = await within(draft).findByRole('alert');
    expect(alert).toHaveTextContent('cannot be referenced');
    expect(alert).toHaveTextContent('a number global needs a value');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('names the case-insensitive duplicate on a 409', async () => {
    const user = userEvent.setup();
    createMock.mockRejectedValue(new ApiError(409, 'conflict', undefined));
    renderWithRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');
    await user.click(screen.getByRole('button', { name: 'Add global parameter' }));
    const draft = row('new global 1');
    await user.type(within(draft).getByLabelText('global 1 name'), 'ApiUrl');
    await user.click(within(draft).getByRole('button', { name: 'create global 1' }));
    expect(await within(draft).findByRole('alert')).toHaveTextContent(
      'A global parameter named “ApiUrl” already exists. Names ignore case.',
    );
  });

  it('saves only what changed — a cleared description is sent as empty text', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global()]);
    updateMock.mockResolvedValue(global({ description: '' }));
    renderWithRouter(<GlobalParamsPage />);
    const saved = await screen.findByRole('group', { name: 'global apiUrl' });
    await user.clear(within(saved).getByLabelText('global 1 description'));
    await user.click(within(saved).getByRole('button', { name: 'save global 1' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('gp_1', { description: '' }));
  });

  it('checks a changed value against the STORED type before sending', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global({ type: 'number', value: 3 })]);
    updateMock.mockResolvedValue(global({ type: 'number', value: 4 }));
    renderWithRouter(<GlobalParamsPage />);
    const saved = await screen.findByRole('group', { name: 'global apiUrl' });
    const value = within(saved).getByLabelText('global 1 value');

    await user.clear(value);
    await user.type(value, 'x');
    await user.click(within(saved).getByRole('button', { name: 'save global 1' }));
    expect(await within(saved).findByRole('alert')).toHaveTextContent('expected a number');
    expect(updateMock).not.toHaveBeenCalled();

    await user.clear(value);
    await user.type(value, '4');
    await user.click(within(saved).getByRole('button', { name: 'save global 1' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('gp_1', { value: 4 }));
  });

  it('refuses a json value that would not replay (1e400 is Infinity), before sending', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global({ type: 'json', value: { a: 1 } })]);
    renderWithRouter(<GlobalParamsPage />);
    const saved = await screen.findByRole('group', { name: 'global apiUrl' });
    const value = within(saved).getByLabelText('global 1 value');
    await user.clear(value);
    await user.click(value);
    await user.paste('{"a":1e400}');
    await user.click(within(saved).getByRole('button', { name: 'save global 1' }));
    expect(await within(saved).findByRole('alert')).toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('keeps an unsaved edit on one row when ANOTHER row saves', async () => {
    const user = userEvent.setup();
    const b = global({ id: 'gp_2', name: 'b' });
    listMock.mockResolvedValue([global(), b]);
    updateMock.mockResolvedValue({ ...b, value: 'new-b', updatedAt: b.updatedAt + 1 });
    renderWithRouter(<GlobalParamsPage />);
    const first = await screen.findByRole('group', { name: 'global apiUrl' });
    await user.clear(within(first).getByLabelText('global 1 value'));
    await user.type(within(first).getByLabelText('global 1 value'), 'unsaved');

    listMock.mockResolvedValue([global(), { ...b, value: 'new-b', updatedAt: b.updatedAt + 1 }]);
    const second = row('global b');
    await user.clear(within(second).getByLabelText('global 2 value'));
    await user.type(within(second).getByLabelText('global 2 value'), 'new-b');
    await user.click(within(second).getByRole('button', { name: 'save global 2' }));

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(within(row('global apiUrl')).getByLabelText('global 1 value')).toHaveValue('unsaved');
    expect(within(row('global b')).getByLabelText('global 2 value')).toHaveValue('new-b');
  });

  it('deletes only after the confirmation, and not when it is cancelled', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([global()]);
    deleteMock.mockResolvedValue(undefined);
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderWithRouter(<GlobalParamsPage />);
    const saved = await screen.findByRole('group', { name: 'global apiUrl' });

    await user.click(within(saved).getByRole('button', { name: 'delete global 1' }));
    expect(deleteMock).not.toHaveBeenCalled();

    await user.click(within(saved).getByRole('button', { name: 'delete global 1' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('gp_1'));
    expect(confirm.mock.calls[0]![0]).toContain('"apiUrl"');
  });

  it('discards an unsaved new row without a request', async () => {
    const user = userEvent.setup();
    renderWithRouter(<GlobalParamsPage />);
    await screen.findByText('No global parameters yet.');
    await user.click(screen.getByRole('button', { name: 'Add global parameter' }));
    await user.click(screen.getByRole('button', { name: 'remove global 1' }));
    expect(screen.queryByRole('group', { name: 'new global 1' })).toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
