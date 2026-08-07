import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openExistingCanvas } from './support/canvas';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { seedVersion } from './support/seedDoc';

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

/**
 * #979 — push a pipeline file the workspace has never seen, so importing it
 * MINTS a version and stamps its git provenance (the precondition for Publish).
 *
 * Built by re-identifying the file already committed on `main` rather than by
 * hand-authoring an envelope: the serializer owns that shape, and a hand-written
 * copy would silently rot the day it changes. Every identity field is rewritten
 * — the pipeline's `resourceId` decides create-vs-update, and a reused VERSION
 * `resourceId` is refused outright as a duplicate immutable id.
 */
function pushNewPipelineFile(bareRepo: string, name: string): void {
  const work = mkdtempSync(join(tmpdir(), 'studio-git-publish-'));
  try {
    execFileSync('git', ['clone', '--branch', 'main', bareRepo, work], { stdio: 'ignore' });
    const dir = join(work, 'pipelines');
    const source = readdirSync(dir).find((f) => f.endsWith('.json'));
    if (source === undefined) throw new Error('no pipeline file on main to re-identify');

    const doc = JSON.parse(readFileSync(join(dir, source), 'utf8')) as {
      data: {
        pipeline: { id: string; resourceId: string; name: string };
        versions: { id: string; resourceId: string; pipelineId: string }[];
      };
    };
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    doc.data.pipeline.id = `pl_${slug}`;
    doc.data.pipeline.resourceId = `res_pl_${slug}`;
    doc.data.pipeline.name = name;
    doc.data.versions.forEach((v, i) => {
      v.id = `plv_${slug}_${String(i + 1)}`;
      v.resourceId = `res_plv_${slug}_${String(i + 1)}`;
      v.pipelineId = `pl_${slug}`;
    });
    writeFileSync(join(dir, `${slug}.json`), `${JSON.stringify(doc, null, 2)}\n`);

    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.email=e2e@studio.test', '-c', 'user.name=studio e2e', ...args],
        {
          cwd: work,
          stdio: 'ignore',
        },
      );
    git('add', '.');
    git('commit', '-m', `studio: add ${name}`);
    git('push', 'origin', 'main');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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
  await seedVersion(page, pipelineName, {
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
   * `update-ref` points the collaboration branch at the commit the workspace
   * just pushed to its working branch — what a merged pull request does,
   * expressed as the one command a bare repo needs. The workspace can then
   * import its own commit back, which walks the whole client path for real:
   * divergence, preview, apply, and the import base moving as a result.
   *
   * WHAT THIS DELIBERATELY DOES NOT COVER, and why. The import applies content
   * identical to the database, so every disposition is `unchanged` and NO
   * version is minted — which means the `sourceCommit` provenance stamp, the
   * thing this slice exists to unblock for Publish, is not exercised here.
   *
   * The obvious way to force a mint — advance the database past the branch,
   * then re-import the branch — is blocked by a SERVER defect (#963): the apply
   * compares the branch's version against the pipeline's CURRENT HEAD rather
   * than against the stored row that owns that version's `resourceId`, so
   * re-importing a commit you have since edited past is refused as if you had
   * tampered with an immutable row. Asserting the minted-version path here
   * would mean asserting a behaviour the server does not have. It belongs in
   * this spec once #963 lands.
   */
  execFileSync('git', ['update-ref', 'refs/heads/main', 'refs/heads/studio/local/work'], {
    cwd: repoDir,
    stdio: 'ignore',
  });

  // Scoped: the commit above left its own `role="status"` on the page, so an
  // unscoped read of either role would be a strict-mode violation from here on.
  const incoming = page.getByRole('region', { name: 'Incoming', exact: true });
  await incoming.getByRole('button', { name: 'Check for incoming' }).click();

  // Never imported before, so there is no base to compare the branch against.
  await expect(incoming).toContainText('never imported from main');
  const previewRows = incoming.getByRole('table').getByRole('row');
  await expect(previewRows.filter({ hasText: pipelineName })).toContainText('unchanged');

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

  const confirmed = await withConfirm(page, () =>
    incoming.getByRole('button', { name: 'Import' }).click(),
  );
  expect(confirmed).toContain('re-read now');

  // An all-unchanged import is a SUCCESS, and must not be phrased as a failure.
  await expect(incoming.getByRole('status')).toContainText('Nothing to import');

  // The import base moved even so: a real sha, where an em-dash stood before.
  await expect(fact(page, 'Imported from')).toHaveText(/^[0-9a-f]{7}$/);

  // ── and the workspace is now measurably up to date, not merely unchanged ───
  await incoming.getByRole('button', { name: 'Check for incoming' }).click();
  await expect(incoming).toContainText('Up to date with main.');

  /**
   * ── publish (#979, U18 slice 3) ────────────────────────────────────────────
   *
   * Publish is CAS over a version whose git provenance is known
   * (`routes/pipelines.ts`), and provenance is stamped ONLY on an import mint
   * (`portability/workspace-apply.ts`). The round trip above minted nothing —
   * it re-imported content identical to the database — so it cannot reach a
   * publishable version, and the note above explains why forcing a mint by
   * advancing the DB past the branch is blocked by #963.
   *
   * So the version is minted through the OTHER branch of the same apply: a
   * pipeline whose `resourceId` the workspace has never seen is `created`
   * outright, with no head comparison, and its version is stamped. The file is
   * built by re-identifying the one just committed — same doc, new identity —
   * which keeps the spec from hand-authoring an envelope that could drift from
   * the serializer's.
   */
  const publishName = `${pipelineName}-published`;
  pushNewPipelineFile(repoDir, publishName);

  await incoming.getByRole('button', { name: 'Check for incoming' }).click();
  await expect(
    incoming.getByRole('table').getByRole('row').filter({ hasText: publishName }),
  ).toContainText('new here');
  await expect(incoming.getByRole('heading', { name: 'Will be archived' })).toHaveCount(0);
  await withConfirm(page, () => incoming.getByRole('button', { name: 'Import' }).click());
  // `(new version)` is the part that matters: it says a version was MINTED, and
  // a minted version is the only kind that carries the git provenance publish
  // requires. An import that changed only the pipeline row would not do.
  await expect(incoming).toContainText('Imported');
  await expect(incoming).toContainText('(new version)');

  await openExistingCanvas(page, publishName);
  await page.getByRole('button', { name: 'Version history' }).click();
  const history = page.getByTestId('version-history');

  // Nothing is published yet, so no row may claim to be active. This is the
  // assertion that would catch an unread pointer being rendered as a fact.
  await expect(history).not.toContainText('active');

  await history.getByRole('button', { name: /^v1/ }).click();
  const bar = page.getByTestId('version-preview-bar');
  const publish = bar.getByRole('button', { name: 'Publish v1' });
  await expect(publish).toBeEnabled();

  const confirmText = await withConfirm(page, () => publish.click());
  // The confirmation's load-bearing sentence: publishing moves what is created
  // NEXT, and does not re-point the triggers that already exist.
  expect(confirmText).toContain('Publish v1?');
  expect(confirmText).toContain('do NOT move');

  await expect(page.getByText('Published v1', { exact: false })).toBeVisible();
  // The pointer reached the list, which is the whole visible outcome.
  await expect(history.getByRole('button', { name: /^v1/ })).toContainText('active');

  /**
   * And it is DURABLE, not merely optimistic local state: a reload re-reads the
   * pointer from `GET /api/pipelines/:id/active`. Without this the spec would
   * pass on a UI that set a tag and posted nothing.
   */
  await page.reload();
  await page.locator('.react-flow__renderer').waitFor();
  await page.getByRole('button', { name: 'Version history' }).click();
  await expect(
    page.getByTestId('version-history').getByRole('button', { name: /^v1/ }),
  ).toContainText('active');

  await openGitPage(page);

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
