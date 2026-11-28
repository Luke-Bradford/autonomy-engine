import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { canvasNodes } from './support/canvasGraph';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { properties } from './support/panels';
import { seedConnection } from './support/seedResources';

/**
 * #1600 OR41 C2a — Copy · Files as-is · Inline content (activity catalogue
 * §4.1's Inline source, §8's `file_write` lowering).
 *
 * A stored Write file keeps running as Write file. Opened in the editor, it is
 * Copy data with Path type Inline content: its text in Content, its path split
 * into Sink folder and File name. Only the fields that apply are drawn, at
 * 1440x900. Saved, it runs as a files copy and writes the same file.
 */

const tab = (page: Page, name: string) => properties(page).getByRole('tab', { name, exact: true });

function tempRoot(tag: string): string {
  // `realpathSync`: macOS `/var` is a symlink, and the fs connector refuses one.
  return realpathSync(mkdtempSync(join(tmpdir(), `e2e-${tag}-`)));
}

test.describe('#1600 C2a — Inline content', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a stored Write file opens as Copy · Inline content, and the saved copy writes the same file', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const root = tempRoot('1600-inline');
    try {
      const store = await seedConnection(page, {
        name: 'e2e 1600 inline store',
        kind: 'fs',
        config: { roots: [root], writable: true },
      });
      writeFileSync(join(root, 'report.txt'), 'an older, longer report\n');
      const doc = {
        nodes: [
          {
            id: 'n_write',
            type: 'file_write',
            position: { x: 0, y: 0 },
            connectionId: store,
            config: { path: 'report.txt', content: 'run ${run.runId}\nline two\n' },
          },
        ],
      };
      const { pipelineId, pipelineVersionId } = await seedVersion(page, 'e2e 1600 inline', doc);

      // The stored version is untouched by the lowering: it runs as Write file.
      const oldRun = await fireAndSettle(page, pipelineVersionId, 'e2e 1600 write file run');
      const old = await (await page.request.get(`/api/runs/${encodeURIComponent(oldRun)}`)).json();
      expect(old.status, `run: ${JSON.stringify(old)}`).toBe('success');
      expect(readFileSync(join(root, 'report.txt'), 'utf8')).toBe(`run ${oldRun}\nline two\n`);

      await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
      await expect(canvasNodes(page)).toHaveCount(1);
      await expect(canvasNodes(page).first()).toContainText('inline → report.txt');
      await canvasNodes(page).first().click();
      await tab(page, 'General').click();
      await expect(
        properties(page).getByRole('combobox', { name: 'Copy mode', exact: true }),
      ).toHaveValue('copy_files');

      await tab(page, 'Source').click();
      await expect(properties(page).getByRole('combobox', { name: 'Path type' })).toHaveValue(
        'inline',
      );
      const content = properties(page).getByRole('textbox', { name: 'Content', exact: true });
      await expect(content).toHaveValue('run ${run.runId}\nline two\n');
      await expect(content).toBeInViewport();
      // Nothing about source files is drawn for inline content.
      for (const name of ['Source path', 'Wildcard', 'Modified from', 'Modified before']) {
        await expect(properties(page).getByRole('textbox', { name, exact: true })).toHaveCount(0);
      }
      for (const name of ['Load', 'After copy']) {
        await expect(properties(page).getByRole('combobox', { name, exact: true })).toHaveCount(0);
      }

      await tab(page, 'Sink').click();
      await expect(
        properties(page).getByRole('textbox', { name: 'File name', exact: true }),
      ).toHaveValue('report.txt');
      await expect(properties(page).getByRole('combobox', { name: 'If file exists' })).toHaveValue(
        'overwrite',
      );
      await expect(properties(page).getByRole('combobox', { name: 'Copy behaviour' })).toHaveCount(
        0,
      );

      // Any edit saves the node as its replacement.
      await tab(page, 'General').click();
      await properties(page)
        .getByRole('textbox', { name: 'Activity description' })
        .fill('written by the lowering');
      await page.getByRole('button', { name: 'Save version' }).click();
      await expect(page.locator('.notice')).toHaveText('Saved v2.');
      const versions = (await (
        await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`)
      ).json()) as {
        id: string;
        version: number;
        catalogVersion: number;
        nodes: { type: string; connectionIds?: object; config: object }[];
      }[];
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      expect(latest.catalogVersion).toBe(77); // #1600 OR41 C2a — Files as-is Inline content
      expect(latest.nodes[0]).toMatchObject({
        type: 'copy_files',
        connectionIds: { source: store, sink: store },
        config: {
          pathType: 'inline',
          content: 'run ${run.runId}\nline two\n',
          sinkFileName: 'report.txt',
          ifExists: 'overwrite',
        },
      });

      writeFileSync(join(root, 'report.txt'), 'an older, longer report\n');
      const newRun = await fireAndSettle(page, latest.id, 'e2e 1600 inline run');
      const now = await (await page.request.get(`/api/runs/${encodeURIComponent(newRun)}`)).json();
      expect(now.status, `run: ${JSON.stringify(now)}`).toBe('success');
      expect(readFileSync(join(root, 'report.txt'), 'utf8')).toBe(`run ${newRun}\nline two\n`);
      await expectQuiet(page, problems);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
