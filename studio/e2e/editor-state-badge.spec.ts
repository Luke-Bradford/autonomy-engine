import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { dragNodeBy, viewportSettled } from './support/canvasGraph';
import { editorMenuItem } from './support/canvas';
import { fluentRootReady } from './support/theme';
import { mintVersion, nodeById, seedVersion, type SeedDoc } from './support/seedDoc';

/**
 * #1476 OR28 slice 1 — the editor says which version it is on, at a glance.
 *
 * The four editing states an operator meets: clean on the latest, a draft, a
 * draft whose basis another tab has since moved past, and a read-only preview
 * of an older version. This workspace is DB-only, so the LIVE part must be
 * absent: there is no publish here, and "Not published" would be a false alarm.
 * The git half (Not published → Live: v1 ✓) is in `workspace-git.spec.ts`,
 * which owns the real repo.
 *
 * 1280×720 throughout: the badge shares the toolbar row with everything else,
 * and that row must never wrap or clip it (#1475's budget).
 */

const V1: SeedDoc = {
  nodes: [
    { id: 'n_a', position: { x: 0, y: 0 } },
    { id: 'n_b', position: { x: 320, y: 0 } },
  ],
  edges: [{ from: 'n_a', to: 'n_b', on: 'success' }],
};
const V2: SeedDoc = { ...V1, nodes: [...V1.nodes, { id: 'n_c', position: { x: 640, y: 0 } }] };

const badge = (page: Page) => page.getByRole('group', { name: 'Pipeline state' });
const part = (page: Page, name: 'editing' | 'live') => badge(page).locator(`[data-part="${name}"]`);

/** One read: the parts as drawn, their colour against the tone tokens, and clipping. */
async function read(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('.app-fluent-root') ?? document.body;
    const probe = (token: string) => {
      const s = document.createElement('span');
      s.style.color = `var(${token})`;
      root.appendChild(s);
      const c = getComputedStyle(s).color;
      s.remove();
      return c;
    };
    const header = document.querySelector('.canvas-page > .page-header')!;
    const editing = document.querySelector<HTMLElement>('[data-part="editing"]');
    const save = document.querySelector('.canvas-page > .page-header button.primary');
    return {
      warning: probe('--warning'),
      muted: probe('--muted'),
      editingColor: editing ? getComputedStyle(editing).color : null,
      editingTone: editing?.dataset.tone ?? null,
      headerOverflows: header.scrollWidth > header.clientWidth,
      editingClipped: editing ? editing.scrollWidth > editing.clientWidth : null,
      // One row: the badge and Save share a vertical centre.
      sameRow:
        editing && save
          ? Math.abs(
              editing.getBoundingClientRect().top +
                editing.getBoundingClientRect().height / 2 -
                (save.getBoundingClientRect().top + save.getBoundingClientRect().height / 2),
            ) <= 4
          : null,
    };
  });
}

