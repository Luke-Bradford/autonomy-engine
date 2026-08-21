import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { seedConnection, seedDataset } from './support/seedResources';
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

  test('creates a postgres connection, typed, with its TLS mode a real choice', async ({
    page,
  }) => {
    // #1189 (M10 slice 1). What only the browser can prove: the `postgres`
    // schema that reached the SHIPPED bundle derives real controls — in
    // particular that `sslmode` is a SELECT of the three modes and not a free
    // text box, and that a required enum did not degrade the whole form to the
    // JSON textarea. The security decision is only as good as the control that
    // carries it: a typo in a text field would be a config the server refuses,
    // and an operator who cannot see the choices cannot make the choice.
    const problems = collectPageProblems(page);
    await gotoConnections(page);

    const name = `e2e m10 postgres ${Date.now()}`;
    await page.getByRole('button', { name: 'New connection' }).click();
    await form(page).getByLabel('Name').fill(name);
    await form(page).getByLabel('Kind').selectOption('postgres');

    // A postgres connection cannot dispatch without a password, and the form
    // must say so — this is the visible face of joining
    // `SECRET_REQUIRING_CONNECTION_KINDS`.
    await expect(form(page).getByText(/cannot dispatch without a secret/)).toBeVisible();

    const sslmode = form(page).getByLabel('sslmode');
    await expect(sslmode).toHaveRole('combobox');
    await expect(sslmode.locator('option')).toHaveText([
      // The empty choice is the form's own placeholder, and it MATTERS here:
      // `sslmode` is required with no default, so a new postgres connection
      // starts on "— none —" and the operator has to pick. The schema refuses
      // the empty one, which is the whole point of having no safe default.
      '— none —',
      'disable',
      'require',
      'verify-full',
    ]);

    await form(page).getByLabel('host').fill('db.example.test');
    await form(page).getByLabel('database').fill('app');
    await form(page).getByLabel('user').fill('app_ro');
    await sslmode.selectOption('verify-full');
    await form(page).getByLabel('port (optional)').fill('6543');
    await form(page).getByRole('button', { name: 'Create connection' }).click();

    await expect(page.getByRole('button', { name: `Export ${name}`, exact: true })).toBeVisible();

    const stored = await page.evaluate(async (wanted: string) => {
      type Row = {
        name: string;
        kind: string;
        config: Record<string, unknown>;
        secretStatus: string;
      };
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
    expect(stored!.kind).toBe('postgres');
    // `port` is a NUMBER, not the string the input held.
    expect(stored!.config).toEqual({
      host: 'db.example.test',
      database: 'app',
      user: 'app_ro',
      sslmode: 'verify-full',
      port: 6543,
    });
    // The readiness half, end to end: no secret was bound, so the server
    // DERIVED `needs_secret` — the state the dispatch gate refuses on. Before
    // the kind joined the secret-requiring set this read `not_required`.
    expect(stored!.secretStatus).toBe('needs_secret');

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

/**
 * #1191 — "Test connection". What only a real browser + a real server can prove
 * here: the button reaches an endpoint that reaches a REAL adapter, and the
 * verdict on screen is the adapter's own. Every unit test on either side mocks
 * the other, so the seam this ticket opened — eight `testConnection`
 * implementations that had no caller at all — is exactly the part only an
 * end-to-end pass covers.
 */
test.describe('#1191 test connection', () => {
  test('reports a real fs probe, and a real refusal, without saving anything', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoConnections(page);

    const name = `e2e 1191 fs ${Date.now()}`;
    await page.getByRole('button', { name: 'New connection' }).click();
    await form(page).getByLabel('Name').fill(name);
    await form(page).getByLabel('Kind').selectOption('fs');

    // A root that DOES exist on any machine this suite runs on. The adapter
    // stats it for real — this is a liveness answer, not a schema check.
    await form(page)
      .getByLabel(/^roots/)
      .fill('/tmp');
    await form(page).getByRole('button', { name: 'Test connection' }).click();
    await expect(form(page).getByRole('status')).toHaveText('Connected.');

    // Now a root that does not. Same button, same adapter, and the sentence is
    // the one `fs.testConnection` authors — nothing in the browser invented it.
    await form(page)
      .getByLabel(/^roots/)
      .fill('/tmp/e2e-1191-definitely-not-here');
    // The previous verdict must be GONE the moment the draft changes under it:
    // a green result about a path since edited is a lie with a timestamp.
    await expect(form(page).getByRole('status')).toHaveCount(0);

    await form(page).getByRole('button', { name: 'Test connection' }).click();
    await expect(form(page).getByRole('status')).toContainText(/not accessible/);

    // Testing is not saving. The row must not exist — the whole point of
    // probing a DRAFT is finding out before committing one.
    const stored = await page.evaluate(async (wanted: string) => {
      type Row = { name: string };
      let cursor: string | null = null;
      for (;;) {
        const url: string =
          cursor === null
            ? '/api/connections'
            : `/api/connections?cursor=${encodeURIComponent(cursor)}`;
        const res: { items: Row[]; nextCursor: string | null } = await (await fetch(url)).json();
        if (res.items.some((r) => r.name === wanted)) return true;
        if (res.nextCursor === null) return false;
        cursor = res.nextCursor;
      }
    }, name);
    expect(stored).toBe(false);

    await expectQuiet(page, problems);
  });

  test('does not claim a connection works when the adapter reached nothing', async ({ page }) => {
    // `agent_cli` deliberately never spawns during a probe, so its `ok: true`
    // means "these settings parse". Before #1191's `probed` field there was no
    // way for the form to tell that apart from a live connection, and it would
    // have rendered a green "Connected." for a command that does not exist.
    const problems = collectPageProblems(page);
    await gotoConnections(page);

    await page.getByRole('button', { name: 'New connection' }).click();
    await form(page).getByLabel('Name').fill(`e2e 1191 agent ${Date.now()}`);
    await form(page).getByLabel('Kind').selectOption('agent_cli');
    await form(page)
      .getByLabel(/^command/)
      .fill('definitely-not-a-real-binary');

    await form(page).getByRole('button', { name: 'Test connection' }).click();
    const status = form(page).getByRole('status');
    await expect(status).toContainText(/not contacted until it runs/);
    await expect(status).not.toContainText('Connected.');

    await expectQuiet(page, problems);
  });
});

test.describe('#1174 an edit says what it would strand', () => {
  /**
   * The defect this closes is the OTHER END of #1158's. A connection's `kind` is
   * mutable and its row is deletable, and nothing re-checks the datasets that
   * named it — #1158 made that visible on the datasets LIST, which the operator
   * only reads if they already suspected. The point at which they can still
   * reconsider is the edit itself.
   *
   * What only a real browser + a real server prove here, over the jsdom suite:
   * that the page really does reach `GET /api/datasets` in the SHIPPED bundle
   * and that the rule renders against rows the real routes stored — the jsdom
   * tests mock that module out entirely, so a wrong path or a mis-bundled
   * `DATASET_CONNECTION_KINDS` would pass there and fail here.
   *
   * NAMING: every connection this suite mints becomes an OPTION in the DATASETS
   * form's Store `<select>`, and `getByLabel` is a case-insensitive SUBSTRING
   * match over the whole wrapping label including its options. A name containing
   * another control's label ('Kind', 'Name', 'Columns') breaks
   * `datasets-page.spec.ts` from over here, in a shared single-worker database.
   * `e2e-1174-*` is clear of all of them — see that file's own note.
   */
  async function seedStoreWithDataset(page: Page, suffix: string) {
    const connectionId = await seedConnection(page, {
      name: `e2e-1174-strand-${suffix}`,
      kind: 'sqlite',
      config: { file: `/tmp/e2e-1174-${suffix}.db` },
    });
    await seedDataset(page, {
      name: `e2e-1174-orders-${suffix}`,
      kind: 'table',
      connectionId,
      config: { table: 'orders' },
      columns: [{ name: 'id', type: 'integer', nullable: false }],
    });
    return connectionId;
  }

  /** Playwright DISMISSES an unhandled dialog, so a confirm must be caught to be read. */
  async function captureConfirm(
    page: Page,
    act: () => Promise<void>,
    response: 'accept' | 'dismiss' = 'dismiss',
  ): Promise<string | null> {
    let seen: string | null = null;
    const handler = async (dialog: {
      message: () => string;
      accept: () => Promise<void>;
      dismiss: () => Promise<void>;
    }) => {
      seen = dialog.message();
      await (response === 'accept' ? dialog.accept() : dialog.dismiss());
    };
    page.on('dialog', handler);
    try {
      await act();
    } finally {
      page.off('dialog', handler);
    }
    return seen;
  }

  test('names the datasets a kind change would strand, before the PATCH is sent', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await seedStoreWithDataset(page, 'edit');
    await gotoConnections(page);

    const row = page.getByRole('row', { name: /e2e-1174-strand-edit/ });
    await row.getByRole('button', { name: 'Edit' }).click();
    // Nothing to say yet — the stored kind has not moved.
    await expect(form(page).getByText(/strands/)).toHaveCount(0);

    await form(page).getByLabel('Kind').selectOption('http');

    const note = form(page).getByText(/strands 1 dataset that reads it/);
    await expect(note).toBeVisible();
    await expect(note).toContainText('e2e-1174-orders-edit');

    // ADVISORY, NEVER A GATE — the polarity #1145/#1158 set and this ticket
    // inherits. The save is still offered, and nothing has been sent: the row
    // still reads `sqlite` behind the open form.
    await expect(form(page).getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await expect(row.getByText('sqlite')).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('names them again in the delete confirmation, and lets the operator decline', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await seedStoreWithDataset(page, 'delete');
    await gotoConnections(page);

    const row = page.getByRole('row', { name: /e2e-1174-strand-delete/ });
    const said = await captureConfirm(page, async () => {
      await row.getByRole('button', { name: /^Delete / }).click();
    });

    expect(said).toContain('1 dataset reads it');
    expect(said).toContain('e2e-1174-orders-delete');
    // Declined, so the connection is still there — which is what makes the
    // sentence a decision the operator got to make rather than a notice.
    await expect(row).toBeVisible();

    await expectQuiet(page, problems);
  });
});
