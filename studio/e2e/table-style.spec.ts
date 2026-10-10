import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedManualTrigger, seedVersion } from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #1594 OR40 S3d — the one table style, measured in the browser on every page
 * with a list or a run's facts, in both densities.
 *
 * Every row is `--row-h` (32 compact, 36 comfortable). A column header is
 * body-strong (13/600 compact, 14/600 comfortable). A cell is 8px either side,
 * except the deliberate ones named in `measure` below. A number (`.num`) is
 * right-aligned in tabular figures. An id or value in `<code>` is in the mono
 * face. A cell cut to one line carries its whole text in a tooltip. Nothing
 * scrolls the page sideways.
 *
 * The seeds are named long on purpose, so the truncation is real: a check that
 * every cut cell has a tooltip passes vacuously on a page where nothing is cut.
 */
test.use({ viewport: { width: 1440, height: 900 } });

type Density = 'compact' | 'comfortable';
const ROW_H: Record<Density, number> = { compact: 32, comfortable: 36 };
const BODY: Record<Density, number> = { compact: 13, comfortable: 14 };

async function setDensity(page: Page, density: Density) {
  await page.goto('/#/settings');
  await fluentRootReady(page);
  await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption(density);
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
}

/** Everything this spec asserts about one page's tables, read in ONE evaluate. */
function measure(page: Page) {
  return page.evaluate(() => {
    const tables = [
      ...document.querySelectorAll<HTMLTableElement>('.content table:not(.row-table)'),
    ].filter((t) => t.getBoundingClientRect().width > 0);
    const name = (t: HTMLTableElement, i: number) =>
      t.className ||
      t.getAttribute('aria-label') ||
      t.caption?.textContent?.trim() ||
      `table ${i + 1}`;
    const px = (v: string) => parseFloat(v);
    return {
      sideways: (() => {
        const content = document.querySelector('.content')!;
        return content.scrollWidth - content.clientWidth;
      })(),
      tables: tables.map((t, i) => {
        const headers = [...t.querySelectorAll<HTMLElement>('thead th')].map((th) => {
          const s = getComputedStyle(th);
          return {
            text: th.textContent?.trim() ?? '',
            font: `${s.fontSize}/${s.fontWeight}`,
            pad: [px(s.paddingLeft), px(s.paddingRight)],
            filler: th.classList.contains('runs-grid__filler'),
          };
        });
        const rows = [...t.querySelectorAll<HTMLTableRowElement>('tbody tr')].map((tr) => ({
          text: tr.textContent?.trim().slice(0, 60) ?? '',
          height: tr.getBoundingClientRect().height,
        }));
        const cells = [...t.querySelectorAll<HTMLTableCellElement>('tbody td')]
          // The deliberate exceptions: the runs grid's trailing filler has no
          // padding, and an activity run under a container is indented.
          .filter((td) => !td.classList.contains('runs-grid__filler'))
          .map((td) => {
            const s = getComputedStyle(td);
            const indented = td.parentElement?.hasAttribute('data-depth') && td.cellIndex === 0;
            return {
              text: td.textContent?.trim().slice(0, 40) ?? '',
              padLeft: indented ? 8 : px(s.paddingLeft),
              padRight: px(s.paddingRight),
            };
          });
        const nums = [...t.querySelectorAll<HTMLElement>(':is(th, td).num')].map((c) => {
          const s = getComputedStyle(c);
          return {
            text: c.textContent?.trim() ?? '',
            align: s.textAlign,
            figures: s.fontVariantNumeric,
          };
        });
        const codes = [...t.querySelectorAll<HTMLElement>('td code')].map((c) => ({
          text: c.textContent?.trim().slice(0, 40) ?? '',
          family: getComputedStyle(c).fontFamily,
        }));
        // A cut cell: anything in a td drawn with an ellipsis whose text does
        // not fit. Its tooltip is on it, on an ancestor inside the cell, or on
        // the one element inside it that holds all its text (a cell's link),
        // and it says everything the cell shows: each word of the visible
        // text, so a tooltip holding some other value (an id) fails.
        const norm = (v: string) => v.replace(/\s+/g, ' ').trim();
        // What is drawn: a screen reader's own words (`.visually-hidden`) are
        // not part of what the cut hides.
        const visible = (el: HTMLElement) => {
          const copy = el.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('.visually-hidden').forEach((h) => h.remove());
          return norm(copy.textContent ?? '');
        };
        const cut = [...t.querySelectorAll<HTMLElement>('td, td *')]
          .filter(
            (el) =>
              getComputedStyle(el).textOverflow === 'ellipsis' &&
              el.scrollWidth > el.clientWidth + 1,
          )
          .map((el) => {
            const text = visible(el);
            const holders: HTMLElement[] = [];
            for (let up: HTMLElement | null = el; up && up.tagName !== 'TR';) {
              holders.push(up);
              up = up.parentElement;
            }
            holders.push(
              ...[...el.querySelectorAll<HTMLElement>('[title]')].filter(
                (d) => visible(d) === text,
              ),
            );
            // Words and numbers; a glyph (✓, ·) is said in words in a title.
            const words = text.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w));
            const titled = holders.some(
              (h) => h.title !== '' && words.every((w) => norm(h.title).includes(w)),
            );
            // The widths name the shortfall in a failure message.
            return { text: `${text.slice(0, 60)} (${el.scrollWidth}/${el.clientWidth}px)`, titled };
          });
        return { name: name(t, i), headers, rows, cells, nums, codes, cut };
      }),
    };
  });
}

