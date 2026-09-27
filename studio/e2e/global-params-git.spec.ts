import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { disconnectWorkspaceGit, makeBareRepo } from './support/workspaceGit';

/**
 * #844 GL6 — a workspace global parameter is a git resource and a portable
 * file (spec `2026-09-27-foundation-global-params.md` GL-D6): the Git page
 * reports it as uncommitted, a Commit writes it as `global-params/<slug>.json`
 * holding exactly `{ name, type, value, description }`, and Manage → Global
 * parameters exports it to a file and imports that file back.
 */

const NAME = 'e2e_844_gl6';
const FILE = 'global-params/e2e-844-gl6.json';
const DATA = { name: NAME, type: 'json', value: { region: 'eu' }, description: 'e2e' };

let repoDir = '';

async function deleteMine(request: APIRequestContext): Promise<void> {
  const res = await request.get('/api/global-params?limit=100');
  expect(res.ok()).toBe(true);
  const { items } = (await res.json()) as { items: { id: string; name: string }[] };
  for (const g of items.filter((i) => i.name.toLowerCase() === NAME)) {
    expect((await request.delete(`/api/global-params/${g.id}`)).ok()).toBe(true);
  }
}

test.beforeAll(async ({ request }) => {
  repoDir = makeBareRepo();
  await deleteMine(request);
});

test.afterAll(async ({ request }) => {
  try {
    await disconnectWorkspaceGit(request);
    await deleteMine(request);
  } finally {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  }
});

test('a global parameter commits to git, and exports and imports as a file', async ({
  page,
  request,
}) => {
  const problems = collectPageProblems(page);

  expect((await request.post('/api/global-params', { data: DATA })).status()).toBe(201);
  const connected = await request.post('/api/workspace/git', { data: { repoUrl: repoDir } });
  expect(connected.ok(), await connected.text()).toBe(true);

  // ── the Git page reports it as uncommitted, then commits it ──────────────
  await page.goto('/#/manage/git');
  await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check for changes' }).click();
  const driftRows = page.getByRole('table').last().getByRole('row');
  await expect(driftRows.filter({ hasText: NAME })).toContainText('not on the branch yet');

  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('studio: globals');
  await page.getByRole('button', { name: 'Commit' }).click();
  await expect(page.getByRole('status')).toContainText('Committed');

  // The committed bytes: the global's four fields and nothing else.
  const committed = execFileSync(
    'git',
    ['--git-dir', repoDir, 'show', `studio/local/work:${FILE}`],
    { encoding: 'utf8' },
  );
  const envelope = JSON.parse(committed) as { kind: string; data: unknown };
  expect(envelope.kind).toBe('global-param');
  expect(envelope.data).toEqual(DATA);

  await page.getByRole('button', { name: 'Check for changes' }).click();
  await expect(page.getByText('No uncommitted changes.')).toBeVisible();

  // ── export to a file, delete, import the file back ─────────────────────────
  await page.goto('/#/manage/global-params');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: `Export ${NAME}` }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^global-param-e2e-844-gl6-gp_[\w-]+\.json$/);
  const file = (await download.path())!;
  expect((JSON.parse(readFileSync(file, 'utf8')) as { data: unknown }).data).toEqual(DATA);

  await deleteMine(request);
  await page.reload();
  await expect(page.getByRole('group', { name: `global ${NAME}` })).toHaveCount(0);

  await page.getByLabel('Export file').setInputFiles(file);
  await expect(page.getByRole('group', { name: `global ${NAME}` })).toBeVisible();

  await expectQuiet(page, problems);
});
