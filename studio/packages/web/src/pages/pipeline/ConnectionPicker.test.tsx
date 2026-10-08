import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { ConnectionPublic } from '@autonomy-studio/shared';
import { testSavedConnection } from '../../api/connections';
import { ConnectionPicker } from './ConnectionPicker';
import { connectionSlotReason } from './bindingPickers';

vi.mock('../../api/connections', async (importActual) => {
  const actual = await importActual<typeof import('../../api/connections')>();
  return { ...actual, testSavedConnection: vi.fn() };
});
const probe = vi.mocked(testSavedConnection);

const conn = (
  id: string,
  name: string,
  kind: 'sqlite' | 'fs',
  config: Record<string, unknown> = {},
): ConnectionPublic =>
  ({
    id,
    name,
    kind,
    config,
    parameters: [],
    secretStatus: 'not_required',
    ownerId: null,
    resourceId: `r_${id}`,
    secretRef: null,
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as ConnectionPublic;

const CONNS = [conn('a', 'Alpha', 'sqlite'), conn('b', 'Beta', 'sqlite')];

function Harness({
  initial,
  connections = CONNS,
  onEdit,
  onNew,
  onPick,
}: {
  initial?: string;
  connections?: ConnectionPublic[];
  onEdit?: (id: string, opener: HTMLElement) => void;
  onNew?: (opener: HTMLElement) => void;
  onPick?: (id: string | undefined) => void;
}) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <ConnectionPicker
      label="Source connection"
      value={value}
      connections={connections}
      disabledReason={connectionSlotReason(['sqlite'], 'Copy Data', 'source')}
      onPick={(id) => {
        onPick?.(id);
        setValue(id);
      }}
      onEdit={onEdit}
      onNew={onNew}
    />
  );
}

