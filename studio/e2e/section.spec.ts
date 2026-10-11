import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openSeededCanvas } from './support/seedDoc';
import { fluentRootReady } from './support/theme';
import { CONTROL_H } from './support/appearance';

/**
 * #1594 OR40 S3 — the one `Section`, measured where it is used: a resource
 * drawer (a secret's), the property dock (a pipeline's General tab) and a page
 * (the Monitor's account quota), in both densities at 1440x900.
 *
 * Every section heading is in the section type (14/600/20 compact, 16/600/22
 * comfortable) in sentence case; its content starts 8px under its heading row;
 * a section that follows another starts 16px after it; a heading row's actions
 * sit at its right end at `--control-h`.
 */
test.use({ viewport: { width: 1440, height: 900 } });

type Density = 'compact' | 'comfortable';
const SECTION_TYPE: Record<Density, string> = {
  compact: '14px/600/20px',
  comfortable: '16px/600/22px',
};

async function setDensity(page: Page, density: Density) {
  await page.goto('/#/settings');
  await fluentRootReady(page);
  await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption(density);
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
}

/** `scope` if it is a section, and every visible section inside it, in ONE evaluate. */
function measure(scope: Locator) {
  return scope.evaluate((root) =>
    [
      ...(root.matches('.section') ? [root as HTMLElement] : []),
      ...root.querySelectorAll<HTMLElement>('.section'),
    ]
      .filter((el) => el.getBoundingClientRect().height > 0)
      .map((el) => {
        const head = el.querySelector<HTMLElement>(':scope > .section__head')!;
        const title = head.querySelector<HTMLElement>(':scope > .section__title')!;
        const body = el.querySelector<HTMLElement>(':scope > .section__body')!;
        const prev = el.previousElementSibling as HTMLElement | null;
        const ts = getComputedStyle(title);
        const actions = [...head.querySelectorAll<HTMLElement>(':scope > .toolbar button')];
        return {
          title: title.textContent,
          font: `${ts.fontSize}/${ts.fontWeight}/${ts.lineHeight}`,
          transform: ts.textTransform,
          headToBody: body.getBoundingClientRect().top - head.getBoundingClientRect().bottom,
          // From the previous SECTION only: what precedes a first section is
          // the container's own business.
          afterSection: prev?.classList.contains('section')
            ? el.getBoundingClientRect().top - prev.getBoundingClientRect().bottom
            : null,
          actions: actions.map((b) => ({
            height: b.getBoundingClientRect().height,
            rightGap: head.getBoundingClientRect().right - b.getBoundingClientRect().right,
          })),
        };
      }),
  );
}

type Measured = Awaited<ReturnType<typeof measure>>;

function expectSections(where: string, seen: Measured, titles: string[], density: Density) {
  expect(
    seen.map((s) => s.title),
    `${where}: sections`,
  ).toEqual(titles);
  seen.forEach((s, i) => {
    const label = `${where} '${s.title}'`;
    expect(s.font, `${label}: heading type`).toBe(SECTION_TYPE[density]);
    expect(s.transform, `${label}: case`).toBe('none');
    expect(s.headToBody, `${label}: heading → content`).toBeCloseTo(8, 0);
    if (i > 0) expect(s.afterSection, `${label}: after the section before`).toBeCloseTo(16, 0);
  });
}

for (const density of ['compact', 'comfortable'] as const) {
  test(`#1594 OR40 S3 — one section: drawer, dock and page (${density})`, async ({ page }) => {
    test.setTimeout(90_000);
    const problems = collectPageProblems(page);
    await setDensity(page, density);

    // A drawer: a new secret's Basics, then Value.
    await page.goto('/#/manage/secrets');
    await fluentRootReady(page);
    await page.getByRole('button', { name: 'New secret' }).click();
    const drawer = page.locator('.form-drawer-body');
    await expect(drawer.getByRole('group', { name: 'Value', exact: true })).toBeVisible();
    expectSections('Secret drawer', await measure(drawer), ['Basics', 'Value'], density);

    // The dock: the pipeline's General tab, General then Annotations.
    await openSeededCanvas(page, `Section dock ${Date.now()}`, {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });
    await page.getByRole('tab', { name: 'General' }).click();
    const tab = page.locator('.property-panel [role="tabpanel"]:not([hidden])');
    await expect(tab.getByRole('group', { name: 'Annotations', exact: true })).toBeVisible();
    expectSections('Dock General', await measure(tab), ['General', 'Annotations'], density);

    // A page: the Monitor's account quota, a region with its Refresh at the
    // heading row's right end.
    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);
    const quota = page.getByRole('region', { name: 'Account quota' });
    await expect(quota.getByRole('heading', { level: 2, name: 'Account quota' })).toBeVisible();
    const [seen] = await measure(quota);
    expect(seen!.font, 'Account quota: heading type').toBe(SECTION_TYPE[density]);
    expect(seen!.actions, 'Account quota: Refresh').toHaveLength(1);
    expect(seen!.actions[0]!.height, 'Account quota: Refresh height').toBeCloseTo(
      CONTROL_H[density],
      0,
    );
    expect(seen!.actions[0]!.rightGap, 'Account quota: Refresh at the right').toBeLessThan(1);

    await expectQuiet(page, problems);
  });
}