type Measured = Awaited<ReturnType<typeof measure>>;

function expectTableStyle(label: string, m: Measured, density: Density) {
  expect(m.sideways, `${label}: sideways scroll`).toBeLessThanOrEqual(0);
  for (const t of m.tables) {
    const where = `${label} › ${t.name}`;
    for (const h of t.headers.filter((h) => !h.filler)) {
      expect(h.font, `${where}: header '${h.text}' type`).toBe(`${BODY[density]}px/600`);
      expect(h.pad, `${where}: header '${h.text}' padding`).toEqual([8, 8]);
    }
    for (const r of t.rows) {
      expect(Math.abs(r.height - ROW_H[density]), `${where}: row '${r.text}' height`).toBeLessThan(
        0.5,
      );
    }
    for (const c of t.cells) {
      expect([c.padLeft, c.padRight], `${where}: cell '${c.text}' padding`).toEqual([8, 8]);
    }
    for (const n of t.nums) {
      expect(n.align, `${where}: number '${n.text}' alignment`).toBe('right');
      expect(n.figures, `${where}: number '${n.text}' figures`).toContain('tabular-nums');
    }
    for (const c of t.codes) {
      expect(c.family, `${where}: code '${c.text}' face`).toMatch(/^ui-monospace/);
    }
    for (const c of t.cut) {
      expect(c.titled, `${where}: cut cell '${c.text}' has its whole text as a tooltip`).toBe(true);
    }
  }
}

/** The pages, each with the table rows a seed below guarantees and a cut name it shows. */
/**
 * `rows: false` is a page whose tables depend on what this machine has run
 * (AI activity): measured when present, never required.
 */
function pages(seeded: Seed): { route: string; title: string; cut: boolean; rows?: false }[] {
  return [
    { route: '/#/author/pipelines', title: 'Pipelines', cut: true },
    { route: '/#/monitor/runs', title: 'Runs', cut: true },
    { route: '/#/manage/connections', title: 'Connections', cut: true },
    { route: '/#/manage/datasets', title: 'Datasets', cut: true },
    { route: '/#/manage/triggers', title: 'Triggers', cut: true },
    { route: '/#/manage/secrets', title: 'Secrets', cut: true },
    { route: '/#/manage/global-params', title: 'Global parameters', cut: true },
    { route: '/#/monitor/audit', title: 'Audit', cut: true },
    { route: '/#/monitor/ai', title: 'AI activity', cut: false, rows: false },
    { route: `/#/monitor/runs/${encodeURIComponent(seeded.runId)}`, title: '', cut: false },
  ];
}

interface Seed {
  runId: string;
}

/** Names long enough that an 18rem cell must cut them. */
const LONG = 'with a name long enough that a list cell has to cut it to one line';

async function seed(page: Page, stamp: string): Promise<Seed> {
  const connectionId = await seedConnection(page, {
    name: `S3d connection ${stamp} ${LONG}`,
    kind: 'sqlite',
    config: { file: `/tmp/e2e-s3d-${stamp}.db` },
  });
  await seedDataset(page, {
    name: `S3d dataset ${stamp} ${LONG}`,
    kind: 'table',
    connectionId,
    config: { table: 'orders' },
    columns: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'total', type: 'number', nullable: true },
    ],
  });
  const secret = await page.request.post('/api/secrets', {
    data: { name: `s3d-secret-${stamp}-${LONG.replace(/ /g, '-')}`, secret: 'x' },
  });
  expect(secret.status(), await secret.text()).toBe(201);
  const global = await page.request.post('/api/global-params', {
    data: {
      name: `s3d_global_${`${stamp}_${LONG}`.replace(/[^A-Za-z0-9]/g, '_')}`,
      type: 'string',
      value: `a value ${LONG}`,
      description: `A description ${LONG}`,
    },
  });
  expect(global.status(), await global.text()).toBe(201);
  // Two failures and the activity after one of them skipped: the Activities
  // cell's figure ("0 ✓ · 2 ✗ · 1 skipped") is wider than its column.
  const { pipelineVersionId } = await seedVersion(page, `S3d pipeline ${stamp} ${LONG}`, {
    nodes: [
      { id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } },
      { id: 'n2', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 120 } },
      { id: 'n3', type: 'fail', config: { message: 'unreached' }, position: { x: 240, y: 0 } },
    ],
    edges: [{ from: 'n1', to: 'n3', on: 'success' }],
  });
  const runId = await fireAndSettle(page, pipelineVersionId, `S3d trigger ${stamp} ${LONG}`);
  // An audit entry whose line is too long for the column: archive and restore.
  const { pipelineId } = await seedVersion(page, `S3d archived ${stamp} ${LONG} ${LONG}`, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } }],
  });
  for (const act of ['archive', 'restore']) {
    const res = await page.request.post(`/api/pipelines/${pipelineId}/${act}`);
    expect(res.status(), await res.text()).toBe(200);
  }
  return { runId };
}

