import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretsPage } from './SecretsPage';
import * as api from '../api/secrets';
import { ApiError } from '../api/client';
import { renderWithRouter } from '../testing/renderWithRouter';

// Mock only the network calls; `SecretWriteSchema` stays REAL so the form's
// client-side validation is exercised exactly as it ships.
vi.mock('../api/secrets', async (importActual) => {
  const actual = await importActual<typeof import('../api/secrets')>();
  return {
    ...actual,
    listSecrets: vi.fn(),
    createSecret: vi.fn(),
    deleteSecret: vi.fn(),
  };
});

const listMock = vi.mocked(api.listSecrets);
const createMock = vi.mocked(api.createSecret);
const deleteMock = vi.mocked(api.deleteSecret);

function secret(overrides: Partial<api.NamedSecret> = {}): api.NamedSecret {
  return {
    id: 'sec_1',
    ownerId: 'local',
    name: 'stripe-key',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SecretsPage', () => {
  it('lists the owner’s secrets by name', async () => {
    listMock.mockResolvedValue([secret(), secret({ id: 'sec_2', name: 'openai-key' })]);
    renderWithRouter(<SecretsPage />);

    expect(await screen.findByText('stripe-key')).toBeInTheDocument();
    expect(screen.getByText('openai-key')).toBeInTheDocument();
  });

  it('says how a node references a secret — the marker is the whole point of the page', async () => {
    renderWithRouter(<SecretsPage />);
    expect(await screen.findByText(/\{"\$secret": "<name>"\}/)).toBeInTheDocument();
  });

  it('reports a failed load AS a failure, never as an empty vault', async () => {
    // The dangerous fold: "no secrets" and "could not read your secrets" look
    // identical if a load error renders the empty state, and the second one
    // would invite an operator to re-create a credential they already have.
    listMock.mockRejectedValue(new Error('network down'));
    renderWithRouter(<SecretsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load secrets: network down',
    );
    expect(screen.queryByText(/No secrets yet/)).not.toBeInTheDocument();
  });

  it('creates a secret and refreshes the list', async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue(secret());
    renderWithRouter(<SecretsPage />);
    await screen.findByText(/No secrets yet/);

    await user.click(screen.getByRole('button', { name: 'New secret' }));
    await user.type(screen.getByLabelText('Name'), 'stripe-key');
    await user.type(screen.getByLabelText('Value'), 'sk_live_123');
    listMock.mockResolvedValue([secret()]);
    await user.click(screen.getByRole('button', { name: 'Create secret' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({ name: 'stripe-key', secret: 'sk_live_123' });
    expect(await screen.findByText('stripe-key')).toBeInTheDocument();
    // The form closed, so the typed credential is no longer on screen.
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
  });

  it('refuses an untrimmed name client-side, without a round trip', async () => {
    // The shared write schema is the SAME object the route parses, so the form
    // rejects exactly what the server would have 400'd — proving the schema is
    // genuinely wired in rather than re-declared loosely on this side.
    const user = userEvent.setup();
    renderWithRouter(<SecretsPage />);
    await screen.findByText(/No secrets yet/);

    await user.click(screen.getByRole('button', { name: 'New secret' }));
    await user.type(screen.getByLabelText('Name'), 'stripe-key ');
    await user.type(screen.getByLabelText('Value'), 'sk_live_123');
    await user.click(screen.getByRole('button', { name: 'Create secret' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /must not be blank or have leading\/trailing whitespace/,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('explains a duplicate name, INCLUDING that names ignore case', async () => {
    // The server answers every unique-constraint violation with one generic
    // sentence, which on this form cannot be acted on. Without this the
    // likeliest first-use failure — a case-variant of an existing name — reads
    // as an unexplained conflict.
    const user = userEvent.setup();
    createMock.mockRejectedValue(
      new ApiError(409, 'The request conflicts with existing data.', undefined),
    );
    renderWithRouter(<SecretsPage />);
    await screen.findByText(/No secrets yet/);

    await user.click(screen.getByRole('button', { name: 'New secret' }));
    await user.type(screen.getByLabelText('Name'), 'Stripe-Key');
    await user.type(screen.getByLabelText('Value'), 'sk_live_123');
    await user.click(screen.getByRole('button', { name: 'Create secret' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A secret named “Stripe-Key” already exists');
    expect(alert).toHaveTextContent(/ignore case/);
    expect(alert).not.toHaveTextContent('The request conflicts with existing data.');
  });

  it('surfaces a NON-conflict create failure as itself, not as a duplicate name', async () => {
    const user = userEvent.setup();
    createMock.mockRejectedValue(new ApiError(500, 'Internal Server Error', undefined));
    renderWithRouter(<SecretsPage />);
    await screen.findByText(/No secrets yet/);

    await user.click(screen.getByRole('button', { name: 'New secret' }));
    await user.type(screen.getByLabelText('Name'), 'stripe-key');
    await user.type(screen.getByLabelText('Value'), 'sk_live_123');
    await user.click(screen.getByRole('button', { name: 'Create secret' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Internal Server Error');
    expect(alert).not.toHaveTextContent(/already exists/);
  });

  it('deletes after a confirmation, and refreshes', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValue([secret()]);
    deleteMock.mockResolvedValue(undefined);
    renderWithRouter(<SecretsPage />);
    await screen.findByText('stripe-key');

    listMock.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Delete stripe-key' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('sec_1'));
    expect(await screen.findByText(/No secrets yet/)).toBeInTheDocument();
  });

  it('warns that deleting breaks the nodes referencing that name', async () => {
    // Delete is also the only way to ROTATE a value (there is no update
    // route), so the confirmation has to say what it costs.
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    listMock.mockResolvedValue([secret()]);
    renderWithRouter(<SecretsPage />);
    await screen.findByText('stripe-key');

    await user.click(screen.getByRole('button', { name: 'Delete stripe-key' }));

    expect(confirmSpy.mock.calls[0]![0]).toContain('{"$secret":"stripe-key"}');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('reports a failed delete instead of leaving the row silently in place', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValue([secret()]);
    deleteMock.mockRejectedValue(new Error('nope'));
    renderWithRouter(<SecretsPage />);
    await screen.findByText('stripe-key');

    await user.click(screen.getByRole('button', { name: 'Delete stripe-key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete “stripe-key”');
    expect(screen.getByText('stripe-key')).toBeInTheDocument();
  });
});
