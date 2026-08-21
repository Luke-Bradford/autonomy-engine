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

/**
 * Any connection, minted through the real route.
 *
 * A CONNECTION NAME MUST NOT CONTAIN THE LABEL TEXT OF ANY OTHER CONTROL ON THE
 * DATASET FORM — 'Kind', 'Name', 'Columns'. Every connection this suite mints
 * becomes an OPTION in the form's Store picker, and Playwright's
 * `getByLabel(string)` is a case-insensitive SUBSTRING match against the
 * wrapping label's text, which for a `<label>` around a `<select>` includes
 * every option. So a store named `e2e-ds-kinds-…` makes `getByLabel('Kind')`
 * resolve to the Store select AS WELL as the Kind one, and every
 * `getByLabel('Kind')` in the file dies of a strict-mode violation.
 *
 * 'Store' itself is the exception and `e2e-ds-store-…` below is fine: the Store
 * select's own label already contains it, so a Store OPTION carrying it adds no
 * second match. It is other controls' labels that a name must stay clear of.
 *
 * The suite database is SHARED across spec files, so the blast radius is not
 * the test that seeded it — this cost six failures across two files once
 * (#1167), and the name is the only thing that prevents it.
 */
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

/** An `fs` store — where a `delimited` dataset lives (#1167). */
async function seedFileStore(page: Page, name: string): Promise<string> {
  return seedConnection(page, name, 'fs', { roots: ['/tmp'] });
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
    // EXPLICIT since #1167. A new form derives its opening kind from the store
    // it opens on, and `blankForm` opens on `connections[0]` in a SHARED suite
    // database — so if that happens to be an `fs` connection the form starts on
    // `delimited` and there is no `table` field to fill. Picking the store does
    // not re-derive the kind (that would clobber a choice the operator may have
    // made deliberately), so the kind is this test's to state.
    await form(page).getByLabel('Kind').selectOption('table');
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
    // NOT `…-kinds-…`: see `seedConnection`'s naming rule.
    const storeId = await seedStore(page, `e2e-ds-swap-${Date.now()}`);
    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    // Pinned to a store we control. The suite database is SHARED and
    // `blankForm` opens on `connections[0]`, so since #1167 derived the opening
    // kind from that store, which kind the form starts on is not this test's to
    // inherit — the spec below owns that question deterministically.
    await form(page).getByLabel('Store').selectOption(storeId);

    await form(page).getByLabel('Kind').selectOption('table');
    await expect(form(page).getByLabel('table', { exact: true })).toBeVisible();

    await form(page).getByLabel('Kind').selectOption('query');
    // `exact` here: `getByLabel` substring-matches, and a `<select>`'s
    // accessible name absorbs its option text — so a plain 'sql' also matches
    // the Store picker whenever any connection in the shared suite database is
    // a `sqlite` one, which is most of them.
    await expect(form(page).getByLabel('sql', { exact: true })).toBeVisible();
    await expect(form(page).getByLabel('table', { exact: true })).toBeHidden();

    // #1167 gave `delimited` a READER, so it gets §2.6's typed controls now.
    // The gate that forces JSON is the reader and never an absent field form,
    // which is exactly why this kind changed sides while its schema did not.
    await form(page).getByLabel('Kind').selectOption('delimited');
    await expect(form(page).getByLabel('path', { exact: true })).toBeVisible();
    await expect(form(page).getByLabel('Config (JSON)')).toBeHidden();
    await expect(form(page).getByText(/no reader exists for a delimited dataset yet/)).toBeHidden();
    // The MIS-STORE note survives on its own, which is what keeps #1145's
    // advisory and #1120's two independent facts rather than one: this is a
    // `sqlite` store and `delimited` lives on `fs`.
    await expect(form(page).getByText(/Kind and store disagree/)).toContainText(
      "dataset kind 'delimited' lives in a store of kind 'fs'",
    );

    // `excel` holds the reader gate open now — same branch, same reason. Kept
    // so this spec still has an arm that can fail rather than becoming a
    // restatement of the enum.
    await form(page).getByLabel('Kind').selectOption('excel');
    await expect(form(page).getByLabel('Config (JSON)')).toBeVisible();
    await expect(form(page).getByText('This kind has no settings.')).toBeHidden();
    await expect(form(page).getByText(/no reader exists for a excel dataset yet/)).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('authors a delimited dataset on an fs store, cleanly', async ({ page }) => {
    // #1167's user-visible step: the pair a CSV -> SQLite copy needs is now
    // authorable end to end — typed controls, no no-reader note, no mis-store
    // note. Deliberately NOT an assertion about the DEFAULT kind: `blankForm`
    // opens on `connections[0]` and the suite database is shared, so which
    // connection that is cannot be fixed from here. `DatasetsPage.test.tsx`
    // pins the store-aware default deterministically instead.
    const problems = collectPageProblems(page);
    const fileStore = await seedFileStore(page, `e2e-ds-fs-${Date.now()}`);

    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    await form(page).getByLabel('Store').selectOption(fileStore);
    // `delimited` is what lives in an `fs` store, and the form must reach it
    // without the operator being told the pair disagrees.
    await form(page).getByLabel('Kind').selectOption('delimited');
    await expect(form(page).getByText(/Kind and store disagree/)).toBeHidden();
    await expect(form(page).getByLabel('path', { exact: true })).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('says a table name that is not a bare identifier is incomplete, before any run', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    // EXPLICIT since #1167 — see the note in the blank-columns test above: the
    // opening kind is derived from `connections[0]`, which a shared suite
    // database does not let this test fix.
    await form(page).getByLabel('Kind').selectOption('table');

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
    // BOTH stores are seeded before the page loads, like every other test here.
    // The form's Store picker is rendered from the connections the page fetched
    // on mount, so a connection minted mid-test has no option to select.
    const storeId = await seedStore(page, `e2e-ds-pileup-${stamp}`);

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
    // inherited from whatever the shared database happens to hold first. The
    // kind carrying it is `excel` as of #1167, NOT `delimited`: this arm needs a
    // kind that is BOTH unreadable and mis-stored, and #1167 gave `delimited` a
    // reader, so it can now only be the second of those. `excel` still lives on
    // `fs` (`DATASET_CONNECTION_KINDS`) and still has no reader
    // (`IMPLEMENTED_DATASET_KINDS`), so it is the pair this test was written
    // for — two true, independent notes, and #1145 must not have swallowed
    // #1120's.
    await form(page).getByLabel('Store').selectOption(storeId);
    await form(page).getByLabel('Kind').selectOption('excel');
    await expect(form(page).getByText(/Kind and store disagree/)).toContainText(
      "dataset kind 'excel' lives in a store of kind 'fs'",
    );
    await expect(form(page).getByText(/no reader exists for a excel dataset yet/)).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('#1158 marks a dataset the LIST has stranded, compactly, with the full reason readable', async ({
    page,
  }) => {
    // The defect, reproduced through the real route that causes it: a
    // connection's `kind` is MUTABLE, so a `sqlite` store can BECOME an `http`
    // connection, and nothing re-checks the datasets that named it. #1145's
    // advisory existed but rendered on the edit FORM only, so the disagreement
    // was true and invisible until somebody opened that dataset.
    const problems = collectPageProblems(page);
    const storeId = await seedStore(page, 'e2e-ds-strand-store');
    const created = await page.request.post('/api/datasets', {
      data: {
        name: 'e2e-ds-strand',
        connectionId: storeId,
        kind: 'table',
        config: { table: 'orders' },
        columns: [{ name: 'id', type: 'integer', nullable: false }],
      },
    });
    expect(created.status(), `seeding dataset: ${await created.text()}`).toBe(201);

    // The mutation itself, through the API an operator's own edit would use.
    const stranded = await page.request.patch(`/api/connections/${storeId}`, {
      data: { kind: 'http', config: { baseUrl: 'https://example.invalid' } },
    });
    expect(stranded.status(), `re-kinding the store: ${await stranded.text()}`).toBe(200);

    await gotoDatasets(page);
    const row = page.getByRole('row', { name: /e2e-ds-strand/ });
    await expect(row).toBeVisible();

    // ONE evaluate carrying every computed assertion — what a jsdom unit test
    // cannot reach is precisely this: that `visually-hidden` really does take
    // the ~20-word sentence OUT of the layout in the shipped bundle, so the
    // fixed-width cell shows a short marker and not a wall of text, while the
    // sentence itself stays in the accessibility tree for anyone reading it.
    const measured = await row.evaluate((el) => {
      const hidden = el.querySelector('.visually-hidden');
      const marker = hidden?.parentElement ?? null;
      const style = hidden === null ? null : getComputedStyle(hidden);
      const box = hidden?.getBoundingClientRect() ?? null;
      return {
        markerText: marker?.textContent ?? '',
        hiddenText: hidden?.textContent ?? '',
        clipPath: style?.clipPath ?? '',
        position: style?.position ?? '',
        // Still rendered (not `display:none`), which is what keeps it in the
        // accessibility tree — the reason this class exists rather than
        // `hidden`.
        display: style?.display ?? '',
        width: box === null ? -1 : Math.round(box.width),
        height: box === null ? -1 : Math.round(box.height),
      };
    });

    expect(measured.markerText).toContain('kind mismatch');
    expect(measured.hiddenText).toContain(
      "dataset kind 'table' lives in a store of kind 'sqlite' or 'postgres', but this one names a connection of kind 'http'",
    );
    expect(measured.clipPath).toBe('inset(50%)');
    expect(measured.position).toBe('absolute');
    expect(measured.display).not.toBe('none');
    expect(measured.width).toBeLessThanOrEqual(1);
    expect(measured.height).toBeLessThanOrEqual(1);

    // ADVISORY, never a gate — #1158 says so in as many words. The row keeps
    // every action it had.
    await expect(row.getByRole('button', { name: 'Edit' })).toBeEnabled();

    await expectQuiet(page, problems);
  });
});