for (const density of ['compact', 'comfortable'] as const) {
  test(`#1594 OR40 S3d — one table style on every list and run page (${density})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);
    const seeded = await seed(page, `${density}-${Date.now()}`);
    await setDensity(page, density);

    for (const p of pages(seeded)) {
      await page.goto(p.route);
      await fluentRootReady(page);
      if (p.title !== '') {
        await expect(page.getByRole('heading', { name: p.title, exact: true })).toBeVisible();
      }
      if (p.rows !== false) {
        await expect(
          page.locator('.content table tbody tr').first(),
          `${p.route}: a table row`,
        ).toBeVisible();
      }
      const m = await measure(page);
      expectTableStyle(`${p.route} (${density})`, m, density);
      if (p.cut) {
        expect(
          m.tables.some((t) => t.cut.length > 0),
          `${p.route}: a seeded long name is cut, so the tooltip check is not vacuous`,
        ).toBe(true);
      }
    }

    // The run page's Events tab: the event feed and the diagnostics above it,
    // whose Seq columns are numbers.
    await page.getByRole('tab', { name: 'Events', exact: true }).click();
    await expect(page.locator('table.event-feed tbody tr').first()).toBeVisible();
    const events = await measure(page);
    expectTableStyle(`run events (${density})`, events, density);
    expect(
      events.tables.find((t) => t.name === 'event-feed')?.nums.length,
      'the event feed numbers its Seq column',
    ).toBeGreaterThan(1);

    await expectQuiet(page, problems);
  });
}

/**
 * #1626 — a status pill cut by its column keeps its whole ring and carries its
 * word as the cell's tooltip.
 *
 * Found order-dependent: the check above met an `interrupted` run only when an
 * earlier spec had left one in the shared database, and only on fonts where the
 * pill outgrows the 88px default. So this seeds its own `interrupted` run (a
 * start refused for an undeclared param, as `run-diagnostics.spec.ts` does) and
 * narrows the Status column to its floor, where the word is cut on any font.
 */
test('#1626 — a cut run status keeps its ring and its word as a tooltip', async ({ page }) => {
  const problems = collectPageProblems(page);
  const { pipelineVersionId } = await seedVersion(page, `#1626 refused ${Date.now()}`, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: 'never reached' }, position: { x: 0, y: 0 } }],
  });
  const triggerId = await seedManualTrigger(page, pipelineVersionId, '#1626 refused');
  const fired = await page.request.post(`/api/triggers/${encodeURIComponent(triggerId)}/fire`, {
    data: { params: { nope: 1 } },
  });
  expect(fired.status(), await fired.text()).toBe(202);
  const { runId } = (await fired.json()) as { runId: string };
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/runs/${encodeURIComponent(runId)}`);
      return ((await res.json()) as { status: string }).status;
    })
    .toBe('interrupted');

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);
  const row = page
    .locator('tr.runs-grid__row')
    .filter({ has: page.locator(`a[href*="${runId}"]`) });
  await expect(row, 'the seeded run is on the first page').toHaveCount(1);
  // The floor, by keyboard: the separator's Home is the column's minimum.
  await page.getByRole('separator', { name: 'Resize Status column' }).focus();
  await page.keyboard.press('Home');

  const m = await row.locator('td:has(> .run-status)').evaluate((td) => {
    const pill = td.querySelector<HTMLElement>(':scope > .run-status')!;
    const cell = td.getBoundingClientRect();
    const padRight = parseFloat(getComputedStyle(td).paddingRight);
    return {
      width: Math.round(cell.width),
      word: pill.textContent,
      title: td.getAttribute('title'),
      cut: pill.scrollWidth > pill.clientWidth + 1,
      ellipsis: getComputedStyle(pill).textOverflow,
      // The pill's right edge against the cell's content edge: past it, the
      // cell clips the ring.
      overrun: Math.round(pill.getBoundingClientRect().right - (cell.right - padRight)),
    };
  });
  expect(m.width, 'the Status column is at its 72px floor').toBe(72);
  expect(m.word).toBe('interrupted');
  expect(m.cut, `the word is cut at ${m.width}px, so the checks below are not vacuous`).toBe(true);
  expect(m.ellipsis, 'the pill ellipsises its own word').toBe('ellipsis');
  expect(m.overrun, 'the pill ends inside the cell, its ring whole').toBeLessThanOrEqual(1);
  expect(m.title, 'the cell says the whole word as a tooltip').toBe('interrupted');
  await expectQuiet(page, problems);
});
