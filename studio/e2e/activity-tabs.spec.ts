import { expect, test, type Page } from '@playwright/test';
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
 * One read: how far the open tab's content runs past the panel's visible
 * bottom (≤ 0 means it fits without scrolling), with the panel scrolled to top.
 */
function overflowOfOpenTab(page: Page) {
  return properties(page).evaluate((panel) => {
    panel.scrollTop = 0;
    const open = panel.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;
    const visibleBottom = panel.getBoundingClientRect().top + panel.clientHeight;
    return Math.round(open.getBoundingClientRect().bottom - visibleBottom);
  });
}

test('a Copy node opens on Source, and Source, Sink and Mapping each fit the dock', async ({
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
  await expect(source.getByLabel('Container membership')).toBeVisible();
  expect(await overflowOfOpenTab(page)).toBeLessThanOrEqual(0);

  await tabs(page).getByRole('tab', { name: 'Sink' }).click();
  const sink = properties(page).getByRole('tabpanel', { name: 'Sink' });
  await expect(sink.getByRole('combobox', { name: 'Sink connection' })).toBeVisible();
  await expect(sink.getByRole('combobox', { name: 'Sink dataset' })).toBeVisible();
  expect(await overflowOfOpenTab(page)).toBeLessThanOrEqual(0);

  await tabs(page).getByRole('tab', { name: 'Mapping' }).click();
  const mapping = properties(page).getByRole('tabpanel', { name: 'Mapping' });
  await expect(mapping.getByRole('button', { name: 'Add mapping row' })).toBeVisible();
  await expect(mapping.getByRole('button', { name: 'Auto-map columns' })).toBeVisible();
  expect(await overflowOfOpenTab(page)).toBeLessThanOrEqual(0);
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
