import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { ConnectionKind, ConnectionPublic } from '@autonomy-studio/shared';
import {
  createConnection,
  listConnectionDependents,
  listConnections,
  updateConnection,
} from '../../api/connections';
import { listDatasets } from '../../api/datasets';
import { renderWithDataRouter } from '../../testing/renderWithRouter';
import { ConnectionColumn } from './ConnectionColumn';
import { connectionSlotReason } from './bindingPickers';

vi.mock('../../api/connections', async (importActual) => {
  const actual = await importActual<typeof import('../../api/connections')>();
  return {
    ...actual,
    createConnection: vi.fn(),
    updateConnection: vi.fn(),
    listConnections: vi.fn(),
    listConnectionDependents: vi.fn(),
  };
});
vi.mock('../../api/datasets', async (importActual) => {
  const actual = await importActual<typeof import('../../api/datasets')>();
  return { ...actual, listDatasets: vi.fn() };
});
const createMock = vi.mocked(createConnection);
const updateMock = vi.mocked(updateConnection);
const listMock = vi.mocked(listConnections);
const dependentsMock = vi.mocked(listConnectionDependents);
const datasetsMock = vi.mocked(listDatasets);

function row(kind: ConnectionKind, over: Partial<ConnectionPublic> = {}): ConnectionPublic {
  return {
    id: 'conn_new',
    resourceId: 'res_new',
    ownerId: 'local',
    name: 'Prod key',
    kind,
    config: {},
    parameters: [],
    description: '',
    annotations: [],
    secretStatus: 'ready',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** An LLM node's slot: the two API kinds, everything else refused. */
const LLM_SLOT = connectionSlotReason(['anthropic_api', 'openai_api'], 'LLM', 'single');

/** ＋ New, or Edit on `editId` over the editor's `connections` list. */
function mount(edit?: { editId: string; connections: ConnectionPublic[] }) {
  const calls = {
    bind: vi.fn<(id: string) => boolean>(() => true),
    onDirtyChange: vi.fn<(dirty: boolean) => void>(),
    onSaved: vi.fn<(c: ConnectionPublic) => void>(),
    onListed: vi.fn<(list: ConnectionPublic[]) => void>(),
    onNotice: vi.fn<(m: string) => void>(),
    onClose: vi.fn<() => void>(),
  };
  renderWithDataRouter(
    <ConnectionColumn
      request={
        edit === undefined
          ? { mode: 'new', disabledReason: LLM_SLOT, bind: calls.bind }
          : { mode: 'edit', connectionId: edit.editId, disabledReason: LLM_SLOT }
      }
      connections={edit?.connections ?? []}
      returnFocusTo={createRef<HTMLElement>()}
      onClose={calls.onClose}
      onListed={calls.onListed}
      onSaved={calls.onSaved}
      onNotice={calls.onNotice}
      onDirtyChange={calls.onDirtyChange}
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

describe('ConnectionColumn, New (#1477 slice 5b)', () => {
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
    expect(calls.onSaved).toHaveBeenCalledWith(row('anthropic_api'));
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
    expect(calls.onSaved).toHaveBeenCalled();
    expect(calls.bind).not.toHaveBeenCalled();
    expect(calls.onNotice).toHaveBeenCalledWith(
      "Created Prod key (Ollama), not bound here. LLM can't use this kind yet.",
    );
  });

  it('reports a typed draft up as dirty, so the editor’s leave guard holds it', async () => {
    const user = userEvent.setup();
    const calls = mount();
    await user.click(await screen.findByRole('button', { name: 'Anthropic API' }));
    expect(calls.onDirtyChange).toHaveBeenLastCalledWith(false);
    await user.type(screen.getByLabelText('Name'), 'P');
    expect(calls.onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('says so when the activity was deleted before Create', async () => {
    createMock.mockResolvedValue(row('anthropic_api'));
    const user = userEvent.setup();
    const calls = mount();
    calls.bind.mockReturnValue(false);
    await createAnthropic(user);
    expect(calls.onSaved).toHaveBeenCalled();
    expect(calls.onNotice).toHaveBeenCalledWith(
      'Created Prod key (Anthropic API), not bound: the activity was deleted.',
    );
  });
});

describe('ConnectionColumn, Edit (#1477 slice 5c)', () => {
  const stale = row('anthropic_api', { name: 'Old name', updatedAt: 1 });
  const fresh = row('anthropic_api', { name: 'Fresh name', updatedAt: 2 });

  beforeEach(() => {
    updateMock.mockReset();
    listMock.mockReset();
    dependentsMock.mockReset();
    datasetsMock.mockReset();
    listMock.mockResolvedValue([fresh]);
    datasetsMock.mockResolvedValue([]);
    dependentsMock.mockResolvedValue({ triggers: [], dynamic: [], nodes: [], dynamicNodes: [] });
  });

  it('reads the connection AGAIN and prefills from that row, not the editor’s stale one', async () => {
    const calls = mount({ editId: 'conn_new', connections: [stale] });
    expect(await screen.findByLabelText('Name')).toHaveValue('Fresh name');
    expect(screen.getByRole('region', { name: 'Edit connection' })).toBeInTheDocument();
    expect(calls.onListed).toHaveBeenCalledWith([fresh]);
    // The edit form's advisories are read for this connection, on open.
    expect(dependentsMock).toHaveBeenCalledWith('conn_new', expect.anything());
    expect(datasetsMock).toHaveBeenCalled();
  });

  it('Save updates the row, hands it back, binds nothing, and closes', async () => {
    const saved = row('anthropic_api', { name: 'Fresh name 2', updatedAt: 3 });
    updateMock.mockResolvedValue(saved);
    const user = userEvent.setup();
    const calls = mount({ editId: 'conn_new', connections: [fresh] });
    await user.type(await screen.findByLabelText('Name'), ' 2');
    expect(calls.onDirtyChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateMock).toHaveBeenCalledWith(
      'conn_new',
      expect.objectContaining({ name: 'Fresh name 2' }),
    );
    expect(createMock).not.toHaveBeenCalled();
    expect(calls.onSaved).toHaveBeenCalledWith(saved);
    expect(calls.bind).not.toHaveBeenCalled();
    expect(calls.onNotice).not.toHaveBeenCalled();
    expect(calls.onClose).toHaveBeenCalled();
  });

  it('says so when the save moves the kind to one this slot refuses', async () => {
    updateMock.mockResolvedValue(row('ollama', { name: 'Fresh name', updatedAt: 3 }));
    const user = userEvent.setup();
    const calls = mount({ editId: 'conn_new', connections: [fresh] });
    await user.selectOptions(await screen.findByLabelText('Kind'), 'ollama');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(calls.onNotice).toHaveBeenCalledWith(
      "Saved Fresh name (Ollama). LLM can't use this kind yet, so runs will refuse it here.",
    );
  });

  it('closes with a notice when the connection was deleted elsewhere', async () => {
    listMock.mockResolvedValue([]);
    const calls = mount({ editId: 'conn_new', connections: [stale] });
    await vi.waitFor(() => expect(calls.onClose).toHaveBeenCalled());
    expect(calls.onNotice).toHaveBeenCalledWith('That connection no longer exists.');
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it('reports a failed read instead of opening a form on stale values', async () => {
    listMock.mockRejectedValue(new Error('server down'));
    mount({ editId: 'conn_new', connections: [stale] });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the connection: server down',
    );
    expect(screen.queryByLabelText('Name')).toBeNull();
  });
});
