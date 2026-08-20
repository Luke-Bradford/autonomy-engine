import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #1115 — Manage → Datasets.
 *
 * What only a real browser + a real server can prove: that the controls this
 * form derives from each dataset kind's own Zod schema are REAL inputs in the
 * SHIPPED bundle, and — the part no unit test reaches, because they all mock
 * the API — that filling them writes exactly those keys through
 * `POST /api/datasets` and reads them back. A stale or mis-bundled shared
 * package is precisely what that would break.
 *
 * Every spec names its rows with a per-test suffix: the suite runs single-worker
 * against one shared SQLite file and rows from earlier specs persist, so
 * anything counting rows would be counting other tests' work.
 */

async function gotoDatasets(page: Page): Promise<void> {
  await page.goto('/#/manage/datasets');
  await page.getByRole('heading', { name: 'Datasets' }).waitFor();
  await fluentRootReady(page);
}

/** Any connection, minted through the real route. */
async function seedConnection(
  page: Page,
  name: string,
  kind: string,
  config: Record<string, unknown>,
): Promise<string> {
  const res = await page.request.post('/api/connections', {
    data: { name, kind, config },
  });
  expect(res.status(), `creating ${kind} connection '${name}': ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** A `sqlite` store — what most of this file needs. */
async function seedStore(page: Page, name: string): Promise<string> {
  return seedConnection(page, name, 'sqlite', { path: `/tmp/${name}.db`, writable: true });
}

function form(page: Page) {
  return page.getByRole('form', { name: 'Dataset form' });
}

/** Read a dataset back from the SERVER by name, walking the paged list (#534). */
async function storedByName(page: Page, wanted: string) {
  return page.evaluate(async (name: string) => {
    type Row = {
      name: string;
      kind: string;
      connectionId: string;
      config: Record<string, unknown>;
      columns: unknown[];
      parameters: string[];
    };
    let cursor: string | null = null;
    for (;;) {
      const url: string =
        cursor === null ? '/api/datasets' : `/api/datasets?cursor=${encodeURIComponent(cursor)}`;
      const body: { items: Row[]; nextCursor: string | null } = await (await fetch(url)).json();
      const hit = body.items.find((r) => r.name === name);
      if (hit !== undefined) return hit;
      if (body.nextCursor === null) return null;
      cursor = body.nextCursor;
    }
  }, wanted);
}

test.describe('#1115 Manage → Datasets', () => {
  test('is reachable from the Manage pane, beside Connections', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/#/manage/connections');
    await page.getByRole('heading', { name: 'Connections' }).waitFor();
    await fluentRootReady(page);

    const pane = page.getByRole('navigation', { name: 'Manage sections' });
    await pane.getByRole('link', { name: 'Datasets' }).click();

    await expect(page.getByRole('heading', { name: 'Datasets' })).toBeVisible();
    // The section is lit, and the breadcrumb reads the trail — the two channels
    // `routes.test.tsx` pins in jsdom, confirmed against the real shell.
    await expect(pane.getByRole('link', { name: 'Datasets' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Datasets');

    await expectQuiet(page, problems);
  });

  test('creates a table dataset through the kind’s own fields, and stores those exact keys', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const stamp = Date.now();
    const storeName = `e2e-ds-store-${stamp}`;
    const storeId = await seedStore(page, storeName);
    const name = `e2e dataset ${stamp}`;

    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    await form(page).getByLabel('Name').fill(name);
    await form(page).getByLabel('Store').selectOption(storeId);
    await form(page).getByLabel('Kind').selectOption('table');

    // A control that exists ONLY because the form read `table`'s own schema.
    await form(page).getByLabel('table', { exact: true }).fill('orders');
    await form(page)
      .getByLabel('Columns (JSON)')
      .fill(JSON.stringify([{ name: 'id', type: 'integer', nullable: false }]));
    await form(page).getByRole('button', { name: 'Create dataset' }).click();

    // The row lands in the list, showing its store by NAME and its column count.
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(storeName);

    const stored = await storedByName(page, name);
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('table');
    expect(stored!.connectionId).toBe(storeId);
    expect(stored!.config).toEqual({ table: 'orders' });
    expect(stored!.columns).toEqual([{ name: 'id', type: 'integer', nullable: false }]);
    // The write body omits `parameters`, so the server's own default applies —
    // it is never sent as an explicit `[]`, which the server reads as a clear.
    expect(stored!.parameters).toEqual([]);

    await expectQuiet(page, problems);
  });

  test('refuses a blank column declaration rather than storing an empty one', async ({ page }) => {
    const problems = collectPageProblems(page);
    const stamp = Date.now();
    const storeId = await seedStore(page, `e2e-ds-blank-${stamp}`);
    const name = `e2e blank columns ${stamp}`;

    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    await form(page).getByLabel('Name').fill(name);
    await form(page).getByLabel('Store').selectOption(storeId);
    await form(page).getByLabel('table', { exact: true }).fill('orders');
    // Columns left EMPTY on purpose.
    await form(page).getByRole('button', { name: 'Create dataset' }).click();

    await expect(form(page).getByRole('alert')).toContainText('Columns is required');
    // Nothing was created — the refusal is not cosmetic.
    expect(await storedByName(page, name)).toBeNull();

    await expectQuiet(page, problems);
  });

  test('swaps the fields with the kind, and forces JSON for a kind with no reader', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();

    // A NEW dataset opens on the first kind that HAS a reader — `table`, not
    // the enum's first member `delimited`.
    await expect(form(page).getByLabel('Kind')).toHaveValue('table');
    await expect(form(page).getByLabel('table', { exact: true })).toBeVisible();

    await form(page).getByLabel('Kind').selectOption('query');
    // `exact` here: `getByLabel` substring-matches, and a `<select>`'s
    // accessible name absorbs its option text — so a plain 'sql' also matches
    // the Store picker whenever any connection in the shared suite database is
    // a `sqlite` one, which is most of them.
    await expect(form(page).getByLabel('sql', { exact: true })).toBeVisible();
    await expect(form(page).getByLabel('table', { exact: true })).toBeHidden();

    await form(page).getByLabel('Kind').selectOption('delimited');
    // No reader, so no derived controls — and the JSON editor rather than the
    // "This kind has no settings" line, which would be false (§2.6 lists seven
    // keys for `delimited`; they are undescribed, not absent).
    await expect(form(page).getByLabel('Config (JSON)')).toBeVisible();
    await expect(form(page).getByText('This kind has no settings.')).toBeHidden();
    await expect(
      form(page).getByText(/no reader exists for a delimited dataset yet/),
    ).toBeVisible();
    // #1145 can land a SECOND note here, but this test does NOT assert it: the
    // form opens on `connections[0]` (`DatasetsPage.tsx` `blankForm`) and the
    // suite database is shared, so whether that first connection is a `sqlite`
    // store — which `delimited` disagrees with — is not this test's to control.
    // The pile-up is asserted deterministically in the #1145 test below.

    await expectQuiet(page, problems);
  });

  test('says a table name that is not a bare identifier is incomplete, before any run', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();

    // #1120 — the advisory. §8's identifier rule is the security-relevant one:
    // a table name cannot be bound as a parameter, so a name that only quoting
    // would make safe is refused by the reader. The operator learns it here.
    await form(page).getByLabel('table', { exact: true }).fill('order lines');
    await expect(form(page).getByText(/This table config is incomplete/)).toContainText(
      'bare SQL identifier',
    );

    await expectQuiet(page, problems);
  });

  test('says the kind and the store disagree, without refusing the save (#1145)', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const stamp = Date.now();
    // `http` rather than `anthropic_api`: it is a real non-store connection and
    // is credential-less, so it needs no secret dance to exist.
    const nonStoreId = await seedConnection(page, `e2e-ds-nonstore-${stamp}`, 'http', {
      baseUrl: 'https://example.com',
    });

    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    await form(page).getByLabel('Store').selectOption(nonStoreId);
    await form(page).getByLabel('Kind').selectOption('table');

    await expect(form(page).getByText(/Kind and store disagree/)).toContainText(
      "names a connection of kind 'http'",
    );
    // ADVISORY, never a gate — the server stores this row today, and a form that
    // refused what the server accepts would be the worse defect.
    await expect(page.getByRole('button', { name: 'Create dataset' })).toBeEnabled();

    // The PILE-UP, asserted where both store kinds are controlled rather than
    // inherited from whatever the shared database happens to hold first. A
    // `delimited` dataset on a `sqlite` store is BOTH unreadable (no reader
    // yet) and mis-stored (`delimited` lives on `fs`) — two true, independent
    // notes, and #1145 must not have swallowed #1120's.
    const storeId = await seedStore(page, `e2e-ds-pileup-${stamp}`);
    await form(page).getByLabel('Store').selectOption(storeId);
    await form(page).getByLabel('Kind').selectOption('delimited');
    await expect(form(page).getByText(/Kind and store disagree/)).toContainText(
      "dataset kind 'delimited' lives in a store of kind 'fs'",
    );
    await expect(
      form(page).getByText(/no reader exists for a delimited dataset yet/),
    ).toBeVisible();

    await expectQuiet(page, problems);
  });
});
