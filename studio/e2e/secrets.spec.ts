import { expect, test } from '@playwright/test';
import { answerConfirm } from './support/confirmDialog';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { chooseRowAction, rowMenuButton } from './support/rowMenu';

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
const ROTATE_NAME = 'e2e-1061-rotate-key';
const DRAWER_NAME = 'e2e-1396-secret-drawer';
const INERT_NAME = 'e2e-1438-inert-while-saving';

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
    await page
      .getByRole('textbox', { name: 'Value', exact: true })
      .fill('e2e-plaintext-never-returned');
    await page.getByRole('button', { name: 'Create secret' }).click();

    // Listed by name — and this row came back from the SERVER, since the form
    // closes and the page refetches rather than pushing local state.
    await expect(page.getByRole('cell', { name: NAME, exact: true })).toBeVisible();

    const menuButton = rowMenuButton(page, NAME);

    // The confirmation is the only place the cost of deleting is stated, and
    // the route cannot state it — read the real dialog.
    await chooseRowAction(page, 'Delete', NAME);
    const confirmText = await answerConfirm(page, 'accept');

    await expect(menuButton).toHaveCount(0);
    expect(confirmText).toContain(`{"$secret":"${NAME}"}`);

    // Gone from the server, not just from this render: a reload re-reads it.
    await page.reload();
    await page.getByRole('heading', { name: 'Secrets' }).waitFor();
    await expect(rowMenuButton(page, NAME)).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('#1061 replaces a value in place — one PATCH, one row, same name', async ({ page }) => {
    const problems = collectPageProblems(page);

    await page.goto('/#/manage/secrets');
    await page.getByRole('heading', { name: 'Secrets' }).waitFor();
    await fluentRootReady(page);

    await page.getByRole('button', { name: 'New secret' }).click();
    await page.getByLabel('Name').fill(ROTATE_NAME);
    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('first-value');
    await page.getByRole('button', { name: 'Create secret' }).click();
    await expect(page.getByRole('cell', { name: ROTATE_NAME, exact: true })).toBeVisible();

    try {
      await page.getByRole('button', { name: `Replace ${ROTATE_NAME}`, exact: true }).click();

      // The name comes through read-only: it is the lookup key, and the route
      // refuses a rename outright.
      const nameField = page.getByLabel('Name');
      await expect(nameField).toHaveValue(ROTATE_NAME);
      await expect(nameField).toHaveAttribute('readonly', '');

      await page.getByRole('textbox', { name: 'Value', exact: true }).fill('second-value');

      // The ONLY browser-observable proof that the rotation reached the
      // server. Everything else on this page — one row, same name, no error —
      // is equally true of a rotate that silently did nothing, because a
      // rotation changes no visible field (there is no `updatedAt`, and
      // `createdAt` is deliberately preserved). That the ciphertext really
      // moved is the server suite's assertion, not one a browser can make: no
      // route returns a value, which is the write-only property working.
      const [patch] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            /\/api\/secrets\/[^/]+$/.test(new URL(r.url()).pathname),
        ),
        page.getByRole('button', { name: 'Replace value', exact: true }).click(),
      ]);
      expect(patch.status()).toBe(200);

      // A DELETE + POST would satisfy "the row is still there" too, so assert
      // the shape that distinguishes them: exactly one row of this name, and
      // it survives a reload (i.e. the server holds it, not React state).
      await expect(page.getByRole('cell', { name: ROTATE_NAME, exact: true })).toHaveCount(1);
      await expect(page.getByRole('alert')).toHaveCount(0);

      await page.reload();
      await page.getByRole('heading', { name: 'Secrets' }).waitFor();
      await expect(page.getByRole('cell', { name: ROTATE_NAME, exact: true })).toHaveCount(1);
    } finally {
      // In a `finally` for the reason the test below states: `reset-state.mjs`
      // wipes once per RUN, so a row left behind 409s the next attempt's
      // CREATE and reads as "create is broken".
      await chooseRowAction(page, 'Delete', ROTATE_NAME);
      await answerConfirm(page, 'accept');
      await expect(rowMenuButton(page, ROTATE_NAME)).toHaveCount(0);
    }

    await expectQuiet(page, problems);
  });

  test('a duplicate name is explained, including that names ignore case', async ({ page }) => {
    const problems = collectPageProblems(page);

    await page.goto('/#/manage/secrets');
    await page.getByRole('heading', { name: 'Secrets' }).waitFor();
    await fluentRootReady(page);

    await page.getByRole('button', { name: 'New secret' }).click();
    await page.getByLabel('Name').fill(DUP_NAME);
    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('first');
    await page.getByRole('button', { name: 'Create secret' }).click();
    await expect(page.getByRole('cell', { name: DUP_NAME, exact: true })).toBeVisible();

    // A CASE VARIANT — the collision an operator cannot see coming, and the
    // one the server's generic conflict message cannot explain. This is the
    // real 409 from the real NOCASE unique index, not a stubbed rejection.
    await page.getByRole('button', { name: 'New secret' }).click();
    await page.getByLabel('Name').fill(DUP_NAME.toUpperCase());
    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('second');
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
      // The form still holds what was typed, so Cancel asks first (#1396).
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Discard changes' }).click();
      await chooseRowAction(page, 'Delete', DUP_NAME);
      await answerConfirm(page, 'accept');
      await expect(rowMenuButton(page, DUP_NAME)).toHaveCount(0);
    }

    // This test PROVOKES the 409, so the browser's own network entry for it is
    // expected output. Anchored on the browser-level text so it cannot swallow
    // an app-emitted message that merely contains "409"; and `expectQuiet`
    // fails an allow pattern that matches nothing, so this cannot go stale
    // into a regression-hider (same shape as `archived-pipeline.spec.ts`).
    await expectQuiet(page, problems, [/Failed to load resource.*409/]);
  });

  test('#1396 replace opens in a drawer beside the list, focus on the value', async ({
    page,
    request,
  }) => {
    const problems = collectPageProblems(page);
    const created = await request.post('/api/secrets', {
      data: { name: DRAWER_NAME, secret: 'first' },
    });
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    try {
      await page.goto('/#/manage/secrets');
      await page.getByRole('heading', { name: 'Secrets' }).waitFor();
      await page.getByRole('button', { name: `Replace ${DRAWER_NAME}`, exact: true }).click();
      const drawer = page.getByRole('dialog', { name: `Replace value for ${DRAWER_NAME}` });
      await expect(drawer).toBeVisible();

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
          actions: [...document.querySelectorAll('.form-drawer-footer button')].map(
            (b) => b.textContent,
          ),
        };
      }, DRAWER_NAME);
      expect(geometry).toEqual({
        drawerRightOfTable: true,
        rowMenuReachable: true,
        sections: ['Basics', 'Value'],
        actions: ['Cancel', 'Replace value'],
      });

      const value = page.getByRole('textbox', { name: 'Value', exact: true });
      await expect(value).toBeFocused();
      await page.getByRole('button', { name: 'Show secret' }).click();
      await expect(value).toHaveAttribute('type', 'text');

      // Typed, so leaving asks first; a clean Escape after Discard would not.
      await value.fill('half-typed');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeVisible();
      await page.getByRole('button', { name: 'Discard changes' }).click();
      await expect(drawer).toHaveCount(0);
    } finally {
      expect((await request.delete(`/api/secrets/${id}`)).ok()).toBe(true);
    }
    await expectQuiet(page, problems);
  });

  /**
   * #1438 — anything typed while a save is in flight used to be dropped when
   * the drawer closed on success. The body is inert while busy: only a browser
   * can show that keystrokes and focus are refused there, and that focus comes
   * back to the field when a failed save hands the form back.
   */
  test('the form is inert while its save is in flight, and live again after a failure', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/secrets', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await held;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'store unavailable' }),
      });
    });

    await page.goto('/#/manage/secrets');
    await page.getByRole('heading', { name: 'Secrets' }).waitFor();
    await fluentRootReady(page);
    await page.getByRole('button', { name: 'New secret' }).click();
    const name = page.getByLabel('Name');
    const value = page.getByRole('textbox', { name: 'Value', exact: true });
    await name.fill(INERT_NAME);
    await value.fill('typed-before-save');
    await value.press('Enter');
    await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    const whileSaving = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.form-drawer-body')!;
      const field = body.querySelector<HTMLInputElement>('input')!;
      field.focus();
      return {
        inert: body.inert,
        busy: body.getAttribute('aria-busy'),
        took: document.activeElement === field,
      };
    });
    expect(whileSaving).toEqual({ inert: true, busy: 'true', took: false });
    await page.keyboard.type('-typed-during-save');
    await expect(value).toHaveValue('typed-before-save');
    await expect(name).toHaveValue(INERT_NAME);

    release();
    await expect(page.getByRole('alert')).toContainText('store unavailable');
    await expect(value).toBeFocused();
    await value.press('End');
    await page.keyboard.type('-editable');
    await expect(value).toHaveValue('typed-before-save-editable');
    await expectQuiet(page, problems, [/503/]);
  });
});
