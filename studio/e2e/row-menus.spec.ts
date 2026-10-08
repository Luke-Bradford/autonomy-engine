import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady, resolvedPaletteColor } from './support/theme';
import { arrowToItem, deleteRowAndExpectFocus, rowMenuButton } from './support/rowMenu';
import { answerConfirm } from './support/confirmDialog';
import { seedConnection, seedDataset } from './support/seedResources';
import { newPipelineButton } from './support/pipelinesPage';

/**
 * #1397 OR6 — list rows keep ONE action inline (Open, Fire now) and put the
 * rest in a `⋯` menu, Delete last, separated, in the danger colour.
 *
 * Driven by the keyboard throughout, because that is what the unit suites
 * cannot see: jsdom has no focus model for Fluent's menu, so where focus lands
 * when the menu opens, closes, hands off to a drawer, or hands off to a
 * confirmation is only observable here.
 */

const PIPELINE = `e2e 1397 row menu ${Date.now()}`;
const TRIGGER = `e2e-1397-row-menu-${Date.now()}`;
const STAMP = Date.now();

/** The open menu's items and divider, in order; a divider reads as `—`. */
function menuShape(page: Page): Promise<string[]> {
  return page
    .getByRole('menu')
    .evaluate((menu) =>
      Array.from(menu.querySelectorAll('[role="menuitem"], .fui-MenuDivider')).map((el) =>
        el.getAttribute('role') === 'menuitem' ? (el.textContent ?? '').trim() : '—',
      ),
    );
}

