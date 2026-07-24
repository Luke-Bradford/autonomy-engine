/**
 * CI/CLI harness for the zero-paid-dependency license audit (P7, #409).
 *
 * Sources the license of every dependency (production + dev) from
 * `pnpm licenses list --json`, then applies the pure allowlist in
 * `licenseAudit.ts`. Exits 0 only when every license is permissive; exits 1
 * (fail-closed) on any violation OR on any failure to obtain a plausible tree —
 * a broken audit must never read as a passing audit.
 *
 * Run it with `pnpm run audit:licenses` (root) — this file is executed via tsx,
 * not built into the shipped `dist/`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_LICENSES,
  assertPlausibleTree,
  auditLicenses,
  type LicenseListMap,
} from './licenseAudit.js';

/**
 * Floor for {@link assertPlausibleTree}. The real workspace tree is ~395
 * packages; a package-subdir cwd reports ~2, and a broken/partial install far
 * fewer than a full one. 50 sits comfortably below the true count yet well
 * above any degenerate result, so it catches a no-op audit without being
 * brittle to ordinary dependency churn.
 */
const MIN_EXPECTED_PACKAGES = 50;

/** studio/ workspace root — two levels up from packages/cli/src. */
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fail(message: string): never {
  console.error(`license audit FAILED: ${message}`);
  process.exit(1);
}

function loadLicenseTree(): LicenseListMap {
  // Always run at the workspace root: `pnpm licenses list` reports only the
  // nearest project's deps when invoked from a package subdir.
  const result = spawnSync('pnpm', ['licenses', 'list', '--json'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) fail(`could not run \`pnpm licenses list\`: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `\`pnpm licenses list\` exited ${result.status ?? 'null'}: ${result.stderr?.trim() ?? ''}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    fail(`could not parse \`pnpm licenses list --json\` output: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('`pnpm licenses list --json` did not return a license map object');
  }
  return parsed as LicenseListMap;
}

function main(): void {
  const tree = loadLicenseTree();

  try {
    assertPlausibleTree(tree, MIN_EXPECTED_PACKAGES);
  } catch (err) {
    fail((err as Error).message);
  }

  const { ok, violations } = auditLicenses(tree, ALLOWED_LICENSES);

  const disallowed = new Set(violations.map((v) => v.license));
  const licenses = Object.keys(tree).sort();
  console.log(`Scanned ${licenses.length} distinct license(s) at ${WORKSPACE_ROOT}:`);
  for (const license of licenses) {
    const count = tree[license]?.length ?? 0;
    const mark = disallowed.has(license) ? '!!' : '  ';
    console.log(`  ${mark} ${license} — ${count} package(s)`);
  }

  if (!ok) {
    console.error('\nDisallowed licenses found:');
    for (const v of violations) {
      const names = v.packages.map((p) => `${p.name}@${p.versions?.join('/') ?? '?'}`).join(', ');
      console.error(`  ${v.license}: ${names}`);
    }
    fail(
      `${violations.length} license bucket(s) are not on the permissive allowlist. ` +
        'Review the dependency, or (if genuinely permissive) add its SPDX id to ALLOWED_LICENSES ' +
        'in licenseAudit.ts with a rationale.',
    );
  }

  console.log('\nAll dependency licenses are permissive. ✔');
}

main();
