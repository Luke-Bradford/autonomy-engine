import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WindowEditor } from './WindowEditor';
import { blankWindowForm } from './windowForm';

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
    process.env.TZ = originalTz;
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
