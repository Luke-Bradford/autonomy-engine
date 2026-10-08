import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { ConnectionKind, ConnectionPublic } from '@autonomy-studio/shared';
import { createConnection } from '../../api/connections';
import { renderWithDataRouter } from '../../testing/renderWithRouter';
import { NewConnectionColumn } from './NewConnectionColumn';
import { connectionSlotReason } from './bindingPickers';

vi.mock('../../api/connections', async (importActual) => {
  const actual = await importActual<typeof import('../../api/connections')>();
  return { ...actual, createConnection: vi.fn() };
});
const createMock = vi.mocked(createConnection);

function row(kind: ConnectionKind): ConnectionPublic {
  return {
    id: 'conn_new',
    resourceId: 'res_new',
    ownerId: 'local',
    name: 'Prod key',
    kind,
    config: {},
    parameters: [],
    secretStatus: 'ready',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** An LLM node's slot: the two API kinds, everything else refused. */
function mount() {
  const calls = {
    bind: vi.fn<(id: string) => void>(),
    onCreated: vi.fn<(c: ConnectionPublic) => void>(),
    onNotice: vi.fn<(m: string) => void>(),
    onClose: vi.fn<() => void>(),
  };
  renderWithDataRouter(
    <NewConnectionColumn
      request={{
        disabledReason: connectionSlotReason(['anthropic_api', 'openai_api'], 'LLM', 'single'),
        bind: calls.bind,
      }}
      returnFocusTo={createRef<HTMLElement>()}
      onClose={calls.onClose}
      onCreated={calls.onCreated}
      onNotice={calls.onNotice}
      onDirtyChange={() => {}}
    />,
  );
  return calls;
}

async function createAnthropic(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Anthropic API' }));
  await user.type(screen.getByLabelText('Name'), 'Prod key');
  await user.type(screen.getByLabelText('Secret'), 'sk-secret');
  await user.click(screen.getByRole('button', { name: 'Create connection' }));
}

describe('NewConnectionColumn (#1477 slice 5b)', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('opens on the gallery with the slot’s refused kinds disabled, and why', async () => {
    mount();
    const sqlite = await screen.findByRole('button', { name: 'SQLite' });
    expect(sqlite).toHaveAttribute('aria-disabled', 'true');
    expect(sqlite).toHaveAccessibleDescription(/LLM can't use this kind yet/);
    expect(screen.getByRole('button', { name: 'Anthropic API' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('Create adds the row, binds it to the slot that asked, and closes', async () => {
    createMock.mockResolvedValue(row('anthropic_api'));
    const user = userEvent.setup();
    const calls = mount();
    await createAnthropic(user);
    expect(calls.onCreated).toHaveBeenCalledWith(row('anthropic_api'));
    expect(calls.bind).toHaveBeenCalledWith('conn_new');
    expect(calls.onNotice).not.toHaveBeenCalled();
    expect(calls.onClose).toHaveBeenCalled();
  });

  it('does NOT bind a connection whose kind the form was switched to a refused one', async () => {
    // The form keeps its Kind select after the gallery pick, so the draft can
    // leave the slot's kinds. The row is still valid and is still created —
    // but binding it would write what the dispatch refuses.
    createMock.mockResolvedValue(row('ollama'));
    const user = userEvent.setup();
    const calls = mount();
    await user.click(await screen.findByRole('button', { name: 'Anthropic API' }));
    await user.selectOptions(screen.getByLabelText('Kind'), 'ollama');
    await user.type(screen.getByLabelText('Name'), 'Prod key');
    await user.click(screen.getByRole('button', { name: 'Create connection' }));
    expect(calls.onCreated).toHaveBeenCalled();
    expect(calls.bind).not.toHaveBeenCalled();
    expect(calls.onNotice).toHaveBeenCalledWith(
      "Created Prod key (Ollama), not bound here. LLM can't use this kind yet.",
    );
  });
});
