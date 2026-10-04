import { afterEach, describe, expect, it } from 'vitest';
import { ANNOTATION_MAX_CHARS } from '@autonomy-studio/shared';
import {
  canonicalKindParam,
  dayRangeBounds,
  hasRunFilterParams,
  isDefaultRunSort,
  nextRunSort,
  readKinds,
  readRunFilters,
  readRunSort,
  runSortParams,
  hasRunsListParams,
  rememberedRunsQuery,
  readRunGridHiddenParam,
  runGridHiddenParam,
  RUN_GRID_HIDDEN_PARAM,
} from './runFilters';

describe('readRunFilters — U26 annotation', () => {
  it('keeps an annotation, decoded, exactly as written', () => {
    const params = new URLSearchParams({ annotation: 'Finance EU & UK+ café' });
    expect(readRunFilters(params)).toEqual({ annotation: 'Finance EU & UK+ café' });
  });

  /** A value the server's shared schema would 400 is dropped, so a junk link lands
   * on the unfiltered list rather than on an error page. */
  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(ANNOTATION_MAX_CHARS + 1)],
  ])('drops an annotation that is %s', (_label, value) => {
    expect(readRunFilters(new URLSearchParams({ annotation: value }))).toEqual({});
  });
});

describe('readRunFilters — #1484 kind, search and days', () => {
  const read = (query: string) => readRunFilters(new URLSearchParams(query));

  it('keeps a kind list in its canonical spelling', () => {
    expect(read('kind=webhook,schedule')).toEqual({ kind: 'schedule,webhook' });
  });

  it.each([
    ['junk', 'kind=nope'],
    ['an empty member', 'kind=schedule,'],
    [
      'every kind, which narrows nothing',
      `kind=${'manual,schedule,tumbling,webhook,event,editor,debug,rerun,call'}`,
    ],
  ])('drops a kind list that is %s', (_label, query) => {
    expect(read(query)).toEqual({});
  });

  it('keeps a trimmed search and drops a blank one', () => {
    expect(read('q=%20orders%20')).toEqual({ q: 'orders' });
    expect(read('q=%20%20')).toEqual({});
  });

  it('keeps one day, and it wins over a range in the same URL', () => {
    expect(read('on=2026-03-29&from=2026-01-01')).toEqual({ on: '2026-03-29' });
  });

  it('keeps a range, open at either end', () => {
    expect(read('from=2026-01-01&to=2026-01-31')).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(read('from=2026-01-01')).toEqual({ from: '2026-01-01' });
    expect(read('to=2026-01-31')).toEqual({ to: '2026-01-31' });
  });

  it.each([
    ['a day that does not exist (no roll-over into March)', 'on=2026-02-30'],
    ['a malformed day', 'on=2026-1-5'],
    ['a reversed range', 'from=2026-02-01&to=2026-01-31'],
    ['a cleared day input', 'on='],
  ])('drops %s', (_label, query) => {
    expect(read(query)).toEqual({});
  });

  it('reads a year below 100 as that year, not as 19xx', () => {
    expect(read('on=0002-10-03')).toEqual({ on: '0002-10-03' });
  });

  it('drops a relative window when days are set, and keeps it otherwise', () => {
    expect(read('since=24h&on=2026-03-29')).toEqual({ on: '2026-03-29' });
    expect(read('since=24h&on=2026-02-30')).toEqual({ since: '24h' });
  });

  it('readKinds and canonicalKindParam agree on one spelling', () => {
    expect(readKinds('call,editor')).toEqual(['editor', 'call']);
    expect(canonicalKindParam(['call', 'editor', 'call'])).toBe('editor,call');
    expect(canonicalKindParam([])).toBeUndefined();
  });
});

describe('dayRangeBounds — #1484', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('covers a whole 23-hour day: midnight to the NEXT midnight, not 24 hours on', () => {
    process.env.TZ = 'Europe/London';
    // 2026-03-29 is the UK's spring-forward day.
    const { from, to } = dayRangeBounds({ on: '2026-03-29' }, 'local');
    expect(Number(from)).toBe(Date.UTC(2026, 2, 29, 0));
    expect(Number(to)).toBe(Date.UTC(2026, 2, 29, 23));
    expect(Number(to) - Number(from)).toBe(23 * 60 * 60 * 1000);
  });

  it("a range runs from the first day's midnight to the midnight after the last", () => {
    process.env.TZ = 'UTC';
    expect(dayRangeBounds({ from: '2026-01-01', to: '2026-01-02' }, 'local')).toEqual({
      from: String(Date.UTC(2026, 0, 1)),
      to: String(Date.UTC(2026, 0, 3)),
    });
    expect(dayRangeBounds({ from: '2026-01-01' }, 'local')).toEqual({
      from: String(Date.UTC(2026, 0, 1)),
    });
    expect(dayRangeBounds({}, 'local')).toEqual({});
  });

  it('bounds the day in the DISPLAY zone, not the browser zone', () => {
    // The browser is in London; the viewer reads New York time, so 4 October
    // is 04:00Z to 04:00Z next day — and London's day would be off by 5 hours.
    process.env.TZ = 'Europe/London';
    expect(dayRangeBounds({ on: '2026-10-04' }, 'America/New_York')).toEqual({
      from: String(Date.UTC(2026, 9, 4, 4)),
      to: String(Date.UTC(2026, 9, 5, 4)),
    });
    expect(dayRangeBounds({ on: '2026-10-04' }, 'UTC')).toEqual({
      from: String(Date.UTC(2026, 9, 4)),
      to: String(Date.UTC(2026, 9, 5)),
    });
  });
});

