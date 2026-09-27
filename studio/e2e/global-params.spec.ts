import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  computedStyleOf,
  contrastRatio,
  fluentRootReady,
  setTheme,
  surfaceBehind,
} from './support/theme';

/**
 * #844 GL2 — Manage › Global parameters, end to end through the browser.
 *
 * `GlobalParamsPage.test.tsx` mocks every api call, so nothing in vitest shows
 * that a global this page creates is the one the SERVER then lists, that an
 * edit survives a reload, or that the `ContractRow` shell — written for the
 * property panel — lays out legibly on a hub page. That seam is this spec.
 *
 * The suite runs single-worker over ONE shared SQLite file reset once per RUN,
 * so every name is unique to its test, and rows are found by the global they
 * ARE (a named group), never by position.
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

const saved = (page: Page, name: string) => page.getByRole('group', { name: `global ${name}` });

async function open(page: Page) {
  await page.goto('/#/manage/global-params');
  await page.getByRole('heading', { name: 'Global parameters' }).waitFor();
  await fluentRootReady(page);
}

async function create(page: Page, name: string, type: string, value: string) {
  await page.getByRole('button', { name: 'Add global parameter' }).click();
  const draft = page.getByRole('group', { name: /^new global/ });
  await draft.getByRole('textbox', { name: /name$/ }).fill(name);
  await draft.getByRole('combobox', { name: /type$/ }).selectOption(type);
  await draft.getByRole('textbox', { name: /value$/ }).fill(value);
  await draft.getByRole('button', { name: /^create global/ }).click();
  await expect(saved(page, name)).toBeVisible();
  await expect(draft).toHaveCount(0);
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

    await page.reload();
    await page.getByRole('heading', { name: 'Global parameters' }).waitFor();
    const str = saved(page, STR);
    await expect(str.getByRole('textbox', { name: /value$/ })).toHaveValue('https://example.test');
    await expect(saved(page, JSON_NAME).getByRole('textbox', { name: /value$/ })).toHaveValue(
      '{"retries":3}',
    );
    // Name and type are immutable once stored (GL-D1): read-only, still reachable.
    await expect(str.getByRole('textbox', { name: /name$/ })).toHaveAttribute('readonly', '');
    await expect(str.getByRole('textbox', { name: /type$/ })).toHaveValue('string');
    await expect(str.getByRole('textbox', { name: /type$/ })).toHaveAttribute('readonly', '');

    // Edit the value; the SERVER holds it, so a reload shows it.
    await str.getByRole('textbox', { name: /value$/ }).fill('https://changed.test');
    await str.getByRole('textbox', { name: /description$/ }).fill('the base URL');
    await str.getByRole('button', { name: /^save global/ }).click();
    await expect(str.getByRole('button', { name: /^save global/ })).toBeDisabled();
    await page.reload();
    await page.getByRole('heading', { name: 'Global parameters' }).waitFor();
    await expect(saved(page, STR).getByRole('textbox', { name: /value$/ })).toHaveValue(
      'https://changed.test',
    );
    await expect(saved(page, STR).getByRole('textbox', { name: /description$/ })).toHaveValue(
      'the base URL',
    );

    // Delete, through the real confirmation.
    let confirmText = '';
    page.once('dialog', (dialog) => {
      confirmText = dialog.message();
      void dialog.accept();
    });
    await saved(page, STR)
      .getByRole('button', { name: /^delete global/ })
      .click();
    await expect(saved(page, STR)).toHaveCount(0);
    expect(confirmText).toContain(`"${STR}"`);
    await page.reload();
    await page.getByRole('heading', { name: 'Global parameters' }).waitFor();
    await expect(saved(page, JSON_NAME)).toBeVisible();
    await expect(saved(page, STR)).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('a case-variant duplicate name is refused, and says why', async ({ page }) => {
    const problems = collectPageProblems(page);
    await open(page);
    await create(page, DUP, 'number', '1');

    const upper = DUP.toUpperCase();
    await page.getByRole('button', { name: 'Add global parameter' }).click();
    const draft = page.getByRole('group', { name: /^new global/ });
    await draft.getByRole('textbox', { name: /name$/ }).fill(upper);
    await draft.getByRole('textbox', { name: /value$/ }).fill('x');
    await draft.getByRole('button', { name: /^create global/ }).click();
    await expect(draft.getByRole('alert')).toHaveText(
      `A global parameter named “${upper}” already exists. Names ignore case.`,
    );
    // This test PROVOKES the 409, so the browser's own network line for it is
    // expected — anchored on the browser's text, not the app's (see expectQuiet).
    await expectQuiet(page, problems, [/Failed to load resource.*409/]);
  });

  test('the row shell stacks and stays legible on a hub page, dark mode included', async ({
    page,
  }) => {
    await open(page);
    await create(page, LOOK, 'string', 'visible');

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      const valueLabel = `[aria-label="global ${LOOK}"] label:has(input[aria-label$="value"])`;
      // Stacked label-over-control, as on the other Manage forms — the
      // property panel's rule does not reach a hub page, this page's must.
      expect(await computedStyleOf(page, valueLabel, 'flex-direction')).toBe('column');
      const input = `[aria-label="global ${LOOK}"] input[aria-label$="value"]`;
      const text = await computedStyleOf(page, input, 'color');
      const surface = await surfaceBehind(page, input);
      expect(
        contrastRatio(text, surface.color),
        `${theme}: value text on ${surface.from}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
