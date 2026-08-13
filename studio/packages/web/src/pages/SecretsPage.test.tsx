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
    rotateSecret: vi.fn(),
    deleteSecret: vi.fn(),
  };
});

const listMock = vi.mocked(api.listSecrets);
const createMock = vi.mocked(api.createSecret);
const rotateMock = vi.mocked(api.rotateSecret);
const deleteMock = vi.mocked(api.deleteSecret);

/** A promise this test resolves by hand, so a load can be held open across
 *  other interactions and answered out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

  it('does not let the MOUNT load overwrite the list a create just refreshed', async () => {
    // The New secret button is not gated behind the list having arrived, so a
    // create can complete while the initial load is still in flight. Without a
    // latest-wins guard the mount load lands second and writes a list taken
    // BEFORE the secret existed — the new row appears, then silently vanishes
    // from the one surface that exists to confirm it was stored.
    const user = userEvent.setup();
    const mountLoad = deferred<api.NamedSecret[]>();
    listMock.mockReturnValueOnce(mountLoad.promise);
    createMock.mockResolvedValue(secret());
    renderWithRouter(<SecretsPage />);

    // The mount load is held open; the form is reachable regardless.
    await user.click(screen.getByRole('button', { name: 'New secret' }));
    await user.type(screen.getByLabelText('Name'), 'stripe-key');
    await user.type(screen.getByLabelText('Value'), 'sk_live_123');

    // The post-create refresh resolves FIRST, with the secret present.
    listMock.mockResolvedValue([secret()]);
    await user.click(screen.getByRole('button', { name: 'Create secret' }));
    expect(await screen.findByText('stripe-key')).toBeInTheDocument();

    // ...and only now does the stale mount load answer, with the empty list it
    // was always going to return.
    mountLoad.resolve([]);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));

    expect(screen.getByText('stripe-key')).toBeInTheDocument();
    expect(screen.queryByText(/No secrets yet/)).not.toBeInTheDocument();
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
    expect(alert).toHaveTextContent('“Stripe-Key” and “stripe-key” are the same name');
    expect(alert).not.toHaveTextContent('The request conflicts with existing data.');
  });

  it('states the case rule WITHOUT the two-spelling example when the name is already lower case', async () => {
    // The example contrasts the typed name with its lower-cased form, so on an
    // already-lower-case name it would read «“stripe-key” and “stripe-key” are
    // the same name» — the sentence that is supposed to EXPLAIN the collision
    // instead reads as a typo. The rule still has to be stated; only the
    // example drops.
    const user = userEvent.setup();
    createMock.mockRejectedValue(
      new ApiError(409, 'The request conflicts with existing data.', undefined),
    );
    renderWithRouter(<SecretsPage />);
    await screen.findByText(/No secrets yet/);

    await user.click(screen.getByRole('button', { name: 'New secret' }));
    await user.type(screen.getByLabelText('Name'), 'stripe-key');
    await user.type(screen.getByLabelText('Value'), 'sk_live_123');
    await user.click(screen.getByRole('button', { name: 'Create secret' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A secret named “stripe-key” already exists');
    expect(alert).toHaveTextContent('Secret names ignore case.');
    expect(alert).not.toHaveTextContent('are the same name');
    expect(alert).toHaveTextContent('Use Replace to change its value.');
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
    // Deleting is not how a value is rotated any more (#1061 added Replace),
    // but it is still how a name is retired — and that breaks every node
    // referencing it, so the confirmation has to say what it costs.
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    listMock.mockResolvedValue([secret()]);
    renderWithRouter(<SecretsPage />);
    await screen.findByText('stripe-key');

    await user.click(screen.getByRole('button', { name: 'Delete stripe-key' }));

    expect(confirmSpy.mock.calls[0]![0]).toContain('{"$secret":"stripe-key"}');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  /**
   * #1061 — REPLACE. Before this existed, changing a value meant deleting the
   * secret and creating it again under the same name, which leaves a window
   * where `{ "$secret": "<name>" }` resolves to nothing and any node
   * dispatching inside it fails. These prove the page reaches the rotate route
   * instead: a mocked api cannot prove the window is gone (that is the server
   * suite's job), but it CAN prove the page never takes the delete-then-create
   * path.
   */
  describe('replacing a value in place (#1061)', () => {
    it('sends only the new value to rotateSecret, and never deletes', async () => {
      const user = userEvent.setup();
      rotateMock.mockResolvedValue(secret());
      listMock.mockResolvedValue([secret()]);
      renderWithRouter(<SecretsPage />);
      await screen.findByText('stripe-key');

      await user.click(screen.getByRole('button', { name: 'Replace stripe-key' }));
      await user.type(screen.getByLabelText('Value'), 'sk_live_rotated');
      await user.click(screen.getByRole('button', { name: 'Replace value' }));

      await waitFor(() =>
        expect(rotateMock).toHaveBeenCalledWith('sec_1', { secret: 'sk_live_rotated' }),
      );
      // The whole point: rotation is ONE call. A delete here would reopen the
      // window this ticket closed.
      expect(deleteMock).not.toHaveBeenCalled();
      expect(createMock).not.toHaveBeenCalled();
      // Two loads: the mount, then the post-mutation refresh.
      await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
      // The form closes on success.
      expect(screen.queryByRole('button', { name: 'Replace value' })).not.toBeInTheDocument();
    });

    it('does not let the name be edited — it is the lookup key, not a field', async () => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([secret()]);
      renderWithRouter(<SecretsPage />);
      await screen.findByText('stripe-key');

      await user.click(screen.getByRole('button', { name: 'Replace stripe-key' }));

      // The form names its target (there is no other confirmation step) and
      // shows the name as read-only: the route refuses a rename with a 400, so
      // an editable field here would only offer an error.
      const name = screen.getByLabelText('Name');
      expect(name).toHaveValue('stripe-key');
      expect(name).toHaveAttribute('readonly');
      expect(screen.getByRole('heading', { name: /Replace value for stripe-key/ })).toBeVisible();
    });

    it('reports a failed rotation without claiming a duplicate name', async () => {
      const user = userEvent.setup();
      // A rotation cannot 409 — the name is not changing — so the create
      // form's duplicate-name explanation must not leak onto this path.
      rotateMock.mockRejectedValue(new ApiError(500, 'Internal Server Error', undefined));
      listMock.mockResolvedValue([secret()]);
      renderWithRouter(<SecretsPage />);
      await screen.findByText('stripe-key');

      await user.click(screen.getByRole('button', { name: 'Replace stripe-key' }));
      await user.type(screen.getByLabelText('Value'), 'sk_live_rotated');
      await user.click(screen.getByRole('button', { name: 'Replace value' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Internal Server Error');
      expect(alert).not.toHaveTextContent(/already exists/);
      // Still open, so the operator can retry without retyping the name.
      expect(screen.getByRole('button', { name: 'Replace value' })).toBeInTheDocument();
    });

    it('creating is still creating — Replace does not capture the New secret button', async () => {
      const user = userEvent.setup();
      createMock.mockResolvedValue(secret({ id: 'sec_2', name: 'openai-key' }));
      listMock.mockResolvedValue([secret()]);
      renderWithRouter(<SecretsPage />);
      await screen.findByText('stripe-key');

      await user.click(screen.getByRole('button', { name: 'New secret' }));
      await user.type(screen.getByLabelText('Name'), 'openai-key');
      await user.type(screen.getByLabelText('Value'), 'sk_new');
      await user.click(screen.getByRole('button', { name: 'Create secret' }));

      await waitFor(() =>
        expect(createMock).toHaveBeenCalledWith({ name: 'openai-key', secret: 'sk_new' }),
      );
      expect(rotateMock).not.toHaveBeenCalled();
    });
  });

  it('aborts an in-flight post-mutation refresh when the page unmounts', async () => {
    // The mount load is abort-guarded; a refresh triggered by a create or a
    // delete has to be too, or navigating away mid-mutation leaves a request
    // running whose settle path still writes state into a dead component.
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValue([secret()]);
    deleteMock.mockResolvedValue(undefined);
    const { unmount } = renderWithRouter(<SecretsPage />);
    await screen.findByText('stripe-key');

    // Hold the post-delete refresh open, so it is genuinely in flight at unmount.
    const refreshLoad = deferred<api.NamedSecret[]>();
    listMock.mockReturnValueOnce(refreshLoad.promise);
    await user.click(screen.getByRole('button', { name: 'Delete stripe-key' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));

    const signal = listMock.mock.calls[1]![0];
    expect(signal?.aborted).toBe(false);

    unmount();

    expect(signal?.aborted).toBe(true);
  });

  it('starts NO refresh at all when the delete itself was still pending at unmount', async () => {
    // The sibling test above covers a refresh already in flight at unmount. This
    // is the earlier timing: unmount lands while `deleteSecret` is still
    // awaiting, so the cleanup nulls the controller ref BEFORE the continuation
    // reaches `refresh` — there is no signal left to capture. Falling back to an
    // unguarded load would start an unabortable request on behalf of a component
    // that no longer exists, so the refresh must not be issued at all.
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValue([secret()]);
    const pendingDelete = deferred<void>();
    deleteMock.mockReturnValue(pendingDelete.promise);
    const { unmount } = renderWithRouter(<SecretsPage />);
    await screen.findByText('stripe-key');
    expect(listMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Delete stripe-key' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));

    // Unmount while the DELETE is still in flight, then let it resolve.
    unmount();
    pendingDelete.resolve();
    await pendingDelete.promise;

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
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
