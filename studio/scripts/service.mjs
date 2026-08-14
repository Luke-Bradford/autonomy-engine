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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything about the installed service, in one place. */
const SERVICE_HOME = join(homedir(), '.autonomy-studio', 'service');
const SERVICE_REPO = join(SERVICE_HOME, 'repo');
const SERVICE_STUDIO = join(SERVICE_REPO, 'studio');
const BUILT_SHA = join(SERVICE_HOME, 'built.sha');
const LAUNCHD_LABEL = 'com.autonomy.studio-server';
/** Held for the duration of a refresh — see `withLock`. */
const REFRESH_LOCK = join(SERVICE_HOME, 'refresh.lock');
/** The address the launchd plist binds. Stated here so `status` can probe it. */
const SERVICE_URL = 'http://127.0.0.1:8788';

/**
 * A failure this script REPORTS, as against one it lets escape as a stack trace.
 *
 * The whole value of these two commands is that they say what happened; a raw
 * `execFileSync` throw prints a spawn trace with the command buried in it, which
 * is worse than the four manual steps this replaces.
 */
class ServiceError extends Error {}

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    /* `stderr` is where git and pnpm say what is actually wrong; the Error's own
       message is only ever "Command failed". */
    const detail = String(err.stderr ?? '').trim() || err.message;
    throw new ServiceError(`${cmd} ${args.join(' ')} failed:\n${detail}`);
  }
}

/**
 * Run `body` holding an exclusive lock, so two refreshes cannot overlap.
 *
 * NOT paranoia: `refresh` runs `pnpm install` and `pnpm build` against one
 * directory, and two of those at once corrupt `node_modules` and `dist` in ways
 * that surface later as an unrelated-looking build failure. The second caller is
 * already foreseeable — #1080's applet exposes Refresh as a menu item, next to a
 * human who can also run `pnpm service:refresh`.
 *
 * `wx` is the mutex: an exclusive create is atomic, so the loser of a race gets
 * `EEXIST` rather than both proceeding. The PID is written INTO the lock so a
 * stale one — a refresh killed mid-build, which leaves the file behind — can be
 * told from a live one and taken over, rather than wedging every future refresh
 * until someone deletes a file they have never heard of.
 */
async function withLock(body) {
  /* Bounded, because every retry means the lock changed hands under us; a loop
     that never gives up would spin instead of reporting a machine where
     something is repeatedly dying mid-refresh. */
  const ATTEMPTS = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      writeFileSync(REFRESH_LOCK, `${String(process.pid)}\n`, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      /* The holder can RELEASE between our failed create and this read, which
         is not an error — it just means the lock is free now. Retrying the
         exclusive create is the whole response. */
      let holderText;
      try {
        holderText = readFileSync(REFRESH_LOCK, 'utf8').trim();
      } catch (readErr) {
        if (readErr.code !== 'ENOENT') throw readErr;
        if (attempt >= ATTEMPTS) throw new ServiceError('the refresh lock kept changing hands');
        continue;
      }

      const holder = Number(holderText);
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
        throw new ServiceError(
          `another refresh is already running (pid ${String(holder)}).\n` +
            `Wait for it, or if it is gone: rm ${REFRESH_LOCK}`,
        );
      }

      /* STALE. Do NOT simply overwrite it: a plain write is not exclusive, so
         two processes that both find the holder dead would both proceed — which
         is the failure this lock exists to prevent, reintroduced in precisely
         the crash-recovery path it was added for. Instead remove it and go
         round again, so ownership is still decided by an exclusive create and
         exactly one racer can win.
         The removal is CONTENT-CHECKED: another process may have taken over
         between the read above and here, and deleting a lock that is now LIVE
         would be worse than the problem. Node has no atomic compare-and-delete,
         so a window of a few microseconds remains — two processes recovering
         the same stale lock at the same instant. Stated rather than hidden: the
         cost is one duplicated build on a machine where a refresh had already
         been killed mid-flight, and closing it properly needs a real lock file
         API this script does not earn. */
      if (readFileSync(REFRESH_LOCK, 'utf8').trim() === holderText) {
        console.log(`taking over a stale lock from pid ${holderText}`);
        rmSync(REFRESH_LOCK, { force: true });
      }
      if (attempt >= ATTEMPTS) throw new ServiceError('the refresh lock kept changing hands');
    }
  }

  try {
    return await body();
  } finally {
    rmSync(REFRESH_LOCK, { force: true });
  }
}

/** Whether a pid is still around. `signal 0` tests without delivering anything. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    /* EPERM means it exists and belongs to someone else — still alive, and still
       a reason not to run a second build over the top of it. */
    return err.code === 'EPERM';
  }
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
  return withLock(doRefresh);
}

async function doRefresh() {
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
  /* `switch main` assumes a LOCAL main exists, and it need not: a detached HEAD
     from a previous manual intervention is exactly the state someone reaches for
     this command in, and there it threw a spawn trace instead of the reported
     failure every other path here gives. `-c … --track` creates it from the
     remote the first time; plain `switch` is used once it exists so the tracking
     branch is never silently re-pointed. */
  const hasMain = run('git', ['branch', '--list', 'main'], SERVICE_REPO) !== '';
  run(
    'git',
    hasMain ? ['switch', 'main'] : ['switch', '-c', 'main', '--track', 'origin/main'],
    SERVICE_REPO,
  );
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
let exit = 1;
try {
  exit =
    command === 'refresh'
      ? await refresh()
      : command === 'status'
        ? await status()
        : (console.error(`unknown command '${command}' — use status or refresh`), 1);
} catch (err) {
  /* A REPORTED failure prints its message; anything else is a bug in this
     script and keeps its stack, because that is what a stack is for. */
  if (err instanceof ServiceError) console.error(`\n  ! ${err.message}`);
  else throw err;
}
process.exit(exit);
