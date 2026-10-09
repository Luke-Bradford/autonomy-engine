import { expect, test, type Page } from '@playwright/test';
import { answerConfirm } from './support/confirmDialog';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  computedStyleOf,
  contrastRatio,
  fluentRootReady,
  setTheme,
  surfaceBehind,
} from './support/theme';
import { chooseRowAction } from './support/rowMenu';

/**
 * #844 GL2 — Manage › Global parameters, end to end through the browser.
 *
 * `GlobalParamsPage.test.tsx` mocks every api call, so nothing in vitest shows
 * that a global this page creates is the one the SERVER then lists, that an
 * edit survives a reload, or that the form drawer (#1396 OR5) lays out
 * legibly beside the list and holds unsaved edits. That seam is this spec.
 *
 * The suite runs single-worker over ONE shared SQLite file reset once per RUN,
 * so every name is unique to its test, and rows are found by the global they
 * ARE (the row holding its name), never by position.
 */
const STR = 'e2e_844_gl2_str';
const JSON_NAME = 'e2e_844_gl2_json';
const DUP = 'e2e_844_gl2_dup';
const LOOK = 'e2e_844_gl2_look';

/**
 * Clears this spec's own globals through the API before each test.
 * `reset-state.mjs` wipes once per RUN, so a row left by an earlier attempt
 * would 409 the next CREATE and read as "create is broken" (the trap
 * `secrets.spec.ts` handles with `finally` blocks). Before, not after, so a
 * failed test leaves its state to inspect.
 */
test.beforeEach(async ({ request }) => {
  const res = await request.get('/api/global-params?limit=100');
  expect(res.ok()).toBe(true);
  const { items } = (await res.json()) as { items: { id: string; name: string }[] };
  const mine = new Set([STR, JSON_NAME, DUP, LOOK].map((n) => n.toLowerCase()));
  for (const g of items.filter((i) => mine.has(i.name.toLowerCase()))) {
    expect((await request.delete(`/api/global-params/${g.id}`)).ok()).toBe(true);
  }
});

/** The list row of a stored global, found by its name cell. */
const saved = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
const drawer = (page: Page) => page.getByRole('dialog', { name: /global parameter$/ });
const form = (page: Page) => page.getByRole('form', { name: 'Global parameter form' });
const prompt = (page: Page) => page.getByRole('alertdialog', { name: 'Unsaved changes' });
/** The FIELD a label names: the Value section is a group named "Value" too. */
const field = (page: Page, label: string) =>
  form(page).getByLabel(label, { exact: true }).and(page.locator('input, select, textarea'));

async function open(page: Page) {
  await page.goto('/#/manage/global-params');
  await page.getByRole('heading', { name: 'Global parameters' }).waitFor();
  await fluentRootReady(page);
}

async function create(page: Page, name: string, type: string, value: string) {
  await page.getByRole('button', { name: 'New global parameter' }).click();
  await field(page, 'Name').fill(name);
  await field(page, 'Type').selectOption(type);
  await field(page, 'Value').fill(value);
  await form(page).getByRole('button', { name: 'Create global parameter' }).click();
  await expect(saved(page, name)).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
}

async function reload(page: Page) {
  await page.reload();
  await page.getByRole('heading', { name: 'Global parameters' }).waitFor();
}