test.describe('#1397 row ⋯ menus, by keyboard', () => {
  test('Pipelines: Tab from Open to ⋯, Delete last in red, focus returns to ⋯, then moves on after a Delete', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const res = await page.request.post('/api/pipelines', { data: { name: PIPELINE } });
    expect(res.status(), await res.text()).toBe(201);
    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
    await fluentRootReady(page);

    const row = page.getByRole('row', { name: new RegExp(PIPELINE) });
    // Only Open is inline; nothing else in the row is a button but the menu.
    await expect(row.getByRole('link', { name: `Open ${PIPELINE}` })).toBeVisible();
    await expect(row.getByRole('button')).toHaveCount(1);

    const opener = rowMenuButton(page, PIPELINE);
    await row.getByRole('link', { name: `Open ${PIPELINE}` }).focus();
    await page.keyboard.press('Tab');
    await expect(opener).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    // #1569 slice 7 — Trigger now, Open last run and Runs lead the menu.
    expect(await menuShape(page)).toEqual([
      'Trigger now…',
      'Open last run',
      'Runs',
      'Duplicate…',
      'Clone from version…',
      'Export',
      'Archive',
      '—',
      'Delete',
    ]);
    const del = page.getByRole('menuitem', { name: 'Delete' });
    const exp = page.getByRole('menuitem', { name: 'Export' });
    const error = await resolvedPaletteColor(page, '--error');
    expect(await del.evaluate((el) => getComputedStyle(el).color)).toBe(error);
    expect(await exp.evaluate((el) => getComputedStyle(el).color)).not.toBe(error);
    // Red while it holds focus too: Fluent's own focus rule must not repaint it.
    await arrowToItem(page, del);
    expect(await del.evaluate((el) => getComputedStyle(el).color)).toBe(error);

    // Escape closes the menu and hands focus back to ⋯.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(opener).toBeFocused();

    // A confirmation asked from the menu returns focus to ⋯ when declined,
    // not to <body> (the menu item that asked has unmounted).
    await page.keyboard.press('Enter');
    await arrowToItem(page, page.getByRole('menuitem', { name: 'Archive' }));
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: new RegExp(PIPELINE) });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(opener).toBeVisible();

    // #1470 — accepted, the row and its ⋯ are gone: focus moves to the next row.
    await deleteRowAndExpectFocus(page, row, newPipelineButton(page), (p) =>
      answerConfirm(p, 'accept'),
    );

    await expectQuiet(page, problems);
  });

  test('Triggers: Fire now inline, Edit from ⋯ opens the drawer and closing it returns to ⋯', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const res = await page.request.post('/api/triggers', {
      data: {
        name: TRIGGER,
        pipelineVersionId: null,
        params: {},
        mode: 'schedule',
        schedule: null,
        webhook: null,
        runWindows: null,
        concurrency: { policy: 'skip_if_running' },
        enabled: false,
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    await page.goto('/#/manage/triggers');
    await page.getByRole('heading', { name: 'Triggers' }).waitFor();
    await fluentRootReady(page);

    const row = page.getByRole('row', { name: new RegExp(TRIGGER) });
    const fire = row.getByRole('button', { name: `Fire now: ${TRIGGER}` });
    await expect(fire).toBeVisible();
    // Fire now and the menu button, nothing else.
    await expect(row.getByRole('button')).toHaveCount(2);

    const opener = rowMenuButton(page, TRIGGER);
    await fire.focus();
    await page.keyboard.press('Tab');
    await expect(opener).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    // A schedule trigger has no webhook secret to provision.
    expect(await menuShape(page)).toEqual(['Edit', 'Export', '—', 'Delete']);
    await arrowToItem(page, page.getByRole('menuitem', { name: 'Edit' }));
    await page.keyboard.press('Enter');

    // The drawer takes focus on its first field, not the closing menu's trigger.
    const drawer = page.getByRole('dialog', { name: /trigger$/ });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel('Name')).toBeFocused();
    await expect(drawer.getByLabel('Name')).toHaveValue(TRIGGER);

    // Closed unchanged, focus goes back where the keyboard came from.
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();

    // Delete, declined: focus returns to ⋯ rather than to <body>.
    await page.keyboard.press('Enter');
    await arrowToItem(page, page.getByRole('menuitem', { name: 'Delete' }));
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: new RegExp(TRIGGER) });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    // #1470 — accepted: focus moves on rather than falling to <body>.
    await deleteRowAndExpectFocus(
      page,
      row,
      page.getByRole('button', { name: 'New trigger' }),
      (p) => answerConfirm(p, 'accept'),
    );

    await expectQuiet(page, problems);
  });

  /* The resource pages: Edit (Replace, for a secret) stays inline and the rest
     is in ⋯. Connections and Global parameters read what depends on the row
     BEFORE asking, so by the time the dialog opens the menu item that asked is
     long gone — focus has to be handed back to ⋯ by lookup. */
  const RESOURCE_PAGES: {
    readonly page: string;
    readonly route: string;
    readonly inline: string;
    readonly shape: readonly string[];
    readonly create: string;
    readonly seed: (page: Page) => Promise<string>;
  }[] = [
    {
      page: 'Connections',
      create: 'New connection',
      route: '/#/manage/connections',
      inline: 'Edit',
      shape: ['Export', '—', 'Delete'],
      seed: async (page) => {
        const name = `e2e-1397-rm-conn-${STAMP}`;
        await seedConnection(page, {
          name,
          kind: 'sqlite',
          config: { file: '/tmp/e2e-1397-rm.db' },
        });
        return name;
      },
    },
    {
      page: 'Datasets',
      create: 'New dataset',
      route: '/#/manage/datasets',
      inline: 'Edit',
      shape: ['Export', '—', 'Delete'],
      seed: async (page) => {
        const connectionId = await seedConnection(page, {
          name: `e2e-1397-rm-store-${STAMP}`,
          kind: 'sqlite',
          config: { file: '/tmp/e2e-1397-rm.db' },
        });
        const name = `e2e-1397-rm-ds-${STAMP}`;
        await seedDataset(page, {
          name,
          kind: 'table',
          connectionId,
          config: { table: 'orders' },
          columns: [{ name: 'id', type: 'integer', nullable: false }],
        });
        return name;
      },
    },
    {
      page: 'Global parameters',
      create: 'New global parameter',
      route: '/#/manage/global-params',
      inline: 'Edit',
      shape: ['Export', '—', 'Delete'],
      seed: async (page) => {
        const name = `e2e_1397_rm_${STAMP}`;
        const res = await page.request.post('/api/global-params', {
          data: { name, type: 'string', value: 'v' },
        });
        expect(res.status(), await res.text()).toBe(201);
        return name;
      },
    },
    {
      page: 'Secrets',
      create: 'New secret',
      route: '/#/manage/secrets',
      inline: 'Replace',
      // Delete alone: no separator above it.
      shape: ['Delete'],
      seed: async (page) => {
        const name = `e2e-1397-rm-secret-${STAMP}`;
        const res = await page.request.post('/api/secrets', { data: { name, secret: 'x' } });
        expect(res.ok(), await res.text()).toBe(true);
        return name;
      },
    },
  ];

  for (const spec of RESOURCE_PAGES) {
    test(`${spec.page}: ${spec.inline} inline, Delete last in red, a declined Delete returns to ⋯, an accepted one moves on`, async ({
      page,
    }) => {
      const problems = collectPageProblems(page);
      const name = await spec.seed(page);
      await page.goto(spec.route);
      await page.getByRole('heading', { name: spec.page, exact: true }).waitFor();
      await fluentRootReady(page);

      const row = page.getByRole('row', { name: new RegExp(name) });
      const inline = row.getByRole('button', { name: `${spec.inline} ${name}`, exact: true });
      await expect(inline).toBeVisible();
      // The inline action and the menu button, nothing else.
      await expect(row.getByRole('button')).toHaveCount(2);

      const opener = rowMenuButton(page, name);
      await inline.focus();
      await page.keyboard.press('Tab');
      await expect(opener).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu')).toBeVisible();
      expect(await menuShape(page)).toEqual(spec.shape);
      const del = page.getByRole('menuitem', { name: 'Delete' });
      await arrowToItem(page, del);
      expect(await del.evaluate((el) => getComputedStyle(el).color)).toBe(
        await resolvedPaletteColor(page, '--error'),
      );

      await page.keyboard.press('Enter');
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(name);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
      // Declined: the row is still there.
      await expect(row).toBeVisible();

      // #1470 — accepted: focus goes to the neighbouring row's ⋯, or New.
      await deleteRowAndExpectFocus(
        page,
        row,
        page.getByRole('button', { name: spec.create, exact: true }),
        (p) => answerConfirm(p, 'accept'),
      );

      await expectQuiet(page, problems);
    });
  }
});
