import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { contrastRatio, fluentRootReady, setTheme, surfaceBehind } from './support/theme';

/**
 * #1477 OR29 slice 5a — Manage → Connections → New connection opens ADF's
 * "New linked service" step: every connection kind, grouped and searchable,
 * picked BEFORE the form. Measured at 1440x900, the operator's acceptance size.
 */

async function gotoConnections(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/manage/connections');
  await page.getByRole('heading', { name: 'Connections' }).waitFor();
  await fluentRootReady(page);
}

const gallery = (page: Page) => page.getByRole('dialog', { name: 'New connection' });

test.describe('#1477 the connection kind gallery', () => {
  test('every kind is on screen, grouped, compact, before any scroll', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoConnections(page);
    await page.getByRole('button', { name: 'New connection' }).click();

    await expect(
      gallery(page).getByRole('textbox', { name: 'Search connection kinds' }),
    ).toBeFocused();
    await expect(page.getByRole('form', { name: 'Connection form' })).toHaveCount(0);

    const layout = await page.evaluate(() => {
      const root = document.querySelector('.kind-gallery')!;
      const tiles = [...root.querySelectorAll<HTMLElement>('.kind-gallery__tile')];
      const footer = root.closest('.form-drawer')!.querySelector('.form-drawer-footer')!;
      const footerTop = footer.getBoundingClientRect().top;
      const heading = root.querySelector('h4')!;
      return {
        groups: [...root.querySelectorAll('h4')].map((h) => h.textContent),
        tiles: tiles.map((t) => t.textContent),
        allAboveFooter: tiles.every((t) => t.getBoundingClientRect().bottom <= footerTop),
        allInViewport: tiles.every((t) => t.getBoundingClientRect().bottom <= window.innerHeight),
        scrolled: window.scrollY,
        tileHeights: [...new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().height)))],
        tileFont: getComputedStyle(tiles[0]!).fontSize,
        headingFont: `${getComputedStyle(heading).fontSize}/${getComputedStyle(heading).fontWeight}`,
        columns: new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().left))).size,
      };
    });
    expect(layout).toEqual({
      groups: ['Database', 'File', 'HTTP/API', 'AI'],
      tiles: [
        'SQLite',
        'PostgreSQL',
        'File system',
        'HTTP',
        'Anthropic API',
        'OpenAI API',
        'Ollama',
        'Agent CLI (subscription)',
      ],
      allAboveFooter: true,
      allInViewport: true,
      scrolled: 0,
      tileHeights: [28],
      tileFont: '13px',
      headingFont: '12px/600',
      columns: 2,
    });
    await expectQuiet(page, problems);
  });

  test('search narrows the kinds and says when none match', async ({ page }) => {
    await gotoConnections(page);
    await page.getByRole('button', { name: 'New connection' }).click();
    const search = gallery(page).getByRole('textbox', { name: 'Search connection kinds' });

    await search.fill('post');
    await expect(gallery(page).locator('.kind-gallery__tile')).toHaveText(['PostgreSQL']);
    await search.fill('database');
    await expect(gallery(page).locator('.kind-gallery__tile')).toHaveText(['SQLite', 'PostgreSQL']);
    await search.fill('zzz');
    await expect(gallery(page).getByText('No connection kinds match')).toBeVisible();
    await expect(gallery(page).locator('.kind-gallery__tile')).toHaveCount(0);
  });

  test('picking a kind opens that kind’s form; Escape closes the gallery back to New', async ({
    page,
  }) => {
    await gotoConnections(page);
    const newButton = page.getByRole('button', { name: 'New connection' });

    // Escape from a focused tile, not only from the search box.
    await newButton.click();
    await gallery(page).getByRole('button', { name: 'HTTP', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(gallery(page)).toHaveCount(0);
    await expect(newButton).toBeFocused();

    await newButton.click();
    await gallery(page).getByRole('button', { name: 'SQLite', exact: true }).click();
    const form = page.getByRole('form', { name: 'Connection form' });
    await expect(form.getByLabel('Kind')).toHaveValue('sqlite');
    await expect(form.getByLabel('Name')).toBeFocused();
    await expect(form.getByLabel(/^Database file/)).toBeVisible();
  });

  test('paste-to-detect: a postgres URL opens the PostgreSQL form filled in, the password only in Secret', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await gotoConnections(page);
    await page.getByRole('button', { name: 'New connection' }).click();
    // A shortcut above the kinds: one compact row, and the search keeps focus.
    const paste = gallery(page).getByRole('textbox', { name: 'Paste a path or URL' });
    await expect(
      gallery(page).getByRole('textbox', { name: 'Search connection kinds' }),
    ).toBeFocused();
    const row = await paste.locator('xpath=..').evaluate((el) => {
      const search = document.querySelector('.kind-gallery__search')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const controls = [...el.querySelectorAll('input, button')].map((c) =>
        Math.round(c.getBoundingClientRect().height),
      );
      return { above: r.bottom <= search.top, height: Math.round(r.height), controls };
    });
    expect(row).toEqual({ above: true, height: 28, controls: [28, 28] });

    await paste.fill('postgres://etl:pa%24%24word@db.internal:6543/warehouse?sslmode=require');
    await paste.press('Enter');
    // The gallery gives way to the form (whose drawer has the same title).
    await expect(paste).toHaveCount(0);
    const form = page.getByRole('form', { name: 'Connection form' });
    await expect(form.getByLabel('Kind')).toHaveValue('postgres');
    await expect(form.getByLabel(/^Host/)).toHaveValue('db.internal');
    await expect(form.getByLabel(/^Port/)).toHaveValue('6543');
    await expect(form.getByLabel(/^Database/)).toHaveValue('warehouse');
    await expect(form.getByLabel(/^User/)).toHaveValue('etl');
    await expect(form.getByLabel(/^TLS mode/)).toHaveValue('require');
    // The password is in the write-only Secret, and in no other field.
    const holding = await form.evaluate((el) =>
      [...el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')]
        .filter((f) => f.value.includes('pa$$word'))
        .map((f) => f.type),
    );
    expect(holding).toEqual(['password']);
    await expectQuiet(page, problems);
  });

  test('dark mode: tiles are legible on the drawer', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoConnections(page);
    await setTheme(page, 'dark');
    await page.getByRole('button', { name: 'New connection' }).click();
    const tile = gallery(page).getByRole('button', { name: 'PostgreSQL', exact: true });
    const color = await tile.evaluate((el) => getComputedStyle(el).color);
    const behind = await surfaceBehind(page, '.kind-gallery__tile');
    expect(contrastRatio(color, behind.color)).toBeGreaterThanOrEqual(4.5);
    await expectQuiet(page, problems);
  });
});
