import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1600 OR41 C0f — the workspace's default Timeout (catalogue §3: "12 h
 * (workspace setting)"). Set on the Settings page, written into a NEW execution
 * activity's policy as ADF does. That it never touches an existing activity is
 * pinned in `canvasStore.test.ts`.
 *
 * Each canvas test opens its own canvas and never navigates away from it: adding
 * an activity makes the doc dirty, and the editor holds a route change while it
 * is. The setting is changed through the API before the canvas opens.
 */

const TIMEOUT = 'Timeout (duration)';
const DEFAULT_FIELD = 'Activity timeout (duration)';
const SETTINGS_URL = '/api/workspace/settings';

/** The PUT takes the whole document (#1600 C7d), so Lookup max rows goes back as its default. */
async function putDefault(page: Page, seconds: number | null, lookupMaxRows = 1000): Promise<void> {
  const res = await page.request.put(SETTINGS_URL, {
    data: { defaultActivityTimeoutSeconds: seconds, lookupMaxRows },
  });
  expect(res.status()).toBe(200);
}

/** Open a fresh canvas, and wait until it has read the workspace default. */
async function openCanvasWithDefault(page: Page, name: string, expected: number | null) {
  const read = page.waitForResponse(
    (r) => r.url().endsWith(SETTINGS_URL) && r.request().method() === 'GET',
  );
  await openSeededCanvas(page, name, { nodes: [] });
  const body = (await (await read).json()) as {
    settings: { defaultActivityTimeoutSeconds: number | null };
  };
  expect(body.settings.defaultActivityTimeoutSeconds).toBe(expected);
}

/** Select the most recently added node and open its General tab. */
async function openNewestGeneral(page: Page): Promise<void> {
  await canvasNodes(page).last().click();
  await properties(page).getByRole('tab', { name: 'General' }).click();
}

function defaultField(page: Page) {
  return page.getByRole('region', { name: 'Run defaults' }).getByLabel(DEFAULT_FIELD, {
    exact: true,
  });
}

test.describe('#1600 C0f — the workspace default activity timeout', () => {
  // The setting is workspace-wide and the e2e server is shared, so leave it at
  // its default for every spec after this one.
  test.afterEach(async ({ page }) => {
    await putDefault(page, 43_200);
  });

  test('a new activity starts with the 12 h default', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvasWithDefault(page, 'timeout default 12h', 43_200);
    await addActivity(page, 'Web');
    await openNewestGeneral(page);
    // #1680 — shown as ADF's D.HH:MM:SS.
    await expect(properties(page).getByLabel(TIMEOUT, { exact: true })).toHaveValue('12:00:00');
    await expectQuiet(page, problems);
  });

  test('a changed default is what the next new activity gets', async ({ page }) => {
    await putDefault(page, 600);
    await openCanvasWithDefault(page, 'timeout default 600', 600);
    await addActivity(page, 'Web');
    await openNewestGeneral(page);
    await expect(properties(page).getByLabel(TIMEOUT, { exact: true })).toHaveValue('00:10:00');
  });

  test('with the default off, a new activity has none, and a control activity never takes one', async ({
    page,
  }) => {
    await putDefault(page, null);
    await openCanvasWithDefault(page, 'timeout default off', null);
    await addActivity(page, 'Web');
    await openNewestGeneral(page);
    await expect(properties(page).getByLabel(TIMEOUT, { exact: true })).toHaveValue('');
    await addActivity(page, 'Wait');
    await openNewestGeneral(page);
    await expect(properties(page).getByLabel(TIMEOUT, { exact: true })).toHaveCount(0);
  });

  test('Settings saves the default when the field is left, in the first screen at 1440x900', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/settings');
    await expect(defaultField(page)).toHaveValue('12:00:00');

    const box = await defaultField(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(900);
    // Sized to a number, not stretched across the page.
    expect(box!.width).toBeLessThanOrEqual(200);

    // #1680 — typed as D.HH:MM:SS, saved as its seconds.
    await defaultField(page).fill('1.02:03:04');
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(SETTINGS_URL) && r.request().method() === 'PUT',
    );
    await defaultField(page).blur();
    const put = await saved;
    expect(put.status()).toBe(200);
    expect(put.request().postDataJSON()).toMatchObject({ defaultActivityTimeoutSeconds: 93_784 });
    // A reload reads the stored value back, not the field's draft.
    await page.reload();
    await expect(defaultField(page)).toHaveValue('1.02:03:04');
    await expectQuiet(page, problems);
  });
});

/**
 * #1600 OR41 C7d — the workspace's Lookup max rows, beside the timeout. That a
 * Lookup run is held to it is pinned in `lookup-activity.test.ts` and
 * `executor.test.ts`; this is the field, its save and its read-back.
 */
test.describe('#1600 C7d — the workspace Lookup max rows', () => {
  test.afterEach(async ({ page }) => {
    await putDefault(page, 43_200, 1000);
  });

  const rowsField = (page: Page) =>
    page
      .getByRole('region', { name: 'Run defaults' })
      .getByLabel('Lookup max rows', { exact: true });

  test('Settings saves Lookup max rows beside the timeout, without undoing it, at 1440x900', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await putDefault(page, 600, 1000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/settings');
    await expect(rowsField(page)).toHaveValue('1000');

    const box = await rowsField(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(900);
    expect(box!.width).toBeLessThanOrEqual(200);

    await rowsField(page).fill('5001');
    await rowsField(page).blur();
    await expect(page.getByText('Enter a whole number from 1 to 5000')).toBeVisible();

    await rowsField(page).fill('2500');
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(SETTINGS_URL) && r.request().method() === 'PUT',
    );
    await rowsField(page).blur();
    expect((await saved).status()).toBe(200);
    await page.reload();
    await expect(rowsField(page)).toHaveValue('2500');
    // The timeout saved before is still there: the PUT carried the whole document.
    await expect(defaultField(page)).toHaveValue('00:10:00');
    await expectQuiet(page, problems);
  });
});
