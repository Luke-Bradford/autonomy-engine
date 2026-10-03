import { TERMINAL_RUN_ROW_STATUS, type RunSummary } from '@autonomy-studio/shared';
import { formatCount } from './format';

/** One Activities cell: the dense `8 ✓ · 1 ✗ · 2 skipped` and the same in words. */
export interface ActivitiesCell {
  /** What the cell draws. Glyphs, so it fits a 32px row. */
  readonly figure: string;
  /** The same counts in words: the cell's accessible text. */
  readonly words: string;
  /** The cell's hover text. */
  readonly title: string;
}

/**
 * #1484 OR35 M1 — the runs list's Activities column, from the server's own fold
 * (`RunSummary.activities`); this only words it.
 *
 * Succeeded is always shown, so a run that did nothing reads `0 ✓` rather than
 * an empty cell. Every other count appears only when it is not zero. Activities
 * that have not finished read "in progress" on a live run and "not run" on one
 * that has ended, because by then they never will.
 *
 * `null` is "no count to show" — the run has not started, or its log or version
 * cannot be read — and draws the em-dash this list uses for "no answer".
 */
export function activitiesCell(run: Pick<RunSummary, 'activities' | 'status'>): ActivitiesCell {
  const counts = run.activities;
  if (counts === null) {
    return {
      figure: '—',
      words: 'No activity counts',
      title:
        'No activity counts: the run has not started, or its log or pipeline version cannot be read',
    };
  }
  const unfinished = TERMINAL_RUN_ROW_STATUS.has(run.status) ? 'not run' : 'in progress';
  const parts: { figure: string; words: string; n: number; always?: boolean }[] = [
    { n: counts.succeeded, figure: '✓', words: 'succeeded', always: true },
    { n: counts.failed, figure: '✗', words: 'failed' },
    { n: counts.skipped, figure: 'skipped', words: 'skipped' },
    { n: counts.reused, figure: 'reused', words: 'reused from the earlier run' },
    { n: counts.unfinished, figure: unfinished, words: unfinished },
  ];
  const shown = parts.filter((p) => p.always === true || p.n > 0);
  const words = shown.map((p) => `${formatCount(p.n)} ${p.words}`).join(', ');
  return {
    figure: shown.map((p) => `${formatCount(p.n)} ${p.figure}`).join(' · '),
    words,
    title: words,
  };
}

/** #1484 — the Rows written cell: a grouped count, or the em-dash when no
 * activity in the run reported the figure (`RunSummary.rowsWritten`). */
export function rowsWrittenCell(run: Pick<RunSummary, 'rowsWritten'>): string {
  return run.rowsWritten === null ? '—' : formatCount(run.rowsWritten);
}
