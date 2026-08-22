import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';

/**
 * #996 M12 slice 2 (#1221) — authoring a `lookup` node on the canvas.
 *
 * The slice that makes a SOURCE-ONLY binding reachable from the UI at all. M12
 * slice 1 (#1220) made the shape legal in `NodeSchema`, and recorded that
 * nothing could yet AUTHOR it: no catalog entry declared
 * `datasetKinds.sink === undefined`, and `canvasStore.setNodeBindingEnd`
 * committed a dataset binding only as a WHOLE pair. This spec is that note being
 * discharged.
 *
 * What no unit test can reach, and this spec is here for:
 *
 *  - the pickers are fed by LIVE server rows, so the connections and datasets an
 *    operator sees are real records;
 *  - the doc has to survive the client-side `PipelineVersionWriteSchema.parse`
 *    that `api/pipelines.ts` runs on every POST — the parse that would reject a
 *    malformed binding as a raw ZodError rather than a badge;
 *  - and the round trip proves a source-only `datasetIds` reached an IMMUTABLE
 *    version with NO sink key, rather than a present-`undefined` that a unit
 *    test's `toEqual` cannot see.
 */

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Properties' });
}

async function seedConnection(page: Page, name: string, path: string): Promise<string> {
  const res = await page.request.post('/api/connections', {
    data: { name, kind: 'sqlite', config: { path, writable: true } },
  });
  expect(res.status(), `creating connection '${name}': ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function seedDataset(
  page: Page,
  name: string,
  connectionId: string,
  table: string,
): Promise<string> {
  const res = await page.request.post('/api/datasets', {
    data: {
      name,
      kind: 'table',
      connectionId,
      config: { table },
      columns: [{ name: 'id', type: 'integer', nullable: false }],
    },
  });
  expect(res.status(), `creating dataset '${name}': ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test.describe('#1221 — lookup-node authoring', () => {
  test('a lookup binds a SOURCE alone and survives a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);

    // TWO stores, one dataset each. The second exists only so the source-dataset
    // list has something it must EXCLUDE — without it the narrowing assertion
    // below would pass on a list that was never narrowed at all.
    const connA = await seedConnection(page, 'e2e 1221 store A', 'e2e-1221-a.db');
    const connB = await seedConnection(page, 'e2e 1221 store B', 'e2e-1221-b.db');
    const setA = await seedDataset(page, 'e2e 1221 people', connA, 'people');
    const setB = await seedDataset(page, 'e2e 1221 elsewhere', connB, 'elsewhere');

    const pipelineId = await openSeededCanvas(page, 'e2e 1221 lookup', { nodes: [] });

    // The palette offers it — the catalog entry landing is half the ticket.
    await addActivity(page, 'Lookup Rows');
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();

    // A lookup declares no `sinkConnectionKinds`, so it is NOT a paired
    // activity: it renders the SINGULAR connection picker, and neither of the
    // paired ones. `exact` is load-bearing — Playwright matches an accessible
    // name by SUBSTRING, so a loose 'Connection' would also match
    // 'Source connection' and this assertion could not fail.
    await expect(
      panel(page).getByRole('combobox', { name: 'Connection', exact: true }),
    ).toBeVisible();
    for (const absent of ['Source connection', 'Sink connection', 'Sink dataset']) {
      await expect(panel(page).getByRole('combobox', { name: absent })).toHaveCount(0);
    }
    await expect(panel(page).getByRole('combobox', { name: 'Source dataset' })).toBeVisible();

    // A lookup node has no settings of its own — everything that shapes the read
    // belongs to the dataset — so the form derives to nothing rather than
    // degrading to a raw JSON textarea.
    await expect(panel(page)).toContainText('This activity has no settings.');

    // Before a connection is picked, both stores' datasets are on offer. Asserted
    // by IDENTITY rather than by a total count: the e2e workspace is shared
    // across specs, so the unnarrowed list also carries whatever they seeded and
    // a fixed number would be a flake waiting on test-ordering.
    const sourceDataset = panel(page).getByRole('combobox', { name: 'Source dataset' });
    await expect(sourceDataset.locator(`option[value="${setB}"]`)).toHaveCount(1);
    await expect(sourceDataset.locator(`option[value="${setA}"]`)).toHaveCount(1);

    // THE NARROWING FIX. On an unpaired node the bound connection is the
    // SINGULAR `connectionId`, and the source-dataset list used to read only
    // `connectionIds.source` — permanently `undefined` here — so the connection
    // axis silently degraded to kind-only and offered datasets on stores this
    // node is not bound to, which dispatch then refuses with
    // `DATASET_CONNECTION_MISMATCH`.
    await panel(page)
      .getByRole('combobox', { name: 'Connection', exact: true })
      .selectOption(connA);
    // Store B's dataset is GONE, store A's remains — and now the total IS
    // deterministic, because narrowing to this connection excludes every other
    // spec's datasets too: "— none —" plus store A's one.
    await expect(sourceDataset.locator(`option[value="${setB}"]`)).toHaveCount(0);
    await expect(sourceDataset.locator(`option[value="${setA}"]`)).toHaveCount(1);
    await expect(sourceDataset.locator('option')).toHaveCount(2);

    await sourceDataset.selectOption(setA);

    // No half-bound advisory: a source-only binding is COMPLETE for this
    // activity, so nothing is pending and the panel must not claim otherwise.
    await expect(panel(page).getByRole('status')).toHaveCount(0);

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // The round trip. A reload re-fetches the LATEST version from the server, so
    // what renders is what was PERSISTED, not what the store still held.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();
    await expect(
      panel(page).getByRole('combobox', { name: 'Connection', exact: true }),
    ).toHaveValue(connA);
    await expect(panel(page).getByRole('combobox', { name: 'Source dataset' })).toHaveValue(setA);

    // Read from the PERSISTED version: a picker showing the right value proves
    // the store round-tripped it, not that the server stored it.
    const res = await page.request.get(`/api/pipelines/${pipelineId}/versions`);
    const versions = (await res.json()) as {
      version: number;
      catalogVersion: number;
      nodes: { type: string; connectionId?: string; datasetIds?: Record<string, unknown> }[];
    }[];
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    const stored = latest.nodes.find((n) => n.type === 'lookup');
    expect(stored?.connectionId).toBe(connA);
    expect(stored?.datasetIds).toEqual({ source: setA });
    // ABSENT, not present-`undefined` and not `null`. #1220 made those three
    // distinct facts one layer down, and `toEqual` above cannot tell the first
    // two apart — this is the assertion that can.
    expect('sink' in (stored?.datasetIds ?? {})).toBe(false);
    // The bump this entry owes, stamped on the row the server minted. A LITERAL
    // on purpose: it is the tripwire that makes a catalog widening show up here
    // and not only in the shared package's own tests.
    expect(latest.catalogVersion).toBe(29); // #1221 M12 — the `lookup` activity

    await expectQuiet(page, problems);
  });
});
