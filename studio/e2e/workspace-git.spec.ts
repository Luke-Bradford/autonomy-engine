import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';

/**
 * #3 G10 / U18 slice 1 — Manage → Git (#956).
 *
 * This is the first end-to-end exercise of the workspace-git subsystem: until
 * this slice the server owned all thirteen routes and no client called any of
 * them, so the whole connect → inspect → commit path had never been walked
 * against a real repository.
 *
 * The repo is a REAL `git init --bare` in a scratch directory, connected by
 * absolute path (which `WorkspaceGitRepoUrlSchema` accepts precisely so a local
 * repo can be a remote). That keeps the spec offline and credential-free — the
 * harness deliberately blanks `GH_TOKEN`/`GITHUB_TOKEN` — while still driving
 * git for real: the commit below is a genuine commit, pushed to a genuine
 * remote, and its sha is read back off the page.
 *
 * SERIAL, and shared-state aware. Connecting flips the WHOLE workspace into git
 * mode server-side (publish and bind-to-active start behaving differently), and
 * one SQLite database is shared by every spec file in the run. So the teardown
 * disconnects unconditionally — including after a mid-spec failure — rather
 * than leaving the suite in a mode later specs did not ask for.
 */
test.describe.configure({ mode: 'serial' });

let repoDir: string;

/** The scratch bare repo, outside the harness's own data dir. */
function makeBareRepo(): string {
  // NOT under `data/e2e`: `reset-state.mjs` wipes that tree, and putting
  // spec-authored content inside it invites a future widening of that delete.
  const dir = mkdtempSync(join(tmpdir(), 'studio-git-e2e-'));
  execFileSync('git', ['init', '--bare', '--initial-branch=main', dir], { stdio: 'ignore' });
  return dir;
}

/** The Git page, freshly loaded. */
async function openGitPage(page: Page): Promise<void> {
  await page.goto('/#/manage/git');
  await expect(page.getByRole('heading', { name: 'Git', level: 2 })).toBeVisible();
}

/** The value the fact list shows under `term` — read by PAIRING, not by search. */
function fact(page: Page, term: string) {
  return page.locator('dt', { hasText: new RegExp(`^${term}$`) }).locator('+ dd');
}

/**
 * Run `act` with a confirm dialog answered. Playwright DISMISSES dialogs by
 * default, so without this the Disconnect click is a silent no-op and the spec
 * would "pass" having proved nothing.
 */
async function withConfirm(page: Page, act: () => Promise<void>): Promise<string | null> {
  let seen: string | null = null;
  const handler = async (dialog: { message: () => string; accept: () => Promise<void> }) => {
    seen = dialog.message();
    await dialog.accept();
  };
  page.on('dialog', handler);
  try {
    await act();
  } finally {
    page.off('dialog', handler);
  }
  return seen;
}

test.beforeAll(() => {
  repoDir = makeBareRepo();
});

test.afterAll(async ({ request }) => {
  // Unconditional: a failure above must not leave the workspace in git mode for
  // whatever spec file runs next.
  await request.delete('/api/workspace/git').catch(() => undefined);
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

test('a workspace connects to a repo, commits itself, and disconnects', async ({ page }) => {
  const problems = collectPageProblems(page);

  // A resource to commit, so the drift below cannot be trivially empty.
  const created = await page.request.post('/api/pipelines', {
    data: { name: `git-e2e-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);

  await openGitPage(page);

  // ── connect ────────────────────────────────────────────────────────────────
  await expect(page.getByRole('form', { name: 'Connect a repository' })).toBeVisible();
  // By ROLE, not `getByLabel`: the form's own `aria-label` ("Connect a
  // repository") also contains the word, and label matching is substring-based.
  await page.getByRole('textbox', { name: 'Repository', exact: true }).fill(repoDir);
  await page.getByRole('button', { name: 'Connect' }).click();

  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
  await expect(fact(page, 'Repository')).toHaveText(repoDir);
  await expect(fact(page, 'Working branch')).toHaveText('studio/local/work');

  /**
   * A freshly-`init`ed bare repo has no commits, so `main` does not resolve at
   * the remote and the derived state is `collab_branch_missing` — the real
   * first-run onboarding state, asserted explicitly rather than loosely, since
   * "connected" alone would hide a regression that reported `ready` for a repo
   * with nothing in it.
   */
  await expect(fact(page, 'State')).toContainText('does not exist at the remote yet');
  await expect(fact(page, 'Imported from')).toHaveText('—');

  // ── drift ──────────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Check for changes' }).click();

  /**
   * CONTAINMENT, never an exact list: one database is shared across the whole
   * run, so this table carries every resource any earlier spec created. What
   * matters is that the pipeline just created is in it, as an addition.
   */
  const driftRows = page.getByRole('table').last().getByRole('row');
  await expect(driftRows.filter({ hasText: 'added' }).first()).toBeVisible();

  // ── commit ─────────────────────────────────────────────────────────────────
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('studio: first commit from the UI');
  await page.getByRole('button', { name: 'Commit' }).click();

  const note = page.getByRole('status');
  await expect(note).toContainText('Committed');
  await expect(note).toContainText('studio/local/work');
  // A real sha, read back off the page — seven hex characters, not a placeholder.
  await expect(note).toHaveText(/Committed [0-9a-f]{7} to studio\/local\/work — \d+ files?\./);

  // The stale drift report must be gone: it described the pre-commit state.
  await expect(page.getByRole('table')).toHaveCount(0);

  // ── the commit really landed ───────────────────────────────────────────────
  const branches = execFileSync('git', ['branch', '--list'], { cwd: repoDir, encoding: 'utf8' });
  expect(branches).toContain('studio/local/work');

  // ── drift is clean afterwards ──────────────────────────────────────────────
  await page.getByRole('button', { name: 'Check for changes' }).click();
  await expect(page.getByText('No uncommitted changes.')).toBeVisible();

  // ── disconnect ─────────────────────────────────────────────────────────────
  const message = await withConfirm(page, () =>
    page.getByRole('button', { name: 'Disconnect' }).click(),
  );
  expect(message).toContain(repoDir);

  await expect(page.getByRole('form', { name: 'Connect a repository' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connected' })).toHaveCount(0);

  expectQuiet(problems);
});

test('the Git section is reachable from the Manage pane', async ({ page }) => {
  const problems = collectPageProblems(page);

  await page.goto('/#/manage/connections');
  const pane = page.getByRole('navigation', { name: 'Manage sections' });
  await pane.getByRole('link', { name: 'Git' }).click();

  await expect(page.getByRole('heading', { name: 'Git', level: 2 })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/manage/git');

  expectQuiet(problems);
});
