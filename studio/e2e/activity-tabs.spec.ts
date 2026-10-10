import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties, expectTabNames } from './support/panels';

/**
 * #1477 OR29 slice 2 — an activity's properties are on the tabs its catalog
 * entry declares, under ONE header row pinned with the tab strip. Measured at the
 * operator's 1440×900, with the dock at its default height and compact density.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const seed = {
  nodes: [
    {
      id: 'c',
      type: 'copy',
      position: { x: 0, y: 0 },
      config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }] },
    },
    {
      id: 'h',
      type: 'http_request',
      position: { x: 300, y: 0 },
      config: { url: 'https://a.example.test' },
    },
    { id: 'l', type: 'llm_call', position: { x: 600, y: 0 }, config: { prompt: 'Hello' } },
  ],
};

const tabs = (page: Page) => properties(page).getByRole('tablist', { name: 'Activity properties' });

/**
 * One read: how far `target` runs past its panel's visible bottom, with the
 * panel scrolled to the top. ≤ 0 means it is on screen without scrolling.
 */
function overflowOf(target: Locator) {
  return target.evaluate((el) => {
    const panel = el.closest<HTMLElement>('.property-panel')!;
    panel.scrollTop = 0;
    const visibleBottom = panel.getBoundingClientRect().top + panel.clientHeight;
    return Math.round(el.getBoundingClientRect().bottom - visibleBottom);
  });
}

