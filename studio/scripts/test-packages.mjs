/**
 * #1124 — run each package's vitest suite with the machine to ITSELF, and
 * report every package's result.
 *
 * ## The defect this exists to remove
 *
 * `pnpm -r run test` runs the four packages CONCURRENTLY, and each package's
 * script is a bare `vitest run`. vitest 4.1.10 defaults `maxWorkers` to
 * `os.availableParallelism()` and pool to `forks`, so every package
 * independently sizes itself to the whole machine. Nothing coordinates them.
 *
 * Measured on a 10-core darwin box during a full `pnpm test`:
 *
 * | run                          | vitest processes | loadavg |
 * | ---------------------------- | ---------------- | ------- |
 * | packages concurrent (before) | 23               | ~20     |
 * | packages serial (after)      | 13               | ~11     |
 *
 * That 2x oversubscription is the whole content of "fails in the full suite,
 * passes in isolation" (#1124, #985, #969): an isolated re-run is not a
 * different TEST, it is a different MACHINE. Re-running the three #1124 files
 * alone passed 29/29 while the full suite failed six assertions across them.
 *
 * ## Why serial costs nothing
 *
 * The concurrency was buying no wall-clock, because it was thrashing. Timed
 * back-to-back on an otherwise idle box, same tree, same commit:
 *
 * | run                        | wall-clock |
 * | -------------------------- | ---------- |
 * | `pnpm -r run test` (before)| 135s       |
 * | this script (after)        | 129s       |
 *
 * Serial is marginally FASTER, so this is not a speed-for-reliability trade.
 * vitest's own per-package `Duration` from that same pair shows where it goes —
 * concurrent wall-clock is the MAX of the four, serial is their SUM, and each
 * package roughly halves once it is not fighting the others:
 *
 * | package | concurrent | serial |
 * | ------- | ---------- | ------ |
 * | cli     | 0.30s      | 0.22s  |
 * | shared  | 5.42s      | 6.32s  |
 * | server  | 115.84s    | 55.81s |
 * | web     | 127.96s    | 62.36s |
 *
 * Measure both halves of a comparison like this in one sitting: an earlier
 * pass of these numbers was taken while other work ran on the box and put
 * serial at ~156s, which understated it by 20%.
 *
 * Measured on darwin/10 cores only. CI is 4-core ubuntu, where the before-state
 * is 4 packages x 4 forks on 4 cores. The arithmetic does not transport;
 * compare the `studio-ci` `Test` step duration rather than assuming it does.
 *
 * ## Why this is a script and not a pnpm flag
 *
 * `pnpm -r --workspace-concurrency=1 run test` serializes, but MEASURED on
 * pnpm 11.0.6 with a three-package probe (`a` pass, `b` fail, `c` pass) it
 * BAILS: only `a` and `b` ran, `c` never executed. A red server suite would
 * hide a red web suite entirely. At the default concurrency all three ran only
 * because all three had already been launched before `b` failed — "run all,
 * report all" was an accident of concurrency, not a property.
 *
 * `--no-bail` does run all three, and measured exit code was 1. It is NOT used
 * here, because pnpm's own `--help` documents it as *"will exit with a 0 exit
 * code even if the script fails"*. Relying on behaviour that contradicts its
 * documentation is fine for a convenience script and unacceptable for a merge
 * gate: the day a patch release makes the code match the docs, this gate turns
 * fail-OPEN silently, which is the one polarity that must never be possible.
 *
 * An explicit runner is immune to that. It also fixes a pre-existing gap in
 * both pnpm modes: a package whose DEPENDENCY's test script failed is skipped,
 * and `server`/`web` both depend on `shared`, so one red `shared` suite meant
 * neither of them ran at all. Here every package runs regardless.
 *
 * ## What this is NOT
 *
 * Not a timeout change. `packages/server/vitest.config.ts` (30s) and
 * `packages/web/vitest.setup.ts` (RTL 5s) are two PRIOR attempts at this same
 * flake class (#723); both are deliberately untouched. This removes the
 * contention those budgets were widened to absorb. It buys headroom — it does
 * not remove a deadline, and a heavy enough spec will spend it again. The
 * deadline-dependence fixes are per-spec and land beside this one.
 */
import { spawnSync } from 'node:child_process';

/**
 * Dependency order, so a `shared` break is reported before the packages that
 * consume it rather than as four confusing failures. Order is presentational
 * only: every entry runs regardless of what came before.
 */
const PACKAGES = [
  '@autonomy-studio/shared',
  '@autonomy-studio/cli',
  '@autonomy-studio/server',
  '@autonomy-studio/web',
];

const failed = [];

for (const name of PACKAGES) {
  // The banner is what replaces pnpm's `packages/<name> test:` line prefix.
  // Without it a bare `src/…/foo.test.ts` failure is ambiguous about which
  // package produced it, since all four report paths relative to their own root.
  console.log(`\n=== ${name} — vitest ===`);
  const result = spawnSync('pnpm', ['--filter', name, 'run', 'test'], {
    stdio: 'inherit',
    // `shell: true` on win32 only: pnpm is a `.cmd` shim there and is not
    // directly executable. Kept off elsewhere so no argument passes through a
    // shell that could reinterpret it.
    shell: process.platform === 'win32',
  });

  // A signal-killed child reports `status: null`. Treating that as anything but
  // a failure would let an OOM-killed suite read as a pass.
  if (result.status !== 0) {
    failed.push({
      name,
      reason: result.error
        ? `could not run: ${result.error.message}`
        : result.signal
          ? `killed by ${result.signal}`
          : `exit ${result.status}`,
    });
  }
}

if (failed.length > 0) {
  console.error(`\n=== FAILED: ${failed.length} of ${PACKAGES.length} packages ===`);
  for (const { name, reason } of failed) console.error(`  ${name} (${reason})`);
  process.exit(1);
}

console.log(`\n=== all ${PACKAGES.length} packages passed ===`);