test('the badge names the editing state: latest, draft, overtaken, previewing', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const name = `e2e 1476 badge ${String(Date.now())}`;
  const { pipelineId, pipelineVersionId: v1 } = await seedVersion(page, name, V1);
  const v2 = await mintVersion(page, pipelineId, V2, v1, name);

  // The publish state is its own read, after the load. Wait for it, or the
  // "no live part" check below would pass merely by running first.
  const publishRead = Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/workspace/git')),
    page.waitForResponse((r) => r.url().endsWith(`/api/pipelines/${pipelineId}/active`)),
  ]);
  await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
  await publishRead;
  await fluentRootReady(page);
  await expect(nodeById(page, 'n_c')).toBeVisible();
  await viewportSettled(page);

  // ── clean, on the latest ────────────────────────────────────────────────
  await expect(part(page, 'editing')).toHaveText(/^v2 \(latest\)/);
  await expect(part(page, 'editing')).toHaveAttribute('title', 'v2, the latest saved version.');
  // DB-only: no live part at all, not a "Not published" guess.
  await expect(part(page, 'live')).toHaveCount(0);
  let m = await read(page);
  expect(m.editingTone).toBe('neutral');
  expect(m.editingColor).toBe(m.muted);

  // ── a draft ─────────────────────────────────────────────────────────────
  // A move, not an added activity: the draft must stay SAVABLE for the
  // overtaken step below to reach the server.
  await dragNodeBy(page, 2, 0, 80);
  await expect(part(page, 'editing')).toHaveText(/^Draft · v2/);
  await expect(part(page, 'editing')).toHaveAttribute('title', /^Draft — unsaved changes on v2\./);
  m = await read(page);
  expect(m.editingTone).toBe('warning');
  expect(m.editingColor, 'the draft is drawn in the warning colour').toBe(m.warning);
  expect(m.headerOverflows, 'the toolbar row does not overflow at 1280').toBe(false);
  expect(m.editingClipped, 'the badge is not clipped').toBe(false);
  expect(m.sameRow, 'the badge sits in the toolbar row').toBe(true);

  // ── overtaken: another tab saves v3, so this draft's basis is no longer the
  // head. The badge must keep naming the version ON SCREEN (v2), not the head.
  await mintVersion(page, pipelineId, { ...V2, nodes: V2.nodes.slice(0, 2) }, v2, name);
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.locator('.notice-conflict')).toBeVisible();
  await expect(part(page, 'editing')).toHaveText(/^Draft · v2/);
  await expect(part(page, 'editing')).toHaveAttribute('title', /v3 is newer/);

  // ── previewing an older version over the kept draft ─────────────────────
  await (await editorMenuItem(page, /^Show version history/)).click();
  await page.getByTestId('version-history').getByRole('button', { name: /^v1\b/ }).click();
  await expect(page.getByTestId('canvas-preview')).toBeVisible();
  await expect(part(page, 'editing')).toHaveText(/^Viewing v1/);
  await expect(part(page, 'editing')).toHaveAttribute('title', /unsaved changes are kept/);

  await expectQuiet(page, problems, [
    /^console\.error: Failed to load resource: the server responded with a status of 409 \(Conflict\)$/,
  ]);
});

/**
 * #1502 — another tab saves while this editor sits idle. The editor learns of it
 * when the window regains focus, with NO save attempt to provoke a re-read: the
 * badge names the newer version, and the history column lists it.
 */
test('a version saved elsewhere reaches the badge and the history on focus', async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const name = `e2e 1502 focus ${String(Date.now())}`;
  const { pipelineId, pipelineVersionId: v1 } = await seedVersion(page, name, V1);

  const publishRead = page.waitForResponse((r) =>
    r.url().endsWith(`/api/pipelines/${pipelineId}/active`),
  );
  await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
  await publishRead;
  await fluentRootReady(page);
  await expect(nodeById(page, 'n_b')).toBeVisible();
  await expect(part(page, 'editing')).toHaveText(/^v1 \(latest\)/);
  await (await editorMenuItem(page, /^Show version history/)).click();
  const history = page.getByTestId('version-history');
  await expect(history.getByRole('button', { name: /^v2\b/ })).toHaveCount(0);

  await mintVersion(page, pipelineId, V2, v1, name);
  // Nothing on the page has asked yet: the claim is still the open-time one.
  await expect(part(page, 'editing')).toHaveText(/^v1 \(latest\)/);

  const reread = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/pipelines/${pipelineId}/versions`) && r.request().method() === 'GET',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await reread;
  await expect(part(page, 'editing')).toHaveText(/^v1 · v2 is newer/);
  await expect(part(page, 'editing')).toHaveAttribute('data-tone', 'warning');
  await expect(history.getByRole('button', { name: /^v2\b/ })).toContainText('latest');
  // The canvas was not moved: the operator is still on the version they opened.
  await expect(nodeById(page, 'n_c')).toHaveCount(0);
  await expect(page.locator('.notice-conflict')).toHaveCount(0);
  // DB-only: no repo, so no git part either.
  await expect(badge(page).locator('[data-part="git"]')).toHaveCount(0);

  await expectQuiet(page, problems);
});
