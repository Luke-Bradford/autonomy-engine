import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, openSeededCanvas, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #1594 OR40 S3 — the one page header, its toolbar, and the one content frame,
 * measured in the browser on every page that has a title, in both densities.
 *
 * Every page's title row is `--header-h` (40px) with the title in the title
 * type (20/600), starting 16px inside `.content` (one left edge, and no
 * reading-width cap); its toolbar sits at the row's right end, each control is
 * `--control-h` tall, adjacent controls are at least 8px apart, and their
 * vertical centres agree within 1px. Nothing scrolls sideways.
 */
test.use({ viewport: { width: 1440, height: 900 } });

type Density = 'compact' | 'comfortable';
const CONTROL_H: Record<Density, number> = { compact: 28, comfortable: 32 };

/** Route, title, and how many toolbar controls it shows (so none passes empty). */
const STATIC_PAGES: [string, string, number][] = [
  ['/', 'Home', 0],
  ['/settings', 'Settings', 0],
  ['/author/pipelines', 'Pipelines', 3],
  ['/monitor/runs', 'Runs', 9],
  ['/monitor/ai', 'AI activity', 1],
  ['/monitor/audit', 'Audit', 1],
  ['/manage/connections', 'Connections', 1],
  ['/manage/datasets', 'Datasets', 1],
  ['/manage/secrets', 'Secrets', 1],
  ['/manage/global-params', 'Global parameters', 1],
  ['/manage/triggers', 'Triggers', 1],
  ['/manage/git', 'Git', 0],
  ['/no-such-page', 'Page not found', 0],
];

async function setDensity(page: Page, density: Density) {
  await page.goto('/#/settings');
  await fluentRootReady(page);
  await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption(density);
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
}

/** Everything this spec asserts about one page, read in ONE evaluate. */
function measure(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('.page-header')!;
    const h2 = header.querySelector(':scope > h2')!;
    const content = document.querySelector('.content')!;
    const toolbar = header.querySelector(':scope > .toolbar');
    const hb = header.getBoundingClientRect();
    const tb = h2.getBoundingClientRect();
    const cb = content.getBoundingClientRect();
    const titleStyle = getComputedStyle(h2);
    const contentStyle = getComputedStyle(content);
    // The leaf controls, in order: what a reader sees as one control each.
    const controls = toolbar
      ? [...toolbar.querySelectorAll<HTMLElement>('button, input, select, a.page-back')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              name: (
                el.getAttribute('aria-label') ??
                (el as HTMLInputElement).labels?.[0]?.textContent ??
                el.textContent ??
                ''
              ).trim(),
              left: r.left,
              right: r.right,
              height: r.height,
              centre: r.top + r.height / 2,
            };
          })
      : [];
    return {
      headerHeight: hb.height,
      headerRight: hb.right,
      toolbarRight: toolbar?.getBoundingClientRect().right ?? null,
      titleInset: tb.left - cb.left,
      titleFont: `${titleStyle.fontSize}/${titleStyle.fontWeight}/${titleStyle.lineHeight}`,
      contentMaxWidth: contentStyle.maxWidth,
      contentPaddingRight: parseFloat(contentStyle.paddingRight),
      contentRight: cb.right,
      sideways: content.scrollWidth - content.clientWidth,
      controls,
    };
  });
}

type Measured = Awaited<ReturnType<typeof measure>>;

