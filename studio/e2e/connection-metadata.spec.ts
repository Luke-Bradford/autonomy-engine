import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { openNewConnection } from './support/newConnection';

/**
 * #1477 OR29 slice 5c — a connection's Description and Annotations, in ADF's
 * linked-service order: Name, Description, the kind's fields, Authentication,
 * then Annotations last. Created, saved, and read back on Edit, at 1440x900.
 */

async function gotoConnections(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/manage/connections');
  await page.getByRole('heading', { name: 'Connections' }).waitFor();
  await fluentRootReady(page);
}

const form = (page: Page) => page.getByRole('form', { name: 'Connection form' });

test.describe('#1477 connection description + annotations', () => {
  test('are created, saved and prefilled on Edit, in ADF order and at compact density', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const name = `e2e 1477 meta ${Date.now()}`;
    await gotoConnections(page);
    await openNewConnection(page, 'http');

    await form(page).getByLabel('Name', { exact: true }).fill(name);
    await form(page).getByLabel('Description', { exact: true }).fill('Reads the nightly feed');
    await form(page).getByRole('button', { name: 'Add annotation' }).click();
    await form(page).getByLabel('annotation 1', { exact: true }).fill('prod');
    await form(page).getByRole('button', { name: 'Add annotation' }).click();
    await form(page).getByLabel('annotation 2', { exact: true }).fill('finance');

    const topOf = async (label: string) =>
      (await form(page).getByLabel(label, { exact: true }).boundingBox())!.y;
    const order = {
      nameAboveDescription: (await topOf('Name')) < (await topOf('Description')),
      descriptionAboveKind: (await topOf('Description')) < (await topOf('Kind')),
    };
    const layout = await page.evaluate(() => {
      const root = document.querySelector('form[aria-label="Connection form"]')!;
      const sections = [...root.querySelectorAll('.form-section-title')].map((h) =>
        h.textContent?.trim(),
      );
      const row = root.querySelector('table[aria-label="Annotations"] tbody tr')!;
      const input = row.querySelector('input')!;
      return {
        annotationsLast: sections.at(-1),
        rowHeight: Math.round(row.getBoundingClientRect().height),
        inputHeight: Math.round(input.getBoundingClientRect().height),
        inputFont: getComputedStyle(input).fontSize,
      };
    });
    expect(order).toEqual({ nameAboveDescription: true, descriptionAboveKind: true });
    expect(layout).toEqual({
      annotationsLast: 'Annotations',
      rowHeight: 32,
      inputHeight: 28,
      inputFont: '13px',
    });

    await form(page).getByRole('button', { name: 'Create connection' }).click();
    await expect(form(page)).toHaveCount(0);

    await page.getByRole('button', { name: `Edit ${name}` }).click();
    await expect(form(page).getByLabel('Description', { exact: true })).toHaveValue(
      'Reads the nightly feed',
    );
    await expect(form(page).getByLabel('annotation 1', { exact: true })).toHaveValue('prod');
    await expect(form(page).getByLabel('annotation 2', { exact: true })).toHaveValue('finance');
    await expectQuiet(page, problems);
  });
});