test('a Copy node opens on Source; each tab starts on screen and Sink fits whole', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or29 copy tabs', seed);
  await nodeById(page, 'c').click();

  await expectTabNames(tabs(page), ['General', 'Source', 'Sink', 'Mapping']);
  await expect(tabs(page).getByRole('tab', { name: 'Source' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const source = properties(page).getByRole('tabpanel', { name: 'Source' });
  await expect(source.getByRole('combobox', { name: 'Source connection' })).toBeVisible();
  await expect(source.getByRole('combobox', { name: 'Source dataset' })).toBeVisible();
  // #1597 — the WHOLE Source tab fits without a scroll. It ran 73px over while
  // every activity's landing tab closed on a Container section (membership,
  // its prose hint and a New container form); that section is gone, because
  // membership is a canvas fact (Move into ▸ on the canvas context menu).
  await expect(source.getByRole('group', { name: 'Container' })).toHaveCount(0);
  expect(await overflowOf(source)).toBeLessThanOrEqual(0);

  await tabs(page).getByRole('tab', { name: 'Sink' }).click();
  const sink = properties(page).getByRole('tabpanel', { name: 'Sink' });
  await expect(sink.getByRole('combobox', { name: 'Sink connection' })).toBeVisible();
  await expect(sink.getByRole('combobox', { name: 'Sink dataset' })).toBeVisible();
  expect(await overflowOf(sink)).toBeLessThanOrEqual(0);

  await tabs(page).getByRole('tab', { name: 'Mapping' }).click();
  const mapping = properties(page).getByRole('tabpanel', { name: 'Mapping' });
  await expect(mapping.getByRole('button', { name: 'Add column mapping row' })).toBeVisible();
  await expect(mapping.getByRole('button', { name: 'Auto-map columns' })).toBeVisible();
  // #1477 OR29 — with the row list a compact table, the whole tab fits.
  expect(await overflowOf(mapping)).toBeLessThanOrEqual(0);
  await expectQuiet(page, problems);
});

test('the header and tab strip stay pinned while a long tab scrolls', async ({ page }) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or29 sticky header', seed);
  await nodeById(page, 'l').click();
  await expect(tabs(page).getByRole('tab', { name: 'Model' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const pinned = await properties(page).evaluate((panel) => {
    const header = panel.querySelector<HTMLElement>('.property-panel__header')!;
    const strip = panel.querySelector<HTMLElement>('[role="tablist"]')!;
    const before = {
      header: header.getBoundingClientRect().top,
      strip: strip.getBoundingClientRect().top,
    };
    panel.scrollTop = panel.scrollHeight;
    const scrolled = panel.scrollTop;
    const after = {
      header: header.getBoundingClientRect().top,
      strip: strip.getBoundingClientRect().top,
    };
    const sticky = header.parentElement!;
    return {
      scrolled,
      headerMoved: Math.abs(after.header - before.header),
      stripMoved: Math.abs(after.strip - before.strip),
      // Opaque, so the fields scrolling under it do not show through.
      background: getComputedStyle(sticky).backgroundColor,
    };
  });
  expect(pinned.scrolled).toBeGreaterThan(0);
  expect(pinned.headerMoved).toBeLessThan(1);
  expect(pinned.stripMoved).toBeLessThan(1);
  expect(pinned.background).not.toBe('rgba(0, 0, 0, 0)');
  await expect(properties(page).getByRole('button', { name: 'Apply config' })).toBeInViewport();
  await expectQuiet(page, problems);
});

test('a chosen tab is kept for the next node that has it', async ({ page }) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or29 remembered tab', seed);
  await nodeById(page, 'c').click();
  await tabs(page).getByRole('tab', { name: 'Mapping' }).click();

  // An HTTP node has no Mapping, so it opens on its first type tab…
  await nodeById(page, 'h').click();
  await expect(tabs(page).getByRole('tab', { name: 'Request' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // …and the choice survives it.
  await nodeById(page, 'c').click();
  await expect(tabs(page).getByRole('tab', { name: 'Mapping' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expectQuiet(page, problems);
});

/**
 * #1477 OR29 — each tab label carries its status, so a problem never needs a
 * scroll hunt. The mark is `aria-hidden`; its meaning is the tab's DESCRIPTION,
 * so `expectTabNames` (exact names) also certifies the mark left the name alone.
 */
test('a tab label shows its problems, an unapplied edit, or that it is complete', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or29 tab status', {
    nodes: [
      { id: 'h', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
      { id: 'w', type: 'wait', position: { x: 300, y: 0 }, config: { seconds: '${1}' } },
      { ...seed.nodes[0]!, position: { x: 600, y: 0 } },
    ],
  });
  await nodeById(page, 'h').click();
  await expectTabNames(tabs(page), ['General', 'Request', 'Auth']);
  const request = tabs(page).getByRole('tab', { name: 'Request' });
  const auth = tabs(page).getByRole('tab', { name: 'Auth' });
  const url = properties(page).getByLabel('Request URL', { exact: true });
  const apply = properties(page).getByRole('button', { name: 'Apply config' });
  // The seed's URL is valid; Request also holds the (unbound, optional)
  // connection, so it is not marked complete either.
  await expect(request).toHaveAccessibleDescription('');

  // Clearing the URL is an edit not yet on the node, and marking it moves no tab.
  const authLeft = async () => (await auth.boundingBox())!.x;
  const before = await authLeft();
  await url.fill('');
  await expect(request).toHaveAccessibleDescription('Unapplied changes');
  // The pending dot sits in the tab's corner, over its padding, not after the label.
  const dot = await request.evaluate((tab) => {
    const at = tab.querySelector('.fui-Tab__content .panel-tabs__pending')!.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    return at.left >= box.left && at.right <= box.right + 0.5 && at.top >= box.top;
  });
  expect(dot).toBe(true);
  await expect(auth).toHaveAccessibleDescription('');
  expect(await authLeft()).toBe(before);

  // Applying it is a problem on Request: the URL is required.
  await apply.click();
  await expect(request).toHaveAccessibleDescription(/^1 problem/);
  const mark = request.locator('.fui-Tab__content .panel-tabs__status');
  await expect(mark).toHaveText('⚠ 1');
  const tone = await mark.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--error)';
    el.appendChild(probe);
    const error = getComputedStyle(probe).color;
    probe.remove();
    return { color: getComputedStyle(el).color, error };
  });
  expect(tone.color).toBe(tone.error);
  await expect(auth).toHaveAccessibleDescription('');

  // Fixed and applied, the mark goes.
  await url.fill('https://a.example.test');
  await apply.click();
  await expect(request).toHaveAccessibleDescription('');
  expect(await authLeft()).toBe(before);

  // A Wait node's Settings tab: its one required field holds a value.
  await nodeById(page, 'w').click();
  const settings = tabs(page).getByRole('tab', { name: 'Settings' });
  await expect(settings).toHaveAccessibleDescription('Complete');
  await expect(settings.locator('.fui-Tab__content .panel-tabs__status')).toHaveText('✓');

  // Copy's four tabs, Mapping's ✓ included, fit the dock in its narrower,
  // right-hand position.
  await nodeById(page, 'c').click();
  await page.getByRole('button', { name: 'Dock to right' }).click();
  await expectTabNames(tabs(page), ['General', 'Source', 'Sink', 'Mapping']);
  const fit = await tabs(page).evaluate((list) => {
    const bound = list.getBoundingClientRect();
    const last = list.querySelector('[role="tab"]:last-of-type')!.getBoundingClientRect();
    return { overflow: list.scrollWidth - list.clientWidth, gap: bound.right - last.right };
  });
  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.gap).toBeGreaterThanOrEqual(0);
  await expectQuiet(page, problems);
});
