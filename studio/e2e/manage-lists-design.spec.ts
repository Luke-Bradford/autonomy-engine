import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { CONTROL_H, DENSITIES, expectAppearance, preferAppearance } from './support/appearance';
import { expectInlineRow } from './support/inlineRow';
import { offRampText } from './support/typeRamp';

/**
 * #1594 OR40 S6d — the five Manage lists on the design system, measured at
 * 1440x900 in compact light and comfortable dark.
 *
 * On each page: no paragraph of prose under the title, which says what the page
 * holds through its `?` instead ("About Secrets"), the page's description; the
 * title, the `?` and the create button one header row; the note, once open,
 * under that row at its left edge and inside the viewport; every piece of text
 * on the type ramp with the note closed and open; and, where the page imports,
 * the Import panel as the one `Section`, a named region whose file field is the
 * label-left form, 12px from its label. Each is read with the form closed and
 * no filter applied: a line of STATE (a Triggers filter, a dataset import with
 * no connection to store it in) is not prose and is not counted.
 *
 * Global parameters keeps one warning on screen, where a value is typed: the
 * Value field's hint says it is cleartext.
 */

type Density = (typeof DENSITIES)[number];

const PAGES = [
  { path: 'connections', title: 'Connections', create: 'New connection', imports: true },
  { path: 'datasets', title: 'Datasets', create: 'New dataset', imports: true },
  { path: 'triggers', title: 'Triggers', create: 'New trigger', imports: true },
  { path: 'secrets', title: 'Secrets', create: 'New secret', imports: false },
  {
    path: 'global-params',
    title: 'Global parameters',
    create: 'New global parameter',
    imports: true,
  },
] as const;

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

/** The page's shape and measurements, read in ONE evaluate. */
function measure(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content')!;
    const header = content.querySelector('.page-header')!;
    const item = (el: Element, name: string) => {
      const r = el.getBoundingClientRect();
      return { name, left: r.left, right: r.right, centre: r.top + r.height / 2 };
    };
    const h1 = header.querySelector('h1')!;
    const help = header.querySelector(':scope > details > summary');
    const create = header.querySelector('.toolbar button');
    const note = header.querySelector<HTMLElement>(':scope > details[open] > [role=note]');
    const headRect = header.getBoundingClientRect();
    const noteRect = note?.getBoundingClientRect();
    const imports = [...content.querySelectorAll('section.section')]
      .filter((s) => s.querySelector('.section__title')?.textContent === 'Import')
      .map((s) => {
        const row = s.querySelector('.field-form > .labelled-control')!;
        const label = row.firstElementChild!.getBoundingClientRect();
        const file = row.querySelector('input[type=file]')!.getBoundingClientRect();
        return {
          level: s.querySelector('.section__title')!.tagName,
          labelGap: Math.round(file.left - label.right),
        };
      });
    const root = document.scrollingElement!;
    return {
      // Prose under the title: a `.page-hint` that is not inside a section or
      // a form, where a hint is a line of that part's state.
      prose: [...content.querySelectorAll('.page-hint')].filter(
        (el) => !el.closest('.section, form'),
      ).length,
      helpName: help?.getAttribute('aria-label') ?? null,
      row: [
        item(h1, 'title'),
        ...(help ? [item(help, '?')] : []),
        ...(create ? [item(create, 'create')] : []),
      ],
      createH: create ? Math.round(create.getBoundingClientRect().height) : null,
      note:
        noteRect === undefined
          ? null
          : {
              leftOffset: Math.round(noteRect.left - headRect.left),
              belowRow: Math.round(noteRect.top - headRect.bottom),
              inViewport: noteRect.left >= 0 && noteRect.right <= window.innerWidth,
            },
      imports,
      sideways: Math.max(
        root.scrollWidth - root.clientWidth,
        content.scrollWidth - content.clientWidth,
      ),
    };
  });
}

for (const { density, theme } of RUNS) {
  test(`#1594 OR40 S6d — the Manage lists: no prose, the title's ?, Import as a section (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, density as Density);

    for (const p of PAGES) {
      await page.goto(`/#/manage/${p.path}`);
      await fluentRootReady(page);
      await expectAppearance(page, theme, density as Density);
      const region = page.getByRole('region', { name: p.title, exact: true });
      await expect(region.getByRole('heading', { level: 1, name: p.title })).toBeVisible();
      await expect(page.getByRole('button', { name: p.create, exact: true })).toBeVisible();

      const closed = await measure(page);
      expect(closed, p.title).toMatchObject({
        prose: 0,
        helpName: `About ${p.title}`,
        createH: CONTROL_H[density as Density],
        note: null,
        sideways: 0,
        imports: p.imports ? [{ level: 'H2', labelGap: 12 }] : [],
      });
      expectInlineRow(`${p.title} header`, closed.row);
      expect(await offRampText(page, density as Density), `${p.title}, ? closed`).toEqual([]);

      // The note is the page's description, and it opens under the header row.
      const note = page.locator('.page-header [role=note]');
      await expect(region).toHaveAccessibleDescription((await note.textContent()) ?? '');
      await page.locator('.page-header > details > summary').click();
      await expect(note).toBeVisible();
      const open = await measure(page);
      expect(open.note, `${p.title} note`).toEqual({
        leftOffset: 0,
        belowRow: 4,
        inViewport: true,
      });
      expect(open.sideways).toBe(0);
      expect(await offRampText(page, density as Density), `${p.title}, ? open`).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(note).toBeHidden();
    }

    // The one warning kept on screen: where a global's value is typed.
    await page.getByRole('button', { name: 'New global parameter', exact: true }).click();
    const value = page.getByRole('textbox', { name: 'Value', exact: true });
    await expect(value).toBeVisible();
    await expect(page.getByText(/^Cleartext: shown here and copied into run logs/)).toBeVisible();
    await expect(value).toHaveAccessibleDescription(/^Cleartext: shown here/);

    await expectQuiet(page, problems);
  });
}
