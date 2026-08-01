import { describe, expect, it } from 'vitest';
import {
  filterRunsByTab,
  isRunTab,
  RUN_ORIGIN_LABEL,
  RUN_ORIGINS,
  RUN_TAB_LABEL,
  RUN_TABS,
  runOriginOf,
  type RunOrigin,
} from './runOrigin';

const NEITHER = { triggerId: null, parentRunId: null };

describe('runOriginOf', () => {
  it('classifies a triggered run, a manual run and a child run', () => {
    expect(runOriginOf({ triggerId: 'trg_1', parentRunId: null })).toBe('triggered');
    expect(runOriginOf(NEITHER)).toBe('manual');
    expect(runOriginOf({ triggerId: null, parentRunId: 'run_1' })).toBe('child');
  });

  /**
   * The classification must be TOTAL — every run lands in exactly one tab, or a
   * row is reachable from none of them and silently disappears from the list.
   * All four combinations of the two nullable columns are enumerated, including
   * the one the row model does not forbid: a run carrying BOTH a trigger and a
   * parent. `child` wins there, deliberately.
   */
  it('is total over both nullable columns, with parent winning outright', () => {
    const combos = [
      { triggerId: null, parentRunId: null },
      { triggerId: 'trg_1', parentRunId: null },
      { triggerId: null, parentRunId: 'run_1' },
      { triggerId: 'trg_1', parentRunId: 'run_1' },
    ];
    for (const combo of combos) {
      expect(RUN_ORIGINS).toContain(runOriginOf(combo));
    }
    expect(runOriginOf({ triggerId: 'trg_1', parentRunId: 'run_1' })).toBe('child');
  });

  it('labels every origin, and every tab', () => {
    for (const origin of RUN_ORIGINS) {
      expect(RUN_ORIGIN_LABEL[origin], `no label for ${origin}`).toBeTruthy();
    }
    for (const tab of RUN_TABS) {
      expect(RUN_TAB_LABEL[tab], `no label for ${tab}`).toBeTruthy();
    }
    // The tab axis is exactly "everything", plus one tab per origin.
    expect(RUN_TABS).toEqual(['all', ...RUN_ORIGINS]);
  });
});

describe('filterRunsByTab', () => {
  const triggered = { id: 'a', triggerId: 'trg_1', parentRunId: null };
  const manual = { id: 'b', ...NEITHER };
  const child = { id: 'c', triggerId: null, parentRunId: 'run_1' };
  const all = [triggered, manual, child];

  it('passes everything through on the All tab', () => {
    expect(filterRunsByTab(all, 'all').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps exactly the runs of the tab’s own origin', () => {
    expect(filterRunsByTab(all, 'triggered').map((r) => r.id)).toEqual(['a']);
    expect(filterRunsByTab(all, 'manual').map((r) => r.id)).toEqual(['b']);
    expect(filterRunsByTab(all, 'child').map((r) => r.id)).toEqual(['c']);
  });

  /**
   * The tabs PARTITION the list: summing the per-origin tabs must recover the
   * All tab exactly, with nothing dropped and nothing counted twice. This is the
   * property that a hidden row would break, and it holds for any input rather
   * than for the three rows above.
   */
  it('partitions the list — the origin tabs sum to All', () => {
    const summed = RUN_ORIGINS.flatMap((origin: RunOrigin) => filterRunsByTab(all, origin));
    expect(summed.map((r) => r.id).sort()).toEqual(
      filterRunsByTab(all, 'all')
        .map((r) => r.id)
        .sort(),
    );
    expect(summed).toHaveLength(all.length);
  });

  it('does not mutate or alias the input array', () => {
    const input = [...all];
    const out = filterRunsByTab(input, 'all');
    expect(out).not.toBe(input);
    expect(input).toHaveLength(3);
  });
});

describe('isRunTab', () => {
  it('accepts every rendered tab and nothing else', () => {
    for (const key of RUN_TABS) expect(isRunTab(key)).toBe(true);
    expect(isRunTab('Manual')).toBe(false);
    expect(isRunTab('')).toBe(false);
    expect(isRunTab(null)).toBe(false);
  });

  /**
   * The guard takes `unknown` because it narrows Fluent's `TabValue` as well as
   * a URL search param, and `TabValue` is `unknown`. A non-string reaching it
   * must be REJECTED rather than coerced: a `String(value)` shape would let an
   * object whose `toString()` happened to read `manual` select a tab.
   */
  it('rejects a non-string without coercing it', () => {
    expect(isRunTab(undefined)).toBe(false);
    expect(isRunTab(0)).toBe(false);
    expect(isRunTab({ toString: () => 'manual' })).toBe(false);
    expect(isRunTab(['manual'])).toBe(false);
  });
});
