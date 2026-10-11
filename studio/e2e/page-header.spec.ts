import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, openSeededCanvas, seedVersion } from './support/seedDoc';
import { TITLED_PAGES } from './support/pages';
import { fluentRootReady } from './support/theme';
import { CONTROL_H } from './support/appearance';
import { expectInlineRow } from './support/inlineRow';

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
    const h1 = header.querySelector(':scope > h1')!;
    const content = document.querySelector('.content')!;
    const toolbar = header.querySelector(':scope > .toolbar');
    const hb = header.getBoundingClientRect();
    const tb = h1.getBoundingClientRect();
    const cb = content.getBoundingClientRect();
    const titleStyle = getComputedStyle(h1);
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
  expectInlineRow(label, m.controls, 7.5);
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

    for (const { path, title, controls: count } of TITLED_PAGES) {
      await page.goto(`/#${path}`);
      await fluentRootReady(page);
      await expect(
        page.locator('.page-header > h1').filter({ hasText: new RegExp(`^${title}$`) }),
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
    // A control's label never wraps, but a panel opened from the toolbar (Run
    // now, Debug) is deeper than a control and its labels must.
    const wrap = await page.evaluate(() => {
      const anchor = document.querySelector('.page-header > .toolbar .run-now-anchor')!;
      const panel = document.createElement('div');
      panel.innerHTML = '<label>probe</label><button type="button">probe</button>';
      anchor.append(panel);
      const read = (el: Element) => getComputedStyle(el).whiteSpace;
      const result = {
        control: read(anchor.querySelector(':scope > button')!),
        panelLabel: read(panel.querySelector('label')!),
        panelButton: read(panel.querySelector('button')!),
      };
      panel.remove();
      return result;
    });
    expect(wrap).toEqual({ control: 'nowrap', panelLabel: 'normal', panelButton: 'normal' });

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
    // A toolbar whose children all rendered nothing takes no room.
    const empty = document.createElement('div');
    empty.className = 'toolbar';
    toolbar.parentElement!.append(empty);
    const emptyDisplay = getComputedStyle(empty).display;
    empty.remove();
    const next = status.nextElementSibling!.getBoundingClientRect();
    const prev = status.previousElementSibling!.getBoundingClientRect();
    return {
      emptyDisplay,
      dividers: dividers.length,
      dividerHidden: dividers.every((d) => d.getAttribute('aria-hidden') === 'true'),
      statusEmpty: status.textContent === '',
      // Live → divider, across the empty status: one gap, not two.
      liveToDivider: next.left - prev.right,
    };
  });
  expect(seen.emptyDisplay).toBe('none');
  expect(seen.dividers).toBe(3);
  expect(seen.dividerHidden).toBe(true);
  expect(seen.statusEmpty).toBe(true);
  expect(seen.liveToDivider).toBeCloseTo(8, 0);
});
