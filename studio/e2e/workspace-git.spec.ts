import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { mintVersion, seedVersion } from './support/seedDoc';

/**
 * #3 G10 / U18 slices 1-2 — Manage → Git (#956, #962).
 *
 * This is the first end-to-end exercise of the workspace-git subsystem: until
 * slice 1 the server owned all thirteen routes and no client called any of
 * them, so the whole connect → inspect → commit path had never been walked
 * against a real repository. Slice 2 walks the other direction — divergence,
 * preview, import — and closes the round trip inside one spec.
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

test('a workspace connects to a repo, commits itself, imports it back, and disconnects', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  /**
   * A resource to commit, so the drift below cannot be trivially empty.
   *
   * It must be a pipeline with a VERSION, not a bare pipeline: the serializer
   * writes immutable versions, so a pipeline that has never been saved
   * contributes no file and the workspace serializes to nothing — which is
   * exactly what the first draft of this spec hit.
   */
  const pipelineName = `git-e2e-${Date.now()}`;
  const { pipelineId, pipelineVersionId } = await seedVersion(page, pipelineName, {
    nodes: [{ id: 'n1', position: { x: 0, y: 0 } }],
  });

  await openGitPage(page);

  // ── connect ────────────────────────────────────────────────────────────────
  await expect(page.getByRole('form', { name: 'Connect a repository' })).toBeVisible();
  // By ROLE, not `getByLabel`: the form's own `aria-label` ("Connect a
  // repository") also contains the word, and label matching is substring-based.
  await page.getByRole('textbox', { name: 'Repository', exact: true }).fill(repoDir);
  await page.getByRole('button', { name: 'Connect' }).click();

  // `exact`, because Playwright matches an accessible name by SUBSTRING: the
  // not-connected form's own heading is "No repository connected", which a
  // loose 'Connected' matches — so the teardown assertion below would never be
  // able to fail.
  await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toBeVisible();
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
  await expect(driftRows.filter({ hasText: pipelineName })).toContainText('added');

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

  /**
   * ── the incoming half (#962) ───────────────────────────────────────────────
   *
   * Two setup moves make the import a REAL one rather than a no-op:
   *
   * 1. `update-ref` points the collaboration branch at the commit the workspace
   *    just pushed to its working branch. That is what a merged pull request
   *    does, expressed as the one command a bare repo needs.
   * 2. A THIRD version is minted straight into the database, so the workspace
   *    now differs from the branch. Without it every disposition comes back
   *    `unchanged`, no version is minted, and the spec would never exercise the
   *    provenance stamp — which is the entire reason this slice exists, since
   *    `POST /api/pipelines/:id/publish` refuses a version whose `sourceCommit`
   *    is null and the import is the only writer of that field.
   *
   * The import therefore rolls the pipeline back to its one-node branch form,
   * minting a version that carries the branch's commit as its provenance.
   */
  execFileSync('git', ['update-ref', 'refs/heads/main', 'refs/heads/studio/local/work'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  await mintVersion(
    page,
    pipelineId,
    // A CONFIG change, not a position one: node positions are canvas furniture
    // and the canonical content form may exclude them, in which case the
    // disposition would come back `unchanged` and the spec would prove nothing.
    {
      nodes: [{ id: 'n1', position: { x: 0, y: 0 }, config: { url: 'https://example.invalid/' } }],
    },
    pipelineVersionId,
  );

  // Scoped: the commit above left its own `role="status"` on the page, so an
  // unscoped read of either role would be a strict-mode violation from here on.
  const incoming = page.getByRole('region', { name: 'Incoming', exact: true });
  await incoming.getByRole('button', { name: 'Check for incoming' }).click();

  const previewRows = incoming.getByRole('table').getByRole('row');
  await expect(previewRows.filter({ hasText: pipelineName })).toContainText('content differs');

  /**
   * A GATE, not a comment. One SQLite database is shared by every spec file, so
   * a preview proposing archives would mean this import is about to archive
   * OTHER specs' pipelines and disable their triggers — and `withConfirm` below
   * accepts blindly, so nothing else would stop it. The set is empty by
   * construction (the branch was written from this very database, and drift was
   * asserted clean two steps ago); this is what makes that safe by check rather
   * than safe by argument.
   */
  await expect(incoming.getByRole('heading', { name: 'Will be archived' })).toHaveCount(0);

  await withConfirm(page, () => incoming.getByRole('button', { name: 'Import' }).click());

  const outcome = incoming.getByRole('status');
  await expect(outcome).toContainText('1 resource changed');
  // `versionMinted` — the provenance stamp this whole slice exists to produce.
  await expect(incoming.getByText(/pipelines\/.*\.json/)).toContainText('new version');

  // The import base moved: a real sha, where an em-dash stood before the import.
  await expect(fact(page, 'Imported from')).toHaveText(/^[0-9a-f]{7}$/);

  // ── and the workspace now matches the branch ───────────────────────────────
  await incoming.getByRole('button', { name: 'Check for incoming' }).click();
  await expect(incoming).toContainText('Up to date with main.');

  // ── disconnect ─────────────────────────────────────────────────────────────
  const message = await withConfirm(page, () =>
    page.getByRole('button', { name: 'Disconnect' }).click(),
  );
  expect(message).toContain(repoDir);

  await expect(page.getByRole('form', { name: 'Connect a repository' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toHaveCount(0);

  await expectQuiet(page, problems);
});

test('the Git section is reachable from the Manage pane', async ({ page }) => {
  const problems = collectPageProblems(page);

  await page.goto('/#/manage/connections');
  const pane = page.getByRole('navigation', { name: 'Manage sections' });
  await pane.getByRole('link', { name: 'Git' }).click();

  await expect(page.getByRole('heading', { name: 'Git', level: 2 })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/manage/git');

  await expectQuiet(page, problems);
});
