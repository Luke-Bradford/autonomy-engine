import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openNewConnection } from './support/newConnection';
import { seedConnection } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #1694 OR42 item 4 — the per-field `?` audit, carried from the properties
 * pane (`property-pane-ratchet.spec.ts`) to the connection and dataset forms.
 * A field shows a `?` only where the catalog wrote it a note, and a note that
 * restated its label was deleted (CSV header, Postgres statement timeout, CLI
 * timeout, …). This opens the NEW form of every connection kind and every
 * dataset kind at 1440×900 and holds its `?` count to the measured figure
 * below, which may only fall. The kinds are read from the page (the kind
 * gallery's tiles, the dataset form's Kind options), so a kind the map does not
 * know fails until its form is looked at and seeded.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/**
 * Connection kind → the most `?`s its new form may show. Lower only. Each
 * count is the form's section `?`s (#1413 keeps one per section outside the
 * properties pane: Basics, Connection, Authentication, Advanced, Annotations),
 * the Secret picker's, and the kind's fields whose note is not its label.
 * #1712 raised agent_cli and postgres once, on purpose: the CLI timeout and the
 * two postgres timeouts now state the default the server applies. #1600 OR41
 * C3b raised sqlite and postgres once more: Allow writes now says it lets a
 * Copy run its Pre-copy script, the SQL authority ticking it grants.
 */
const CONNECTION_HELP_LIMITS: Record<string, number> = {
  anthropic_api: 8,
  openai_api: 7,
  ollama: 7,
  agent_cli: 14,
  http: 7,
  fs: 10,
  sqlite: 9,
  postgres: 11,
};

/**
 * Dataset kind → the most `?`s its new form may show. Lower only. Basics,
 * Dataset, Columns, Columns (JSON) and Advanced are in every count.
 */
const DATASET_HELP_LIMITS: Record<string, number> = {
  delimited: 12,
  excel: 10,
  table: 6,
  // +1 for C1q-c's Query timeout, a new field whose `?` says blank means no limit.
  query: 8,
};

/** The store kind each dataset kind is made on, for the form's Store picker. */
const DATASET_STORE: Record<string, 'fs' | 'sqlite'> = {
  delimited: 'fs',
  excel: 'fs',
  table: 'sqlite',
  query: 'sqlite',
};

/** The visible `?`s in `form`, by name, read once its fields have settled. */
async function helpNames(form: Locator): Promise<string[]> {
  const read = () =>
    form.evaluate((root) =>
      [...root.querySelectorAll('summary[aria-label^="About "]')]
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((el) => (el.getAttribute('aria-label') ?? '').replace(/^About /, '')),
    );
  let last = await read();
  await expect
    .poll(async () => {
      const again = await read();
      const settled = JSON.stringify(again) === JSON.stringify(last);
      last = again;
      return settled;
    })
    .toBe(true);
  return last;
}

/** A miss when `kind`'s `?`s rise above its seeded limit, naming them all. */
function overLimit(kind: string, names: string[], limits: Record<string, number>): string[] {
  const limit = limits[kind];
  const seen = `${names.length} (${names.join(', ')})`;
  if (limit === undefined) return [`${kind}: not seeded, measured ${seen}`];
  return names.length > limit ? [`${kind}: ? ${seen} > ${limit}`] : [];
}

/** A miss for each seeded kind the page no longer offers: a stale limit. */
function unseen(kinds: string[], limits: Record<string, number>): string[] {
  return Object.keys(limits)
    .filter((kind) => !kinds.includes(kind))
    .map((kind) => `${kind}: seeded but not offered`);
}

async function gotoManage(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(`/#/manage/${path}`);
  await page.getByRole('heading', { name: heading }).waitFor();
  await fluentRootReady(page);
}

test('every connection kind’s new form holds its `?` count', async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectPageProblems(page);
  await gotoManage(page, 'connections', 'Connections');
  const form = page.getByRole('form', { name: 'Connection form' });
  await page.getByRole('button', { name: 'New connection' }).click();
  const gallery = page.getByRole('dialog', { name: 'New connection' });
  const kinds = await gallery
    .locator('.kind-gallery__tile .kind-icon[data-kind]')
    .evaluateAll((icons) => icons.map((icon) => icon.getAttribute('data-kind') ?? ''));
  expect(kinds.length, 'the gallery offers kinds').toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(gallery).toBeHidden();
  const misses = unseen(kinds, CONNECTION_HELP_LIMITS);
  for (const kind of kinds) {
    await openNewConnection(page, kind);
    misses.push(...overLimit(kind, await helpNames(form), CONNECTION_HELP_LIMITS));
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();
  }
  expect(misses).toEqual([]);
  await expectQuiet(page, problems);
});

test('every dataset kind’s new form holds its `?` count', async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectPageProblems(page);
  const stamp = Date.now();
  const stores = {
    fs: await seedConnection(page, {
      name: `e2e-or42-help-fs-${stamp}`,
      kind: 'fs',
      config: { roots: [`/tmp/e2e-or42-help-${stamp}`] },
    }),
    sqlite: await seedConnection(page, {
      name: `e2e-or42-help-sqlite-${stamp}`,
      kind: 'sqlite',
      config: {
        roots: [`/tmp/e2e-or42-help-${stamp}`],
        path: `/tmp/e2e-or42-help-${stamp}/store.db`,
      },
    }),
  };
  await gotoManage(page, 'datasets', 'Datasets');
  await page.getByRole('button', { name: 'New dataset' }).click();
  const form = page.getByRole('form', { name: 'Dataset form' });
  const kinds = await form
    .getByLabel('Kind')
    .locator('option')
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== ''),
    );
  expect(kinds.length, 'the form offers kinds').toBeGreaterThan(0);
  const misses = unseen(kinds, DATASET_HELP_LIMITS);
  for (const kind of kinds) {
    const store = DATASET_STORE[kind];
    if (store === undefined) {
      misses.push(`${kind}: no store kind to make it on`);
      continue;
    }
    await form.getByLabel('Store').selectOption(stores[store]);
    await form.getByLabel('Kind').selectOption(kind);
    await expect(form.getByLabel('Kind')).toHaveValue(kind);
    misses.push(...overLimit(kind, await helpNames(form), DATASET_HELP_LIMITS));
  }
  expect(misses).toEqual([]);
  await expectQuiet(page, problems);
});
