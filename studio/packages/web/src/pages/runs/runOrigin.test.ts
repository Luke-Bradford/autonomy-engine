import { describe, expect, it } from 'vitest';
import { RUN_TRIGGERED_BY_KINDS, type RunTriggeredByKind } from '@autonomy-studio/shared';
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

describe('runOriginOf', () => {
  /**
   * #1484 — every server kind lands in exactly one tab, or a row is reachable
   * from none of them and silently disappears from the list. Enumerated from the
   * shared enum, so a new kind that is not placed fails here (and typecheck).
   */
  it('places every server kind in exactly one origin', () => {
    const expected: Record<RunTriggeredByKind, RunOrigin> = {
      manual: 'triggered',
      schedule: 'triggered',
      tumbling: 'triggered',
      webhook: 'triggered',
      event: 'triggered',
      editor: 'manual',
      debug: 'manual',
      rerun: 'manual',
      call: 'child',
    };
    for (const kind of RUN_TRIGGERED_BY_KINDS) {
      expect(runOriginOf({ triggeredByKind: kind }), kind).toBe(expected[kind]);
    }
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
  const triggered = { id: 'a', triggeredByKind: 'webhook' as const };
  const manual = { id: 'b', triggeredByKind: 'editor' as const };
  const child = { id: 'c', triggeredByKind: 'call' as const };
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
