import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * U13b (#1087) — the per-kind connection config form.
 *
 * What only a real browser + a real server can prove here: that the controls
 * the form derives from each kind's schema are REAL inputs in the shipped
 * bundle, and — the part no unit test reaches, because they all mock the API —
 * that filling them writes exactly those keys through `POST /api/connections`
 * and reads them back. The unit suite proves the state machine; this proves the
 * schemas the browser actually loads are the ones the server actually parses,
 * which is precisely what a stale or mis-bundled shared package would break.
 *
 * Every spec names its own connection with a per-test suffix: the suite runs
 * single-worker against one shared SQLite file and rows from earlier specs
 * persist, so anything counting rows would be counting other tests' work.
 */

async function gotoConnections(page: Page): Promise<void> {
  await page.goto('/#/manage/connections');
  await page.getByRole('heading', { name: 'Connections' }).waitFor();
  await fluentRootReady(page);
}

function form(page: Page) {
  return page.getByRole('form', { name: 'Connection form' });
}

test.describe('U13b per-kind connection config', () => {
  test('creates an fs connection through the kind’s own fields', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoConnections(page);

    const name = `e2e u13b fs ${Date.now()}`;
    await page.getByRole('button', { name: 'New connection' }).click();
    await form(page).getByLabel('Name').fill(name);
    await form(page).getByLabel('Kind').selectOption('fs');

    // These controls exist ONLY because the form read `fs`'s own schema. Before
    // #1087 the whole config was one textarea and an operator had to know the
    // key names by heart.
    await form(page)
      .getByLabel(/^roots/)
      .fill('/tmp/e2e-u13b');
    await form(page).getByLabel('maxBytes (optional)').fill('2048');
    await form(page).getByRole('button', { name: 'Create connection' }).click();

    await expect(page.getByRole('button', { name: `Export ${name}`, exact: true })).toBeVisible();

    // Read the row back from the SERVER, not from the DOM: the point is that
    // the typed fields became those exact config keys, with those types.
    // `GET /api/connections` is PAGED (#542-line work), so this walks the pages
    // rather than assuming one holds everything — the row it wants is the
    // newest, but a page-size assumption is exactly the kind of thing that
    // passes until a fixture grows.
    const stored = await page.evaluate(async (wanted: string) => {
      type Row = { name: string; kind: string; config: Record<string, unknown> };
      let cursor: string | null = null;
      for (;;) {
        const url: string =
          cursor === null
            ? '/api/connections'
            : `/api/connections?cursor=${encodeURIComponent(cursor)}`;
        const page: { items: Row[]; nextCursor: string | null } = await (await fetch(url)).json();
        const hit = page.items.find((r) => r.name === wanted);
        if (hit !== undefined) return hit;
        if (page.nextCursor === null) return null;
        cursor = page.nextCursor;
      }
    }, name);

    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('fs');
    // `roots` is a list of strings and `maxBytes` a NUMBER — the one-per-line
    // and numeric controls, not two strings.
    expect(stored!.config).toEqual({ roots: ['/tmp/e2e-u13b'], maxBytes: 2048 });

    await expectQuiet(page, problems);
  });

  test('swaps the fields when the kind changes, and says what the secret is for', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await gotoConnections(page);

    await page.getByRole('button', { name: 'New connection' }).click();
    // anthropic_api is the first kind: its own header field is present, and the
    // secret note says it cannot dispatch without one.
    await expect(form(page).getByLabel('anthropicVersion (optional)')).toBeVisible();
    await expect(form(page).getByText(/cannot dispatch without a secret/)).toBeVisible();

    await form(page).getByLabel('Kind').selectOption('agent_cli');
    await expect(form(page).getByLabel('command')).toBeVisible();
    await expect(form(page).getByLabel('anthropicVersion (optional)')).toBeHidden();
    // An agent_cli DOES use a secret without requiring one — "optional" alone
    // would not say where it goes.
    await expect(form(page).getByText(/environment variable named by/)).toBeVisible();

    // The JSON escape hatch is still reachable, and opens on the same config.
    await form(page).getByLabel('command').fill('claude');
    await form(page).getByRole('button', { name: 'Edit as JSON' }).click();
    await expect(form(page).getByLabel('Config (JSON)')).toHaveValue(
      JSON.stringify({ command: 'claude' }, null, 2),
    );

    await expectQuiet(page, problems);
  });
});
