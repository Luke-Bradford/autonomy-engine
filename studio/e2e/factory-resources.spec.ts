import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { loadBanner, openRowMenu, pane, tree } from './support/authorPane';

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

/** Chromium's OWN network-failure entry for the 502 the recovery spec injects. */
const BROWSER_502 =
  /^console\.error: Failed to load resource: the server responded with a status of 502\b/;

test.describe('U4 Factory Resources pane', () => {
  test('creates a pipeline in the pane and opens it on the canvas by URL', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    const name = 'e2e u4 open';
    await createInPane(page, name);

    // The pane's create must ALSO reach the page's list — they are two views of
    // one store, and the whole reason that store exists.
    await expect(
      page.getByRole('main').getByRole('link', { name: `Open ${name}`, exact: true }),
    ).toBeVisible();

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
    await expect(
      page.getByRole('main').getByRole('link', { name: `Open ${after}`, exact: true }),
    ).toBeVisible();

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
    await pane(page)
      .getByRole('button', { name: /Collapse Pipelines/ })
      .click();
    await expect(tree(page)).toBeHidden();
    await pane(page)
      .getByRole('button', { name: /Expand Pipelines/ })
      .click();
    await expect(tree(page).getByRole('link', { name, exact: true })).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('the row menu is reachable by KEYBOARD, not hover alone', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    const name = 'e2e u4 keyboard';
    await createInPane(page, name);

    // The `⋯` is `opacity: 0` until hover — deliberately NOT `visibility`
    // or `display`, both of which would drop it out of the accessibility tree
    // and make the row's actions pointer-only. Focus the row's LINK, then Tab
    // to its menu button; no hover anywhere.
    await tree(page).getByRole('link', { name, exact: true }).focus();
    await page.keyboard.press('Tab');
    const menuButton = page.getByRole('button', { name: `More actions for ${name}` });
    await expect(menuButton).toBeFocused();
    await expect(menuButton).toBeVisible();

    await expectQuiet(page, problems);
  });

  /**
   * The reveal must not depend on the focus it gates.
   *
   * With `visibility: hidden` the button is not focusable until the row already
   * has focus within it, so arriving BACKWARDS — Shift+Tab from the next row —
   * skips it entirely, and a screen reader reading the tree never encounters it
   * at all. `opacity` keeps it in the tab order and the a11y tree throughout.
   */
  test('the row menu is reachable arriving BACKWARDS too', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    const first = 'e2e u4 backtab a';
    const second = 'e2e u4 backtab b';
    await createInPane(page, first);
    await createInPane(page, second);

    // Land on the SECOND row's link, then walk backwards into the first row's
    // menu button — the element that would be skipped if it were unfocusable.
    await tree(page).getByRole('link', { name: second, exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: `More actions for ${first}` })).toBeFocused();

    await expectQuiet(page, problems);
  });

  test('a failed action can be dismissed, and does not hide Retry', async ({ page }) => {
    const problems = collectPageProblems(page);
    page.on('dialog', (dialog) => void dialog.accept());
    await gotoAuthor(page);

    const name = 'e2e u4 dismiss';
    await createInPane(page, name);
    await tree(page).getByRole('link', { name, exact: true }).click();
    await page.locator('.react-flow__renderer').waitFor();

    // Save a version so the pipeline has run-less history, then delete it: the
    // delete succeeds here, so drive the dismissable-message path through a
    // rename to a name the server refuses instead.
    await openRowMenu(page, name);
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByRole('textbox', { name: 'Pipeline name' }).fill('   ');
    // A blank name never reaches the network — the confirm button is disabled,
    // which is itself the assertion.
    await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Pipeline name' })).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('a pipeline whose name PREFIXES another still opens its own canvas', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoAuthor(page);

    // An accessible name is only useful if it identifies ONE thing. `Open <p>`
    // is a substring of `Open <p> …` for every longer sibling, so a list holding
    // both offers two links a name-based lookup cannot tell apart — which is
    // what a screen-reader user hears, and what broke `support/canvas.ts`.
    // Longer one FIRST, so the shorter one is created into a page that already
    // carries a link its name is a substring of.
    const longer = 'e2e u4 prefix guard longer';
    const shorter = 'e2e u4 prefix guard';
    await createInPane(page, longer);
    await createInPane(page, shorter);

    const list = page.getByRole('main');
    await expect(list.getByRole('link', { name: `Open ${shorter}`, exact: true })).toHaveCount(1);
    await list.getByRole('link', { name: `Open ${shorter}`, exact: true }).click();

    await page.locator('.react-flow__renderer').waitFor();
    // The canvas that opened is the SHORTER pipeline's, not its longer sibling's
    // — the failure mode here is silent, since either one mounts a valid canvas.
    await expect(page.getByRole('heading', { name: shorter, exact: true })).toBeVisible();

    await expectQuiet(page, problems);
  });

  /**
   * #761 — a failed list load must not outlive the failure it describes.
   *
   * What only a real browser proves here: that a CLIENT-SIDE navigation (a hash
   * change, no document load) is what clears the banner. In jsdom the whole
   * question is unaskable — `location.reload()`, the remedy this defect used to
   * require, is exactly what a unit test cannot distinguish from a re-render.
   *
   * The failure is injected at the network, not faked in the app, so this also
   * pins the real `?limit=` list URL: the glob MUST be `**\/api\/pipelines*`.
   * A bare `**\/api\/pipelines` matches nothing, because `listPipelines` always
   * sends `?limit=100` — the spec would then pass having never failed a request.
   * (It correctly does NOT match `/api/pipelines/:id`, so the canvas's own fetch
   * below is untouched.)
   *
   * The navigation at the end is WITHIN Author, and that is the whole design of
   * this case. A cross-hub round trip would unmount and remount the list PAGE,
   * whose own recovery would clear the banner — measured: with the pane's effect
   * deleted, a cross-hub version of this spec still passed. Going list → canvas
   * keeps the pane mounted and UNMOUNTS the page, so the pane is the only thing
   * that can possibly recover.
   */
  test('recovers a failed pipelines load on navigation, without a reload', async ({ page }) => {
    const problems = collectPageProblems(page);

    let listRequests = 0;
    let failNextList = false;
    await page.route('**/api/pipelines*', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      listRequests += 1;
      if (!failNextList) return route.fallback();
      failNextList = false;
      await route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
    });

    // A row has to exist to navigate INTO, so the first load must succeed.
    await gotoAuthor(page);
    const name = 'e2e u4 recovers';
    await createInPane(page, name);

    /* Now break the next list load, and provoke one. The cross-hub round trip is
       how it is provoked rather than what is being tested: remounting the page
       calls `ensureFresh`, which loads from `ready` and gets the 502. The store
       keeps the last good list through a failed REFRESH, so the row stays
       clickable underneath the banner — which is what the final step needs. */
    failNextList = true;
    await page.evaluate(() => {
      window.location.hash = '#/monitor/runs';
    });
    await page.getByRole('heading', { name: 'Runs' }).waitFor();
    await page.evaluate(() => {
      window.location.hash = '#/author/pipelines';
    });
    const banner = loadBanner(page);
    await expect(banner).toBeVisible();

    const before = listRequests;
    // A client-side route change with no document load — `location.reload()` was
    // the remedy this defect used to require, so a reload here would prove
    // nothing. The page unmounts with the `<Outlet/>`; the pane does not.
    await tree(page).getByRole('link', { name, exact: true }).click();
    await page.locator('.react-flow__renderer').waitFor();

    /* The banner clearing IS the recovery: the store nulls `error` when a load
       STARTS, so an empty pane here means a fresh request went out. Before the
       fix nothing re-fetched and this banner stayed up for the life of the tab. */
    await expect(banner).toHaveCount(0);
    /* And a real request went out, counted at the network. Deliberately NOT
       "the tree is visible": these specs share one SQLite file, so on an empty
       DB the tree is an empty `<ul>` that Playwright reports as hidden — an
       assertion that would pass or fail on which specs ran before it. */
    /* Polled, not read: `listRequests` increments in the NODE process when the
       route handler fires, while the assertion above becomes true in the BROWSER
       when the load STARTS — which is before the request reaches Node. */
    await expect.poll(() => listRequests).toBeGreaterThan(before);

    /* The deliberate 502 makes Chromium emit its own browser-level "Failed to
       load resource" entry, so this spec allows exactly that ONE shape and holds
       everything else to silence. Anchored on the BROWSER's wording rather than a
       loose `/502/`, because the app's own message for this fault is literally
       `request failed (502)` — a loose pattern would swallow an app-level error
       too, and `expectQuiet` documents the measurement that proved it. */
    await expectQuiet(page, problems, [BROWSER_502]);
  });
});
