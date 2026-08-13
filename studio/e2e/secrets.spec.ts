import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #1060 — the standalone secret vault, end to end through the browser.
 *
 * Why this needs a browser. Each unit suite covers one side and neither can
 * cover the seam: the server suite proves the routes encrypt, list and delete,
 * and `SecretsPage.test.tsx` proves the page calls the right functions — but
 * every api function is mocked there, so nothing in vitest checks that a
 * secret this page CREATES is the one the list then shows, or that deleting it
 * removes it from the server rather than only from React state. That seam is
 * the entire ticket: the whole subsystem existed server-side and was simply
 * unreachable.
 *
 * The value is never asserted, anywhere, because nothing can return it — that
 * is the write-only property, not an omission in this spec.
 */

/** Unique per test: the suite is single-worker over ONE shared SQLite file and
 *  `reset-state.mjs` runs once per RUN, not per test. Names are unique
 *  case-insensitively (`UNIQUE(owner_id, name COLLATE NOCASE)`), so a leftover
 *  row from an earlier test would 409 and read as "create is broken". */
const NAME = 'e2e-1060-vault-key';
const DUP_NAME = 'e2e-1060-duplicate-key';

test.describe('#1060 the secrets vault has a front end', () => {
  test('creates a secret, lists it, and deletes it', async ({ page }) => {
    const problems = collectPageProblems(page);

    await page.goto('/#/manage/secrets');
    await page.getByRole('heading', { name: 'Secrets' }).waitFor();
    await fluentRootReady(page);

    // The page has to say how a node references what it creates — a vault
    // whose contents cannot be addressed is not a usable core path.
    await expect(page.getByText('{"$secret": "<name>"}')).toBeVisible();

    await page.getByRole('button', { name: 'New secret' }).click();
    await page.getByLabel('Name').fill(NAME);
    await page.getByLabel('Value').fill('e2e-plaintext-never-returned');
    await page.getByRole('button', { name: 'Create secret' }).click();

    // Listed by name — and this row came back from the SERVER, since the form
    // closes and the page refetches rather than pushing local state.
    await expect(page.getByRole('cell', { name: NAME, exact: true })).toBeVisible();

    const deleteButton = page.getByRole('button', { name: `Delete ${NAME}`, exact: true });

    // The confirmation is the only place the cost of deleting is stated, and
    // the route cannot state it — capture the real dialog.
    let confirmText = '';
    page.once('dialog', (dialog) => {
      confirmText = dialog.message();
      void dialog.accept();
    });
    await deleteButton.click();

    await expect(deleteButton).toHaveCount(0);
    expect(confirmText).toContain(`{"$secret":"${NAME}"}`);

    // Gone from the server, not just from this render: a reload re-reads it.
    await page.reload();
    await page.getByRole('heading', { name: 'Secrets' }).waitFor();
    await expect(page.getByRole('button', { name: `Delete ${NAME}`, exact: true })).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('a duplicate name is explained, including that names ignore case', async ({ page }) => {
    const problems = collectPageProblems(page);

    await page.goto('/#/manage/secrets');
    await page.getByRole('heading', { name: 'Secrets' }).waitFor();
    await fluentRootReady(page);

    await page.getByRole('button', { name: 'New secret' }).click();
    await page.getByLabel('Name').fill(DUP_NAME);
    await page.getByLabel('Value').fill('first');
    await page.getByRole('button', { name: 'Create secret' }).click();
    await expect(page.getByRole('cell', { name: DUP_NAME, exact: true })).toBeVisible();

    // A CASE VARIANT — the collision an operator cannot see coming, and the
    // one the server's generic conflict message cannot explain. This is the
    // real 409 from the real NOCASE unique index, not a stubbed rejection.
    await page.getByRole('button', { name: 'New secret' }).click();
    await page.getByLabel('Name').fill(DUP_NAME.toUpperCase());
    await page.getByLabel('Value').fill('second');
    await page.getByRole('button', { name: 'Create secret' }).click();

    try {
      const alert = page.getByRole('alert');
      await expect(alert).toContainText('already exists');
      await expect(alert).toContainText('ignore case');
      await expect(alert).not.toContainText('The request conflicts with existing data.');
    } finally {
      // In a `finally`, because the cleanup matters MOST when an assertion
      // above has just failed: `reset-state.mjs` wipes once per RUN, not per
      // test, so a row left behind would make the next attempt at this test
      // 409 on its FIRST create — which reads as "create is broken" rather
      // than as leftover state. Exactly the trap the note at the top of this
      // file describes, which a trailing cleanup does not actually avoid.
      await page.getByRole('button', { name: 'Cancel' }).click();
      page.once('dialog', (dialog) => void dialog.accept());
      await page.getByRole('button', { name: `Delete ${DUP_NAME}`, exact: true }).click();
      await expect(
        page.getByRole('button', { name: `Delete ${DUP_NAME}`, exact: true }),
      ).toHaveCount(0);
    }

    // This test PROVOKES the 409, so the browser's own network entry for it is
    // expected output. Anchored on the browser-level text so it cannot swallow
    // an app-emitted message that merely contains "409"; and `expectQuiet`
    // fails an allow pattern that matches nothing, so this cannot go stale
    // into a regression-hider (same shape as `archived-pipeline.spec.ts`).
    await expectQuiet(page, problems, [/Failed to load resource.*409/]);
  });
});
