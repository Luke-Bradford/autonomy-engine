import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DENSITIES, THEMES, expectAppearance, preferAppearance } from './support/appearance';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { TITLED_PAGES } from './support/pages';
import { openRunView, properties } from './support/panels';
import { fireAndSettle, nodeById, openSeededCanvas, seedVersion } from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady } from './support/theme';
import { disconnectWorkspaceGit, makeBareRepo } from './support/workspaceGit';

/**
 * #1594 OR40 S5b — the accessibility gate.
 *
 * axe runs on every audited view, in both themes and both densities, and the
 * bar is ZERO violations of ANY impact: a "minor" today is a contrast or name
 * fault a screen-reader user still meets. One test per theme × density, so a
 * failure names the combination; within it every view is checked before the
 * one assertion, so a failure lists every view and rule at once rather than
 * stopping at the first.
 *
 * The views are the ticket's list: every titled page (Home, Pipelines, Runs,
 * each Manage list, Settings, ...), the editor with Copy selected, with ForEach
 * selected and with pipeline properties, the run page with its drawer closed
 * and open, plus OR29's three: Expand properties, a connection picker's list
 * open, and the New connection kind gallery. The workspace is seeded first, so
 * the lists are scanned with rows in them, not as empty states.
 */

/** One violation on one element, as the failure message prints it. */
interface Finding {
  view: string;
  rule: string;
  impact: string;
  target: string;
}

/**
 * Waits for every finite animation and transition to finish, so a dialog or
 * list is scanned at rest and not mid-fade (where contrast is a moving target).
 */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
}

/**
 * Scans the page as it stands. No violation is let through: there is no
 * allowlist, and never `.exclude()` or `disableRules()`, which would hide every
 * other rule on those elements too.
 */
async function scan(page: Page, view: string, findings: Finding[]): Promise<void> {
  await settled(page);
  const result = await new AxeBuilder({ page }).analyze();
  // A scan that checked nothing would pass vacuously; there is always a page.
  expect(result.passes.length, `axe checked nothing on ${view}`).toBeGreaterThan(0);
  for (const v of result.violations) {
    for (const node of v.nodes) {
      findings.push({
        view,
        rule: v.id,
        impact: v.impact ?? 'unknown',
        target: node.target.join(' '),
      });
    }
  }
}

/** The run page's views below its activity runs, each scanned once. */
const RUN_VIEWS = ['Gantt', 'Graph', 'Events', 'Variables', 'Cost'] as const;

function report(findings: Finding[]): string {
  return findings.map((f) => `${f.view}: ${f.rule} (${f.impact}) at ${f.target}`).join('\n');
}

