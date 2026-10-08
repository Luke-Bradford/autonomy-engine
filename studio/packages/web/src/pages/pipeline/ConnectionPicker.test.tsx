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

const conn = (id: string, name: string, kind: 'sqlite' | 'fs'): ConnectionPublic =>
  ({
    id,
    name,
    kind,
    config: {},
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
}: {
  initial?: string;
  connections?: ConnectionPublic[];
  onEdit?: (id: string, opener: HTMLElement) => void;
}) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <ConnectionPicker
      label="Source connection"
      value={value}
      connections={connections}
      disabledReason={connectionSlotReason(['sqlite'], 'Copy Data', 'source')}
      onPick={setValue}
      onEdit={onEdit}
    />
  );
}

const testButton = () => screen.getByRole('button', { name: 'Test selected source connection' });

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
    fireEvent.change(screen.getByRole('combobox', { name: 'Source connection' }), {
      target: { value: 'b' },
    });
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
    const select = screen.getByRole('combobox', { name: 'Source connection' });
    fireEvent.change(select, { target: { value: 'b' } });
    fireEvent.change(select, { target: { value: 'a' } });
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
    const select = screen.getByRole('combobox', { name: 'Source connection' });
    fireEvent.change(select, { target: { value: 'b' } });
    // The re-pick frees Test for the new choice rather than waiting on the old probe.
    expect(testButton()).toBeEnabled();
    fireEvent.change(select, { target: { value: 'a' } });
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
});