function expectFrame(label: string, m: Measured, density: Density, fixedHeight: boolean) {
  const h = CONTROL_H[density];
  // The title row, and the title in the title type.
  if (fixedHeight) expect(m.headerHeight, `${label}: header height`).toBe(40);
  else expect(m.headerHeight, `${label}: header height`).toBeGreaterThanOrEqual(40);
  expect(m.titleFont, `${label}: title type`).toBe('20px/600/28px');
  // One content frame: the same 16px inset everywhere, no reading cap.
  expect(m.titleInset, `${label}: title inset from .content`).toBe(16);
  expect(m.contentMaxWidth, `${label}: .content max-width`).toBe('none');
  expect(m.sideways, `${label}: sideways scroll`).toBeLessThanOrEqual(0);
  if (m.toolbarRight === null) return;
  // The toolbar, and its last control, end at the row's right end.
  expect(Math.abs(m.toolbarRight - m.headerRight), `${label}: toolbar at the right`).toBeLessThan(
    1,
  );
  const last = m.controls.at(-1);
  if (last) {
    expect(
      Math.abs(last.right - m.headerRight),
      `${label}: '${last.name}' at the right`,
    ).toBeLessThan(1);
  }
  for (const c of m.controls) {
    expect(Math.abs(c.height - h), `${label}: '${c.name}' height`).toBeLessThan(0.5);
  }
  for (let i = 1; i < m.controls.length; i++) {
    const [a, b] = [m.controls[i - 1]!, m.controls[i]!];
    expect(b.left - a.right, `${label}: gap '${a.name}' → '${b.name}'`).toBeGreaterThanOrEqual(7.5);
    expect(
      Math.abs(b.centre - a.centre),
      `${label}: centres '${a.name}'/'${b.name}'`,
    ).toBeLessThanOrEqual(1);
  }
}

for (const density of ['compact', 'comfortable'] as const) {
  test(`#1594 OR40 S3 — every page's title row, toolbar and content frame (${density})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = collectPageProblems(page);

    // A run to open, and a pipeline to open in the editor.
    const stamp = Date.now();
    const { pipelineVersionId } = await seedVersion(page, `Page header run ${stamp}`, {
      nodes: [
        { id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } },
      ],
    });
    const runId = await fireAndSettle(page, pipelineVersionId, 'e2e page header');

    await setDensity(page, density);

    for (const [path, title, count] of STATIC_PAGES) {
      await page.goto(`/#${path}`);
      await fluentRootReady(page);
      await expect(
        page.locator('.page-header > h2').filter({ hasText: new RegExp(`^${title}$`) }),
      ).toBeVisible();
      const m = await measure(page);
      expectFrame(title, m, density, false);
      expect(m.controls.length, `${title}: toolbar controls`).toBe(count);
    }

    // The run page: its title row, then the facts band under it.
    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);
    await expect(page.locator('.run-header .run-status')).toHaveText('failure');
    const run = await measure(page);
    expectFrame('Run', run, density, false);
    expect(run.controls.map((c) => c.name)).toContain('← All runs');

    // The editor: a FIXED 40px row (#1393, nothing may change its height).
    await openSeededCanvas(page, `Page header canvas ${stamp}`, {
      nodes: [{ id: 'n1', type: 'fail', config: { message: 'x' }, position: { x: 0, y: 0 } }],
    });
    const editor = await measure(page);
    expectFrame('Editor', editor, density, true);
    expect(editor.controls.some((c) => c.name.startsWith('Save version'))).toBe(true);

    await expectQuiet(page, problems);
  });
}

/**
 * The Runs toolbar is the audit's worst case: ten controls that touched (0px
 * gaps) at four different heights. Its groups are split by dividers, and the
 * empty Live status gives back the gap it would otherwise add.
 */
test('#1594 OR40 S3 — the Runs toolbar is grouped, with no doubled gap', async ({ page }) => {
  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);
  const seen = await page.evaluate(() => {
    const toolbar = document.querySelector('.runs-page .page-header > .toolbar')!;
    const kids = [...toolbar.children] as HTMLElement[];
    const dividers = kids.filter((k) => k.classList.contains('toolbar__divider'));
    const status = toolbar.querySelector<HTMLElement>('.runs-live-status')!;
    const next = status.nextElementSibling!.getBoundingClientRect();
    const prev = status.previousElementSibling!.getBoundingClientRect();
    return {
      dividers: dividers.length,
      dividerHidden: dividers.every((d) => d.getAttribute('aria-hidden') === 'true'),
      statusEmpty: status.textContent === '',
      // Live → divider, across the empty status: one gap, not two.
      liveToDivider: next.left - prev.right,
    };
  });
  expect(seen.dividers).toBe(3);
  expect(seen.dividerHidden).toBe(true);
  expect(seen.statusEmpty).toBe(true);
  expect(seen.liveToDivider).toBeCloseTo(8, 0);
});
