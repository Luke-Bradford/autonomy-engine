import { expect, test } from '@playwright/test';

test('the shell shows a version', async ({ page }) => {
  await page.goto('/#/');
  // The e2e server is an unpackaged build, so it reports the dev placeholder —
  // which is exactly what proves the badge renders what the API returned rather
  // than a hardcoded string.
  await expect(page.locator('.version-badge')).toHaveText('0.0.0-dev');
});

test('no update banner on a dev build', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('.update-banner')).toHaveCount(0);
});
