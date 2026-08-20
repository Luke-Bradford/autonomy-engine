import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';

/**
 * #996 M5 slice 4c (#1139) — authoring a `copy` node on the canvas.
 *
 * The slice that makes the whole data-movement chain reachable. `copy` runs end
 * to end as of #1134, and until this ticket the executor refused the type before
 * dispatch (`UNKNOWN_ACTIVITY`) because no catalog entry existed — so a pipeline
 * could move data only if somebody minted the version through the API.
 *
 * What no unit test can reach, and this spec is here for:
 *
 *  - the pickers are fed by LIVE server rows, so the connections and datasets an
 *    operator sees are real records rather than a fixture's;
 *  - the doc has to survive the client-side `PipelineVersionWriteSchema.parse`
 *    that `api/pipelines.ts` runs on every POST — the parse that makes a
 *    half-bound pair on a node a raw ZodError rather than a badge, and the whole
 *    reason the half-picked end is held outside the doc;
 *  - and the round trip through Save proves both pairs reached an IMMUTABLE
 *    version: `toVersionBody` carrying them, the write gate accepting them, and
 *    the reload resolving all four ids back into the same four pickers.
 */

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Properties' });
}

/** A `sqlite` store connection, minted through the real route. */
async function seedConnection(page: Page, name: string, path: string): Promise<string> {
  const res = await page.request.post('/api/connections', {
    data: { name, kind: 'sqlite', config: { path, writable: true } },
  });
  expect(res.status(), `creating connection '${name}': ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * A `table` dataset on that store. `columns` is REQUIRED and has no default —
 * deliberately, per the dataset schema: an empty column list is a fact about the
 * table, never a stand-in for "not described yet".
 */
async function seedDataset(page: Page, name: string, connectionId: string, table: string) {
  const res = await page.request.post('/api/datasets', {
    data: {
      name,
      kind: 'table',
      connectionId,
      config: { table },
      columns: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'label', type: 'string', nullable: true },
      ],
    },
  });
  expect(res.status(), `creating dataset '${name}': ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test.describe('#1139 — copy-node authoring', () => {
  test('a copy node is bound on all four ends and SURVIVES a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);

    const srcConn = await seedConnection(page, 'e2e 1139 source store', 'e2e-1139-src.db');
    const sinkConn = await seedConnection(page, 'e2e 1139 sink store', 'e2e-1139-sink.db');
    const srcSet = await seedDataset(page, 'e2e 1139 people', srcConn, 'people');
    const sinkSet = await seedDataset(page, 'e2e 1139 people copy', sinkConn, 'people_copy');

    const pipelineId = await openSeededCanvas(page, 'e2e 1139 copy', { nodes: [] });

    // The palette offers it — the catalog entry landing is the whole ticket.
    await addActivity(page, 'Copy Data');
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();

    // FOUR pickers, and NOT the singular one: `validateDoc` refuses
    // `connectionId` and `connectionIds` on the same node. `exact` is
    // load-bearing — Playwright matches an accessible name by SUBSTRING by
    // default, so a loose 'Connection' matches the two paired pickers and this
    // assertion would fail against a correct panel.
    await expect(
      panel(page).getByRole('combobox', { name: 'Connection', exact: true }),
    ).toHaveCount(0);
    for (const label of ['Source connection', 'Sink connection', 'Source dataset']) {
      await expect(panel(page).getByRole('combobox', { name: label })).toBeVisible();
    }

    // Picking ONE end leaves the doc without the pair, and the panel says so
    // rather than letting the pick look saved.
    await panel(page).getByRole('combobox', { name: 'Source connection' }).selectOption(srcConn);
    await expect(panel(page).getByRole('status')).toContainText('not saved');

    await panel(page).getByRole('combobox', { name: 'Sink connection' }).selectOption(sinkConn);

    // The dataset lists are narrowed by the connection bound to the SAME end —
    // a disagreeing pair is refused at dispatch, so offering one is offering a
    // binding that cannot run.
    await expect(
      panel(page).getByRole('combobox', { name: 'Source dataset' }).locator('option'),
    ).toHaveCount(2); // "— none —" plus the one dataset on the source store

    await panel(page).getByRole('combobox', { name: 'Source dataset' }).selectOption(srcSet);
    await panel(page).getByRole('combobox', { name: 'Sink dataset' }).selectOption(sinkSet);
    await expect(panel(page).getByRole('status')).toHaveCount(0);

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // The round trip. A reload re-fetches the LATEST version from the server, so
    // what renders is what was PERSISTED, not what the store still held.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();

    await expect(panel(page).getByRole('combobox', { name: 'Source connection' })).toHaveValue(
      srcConn,
    );
    await expect(panel(page).getByRole('combobox', { name: 'Sink connection' })).toHaveValue(
      sinkConn,
    );
    await expect(panel(page).getByRole('combobox', { name: 'Source dataset' })).toHaveValue(srcSet);
    await expect(panel(page).getByRole('combobox', { name: 'Sink dataset' })).toHaveValue(sinkSet);

    // Read from the persisted version, because a picker showing the right value
    // proves the store round-tripped it, not that the SERVER stored it — and
    // these two fields are exactly the ones an unremapped-ref bug loses silently.
    const res = await page.request.get(`/api/pipelines/${pipelineId}/versions`);
    const versions = (await res.json()) as {
      version: number;
      catalogVersion: number;
      nodes: {
        type: string;
        connectionIds?: { source: string; sink: string };
        datasetIds?: { source: string; sink: string };
      }[];
    }[];
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    const stored = latest.nodes.find((n) => n.type === 'copy');
    expect(stored?.connectionIds).toEqual({ source: srcConn, sink: sinkConn });
    expect(stored?.datasetIds).toEqual({ source: srcSet, sink: sinkSet });
    // The bump this entry owes, stamped on the row the server minted. A LITERAL
    // on purpose, and the maintenance it costs is the point: it is the tripwire
    // that made #1167's 23 -> 24 bump show up here rather than only in the
    // shared package's own tests. Importing `CATALOG_VERSION` would make this
    // assert that two copies of one constant agree, which is not the claim.
    expect(latest.catalogVersion).toBe(24);

    await expectQuiet(page, problems);
  });

  /**
   * #1169 (M8 slice 1) — the column mapping is authored in a ROW CONTROL.
   *
   * Until this ticket `mapping` was an array of objects, which
   * `deriveConfigFields` had no control for, so it degraded to a raw JSON
   * textarea: to map two columns an operator had to know the shape of
   * `CopyMappingSchema` by heart and type it as valid JSON. That is the blank
   * box the data-movement spec's §13 exists to remove, and the reason it lists
   * a mapping panel as its own M-series row.
   *
   * A unit test can prove the derived rules; only this can prove the mapping an
   * operator TYPED reaches an immutable version and comes back.
   */
  test('a column mapping typed into the row control reaches the saved version', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);

    const srcConn = await seedConnection(page, 'e2e 1169 source store', 'e2e-1169-src.db');
    const sinkConn = await seedConnection(page, 'e2e 1169 sink store', 'e2e-1169-sink.db');
    const srcSet = await seedDataset(page, 'e2e 1169 people', srcConn, 'people');
    const sinkSet = await seedDataset(page, 'e2e 1169 people copy', sinkConn, 'people_copy');

    const pipelineId = await openSeededCanvas(page, 'e2e 1169 mapping', { nodes: [] });
    await addActivity(page, 'Copy Data');
    await canvasNodes(page).first().click();

    await panel(page).getByRole('combobox', { name: 'Source connection' }).selectOption(srcConn);
    await panel(page).getByRole('combobox', { name: 'Sink connection' }).selectOption(sinkConn);
    await panel(page).getByRole('combobox', { name: 'Source dataset' }).selectOption(srcSet);
    await panel(page).getByRole('combobox', { name: 'Sink dataset' }).selectOption(sinkSet);

    // The JSON textarea this control replaces — for the field, and for the whole
    // node. Their ABSENCE is the ticket.
    await expect(panel(page).getByLabel('mapping — JSON')).toHaveCount(0);
    await expect(panel(page).getByLabel('Config (JSON)')).toHaveCount(0);

    // Two rows, each authored through named controls rather than as JSON.
    for (const [row, source, sink, type] of [
      [1, 'id', 'id', 'integer'],
      [2, 'label', 'full_name', 'string'],
    ] as const) {
      await panel(page).getByRole('button', { name: 'Add mapping row' }).click();
      await panel(page)
        .getByLabel(`mapping row ${row} source (optional)`)
        .fill(source);
      await panel(page).getByLabel(`mapping row ${row} sink`).fill(sink);
      await panel(page)
        .getByLabel(`mapping row ${row} type`)
        .selectOption(type);
    }

    // Row 2 takes an explicit `onError`; row 1 is left alone. A defaulted enum
    // cell that nobody touched must OMIT its key rather than write the default
    // in — the same rule every optional control in this form follows, and the
    // difference between "the author chose 'fail'" and "the author said
    // nothing", which is a distinction §6.2 can still act on later.
    await panel(page).getByLabel('mapping row 2 onError (optional)').selectOption('null');

    await panel(page).getByRole('button', { name: 'Apply config' }).click();
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // The round trip, read from the PERSISTED version — a control showing the
    // right value proves the store round-tripped it, not that the server has it.
    const res = await page.request.get(`/api/pipelines/${pipelineId}/versions`);
    const versions = (await res.json()) as {
      version: number;
      nodes: { type: string; config?: { mapping?: unknown } }[];
    }[];
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    expect(latest.nodes.find((n) => n.type === 'copy')?.config?.mapping).toEqual([
      { source: 'id', sink: 'id', type: 'integer' },
      { source: 'label', sink: 'full_name', type: 'string', onError: 'null' },
    ]);

    // And it comes BACK into the same controls, one row per stored mapping.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await canvasNodes(page).first().click();
    await expect(panel(page).getByLabel('mapping row 2 sink')).toHaveValue('full_name');
    await expect(panel(page).getByLabel('mapping row 2 type')).toHaveValue('string');

    await expectQuiet(page, problems);
  });
});