const testButton = () => screen.getByRole('button', { name: 'Test selected source connection' });
const picker = () => screen.getByRole('combobox', { name: 'Source connection' });
/** Open the list and type into it, as an author searching does. */
function search(text: string) {
  if (picker().getAttribute('aria-expanded') !== 'true') fireEvent.click(picker());
  fireEvent.change(picker(), { target: { value: text } });
}
/** Open the list and click the option whose name starts with `name`. */
function pick(name: string) {
  fireEvent.click(picker());
  fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${name}`) }));
}

describe('ConnectionPicker (#1477 slice 5b)', () => {
  beforeEach(() => {
    probe.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('cannot Test with nothing selected', () => {
    render(<Harness />);
    expect(testButton()).toBeDisabled();
  });

  it('Test probes the SAVED connection that is selected and shows its verdict', async () => {
    probe.mockResolvedValue({ ok: true, probed: 'liveness' });
    render(<Harness initial="b" />);
    await act(async () => {
      fireEvent.click(testButton());
    });
    expect(probe).toHaveBeenCalledWith('b');
    expect(screen.getByRole('status')).toHaveTextContent('Connected.');
  });

  it('drops the verdict once the selection moves: it was about the other connection', async () => {
    probe.mockResolvedValue({ ok: true, probed: 'liveness' });
    render(<Harness initial="a" />);
    await act(async () => {
      fireEvent.click(testButton());
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    pick('Beta');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports a request that failed as a failed verdict, not silence', async () => {
    probe.mockRejectedValue(new Error('HTTP 404: connection not found'));
    render(<Harness initial="a" />);
    await act(async () => {
      fireEvent.click(testButton());
    });
    expect(screen.getByRole('status')).toHaveTextContent('HTTP 404: connection not found');
    expect(screen.getByRole('status')).toHaveClass('probe-failed');
  });

  it('a re-pick drops the verdict even when it comes back to the probed connection', async () => {
    // The reading was from one moment; coming back to it later must not show it
    // again as though it were current.
    probe.mockResolvedValue({ ok: true, probed: 'liveness' });
    render(<Harness initial="a" />);
    await act(async () => {
      fireEvent.click(testButton());
    });
    pick('Beta');
    pick('Alpha');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('drops a probe that was in flight across a re-pick, even back to the same connection', async () => {
    let answer!: (r: { ok: true; probed: 'liveness' }) => void;
    probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    render(<Harness initial="a" />);
    fireEvent.click(testButton());
    pick('Beta');
    // The re-pick frees Test for the new choice rather than waiting on the old probe.
    expect(testButton()).toBeEnabled();
    pick('Alpha');
    await act(async () => {
      answer({ ok: true, probed: 'liveness' });
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  describe('Edit (#1477 slice 5c)', () => {
    const editButton = () =>
      screen.getByRole('button', { name: 'Edit selected source connection' });

    it('opens the BOUND connection, from the Edit button', () => {
      const onEdit = vi.fn<(id: string, opener: HTMLElement) => void>();
      render(<Harness initial="b" onEdit={onEdit} />);
      fireEvent.click(editButton());
      expect(onEdit).toHaveBeenCalledWith('b', editButton());
    });

    it('cannot Edit with nothing bound, or a binding whose connection is gone', () => {
      const onEdit = vi.fn<(id: string, opener: HTMLElement) => void>();
      const { unmount } = render(<Harness onEdit={onEdit} />);
      expect(editButton()).toBeDisabled();
      unmount();
      render(<Harness initial="gone" onEdit={onEdit} />);
      expect(editButton()).toBeDisabled();
      fireEvent.click(editButton());
      expect(onEdit).not.toHaveBeenCalled();
    });

    it('drops a Test verdict once the connection is edited: it was about the old one', async () => {
      probe.mockResolvedValue({ ok: true, probed: 'liveness' });
      const { rerender } = render(<Harness initial="a" />);
      fireEvent.click(testButton());
      expect(await screen.findByText(/Connected/)).toBeInTheDocument();
      const edited = [{ ...CONNS[0]!, name: 'Alpha 2', updatedAt: 5 }, CONNS[1]!];
      rerender(<Harness initial="a" connections={edited} />);
      expect(screen.queryByText(/Connected/)).toBeNull();
    });
  });

  describe('the list (#1477 slice 5c)', () => {
    const MIXED = [
      conn('a', 'Alpha', 'sqlite', { path: '/srv/alpha.sqlite' }),
      conn('b', 'Beta', 'sqlite', { path: '/srv/beta.sqlite' }),
      conn('f', 'Files', 'fs', { roots: ['/in'] }),
    ];
    const option = (name: string) => screen.getByRole('option', { name: new RegExp(`^${name}`) });

    it('shows the bound connection by name and kind, closed', () => {
      render(<Harness initial="b" />);
      expect(picker()).toHaveValue('Beta (SQLite)');
    });

    it('lists each connection with where it points, grouped by kind', () => {
      render(<Harness connections={MIXED} />);
      fireEvent.click(picker());
      expect(option('Alpha')).toHaveTextContent('/srv/alpha.sqlite');
      expect(screen.getByRole('group', { name: 'SQLite' })).toContainElement(option('Beta'));
      expect(screen.getByRole('group', { name: 'File system' })).toContainElement(option('Files'));
    });

    it('lists a kind this slot refuses disabled, with the reason', () => {
      const onPick = vi.fn();
      render(<Harness connections={MIXED} onPick={onPick} />);
      fireEvent.click(picker());
      expect(option('Files')).toHaveAttribute('aria-disabled', 'true');
      expect(option('Files')).toHaveTextContent("Can't be a Copy Data source yet");
      fireEvent.click(option('Files'));
      expect(onPick).not.toHaveBeenCalled();
    });

    it('filters on what is typed, by name or location', () => {
      render(<Harness connections={MIXED} />);
      search('beta.sql');
      expect(picker()).toHaveValue('beta.sql');
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
        'None',
        'Beta/srv/beta.sqlite',
      ]);
      search('zzz');
      expect(screen.getByRole('option', { name: 'No connections match' })).toBeInTheDocument();
    });

    it('typing a search is not an unbind, and closing the list restores the binding', () => {
      const onPick = vi.fn();
      render(<Harness initial="a" connections={MIXED} onPick={onPick} />);
      // Text that matches nothing, then nothing at all: each is where Fluent
      // clears its own selection, which must not reach the binding.
      search('zzz');
      expect(picker()).toHaveValue('zzz');
      search('');
      expect(onPick).not.toHaveBeenCalled();
      fireEvent.keyDown(picker(), { key: 'Escape' });
      expect(picker()).toHaveValue('Alpha (SQLite)');
      expect(onPick).not.toHaveBeenCalled();
    });

    it('a pick ends the search: the picker reads the new binding', () => {
      render(<Harness connections={MIXED} />);
      search('alp');
      fireEvent.click(option('Alpha'));
      expect(picker()).toHaveValue('Alpha (SQLite)');
    });

    it('None unbinds', () => {
      const onPick = vi.fn();
      render(<Harness initial="a" onPick={onPick} />);
      pick('None');
      expect(onPick).toHaveBeenCalledWith(undefined);
      expect(picker()).toHaveValue('');
    });

    it('shows a bound id with no connection behind it, not a blank that reads as unbound', () => {
      render(<Harness initial="gone" />);
      expect(picker()).toHaveValue('gone (not found)');
    });

    it('New connection… in the list opens the New column from the picker', () => {
      const onNew = vi.fn<(opener: HTMLElement) => void>();
      const onPick = vi.fn();
      render(<Harness onNew={onNew} onPick={onPick} />);
      pick('New connection');
      expect(onNew).toHaveBeenCalledWith(picker());
      expect(onPick).not.toHaveBeenCalled();
      expect(picker()).toHaveValue('');
    });

    it('with nothing this slot can use, says so, and New is the live entry', () => {
      render(<Harness connections={[conn('f', 'Files', 'fs')]} onNew={vi.fn()} />);
      expect(picker()).toHaveAttribute('placeholder', 'No connection yet');
      fireEvent.click(picker());
      expect(option('Files')).toHaveAttribute('aria-disabled', 'true');
      expect(option('New connection')).not.toHaveAttribute('aria-disabled');
    });
  });
});
