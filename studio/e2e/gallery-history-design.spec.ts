import { expect, test, type Page } from '@playwright/test';
import { allCapsText } from './support/allCaps';
import {
  CONTROL_H,
  computedStyles as styles,
  DENSITIES,
  expectAppearance,
  ICON_SIZE,
  preferAppearance,
  ROW_H,
} from './support/appearance';
import { editorMenuItem } from './support/canvas';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { chooseRowAction } from './support/rowMenu';
import { mintVersion, nodeById, seedVersion, type SeedDoc } from './support/seedDoc';
import { seedConnection } from './support/seedResources';
import { fluentRootReady } from './support/theme';
import { offRampText } from './support/typeRamp';

/**
 * #1594 OR40 S6s — the connection kind family and the editor's version history
 * on the design system, at 1440x900 in compact light and comfortable dark: a
 * kind's name and icon in a list row and beside the form's Kind picker, the New
 * connection kind gallery (search, paste field and its reason, group headings,
 * tiles), and the version-history column (its panel, rows, tags, ⋯ and a clone's
 * status line).
 *
 * Measured: all their text on the type ramp, and their spacing on the 4px scale
 * at the values below.
 */

type Density = (typeof DENSITIES)[number];

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

const PAD = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] as const;

/** All four paddings, as one string per side, for one `toMatchObject`. */
const pads = (top: number, right: number, bottom = top, left = right) => ({
  'padding-top': `${top}px`,
  'padding-right': `${right}px`,
  'padding-bottom': `${bottom}px`,
  'padding-left': `${left}px`,
});

const V1: SeedDoc = {
  nodes: [
    { id: 'n_a', position: { x: 0, y: 0 } },
    { id: 'n_b', position: { x: 320, y: 0 } },
  ],
  edges: [{ from: 'n_a', to: 'n_b', on: 'success' }],
};
const V2: SeedDoc = {
  nodes: [...V1.nodes, { id: 'n_c', position: { x: 640, y: 0 } }],
  edges: V1.edges,
};

/** Each history row's ⋯ against the row's first line (its version number): centres apart, in px. */
function menuOffCentre(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.version-history-item__line')].map((line) => {
      const mid = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      };
      return Math.abs(
        mid(line.querySelector('.version-history-row > strong')!) -
          mid(line.querySelector('.row-menu__trigger')!),
      );
    }),
  );
}

