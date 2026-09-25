import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WindowEditor } from './WindowEditor';
import { blankWindowForm, windowToForm } from './windowForm';

/**
 * #855 — the tumbling-window editor shares the recurrence editor's
 * `datetime-local` bounds, so it shares the daylight-saving gap too: a window
 * epoch typed as a wall clock the browser's zone skips is saved as a different
 * one, and the editor must say so where it was typed. (The recurrence editor's
 * half is covered end to end in `e2e/trigger-recurrence.spec.ts`.)
 */
describe('#855 WindowEditor names a bound the DST gap will move', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('warns for an epoch inside the gap, and is silent for one that exists', () => {
    process.env.TZ = 'Europe/London';
    const noop = () => {};
    const { rerender } = render(
      <WindowEditor
        value={{ ...blankWindowForm(), startTime: '2026-03-29T01:30' }}
        onChange={noop}
      />,
    );
    expect(screen.getByTestId('bound-shift')).toHaveTextContent(
      /^Start time 2026-03-29T01:30 .* saved as 2026-03-29T02:30\.$/,
    );

    rerender(
      <WindowEditor
        value={{ ...blankWindowForm(), startTime: '2026-03-29T03:30' }}
        onChange={noop}
      />,
    );
    expect(screen.queryByTestId('bound-shift')).toBeNull();
  });
});

/**
 * #861 — a window's retry policy and self-dependency have controls of their
 * own, and the editor says what they will do, computed from the built window.
 */
describe('#861 WindowEditor retry + self-dependency', () => {
  const loaded = () =>
    windowToForm({
      frequency: 'hour',
      interval: 1,
      startTime: '2026-08-01T08:00:00.000Z',
      retry: { count: 3, intervalInSeconds: 60 },
      selfDependency: { offsetInSeconds: -7200 },
    });

  it('shows the loaded values in their controls and states what they do', () => {
    render(<WindowEditor value={loaded()} onChange={() => {}} />);
    expect(screen.getByLabelText(/Retry a failed window/)).toHaveValue(3);
    expect(screen.getByLabelText(/Seconds between retries/)).toHaveValue(60);
    expect(screen.getByLabelText(/offset in seconds/)).toHaveValue(-7200);
    expect(screen.getByLabelText(/Dependency span/)).toHaveValue(null);
    expect(screen.getByTestId('window-retry-preview')).toHaveTextContent(
      'A failed window is re-run up to 3 more times, 60s apart',
    );
    // A blank span is one window (3600s here), so the interval ends 3600s back.
    expect(screen.getByTestId('window-dependency-preview')).toHaveTextContent(
      'overlapping 7200s before its start to 3600s before its start',
    );
    expect(screen.queryByTestId('window-problem')).toBeNull();
  });

  it('reports each typed field through onChange as text', () => {
    const onChange = vi.fn();
    render(<WindowEditor value={blankWindowForm()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/offset in seconds/), { target: { value: '-60' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ dependencyOffsetSeconds: '-60' }),
    );
    fireEvent.change(screen.getByLabelText(/Retry a failed window/), { target: { value: '2' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ retryCount: '2' }));
  });

  it('drops the dependency preview and names the rule when the geometry moves it out of range', () => {
    // A 1-hour dependency span with a 1-hour offset is legal on 1-hour windows;
    // growing the window to 3 hours makes the span default to 3h, which reaches
    // past the window's own start — a deadlock the write schema refuses.
    render(
      <WindowEditor
        value={{ ...loaded(), interval: '3', dependencyOffsetSeconds: '-3600' }}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId('window-dependency-preview')).toBeNull();
    expect(screen.getByTestId('window-problem')).toHaveTextContent(/selfDependency/);
  });
});
