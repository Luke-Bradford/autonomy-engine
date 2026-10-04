import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #1484 OR35 M2 — the run page's activity runs, read from the server's
 * projection of a REAL run: an If that takes `true` into a two-item ForEach,
 * and a Fail on the `false` branch that is therefore skipped. Then a Fail after
 * the ForEach, so the run ends failed with a reason on its row.
 */
const DOC = {
  nodes: [
    { id: 'pick', type: 'if', config: { condition: '${equals(1, 1)}' }, position: { x: 0, y: 0 } },
    { id: 'hold', type: 'wait', config: { seconds: '${1}' }, position: { x: 260, y: 0 } },
    { id: 'never', type: 'fail', config: { message: 'not taken' }, position: { x: 260, y: 200 } },
    { id: 'stop', type: 'fail', config: { message: 'planned stop' }, position: { x: 520, y: 0 } },
  ],
  edges: [
    { from: 'pick', to: 'fe', on: 'branch' as const, branch: 'true' },
    { from: 'pick', to: 'never', on: 'branch' as const, branch: 'false' },
    { from: 'fe', to: 'stop', on: 'success' as const },
  ],
  containers: [
    {
      id: 'fe',
      kind: 'foreach' as const,
      children: ['hold'],
      items: "${createArray('orders_a.csv', 'orders_b.csv')}",
    },
  ],
};

test('#1484 M2 — the activity runs sit under the header: one row per attempt and item', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const { pipelineVersionId } = await seedVersion(page, 'M2 activity runs', DOC);
  const runId = await fireAndSettle(page, pipelineVersionId, 'M2 activity runs');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  const table = page.locator('.activity-runs__table');
  await expect(table.locator('tbody tr')).toHaveCount(5);

  // Every reading in one evaluate: a round trip per assertion is what costs.
  const seen = await page.evaluate(() => {
    const t = document.querySelector<HTMLTableElement>('.activity-runs__table')!;
    const headers = [...t.querySelectorAll('thead th')].map((th) => th.textContent);
    const col = (name: string) => headers.indexOf(name);
    const rows = [...t.querySelectorAll<HTMLTableRowElement>('tbody tr')].map((tr) => {
      const cells = [...tr.cells].map((c) => (c.textContent ?? '').trim());
      return {
        id: tr.dataset.activityId,
        status: cells[col('Status')],
        start: cells[col('Start')],
        duration: cells[col('Duration')],
        iteration: cells[col('Iteration')],
        branch: cells[col('Branch')],
        error: cells[col('Error')],
        height: tr.getBoundingClientRect().height,
      };
    });
    const top = (el: Element | null) => el?.getBoundingClientRect().top ?? Number.NaN;
    const firstRow = t.querySelector<HTMLTableRowElement>('tbody tr')!;
    const graph = [...document.querySelectorAll('h3')].find((h) => h.textContent === 'Graph');
    return {
      rows,
      fontSize: getComputedStyle(firstRow.querySelector('td')!).fontSize,
      durationAlign: getComputedStyle(firstRow.cells[col('Duration')]!).textAlign,
      firstRowTop: top(firstRow),
      graphTop: top(graph ?? null),
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  });

  const byId = (id: string) => seen.rows.filter((r) => r.id === id);
  // The If is a row though it is never dispatched, and it says which way it went.
  expect(byId('pick')).toMatchObject([{ status: 'success', branch: 'true' }]);
  // One row per ForEach item, each naming its item.
  expect(byId('hold').map((r) => r.iteration)).toEqual([
    '1 of 2 · orders_a.csv',
    '2 of 2 · orders_b.csv',
  ]);
  for (const r of byId('hold')) {
    expect(r.status).toBe('success');
    expect(r.start).toMatch(/^\d\d:\d\d:\d\d\.\d{3}$/);
    // A one-second wait, in the one duration format.
    expect(r.duration).toMatch(/^[12](\.\d+)?s$/);
  }
  expect(byId('never')).toMatchObject([{ status: 'skipped', start: '—' }]);
  expect(byId('stop')[0]!.status).toBe('failure');
  expect(byId('stop')[0]!.error).toContain('planned stop');

  // Dense, numbers right-aligned, and above the graph rather than below it.
  expect(seen.fontSize).toBe('13px');
  expect(seen.durationAlign).toBe('right');
  for (const r of seen.rows) expect(r.height).toBeLessThanOrEqual(33);
  expect(seen.firstRowTop).toBeLessThan(seen.graphTop);
  expect(seen.pageScrollsSideways).toBe(false);
  test.info().annotations.push({
    type: 'first activity row y at 1440x900',
    description: String(Math.round(seen.firstRowTop)),
  });

  await expectQuiet(page, problems);
});
