import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * U4 — the Factory Resources pane.
 *
 * What only a real browser can prove here: that the tree's links actually
 * change the ADDRESS (jsdom has no address bar, so a unit test can only inspect
 * the router's own idea of where it is); that the pane's rows are REACHABLE —
 * the `⋯` menu is revealed by `:hover`/`:focus-within`, which jsdom computes no
 * cascade for, so a rule that hid it outright would pass every unit test; that
 * a Fluent `Menu` portalled to `<body>` opens and is clickable from inside a
 * pane that clips its own overflow; and that the whole flow stays free of
 * console errors.
 *
 * Every spec creates its own pipelines with a per-test name prefix: the suite
 * runs single-worker against one shared SQLite file, but rows from an earlier
 * spec in the same file persist, so anything asserting "the tree contains
 * exactly …" would be counting other tests' work.
 */

/** The pane, addressed the way a user perceives it. */
function pane(page: Page) {
  return page.getByRole('navigation', { name: 'Author sections' });
}

/** The pipelines tree inside the pane. */
function tree(page: Page) {
  return pane(page).getByRole('list', { name: 'Pipelines' });
}

async function gotoAuthor(page: Page): Promise<void> {
  await page.goto('/#/author/pipelines');
  await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
  await fluentRootReady(page);
}

/** Create a pipeline THROUGH THE PANE, and wait for it to appear in the tree. */
async function createInPane(page: Page, name: string): Promise<void> {
  await pane(page).getByRole('button', { name: 'New pipeline' }).click();
  await page.getByRole('textbox', { name: 'Pipeline name' }).fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(tree(page).getByRole('link', { name, exact: true })).toBeVisible();
}

/** Open a row's `⋯` menu. It is revealed on hover, so hover first. */
async function openRowMenu(page: Page, name: string): Promise<void> {
  const row = tree(page).getByRole('listitem').filter({ hasText: name }).first();
  await row.hover();
  await row.getByRole('button', { name: `More actions for ${name}` }).click();
}

test.describe('U4 Factory Resources pane', () => {
  test('creates a pipeline in the pane and opens it on the canvas by URL', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    const name = 'e2e u4 open';
    await createInPane(page, name);

    // The pane's create must ALSO reach the page's list — they are two views of
    // one store, and the whole reason that store exists.
    await expect(page.getByRole('main').getByRole('link', { name: `Open ${name}` })).toBeVisible();

    await tree(page).getByRole('link', { name, exact: true }).click();

    // The canvas now has an ADDRESS. Before U4 the open pipeline was local
    // state and this hash never changed.
    // The id's prefix is the server's business (`pipe_` + a nanoid today), so
    // this pins the SHAPE — a non-empty id segment under the list path — rather
    // than a literal that would fail the day the minting changes.
    await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/author\/pipelines\/[\w-]+$/);
    await page.locator('.react-flow__renderer').waitFor();
    await expect(page.getByRole('heading', { name })).toBeVisible();

    // The breadcrumb gained a third crumb — the id, per the `:runId` precedent.
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('listitem');
    await expect(crumbs).toHaveCount(3);
    await expect(crumbs.nth(1)).toHaveText('Pipelines');

    await expectQuiet(page, problems);
  });

  test('a deep link straight to a pipeline renders its canvas', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    const name = 'e2e u4 deeplink';
    await createInPane(page, name);
    await tree(page).getByRole('link', { name, exact: true }).click();
    await page.locator('.react-flow__renderer').waitFor();
    const url = page.url();

    // A RELOAD, not a client-side navigation: this is the bookmark case, which
    // resolves the pipeline from the server with no list in memory at all.
    await page.goto(url);
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await page.locator('.react-flow__renderer').waitFor();

    await expectQuiet(page, problems);
  });

  test('filters the tree, and says so when nothing matches', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    const keep = 'e2e u4 filter keep';
    const hide = 'e2e u4 filter hide';
    await createInPane(page, keep);
    await createInPane(page, hide);

    const filter = pane(page).getByRole('searchbox', { name: 'Filter pipelines' });
    await filter.fill('KEEP');
    await expect(tree(page).getByRole('link', { name: keep, exact: true })).toBeVisible();
    await expect(tree(page).getByRole('link', { name: hide, exact: true })).toBeHidden();

    await filter.fill('nothing-matches-this');
    await expect(pane(page).getByText(/No pipelines match/i)).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('renames a pipeline in place through the row menu', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    const before = 'e2e u4 rename before';
    const after = 'e2e u4 rename after';
    await createInPane(page, before);

    await openRowMenu(page, before);
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const field = page.getByRole('textbox', { name: 'Pipeline name' });
    await expect(field).toHaveValue(before);
    await field.fill(after);
    await page.getByRole('button', { name: 'Rename', exact: true }).click();

    await expect(tree(page).getByRole('link', { name: after, exact: true })).toBeVisible();
    await expect(tree(page).getByRole('link', { name: before, exact: true })).toHaveCount(0);
    // ...and the page's own list agrees, through the shared store.
    await expect(page.getByRole('main').getByRole('link', { name: `Open ${after}` })).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('duplicates a pipeline, defaulting the copy’s name', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    const source = 'e2e u4 dup';
    await createInPane(page, source);

    await openRowMenu(page, source);
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(page.getByRole('textbox', { name: 'Pipeline name' })).toHaveValue(
      `${source} (copy)`,
    );
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click();

    await expect(
      tree(page).getByRole('link', { name: `${source} (copy)`, exact: true }),
    ).toBeVisible();
    // The source survives the copy.
    await expect(tree(page).getByRole('link', { name: source, exact: true })).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('deletes a pipeline, and leaves its canvas if that is where you are', async ({ page }) => {
    const problems = collectPageProblems(page);
    // The pane confirms deletion with `window.confirm`, which Playwright
    // auto-DISMISSES by default — without this the delete would silently no-op
    // and the test would fail with a confusing "still visible".
    page.on('dialog', (dialog) => void dialog.accept());
    await gotoAuthor(page);

    const name = 'e2e u4 delete';
    await createInPane(page, name);
    await tree(page).getByRole('link', { name, exact: true }).click();
    await page.locator('.react-flow__renderer').waitFor();

    await openRowMenu(page, name);
    await page.getByRole('menuitem', { name: 'Delete' }).click();

    await expect(tree(page).getByRole('link', { name, exact: true })).toHaveCount(0);
    // Staying on the deleted pipeline's canvas would show a graph that no
    // longer exists, and 404 on the next load.
    await expect.poll(() => new URL(page.url()).hash).toBe('#/author/pipelines');

    await expectQuiet(page, problems);
  });

  test('the pane survives collapsing and re-expanding', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    const name = 'e2e u4 collapse';
    await createInPane(page, name);

    // U3's toggle hides the whole pane — the tree must come back with it, not
    // remount empty or lose the shell's column arithmetic.
    await page.getByRole('button', { name: 'Hide navigation pane' }).click();
    await expect(pane(page)).toBeHidden();
    await page.getByRole('button', { name: 'Show navigation pane' }).click();
    await expect(tree(page).getByRole('link', { name, exact: true })).toBeVisible();

    // The group's own disclosure is independent of the pane's collapse.
    await pane(page).getByRole('button', { name: /Collapse Pipelines/ }).click();
    await expect(tree(page)).toBeHidden();
    await pane(page).getByRole('button', { name: /Expand Pipelines/ }).click();
    await expect(tree(page).getByRole('link', { name, exact: true })).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('the row menu is reachable by KEYBOARD, not hover alone', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    const name = 'e2e u4 keyboard';
    await createInPane(page, name);

    // The `⋯` is `visibility: hidden` until hover — but `:focus-within` must
    // bring it back, or the whole row's actions are pointer-only. Focus the
    // row's LINK, then Tab to its menu button; no hover anywhere.
    await tree(page).getByRole('link', { name, exact: true }).focus();
    await page.keyboard.press('Tab');
    const menuButton = page.getByRole('button', { name: `More actions for ${name}` });
    await expect(menuButton).toBeFocused();
    await expect(menuButton).toBeVisible();

    await expectQuiet(page, problems);
  });
});
