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

function Harness({ initial }: { initial?: string }) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <ConnectionPicker
      label="Source connection"
      value={value}
      connections={CONNS}
      disabledReason={connectionSlotReason(['sqlite'], 'Copy Data', 'source')}
      onPick={setValue}
    />
  );
}

const testButton = () => screen.getByRole('button', { name: 'Test selected source connection' });

describe('ConnectionPicker (#1477 slice 5b)', () => {
  beforeEach(() => probe.mockReset());
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
    probe.mockRejectedValueOnce(new Error('HTTP 404: connection not found'));
    render(<Harness initial="a" />);
    await act(async () => {
      fireEvent.click(testButton());
    });
    expect(screen.getByRole('status')).toHaveTextContent('HTTP 404: connection not found');
    expect(screen.getByRole('status')).toHaveClass('probe-failed');
  });
});
