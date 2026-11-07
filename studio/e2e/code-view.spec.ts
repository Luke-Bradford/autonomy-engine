import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { nodeById, openSeededCanvas } from './support/seedDoc';

/**
 * #1573 OR38 — the editor's Code view: the whole pipeline as JSON, edited and
 * applied to the canvas as one undoable edit, with every refusal on its line.
 */

const DOC_KEYS = [
  'description',
  'annotations',
  'params',
  'variables',
  'outputs',
  'nodes',
  'edges',
  'containers',
] as const;

const DEMO_NAMES = [
  'Demo — 1 Load one CSV to staging',
  'Demo — 2 Ingest landing folder',
  'Demo — 3 Clean and aggregate',
  'Demo — 4 Nightly orchestrator',
  'Demo — 5 Broken on purpose',
];

function codeDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Pipeline code' });
}

async function openCode(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  const dialog = codeDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

const codeBox = (dialog: Locator) => dialog.getByRole('textbox', { name: 'Pipeline code' });

/** The latest saved version's doc, as the server stores it. */
async function savedDoc(page: Page, pipelineId: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`);
  expect(res.status()).toBe(200);
  const versions = (await res.json()) as ({ version: number } & Record<string, unknown>)[];
  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
  return Object.fromEntries(DOC_KEYS.map((k) => [k, latest[k]]));
}

test.describe('#1573 the Code view', () => {
  test('shows the saved doc, applies an edit as one undo step, and refuses with the line', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const pipelineId = await openSeededCanvas(page, 'e2e code view', {
      description: 'code view',
      annotations: ['e2e'],
      params: [{ name: 'mode', type: 'string', required: false, default: 'full' }],
      nodes: [
        {
          id: 'n_if',
          type: 'if',
          config: { condition: "${equals(params.mode, 'full')}" },
          position: { x: 0, y: 0 },
        },
        { id: 'n_wait', type: 'wait', config: { seconds: '${1}' }, position: { x: 320, y: 0 } },
      ],
      edges: [{ id: 'e_1', from: 'n_if', to: 'n_wait', on: 'success' }],
    });
    await expect(nodeById(page, 'n_if')).toContainText("equals(params.mode, 'full')");

    // Opened on the doc the canvas holds: the saved one, exactly.
    let dialog = await openCode(page);
    const text = await codeBox(dialog).inputValue();
    expect(Object.keys(JSON.parse(text) as object)).toEqual([...DOC_KEYS]);
    expect(JSON.parse(text)).toEqual(await savedDoc(page, pipelineId));
    await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await expect(dialog.getByText('No problems')).toBeVisible();

    // The dialog is accessible as it stands open.
    const axe = await new AxeBuilder({ page }).include('dialog.code-view').analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
    expect(axe.passes.length).toBeGreaterThan(0);

    // Not JSON: Apply stays off, and the problem names its line.
    const broken = text.replace('"type": "if",', '"type": "if"');
    expect(broken).not.toBe(text);
    await codeBox(dialog).fill(broken);
    const brokenLine = broken.split('\n').findIndex((l) => l.includes('"type": "if"')) + 2;
    const problemsList = dialog.getByRole('region', { name: 'Problems' });
    await expect(problemsList.getByRole('button', { name: `Line ${brokenLine}` })).toBeVisible();
    await expect(problemsList).toContainText('Blocks apply');
    await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled();

    // An unknown activity type: refused, on the line of its type.
    const unknown = text.replace('"type": "wait"', '"type": "wiat"');
    await codeBox(dialog).fill(unknown);
    const unknownLine = unknown.split('\n').findIndex((l) => l.includes('"wiat"')) + 1;
    await expect(problemsList).toContainText("unknown activity type 'wiat'");
    await expect(problemsList.getByRole('button', { name: `Line ${unknownLine}` })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled();

    // Line N moves the caret to that line.
    await problemsList.getByRole('button', { name: `Line ${unknownLine}` }).click();
    const selected = await codeBox(dialog).evaluate((el: HTMLTextAreaElement) =>
      el.value.slice(el.selectionStart, el.selectionEnd),
    );
    expect(selected).toContain('"wiat"');

    // Edit the If's condition and Apply: the canvas shows it, the draft is unsaved.
    const edited = text.replace("'full')}", "'delta')}");
    expect(edited).not.toBe(text);
    await codeBox(dialog).fill(edited);
    await expect(dialog.getByText('No problems')).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toBeHidden();
    await expect(nodeById(page, 'n_if')).toContainText("equals(params.mode, 'delta')");
    await expect(page.locator('.dirty-dot')).toHaveCSS('visibility', 'visible');

    // One Undo takes the whole Apply back.
    await nodeById(page, 'n_wait').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(nodeById(page, 'n_if')).toContainText("equals(params.mode, 'full')");
    await expect(page.locator('.dirty-dot')).toHaveCSS('visibility', 'hidden');

    // Cancel with edits asks first, and Keep editing keeps the text.
    dialog = await openCode(page);
    await codeBox(dialog).fill(edited);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(codeBox(dialog)).toHaveValue(edited);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.getByRole('button', { name: 'Discard changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(nodeById(page, 'n_if')).toContainText("equals(params.mode, 'full')");

    await expectQuiet(page, problems);
  });

  test.describe('the demo pipelines', () => {
    test.afterAll(async ({ request }) => {
      const res = await request.delete('/api/demo');
      expect(res.status(), `removing the demo: ${await res.text()}`).toBe(200);
    });

    test('each opens in the Code view as exactly its saved doc', async ({ page }) => {
      test.setTimeout(90_000);
      const problems = collectPageProblems(page);
      // 201 on a first load, 200 when another spec left it loaded.
      const seeded = await page.request.post('/api/demo/seed');
      expect([200, 201], await seeded.text()).toContain(seeded.status());
      const { pipelines } = (await seeded.json()) as {
        pipelines: { name: string; pipelineId: string }[];
      };
      expect(pipelines.map((p) => p.name)).toEqual(DEMO_NAMES);
      for (const { name, pipelineId } of pipelines) {
        const pipeline = { id: pipelineId };
        await page.goto(`/#/author/pipelines/${encodeURIComponent(pipeline!.id)}`);
        await fluentRootReady(page);
        await page.locator('.react-flow__renderer').waitFor();
        const dialog = await openCode(page);
        const text = await codeBox(dialog).inputValue();
        expect(JSON.parse(text), name).toEqual(await savedDoc(page, pipeline!.id));
        // Nothing in a saved doc keeps Apply off.
        await expect(dialog.getByText('Blocks apply')).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
      }
      await expectQuiet(page, problems);
    });
  });
});
