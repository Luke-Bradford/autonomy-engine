import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunDiagnostic } from '@autonomy-studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunDiagnostics } from './RunDiagnostics';
import * as runsApi from '../../api/runs';

/**
 * #1065 — the run monitor's "why". These tests pin three properties that are the
 * reason the component exists rather than being a `map` over the response:
 *
 *  1. the `cap` marker is rendered ABOVE the list and is NOT one of its rows;
 *  2. a failed lookup is stated, never rendered as an empty (i.e. clean) run;
 *  3. the empty state keys off the rows the operator reads, not the raw response.
 */

const DIAGNOSTIC: RunDiagnostic = {
  id: 'rdg_1',
  runId: 'run_1',
  seq: 4,
  phase: 'fold',
  ordinal: 0,
  message: "container 'stg' failed: child 'stop' failed",
  ts: 140,
};

const SECOND: RunDiagnostic = {
  ...DIAGNOSTIC,
  id: 'rdg_2',
  seq: 7,
  ordinal: 1,
  message: "edge 'e2' was ignored: its source never produced an outcome",
};

const RESUME: RunDiagnostic = {
  ...DIAGNOSTIC,
  id: 'rdg_3',
  seq: 9,
  phase: 'resume',
  message: "node 'send' was re-dispatched after the run resumed",
};

/** The truncation marker the server writes at `RUN_DIAGNOSTIC_CAP`. */
const CAP: RunDiagnostic = {
  id: 'rdg_cap',
  runId: 'run_1',
  seq: -1,
  phase: 'cap',
  ordinal: 0,
  message:
    'diagnostics for this run reached the cap of 500 and later ones were NOT recorded. ' +
    'The run’s decisions are unaffected and remain fully durable in its event log.',
  ts: 90,
};

function stubDiagnostics(rows: RunDiagnostic[]) {
  return vi.spyOn(runsApi, 'getRunDiagnostics').mockResolvedValue(rows);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RunDiagnostics', () => {
  it('renders each explanation against the seq it was derived at', async () => {
    stubDiagnostics([DIAGNOSTIC, SECOND]);
    render(<RunDiagnostics runId="run_1" settled />);

    expect(await screen.findByText(DIAGNOSTIC.message)).toBeInTheDocument();
    expect(screen.getByText(SECOND.message)).toBeInTheDocument();
    /* The seq is the cross-reference to the Events table, so it has to be on
       screen — a message alone leaves the operator no way to find the decision
       it explains. */
    expect(screen.getByRole('cell', { name: '4' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '7' })).toBeInTheDocument();
  });

  it('says a healthy run has nothing to explain, rather than showing an empty table', async () => {
    stubDiagnostics([]);
    render(<RunDiagnostics runId="run_1" settled />);

    expect(await screen.findByText(/neutralized nothing on this run/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the cap marker as a warning ABOVE the list and NOT as a row', async () => {
    stubDiagnostics([CAP, DIAGNOSTIC, SECOND]);
    render(<RunDiagnostics runId="run_1" settled />);

    expect(await screen.findByText(/Some explanations were dropped\./)).toBeInTheDocument();

    /* THE LOAD-BEARING ASSERTION. Checking only that the warning exists would
       pass while the marker was ALSO rendered as an ordinary row — the exact
       thing the partition exists to prevent. So count the rows: two real
       diagnostics and the header, and no third body row. */
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(screen.queryByRole('cell', { name: '-1' })).not.toBeInTheDocument();
    /* And the marker's own text must not appear inside the table. */
    const table = screen.getByRole('table');
    expect(table).not.toHaveTextContent(/reached the cap of 500/);
  });

  it('does not claim there is nothing to explain when the cap dropped everything', async () => {
    /* The empty state keys off the ROWS, not the raw response. A response of
       just the marker must never render "the reducer neutralized nothing"
       directly beneath a warning saying explanations were discarded. */
    stubDiagnostics([CAP]);
    render(<RunDiagnostics runId="run_1" settled />);

    expect(await screen.findByText(/Some explanations were dropped\./)).toBeInTheDocument();
    expect(screen.queryByText(/neutralized nothing on this run/i)).not.toBeInTheDocument();
  });

  it('states a failed lookup instead of rendering it as a clean run', async () => {
    vi.spyOn(runsApi, 'getRunDiagnostics').mockRejectedValue(new Error('boom'));
    render(<RunDiagnostics runId="run_1" settled />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be read/i);
    /* The whole point: a rejection must not be indistinguishable from a run the
       reducer had nothing to say about. */
    expect(screen.queryByText(/neutralized nothing on this run/i)).not.toBeInTheDocument();
  });

  it('marks a resume-derived explanation and leaves a folded one unmarked', async () => {
    stubDiagnostics([DIAGNOSTIC, RESUME]);
    render(<RunDiagnostics runId="run_1" settled />);

    await screen.findByText(RESUME.message);
    expect(screen.getByText(/derived when the run was resumed/i)).toBeInTheDocument();
    /* Exactly one — the `fold` row is the unmarked common case. */
    expect(screen.getAllByText(/derived when the run was resumed/i)).toHaveLength(1);
  });

  it('says an unfinished run’s list is a snapshot, and drops the caveat once it settles', async () => {
    stubDiagnostics([DIAGNOSTIC]);
    const { rerender } = render(<RunDiagnostics runId="run_1" settled={false} />);

    expect(await screen.findByText(/has not finished, so this is a snapshot/i)).toBeInTheDocument();

    rerender(<RunDiagnostics runId="run_1" settled />);
    await waitFor(() =>
      expect(screen.queryByText(/has not finished, so this is a snapshot/i)).not.toBeInTheDocument(),
    );
  });

  it('re-reads once when the run settles, without blanking the list it already has', async () => {
    const spy = stubDiagnostics([DIAGNOSTIC]);
    const { rerender } = render(<RunDiagnostics runId="run_1" settled={false} />);
    await screen.findByText(DIAGNOSTIC.message);
    expect(spy).toHaveBeenCalledTimes(1);

    rerender(<RunDiagnostics runId="run_1" settled />);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    /* The reason this is a `refresh()` and not a `key` remount: the list the
       operator was reading stays on screen across the refetch. A remount would
       reset state to `null` and flash "Reading…" — on EVERY view of a terminal
       run, since `settled` starts false while the REST row is in flight. */
    expect(screen.getByText(DIAGNOSTIC.message)).toBeInTheDocument();
    expect(screen.queryByText(/Reading the run’s diagnostics…/)).not.toBeInTheDocument();
  });

  it('does not re-read on a rerender that leaves the run settled', async () => {
    /* The settle refetch is guarded on the false→true EDGE. Without that, a run
       already terminal at mount would fire a second request on top of its own
       first load, and every later rerender another. */
    const spy = stubDiagnostics([DIAGNOSTIC]);
    const { rerender } = render(<RunDiagnostics runId="run_1" settled />);
    await screen.findByText(DIAGNOSTIC.message);

    rerender(<RunDiagnostics runId="run_1" settled />);
    rerender(<RunDiagnostics runId="run_1" settled />);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-reads on demand', async () => {
    const spy = stubDiagnostics([DIAGNOSTIC]);
    render(<RunDiagnostics runId="run_1" settled />);
    await screen.findByText(DIAGNOSTIC.message);

    await userEvent.click(screen.getByRole('button', { name: /refresh diagnostics/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
