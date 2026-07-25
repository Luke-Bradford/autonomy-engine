import { type Page } from '@playwright/test';
import { fluentRootReady } from './theme';

/**
 * Reaching a MOUNTED authoring canvas — the setup two spec files now share.
 *
 * Extracted rather than copied a third time, for the reason `support/theme.ts`
 * already records: this repo has paid once for a helper that existed twice and
 * was hardened in only one copy. The steps here encode real decisions (which
 * route is canonical, that Open is a LINK since U4, and which element proves the
 * canvas is mounted) and each is a thing that can change.
 */

/**
 * Create a pipeline and open its canvas, returning once React Flow has mounted.
 *
 * Navigates to the canonical `#/author/pipelines` rather than the MVP's flat
 * `#/pipelines`, which U3r still redirects — `legacy-routes.spec.ts` covers that
 * hop, so a canvas failure here can never be a routing failure in disguise.
 */
export async function openCanvas(page: Page, name: string): Promise<void> {
  await page.goto('/#/author/pipelines');
  await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
  await fluentRootReady(page);
  // `exact`, and by ROLE. `getByLabel('Name')` is a SUBSTRING matcher over every
  // accessible name on the page, so it also matched the row controls of any
  // pipeline whose name contains "name" — and the suite runs single-worker
  // against one shared SQLite file, so one spec creating a pipeline called
  // "…rename…" broke this helper for every LATER spec, with a strict-mode
  // violation that reads as "the create form is missing".
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create pipeline' }).click();
  // U4 turned Open into a LINK to the pipeline's own route — the canvas used to
  // be local state with no address at all.
  await page.getByRole('link', { name: `Open ${name}` }).click();
  // The RF viewport, not just the wrapper — the chrome is its child.
  await page.locator('.react-flow__renderer').waitFor();
}
