import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { seedVersion } from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #996 M9 (#1185, data-movement spec §2.1) — the dataset detail page answers
 * "what will editing this break", which nothing could answer before it.
 *
 * §2.1's consequence 2 is that "editing a dataset can invalidate a pinned
 * mapping", because the node holds a REF and the dataset row is MUTABLE while
 * the mapping is immutable inside its pipeline version. Its second compensating
 * control is this page. So the spec walks the INVALIDATION, not a pre-broken
 * fixture: mint a version whose mapping agrees, then edit the dataset out from
 * under it and read the flag. A mapping seeded already-wrong would prove the
 * renderer works and nothing about the story the page exists for.
 *
 * EGRESS-FREE and no run fires — M9 is a read surface, so nothing here needs a
 * real store on disk. The connection's `config` is not validated per kind on
 * the create route (it is refused at DISPATCH), which is what lets a spec that
 * only authors get away with a nominal path.
 */

test('#1185 — editing a dataset shows which pinned mappings no longer agree', async ({ page }) => {
  const problems = collectPageProblems(page);
  const stamp = Date.now();

  const store = await seedConnection(page, {
    name: `e2e-m9-store-${stamp}`,
    kind: 'sqlite',
    config: { path: `m9-${stamp}.db` },
  });
  const sourceDataset = await seedDataset(page, {
    name: `e2e-m9-source-${stamp}`,
    kind: 'table',
    connectionId: store,
    config: { table: 'people' },
    columns: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'email', type: 'string', nullable: true },
    ],
  });
  const sinkDataset = await seedDataset(page, {
    name: `e2e-m9-sink-${stamp}`,
    kind: 'table',
    connectionId: store,
    config: { table: 'people_copy' },
    columns: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'email', type: 'string', nullable: true },
    ],
  });

  // A mapping that AGREES with both datasets as they stand right now.
  await seedVersion(page, `e2e-m9-pipeline-${stamp}`, {
    nodes: [
      {
        id: 'copy1',
        type: 'copy',
        position: { x: 0, y: 0 },
        connectionIds: { source: store, sink: store },
        datasetIds: { source: sourceDataset, sink: sinkDataset },
        config: {
          mapping: [
            { source: 'id', sink: 'id', type: 'integer' },
            { source: 'email', sink: 'email', type: 'string' },
          ],
          mode: 'append',
        },
      },
    ],
  });

  // Reached by DRILLING IN from the list, not by typing the URL — the link in
  // the name cell is the only way an operator finds this page.
  await page.goto('/#/manage/datasets');
  await page.getByRole('heading', { name: 'Datasets' }).waitFor();
  await fluentRootReady(page);
  await page.getByRole('link', { name: `e2e-m9-source-${stamp}` }).click();

  await expect(page.getByRole('heading', { name: `e2e-m9-source-${stamp}` })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Datasets');

  const row = page.getByRole('row', { name: new RegExp(`e2e-m9-pipeline-${stamp}`) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('source');
  await expect(row).toContainText('latest version');
  await expect(row).toContainText('agrees');
  await expect(row).not.toContainText('no longer agrees');

  // THE EDIT §2.1 is about: the source column is renamed, and the version that
  // reads it is immutable — so the mapping cannot follow.
  const patched = await page.request.patch(`/api/datasets/${sourceDataset}`, {
    data: {
      columns: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'email_address', type: 'string', nullable: true },
      ],
    },
  });
  expect(patched.status(), await patched.text()).toBe(200);

  await page.reload();
  const flagged = page.getByRole('row', { name: new RegExp(`e2e-m9-pipeline-${stamp}`) });
  await expect(flagged).toContainText('no longer agrees');
  // Names the COLUMN, not just the fact — the page is useless if the operator
  // has to open the canvas to find out which one moved.
  await expect(flagged).toContainText('reads “email”, which this dataset no longer declares');
  // And the additive half stays informational: `email_address` is unread, which
  // §7 row 4 makes a warning rather than a fault.
  await expect(flagged).toContainText('does not read “email_address”');

  // The SINK dataset is untouched, so its own page still agrees — proving the
  // verdict is per-reference and per-end, not a page-wide banner.
  await page.goto('/#/manage/datasets');
  await page.getByRole('link', { name: `e2e-m9-sink-${stamp}` }).click();
  const sinkRow = page.getByRole('row', { name: new RegExp(`e2e-m9-pipeline-${stamp}`) });
  await expect(sinkRow).toContainText('sink');
  await expect(sinkRow).toContainText('agrees');
  await expect(sinkRow).not.toContainText('no longer agrees');

  await expectQuiet(page, problems);
});
