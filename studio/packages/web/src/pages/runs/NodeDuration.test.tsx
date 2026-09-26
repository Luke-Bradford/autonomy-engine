import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { NodeDuration } from './NodeDuration';
import type { AttemptSpan } from './runSummary';

const openSpan: AttemptSpan = {
  startedAtMs: 1_000,
  endedAtMs: undefined,
  startedAs: 'dispatched',
  endedAs: undefined,
  instanceId: undefined,
};

const running = { startedAtMs: 1_000, endedAtMs: undefined, spans: [openSpan] };

beforeEach(() => {
  vi.useFakeTimers({ now: 11_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('NodeDuration (#890)', () => {
  it('counts a running node up, once a second, while the page is live', () => {
    const { container } = render(<NodeDuration node={running} live />);
    expect(container.textContent).toBe('10s so far');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(container.textContent).toBe('12s so far');
  });

  it('keeps the em-dash when the page could not hear a settle — no ticking guess', () => {
    const { container } = render(<NodeDuration node={running} live={false} />);
    expect(container.textContent).toBe('—');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the measured duration of a settled node, and starts no clock for it', () => {
    const settled = {
      startedAtMs: 1_000,
      endedAtMs: 4_000,
      spans: [{ ...openSpan, endedAtMs: 4_000, endedAs: 'success' as const }],
    };
    const { container } = render(<NodeDuration node={settled} live />);
    expect(container.textContent).toBe('3s');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not tick a foreach item row, whose start every new item overwrites', () => {
    const item = { ...running, spans: [{ ...openSpan, instanceId: 'w@2' }] };
    const { container } = render(<NodeDuration node={item} live />);
    expect(container.textContent).toBe('—');
  });

  it('stops ticking the moment the node settles', () => {
    const { container, rerender } = render(<NodeDuration node={running} live />);
    rerender(
      <NodeDuration
        node={{ ...running, endedAtMs: 12_000, spans: [{ ...openSpan, endedAtMs: 12_000 }] }}
        live
      />,
    );
    expect(container.textContent).toBe('11s');
    expect(vi.getTimerCount()).toBe(0);
  });
});
