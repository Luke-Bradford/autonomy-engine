import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { properties, pickConnection } from './support/panels';
import { seedConnection, seedDataset } from './support/seedResources';

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

async function seedStore(page: Page, name: string, path: string): Promise<string> {
  return seedConnection(page, { name, kind: 'sqlite', config: { path, writable: true } });
}

async function seedTable(
  page: Page,
  name: string,
  connectionId: string,
  table: string,
): Promise<string> {
  return seedDataset(page, {
    name,
    kind: 'table',
    connectionId,
    config: { table },
    columns: [{ name: 'id', type: 'integer', nullable: false }],
  });
}

test.describe('#1221 — lookup-node authoring', () => {
  test('a lookup binds a SOURCE alone and survives a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);

    // TWO stores, one dataset each. The second exists only so the source-dataset
    // list has something it must EXCLUDE — without it the narrowing assertion
    // below would pass on a list that was never narrowed at all.
    const connA = await seedStore(page, 'e2e 1221 store A', 'e2e-1221-a.db');
    const connB = await seedStore(page, 'e2e 1221 store B', 'e2e-1221-b.db');
    const setA = await seedTable(page, 'e2e 1221 people', connA, 'people');
    const setB = await seedTable(page, 'e2e 1221 elsewhere', connB, 'elsewhere');

    const pipelineId = await openSeededCanvas(page, 'e2e 1221 lookup', { nodes: [] });

    // The palette offers it — the catalog entry landing is half the ticket.
    await addActivity(page, 'Lookup');
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();

    // A lookup declares no `sinkConnectionKinds`, so it is NOT a paired
    // activity: it renders the SINGULAR connection picker, and neither of the
    // paired ones. `exact` is load-bearing — Playwright matches an accessible
    // name by SUBSTRING, so a loose 'Connection' would also match
    // 'Source connection' and this assertion could not fail.
    await expect(
      properties(page).getByRole('combobox', { name: 'Connection', exact: true }),
    ).toBeVisible();
    for (const absent of ['Source connection', 'Sink connection', 'Sink dataset']) {
      await expect(properties(page).getByRole('combobox', { name: absent })).toHaveCount(0);
    }
    await expect(properties(page).getByRole('combobox', { name: 'Source dataset' })).toBeVisible();

    // Everything that shapes the read belongs to the dataset, so the Source tab
    // (#1477) holds the bindings and no config form, rather than a raw JSON
    // textarea. Its own Settings (#1600 C7a) are a tab of their own, after it.
    const tabStrip = properties(page).getByRole('tablist', { name: 'Activity properties' });
    await expect(tabStrip.getByRole('tab')).toHaveCount(3);
    for (const name of ['General', 'Source', 'Settings']) {
      await expect(tabStrip.getByRole('tab', { name, exact: true })).toHaveCount(1);
    }
    await expect(properties(page).getByRole('tab', { name: 'Source' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(properties(page).getByRole('group', { name: 'Config' })).toHaveCount(0);
    await expect(properties(page).getByLabel('Config (JSON)')).toHaveCount(0);

    // Before a connection is picked, both stores' datasets are on offer. Asserted
    // by IDENTITY rather than by a total count: the e2e workspace is shared
    // across specs, so the unnarrowed list also carries whatever they seeded and
    // a fixed number would be a flake waiting on test-ordering.
    const sourceDataset = properties(page).getByRole('combobox', { name: 'Source dataset' });
    await expect(sourceDataset.locator(`option[value="${setB}"]`)).toHaveCount(1);
    await expect(sourceDataset.locator(`option[value="${setA}"]`)).toHaveCount(1);

    // THE NARROWING FIX. On an unpaired node the bound connection is the
    // SINGULAR `connectionId`, and the source-dataset list used to read only
    // `connectionIds.source` — permanently `undefined` here — so the connection
    // axis silently degraded to kind-only and offered datasets on stores this
    // node is not bound to, which dispatch then refuses with
    // `DATASET_CONNECTION_MISMATCH`.
    await pickConnection(page, 'Connection', { id: connA });
    // Store B's dataset is GONE, store A's remains — and now the total IS
    // deterministic, because narrowing to this connection excludes every other
    // spec's datasets too: "— none —" plus store A's one.
    await expect(sourceDataset.locator(`option[value="${setB}"]`)).toHaveCount(0);
    await expect(sourceDataset.locator(`option[value="${setA}"]`)).toHaveCount(1);
    await expect(sourceDataset.locator('option')).toHaveCount(2);

    await sourceDataset.selectOption(setA);

    // No half-bound advisory: a source-only binding is COMPLETE for this
    // activity, so nothing is pending and the panel must not claim otherwise.
    await expect(properties(page).getByRole('status')).toHaveCount(0);

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // The round trip. A reload re-fetches the LATEST version from the server, so
    // what renders is what was PERSISTED, not what the store still held.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await expect(canvasNodes(page)).toHaveCount(1);
    await canvasNodes(page).first().click();
    await expect(
      properties(page).getByRole('combobox', { name: 'Connection', exact: true }),
    ).toHaveValue('e2e 1221 store A (SQLite)');
    await expect(properties(page).getByRole('combobox', { name: 'Source dataset' })).toHaveValue(
      setA,
    );

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
    expect(latest.catalogVersion).toBe(51); // #1600 C9c — Delete's session log

    await expectQuiet(page, problems);
  });

  test('#1600 C7a — Settings: a new lookup starts First row only, and the choices save', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const pipelineId = await openSeededCanvas(page, 'e2e 1600 c7a lookup row limit', {
      nodes: [],
    });
    await addActivity(page, 'Lookup');
    await canvasNodes(page).first().click();
    await properties(page).getByRole('tab', { name: 'Settings' }).click();

    const firstRowOnly = properties(page).getByRole('checkbox', { name: 'First row only' });
    const maxRows = properties(page).getByRole('textbox', { name: 'Max rows', exact: true });
    const overLimit = properties(page).getByRole('combobox', { name: 'When over the limit' });
    // ADF's new-node default, written into the node rather than assumed.
    await expect(firstRowOnly).toBeChecked();
    await expect(maxRows).toBeVisible();
    await expect(overLimit.locator('option')).toContainText(['Truncate and warn', 'Fail']);
    // #1732 — the unset choice names the schema default rather than "— none —".
    await expect(overLimit).toHaveValue('');
    await expect(overLimit.locator('option').first()).toHaveText('Truncate and warn (default)');

    // The whole tab is on screen at 1440x900, and the number box is number-sized.
    const pane = (await properties(page).boundingBox())!;
    const last = (await overLimit.boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(Math.min(pane.y + pane.height, 900));
    expect((await maxRows.boundingBox())!.width).toBeLessThanOrEqual(140);

    await firstRowOnly.uncheck();
    await maxRows.fill('50');
    await maxRows.blur();
    await overLimit.selectOption({ label: 'Fail' });
    await properties(page).getByRole('button', { name: 'Apply config', exact: true }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    const versions = (await (
      await page.request.get(`/api/pipelines/${pipelineId}/versions`)
    ).json()) as { version: number; nodes: { type: string; config: Record<string, unknown> }[] }[];
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    const config = latest.nodes.find((n) => n.type === 'lookup')!.config;
    // Unticked is the schema's default, which the form writes as an absent key.
    expect(config['firstRowOnly'] ?? false).toBe(false);
    expect(config).toMatchObject({ maxRows: 50, overLimit: 'fail' });
    expect((config['outputs'] as { name: string }[]).map((o) => o.name)).toEqual([
      'rows',
      'rowCount',
      'count',
      'firstRow',
      'bytes',
      'truncated',
    ]);

    // And it reads back into the form after a reload.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await canvasNodes(page).first().click();
    await properties(page).getByRole('tab', { name: 'Settings' }).click();
    await expect(firstRowOnly).not.toBeChecked();
    await expect(maxRows).toHaveValue('50');
    await expect(overLimit).toHaveValue('fail');

    await expectQuiet(page, problems);
  });
});
