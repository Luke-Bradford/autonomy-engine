import { describe, expect, it } from 'vitest';
import { RunStatusSchema } from '@autonomy-studio/shared';
import { canCancelRun, cancelConfirmMessage } from './cancelAction';

describe('canCancelRun (CX4 #1320)', () => {
  it('offers a cancel on exactly the statuses that have not ended (spec D5)', () => {
    const offered = RunStatusSchema.options.filter((s) => canCancelRun(s));
    expect(offered.sort()).toEqual(['pending', 'queued', 'running', 'waiting']);
  });
});

describe('cancelConfirmMessage (CX4 #1320)', () => {
  it('names each node the cancel stops, in the page’s own status words', () => {
    const text = cancelConfirmMessage([
      { name: 'HTTP Request 1', status: 'dispatched' },
      { name: 'Wait 1', status: 'wait_pending' },
      { name: 'Later', status: 'pending' },
      { name: 'Done', status: 'success' },
    ]);
    expect(text).toContain('HTTP Request 1 — running');
    expect(text).toContain('Wait 1 — waiting (timer)');
    // Not in progress: neither is named as something the cancel stops.
    expect(text).not.toContain('Later');
    expect(text).not.toContain('Done');
  });

  it('never implies a rollback of work already sent', () => {
    for (const targets of [[], [{ name: 'Copy 1', status: 'dispatched' as const }]]) {
      expect(cancelConfirmMessage(targets)).toContain('is not undone');
    }
  });

  it('says so when nothing is in progress, rather than listing nothing', () => {
    const text = cancelConfirmMessage([{ name: 'Later', status: 'pending' }]);
    expect(text).toContain('Nothing is in progress right now');
    expect(text).not.toContain('This stops:');
  });

  it('does not promise an immediate stop while a node waits on a child run (until CX3)', () => {
    expect(cancelConfirmMessage([{ name: 'Call 1', status: 'waiting' }])).toContain(
      'stops only once that child ends',
    );
    expect(cancelConfirmMessage([{ name: 'HTTP 1', status: 'dispatched' }])).not.toContain('child');
  });
});