for (const theme of THEMES) {
  for (const density of DENSITIES) {
    test(`axe: 0 violations on every audited view, ${theme} ${density}`, async ({ page }) => {
      test.setTimeout(120_000);
      const problems = collectPageProblems(page);
      const tag = `e2e-axe-${theme}-${density}`;
      const root = realpathSync(mkdtempSync(join(tmpdir(), `${tag}-`)));
      try {
        mkdirSync(join(root, 'a'));
        mkdirSync(join(root, 'b'));
        writeFileSync(join(root, 'people.csv'), 'id,name\n1,Ada\n');
        await page.setViewportSize({ width: 1440, height: 900 });
        await preferAppearance(page, theme, density);

        // A workspace with a row in every list.
        const files = await seedConnection(page, {
          name: `${tag} files`,
          kind: 'fs',
          config: { roots: [root] },
        });
        const people = await seedDataset(page, {
          name: `${tag} people`,
          kind: 'delimited',
          connectionId: files,
          config: { path: join(root, 'people.csv'), header: true },
          columns: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'name', type: 'string', nullable: true },
          ],
        });
        const paramName = `${tag.replaceAll('-', '_')}_param`;
        const secret = await page.request.post('/api/secrets', {
          data: { name: `${tag}-secret`, secret: 'x' },
        });
        expect(secret.status(), await secret.text()).toBe(201);
        const param = await page.request.post('/api/global-params', {
          data: { name: paramName, type: 'string', value: 'v' },
        });
        expect(param.status(), await param.text()).toBe(201);

        // A settled run with a ForEach of two items, so the run page has
        // activity runs and the drawer has something to open.
        const { pipelineVersionId } = await seedVersion(page, `${tag} run`, {
          nodes: [
            {
              id: 'ls',
              type: 'file_list',
              connectionId: files,
              config: { path: '${item}' },
              position: { x: 0, y: 0 },
            },
          ],
          containers: [
            {
              id: 'each',
              kind: 'foreach',
              children: ['ls'],
              items: `\${createArray('${join(root, 'a')}', '${join(root, 'b')}')}`,
            },
          ],
        });
        const runId = await fireAndSettle(page, pipelineVersionId, `${tag} trigger`);

        const findings: Finding[] = [];

        // The seeded row each list must show before it is scanned, so a list
        // is never scanned while it is still loading or empty.
        const seededRow: Record<string, string> = {
          '/author/pipelines': `${tag} run`,
          '/monitor/runs': `${tag} run`,
          '/manage/connections': `${tag} files`,
          '/manage/datasets': `${tag} people`,
          '/manage/secrets': `${tag}-secret`,
          '/manage/global-params': paramName,
          '/manage/triggers': `${tag} trigger`,
        };
        for (const p of TITLED_PAGES) {
          await page.goto(`/#${p.path}`);
          await fluentRootReady(page);
          await expect(page.getByRole('heading', { level: 1, name: p.title })).toBeVisible();
          await expectAppearance(page, theme, density);
          const row = seededRow[p.path];
          if (row !== undefined) {
            await expect(page.getByRole('row').filter({ hasText: row }).first()).toBeVisible();
          }
          await scan(page, p.title, findings);
        }

        await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
        await fluentRootReady(page);
        const opens = page.locator('.activity-runs__table .activity-runs__open');
        await expect(opens).toHaveCount(2);
        await scan(page, 'run detail', findings);
        for (const view of RUN_VIEWS) {
          await openRunView(page, view);
          await scan(page, `run detail, ${view}`, findings);
        }
        await opens.first().click();
        await expect(
          page.locator('#run-detail-drawer').getByRole('region', { name: /^Node / }),
        ).toBeVisible();
        await scan(page, 'run detail, drawer open', findings);

        // The editor: a Copy bound to the dataset, inside nothing, beside a ForEach.
        await openSeededCanvas(page, `${tag} editor`, {
          nodes: [
            {
              id: 'copy',
              type: 'copy',
              position: { x: 0, y: 0 },
              connectionIds: { source: files, sink: files },
              datasetIds: { source: people, sink: people },
              config: { mapping: [{ source: 'id', sink: 'id', type: 'string' }] },
            },
            { id: 'h', position: { x: 400, y: 0 } },
          ],
          containers: [
            { id: 'foreach_1', kind: 'foreach', children: ['h'], items: '${createArray(1, 2)}' },
          ],
        });
        await scan(page, 'editor, pipeline properties', findings);

        await nodeById(page, 'copy').click();
        await expect(
          properties(page).getByRole('tab', { name: 'Sink', exact: true }),
        ).toBeVisible();
        await scan(page, 'editor, Copy selected', findings);

        await properties(page).getByRole('tab', { name: 'Sink', exact: true }).click();
        const sink = properties(page).getByRole('combobox', { name: 'Sink connection' });
        await expect(sink).toBeVisible();
        await scan(page, 'editor, Copy selected, Sink tab', findings);

        await sink.click();
        await expect(page.getByRole('listbox')).toBeVisible();
        await scan(page, 'editor, connection picker open', findings);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('listbox')).toHaveCount(0);

        await page.getByRole('button', { name: 'Expand properties' }).click();
        await expect(page.getByRole('button', { name: 'Expand properties' })).toHaveCount(0);
        await scan(page, 'editor, Expand properties', findings);
        await page.keyboard.press('Escape');

        await page.getByRole('button', { name: 'Configure ForEach 1' }).click();
        await expect(page.getByRole('heading', { name: 'ForEach 1' })).toBeVisible();
        await scan(page, 'editor, ForEach selected', findings);

        await page.goto('/#/manage/connections');
        await fluentRootReady(page);
        await page.getByRole('button', { name: 'New connection' }).click();
        await expect(page.getByRole('dialog', { name: 'New connection' })).toBeVisible();
        await scan(page, 'New connection kind gallery', findings);

        expect(findings, report(findings)).toEqual([]);
        await expectQuiet(page, problems);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

/**
 * The Git page CONNECTED — a different page from the empty state the loop
 * above scans. Its own test because the connection is workspace-wide state,
 * undone in `finally` whatever happens.
 */
test('axe: 0 violations on the connected Git page, both themes and densities', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const problems = collectPageProblems(page);
  const repo = makeBareRepo('e2e-axe-git-');
  try {
    const connected = await request.post('/api/workspace/git', { data: { repoUrl: repo } });
    expect(connected.ok(), await connected.text()).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    const findings: Finding[] = [];
    for (const theme of THEMES) {
      for (const density of DENSITIES) {
        // Init scripts run in the order added, so the latest pair wins.
        await preferAppearance(page, theme, density);
        await page.goto('/#/manage/git');
        // The same URL again is a same-document move; a reload reruns the scripts.
        await page.reload();
        await fluentRootReady(page);
        await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toBeVisible();
        await expectAppearance(page, theme, density);
        await scan(page, `Git connected, ${theme} ${density}`, findings);
      }
    }
    expect(findings, report(findings)).toEqual([]);
    await expectQuiet(page, problems);
  } finally {
    await disconnectWorkspaceGit(request);
    rmSync(repo, { recursive: true, force: true });
  }
});