describe('the runs grid sort in the URL — #1484', () => {
  const read = (q: string) => readRunSort(new URLSearchParams(q));

  it("reads newest first by default, and an absent dir as the column's natural one", () => {
    expect(read('')).toEqual({ key: 'started', dir: 'desc' });
    expect(read('sort=pipeline')).toEqual({ key: 'pipeline', dir: 'asc' });
    expect(read('sort=duration')).toEqual({ key: 'duration', dir: 'desc' });
    expect(read('sort=status&dir=desc')).toEqual({ key: 'status', dir: 'desc' });
  });

  it('drops a junk key or dir rather than sending the server a 400', () => {
    expect(read('sort=cost&dir=up')).toEqual({ key: 'started', dir: 'desc' });
    expect(read('sort=status&dir=sideways')).toEqual({ key: 'status', dir: 'asc' });
  });

  it('writes nothing for the default, and no dir when it is the natural one', () => {
    expect(runSortParams({ key: 'started', dir: 'desc' })).toEqual({ sort: '', dir: '' });
    expect(runSortParams({ key: 'started', dir: 'asc' })).toEqual({ sort: 'started', dir: 'asc' });
    expect(runSortParams({ key: 'pipeline', dir: 'asc' })).toEqual({ sort: 'pipeline', dir: '' });
    expect(runSortParams({ key: 'pipeline', dir: 'desc' })).toEqual({
      sort: 'pipeline',
      dir: 'desc',
    });
  });

  it('round-trips every sort through the URL', () => {
    for (const key of ['started', 'duration', 'pipeline', 'status', 'triggeredBy'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(runSortParams({ key, dir }))) if (v) params.set(k, v);
        expect(readRunSort(params)).toEqual({ key, dir });
      }
    }
  });

  it('flips the sorted column and opens any other in its natural direction', () => {
    expect(nextRunSort({ key: 'started', dir: 'desc' }, 'started')).toEqual({
      key: 'started',
      dir: 'asc',
    });
    expect(nextRunSort({ key: 'started', dir: 'desc' }, 'pipeline')).toEqual({
      key: 'pipeline',
      dir: 'asc',
    });
    expect(nextRunSort({ key: 'pipeline', dir: 'desc' }, 'duration')).toEqual({
      key: 'duration',
      dir: 'desc',
    });
  });

  it('is not a filter: a sorted URL has no filter params', () => {
    expect(hasRunFilterParams(new URLSearchParams('sort=status&dir=desc'))).toBe(false);
    expect(isDefaultRunSort(read('sort=status'))).toBe(false);
    expect(isDefaultRunSort(read(''))).toBe(true);
  });
});

describe('the runs list query remembered per viewer — #1484', () => {
  const remembered = (query: string) => rememberedRunsQuery(new URLSearchParams(query));

  it('keeps the filters, the window, the sort and the children toggle', () => {
    expect(
      remembered(
        'status=failure&pipeline=p_1&trigger=t_1&since=7d&annotation=nightly&kind=schedule&sort=status&dir=desc&children=off',
      ),
    ).toBe(
      'status=failure&pipeline=p_1&trigger=t_1&since=7d&annotation=nightly&kind=schedule&sort=status&dir=desc&children=off',
    );
  });

  it('drops one-off questions, view settings and the columns', () => {
    expect(
      remembered(
        'q=abc&on=2026-10-01&from=2026-09-01&to=2026-09-02&view=timeline&group=trigger&hide=cost',
      ),
    ).toBe('');
  });

  it('drops what narrows nothing: junk, an empty value, the default sort, children on', () => {
    expect(
      remembered('status=bogus&pipeline=&since=1y&kind=&sort=started&dir=desc&children=on'),
    ).toBe('');
  });

  it('says whether a URL names any of the list state, so a bare one can be restored', () => {
    expect(hasRunsListParams(new URLSearchParams(''))).toBe(false);
    expect(hasRunsListParams(new URLSearchParams('view=timeline&group=trigger'))).toBe(false);
    for (const query of [
      'status=bogus',
      'on=',
      'q=x',
      'sort=status',
      'children=off',
      'hide=cost',
    ]) {
      expect(hasRunsListParams(new URLSearchParams(query))).toBe(true);
    }
  });
});

describe('the runs grid column choice in the URL — #1484', () => {
  it('round-trips a hidden set, the empty one included', () => {
    for (const hidden of [[], ['annotations'], ['status', 'cost']] as const) {
      const params = new URLSearchParams({ [RUN_GRID_HIDDEN_PARAM]: runGridHiddenParam(hidden) });
      expect(readRunGridHiddenParam(params)).toEqual(hidden);
    }
    expect(runGridHiddenParam([])).toBe('none');
  });

  it('is absent, so the viewer’s own choice applies, when the param is missing or junk', () => {
    expect(readRunGridHiddenParam(new URLSearchParams(''))).toBeUndefined();
    expect(readRunGridHiddenParam(new URLSearchParams('hide='))).toBeUndefined();
    expect(readRunGridHiddenParam(new URLSearchParams('hide=bogus'))).toBeUndefined();
  });

  it('never hides a required column, and keeps column order', () => {
    expect(readRunGridHiddenParam(new URLSearchParams('hide=runId,cost,pipeline,status'))).toEqual([
      'status',
      'cost',
    ]);
  });
});
