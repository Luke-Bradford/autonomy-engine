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
  //
  // `exact` for the SAME reason as the fill above, which this line originally
  // missed: `Open e2e u5 collapse` is a substring of `Open e2e u5 collapse
  // search`, a pipeline an EARLIER spec in that file leaves behind. Worse than a
  // plain break — it was a RACE. The old link is on the page before the new one
  // renders, so whichever evaluation won decided the outcome: click early and
  // the helper silently opened the WRONG pipeline and the spec passed anyway;
  // click late and Playwright's strict mode saw two matches and failed. Green on
  // main, red on the next PR, with nothing between them to explain it.
  await openExistingCanvas(page, name);
}

/**
 * Open the canvas of a pipeline that ALREADY exists.
 *
 * The other half of `openCanvas`, which creates one first. A caller whose
 * pipeline arrived by some other route — a git import (#979), a copy, a seed —
 * cannot use that helper, and hand-rolling the navigation is how the two `exact`
 * lessons above get lost: both the Open link and the shared single-worker
 * database are unchanged here, so the same substring races apply.
 */
export async function openExistingCanvas(page: Page, name: string): Promise<void> {
  if (!page.url().includes('#/author/pipelines')) {
    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
    await fluentRootReady(page);
  }
  await page.getByRole('link', { name: `Open ${name}`, exact: true }).click();
  // The RF viewport, not just the wrapper — the chrome is its child.
  await page.locator('.react-flow__renderer').waitFor();
}
