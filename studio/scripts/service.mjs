/**
 * The studio SERVICE — one command to ask what is running, and one to fix it.
 *
 *   pnpm service:status    # what is installed, what is served, how far behind
 *   pnpm service:refresh   # fast-forward to main, build, restart, stamp
 *
 * WHY THIS EXISTS. The service is a launchd agent serving a SEPARATE checkout
 * (`~/.autonomy-studio/service/repo`), so the code an operator sees has no
 * necessary relationship to the code in this working tree. That gap has now
 * caused the same failure twice: a service left on an old build for a day, with
 * nothing on screen saying so, was reported as "the app looks broken" when the
 * app was fine and the BUILD was stale.
 *
 * Doing it by hand is four steps — fetch, checkout, build, `launchctl kickstart`
 * — and every one of them can succeed while another is skipped. The specific
 * way it went wrong is worth naming: a build without a restart leaves the old
 * process serving old bundles from a NEW `dist`, and a restart without a stamp
 * leaves `built.sha` asserting a commit that is not what is running. `built.sha`
 * was found lying for exactly that reason. So refresh is ONE operation that
 * either completes or reports where it stopped, and the stamp is written LAST —
 * after the restart is confirmed serving — because a stamp is a claim about
 * what is running, not about what was compiled.
 *
 * READ-ONLY BY DEFAULT. `status` touches nothing, so "which build am I on" never
 * costs a restart of the thing being asked about.
 *
 * Deliberately NOT a deploy pipeline. It fast-forwards to `origin/main` and
 * refuses anything else — no branch argument, no arbitrary ref. A service that
 * can be pointed at any commit is a second place where "what is running" has to
 * be tracked, which is the problem this is here to remove.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything about the installed service, in one place. */
const SERVICE_HOME = join(homedir(), '.autonomy-studio', 'service');
const SERVICE_REPO = join(SERVICE_HOME, 'repo');
const SERVICE_STUDIO = join(SERVICE_REPO, 'studio');
const BUILT_SHA = join(SERVICE_HOME, 'built.sha');
const LAUNCHD_LABEL = 'com.autonomy.studio-server';
/** The address the launchd plist binds. Stated here so `status` can probe it. */
const SERVICE_URL = 'http://127.0.0.1:8788';

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** What the RUNNING process says about itself — the only authority on "served". */
async function servedCommit() {
  try {
    const res = await fetch(`${SERVICE_URL}/api/version`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.commit === 'string' ? body.commit : null;
  } catch {
    // Down, or not answering — a fact to report, not an error to throw.
    return null;
  }
}

async function status() {
  if (!existsSync(SERVICE_REPO)) {
    console.log(`no service installed at ${SERVICE_REPO}`);
    return 1;
  }
  run('git', ['fetch', 'origin', '--quiet'], SERVICE_REPO);
  const head = run('git', ['rev-parse', '--short', 'HEAD'], SERVICE_REPO);
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], SERVICE_REPO);
  const behind = run('git', ['rev-list', '--count', 'HEAD..origin/main'], SERVICE_REPO);
  const stamped = existsSync(BUILT_SHA)
    ? readFileSync(BUILT_SHA, 'utf8').trim().slice(0, 7)
    : '(none)';
  const served = await servedCommit();

  console.log(`  checkout   ${head} on ${branch}`);
  console.log(
    `  served     ${served ?? '(not answering)'}${served === null ? ` — ${SERVICE_URL}` : ''}`,
  );
  console.log(`  stamped    ${stamped}`);
  console.log(`  behind     ${behind} commit(s) behind origin/main`);

  /* THE THREE CAN DISAGREE, and each disagreement means something different —
     which is the whole reason all three are printed rather than one summary. */
  if (served !== null && !head.startsWith(served) && !served.startsWith(head)) {
    console.log(
      '\n  ! the running process is NOT the checkout — built or pulled without a restart',
    );
  }
  if (
    stamped !== '(none)' &&
    served !== null &&
    !stamped.startsWith(served) &&
    !served.startsWith(stamped)
  ) {
    console.log('  ! built.sha does not match what is served — the stamp is lying');
  }
  if (Number(behind) > 0) console.log(`\n  run: pnpm service:refresh`);
  return 0;
}

async function refresh() {
  if (!existsSync(SERVICE_REPO)) {
    console.error(`no service installed at ${SERVICE_REPO}`);
    return 1;
  }
  /* A DIRTY CHECKOUT IS A REFUSAL, not something to fast-forward over. Anything
     uncommitted there was put there by a person, and a `git checkout main` on
     top of it is the destructive move this repo has already paid for twice. */
  const dirty = run('git', ['status', '--porcelain'], SERVICE_REPO);
  if (dirty !== '') {
    console.error(`refusing: ${SERVICE_REPO} has uncommitted changes\n${dirty}`);
    return 1;
  }

  console.log('fetching…');
  run('git', ['fetch', 'origin', '--quiet'], SERVICE_REPO);
  run('git', ['switch', 'main'], SERVICE_REPO);
  /* `--ff-only`: the service tracks main and never merges. A refresh that needed
     a merge commit would mean the checkout had diverged, which is a thing to
     look at, not to resolve automatically. */
  run('git', ['pull', '--ff-only', '--quiet'], SERVICE_REPO);
  const head = run('git', ['rev-parse', 'HEAD'], SERVICE_REPO);
  console.log(`checkout at ${head.slice(0, 7)}`);

  console.log('installing…');
  run('pnpm', ['install', '--frozen-lockfile'], SERVICE_STUDIO);
  console.log('building…');
  run('pnpm', ['build'], SERVICE_STUDIO);

  console.log('restarting…');
  run('launchctl', [
    'kickstart',
    '-k',
    `gui/${String(process.getuid?.() ?? 501)}/${LAUNCHD_LABEL}`,
  ]);

  /* WAIT FOR THE NEW PROCESS TO SAY IT IS THE NEW COMMIT. Stamping on the
     strength of a successful build is what let `built.sha` lie: the build
     succeeded, the restart had not landed, and the file asserted a commit that
     was not being served. */
  const deadline = Date.now() + 60_000;
  let served = null;
  while (Date.now() < deadline) {
    served = await servedCommit();
    if (served !== null && head.startsWith(served)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (served === null || !head.startsWith(served)) {
    console.error(
      `\n  ! restarted, but ${SERVICE_URL} is serving ${served ?? '(nothing)'} — NOT stamping`,
    );
    return 1;
  }

  writeFileSync(BUILT_SHA, `${head}\n`);
  console.log(`\n  serving ${served} at ${SERVICE_URL}`);
  return 0;
}

const [, , command = 'status'] = process.argv;
const exit =
  command === 'refresh'
    ? await refresh()
    : command === 'status'
      ? await status()
      : (console.error(`unknown command '${command}' — use status or refresh`), 1);
process.exit(exit);
