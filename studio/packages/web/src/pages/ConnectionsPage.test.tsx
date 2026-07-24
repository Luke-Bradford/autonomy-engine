import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectionPublic } from '@autonomy-studio/shared';
import { ConnectionsPage } from './ConnectionsPage';
import * as api from '../api/connections';

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

const listMock = vi.mocked(api.listConnections);
const createMock = vi.mocked(api.createConnection);
const updateMock = vi.mocked(api.updateConnection);
const deleteMock = vi.mocked(api.deleteConnection);

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConnectionsPage', () => {
  it('shows the empty state after loading', async () => {
    render(<ConnectionsPage />);
    expect(await screen.findByText(/No connections yet/i)).toBeInTheDocument();
  });

  it('renders a connection row with its kind', async () => {
    listMock.mockResolvedValue([conn({ name: 'My Claude', kind: 'anthropic_api' })]);
    render(<ConnectionsPage />);
    expect(await screen.findByText('My Claude')).toBeInTheDocument();
    expect(screen.getByText('anthropic_api')).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    render(<ConnectionsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('creates a connection from the form', async () => {
    const user = userEvent.setup();
    render(<ConnectionsPage />);
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

  it('rejects invalid config JSON without calling the API', async () => {
    const user = userEvent.setup();
    render(<ConnectionsPage />);
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
    render(<ConnectionsPage />);
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
    render(<ConnectionsPage />);
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
    render(<ConnectionsPage />);
    await screen.findByText(/No connections yet/i);
    expect(listMock).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('deletes a connection after confirmation', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([conn({ name: 'Doomed' })]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ConnectionsPage />);
    await screen.findByText('Doomed');

    await user.click(screen.getByRole('button', { name: 'Delete Doomed' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('conn_1'));
  });

  it('does not delete when confirmation is cancelled', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([conn({ name: 'Safe' })]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ConnectionsPage />);
    await screen.findByText('Safe');

    await user.click(screen.getByRole('button', { name: 'Delete Safe' }));
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
