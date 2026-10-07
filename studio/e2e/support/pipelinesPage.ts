import { expect, type Locator, type Page } from '@playwright/test';

/**
 * #1569 OR37 slice 3 — the Pipelines page creates and imports through its
 * toolbar's drawers. By its exact `+ New pipeline` name: the Factory Resources
 * pane beside the page has its own icon button named "New pipeline".
 */
export function newPipelineButton(page: Page): Locator {
  return page.getByRole('button', { name: '+ New pipeline', exact: true });
}

/** Create a pipeline through the New pipeline drawer, which closes once it has. */
export async function createPipelineFromList(page: Page, name: string): Promise<void> {
  await newPipelineButton(page).click();
  const form = page.getByRole('form', { name: 'New pipeline' });
  // `exact`, by ROLE: a substring `getByLabel('Name')` also matches row controls
  // of any pipeline whose name contains "name" (see `openCanvas`).
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await form.getByRole('button', { name: 'Create pipeline' }).click();
  await expect(form).toBeHidden();
}

/** Open the Import drawer: an export file, or the demo. */
export async function openImportDrawer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const drawer = page.getByRole('form', { name: 'Import' });
  await expect(drawer).toBeVisible();
  return drawer;
}
