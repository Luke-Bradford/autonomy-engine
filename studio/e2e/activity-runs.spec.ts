import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, mintVersion, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #1484 OR35 M2 — the run page's activity runs, read from the server's
 * projection of a REAL run: an If that takes `true` into a two-item ForEach,
 * and a Fail on the `false` branch that is therefore skipped. Then a Fail after
 * the ForEach, so the run ends failed with a reason on its row, and two waits
 * after that Fail, skipped because it failed.
 */
const DOC = {
  nodes: [
    { id: 'pick', type: 'if', config: { condition: '${equals(1, 1)}' }, position: { x: 0, y: 0 } },
    { id: 'hold', type: 'wait', config: { seconds: '${1}' }, position: { x: 260, y: 0 } },
    { id: 'never', type: 'fail', config: { message: 'not taken' }, position: { x: 260, y: 200 } },
    { id: 'stop', type: 'fail', config: { message: 'planned stop' }, position: { x: 520, y: 0 } },
    { id: 'after1', type: 'wait', config: { seconds: '${1}' }, position: { x: 780, y: 0 } },
    { id: 'after2', type: 'wait', config: { seconds: '${1}' }, position: { x: 1040, y: 0 } },
  ],
  edges: [
    { from: 'pick', to: 'fe', on: 'branch' as const, branch: 'true' },
    { from: 'pick', to: 'never', on: 'branch' as const, branch: 'false' },
    { from: 'fe', to: 'stop', on: 'success' as const },
    { from: 'stop', to: 'after1', on: 'success' as const },
    { from: 'after1', to: 'after2', on: 'success' as const },
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
  const { pipelineId, pipelineVersionId } = await seedVersion(page, 'M2 activity runs', DOC);
  const runId = await fireAndSettle(page, pipelineVersionId, 'M2 activity runs');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  const table = page.locator('.activity-runs__table');
  // 7 activity rows, plus the ForEach's group line and a line per item.
  await expect(table.locator('tbody tr')).toHaveCount(10);

  /* The failure banner waits for activity runs read at the log's newest event
     (#1541), which can be one throttled read after the table first fills. */
  await expect(page.locator('.run-failure')).toBeVisible();
  // Every reading in one evaluate: a round trip per assertion is what costs.
  const seen = await page.evaluate(() => {
    const t = document.querySelector<HTMLTableElement>('.activity-runs__table')!;
    const headers = [...t.querySelectorAll('thead th')].map((th) => th.textContent);
    const col = (name: string) => headers.indexOf(name);
    const rows = [...t.querySelectorAll<HTMLTableRowElement>('tbody tr')].map((tr) => {
      const cells = [...tr.cells].map((c) => (c.textContent ?? '').trim());
      return {
        id: tr.dataset.activityId,
        container: tr.dataset.containerId,
        line: tr.dataset.iteration === undefined ? null : `item ${tr.dataset.iteration}`,
        depth: tr.dataset.depth,
        // A group or item line's label: its toggle's text, without the chevron.
        label: [...(tr.querySelector('.activity-runs__toggle')?.childNodes ?? [])]
          .filter((n) => !(n instanceof Element && n.getAttribute('aria-hidden') === 'true'))
          .map((n) => n.textContent)
          .join(''),
        name: cells[col('Activity')],
        type: cells[col('Type')],
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
      // #1484 M2 slice 2 — the header band and the failure banner.
      facts: Object.fromEntries(
        [...document.querySelectorAll('.run-header__facts > div')].map((d) => [
          d.querySelector('dt')?.textContent,
          (d.querySelector('dd')?.textContent ?? '').trim(),
        ]),
      ),
      banner: (document.querySelector('.run-failure')?.textContent ?? '').trim(),
      bannerAboveTable: top(document.querySelector('.run-failure')) < top(firstRow),
    };
  });

  const byId = (id: string) => seen.rows.filter((r) => r.id === id);
  // #1484 M2 — the ForEach is a group line, with a line per item and each
  // item's activity under it.
  expect(
    seen.rows
      .filter((r) => r.container === 'fe' || r.id === 'hold')
      .map((r) => [r.line ?? r.id ?? 'group', r.depth, r.status]),
  ).toEqual([
    ['group', '0', 'success'],
    ['item 0', '1', 'success'],
    ['hold', '2', 'success'],
    ['item 1', '1', 'success'],
    ['hold', '2', 'success'],
  ]);
  const group = seen.rows.find((r) => r.container === 'fe' && r.line === null)!;
  expect(group).toMatchObject({ type: 'ForEach', iteration: '2 items' });
  // Two one-second waits, one after the other.
  expect(group.duration).toMatch(/^\d+(\.\d+)?s$/);
  expect(parseFloat(group.duration!)).toBeGreaterThanOrEqual(2);
  expect(seen.rows.filter((r) => r.line !== null).map((r) => r.label)).toEqual([
    'Item 1 of 2 · orders_a.csv',
    'Item 2 of 2 · orders_b.csv',
  ]);
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
  // #1484 M2 — a skip says why: the arm the If did not take, and two activities
  // after a failure, the second of which names the failure, not the skip between.
  expect(byId('never')).toMatchObject([{ status: 'skipped · branch not taken', start: '—' }]);
  const stopName = byId('stop')[0]!.name;
  expect(stopName).not.toBe('');
  for (const id of ['after1', 'after2'])
    expect(byId(id)).toMatchObject([{ status: `skipped · upstream failed: ${stopName}` }]);
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

  // The header is one band of facts, and the activity runs start high enough
  // that the table is the first thing below it (OR35: y ≤ 260 at 1440x900).
  expect(seen.facts['Triggered by']).toBe('Fire now · M2 activity runs');
  expect(seen.facts['Duration']).toMatch(/^\d+(\.\d+)?s$/);
  expect(seen.facts['Ended']).toMatch(/\d\d:\d\d:\d\d\.\d{3}/);
  expect(seen.firstRowTop).toBeLessThanOrEqual(260);
  // The banner names the activity the engine blamed, with its error, above the table.
  expect(seen.banner).toContain('Failed:');
  expect(seen.banner).toContain('planned stop');
  expect(seen.bannerAboveTable).toBe(true);

  // Show activity takes the reader to that activity's row.
  await page.getByRole('button', { name: 'Show activity' }).click();
  const current = table.locator('tbody tr[aria-current="true"]');
  await expect(current).toHaveAttribute('data-activity-id', 'stop');
  await expect(current).toBeFocused();

  // Collapsing the ForEach leaves its own line; opening it brings the items back.
  const toggle = table.locator('tr.activity-runs__group button');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(table.locator('tbody tr')).toHaveCount(6);
  await toggle.click();
  await expect(table.locator('tbody tr')).toHaveCount(10);

  /* Filtered within the run: failed rows only, the filter in the URL, so a
     reload (or a shared link) keeps it. */
  await page.getByRole('combobox', { name: 'Status' }).selectOption('failure');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr')).toHaveAttribute('data-activity-id', 'stop');
  expect(page.url()).toContain('arStatus=failure');
  await page.reload();
  await fluentRootReady(page);
  await expect(table.locator('tbody tr')).toHaveCount(1);
  // Back steps out of the filter, as on the runs list.
  await page.goBack();
  await expect(table.locator('tbody tr')).toHaveCount(10);
  expect(page.url()).not.toContain('arStatus');

  // By type: the two waits after the Fail, and the ForEach's own wait per item.
  await page.getByRole('combobox', { name: 'Type' }).selectOption('Wait');
  await expect(table.locator('tbody tr[data-activity-id]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(10);

  // Searched: the item's file name finds its row, under its group and item lines.
  await page.getByRole('searchbox', { name: 'Search activity runs' }).fill('orders_b');
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'Clear' }).click();

  /* Sorted by Duration: one flat list of the 7 rows, longest first — the two
     one-second waits ahead of everything that took no time. */
  const duration = table.getByRole('columnheader', { name: /Duration/ });
  await duration.getByRole('button').click();
  await expect(duration).toHaveAttribute('aria-sort', 'descending');
  await expect(table.locator('tbody tr')).toHaveCount(7);
  const firstTwo = await table
    .locator('tbody tr')
    .evaluateAll((trs) => trs.slice(0, 2).map((tr) => (tr as HTMLElement).dataset.activityId));
  expect(firstTwo).toEqual(['hold', 'hold']);

  /* #1541 — Open in editor lands on the version that ran with what failed
     selected. That version is still the latest, so it opens in the editor, and
     the editor's own selection is the failed activity. */
  const openInEditor = page.getByRole('link', { name: 'Open in editor' });
  await openInEditor.click();
  await expect(page).toHaveURL(/[?&]node=stop(&|$)/);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', 'stop');

  /* Once a newer version is saved, the run's version opens as a read-only
     preview instead, with the failed box marked: one box, bordered in the
     accent (the outline stays the status tone's), and named as selected. */
  await mintVersion(page, pipelineId, DOC, pipelineVersionId);
  await page.goBack();
  await fluentRootReady(page);
  await openInEditor.click();
  await expect(page).toHaveURL(/[?&]node=stop(&|$)/);
  const marked = page.locator('.run-node--selected');
  await expect(marked).toHaveCount(1);
  const mark = await marked.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    el.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const node = el.closest('.react-flow__node');
    return {
      id: node?.getAttribute('data-id'),
      label: node?.getAttribute('aria-label'),
      border: getComputedStyle(el).borderTopColor,
      accent,
    };
  });
  expect(mark.id).toBe('stop');
  expect(mark.label).toMatch(/, selected$/);
  expect(mark.accent).not.toBe('');
  expect(mark.border).toBe(mark.accent);

  await expectQuiet(page, problems);
});