test.describe('#844 GL2 the global-params store has a front end', () => {
  test('creates, edits and deletes globals, and each survives a reload', async ({ page }) => {
    const problems = collectPageProblems(page);
    await open(page);

    // Reached from the Manage pane, not only by URL.
    await expect(
      page.getByRole('navigation', { name: 'Manage sections' }).getByRole('link', {
        name: 'Global parameters',
      }),
    ).toHaveAttribute('href', '#/manage/global-params');
    await expect(page.getByText('cleartext', { exact: true })).toBeVisible();

    await create(page, STR, 'string', 'https://example.test');
    await create(page, JSON_NAME, 'json', '{"retries": 3}');

    await reload(page);
    await expect(
      saved(page, STR).getByRole('cell', { name: 'https://example.test' }),
    ).toBeVisible();
    await expect(saved(page, JSON_NAME).getByRole('cell', { name: '{"retries":3}' })).toBeVisible();

    // Name and type are immutable once stored (GL-D1): read-only, still reachable.
    await page.getByRole('button', { name: `Edit ${STR}`, exact: true }).click();
    await expect(field(page, 'Name')).toHaveValue(STR);
    await expect(field(page, 'Name')).toHaveAttribute('readonly', '');
    await expect(field(page, 'Type')).toHaveValue('String');
    await expect(field(page, 'Type')).toHaveAttribute('readonly', '');
    await expect(field(page, 'Value')).toBeFocused();

    // Edit the value; the SERVER holds it, so a reload shows it.
    await field(page, 'Value').fill('https://changed.test');
    await field(page, 'Description').fill('the base URL');
    await form(page).getByRole('button', { name: 'Save changes' }).click();
    await expect(drawer(page)).toHaveCount(0);
    await reload(page);
    await page.getByRole('button', { name: `Edit ${STR}`, exact: true }).click();
    await expect(field(page, 'Value')).toHaveValue('https://changed.test');
    await expect(field(page, 'Description')).toHaveValue('the base URL');
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);

    // Delete, through the real confirmation.
    await chooseRowAction(page, 'Delete', STR);
    const confirmText = await answerConfirm(page, 'accept');
    await expect(saved(page, STR)).toHaveCount(0);
    expect(confirmText).toContain(`"${STR}"`);
    await reload(page);
    await expect(saved(page, JSON_NAME)).toBeVisible();
    await expect(saved(page, STR)).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('a case-variant duplicate name is refused, and says why', async ({ page }) => {
    const problems = collectPageProblems(page);
    await open(page);
    await create(page, DUP, 'number', '1');

    const upper = DUP.toUpperCase();
    await page.getByRole('button', { name: 'New global parameter' }).click();
    await field(page, 'Name').fill(upper);
    await field(page, 'Value').fill('x');
    await form(page).getByRole('button', { name: 'Create global parameter' }).click();
    // #1396 — the NAME's problem, so it is shown beside the Name, and listed.
    const message = `A global parameter named “${upper}” already exists. Names ignore case.`;
    await expect(field(page, 'Name')).toHaveAccessibleDescription(message);
    await expect(form(page).getByRole('alert')).toHaveText(`Fix this field:Name: ${message}`);
    await expect(field(page, 'Name')).toBeFocused();
    // This test PROVOKES the 409, so the browser's own network line for it is
    // expected — anchored on the browser's text, not the app's (see expectQuiet).
    await expectQuiet(page, problems, [/Failed to load resource.*409/]);
  });

  test('the form opens in a drawer beside the list, legible in both themes', async ({ page }) => {
    const problems = collectPageProblems(page);
    await open(page);
    await create(page, LOOK, 'string', 'visible');
    await page.getByRole('button', { name: `Edit ${LOOK}`, exact: true }).click();
    await expect(drawer(page)).toBeVisible();

    // A column to the right of the list, with the row actions still reachable.
    const geometry = await page.evaluate((name) => {
      const table = document.querySelector('table')!.getBoundingClientRect();
      const aside = document.querySelector('.form-drawer')!.getBoundingClientRect();
      // #1397 — Delete is in the row's ⋯ menu; its button must stay clickable
      // (the point lands on its icon, hence `contains`).
      const del = document.querySelector(`[aria-label="Actions for ${name}"]`)!;
      const box = del.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        drawerRightOfTable: aside.left >= table.right,
        rowMenuReachable: hit !== null && del.contains(hit),
        sections: [...document.querySelectorAll('.form-drawer .section__title')].map(
          (l) => l.textContent,
        ),
      };
    }, LOOK);
    expect(geometry).toEqual({
      drawerRightOfTable: true,
      rowMenuReachable: true,
      sections: ['Basics', 'Value'],
    });

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      // #1594 OR40 S3c — label-left, as on every form wide enough
      // (`field-grid.spec.ts`).
      const valueRow =
        '.form-drawer .labelled-control:has(> input[placeholder="empty text is a value"])';
      expect(await computedStyleOf(page, valueRow, 'display')).toBe('grid');
      const input = '.form-drawer input[placeholder="empty text is a value"]';
      const text = await computedStyleOf(page, input, 'color');
      const surface = await surfaceBehind(page, input);
      expect(
        contrastRatio(text, surface.color),
        `${theme}: value text on ${surface.from}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    await expectQuiet(page, problems);
  });

  test('a dirty form is held on Escape and on a route change', async ({ page }) => {
    const problems = collectPageProblems(page);
    await open(page);
    await page.getByRole('button', { name: 'New global parameter' }).click();
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'New global parameter' }).click();
    await field(page, 'Name').fill('half_typed');
    await page.keyboard.press('Escape');
    await expect(prompt(page)).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(field(page, 'Name')).toHaveValue('half_typed');

    await page
      .getByRole('navigation', { name: 'Manage sections' })
      .getByRole('link', { name: 'Secrets' })
      .click();
    await expect(prompt(page)).toBeVisible();
    expect(page.url()).toContain('#/manage/global-params');
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await page.getByRole('heading', { name: 'Secrets' }).waitFor();
    await expectQuiet(page, problems);
  });
});
