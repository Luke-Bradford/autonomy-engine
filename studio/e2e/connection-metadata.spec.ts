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
  test('are created, saved and prefilled on Edit, in ADF order, one line per row', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const name = `e2e 1477 meta ${Date.now()}`;
    await gotoConnections(page);
    await openNewConnection(page, 'http');

    await form(page).getByLabel('Name', { exact: true }).fill(name);
    await form(page).getByLabel('Description', { exact: true }).fill('Reads the nightly feed');
    await form(page).getByRole('button', { name: 'Add annotation' }).click();
    await form(page).getByLabel('Annotation 1', { exact: true }).fill('prod');
    await form(page).getByRole('button', { name: 'Add annotation' }).click();
    await form(page).getByLabel('Annotation 2', { exact: true }).fill('finance');

    const topOf = async (label: string) =>
      (await form(page).getByLabel(label, { exact: true }).boundingBox())!.y;
    const order = {
      nameAboveDescription: (await topOf('Name')) < (await topOf('Description')),
      descriptionAboveKind: (await topOf('Description')) < (await topOf('Kind')),
    };
    // The labelled controls, not DOM order: a reordered field cannot change what is compared.
    const heightOf = async (label: string) =>
      Math.round((await form(page).getByLabel(label, { exact: true }).boundingBox())!.height);
    const rowInputMatchesName = (await heightOf('Annotation 1')) === (await heightOf('Name'));
    const layout = await page.evaluate(() => {
      const root = document.querySelector('form[aria-label="Connection form"]')!;
      const sections = [...root.querySelectorAll('.section__title')].map((h) =>
        h.textContent?.trim(),
      );
      const row = root.querySelector('table[aria-label="Annotations"] tbody tr')!;
      const input = row.querySelector('input')!;
      return {
        annotationsLast: sections.at(-1),
        rowsOneLine:
          Math.round(row.getBoundingClientRect().height) <=
          Math.round(input.getBoundingClientRect().height) + 8,
      };
    });
    expect(order).toEqual({ nameAboveDescription: true, descriptionAboveKind: true });
    // A row's box is as tall as the drawer's own text box. The drawer is not on
    // compact density yet, and its 14.4px field text is off the type ramp: both
    // are OR40 #1594's to change, for every field at once.
    expect(rowInputMatchesName).toBe(true);
    expect(layout).toEqual({
      annotationsLast: 'Annotations',
      rowsOneLine: true,
    });

    await form(page).getByRole('button', { name: 'Create connection' }).click();
    await expect(form(page)).toHaveCount(0);

    await page.getByRole('button', { name: `Edit ${name}` }).click();
    await expect(form(page).getByLabel('Description', { exact: true })).toHaveValue(
      'Reads the nightly feed',
    );
    await expect(form(page).getByLabel('Annotation 1', { exact: true })).toHaveValue('prod');
    await expect(form(page).getByLabel('Annotation 2', { exact: true })).toHaveValue('finance');
    await expectQuiet(page, problems);
  });
});