for (const { density, theme } of RUNS) {
  const d = density as Density;

  test(`#1594 OR40 S6s — the kind gallery and the version history on the ramp and the scale (${density} ${theme})`, async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, d);

    // --- Manage → Connections: a kind's name and icon in a list row ----------
    const conn = `e2e_s6s_conn_${density}`;
    await seedConnection(page, { name: conn, kind: 'http', config: {} });
    await page.goto('/#/manage/connections');
    await page.getByRole('heading', { name: 'Connections' }).waitFor();
    await fluentRootReady(page);
    await expectAppearance(page, theme, d);
    const listed = page.getByRole('row').filter({ hasText: conn });
    await expect(listed).toBeVisible();
    const kindName = await listed.locator('.kind-name').evaluate((el) => ({
      gap: getComputedStyle(el).columnGap,
      icon: Math.round(el.querySelector('.kind-icon svg')!.getBoundingClientRect().height),
    }));
    expect(kindName, 'kind name: icon at the icon size, 4px from the name').toEqual({
      gap: '4px',
      icon: ICON_SIZE[d],
    });
    // The icon does not make its row any taller.
    expect(Math.round((await listed.boundingBox())?.height ?? 0)).toBe(ROW_H[d]);

    // --- New connection: the kind gallery -----------------------------------
    await page.getByRole('button', { name: 'New connection' }).click();
    const gallery = page.getByRole('dialog', { name: 'New connection' });
    const paste = gallery.getByRole('textbox', { name: 'Paste a path or URL' });
    await paste.fill('not a path or a url');
    await paste.press('Enter');
    await expect(gallery.locator('.kind-gallery__reason')).not.toBeEmpty();

    const g = await styles(
      page,
      [
        '.kind-gallery',
        '.kind-gallery__paste',
        '.kind-gallery__paste .kind-gallery__reason',
        '.kind-gallery__group h3',
        '.kind-gallery__tiles',
        '.kind-gallery__tiles li',
        '.kind-gallery__tile',
      ],
      [...PAD, 'row-gap', 'column-gap', 'margin-top', 'margin-bottom', 'min-height'],
    );
    expect(g['.kind-gallery']).toMatchObject({ 'row-gap': '12px' });
    expect(g['.kind-gallery__paste']).toMatchObject({ 'row-gap': 'normal', 'column-gap': '8px' });
    expect(g['.kind-gallery__paste .kind-gallery__reason']).toMatchObject({ 'margin-top': '4px' });
    expect(g['.kind-gallery__group h3']).toMatchObject({
      'margin-top': '0px',
      'margin-bottom': '4px',
    });
    expect(g['.kind-gallery__tiles']).toMatchObject({ 'row-gap': '4px', 'column-gap': '4px' });
    expect(g['.kind-gallery__tiles li']).toMatchObject({ 'row-gap': '4px' });
    expect(g['.kind-gallery__tile']).toMatchObject({
      ...pads(4, 8),
      'min-height': `${CONTROL_H[d]}px`,
    });
    const tile = await gallery.getByRole('button', { name: 'HTTP', exact: true }).boundingBox();
    expect(Math.round(tile?.height ?? 0), 'a tile is one control tall').toBe(CONTROL_H[d]);
    expect(await offRampText(page, d, '.kind-gallery'), 'gallery: ramp').toEqual([]);
    expect(await allCapsText(page, '.kind-gallery'), 'gallery: ALL CAPS').toEqual([]);

    // A search with no match: the empty line, on the ramp.
    await gallery.getByRole('textbox', { name: 'Search connection kinds' }).fill('zzz');
    await expect(gallery.locator('.kind-gallery__empty')).toBeVisible();
    expect(await offRampText(page, d, '.kind-gallery'), 'gallery empty: ramp').toEqual([]);
    await gallery.getByRole('textbox', { name: 'Search connection kinds' }).fill('');

    // Picking a kind: its icon beside the form's Kind picker, 8px apart.
    await gallery.getByRole('button', { name: 'HTTP', exact: true }).click();
    const form = page.getByRole('form', { name: 'Connection form' });
    await expect(form.getByLabel('Kind')).toHaveValue('http');
    const pick = await styles(page, ['.form-drawer .kind-select'], ['column-gap']);
    expect(pick['.form-drawer .kind-select']).toMatchObject({ 'column-gap': '8px' });
    await page.keyboard.press('Escape');

    // --- The editor's version history ----------------------------------------
    const name = `e2e-s6s-history-${density}`;
    const { pipelineId, pipelineVersionId } = await seedVersion(page, name, V1);
    await mintVersion(page, pipelineId, V2, pipelineVersionId, name);
    await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
    await fluentRootReady(page);
    await expect(nodeById(page, 'n_c')).toHaveClass(/\bdraggable\b/);
    await (await editorMenuItem(page, /^Show version history/)).click();
    const rows = page.locator('.version-history-row');
    await expect(rows).toHaveCount(2);

    const h = await styles(
      page,
      [
        '.version-history',
        '.version-history__header',
        '.version-history__header h2',
        '.version-history-list',
        '.version-history-row',
        '.version-history-tag',
        '.version-history-item__line',
      ],
      [...PAD, 'row-gap', 'column-gap', 'margin-top', 'margin-bottom', 'border-top-left-radius'],
    );
    // The column is a panel like the Activities column beside it.
    expect(h['.version-history']).toMatchObject({
      ...pads(12, 12),
      'row-gap': '8px',
      'border-top-left-radius': '6px',
    });
    expect(h['.version-history__header']).toMatchObject({ 'margin-bottom': '0px' });
    expect(h['.version-history__header h2']).toMatchObject({
      'margin-top': '0px',
      'margin-bottom': '0px',
    });
    expect(h['.version-history-list']).toMatchObject({ 'row-gap': '4px' });
    expect(h['.version-history-row']).toMatchObject({
      ...pads(0, 8, 4),
      'row-gap': '4px',
      'column-gap': '8px',
      'border-top-left-radius': '4px',
    });
    expect(h['.version-history-tag']).toMatchObject({
      ...pads(0, 4),
      'border-top-left-radius': '999px',
    });
    expect(h['.version-history-item__line']).toMatchObject({ 'column-gap': '4px' });
    // Each row's ⋯ is level with the row's first line.
    for (const off of await menuOffCentre(page)) {
      expect(off, 'history: ⋯ centred on the version number').toBeLessThanOrEqual(1);
    }

    // A clone's status line under its row.
    await chooseRowAction(page, 'Clone v1 as new pipeline…', 'v1');
    await page.getByRole('textbox', { name: 'New pipeline name' }).fill(`e2e-s6s-clone-${density}`);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    await expect(page.locator('.version-history-clone-status')).toBeVisible();
    const status = await styles(
      page,
      ['.version-history-clone-status'],
      [...PAD, 'margin-top', 'margin-left', 'margin-bottom'],
    );
    expect(status['.version-history-clone-status']).toMatchObject({
      'margin-top': '0px',
      'margin-left': '8px',
      'margin-bottom': '4px',
    });
    expect(await offRampText(page, d, '.version-history'), 'history: ramp').toEqual([]);
    expect(await allCapsText(page, '.version-history'), 'history: ALL CAPS').toEqual([]);

    await expectQuiet(page, problems);
  });
}
